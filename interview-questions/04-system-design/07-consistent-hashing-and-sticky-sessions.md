# Q: What are sticky sessions and consistent hashing, and why do they matter in a load-balanced system?

> **Level:** System Design · **Asked in:** DevOps, Backend, SRE, System Design round

## 🎯 Short answer (say this in the interview)

**Sticky sessions** (session affinity) mean the load balancer sends the same user to the same backend every time. You need it when the app keeps state in memory, for example a login session in a Node process. In open-source Nginx, `ip_hash` does this by client IP, and `hash $cookie_session_id consistent;` does it by any key. **Consistent hashing** is the algorithm that keeps this mapping stable when servers are added or removed. Servers and keys are placed on a **hash ring**, and each key goes to the next server clockwise. Adding a 4th server moves only about **1/4 of keys**. Simple `hash % N` would move about **3/4** of them. This matters most for **cache servers**, where a moved key is a cache miss. For app sessions, though, my preferred design is **stateless app servers with sessions in Redis**. Then any server can handle any request, scaling and failover are simple, and stickiness becomes an optimisation instead of a requirement.

## 🧩 Scenario

Your Node.js app stores login sessions in memory (the default `express-session` MemoryStore). With one server it worked. After adding two more behind Nginx with round robin, users get randomly logged out. Request 1 logs them in on server A, and request 2 lands on server B, which has never heard of them. Separately, your team runs 3 cache nodes and wants to add a 4th before a sale. Last time someone did this, the cache hit ratio crashed and the database fell over.

## 💼 Use case

- **Legacy stateful apps** that keep sessions or uploads in local memory/disk and can't be changed quickly.
- **Cache tiers** (Nginx caches, Varnish, memcached-style nodes): send the same URL/key to the same node so it is cached once, not on every node.
- **WebSocket / long-lived connections**, where reconnecting to the same node can reuse warm state.
- **Sharding** in general (databases, queues, object stores): the same consistent-hashing idea decides which shard owns a key.

## ⚙️ How it works

**Where it sits in an HLD diagram:** `Client → Nginx (upstream: hash $key consistent) → App/cache node chosen by the hash ring`

**The problem: in-memory state + round robin**

```text
 Request 1 (login)  ──► Nginx ──► App A   session saved in A's memory ✔
 Request 2 (/cart)  ──► Nginx ──► App B   "who are you?"  → 401, user logged out ✖
```

**Three ways to solve it**

```text
 1) ip_hash                    2) hash $cookie_x consistent      3) Stateless + Redis (preferred)
 Nginx ─ hash(client IP) ─► A  Nginx ─ hash(cookie) ─► A         Nginx ─ round robin ─► A ┐
                                                                                         B ├─► Redis (sessions)
                                                                                         C ┘
 same IP → same server          same cookie → same server        any server can serve any user
```

| Method | Directive | Good | Bad |
|---|---|---|---|
| IP-based | `ip_hash;` | Zero app changes | Uses the first 3 octets of an IPv4 address, so a whole office/mobile carrier NAT lands on one server. Behind a CDN/cloud LB all users share a few IPs unless real-IP is set. Mobile users change IP. |
| Key-based | `hash $cookie_session_id consistent;` | Stable per user, any key (cookie, header, URI) | Requests without the cookie all hash the same empty key → one hot server (fix with a `map` fallback) |
| Cookie insertion | `sticky cookie srv_id expires=1h;` | Nginx sets and reads the cookie itself | **Nginx Plus only** (not in the Ubuntu apt package) |
| Stateless | (plain round robin / `least_conn`) | Simple scaling, any node can die | Needs an external store such as Redis, which is one more component |

**Why `hash % N` breaks when N changes: worked example (3 → 4 servers)**

Take 12 keys whose hash values are 0–11. Server index = `hash % N`.

```text
 hash :  0  1  2  3  4  5  6  7  8  9 10 11
 % 3  :  0  1  2  0  1  2  0  1  2  0  1  2    (3 servers)
 % 4  :  0  1  2  3  0  1  2  3  0  1  2  3    (4 servers)
 same?:  ✔  ✔  ✔  ✖  ✖  ✖  ✖  ✖  ✖  ✖  ✖  ✖

 Only 3 of 12 keys stay → 9 of 12 = 75% of keys MOVE.
 For a cache tier that means ~75% cache misses at once → the DB gets hammered.
```

**Consistent hashing: the hash ring**

Put servers **and** keys on the same ring (say positions 0–99). Each key belongs to the first server **clockwise** from it.

```text
 The ring "unrolled" (position 0 → 99, then it wraps back to 0):

  0 ── u1(5) ── A(10) ── u8(15) ── u2(22) ── u3(38) ── B(45) ── u4(50) ── u5(58) ── [D(60)] ── u6(70) ── C(80) ── u7(90) ── 99 ↩
       ●=server: A, B, C (and D, the new one)   u = user keys   each key → next server to its right (wrapping)

 Before (A=10, B=45, C=80):          After adding D at 60:
 u1(5)→A  u8(15)→B  u2(22)→B         u1→A  u8→B  u2→B  u3→B
 u3(38)→B u4(50)→C  u5(58)→C         u4→D  u5→D          ← only keys in (45,60] moved
 u6(70)→C u7(90)→A (wraps around)    u6→C  u7→A

 2 of 8 keys moved = 25% ≈ 1/N (N = 4). All other keys keep their server.
 Removing a server: only ITS keys move, to the next server clockwise.
```

With only one point per server, the slices are uneven. Real implementations, including Nginx's `consistent` (the **ketama** method), place **many virtual points per server** on the ring, so load spreads evenly and moved keys are shared across all remaining servers.

## 🛠️ Practical: step by step

Load-balancing methods in general are covered in [Load balancing methods](../02-intermediate/03-load-balancing-methods.md). Here we **measure** how many keys move with and without `consistent`.

1. **Start four tiny test backends** (only 3 will be used at first)

```bash
for p in 8081 8082 8083 8084; do
  mkdir -p /tmp/backend-$p
  echo "backend $p" > /tmp/backend-$p/index.html
  nohup python3 -m http.server $p --bind 127.0.0.1 --directory /tmp/backend-$p >/dev/null 2>&1 &
done
```

2. **Sticky-by-cookie upstream with consistent hashing**. Put the `map` in `/etc/nginx/conf.d/sticky-map.conf` (http context):

```nginx
# Users without a session cookie fall back to their IP,
# so they don't all hash the same empty key onto one server.
map $cookie_session_id $sticky_key {
    ""       $remote_addr;
    default  $cookie_session_id;
}
```

File: `/etc/nginx/sites-available/sticky.conf`

```nginx
upstream app_backend {
    hash $sticky_key consistent;      # ketama consistent hashing
    server 127.0.0.1:8081;
    server 127.0.0.1:8082;
    server 127.0.0.1:8083;
    # server 127.0.0.1:8084;          # step 4: uncomment to "scale out"
    # Note: 'backup' is NOT allowed together with 'hash'.
}

server {
    listen 80;
    server_name sticky.example.com;

    location / {
        proxy_pass http://app_backend;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sticky.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

3. **Record which backend 100 different "users" land on**

```bash
for i in $(seq 1 100); do
  echo "user$i $(curl -s -H 'Host: sticky.example.com' -H "Cookie: session_id=user$i" http://127.0.0.1/)"
done > /tmp/before.txt
head -n 3 /tmp/before.txt
```

4. **Add the 4th server**: uncomment `server 127.0.0.1:8084;`, reload, record again, then count moved users

```bash
sudo nginx -t && sudo systemctl reload nginx
for i in $(seq 1 100); do
  echo "user$i $(curl -s -H 'Host: sticky.example.com' -H "Cookie: session_id=user$i" http://127.0.0.1/)"
done > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt | grep -c '^>'      # number of users that moved
```

5. **Compare with plain modulo hashing**: change the line to `hash $sticky_key;` (no `consistent`), comment out 8084 again, and repeat steps 3–4. You should see many more users move.

6. **The better long-term fix: make the app stateless.** Store sessions in Redis so stickiness is no longer needed (Node example):

```bash
npm install express express-session connect-redis@7 redis@4
```

```js
// server.js: sessions live in Redis, so any app server can handle any user
const express = require('express');
const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;   // connect-redis v7 API

const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);

const app = express();
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
}));
app.get('/', (req, res) => { req.session.views = (req.session.views || 0) + 1; res.json(req.session); });
app.listen(3000);
```

Then the upstream can go back to round robin or `least_conn`. The versions are pinned because `connect-redis` changed its import style in later major versions. If you upgrade, check its README.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/conf.d/sticky-map.conf` | `map` that builds the hash key (cookie, or IP fallback), http context |
| `/etc/nginx/sites-available/sticky.conf` | Upstream with `hash ... consistent` and the server block |
| `/etc/nginx/sites-enabled/sticky.conf` | Symlink that activates it |
| `/tmp/before.txt`, `/tmp/after.txt` | Key → backend mapping before/after scaling, used to count moved keys |
| `/tmp/backend-808x/` | Test backends |

## ✅ Verify it works

Same user, same backend (run it several times):

```bash
for n in 1 2 3 4 5; do curl -s -H 'Host: sticky.example.com' -H 'Cookie: session_id=user42' http://127.0.0.1/; done
```

Example output:

```text
backend 8082
backend 8082
backend 8082
backend 8082
backend 8082
```

The moved-key count from step 4 should be **roughly 25 out of 100** with `consistent` (about 1/N for N = 4), and **much higher** (around 75 in theory) with plain `hash`. Exact numbers depend on the keys, so treat them as approximate.

## ⚠️ Common mistakes

- Using `ip_hash` behind a CDN or cloud load balancer without the real-IP module. Every request has the LB's IP, so one backend gets all the traffic.
- Hashing on a cookie that new visitors don't have yet. All anonymous users land on one server. Use a `map` fallback.
- Treating sticky sessions as high availability. If the sticky server dies, its users lose their in-memory sessions anyway.
- Forgetting that stickiness hurts load balance. A few heavy users or a big NAT can overload one node.
- Adding `backup` to a `hash`/`ip_hash` upstream. Nginx refuses the config.
- Scaling a cache tier with `hash % N` (no `consistent`). Most keys move and the cache hit ratio collapses.

## 🔁 Follow-up questions interviewers ask

1. **Trade-off: sticky sessions vs a shared session store (Redis)?**
   Sticky sessions need no new component but give uneven load and lose sessions when a node dies. Redis adds a dependency and a network hop, but makes app servers stateless, so any node can serve any user and scaling is trivial.
2. **Why do virtual nodes matter in consistent hashing?**
   With one point per server, slices of the ring are uneven and a removed server dumps all its keys on one neighbour. Many virtual points spread load evenly and share the moved keys across all servers.
3. **What happens to a key when its server in a `hash` upstream is marked down?**
   Nginx picks another server for that request, so the user is not stuck on a dead node, but in-memory state on the failed node is lost.
4. **Where else is consistent hashing used?**
   Distributed caches, DynamoDB/Cassandra-style data partitioning, and CDN request routing. The idea is always the same: when the number of nodes changes, move as few keys as possible.
5. **How would you keep WebSocket users on the same node?**
   Hash on a user/session key (`hash $cookie_session_id consistent`). Better still, share state through Redis pub/sub so it doesn't matter which node a socket lands on. See [WebSocket proxy](../03-advanced/05-websocket-proxy.md).

---
[⬅️ Previous](06-cdn-vs-nginx-caching.md) · [🏠 Index](../README.md) · [Next ➡️](08-rate-limiting-algorithms.md)

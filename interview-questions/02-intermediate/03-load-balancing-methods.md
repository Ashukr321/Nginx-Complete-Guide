# Q: What load-balancing methods does Nginx support, and how do you configure them?

> **Level:** Intermediate · **Asked in:** DevOps, SRE, Backend, Platform Engineering

## 🎯 Short answer (say this in the interview)

Open-source Nginx supports **round robin** (the default), **weighted** round robin, **`least_conn`**, **`ip_hash`**, generic **`hash`** (with optional `consistent` hashing), and **`random`** (optionally `random two least_conn`). You define backends in an `upstream` block and send traffic with `proxy_pass`. Each server can have parameters like `weight`, `max_fails`, `fail_timeout`, `backup`, and `down`; open source does **passive** health checks only. Features like `least_time`, active `health_check`, and `sticky` sessions are **Nginx Plus** (commercial) only. For performance, I also enable `keepalive` connections to the upstream with `proxy_http_version 1.1` and an empty `Connection` header.

## 🧩 Scenario

Your Node.js API runs on one server and CPU is at 100% during sales. You add two more app servers (`10.0.0.11`, `10.0.0.12`, `10.0.0.13`). One of them is a bigger machine. Some requests (report generation) take much longer than others. And the old checkout code still stores sessions in memory, so a user must keep hitting the same server. You need to pick the right method for each need.

![Load balancer scenario](../../resoruces/scenario_load_balancer.png)

## 💼 Use case

- Spreading API traffic across many identical app servers.
- Sending more traffic to bigger machines (`weight`).
- Long-lived or uneven requests (uploads, reports, WebSockets) → `least_conn`.
- Apps with in-memory sessions → `ip_hash` or `hash $cookie_...`.
- Cache servers where the same URL should hit the same node → `hash $request_uri consistent`.
- A standby server that only gets traffic when all others fail → `backup`.

## ⚙️ How it works

```text
                         Clients
                            |
                            v
                  +--------------------+
                  |       Nginx        |
                  |  proxy_pass        |
                  |  http://api_pool;  |
                  +---------+----------+
                            |  picks a server using the
                            |  load-balancing method
         +------------------+------------------+-----------------+
         |                  |                  |                 |
         v                  v                  v                 v
   10.0.0.11:5000     10.0.0.12:5000     10.0.0.13:5000     10.0.0.20:5000
   weight=3           weight=1           max_fails=3        backup
                                         fail_timeout=30s   (only if others down)
```

### Methods at a glance

| Method | Directive | How it picks | Good for | Open source? |
|---|---|---|---|---|
| Round robin | *(default, no directive)* | In turn, 1→2→3→1… | Identical servers, short requests | ✅ |
| Weighted RR | `server ... weight=3;` | Proportional to weight | Servers of different sizes | ✅ |
| Least connections | `least_conn;` | Fewest active connections (weights considered) | Long or uneven requests | ✅ |
| IP hash | `ip_hash;` | Hash of client IP (first 3 octets of IPv4, whole IPv6) | Simple session stickiness | ✅ |
| Generic hash | `hash $request_uri consistent;` | Hash of any key you choose | Caches, custom stickiness | ✅ |
| Random | `random;` / `random two least_conn;` | Random, or best of two random picks | Many Nginx LBs sharing one pool | ✅ |
| Least time | `least_time header;` / `random two least_time=...` | Lowest response time + connections | Latency-sensitive | ❌ **Nginx Plus only** |
| Active health checks | `health_check;` | Nginx probes servers itself | Detecting failures before users hit them | ❌ **Nginx Plus only** |
| Sticky cookie | `sticky cookie ...;` | Cookie set by Nginx | Session affinity | ❌ **Nginx Plus only** |

### Server parameters (open source)

| Parameter | Meaning | Default |
|---|---|---|
| `weight=N` | Relative share of traffic | `1` |
| `max_fails=N` | Failures within `fail_timeout` before marking server unavailable | `1` |
| `fail_timeout=T` | Window for counting failures **and** how long the server stays unavailable | `10s` |
| `backup` | Used only when all primary servers are unavailable (not allowed with `hash`, `ip_hash`, `random`) | — |
| `down` | Permanently marked unavailable (maintenance) | — |
| `max_conns=N` | Limit concurrent connections to this server | `0` (no limit) |

**Passive health checks (open source):** Nginx only learns a server is bad when a *real* request to it fails. What counts as a failure is controlled by `proxy_next_upstream` (default: `error timeout`).

### Upstream keepalive

By default Nginx opens a **new TCP connection** to the backend for every request (HTTP/1.0, `Connection: close`). With `keepalive`, idle connections are cached and reused:

```text
Without keepalive:  req -> [TCP handshake] -> request -> close   (every time)
With keepalive:     req -> [reuse open TCP connection] -> request -> keep open
```

Three things are required together:

1. `keepalive N;` in the `upstream` block (N = idle connections cached **per worker**).
2. `proxy_http_version 1.1;` in the location.
3. `proxy_set_header Connection "";` to stop Nginx sending `Connection: close`.

## 🛠️ Practical: step by step

1. (For a lab) start three tiny backends on one machine. Requires Python 3 (preinstalled on Ubuntu).

```bash
mkdir -p ~/lb-lab/{s1,s2,s3}
for i in 1 2 3; do echo "hello from backend $i" > ~/lb-lab/s$i/index.html; done
cd ~/lb-lab/s1 && nohup python3 -m http.server 5001 --bind 127.0.0.1 >/dev/null 2>&1 &
cd ~/lb-lab/s2 && nohup python3 -m http.server 5002 --bind 127.0.0.1 >/dev/null 2>&1 &
cd ~/lb-lab/s3 && nohup python3 -m http.server 5003 --bind 127.0.0.1 >/dev/null 2>&1 &
```

2. Create the load balancer config. `upstream` must be in the `http` context — files in `conf.d/` and `sites-enabled/` are included inside `http`, so it is fine here.

```bash
sudo nano /etc/nginx/conf.d/lb-demo.conf
```

```nginx
# File: /etc/nginx/conf.d/lb-demo.conf

# ---- Pool 1: weighted round robin + passive health checks + keepalive ----
upstream api_pool {
    # Load-balancing method goes FIRST (before keepalive).
    # Uncomment ONE of these to change the method:
    # least_conn;
    # ip_hash;
    # hash $request_uri consistent;
    # random two least_conn;

    server 127.0.0.1:5001 weight=3;                       # gets ~3/5 of traffic
    server 127.0.0.1:5002 weight=1 max_fails=3 fail_timeout=30s;
    server 127.0.0.1:5003 backup;                         # only when 5001 & 5002 are down
                                                          # (remove "backup" if you enable
                                                          #  ip_hash, hash or random)
    # server 127.0.0.1:5004 down;                         # in maintenance

    keepalive 16;     # idle keepalive connections cached per worker
}

server {
    listen 80;
    server_name lb.local;

    location / {
        proxy_pass http://api_pool;

        # Required for upstream keepalive
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Pass client info to backends
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Retry next server on these errors (passive failover)
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_connect_timeout 3s;

        # Show which backend answered (handy for testing; remove in prod)
        add_header X-Upstream $upstream_addr always;
    }
}
```

3. Test and reload.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Quick examples of each method

```nginx
# Least connections
upstream app_lc   { least_conn; server 10.0.0.11:5000; server 10.0.0.12:5000; }

# Client-IP stickiness
upstream app_ip   { ip_hash;    server 10.0.0.11:5000; server 10.0.0.12:5000; }

# Consistent hashing on URI (adding/removing a node remaps only a small share of keys)
upstream cache_ch { hash $request_uri consistent; server 10.0.0.31; server 10.0.0.32; }

# Stickiness on a session cookie (open-source alternative to Plus "sticky")
upstream app_ck   { hash $cookie_sessionid; server 10.0.0.11:5000; server 10.0.0.12:5000; }

# Power of two choices
upstream app_rnd  { random two least_conn; server 10.0.0.11:5000; server 10.0.0.12:5000; server 10.0.0.13:5000; }
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/conf.d/lb-demo.conf` | `upstream` pool + `server` block that proxies to it |
| `/etc/nginx/nginx.conf` | Main config; its `http {}` includes `conf.d/*.conf` |
| `/var/log/nginx/error.log` | Shows `upstream timed out`, `connect() failed`, `no live upstreams` |
| `/var/log/nginx/access.log` | Add `$upstream_addr` to `log_format` to see which backend served each request |

## ✅ Verify it works

```bash
# Expect roughly 3 responses from backend 1 for every 1 from backend 2
for i in $(seq 1 8); do curl -s -H 'Host: lb.local' http://127.0.0.1/; done

# See which upstream answered
curl -sI -H 'Host: lb.local' http://127.0.0.1/ | grep -i x-upstream
# X-Upstream: 127.0.0.1:5001

# Kill backend 1 and 2 -> backup (5003) should start answering
pkill -f 'http.server 5001'; pkill -f 'http.server 5002'
curl -s -H 'Host: lb.local' http://127.0.0.1/
# hello from backend 3

# Confirm keepalive (with a real HTTP/1.1 backend such as Node/Express):
# you should see a few ESTABLISHED connections being reused, not a pile of TIME_WAIT.
# Note: python's http.server speaks HTTP/1.0 and closes every connection,
# so this check is only meaningful against a real app server.
ss -tan | grep -E ':500[0-9]' | awk '{print $1}' | sort | uniq -c
```

## ⚠️ Common mistakes

- Using `backup` together with `ip_hash`, `hash` or `random` → config error.
- Putting `keepalive` **before** the method directive (e.g. `least_conn`). The docs say the method must be activated before `keepalive`.
- Enabling `keepalive` but forgetting `proxy_http_version 1.1;` and `proxy_set_header Connection "";` → connections are still closed every time.
- Claiming open-source Nginx does active health checks. It does not; `health_check` is Plus-only. Open source is passive (`max_fails`/`fail_timeout`), or use an external tool.
- Using `ip_hash` behind a CDN or cloud LB — every request appears to come from the LB's few IPs, so traffic sticks to one backend. Use `hash $http_x_forwarded_for` or a cookie, or fix the client IP with the realip module.
- Retrying non-idempotent requests (POST) blindly. By default Nginx does **not** retry non-idempotent requests on another server unless `proxy_next_upstream non_idempotent` is set — know this before enabling it.

## 🔁 Follow-up questions interviewers ask

- **Round robin vs least_conn — when do you switch?** When request durations vary a lot (uploads, reports, WebSockets); `least_conn` avoids piling new requests onto a server busy with slow ones.
- **What does `consistent` add to `hash`?** It uses ketama consistent hashing, so adding or removing a server remaps only a small portion of keys — important for cache servers.
- **How does open-source Nginx detect a dead backend?** Passively: after `max_fails` failed attempts within `fail_timeout`, the server is skipped for `fail_timeout`, then tried again.
- **What happens if all servers are down?** Nginx returns `502 Bad Gateway` and logs `no live upstreams` in the error log.
- **How do you do sticky sessions without Nginx Plus?** `ip_hash` or `hash $cookie_<name>`; better still, make the app stateless (sessions in Redis/DB) so any server can serve any user.

---
[⬅️ Previous](02-root-vs-alias.md) · [🏠 Index](../README.md) · [Next ➡️](04-https-ssl-certbot-setup.md)

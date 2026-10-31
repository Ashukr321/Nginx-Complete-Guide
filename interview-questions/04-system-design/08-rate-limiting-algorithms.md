# Q: What rate-limiting algorithms exist, and which one does Nginx use? How do you rate limit across many Nginx servers?

> **Level:** System Design · **Asked in:** DevOps, Backend, SRE, API/Platform Engineer, System Design round

## 🎯 Short answer (say this in the interview)

There are five common algorithms:

- **Fixed window:** count requests per clock minute. Simple, but allows a double burst at the window edge.
- **Sliding window log:** store every request's timestamp. Exact, but memory-heavy.
- **Sliding window counter:** a weighted mix of the current and previous window. Close to exact and cheap.
- **Token bucket:** tokens refill at a steady rate, and each request spends one. It allows short bursts up to the bucket size.
- **Leaky bucket:** requests enter a queue that drains at a constant rate. The output is smooth.

**Nginx `limit_req` uses the leaky bucket.** `rate` is the drain rate, `burst` is the queue size, and excess requests are delayed to match the rate. With `nodelay`, requests that fit in the burst are served immediately, which in practice behaves much like a token bucket. Rejected requests should get **`429 Too Many Requests` with a `Retry-After` header**. The catch in system design: `limit_req` state is in **shared memory on one machine**. With 3 Nginx nodes, a client can get up to 3× the limit. For a strict global limit I use a **central counter in Redis** (in the app, an API gateway, or OpenResty). Other options are cluster sync (**Nginx Plus**) or an approximation: divide the limit per node, or make the LB sticky by client IP.

## 🧩 Scenario

You run a public API with free and paid plans. The rule is: free users get 100 requests per minute. Traffic grows, so you go from one Nginx server to three behind a cloud load balancer. A free user's script now gets about 300 requests per minute through, because each Nginx node only counts the requests it sees. Meanwhile, the mobile team complains that when their app opens it fires 10 calls at once and some get rejected. The interviewer asks: "Which algorithm would you choose, and how do you enforce the limit globally?"

## 💼 Use case

- Protecting login/OTP endpoints from brute force (per-IP or per-username limits).
- Per-API-key quotas for paid plans (needs a **global** count → Redis).
- Shielding a slow backend or third-party API from traffic spikes (smooth rate → leaky bucket).
- Allowing short bursts from real clients (page load fires many calls) while blocking sustained abuse (token bucket / `burst` + `nodelay`).

## ⚙️ How it works

**Where it sits in an HLD diagram:** `Client → CDN/WAF (coarse limits) → Nginx limit_req (per node, per IP) → App/API gateway (global per-user limit in Redis) → Backend`

**The five algorithms**

```text
 1) FIXED WINDOW (limit 100/min)
    |—— 12:00–12:01 ——|—— 12:01–12:02 ——|
                 100 req ▲ 100 req          ← 200 requests in ~2 seconds around 12:01
                       boundary problem

 2) SLIDING WINDOW LOG
    keep timestamps: [12:00:05, 12:00:09, ... ]  → drop those older than 60 s → count ≤ 100?
    exact, but stores one entry per request

 3) SLIDING WINDOW COUNTER
    estimate = current_count + previous_count × (1 − elapsed_fraction_of_current_window)

 4) TOKEN BUCKET                         5) LEAKY BUCKET  (Nginx limit_req)
    refill r tokens/s                       requests ──► [ queue of size = burst ] ──► leaks out at rate r
         │                                                   │ full?
    [ bucket, capacity B ]                                   └──► reject (429)
         │ request takes 1 token
    empty? → reject                         output is smooth: never faster than r
    allows bursts up to B, then rate r
```

**Worked example: sliding window counter**

Limit = 100 requests/minute. The previous minute had **80** requests. We are **15 s (25%)** into the current minute, which has **30** requests so far.

```text
 estimate = 30 + 80 × (1 − 0.25) = 30 + 60 = 90   → 90 < 100 → allow
```

**Comparison**

| Algorithm | Memory per key | Accuracy | Bursts | Typical use |
|---|---|---|---|---|
| Fixed window | 1 counter | Low at window edges | Up to 2× at the boundary | Simple quotas ("1000/day") |
| Sliding window log | 1 entry per request | Exact | No | Low-volume, strict limits |
| Sliding window counter | 2 counters | Very close | Smoothed | API gateways, Redis-based limits |
| Token bucket | Tokens + timestamp | Good | Yes, up to bucket size | Public APIs, cloud provider APIs |
| Leaky bucket | Queue / level + timestamp | Good | Queued, then smoothed | Protecting fragile backends. **Nginx `limit_req`** |

**How Nginx's leaky bucket behaves** (`rate=5r/s burst=5`; details in [Rate limiting](../03-advanced/04-rate-limiting.md))

```text
 12 requests arrive at the same moment:

 without nodelay:  #1 served now, #2–#6 QUEUED and released every 200 ms (0.2s, 0.4s … 1.0s),
                   #7–#12 → 429
 with nodelay:     #1–#6 served NOW, #7–#12 → 429,
                   and the 5 burst slots free up one every 200 ms
```

**The multi-node problem**

```text
                      ┌──► Nginx 1  (sees ~1/3 of the client's requests, counts only those)
 client ──► cloud LB ─┼──► Nginx 2  (its own counter)
                      └──► Nginx 3  (its own counter)
 limit 100/min per node  →  client can get up to ~300/min in total
```

| Option | How | Trade-off |
|---|---|---|
| Divide the limit | Set each node to `limit / N` | Easy, but only right if the LB spreads evenly. Must update when N changes. |
| Sticky LB | LB sends the same client IP to the same Nginx | Per-node limit becomes per-client, but load can be uneven |
| Central store (Redis) | App, gateway or OpenResty does `INCR` + `EXPIRE` / Lua script in Redis | Exact and global, but adds a network hop and Redis becomes critical (decide fail-open vs fail-closed) |
| Cluster sync | `limit_req_zone ... sync` with `zone_sync` | **Nginx Plus only**. Eventually consistent between nodes. |

A common layered answer: **Nginx `limit_req` per node** as a cheap first shield against floods (by IP), plus a **global per-user/API-key limit in Redis** at the app or gateway for business quotas.

## 🛠️ Practical: step by step

1. **Start a test backend**

```bash
mkdir -p /tmp/backend-8085 && echo "ok" > /tmp/backend-8085/index.html
nohup python3 -m http.server 8085 --bind 127.0.0.1 --directory /tmp/backend-8085 >/dev/null 2>&1 &
```

2. **Define the zone** (http context). File: `/etc/nginx/conf.d/algo-demo-zone.conf`

```nginx
# Leaky bucket: per client IP, drains at 5 requests per second
limit_req_zone $binary_remote_addr zone=algo_demo:10m rate=5r/s;
```

3. **Apply it and return a proper 429 with `Retry-After`**. File: `/etc/nginx/sites-available/ratelimit-demo.conf`

```nginx
server {
    listen 80;
    server_name ratelimit.example.com;

    location /api/ {
        limit_req zone=algo_demo burst=5 nodelay;   # queue size 5, burst served immediately
        limit_req_status 429;                       # default would be 503
        error_page 429 = @too_many;                 # custom body + Retry-After
        proxy_pass http://127.0.0.1:8085/;          # note: 'return' would run BEFORE limit_req, so use a real backend
    }

    location @too_many {
        default_type application/json;
        add_header Retry-After 1 always;            # tell clients when to retry (seconds)
        return 429 '{"error":"rate_limited","retry_after_seconds":1}\n';
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ratelimit-demo.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

4. **Fire 12 parallel requests** (`nodelay` behaviour)

```bash
seq 1 12 | xargs -P 12 -I{} curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
  -H "Host: ratelimit.example.com" http://127.0.0.1/api/ | sort
```

5. **See the pure leaky bucket**: remove `nodelay` from the `limit_req` line, reload, and run step 4 again. Accepted requests now show growing `time_total` values (about 0.2 s apart) because Nginx queues them.

6. **Global limit across many Nginx nodes: Redis fixed-window counter in the app** (Node + `redis@4`)

```js
// rateLimit.js: global per-API-key limit shared by every app/Nginx node
const { createClient } = require('redis');
const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
redis.connect().catch(console.error);

const LIMIT = 100, WINDOW_SEC = 60;

module.exports = async function rateLimit(req, res, next) {
  const id = req.get('X-API-Key') || req.ip;
  const window = Math.floor(Date.now() / 1000 / WINDOW_SEC);
  const key = `rl:${id}:${window}`;                     // one counter per client per minute
  try {
    const [count] = await redis.multi().incr(key).expire(key, WINDOW_SEC).exec();
    if (count > LIMIT) {
      const retryAfter = WINDOW_SEC - (Math.floor(Date.now() / 1000) % WINDOW_SEC);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  } catch (err) {
    next();   // fail-open: if Redis is down, don't block all traffic (choose deliberately)
  }
};
```

This is a **fixed window**, the simplest version. For smoother limits, use a sliding-window-counter or token-bucket Lua script in Redis, or a ready-made library such as `rate-limit-redis` for `express-rate-limit`.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/conf.d/algo-demo-zone.conf` | `limit_req_zone`: the leaky bucket definition (http context) |
| `/etc/nginx/sites-available/ratelimit-demo.conf` | Applies `limit_req`, sets 429 and the `Retry-After` response |
| `/etc/nginx/sites-enabled/ratelimit-demo.conf` | Symlink that activates it |
| `/var/log/nginx/error.log` | `limiting requests, excess: ... by zone "algo_demo"` lines |
| `rateLimit.js` (app code) | Global Redis-backed limit for multi-node setups |

## ✅ Verify it works

Example output of step 4 with `nodelay` (sorted):

```text
200 0.002s
200 0.002s
200 0.003s
200 0.003s
200 0.003s
200 0.004s
429 0.001s
429 0.001s
429 0.001s
429 0.001s
429 0.001s
429 0.001s
```

About 6 accepted (1 + burst 5), the rest rejected. The exact split can vary by one or two depending on timing. Check the headers of a rejected request:

```bash
for i in $(seq 1 15); do curl -s -o /dev/null -H "Host: ratelimit.example.com" http://127.0.0.1/api/; done
curl -si -H "Host: ratelimit.example.com" http://127.0.0.1/api/ | grep -iE '^(HTTP|retry-after)'
sudo grep 'limiting requests' /var/log/nginx/error.log | tail -n 2
```

Example output:

```text
HTTP/1.1 429 Too Many Requests
Retry-After: 1
```

## ⚠️ Common mistakes

- Assuming `limit_req` is global. It is per Nginx instance (shared between workers, not between machines).
- Keying on `$binary_remote_addr` behind a CDN/LB without real-IP. All users share the LB's IP and get limited together.
- Forgetting `burst`. With `rate=5r/s` and no burst, two requests 50 ms apart already trigger a rejection, because Nginx tracks the rate in milliseconds.
- Leaving the default `503`. Clients and monitoring then think the service is down instead of "slow down". Use `429` + `Retry-After`.
- Testing with `return 200` in the same location. `return` runs before `limit_req`, so nothing is limited.
- Making the Redis limiter fail-closed by accident. A Redis outage then blocks 100% of traffic.

## 🔁 Follow-up questions interviewers ask

1. **Token bucket vs leaky bucket?**
   A token bucket allows bursts up to the bucket size and then the steady rate. A leaky bucket smooths output to a constant rate by queuing. Nginx is a leaky bucket, and with `nodelay` it behaves close to a token bucket.
2. **Trade-off: rate limit at Nginx or in the app?**
   Nginx is cheap and stops floods before they reach the app, but it only knows IPs/headers and counts per node. The app or gateway knows users, plans and API keys, and can use Redis for global counts, but each check costs a Redis call.
3. **Redis is down. Fail-open or fail-closed?**
   Usually fail-open for general APIs, so a limiter outage doesn't become a full outage. Fail-closed for security-sensitive endpoints like login/OTP. Keep Nginx's per-IP limit as a backstop either way.
4. **How do you avoid race conditions in a Redis limiter?**
   Use atomic operations (`INCR`, `MULTI`/`EXEC`) or a Lua script, so the read-check-update happens as one step in Redis.
5. **How do clients know how long to wait?**
   Send `Retry-After`, and optionally `RateLimit-*` style headers (limit, remaining, reset). Clients should back off with jitter instead of retrying immediately.

---
[⬅️ Previous](07-consistent-hashing-and-sticky-sessions.md) · [🏠 Index](../README.md) · [Next ➡️](09-ssl-termination-passthrough-reencryption.md)

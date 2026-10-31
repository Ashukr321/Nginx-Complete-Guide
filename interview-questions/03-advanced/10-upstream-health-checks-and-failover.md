# Q: How does Nginx detect a failed backend and fail over to a healthy one?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Backend

## 🎯 Short answer (say this in the interview)

Nginx open source uses **passive health checks**: it watches real client requests. If connecting to or reading from a backend fails `max_fails` times within `fail_timeout`, that server is marked unavailable for `fail_timeout` and traffic goes to the others. `proxy_next_upstream` decides which failures (error, timeout, certain 5xx codes) make Nginx **retry the same request on the next server**, limited by `proxy_next_upstream_tries` and `proxy_next_upstream_timeout`. I can mark a server as `backup` (used only when all primaries are down) or `down` (taken out for maintenance). **Active health checks** — Nginx probing a `/health` URL on its own with the `health_check` directive — are an **Nginx Plus** feature. One caveat: by default Nginx does not retry non-idempotent requests like `POST` once they were sent, to avoid duplicate orders or payments.

## 🧩 Scenario

You run an order API on three Node.js servers behind Nginx. During a deployment, one server is restarted and for 30 seconds some users get `502 Bad Gateway`. Another time a server's disk fills up and it starts answering every request with `500`, but Nginx keeps sending it traffic. Your lead asks you to make Nginx route around broken servers automatically and keep a standby server for emergencies.

## 💼 Use case

- Rolling deployments where backends restart one by one.
- Surviving a crashed or hung app instance without user-visible errors.
- Disaster-recovery "standby" servers (`backup`) in another zone.
- Planned maintenance (`down`) without editing the whole upstream.

## ⚙️ How it works

```text
                         upstream app_backend
 client ──► NGINX ──┬──► 10.0.0.11:3000  ✔ healthy
                    ├──► 10.0.0.12:3000  ✖ refused  ──► counts as 1 fail
                    │        │  fails ≥ max_fails within fail_timeout?
                    │        └─► mark UNAVAILABLE for fail_timeout (e.g. 30s),
                    │            then try it again with a real request
                    ├──► 10.0.0.13:3000  ✔ healthy
                    └──► 10.0.0.20:3000  (backup) used ONLY if all above are unavailable

 Same request, retry on the next server (proxy_next_upstream):
   GET /orders ──► .12 (connection refused) ──► retried on .13 ──► 200 OK
   user never sees the error
```

**Passive (open source) vs active (Plus)**

| | Passive health checks | Active health checks |
|---|---|---|
| Available in | Nginx open source + Plus | **Nginx Plus only** (`health_check` directive) |
| How a failure is detected | A real client request fails | Nginx sends its own periodic probe (e.g. `GET /health`) |
| Detects a broken server before users hit it | No — at least one real request fails first (but can be retried) | Yes |
| Key directives | `max_fails`, `fail_timeout`, `proxy_next_upstream*` | `health_check`, `match`, requires `zone` in the upstream |

**Key parameters**

| Directive / parameter | Context | Default | Meaning |
|---|---|---|---|
| `max_fails=3` | `server` line in `upstream` | 1 | Failed attempts within `fail_timeout` before marking the server unavailable. `0` disables the check. |
| `fail_timeout=30s` | `server` line | 10s | Window for counting failures **and** how long the server stays unavailable. |
| `backup` | `server` line | — | Used only when all primary servers are unavailable. Not allowed with `hash`, `ip_hash` or `random`. |
| `down` | `server` line | — | Permanently marked unavailable. |
| `proxy_next_upstream` | http/server/location | `error timeout` | Which failures trigger a retry on the next server. |
| `proxy_next_upstream_tries` | http/server/location | 0 (no limit) | Max number of servers to try for one request. |
| `proxy_next_upstream_timeout` | http/server/location | 0 (no limit) | Max total time spent retrying. |
| `zone` | `upstream` | — | Shares upstream state across workers (available in open source; required by Plus `health_check`). |

What counts as a failure for `max_fails` is defined by `proxy_next_upstream` (except `http_404`, which never counts as a failure).

## 🛠️ Practical: step by step

1. **Start three tiny test backends** (Python is already on Ubuntu)

```bash
for p in 8081 8082 8083; do
  mkdir -p /tmp/backend-$p
  echo "backend $p" > /tmp/backend-$p/index.html
  nohup python3 -m http.server $p --bind 127.0.0.1 --directory /tmp/backend-$p >/dev/null 2>&1 &
done
curl -s http://127.0.0.1:8081/   # expect: backend 8081
```

2. **Configure the upstream with failover** — file: `/etc/nginx/sites-available/failover.conf`

```nginx
upstream app_backend {
    zone app_backend 64k;                                   # share fail counters across workers

    server 127.0.0.1:8081 max_fails=3 fail_timeout=30s;
    server 127.0.0.1:8082 max_fails=3 fail_timeout=30s;
    server 127.0.0.1:8083 backup;                           # standby: only when 8081 + 8082 are down
    # server 127.0.0.1:8084 down;                           # example: under maintenance
}

server {
    listen 80;
    server_name failover.example.com;

    location / {
        proxy_pass http://app_backend;
        proxy_set_header Host $host;

        # Retry on the next server for these failures
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_next_upstream_tries 2;        # at most 2 servers per request
        proxy_next_upstream_timeout 10s;    # stop retrying after 10s total

        # Fail fast so retries happen quickly
        proxy_connect_timeout 2s;
        proxy_read_timeout 15s;
    }
}
```

3. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/failover.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

4. **Demo: kill one backend while traffic flows** — terminal 1:

```bash
while true; do
  curl -s -H "Host: failover.example.com" http://127.0.0.1/ ; sleep 0.3
done
```

Terminal 2:

```bash
pkill -f "http.server 8082"      # kill backend 8082
```

Terminal 1 keeps printing `backend 8081` with **no errors**: the failed request to 8082 was retried on 8081 and 8082 was marked unavailable.

```bash
pkill -f "http.server 8081"      # now kill 8081 too → traffic moves to the backup 8083
```

Bring them back and, after `fail_timeout`, traffic spreads again:

```bash
for p in 8081 8082; do
  nohup python3 -m http.server $p --bind 127.0.0.1 --directory /tmp/backend-$p >/dev/null 2>&1 &
done
```

5. **Retrying POST — the idempotency caveat**

Since Nginx 1.9.13, a request with a **non-idempotent** method (`POST`, `LOCK`, `PATCH`) is **not** passed to the next server if it was already sent to an upstream. A connection refused before sending is still retried. Only enable retries for POST if the API is safe to call twice (e.g. uses idempotency keys):

```nginx
location /api/payments/ {
    proxy_pass http://app_backend;
    proxy_next_upstream error timeout;     # default behaviour: no blind POST retries
}

location /api/search/ {                    # POST but read-only → safe to retry
    proxy_pass http://app_backend;
    proxy_next_upstream error timeout non_idempotent;
}
```

6. **Nginx Plus only: active health checks** (shown for interviews; this will **not** load on open-source Nginx — `nginx -t` fails with `unknown directive "health_check"`)

```nginx
# NGINX PLUS ONLY
upstream app_backend {
    zone app_backend 64k;                 # required for health_check
    server 10.0.0.11:3000;
    server 10.0.0.12:3000;
}

match app_ok {
    status 200;
    body ~ "ok";
}

server {
    location / {
        proxy_pass http://app_backend;
        health_check uri=/health interval=5s fails=3 passes=2 match=app_ok;
    }
}
```

Open-source alternatives for active checks: an external tool or orchestrator that removes bad nodes (Kubernetes readiness probes, Consul + consul-template), or third-party modules such as `nginx_upstream_check_module` (requires compiling Nginx).

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/failover.conf` | Upstream with `max_fails`, `fail_timeout`, `backup`, and retry rules |
| `/etc/nginx/sites-enabled/failover.conf` | Symlink that activates it |
| `/var/log/nginx/error.log` | `connect() failed` and `upstream server temporarily disabled` messages |
| `/var/log/nginx/access.log` | Add `$upstream_addr` / `$upstream_status` to see which servers were tried |
| `/tmp/backend-808x/` | Test backends for the demo |

## ✅ Verify it works

Add a log format that shows the retry chain — in `/etc/nginx/conf.d/upstream-log.conf`:

```nginx
log_format upstream_log '$remote_addr "$request" $status upstream=$upstream_addr ustatus=$upstream_status rt=$upstream_response_time';
```

and in the `server` block: `access_log /var/log/nginx/failover_access.log upstream_log;`

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/failover_access.log
```

Example line right after killing 8082 (two servers tried, comma-separated):

```text
127.0.0.1 "GET / HTTP/1.1" 200 upstream=127.0.0.1:8082, 127.0.0.1:8081 ustatus=502, 200 rt=0.000, 0.002
```

Error log:

```bash
sudo grep -E "connect\(\) failed|temporarily disabled" /var/log/nginx/error.log | tail -n 3
```

Example:

```text
[error] 1502#1502: *88 connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, server: failover.example.com, request: "GET / HTTP/1.1", upstream: "http://127.0.0.1:8082/", host: "failover.example.com"
```

The `upstream server temporarily disabled` message is logged at `warn` level, so you only see it if `error_log` is set to `warn` or lower (Ubuntu's default level is `error`).

## ⚠️ Common mistakes

- Thinking open-source Nginx has active health checks — it doesn't; `health_check` is Plus only.
- Leaving `proxy_connect_timeout` at the default 60s — a dead server that drops packets makes users wait a full minute before a retry.
- Adding `http_500` to `proxy_next_upstream` for APIs where a 500 is a real application error — every request then hits two servers.
- Turning on `non_idempotent` globally and creating duplicate orders/payments.
- Using `backup` together with `ip_hash` or `hash` — Nginx refuses that combination.
- No `proxy_next_upstream_tries` limit with many servers — one slow request can try every server and take a very long time.

## 🔁 Follow-up questions interviewers ask

1. **What's the difference between `down` and `backup`?**
   `down` means never send traffic there. `backup` means only send traffic there when all non-backup servers are unavailable.
2. **With `max_fails=1` (default), will one failed request take a server out?**
   Yes, for `fail_timeout` (10s by default). After that, Nginx tries it again with a real request.
3. **Does Nginx return an error if every server fails?**
   Yes, usually `502` (or `504` for timeouts), and the error log shows `no live upstreams` when all servers are marked unavailable.
4. **Why does the `zone` directive matter?**
   Without it, each worker keeps its own fail counters, so different workers may disagree about which server is down.
5. **How do you do active health checks in Kubernetes?**
   Kubernetes readiness probes remove unhealthy pods from the Service endpoints, so the Ingress controller stops sending traffic to them.

---
[⬅️ Previous](09-security-hardening.md) · [🏠 Index](../README.md) · [Next ➡️](11-nginx-in-docker-and-kubernetes-ingress.md)

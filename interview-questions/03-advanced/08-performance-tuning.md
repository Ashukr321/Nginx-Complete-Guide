# Q: How do you tune Nginx for performance?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Performance Engineer, Platform Engineer

## 🎯 Short answer (say this in the interview)

First I **measure** a baseline with a load tool like `wrk` or `ab` and watch `stub_status`, because tuning without numbers is guessing. Then I tune in layers: **processes and connections** (`worker_processes auto`, `worker_connections`, `worker_rlimit_nofile`, `multi_accept`), **file delivery** (`sendfile`, `tcp_nopush`, `tcp_nodelay`, `open_file_cache`), **connection reuse** (client `keepalive_timeout`/`keepalive_requests` and upstream `keepalive` with HTTP/1.1), **less data on the wire** (gzip, HTTP/2, caching headers), and **buffers** (`client_body_buffer_size`, `proxy_buffers`) so responses don't spill to disk. I change one thing at a time and re-measure.

## 🧩 Scenario

Your company's product API (Node.js behind Nginx on a 4-core VM) is fine at normal load but p99 latency gets bad during peak hours. Nginx still uses the default Ubuntu config. Before buying bigger servers, the team lead asks you to tune Nginx and **show before/after numbers**.

## 💼 Use case

- Pre-launch performance hardening.
- Reducing cost: serving more traffic from the same hardware.
- Fixing "warn: an upstream response is buffered to a temporary file" and high disk I/O.
- Reducing latency for static assets and API calls.

## ⚙️ How it works

```text
 client ──(keepalive, HTTP/2, gzip)──► NGINX ──(upstream keepalive, HTTP/1.1)──► backend
                                         │
                                         ├─ worker_processes auto     → use every CPU core
                                         ├─ worker_connections        → connections per worker
                                         ├─ sendfile + tcp_nopush     → kernel sends files directly
                                         ├─ open_file_cache           → fewer open()/stat() syscalls
                                         └─ proxy_buffers             → keep responses in RAM, not temp files
```

**What each setting does**

| Setting | Context | Why it helps |
|---|---|---|
| `worker_processes auto;` | main | One worker per CPU core. |
| `worker_rlimit_nofile 65535;` | main | Raises the open-file limit for workers (each connection = 1 fd). |
| `worker_connections 4096;` | events | Max connections per worker (clients + upstreams). |
| `multi_accept on;` | events | A worker accepts all pending new connections at once instead of one per event. |
| `sendfile on;` | http/server/location | Kernel copies file → socket directly (no copy through user space). |
| `tcp_nopush on;` | http/server/location | With `sendfile`, sends headers and the start of the file in full packets. |
| `tcp_nodelay on;` | http/server/location | Disables Nagle's algorithm on keep-alive connections, so small writes go out immediately. Default is on. |
| `keepalive_timeout 30s;` | http/server/location | How long an idle client connection stays open (default 75s). |
| `keepalive_requests 1000;` | http/server/location | Requests allowed per keep-alive connection (default 1000 since 1.19.10). |
| `keepalive 32;` | upstream | Idle connections to the backend kept open per worker — avoids a new TCP handshake per request. |
| `gzip on;` | http/server/location | Compresses text responses; big bandwidth savings for HTML/JSON/CSS/JS. |
| `open_file_cache` | http/server/location | Caches file descriptors and metadata of frequently served files. |
| `client_body_buffer_size` | http/server/location | Request bodies larger than this are written to a temp file. |
| `proxy_buffer_size` / `proxy_buffers` | http/server/location | Memory for reading backend responses; too small → temp files on disk. |

## 🛠️ Practical: step by step

1. **Install tools and take a baseline** (run the load tool from another machine if you can)

```bash
sudo apt install -y wrk apache2-utils

# 4 threads, 200 connections, 30 seconds
wrk -t4 -c200 -d30s --latency http://SERVER_IP/api/products

# or with ab: 10,000 requests, 200 at a time, keep-alive on
ab -n 10000 -c 200 -k http://SERVER_IP/api/products
```

Save the output (Requests/sec, latency percentiles, errors). These are your "before" numbers.

2. **Enable `stub_status` for live monitoring** — file: `/etc/nginx/conf.d/status.conf` (inside http via Ubuntu's default include). The Ubuntu package is built with this module.

```nginx
# /etc/nginx/conf.d/status.conf
server {
    listen 127.0.0.1:8080;          # only reachable from the server itself
    server_name localhost;

    location = /nginx_status {
        stub_status;                # Active connections, accepts, handled, requests, Reading/Writing/Waiting
        allow 127.0.0.1;
        deny all;
    }
}
```

3. **Tune the main config** — file: `/etc/nginx/nginx.conf`

```nginx
# /etc/nginx/nginx.conf
user www-data;
worker_processes auto;            # one worker per core
worker_rlimit_nofile 65535;       # fds per worker (keep > worker_connections)
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 4096;      # per worker; remember proxying uses 2 per request
    multi_accept on;
}

http {
    ##
    # Basic
    ##
    sendfile on;
    tcp_nopush on;                # only takes effect together with sendfile
    tcp_nodelay on;
    types_hash_max_size 2048;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ##
    # Keep-alive to clients
    ##
    keepalive_timeout 30s;
    keepalive_requests 1000;

    ##
    # Buffers and timeouts
    ##
    client_body_buffer_size 16k;  # most JSON bodies fit in RAM
    client_max_body_size 10m;
    client_header_timeout 15s;    # drop slow clients sooner
    client_body_timeout 15s;
    send_timeout 15s;

    ##
    # File metadata cache (good for static-heavy sites)
    ##
    open_file_cache max=10000 inactive=30s;
    open_file_cache_valid 60s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;

    ##
    # Gzip
    ##
    gzip on;
    gzip_comp_level 5;            # good balance; higher levels cost CPU for little gain
    gzip_min_length 256;          # don't compress tiny responses
    gzip_vary on;                 # add "Vary: Accept-Encoding" for caches/CDNs
    gzip_proxied any;             # also compress proxied responses
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml image/svg+xml;   # text/html is always included

    ##
    # Logs (buffer writes to reduce disk I/O)
    ##
    access_log /var/log/nginx/access.log combined buffer=64k flush=5s;
    error_log /var/log/nginx/error.log;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

4. **Upstream keep-alive, proxy buffers and HTTP/2** — file: `/etc/nginx/sites-available/api.conf`

```nginx
upstream api_backend {
    server 127.0.0.1:3000;
    keepalive 32;                       # idle keep-alive connections per worker to the backend
}

server {
    listen 443 ssl http2;               # Ubuntu 22.04 (1.18) / 24.04 (1.24) syntax
    # On Nginx 1.25.1+ use:  listen 443 ssl;  +  http2 on;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
    ssl_session_cache   shared:SSL:10m; # reuse TLS sessions → fewer full handshakes
    ssl_session_timeout 1h;

    location /api/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;         # required for upstream keepalive
        proxy_set_header Connection ""; # clear "Connection: close" so the connection is reused
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        proxy_buffer_size 16k;          # first part of the response (headers)
        proxy_buffers 16 16k;           # 256k total in memory per connection
        proxy_busy_buffers_size 32k;
    }

    # Long cache for fingerprinted static assets (e.g. app.3f9a1c.js)
    location /static/ {
        root /var/www/api;
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
}
```

5. **Apply and re-measure**

```bash
sudo nginx -t && sudo systemctl reload nginx
wrk -t4 -c200 -d30s --latency https://api.example.com/api/products
```

Compare Requests/sec, p99 latency, and socket errors with your baseline. Keep a change only if it helps **your** workload.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Workers, events, sendfile, keep-alive, gzip, buffers, open_file_cache |
| `/etc/nginx/conf.d/status.conf` | `stub_status` endpoint on localhost |
| `/etc/nginx/sites-available/api.conf` | Upstream keepalive, proxy buffers, HTTP/2, static caching |
| `/etc/systemd/system/nginx.service.d/override.conf` | Optional `LimitNOFILE` for the service |
| `/var/lib/nginx/proxy/` | Temp files written when proxy buffers are too small (Ubuntu path) |
| `/var/log/nginx/error.log` | Warnings like "buffered to a temporary file" |

## ✅ Verify it works

```bash
# stub_status
curl -s http://127.0.0.1:8080/nginx_status
```

Example output:

```text
Active connections: 3
server accepts handled requests
 1520 1520 4980
Reading: 0 Writing: 1 Waiting: 2
```

`accepts` should equal `handled` (if `handled` is lower, you're hitting `worker_connections`). `Waiting` = idle keep-alive connections.

```bash
# gzip is applied
curl -s -o /dev/null -D - -H "Accept-Encoding: gzip" https://api.example.com/api/products | grep -i content-encoding
# expect: content-encoding: gzip

# HTTP/2 is negotiated
curl -sI --http2 https://api.example.com/ | head -n 1
# expect: HTTP/2 200

# upstream keepalive: connections to the backend stay ESTABLISHED and are reused under load
ss -tn state established '( dport = :3000 )' | wc -l

# no responses spilling to disk
sudo grep -c "buffered to a temporary file" /var/log/nginx/error.log
```

## ⚠️ Common mistakes

- Tuning without a baseline — you can't prove anything got better.
- Setting `upstream keepalive` but forgetting `proxy_http_version 1.1;` and `proxy_set_header Connection "";` — connections are then not reused.
- `gzip_comp_level 9`: high CPU cost for a small extra saving.
- Compressing already-compressed files (JPEG, PNG, MP4, ZIP) — wasted CPU.
- Copying giant buffer sizes from blogs: buffers are **per connection**, so 10,000 connections × big buffers = lots of RAM.
- Using `http2 on;` on Ubuntu's packaged Nginx 1.18/1.24 — that directive only exists from 1.25.1; use `listen 443 ssl http2;` there.
- `open_file_cache` on files that change often without understanding `open_file_cache_valid` — changes may take that long to be noticed.

## 🔁 Follow-up questions interviewers ask

1. **Why does upstream keepalive need `proxy_http_version 1.1`?**
   Nginx speaks HTTP/1.0 to backends by default and sends `Connection: close`; keep-alive needs HTTP/1.1 and an empty `Connection` header.
2. **What do `sendfile` and `tcp_nopush` do together?**
   `sendfile` lets the kernel send the file directly; `tcp_nopush` makes Nginx send the headers and the first part of the file in full packets instead of many small ones.
3. **How do you know if `worker_connections` is too low?**
   `worker_connections are not enough` in `error.log`, or `handled` < `accepts` in `stub_status`.
4. **What metrics would you monitor in production?**
   Active/waiting connections (`stub_status` via an exporter such as nginx-prometheus-exporter), request rate, 4xx/5xx rate, `$request_time` and `$upstream_response_time` percentiles from the access log.
5. **Does HTTP/2 always make things faster?**
   It helps mostly for browsers loading many resources over one connection (multiplexing, header compression). For simple server-to-server APIs, the gain may be small.

---
[⬅️ Previous](07-troubleshooting-502-504-413-403-404.md) · [🏠 Index](../README.md) · [Next ➡️](09-security-hardening.md)

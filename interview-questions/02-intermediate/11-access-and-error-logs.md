# Q: How do Nginx access and error logs work, and how do you customize them?

> **Level:** Intermediate · **Asked in:** DevOps, SRE, Backend, Support/Operations engineering

## 🎯 Short answer (say this in the interview)

Nginx has two logs. The **access log** records one line per request (client IP, time, request line, status, bytes, referrer, user agent) using the default `combined` format; the **error log** records problems and diagnostic messages filtered by a severity level such as `warn` or `error`. On Ubuntu they live in `/var/log/nginx/`. I define custom formats with `log_format` in the `http` block — for example adding `$request_time` and `$upstream_response_time` to find slow requests, or JSON with `escape=json` for ELK/Loki. I set separate logs per site, turn logging off for noisy health checks, and rely on logrotate (`/etc/logrotate.d/nginx`), which tells Nginx to reopen its files after rotation.

## 🧩 Scenario

Users complain the site is "sometimes slow" and some get errors. You need to answer: Which URLs are slow — Nginx or the backend? Which IPs are hammering the server? How many 5xx errors happened in the last hour? Meanwhile, the load balancer's health check every 5 seconds is filling the access log with noise, and the disk is filling up.

## 💼 Use case

- Troubleshooting 4xx/5xx errors and `502 Bad Gateway` (error log shows the exact reason).
- Finding slow endpoints with `$request_time` / `$upstream_response_time`.
- Feeding logs into ELK, Loki/Grafana, Datadog, CloudWatch as JSON.
- Security: spotting brute force, scanners, top offending IPs.
- Capacity planning and traffic analysis.

## ⚙️ How it works

```text
             Request
                |
                v
        +---------------+       something goes wrong / diagnostic info
        |     Nginx     | --------------------------------------------+
        +-------+-------+                                             |
                | request finished                                    v
                v                                        +-------------------------+
  log_format main '...'  (defined in http {})            | error_log <file> <level>|
                |                                        | debug < info < notice < |
                v                                        | warn < error < crit <   |
  access_log /var/log/nginx/site.access.log main;        | alert < emerg           |
  (http, server, location; most specific wins)           +-------------------------+
                |
                v
     /var/log/nginx/*.log  --(daily)--> logrotate --> postrotate: tell Nginx to reopen files
                                         access.log.1, access.log.2.gz, ...
```

### Default `combined` format (predefined, no need to declare it)

```nginx
log_format combined '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';
```

Example line:

```text
203.0.113.7 - - [31/Oct/2026:10:15:32 +0000] "GET /api/products HTTP/1.1" 200 5123 "https://shop.example.com/" "Mozilla/5.0 ..."
   $1                   $4 $5                     $6   $7        $8      $9  $10
```

(Field numbers are how `awk '{print $N}'` splits a `combined` line by spaces: `$1` = IP, `$7` = path, `$9` = status, `$10` = bytes.)

### Useful variables

| Variable | Meaning |
|---|---|
| `$remote_addr` | Client IP (real client if the realip module is configured) |
| `$request` | Full request line: `GET /path HTTP/1.1` |
| `$status` | Response status code |
| `$body_bytes_sent` | Body bytes sent to the client |
| `$request_time` | Total time in seconds (ms resolution) from first byte read from the client to last byte sent |
| `$upstream_response_time` | Time the backend took (comma-separated if several upstreams were tried) |
| `$upstream_connect_time` | Time to connect to the backend |
| `$upstream_addr` | Which backend server handled the request |
| `$http_x_forwarded_for` | Incoming X-Forwarded-For header |
| `$host` | Requested host (useful when one log covers many sites) |
| `$request_id` | Unique ID per request (also pass it to the backend for tracing) |

### Error log levels

`debug` → `info` → `notice` → `warn` → `error` → `crit` → `alert` → `emerg`. Setting a level logs that level **and everything more severe**. The default is `error`. `debug` only works if Nginx was built with `--with-debug` (check: `nginx -V 2>&1 | grep -o with-debug`).

## 🛠️ Practical: step by step

### 1. Define custom formats (must be in the `http` context)

```bash
sudo nano /etc/nginx/conf.d/log-formats.conf
```

```nginx
# File: /etc/nginx/conf.d/log-formats.conf   (included inside http {})

# "combined" + timing + upstream info
log_format main_timed '$remote_addr - $remote_user [$time_local] '
                      '"$request" $status $body_bytes_sent '
                      '"$http_referer" "$http_user_agent" '
                      'rt=$request_time urt=$upstream_response_time '
                      'uct=$upstream_connect_time ua="$upstream_addr" '
                      'host=$host rid=$request_id';

# JSON for log shippers (ELK, Loki, Datadog). escape=json escapes quotes, etc.
log_format json_logs escape=json
  '{'
    '"time":"$time_iso8601",'
    '"remote_addr":"$remote_addr",'
    '"x_forwarded_for":"$http_x_forwarded_for",'
    '"host":"$host",'
    '"method":"$request_method",'
    '"uri":"$request_uri",'
    '"status":$status,'
    '"bytes_sent":$body_bytes_sent,'
    '"request_time":$request_time,'
    '"upstream_addr":"$upstream_addr",'
    '"upstream_response_time":"$upstream_response_time",'
    '"referer":"$http_referer",'
    '"user_agent":"$http_user_agent",'
    '"request_id":"$request_id"'
  '}';

# Skip logging of successful (2xx/3xx) requests in a "errors only" log
map $status $loggable_error {
    ~^[23]  0;
    default 1;
}
```

`upstream_response_time` is a quoted string in the JSON because it can be `-` (no upstream) or a list like `0.010, 0.502`.

### 2. Use them in a site, with per-site logs

```bash
sudo nano /etc/nginx/sites-available/shop.example.com
```

```nginx
# File: /etc/nginx/sites-available/shop.example.com
server {
    listen 80;
    server_name shop.example.com;

    # Per-site logs (override the global ones from nginx.conf)
    access_log /var/log/nginx/shop.access.log main_timed;
    access_log /var/log/nginx/shop.access.json json_logs;          # multiple logs are allowed
    access_log /var/log/nginx/shop.errors-only.log main_timed if=$loggable_error;
    error_log  /var/log/nginx/shop.error.log warn;

    root /var/www/shop;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        include proxy_params;
        proxy_set_header X-Request-ID $request_id;   # same ID in Nginx and app logs
    }

    # Health checks from the load balancer: don't log them
    location = /health {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    # Static assets: usually not worth logging either
    location /assets/ {
        access_log off;
    }

    # favicon/robots noise
    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/shop.example.com /etc/nginx/sites-enabled/   # if not already enabled
sudo nginx -t && sudo systemctl reload nginx
```

Optional performance tweak for busy servers — buffer log writes:

```nginx
access_log /var/log/nginx/shop.access.log main_timed buffer=32k flush=5s;
```

### 3. Log rotation

Ubuntu's Nginx package installs `/etc/logrotate.d/nginx`. It rotates `/var/log/nginx/*.log` (so your custom `.log` files are included — but **not** `shop.access.json`, which doesn't end in `.log`) and, in its `postrotate` script, signals Nginx to reopen its log files.

```bash
cat /etc/logrotate.d/nginx
```

To rotate the JSON log too, either name it `.log` (e.g. `shop.access.json.log`) or add its path to the first line of that file. Test rotation:

```bash
sudo logrotate --debug /etc/logrotate.d/nginx     # dry run, shows what would happen
sudo logrotate --force /etc/logrotate.d/nginx     # rotate now
ls -l /var/log/nginx/
```

Why reopen? Nginx keeps the file **open**. After `mv access.log access.log.1`, Nginx keeps writing into `access.log.1` until told to reopen:

```bash
sudo nginx -s reopen
# equivalent: sudo kill -USR1 $(cat /run/nginx.pid)
```

### 4. Useful one-liners (for the `combined` / `main_timed` format)

```bash
LOG=/var/log/nginx/access.log

# Follow live
sudo tail -f $LOG

# Only errors, live
sudo tail -f $LOG | awk '$9 >= 500'

# Count by status code
sudo awk '{print $9}' $LOG | sort | uniq -c | sort -rn

# Top 10 client IPs
sudo awk '{print $1}' $LOG | sort | uniq -c | sort -rn | head -10

# Top 10 requested URLs
sudo awk '{print $7}' $LOG | sort | uniq -c | sort -rn | head -10

# Top URLs returning 404
sudo awk '$9 == 404 {print $7}' $LOG | sort | uniq -c | sort -rn | head -10

# Requests per minute (busiest minutes)
sudo awk '{print substr($4, 2, 17)}' $LOG | sort | uniq -c | sort -rn | head

# Slowest requests (main_timed format: field "rt=")
sudo grep -o 'rt=[0-9.]*' /var/log/nginx/shop.access.log | cut -d= -f2 | sort -rn | head -10

# Include rotated + gzipped logs
sudo zcat -f /var/log/nginx/access.log* | awk '{print $9}' | sort | uniq -c | sort -rn

# JSON logs with jq: 5xx requests with their timings
sudo jq -c 'select(.status >= 500) | {uri, status, request_time, upstream_response_time}' \
     /var/log/nginx/shop.access.json

# Recent errors from the error log
sudo grep -E '\[(error|crit|alert|emerg)\]' /var/log/nginx/error.log | tail -20
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Global `access_log` and `error_log` defaults inside `http {}` and main context |
| `/etc/nginx/conf.d/log-formats.conf` | Custom `log_format` definitions and the `map` for conditional logging |
| `/etc/nginx/sites-available/shop.example.com` | Per-site `access_log` / `error_log` and `access_log off` rules |
| `/var/log/nginx/access.log`, `error.log` | Default log files on Ubuntu |
| `/var/log/nginx/shop.*` | Per-site logs |
| `/etc/logrotate.d/nginx` | Rotation schedule, compression, and the postrotate reopen |
| `/run/nginx.pid` | PID of the master process (used by `kill -USR1`) |

## ✅ Verify it works

```bash
sudo nginx -t
sudo systemctl reload nginx

curl -s -o /dev/null -H 'Host: shop.example.com' http://127.0.0.1/
curl -s -o /dev/null -H 'Host: shop.example.com' http://127.0.0.1/health

sudo tail -n 2 /var/log/nginx/shop.access.log
# 127.0.0.1 - - [31/Oct/2026:10:20:01 +0000] "GET / HTTP/1.1" 200 612 "-" "curl/8.5.0" rt=0.000 urt=- uct=- ua="-" host=shop.example.com rid=4f1c...
# (no line for /health - access_log off works)

sudo tail -n 1 /var/log/nginx/shop.access.json | jq .
# { "time": "2026-10-31T10:20:01+00:00", "status": 200, ... }

# Trigger an error-log entry: request a missing file
curl -s -o /dev/null -H 'Host: shop.example.com' http://127.0.0.1/assets/missing.js
sudo tail -n 1 /var/log/nginx/shop.error.log
# ... [error] ... open() "/var/www/shop/assets/missing.js" failed (2: No such file or directory) ...
```

(Your curl version and request IDs will differ.)

## ⚠️ Common mistakes

- Putting `log_format` inside a `server` block → `"log_format" directive is not allowed here`. It belongs in `http`.
- Defining a format but forgetting to reference it by name in `access_log` → the `combined` format is still used.
- Setting `error_log ... debug;` in production → huge logs and disk full; also does nothing useful without a `--with-debug` build.
- Expecting `access_log off;` in `server` to also silence a location that has its own `access_log` — the most specific level wins.
- Moving/deleting log files manually without `nginx -s reopen` → Nginx writes to a deleted file and disk space isn't freed.
- Custom log files with names not matching `/var/log/nginx/*.log` → never rotated.
- Wrong permissions/ownership on new log directories → Nginx fails to start (`open() ... failed (13: Permission denied)`).
- Logging sensitive data (tokens in query strings, `Authorization` headers) into access logs.
- Confusing `$request_time` (total, includes slow clients) with `$upstream_response_time` (backend only).

## 🔁 Follow-up questions interviewers ask

- **How do you tell if slowness is Nginx/network or the backend?** Compare `$request_time` and `$upstream_response_time`: if both are high, the backend is slow; if only `$request_time` is high, it's the client/network or buffering.
- **Where do you look first for a 502?** The error log — it shows the cause, e.g. `connect() failed (111: Connection refused) while connecting to upstream` or `upstream prematurely closed connection`.
- **How do you send Nginx logs to a central system?** JSON `log_format` + a shipper (Filebeat, Fluent Bit, Promtail/Alloy, CloudWatch agent), or `access_log syslog:server=...` directly.
- **How do you log only errors or only some requests?** Use `access_log ... if=$variable;` with a `map` that sets the variable to `0` for requests you want to skip.
- **In Docker, where do Nginx logs go?** The official image symlinks `access.log` to `/dev/stdout` and `error.log` to `/dev/stderr`, so `docker logs` shows them.

---
[⬅️ Previous](10-deploy-mern-app-with-nginx.md) · [🏠 Index](../README.md) · [Next ➡️](../03-advanced/01-master-worker-event-driven-architecture.md)

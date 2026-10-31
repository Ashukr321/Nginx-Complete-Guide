# Q: Explain the structure of nginx.conf. What are directives, contexts and blocks?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Backend, Linux Admin

## 🎯 Short answer (say this in the interview)

`nginx.conf` is made of **directives**. A **simple directive** is a name + values ending in `;` (e.g. `worker_processes auto;`). A **block directive** has `{ }` and contains other directives; a block is also called a **context**. The main contexts are: **main** (top level: user, workers, pid), **events** (connection handling), **http** (all web settings), **server** (one virtual host), **location** (rules for a URL path) and **upstream** (a group of backend servers). Settings defined in an outer context are **inherited** by inner contexts unless the inner context overrides them. `include` pulls other files in, which is how `sites-enabled/*` and `conf.d/*.conf` get loaded.

## 🧩 Scenario

A teammate added `gzip off;` inside one `server` block and asks why gzip still works for other sites, and why their `add_header` in a `location` made the security headers from the `server` block disappear. To answer, you need to understand contexts and how inheritance works.

## 💼 Use case

- Reading and changing any Nginx config with confidence.
- Putting a directive at the right level (global for all sites in `http`, or one site in `server`, or one path in `location`).
- Debugging "my setting is ignored" problems caused by inheritance or a directive placed in the wrong context ("directive is not allowed here").

## ⚙️ How it works

### Contexts (nesting)

```text
nginx.conf
│
├── main context  (top level, outside any block)
│     user, worker_processes, pid, error_log, include modules, load_module
│
├── events { }    connection processing: worker_connections, multi_accept, use epoll
│
├── http { }      everything about HTTP: mime types, logs, gzip, keepalive, SSL defaults
│   │
│   ├── upstream backend { }    group of servers for proxy_pass / load balancing
│   │      server 127.0.0.1:3000;
│   │
│   └── server { }              one virtual host (listen + server_name)
│        │
│        ├── location / { }     rules for a URI prefix / regex
│        │
│        └── location /api/ { } (locations can be nested, but keep it simple)
│
├── stream { }    (optional) TCP/UDP proxying - its own server/upstream blocks
└── mail { }      (optional) mail proxy (SMTP/IMAP/POP3)
```

Other smaller contexts you will see: `types { }` (inside `mime.types`), `map { }`, `geo { }`, `if { }` and `limit_except { }`.

### Directive vs context

```nginx
worker_processes auto;          # simple directive: name + value(s) + ;

events {                        # block directive -> creates the "events" context
    worker_connections 768;     # simple directive inside the events context
}
```

Every directive has a list of contexts where it is allowed (see its page on nginx.org, "Context:" line). For example `proxy_pass` is allowed in `location` (and `if in location`, `limit_except`), but not in `http`. Putting it in the wrong place gives: `"proxy_pass" directive is not allowed here`.

### Inheritance (outer → inner)

```text
http {           gzip on;  access_log /var/log/nginx/access.log;
  |
  +-- server A   (no gzip line)       -> gzip on  (inherited)
  |
  +-- server B   gzip off;            -> gzip off (overridden)
        |
        +-- location /big/            -> gzip off (inherited from server B)
```

Rules to remember:

- A directive set in an outer context applies to inner contexts **unless the inner context sets it again**.
- **Array-type directives** such as `add_header`, `proxy_set_header` and `fastcgi_param` are inherited **only if the inner level defines none of them**. If a `location` has one `add_header`, it loses **all** `add_header` lines from `server`/`http`.
- `include` is not inheritance - it just pastes file content at that position.
- `location` blocks are not inherited from each other; only one location is chosen per request.

## 🛠️ Practical: step by step

### 1. Read the default Ubuntu `nginx.conf` line by line

Open it with `cat /etc/nginx/nginx.conf`. Below is the Ubuntu 24.04 version with explanations (22.04 is almost the same - there `error_log` sits inside `http` next to `access_log`). Exact lines can differ a little between releases, so compare with your own file.

```nginx
# /etc/nginx/nginx.conf  (Ubuntu default, annotated)

# ---------- main context ----------
user www-data;
# workers run as user www-data (the master runs as root to bind ports 80/443)

worker_processes auto;
# number of worker processes; "auto" = one per CPU core

pid /run/nginx.pid;
# file where the master's process ID is written (used by nginx -s and systemd)

error_log /var/log/nginx/error.log;
# global error log (default level: error)

include /etc/nginx/modules-enabled/*.conf;
# loads dynamic modules: each file contains a "load_module ...so;" line

# ---------- events context ----------
events {
    worker_connections 768;
    # max simultaneous connections per worker (clients + upstream connections)
    # rough max clients = worker_processes x worker_connections

    # multi_accept on;
    # if on, a worker accepts all new connections at once instead of one at a time
}

# ---------- http context ----------
http {

    ##
    # Basic Settings
    ##

    sendfile on;
    # kernel copies files directly to the socket (fast static file serving)

    tcp_nopush on;
    # with sendfile: send headers and start of file in one packet

    types_hash_max_size 2048;
    # size of the hash table for MIME types (performance tuning)

    # server_tokens off;
    # if uncommented: hide the nginx version in headers and error pages

    # server_names_hash_bucket_size 64;
    # uncomment if you get "could not build server_names_hash" with long domain names

    # server_name_in_redirect off;

    include /etc/nginx/mime.types;
    # file extension -> Content-Type mapping

    default_type application/octet-stream;
    # Content-Type when the extension is unknown (browser will download it)

    ##
    # SSL Settings
    ##

    ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3; # Dropping SSLv3, ref: POODLE
    # allowed TLS versions for all HTTPS servers (good practice today: TLSv1.2 TLSv1.3 only)

    ssl_prefer_server_ciphers on;
    # server chooses the cipher, not the client

    ##
    # Logging Settings
    ##

    access_log /var/log/nginx/access.log;
    # one line per request, default "combined" format

    ##
    # Gzip Settings
    ##

    gzip on;
    # compress responses (by default only text/html unless gzip_types is set)

    # gzip_vary on;
    # gzip_proxied any;
    # gzip_comp_level 6;
    # gzip_buffers 16 8k;
    # gzip_http_version 1.1;
    # gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    ##
    # Virtual Host Configs
    ##

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
    # this is where all server { } blocks (your sites) are pulled in
}

# The file ends with a commented-out example "mail { ... }" block
# for using nginx as a mail proxy. You can ignore it.
```

### 2. A complete small config that uses every main context

Write it to a test file so you do not break the real server, e.g. `/etc/nginx/test-structure.conf`:

```nginx
# /etc/nginx/test-structure.conf  (stand-alone example for learning)

# main context
user www-data;
worker_processes auto;
pid /run/nginx-test.pid;
error_log /var/log/nginx/test-error.log warn;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/test-access.log;
    gzip on;                                     # inherited by every server below

    upstream api_backend {                       # group of backend servers
        server 127.0.0.1:3000;
        server 127.0.0.1:3001;
    }

    server {
        listen 8081;
        server_name localhost;

        root /var/www/html;                      # inherited by the locations below
        add_header X-Frame-Options "DENY";       # server-level header

        location / {
            try_files $uri $uri/ =404;           # gets root + X-Frame-Options + gzip
        }

        location /api/ {
            proxy_pass http://api_backend;
            proxy_set_header Host $host;
            add_header X-Api "yes";              # NOTE: now X-Frame-Options is NOT sent here
                                                 # (add_header array is replaced, not merged)
        }

        location /nogzip/ {
            gzip off;                            # override just for this path
        }
    }
}
```

### 3. Test a config file without touching the live one

```bash
sudo nginx -t -c /etc/nginx/test-structure.conf
# nginx: the configuration file /etc/nginx/test-structure.conf syntax is ok
# nginx: configuration file /etc/nginx/test-structure.conf test is successful
```

Optionally run it as a second, separate Nginx instance (it uses its own PID file and port 8081):

```bash
sudo nginx -c /etc/nginx/test-structure.conf            # start
sudo nginx -c /etc/nginx/test-structure.conf -s quit    # stop it again when done
```

### 4. See the context error on purpose

```bash
# put proxy_pass directly in http{} of the test file and run -t again:
# nginx: [emerg] "proxy_pass" directive is not allowed here in /etc/nginx/test-structure.conf:NN
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Main file: main, events and http contexts |
| `/etc/nginx/modules-enabled/*.conf` | Included in main context (`load_module`) |
| `/etc/nginx/mime.types` | Included in `http` (a `types { }` block) |
| `/etc/nginx/conf.d/*.conf` | Included in `http` |
| `/etc/nginx/sites-enabled/*` | Included in `http`; contain `server { }` blocks |
| `/etc/nginx/test-structure.conf` | Our learning file, tested with `-c` |

## ✅ Verify it works

```bash
sudo nginx -t
# ... syntax is ok / test is successful

# print the merged config to confirm where a directive ends up
sudo nginx -T | grep -n -E 'gzip|worker_|include'

# check the add_header inheritance gotcha (test instance from step 3 running, and a backend
# on port 3000/3001 - add_header is only sent on 2xx/3xx responses unless you add "always"):
curl -sI http://localhost:8081/      | grep -i x-frame    # X-Frame-Options: DENY
curl -sI http://localhost:8081/api/  | grep -i x-frame    # (nothing) - replaced by X-Api
```

## ⚠️ Common mistakes

- Missing `;` at the end of a directive → `unexpected "}"` or `unexpected end of file`.
- Putting a directive in a context where it is not allowed (`server` inside `server`, `proxy_pass` in `http`).
- Expecting `add_header` / `proxy_set_header` to merge between levels - they are **replaced** if the inner level defines any.
- Thinking `server_tokens off;` is active in the default file - it is commented out with `#`.
- Writing `http { }` again in a site file - files in `sites-enabled/` are already **inside** `http`, so they should contain only `server { }` (and `upstream`, `map`, etc.).

## 🔁 Follow-up questions interviewers ask

- **What is the main context?** The top level of `nginx.conf`, outside any block - process-wide settings like `user`, `worker_processes`, `pid`.
- **What does `worker_connections` limit?** Max open connections per worker, including connections to upstreams, not only clients.
- **Where do you put a setting that should apply to all sites?** In `http { }` (or a file in `conf.d/`), so every `server` inherits it.
- **Can you nest `location` blocks?** Yes, but it is usually avoided for readability; `location` cannot be put directly inside `http`.
- **What does `include` support?** A path or a glob (`*.conf`); relative paths are resolved from the config directory (`/etc/nginx`).

---
[⬅️ Previous](07-nginx-folder-structure-and-files.md) · [🏠 Index](../README.md) · [Next ➡️](09-nginx-commands-start-stop-reload.md)

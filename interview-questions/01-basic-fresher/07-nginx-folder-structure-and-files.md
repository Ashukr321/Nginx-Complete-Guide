# Q: Explain the Nginx folder structure. What does each file do?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Linux Admin, Cloud

## 🎯 Short answer (say this in the interview)

Everything starts at **`/etc/nginx/nginx.conf`**, the main config file. It uses `include` to pull in other files: `mime.types` for content types, `modules-enabled/*.conf` for dynamic modules, `conf.d/*.conf`, and on Ubuntu/Debian `sites-enabled/*`, where each site is a **symlink** to a file in `sites-available/`. Helper files like `proxy_params`, `fastcgi_params` and `snippets/` hold reusable directives. Outside `/etc/nginx`, the web root is `/var/www/html` on Ubuntu (`/usr/share/nginx/html` on other builds), logs are in `/var/log/nginx/`, the PID file is `/run/nginx.pid`, the binary is `/usr/sbin/nginx`, and systemd's unit is `nginx.service`. The layout differs between the Ubuntu package, the nginx.org package, RHEL and Docker, so I always check with `nginx -V` and `nginx -T`.

## 🧩 Scenario

You are on call. A developer says "I added a new site, but Nginx still shows the welcome page." You SSH into the Ubuntu 22.04 server and need to know exactly where to look: is the file in `sites-available` but not linked in `sites-enabled`? Is there a stray file in `conf.d`? Which log shows the error? Knowing the folder structure turns this into a two-minute fix.

## 💼 Use case

- Debugging "why is my config not applied?" (wrong folder, missing symlink, wrong file extension).
- Finding logs during an incident (`/var/log/nginx/error.log`).
- Writing Ansible roles / Dockerfiles that drop config into the right directory.
- Enabling/disabling sites without deleting config (`sites-available` → `sites-enabled` symlink).
- Reusing common settings with `snippets/` and `proxy_params`.

## ⚙️ How it works

### Full annotated tree - Ubuntu 22.04 / 24.04 (`apt install nginx`)

```text
/etc/nginx/
├── nginx.conf                 # MAIN config. Global settings (user, workers, pid),
│                              # events{}, http{}. Includes everything below.
├── conf.d/                    # Extra config, *.conf only, included inside http{}.
│                              # Empty on Ubuntu. Good for global http-level
│                              # settings (e.g. log formats, maps, rate-limit zones).
├── sites-available/           # Debian/Ubuntu convention: ALL site configs live here
│   └── default                # (enabled or not). "default" = the welcome-page site.
├── sites-enabled/             # Only what is here is loaded (include sites-enabled/*).
│   └── default -> /etc/nginx/sites-available/default   # symlink = "site is ON"
├── snippets/                  # Small reusable pieces you "include" in server/location
│   ├── fastcgi-php.conf       # Standard block to pass .php files to PHP-FPM
│   │                          # (split path info, try_files check, include fastcgi.conf)
│   └── snakeoil.conf          # ssl_certificate/ssl_certificate_key pointing to the
│                              # self-signed "snakeoil" cert (for testing HTTPS only)
├── modules-available/         # Place for module load files (often empty on Ubuntu)
├── modules-enabled/           # *.conf here are included at the top of nginx.conf.
│   └── 50-mod-*.conf -> /usr/share/nginx/modules-available/mod-*.conf
│                              # each contains: load_module modules/ngx_..._module.so;
├── mime.types                 # Map of file extension -> Content-Type
│                              # (html -> text/html, css -> text/css, js -> ...)
├── fastcgi.conf               # fastcgi_param list INCLUDING SCRIPT_FILENAME
├── fastcgi_params             # same list WITHOUT SCRIPT_FILENAME (older style)
├── proxy_params               # Debian/Ubuntu helper: proxy_set_header Host,
│                              # X-Real-IP, X-Forwarded-For, X-Forwarded-Proto
├── scgi_params                # params for scgi_pass (SCGI backends, rare)
├── uwsgi_params               # params for uwsgi_pass (Python apps under uWSGI)
├── koi-utf                    # charset_map: KOI8-R  <-> UTF-8  (Cyrillic)
├── koi-win                    # charset_map: KOI8-R  <-> Windows-1251
└── win-utf                    # charset_map: Windows-1251 <-> UTF-8
                               # (these 3 are for the "charset" module; almost never used)
```

### Outside `/etc/nginx` (Ubuntu)

```text
/usr/sbin/nginx                        # the nginx binary
/lib/systemd/system/nginx.service      # systemd unit (start/stop/reload commands)
/run/nginx.pid                         # PID of the master process (used for signals)
/var/www/html/                         # default web root of the "default" site
│   └── index.nginx-debian.html        # the "Welcome to nginx!" page
/usr/share/nginx/html/                 # stock nginx pages (index.html, 50x.html);
│                                      # NOT the default root on Ubuntu
/usr/share/nginx/modules-available/    # module .conf files that modules-enabled links to
/usr/lib/nginx/modules/                # dynamic module binaries (*.so)
/var/log/nginx/
│   ├── access.log                     # one line per request (IP, time, URL, status, size)
│   └── error.log                      # startup errors, config errors, upstream failures,
│                                      # 403/404 reasons (permission denied, no such file)
/var/lib/nginx/                        # temp files when data does not fit in memory buffers
│   ├── body/                          # large client request bodies (uploads)
│   ├── proxy/                         # buffered responses from proxy_pass backends
│   ├── fastcgi/                       # buffered responses from PHP-FPM
│   ├── scgi/                          # ... from SCGI backends
│   └── uwsgi/                         # ... from uWSGI backends
/etc/logrotate.d/nginx                 # rotates /var/log/nginx/*.log (daily, keeps 14,
│                                      # compress) and tells nginx to reopen log files
/etc/ufw/applications.d/nginx          # ufw profiles: Nginx HTTP / HTTPS / Full
/etc/ssl/certs/ssl-cert-snakeoil.pem   # self-signed cert used by snippets/snakeoil.conf
/etc/ssl/private/ssl-cert-snakeoil.key #   (from the ssl-cert package)
```

### How `include` ties it together

`include` literally pastes the content of a file (or every file matching a glob) at that spot. Here is the skeleton of Ubuntu's `nginx.conf`:

```text
nginx.conf
│
├── user www-data; worker_processes auto; pid /run/nginx.pid;
├── include /etc/nginx/modules-enabled/*.conf;      <- load_module lines (main context)
│
├── events { worker_connections 768; }
│
└── http {
      ├── include /etc/nginx/mime.types;             <- types { ... }
      ├── sendfile, gzip, access_log, ssl_protocols ...
      ├── include /etc/nginx/conf.d/*.conf;          <- your http-level extras
      └── include /etc/nginx/sites-enabled/*;        <- server { } blocks (your sites)
                       │
                       └── server {
                             include snippets/snakeoil.conf;   <- optional, inside server
                             location ~ \.php$ {
                                 include snippets/fastcgi-php.conf;
                                 fastcgi_pass unix:/run/php/php-fpm.sock;
                             }
                             location /api/ {
                                 proxy_pass http://127.0.0.1:3000;
                                 include proxy_params;
                             }
                           }
    }
```

Relative paths in `include` (like `include proxy_params;`) are resolved from the config prefix, `/etc/nginx/`.

### How a request finds its config

```text
Request: GET https://shop.example.com/api/orders
   |
   1. Which "listen"?        -> server blocks that listen on 443 for this IP
   |
   2. Which "server"?        -> compare Host header "shop.example.com" with server_name
   |                            (no match -> default_server for that port)
   |                            these server blocks came from sites-enabled/* or conf.d/*.conf
   |
   3. Which "location"?      -> best match for URI "/api/orders" inside that server
   |
   4. Which directives?      -> location's own + inherited from server{} + http{}
   |                            (e.g. gzip, access_log from nginx.conf)
   |
   5. Handler                -> serve file from root/alias  OR  proxy_pass / fastcgi_pass
   |
   6. Log                    -> access_log (and error_log on problems) in /var/log/nginx/
```

### How the layout differs between installs

| Item | Ubuntu/Debian apt package | Official nginx.org package (Debian/Ubuntu/RHEL) | RHEL / Rocky / Amazon Linux (distro pkg) | Docker official `nginx` image | Windows zip |
|---|---|---|---|---|---|
| Main config | `/etc/nginx/nginx.conf` | `/etc/nginx/nginx.conf` | `/etc/nginx/nginx.conf` | `/etc/nginx/nginx.conf` | `conf\nginx.conf` |
| Site configs | `sites-available/` + `sites-enabled/` (symlinks), also `conf.d/*.conf` | `conf.d/*.conf` only, ships `conf.d/default.conf` | `conf.d/*.conf`; default server is **inside `nginx.conf`**; `default.d/*.conf` included in it | `conf.d/*.conf`, ships `conf.d/default.conf` | everything in `conf\nginx.conf` |
| `proxy_params`, `snippets/` | Yes | No | No | No | No |
| Default web root | `/var/www/html` | `/usr/share/nginx/html` | `/usr/share/nginx/html` | `/usr/share/nginx/html` | `html\` |
| Worker user | `www-data` | `nginx` | `nginx` | `nginx` | current Windows user |
| Logs | `/var/log/nginx/` | `/var/log/nginx/` | `/var/log/nginx/` | symlinked to `/dev/stdout` / `/dev/stderr` | `logs\` |
| PID file | `/run/nginx.pid` | `/run/nginx.pid` or `/var/run/nginx.pid` (same place on modern systems) | `/run/nginx.pid` | `/run/nginx.pid` or `/var/run/nginx.pid` | `logs\nginx.pid` |
| Temp dirs | `/var/lib/nginx/{body,proxy,...}` | `/var/cache/nginx/*_temp` | `/var/lib/nginx/tmp/` | `/var/cache/nginx/*_temp` | `temp\` |
| Dynamic modules | `/usr/lib/nginx/modules/`, loaded via `modules-enabled/` | `/usr/lib/nginx/modules/` (RHEL: `/usr/lib64/nginx/modules/`), add `load_module` yourself | `/usr/lib64/nginx/modules/`, loaded via `/usr/share/nginx/modules/*.conf` | `/usr/lib/nginx/modules/` | built-in only |
| Extra | `modules-enabled/`, ufw profiles | - | SELinux contexts apply | `/docker-entrypoint.d/`, `/etc/nginx/templates/*.template` (env vars via envsubst) | `nginx.exe` in the folder |

Tip: do not memorize paths for every distro - run `nginx -V` (shows `--conf-path`, `--error-log-path`, `--http-log-path`, `--pid-path`, `--http-client-body-temp-path`...) and `sudo nginx -T` (prints the full merged config, with `# configuration file ...` markers showing which file each part came from).

## 🛠️ Practical: step by step

1. Explore the real tree on your server:

   ```bash
   sudo apt install -y tree
   tree /etc/nginx
   ls -l /etc/nginx/sites-enabled/       # see the symlink arrows
   ls -l /etc/nginx/modules-enabled/
   ls /usr/lib/nginx/modules/
   ls /var/log/nginx/ /var/lib/nginx/
   ```

2. Ask Nginx itself where its files are:

   ```bash
   nginx -V 2>&1 | tr ' ' '\n' | grep -E 'path|prefix'
   # --prefix=/usr/share/nginx
   # --conf-path=/etc/nginx/nginx.conf
   # --http-log-path=/var/log/nginx/access.log
   # --error-log-path=/var/log/nginx/error.log    (exact list differs a little per release)
   # --lock-path=/var/lock/nginx.lock
   # --pid-path=/run/nginx.pid
   # --http-client-body-temp-path=/var/lib/nginx/body
   # --http-proxy-temp-path=/var/lib/nginx/proxy
   # ...
   ```

3. Add a site the Ubuntu way. Create `/etc/nginx/sites-available/blog`:

   ```nginx
   # /etc/nginx/sites-available/blog
   server {
       listen 80;
       listen [::]:80;
       server_name blog.local;

       root /var/www/blog;
       index index.html;

       access_log /var/log/nginx/blog.access.log;   # per-site logs are easier to read
       error_log  /var/log/nginx/blog.error.log;

       location / {
           try_files $uri $uri/ =404;
       }
   }
   ```

   ```bash
   sudo mkdir -p /var/www/blog
   echo '<h1>Blog</h1>' | sudo tee /var/www/blog/index.html

   # enable = create a symlink in sites-enabled (use the FULL path as the target)
   sudo ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/blog
   sudo nginx -t && sudo systemctl reload nginx

   # disable = remove only the symlink, the real file stays in sites-available
   # sudo rm /etc/nginx/sites-enabled/blog && sudo systemctl reload nginx
   ```

4. Add a global http-level setting in `conf.d` - create `/etc/nginx/conf.d/security.conf`:

   ```nginx
   # /etc/nginx/conf.d/security.conf  (included inside http{} by nginx.conf)
   server_tokens off;     # hide the nginx version in the Server header and error pages
   ```

5. See what the helper files contain:

   ```bash
   cat /etc/nginx/proxy_params
   cat /etc/nginx/snippets/fastcgi-php.conf
   diff /etc/nginx/fastcgi.conf /etc/nginx/fastcgi_params   # only SCRIPT_FILENAME differs
   head -n 20 /etc/nginx/mime.types
   cat /etc/logrotate.d/nginx
   systemctl cat nginx                                       # shows the unit file
   ```

   `/etc/nginx/proxy_params` on Ubuntu contains:

   ```nginx
   proxy_set_header Host $http_host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```

6. See the final merged config with source markers:

   ```bash
   sudo nginx -T | grep '# configuration file'
   # configuration file /etc/nginx/nginx.conf:
   # configuration file /etc/nginx/modules-enabled/...conf:
   # configuration file /etc/nginx/mime.types:
   # configuration file /etc/nginx/conf.d/security.conf:
   # configuration file /etc/nginx/sites-enabled/blog:
   # configuration file /etc/nginx/sites-enabled/default:
   ```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Root of all config; global + events + http; includes the rest |
| `/etc/nginx/conf.d/*.conf` | Extra http-level config (only `.conf` files are loaded) |
| `/etc/nginx/sites-available/` | All site files (enabled or not) - Debian/Ubuntu only |
| `/etc/nginx/sites-enabled/` | Symlinks to enabled sites; loaded with `include sites-enabled/*` |
| `/etc/nginx/snippets/` | Reusable fragments (`fastcgi-php.conf`, `snakeoil.conf`, your own) |
| `/etc/nginx/modules-available/`, `modules-enabled/` | Dynamic module `load_module` files; enabled ones are included in main context |
| `/etc/nginx/mime.types` | Extension → `Content-Type` table, used with `default_type` |
| `/etc/nginx/fastcgi.conf` vs `fastcgi_params` | FastCGI variables for PHP-FPM; `fastcgi.conf` also sets `SCRIPT_FILENAME` |
| `/etc/nginx/proxy_params` | Standard proxy headers (Ubuntu/Debian only) |
| `/etc/nginx/scgi_params`, `uwsgi_params` | Variables for SCGI / uWSGI backends |
| `/etc/nginx/koi-utf`, `koi-win`, `win-utf` | Cyrillic charset conversion maps for the `charset` module |
| `/var/www/html/` | Ubuntu default web root |
| `/usr/share/nginx/html/` | Stock pages; default root for nginx.org/RHEL/Docker |
| `/var/log/nginx/access.log`, `error.log` | Request log and error log |
| `/run/nginx.pid` | Master PID; used by `nginx -s` and systemd |
| `/usr/sbin/nginx` | The binary |
| `/lib/systemd/system/nginx.service` | systemd unit (runs `nginx -t` before start) |
| `/var/lib/nginx/` | Temp files for big request bodies and buffered upstream responses |
| `/usr/lib/nginx/modules/` | Dynamic module `.so` files |
| `/etc/logrotate.d/nginx` | Log rotation rules |

## ✅ Verify it works

```bash
sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

readlink -f /etc/nginx/sites-enabled/blog
# /etc/nginx/sites-available/blog         <- symlink points to a real file

sudo systemctl reload nginx
curl -s -H "Host: blog.local" http://127.0.0.1/
# <h1>Blog</h1>

tail -n 1 /var/log/nginx/blog.access.log
# 127.0.0.1 - - [..] "GET / HTTP/1.1" 200 14 "-" "curl/..."

cat /run/nginx.pid && pgrep -o nginx      # both show the same master PID
```

## ⚠️ Common mistakes

- **Relative symlink target**: `cd /etc/nginx/sites-enabled && sudo ln -s ../sites-available/blog` works, but `sudo ln -s sites-available/blog /etc/nginx/sites-enabled/` creates a **broken** link. Use full paths.
- Editing the file in `sites-enabled` thinking it is a copy - it is the same file as in `sites-available` (via symlink). If someone copied instead of linking, you now have two diverging files.
- Putting a file in `conf.d/` without the `.conf` extension (`conf.d/mysite`) - it is ignored, because only `conf.d/*.conf` is included.
- Leaving backup files in `sites-enabled/` (e.g. `blog.bak`) - `include sites-enabled/*` loads **everything**, causing "duplicate server" warnings or conflicts.
- Using `fastcgi_params` without setting `SCRIPT_FILENAME` → PHP returns a blank page or "File not found". Use `fastcgi.conf` or `snippets/fastcgi-php.conf`.
- Following an Ubuntu tutorial on RHEL/Docker and creating `sites-enabled/`, which nothing includes.
- Editing `/usr/share/nginx/html/index.html` on Ubuntu and wondering why the page does not change - the Ubuntu default root is `/var/www/html`.

## 🔁 Follow-up questions interviewers ask

- **What is the difference between `sites-available` and `sites-enabled`?** `sites-available` stores all site files; `sites-enabled` holds symlinks to the ones that should be loaded. Enable/disable without deleting config.
- **`conf.d` vs `sites-enabled` - which should I use?** Both are included in `http{}`. `conf.d/*.conf` is the upstream/nginx.org convention and works everywhere; `sites-*` is a Debian/Ubuntu convention.
- **Where do you look first when Nginx won't start?** `sudo nginx -t`, then `sudo journalctl -u nginx -n 50`, then `/var/log/nginx/error.log`.
- **What is `mime.types` for?** It maps file extensions to `Content-Type`; without it browsers may download CSS/JS instead of using them.
- **What is `/var/lib/nginx/body` used for?** Temporary storage when a client request body (e.g. an upload) is bigger than `client_body_buffer_size`.

---
[⬅️ Previous](06-install-and-setup-nginx.md) · [🏠 Index](../README.md) · [Next ➡️](08-nginx-conf-structure-blocks-directives.md)

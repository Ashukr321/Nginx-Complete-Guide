# Q: Apache vs Nginx - what is the difference and when would you pick each?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Linux Admin, PHP/Backend

## 🎯 Short answer (say this in the interview)

Both are open-source web servers that can also act as reverse proxies. The main difference is architecture: **Apache** uses process/thread-based MPMs (prefork, worker, event) and supports per-directory `.htaccess` files and in-process modules like `mod_php`; **Nginx** uses an event-driven, non-blocking model with a few workers, so it uses less memory under many concurrent connections and is very good at static files and reverse proxying. Nginx has no `.htaccess` - all config is central and runs PHP through PHP-FPM. I pick **Nginx** for reverse proxy, load balancing and high-concurrency/static workloads, and **Apache** when an app depends on `.htaccess` (e.g. shared hosting) or Apache-specific modules. A common setup is Nginx in front of Apache.

## 🧩 Scenario

You inherit a server running WordPress on Apache with many `.htaccess` rewrite rules from plugins. Traffic is growing and memory usage spikes during peaks. Options: (1) keep Apache but switch from `prefork` + `mod_php` to `event` MPM + PHP-FPM, (2) put Nginx in front to serve static files and proxy PHP pages to Apache, or (3) migrate fully to Nginx + PHP-FPM and convert `.htaccess` rules into Nginx `location`/`try_files`/`rewrite` rules.

## 💼 Use case

**Choose Nginx when:**
- You need a reverse proxy / load balancer in front of Node, Python, Java, Go apps.
- You serve many static files or have many concurrent (often slow or keep-alive) connections.
- You run Kubernetes ingress (ingress-nginx) or containers that need a small, simple proxy.

**Choose Apache when:**
- The app relies on `.htaccess` (shared hosting, some CMS plugins) so users can change rules without root.
- You need Apache-only modules (e.g. some auth modules) or the team already knows Apache well.

**Both together:** Nginx on 80/443 (TLS, static, cache) → Apache on `127.0.0.1:8080` (PHP app with `.htaccess`).

## ⚙️ How it works

```text
APACHE (prefork/worker MPM)                NGINX (event-driven)

 conn1 -> process/thread 1                  conn1 \
 conn2 -> process/thread 2                  conn2  \
 conn3 -> process/thread 3                  conn3   >-- worker 1 (event loop)
 ...                                        ...    /
 connN -> process/thread N                  connN /         worker 2 ...
 (memory grows with connections)            (few workers, one per CPU core)

 Apache "event" MPM improves keep-alive handling, but is still thread-based.
```

| Topic | Apache httpd | Nginx |
|---|---|---|
| Architecture | MPMs: prefork (processes), worker (threads), event (threads + event for keep-alive) | Master + few workers, event loop, non-blocking |
| Per-directory config | `.htaccess` supported | Not supported (central config only, faster) |
| PHP | `mod_php` (in-process) or PHP-FPM | PHP-FPM via `fastcgi_pass` |
| Static files | Good | Very efficient |
| Reverse proxy | `mod_proxy`, `mod_proxy_http`, `mod_proxy_balancer` | Built-in `proxy_pass`, `upstream` |
| Modules | Load/unload dynamically (`a2enmod`) | Built-in at compile time or dynamic `.so` modules (`load_module`) |
| Config syntax | XML-like `<VirtualHost>`, `<Directory>` | Blocks `server {}`, `location {}` |
| Ubuntu config dir | `/etc/apache2/` | `/etc/nginx/` |
| Test config | `sudo apache2ctl configtest` | `sudo nginx -t` |

## 🛠️ Practical: step by step

The same job - "serve `/var/www/site` for `site.local` and proxy `/api` to `127.0.0.1:3000`" - in both servers.

**Apache (Ubuntu)** – `/etc/apache2/sites-available/site.conf`:

```apache
# /etc/apache2/sites-available/site.conf
<VirtualHost *:80>
    ServerName site.local
    DocumentRoot /var/www/site

    <Directory /var/www/site>
        # allow .htaccess files (Apache comments must be on their own line)
        AllowOverride All
        Require all granted
    </Directory>

    ProxyPass        /api http://127.0.0.1:3000/api
    ProxyPassReverse /api http://127.0.0.1:3000/api
</VirtualHost>
```

```bash
sudo apt install -y apache2
sudo a2enmod proxy proxy_http
sudo a2ensite site.conf
sudo apache2ctl configtest && sudo systemctl reload apache2
```

**Nginx (Ubuntu)** – `/etc/nginx/sites-available/site`:

```nginx
# /etc/nginx/sites-available/site
server {
    listen 80;
    listen [::]:80;
    server_name site.local;

    root /var/www/site;
    index index.html;

    location / {
        try_files $uri $uri/ =404;      # what .htaccess rewrites often did
    }

    location /api {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/site /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> Do not run both on port 80 at the same time - the second one fails with "Address already in use". Move Apache to 8080 (`/etc/apache2/ports.conf` → `Listen 8080` and `<VirtualHost *:8080>`) if you want Nginx in front of it.

**Nginx in front of Apache** – `/etc/nginx/sites-available/site` location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;   # Apache now listens on 8080
    include proxy_params;
}
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/apache2/apache2.conf` | Apache main config |
| `/etc/apache2/ports.conf` | Apache `Listen` ports |
| `/etc/apache2/sites-available/`, `sites-enabled/` | Apache virtual hosts (`a2ensite` / `a2dissite`) |
| `/etc/nginx/nginx.conf` | Nginx main config |
| `/etc/nginx/sites-available/`, `sites-enabled/` | Nginx server blocks (manual symlink) |
| `.htaccess` (inside docroot) | Apache per-directory overrides; ignored by Nginx |

## ✅ Verify it works

```bash
sudo ss -tlnp | grep -E ':80|:8080'
# shows which program (nginx or apache2) owns each port

curl -I -H "Host: site.local" http://127.0.0.1/
# HTTP/1.1 200 OK
# Server: nginx/1.xx.x (Ubuntu)      <- or "Server: Apache/2.4.xx (Ubuntu)"
```

## ⚠️ Common mistakes

- Saying "Nginx is always faster". For dynamic pages the app/PHP is usually the bottleneck; Nginx's big win is concurrency, memory and static files.
- Copying `.htaccess` to an Nginx server and expecting it to work - Nginx ignores it; rules must be rewritten in the server config.
- Running Apache and Nginx both on port 80.
- Forgetting `a2enmod proxy proxy_http` on Apache before using `ProxyPass`.

## 🔁 Follow-up questions interviewers ask

- **What are Apache MPMs?** Multi-Processing Modules: `prefork` (one process per connection, needed for non-thread-safe `mod_php`), `worker` (threads), `event` (threads + better keep-alive handling).
- **Why does Nginx not support `.htaccess`?** Checking for per-directory files on every request costs disk lookups; Nginx keeps config central and loaded in memory.
- **How do you convert an `.htaccess` rewrite?** Usually with `try_files`, `return 301`, or `rewrite` inside a `location`.
- **How does Nginx run PHP?** It passes `.php` requests to PHP-FPM using `fastcgi_pass unix:/run/php/php-fpm.sock;` (socket path depends on the PHP version installed).

---
[⬅️ Previous](04-reverse-proxy-vs-forward-proxy.md) · [🏠 Index](../README.md) · [Next ➡️](06-install-and-setup-nginx.md)

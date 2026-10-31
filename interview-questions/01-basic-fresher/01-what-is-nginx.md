# Q: What is Nginx and what is it used for?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Backend, Full-stack

## 🎯 Short answer (say this in the interview)

Nginx (pronounced "engine-x") is an open-source, high-performance web server. Besides serving files, it is commonly used as a **reverse proxy**, **load balancer**, **TLS/SSL terminator** and **HTTP cache** in front of application servers like Node.js, Python or Java apps. It uses an **event-driven, non-blocking** architecture: one master process manages a few worker processes, and each worker can handle thousands of connections at the same time. That is why it uses little memory and stays fast under many concurrent connections.

## 🧩 Scenario

You join a team that runs an Express API and a React frontend on one Ubuntu 24.04 server. Users must reach everything on `https://shop.example.com`. The React build (HTML/CSS/JS files) must be served fast, `/api/` requests must go to the Node app on port 3000, and HTTPS must be handled in one place. Nginx is the one program that does all of this: it listens on ports 80/443, serves the React files directly from disk, and forwards `/api/` to Node.

## 💼 Use case

- **Web server** – serve static websites (HTML, CSS, JS, images) straight from disk.
- **Reverse proxy** – sit in front of Node.js, Django, Spring Boot, PHP-FPM, etc. and forward requests to them.
- **Load balancer** – spread traffic across several copies of an app (`upstream` block).
- **SSL/TLS termination** – handle HTTPS certificates (e.g. Let's Encrypt) so apps only speak plain HTTP internally.
- **Caching** – cache responses from backends (`proxy_cache`) to reduce load.
- **Security / traffic control** – rate limiting, IP allow/deny, basic auth, security headers.
- **Kubernetes** – the community **ingress-nginx** controller uses Nginx to route traffic into a cluster.
- **TCP/UDP proxy** – the `stream` module can proxy non-HTTP traffic (e.g. databases, DNS).

## ⚙️ How it works

Nginx starts one **master process** (runs as root, reads config, binds ports) and several **worker processes** (run as an unprivileged user like `www-data`, handle the actual requests). Each worker runs an **event loop**: instead of one thread per connection, it reacts to "this socket is ready" events, so a worker never sits idle waiting for a slow client.

```text
                         Internet
                            |
                    (port 80 / 443)
                            |
              +-------------v--------------+
              |   Nginx master (root)      |  reads nginx.conf, binds ports,
              |                            |  starts/stops workers, reloads
              +----+---------+---------+---+
                   |         |         |
              +----v--+ +----v--+ +----v--+
              |worker | |worker | |worker |   (user www-data)
              |event  | |event  | |event  |   each handles thousands
              |loop   | |loop   | |loop   |   of connections
              +---+---+ +---+---+ +---+---+
                  |         |         |
      +-----------+    +----+----+    +------------------+
      |                |         |                       |
 static files      /api/* -> Node app      /admin -> another backend
 /var/www/html     127.0.0.1:3000           127.0.0.1:8080
```

Request flow in one line: **client → Nginx (listen port) → pick `server` block by Host → pick `location` by URL → serve file OR proxy to backend → response back to client.**

## 🛠️ Practical: step by step

1. Install Nginx on Ubuntu:

   ```bash
   sudo apt update
   sudo apt install -y nginx
   ```

2. Check it is running and see the master + worker processes:

   ```bash
   systemctl status nginx --no-pager
   ps -ef | grep [n]ginx
   ```

3. Look at a minimal config that shows the two main jobs (serve files + proxy). Create `/etc/nginx/sites-available/demo`:

   ```nginx
   # /etc/nginx/sites-available/demo
   server {
       listen 80;                      # accept HTTP on port 80 (IPv4)
       listen [::]:80;                 # and on IPv6
       server_name demo.local;         # which Host header this block answers

       root /var/www/html;             # job 1: web server - files come from here
       index index.html index.nginx-debian.html;

       location / {
           try_files $uri $uri/ =404;  # serve the file if it exists, else 404
       }

       location /api/ {
           # job 2: reverse proxy - forward /api/* to a Node app
           proxy_pass http://127.0.0.1:3000;
           include proxy_params;       # Ubuntu file: sets Host, X-Real-IP, X-Forwarded-*
       }
   }
   ```

4. Enable it, test and reload:

   ```bash
   sudo ln -s /etc/nginx/sites-available/demo /etc/nginx/sites-enabled/demo
   sudo nginx -t
   sudo systemctl reload nginx
   ```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/usr/sbin/nginx` | The Nginx binary |
| `/etc/nginx/nginx.conf` | Main config file, includes everything else |
| `/etc/nginx/sites-available/demo` | Our server block (the "site") |
| `/etc/nginx/sites-enabled/demo` | Symlink that turns the site on |
| `/var/www/html` | Default document root on Ubuntu |
| `/var/log/nginx/access.log`, `error.log` | Request log and error log |

## ✅ Verify it works

```bash
sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

curl -I -H "Host: demo.local" http://127.0.0.1/
# HTTP/1.1 200 OK
# Server: nginx/1.xx.x (Ubuntu)
# Content-Type: text/html

curl -I -H "Host: demo.local" http://127.0.0.1/api/
# 502 Bad Gateway if nothing runs on port 3000 yet - that proves Nginx tried to proxy
```

## ⚠️ Common mistakes

- Saying Nginx "runs your app". It does not execute Node/Python code; it **forwards** requests to the app process.
- Calling it only a web server - interviewers want to hear reverse proxy, load balancer and TLS termination too.
- Forgetting that Nginx Plus (paid, from F5) and open-source Nginx are different - features like active health checks and the live API/dashboard are **Plus only**.
- Editing config and not running `sudo nginx -t` before reload.

## 🔁 Follow-up questions interviewers ask

- **What is the master process vs worker process?** The master reads config, binds ports and manages workers; workers accept connections and process requests.
- **Why is Nginx good at many concurrent connections?** It is event-driven and non-blocking, so one worker handles many connections without one thread per connection.
- **How many worker processes should you run?** Usually one per CPU core - `worker_processes auto;` does that.
- **Is Nginx open source?** Yes (2-clause BSD-style license). Nginx Plus is the commercial version with extra features and support.
- **What else can it proxy besides HTTP?** TCP/UDP via the `stream` module, and mail protocols via the `mail` module.

---
[🏠 Index](../README.md) · [Next ➡️](02-web-server-vs-application-server.md)

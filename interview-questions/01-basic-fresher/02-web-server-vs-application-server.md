# Q: What is the difference between a web server and an application server?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, Backend, Full-stack

## 🎯 Short answer (say this in the interview)

A **web server** handles HTTP connections and serves **static content** (HTML, CSS, JS, images) straight from disk; it can also forward requests to other servers. An **application server** runs your **business logic** - code that talks to a database, checks login, builds JSON - and produces **dynamic** responses. Nginx and Apache httpd are web servers; Node.js/Express, Gunicorn/Uvicorn (Python), Tomcat (Java) and PHP-FPM are application servers or app runtimes. In production we usually put the web server in front, and it proxies dynamic requests to the app server.

## 🧩 Scenario

Your team built a Django app. A developer runs `python manage.py runserver` on the production VM and opens port 8000 to the world. It works, but it is slow for images, has no HTTPS, and Django's docs say the dev server is not for production. The fix: run the app with **Gunicorn** (application server) on `127.0.0.1:8000`, and put **Nginx** (web server) on ports 80/443 to serve `/static/` files and proxy everything else to Gunicorn.

## 💼 Use case

- **Web server (Nginx)**: static sites, React/Angular/Vue builds, images and downloads, TLS, compression, caching, rate limiting, routing to backends.
- **Application server**: REST/GraphQL APIs, login/session logic, payments, database queries, server-side rendering.
- Typical stacks:
  - Nginx + Node.js (Express/NestJS/Next.js)
  - Nginx + Gunicorn/Uvicorn (Django/Flask/FastAPI)
  - Nginx + PHP-FPM (Laravel/WordPress)
  - Nginx + Tomcat (Spring/Java)

## ⚙️ How it works

| | Web server (Nginx) | Application server (e.g. Node, Gunicorn, Tomcat) |
|---|---|---|
| Main job | Accept HTTP, serve files, route/proxy | Run your code, build dynamic responses |
| Content | Static (files on disk) | Dynamic (computed per request) |
| Talks to database? | No | Yes |
| Good at | Many connections, TLS, caching, compression | Business logic |
| Usually listens on | `0.0.0.0:80` / `443` (public) | `127.0.0.1:3000` / `8000` / `8080` (private) |

```text
 Browser
   |
   |  GET /index.html          GET /api/orders
   v                               |
+--------------------------------------------------+
|                Nginx  (web server)               |
|  location /      -> read file from /var/www/app  |
|  location /api/  -> proxy_pass to app server ----+-----+
+--------------------------------------------------+     |
                                                         v
                                  +-------------------------------+
                                  | App server 127.0.0.1:3000     |
                                  | (Node/Express, Gunicorn, ...) |
                                  |   runs code -> DB query       |
                                  +---------------+---------------+
                                                  |
                                              PostgreSQL
```

Note: the line is not always sharp. Node.js *can* serve files and Nginx *can* run small logic (e.g. `return`, `map`, njs). But in interviews, describe the roles as above.

## 🛠️ Practical: step by step

1. Start a tiny "application server" with Node.js (only listens on localhost):

   ```bash
   sudo apt update && sudo apt install -y nodejs
   mkdir -p ~/app && cd ~/app
   cat > server.js <<'EOF'
   const http = require('http');
   http.createServer((req, res) => {
     // dynamic: the response changes on every request
     res.setHeader('Content-Type', 'application/json');
     res.end(JSON.stringify({ path: req.url, time: new Date().toISOString() }) + '\n');
   }).listen(3000, '127.0.0.1');
   EOF
   node server.js &
   ```

2. Create static files for the web server part:

   ```bash
   sudo mkdir -p /var/www/app
   echo '<h1>Static page served by Nginx</h1>' | sudo tee /var/www/app/index.html
   ```

3. Create `/etc/nginx/sites-available/app`:

   ```nginx
   # /etc/nginx/sites-available/app
   server {
       listen 80;
       listen [::]:80;
       server_name app.local;

       # WEB SERVER role: static files from disk
       root /var/www/app;
       index index.html;

       location / {
           try_files $uri $uri/ =404;
       }

       # APPLICATION SERVER role is done by Node; Nginx only forwards
       location /api/ {
           proxy_pass http://127.0.0.1:3000;   # no trailing slash: /api/x is sent as /api/x
           include proxy_params;               # sets Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto
       }
   }
   ```

4. Enable, test, reload:

   ```bash
   sudo ln -s /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app
   sudo nginx -t && sudo systemctl reload nginx
   ```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/app` | Server block that splits static vs dynamic |
| `/etc/nginx/sites-enabled/app` | Symlink that activates it |
| `/etc/nginx/proxy_params` | Ubuntu helper with standard `proxy_set_header` lines |
| `/var/www/app/` | Static files served directly by Nginx |
| `~/app/server.js` | The application server (Node) |

## ✅ Verify it works

```bash
curl -s -H "Host: app.local" http://127.0.0.1/
# <h1>Static page served by Nginx</h1>

curl -s -H "Host: app.local" http://127.0.0.1/api/orders
# {"path":"/api/orders","time":"..."}     <- dynamic, changes every call
```

## ⚠️ Common mistakes

- Exposing the app server port (3000/8000/8080) to the internet instead of binding it to `127.0.0.1`.
- Running development servers (`runserver`, `flask run`) in production.
- Letting the app server serve large static files and images - slower and wastes app workers.
- Thinking Tomcat/Node "is not a web server" - they speak HTTP too; the difference is the **role** they play.

## 🔁 Follow-up questions interviewers ask

- **Is Node.js a web server or an application server?** It is a runtime; with `http`/Express it acts as an application server that also speaks HTTP. In production it usually sits behind Nginx.
- **What is PHP-FPM?** A FastCGI process manager that runs PHP code; Nginx talks to it with `fastcgi_pass`.
- **What is WSGI/ASGI?** Python interfaces between a web/app server (Gunicorn/Uvicorn) and the framework (Django/FastAPI).
- **Why not just use the app server alone?** You lose efficient static serving, TLS handling, buffering of slow clients, load balancing and rate limiting in one place.

---
[⬅️ Previous](01-what-is-nginx.md) · [🏠 Index](../README.md) · [Next ➡️](03-why-nginx-in-front-of-nodejs.md)

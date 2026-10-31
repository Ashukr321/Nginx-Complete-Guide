# Q: Node.js can already serve HTTP. Why put Nginx in front of it?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, Backend (Node.js), Full-stack, MERN/MEAN

## 🎯 Short answer (say this in the interview)

Node.js can serve HTTP, but it is built to run application logic, not to be the internet-facing edge. Nginx in front handles the "edge" jobs: **HTTPS/TLS termination**, serving **static files** efficiently, **gzip**, **load balancing** across several Node processes or servers, **buffering slow clients**, **rate limiting**, and **security headers**. It also lets Node run as a normal user on a private port like `127.0.0.1:3000` while Nginx owns ports 80/443. And you can host many apps on one server, routed by domain or path.

## 🧩 Scenario

You deployed an Express API on an Ubuntu 24.04 EC2 instance with `node app.js` on port 3000, and the security group allows port 3000 from anywhere. Problems appear: users type `http://api.example.com` (port 80) and get nothing, there is no HTTPS, and every image download blocks a Node process. You install Nginx, close port 3000 in the security group, bind Node to `127.0.0.1:3000`, and let Nginx listen on 80/443 and proxy to Node.

## 💼 Use case

- **TLS in one place** – Let's Encrypt cert on Nginx (`certbot --nginx`), Node stays plain HTTP.
- **Static assets** – React/Vue build files served by Nginx using `sendfile`, not by Express.
- **Scale out** – run 2–4 Node processes (PM2 or containers) and load balance them with an `upstream`.
- **Zero-downtime deploys** – bring up a new app instance, switch the upstream, `nginx -s reload`.
- **Protection** – `limit_req` rate limiting, request body size limits (`client_max_body_size`), IP allow/deny.
- **Many apps on one VM** – `api.example.com` → Node, `admin.example.com` → another app.
- **WebSockets** – Nginx can proxy them (needs the `Upgrade`/`Connection` headers).

## ⚙️ How it works

```text
             Internet (only 80 and 443 open)
                         |
               +---------v----------+
               |       Nginx        |  TLS, gzip, static files,
               |  :80  -> 301 https |  rate limit, headers,
               |  :443 server block |  load balancing
               +----+----------+----+
                    |          |
       /static/*  <-+          +->  / and /api/*
   read from disk                   proxy_pass http://node_app
   /var/www/myapp/public                    |
                                 +----------+----------+
                                 |                     |
                         127.0.0.1:3000         127.0.0.1:3001
                          Node process 1        Node process 2
                       (not reachable from internet)
```

Why each piece matters:

- **Ports below 1024** need root (or special capabilities). Running Node as root is risky; Nginx's master binds port 80/443 as root and its workers drop to `www-data`.
- **Slow clients**: Nginx buffers the request/response, so a slow mobile client ties up a cheap Nginx connection, not your Node event loop.
- **Single-threaded Node**: one Node process uses one CPU core for JS; Nginx can spread load over several processes.

## 🛠️ Practical: step by step

1. Make Node listen only on localhost (in your app code):

   ```bash
   # app.js ke end me aisa likho:
   #   app.listen(3000, '127.0.0.1');   # sirf localhost pe suno, internet se direct access nahi hoga
   node app.js &                        # app ko background me start karo
   curl -s http://127.0.0.1:3000/       # server ke andar se check karo – yahan chalna chahiye
   ```

2. Install Nginx and allow web traffic:

   ```bash
   sudo apt update && sudo apt install -y nginx   # package list update karo, phir Nginx install karo
   sudo ufw allow OpenSSH                         # pehle SSH allow karo, warna server se lock-out ho jaoge
   sudo ufw allow 'Nginx Full'                    # port 80 (HTTP) aur 443 (HTTPS) dono khol do
   sudo ufw enable                                # firewall ON karo
   ```

3. Create `/etc/nginx/sites-available/api.example.com`:

   ```nginx
   # /etc/nginx/sites-available/api.example.com
   upstream node_app {                     # backend Node servers ka group – iska naam proxy_pass me use hoga
       server 127.0.0.1:3000;              # pehla Node process
       # server 127.0.0.1:3001;            # baad me aur Node process add karo, Nginx load balance karega
   }

   server {
       listen 80;                          # IPv4 pe port 80 (HTTP) pe request suno
       listen [::]:80;                     # IPv6 pe bhi port 80 suno
       server_name api.example.com;        # ye block sirf is domain ki request handle karega (Host header match)

       client_max_body_size 10m;           # 10 MB se badi upload reject karo (warna 413 error)

       # static files Nginx khud serve karega, Express tak request jayegi hi nahi
       location /static/ {
           alias /var/www/myapp/public/;   # /static/logo.png -> /var/www/myapp/public/logo.png se file milegi
           expires 7d;                     # browser 7 din tak file cache karega – baar baar download nahi
       }

       # baaki sab requests Node ko forward karo
       location / {
           proxy_pass http://node_app;                                     # request upstream (Node) ko bhejo
           proxy_http_version 1.1;                                         # backend se HTTP/1.1 me baat karo (keepalive/WebSocket ke liye zaroori)
           proxy_set_header Host $host;                                    # original domain Node tak pahunchao
           proxy_set_header X-Real-IP $remote_addr;                        # user ka asli IP bhejo, warna Node ko 127.0.0.1 dikhega
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;    # proxies ki poori IP chain bhejo
           proxy_set_header X-Forwarded-Proto $scheme;                     # batao request http thi ya https

           # WebSocket support (normal requests pe koi nuksaan nahi)
           proxy_set_header Upgrade $http_upgrade;                         # client ka "Upgrade: websocket" header aage bhejo
           proxy_set_header Connection "upgrade";                          # connection ko WebSocket me upgrade hone do
       }
   }
   ```

   Note: sending `Connection "upgrade"` on every request is the simple version. A `map $http_upgrade $connection_upgrade` block is the cleaner production version (covered in the WebSocket question).

4. Enable, test, reload:

   ```bash
   sudo ln -s /etc/nginx/sites-available/api.example.com /etc/nginx/sites-enabled/   # symlink banao – isse site "enable" hoti hai
   sudo nginx -t && sudo systemctl reload nginx                                       # pehle config test, sahi ho tabhi reload (zero downtime)
   ```

5. (Optional) Add HTTPS with Let's Encrypt once DNS points to the server:

   ```bash
   sudo apt install -y certbot python3-certbot-nginx   # certbot + uska Nginx plugin install karo
   sudo certbot --nginx -d api.example.com              # free SSL certificate lo, Nginx config khud update ho jayega
   ```

6. In Express, trust the proxy so `req.ip` and `req.protocol` use the forwarded headers:

   ```js
   // app.js
   app.set('trust proxy', 1);           // Express ko batao ki aage 1 proxy (Nginx) hai – X-Forwarded-* headers pe bharosa karo
   app.listen(3000, '127.0.0.1');       // sirf localhost pe suno, bahar se sirf Nginx ke through aao
   ```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/api.example.com` | Upstream + server block for the API |
| `/etc/nginx/sites-enabled/api.example.com` | Symlink that enables it |
| `/var/www/myapp/public/` | Static files served by Nginx |
| `/var/log/nginx/access.log`, `error.log` | Shows proxied requests and upstream errors (502/504) |
| `/etc/letsencrypt/live/api.example.com/` | Certificates (after certbot) |

## ✅ Verify it works

```bash
sudo nginx -t                                          # config syntax check – "test is successful" aana chahiye
curl -I -H "Host: api.example.com" http://127.0.0.1/   # Host header ke saath Nginx ko request bhejo, sirf headers dekho
# HTTP/1.1 200 OK
# Server: nginx/1.xx.x (Ubuntu)                        <- Nginx ne jawab diya
# X-Powered-By: Express                                <- matlab response Node se Nginx ke through aaya

# dusri machine se check karo – port 3000 jawab NAHI dena chahiye:
curl -m 5 http://<server-public-ip>:3000/              # timeout / refused aana chahiye, tabhi Node safe hai
```

## ⚠️ Common mistakes

- Leaving Node on `0.0.0.0:3000` with the port open, so people bypass Nginx.
- Forgetting `proxy_set_header Host` / `X-Forwarded-*`, so the app sees wrong host, IP `127.0.0.1` and `http` instead of `https`.
- Not setting `app.set('trust proxy', ...)` in Express, so rate limiters and logs see Nginx's IP.
- **502 Bad Gateway** because Node is down or listening on a different port - check `sudo tail -f /var/log/nginx/error.log`.
- On RHEL/Rocky with SELinux, proxying fails with "Permission denied" until you run `sudo setsebool -P httpd_can_network_connect 1`.

## 🔁 Follow-up questions interviewers ask

- **What does 502 vs 504 mean here?** 502: Nginx could not get a valid response (Node down/refused). 504: Node did not answer within `proxy_read_timeout` (default 60s).
- **PM2 cluster vs Nginx load balancing?** PM2 cluster spreads load across cores on one machine; Nginx can balance across processes and across machines. They are often used together.
- **How does Node know the real client IP?** From `X-Forwarded-For` / `X-Real-IP` set by Nginx, with `trust proxy` enabled.
- **Do you still need Nginx in Kubernetes?** Often an ingress controller (e.g. ingress-nginx) or a cloud load balancer does this edge job instead.

---
[⬅️ Previous](02-web-server-vs-application-server.md) · [🏠 Index](../README.md) · [Next ➡️](04-reverse-proxy-vs-forward-proxy.md)

# Q: What is a reverse proxy? How is it different from a forward proxy?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Cloud, Network/Security, Backend

## 🎯 Short answer (say this in the interview)

Both sit in the middle of a connection, but they work for different sides. A **forward proxy** works for the **clients**: clients are configured to send their requests through it to reach the internet, and websites see the proxy's IP instead of the user's (e.g. a corporate proxy like Squid). A **reverse proxy** works for the **servers**: clients think they are talking to the website, but the reverse proxy receives the request and forwards it to one of the hidden backend servers. Nginx is mostly used as a reverse proxy - for TLS termination, load balancing, caching and hiding backends.

## 🧩 Scenario

- **Reverse proxy:** Your company runs three Spring Boot services on private IPs. Customers only know `https://app.example.com`. Nginx on the public server receives every request and forwards `/orders` to the order service and `/users` to the user service. Customers never see the private IPs.
- **Forward proxy:** In the same company, office laptops are configured (browser or `HTTP_PROXY` env var) to go through a Squid proxy at `proxy.corp:3128`. The proxy blocks social media and logs which sites employees visit.

## 💼 Use case

**Reverse proxy (server side):**
- Hide and protect backend servers (only the proxy is public).
- TLS termination, load balancing, caching, compression.
- One domain, many services (path or host based routing).
- Examples: Nginx, HAProxy, Envoy, Traefik, cloud load balancers (AWS ALB), CDNs.

**Forward proxy (client side):**
- Corporate internet filtering and logging.
- Caching downloads for many internal users (e.g. package mirrors).
- Giving private servers controlled outbound internet access.
- Examples: Squid, corporate web proxies, VPN-style anonymizing proxies.

## ⚙️ How it works

```text
FORWARD PROXY  (acts for the CLIENT, client knows about it)

  +---------+       +----------------+                +---------------+
  | Laptop  | ----> | Forward proxy  | --- internet ->| google.com    |
  | (config:|       | (Squid :3128)  |                | sees proxy IP |
  | proxy)  | <---- | filter / log   | <------------- |               |
  +---------+       +----------------+                +---------------+
   inside company network


REVERSE PROXY  (acts for the SERVER, client does NOT know about backends)

  +---------+                +------------------+       +------------------+
  | Browser | -- internet -> |  Reverse proxy   | ----> | backend 10.0.1.5 |
  | thinks  |                |  Nginx :443      | ----> | backend 10.0.1.6 |
  | it talks| <------------- |  app.example.com | <---- | (private)        |
  | to app  |                +------------------+       +------------------+
  +---------+                                      inside company network
```

| | Forward proxy | Reverse proxy |
|---|---|---|
| Works on behalf of | Clients | Servers |
| Who configures it | The client (browser / OS / env var) | The site owner (DNS points to it) |
| Hides | The client's identity | The backend servers |
| Typical tools | Squid | Nginx, HAProxy, Envoy, AWS ALB |
| Typical jobs | Filtering, logging, outbound access | TLS, load balancing, caching, routing |

**Can Nginx be a forward proxy?** Only in a limited way for plain HTTP. Open-source Nginx does not support the `CONNECT` method that browsers use for HTTPS through a proxy, so for a real forward proxy use Squid (or similar).

## 🛠️ Practical: step by step

**Part A – Nginx as a reverse proxy (the common case)**

1. Start two fake backend services:

   ```bash
   mkdir -p /tmp/orders /tmp/users
   echo "orders service" > /tmp/orders/index.html
   echo "users service"  > /tmp/users/index.html
   (cd /tmp/orders && python3 -m http.server 5001 --bind 127.0.0.1 &)
   (cd /tmp/users  && python3 -m http.server 5002 --bind 127.0.0.1 &)
   ```

2. Create `/etc/nginx/sites-available/gateway`:

   ```nginx
   # /etc/nginx/sites-available/gateway
   server {
       listen 80;
       listen [::]:80;
       server_name app.local;

       # /orders/... -> backend on 5001, prefix /orders/ is stripped
       location /orders/ {
           proxy_pass http://127.0.0.1:5001/;    # trailing slash = replace /orders/ with /
           include proxy_params;
       }

       # /users/... -> backend on 5002
       location /users/ {
           proxy_pass http://127.0.0.1:5002/;
           include proxy_params;
       }
   }
   ```

3. Enable and reload:

   ```bash
   sudo ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

**Part B – what a forward proxy looks like from the client side**

The client must be told to use the proxy (this is the key difference):

```bash
# one command through a forward proxy
curl -x http://proxy.corp:3128 https://example.com

# or for the whole shell session
export http_proxy=http://proxy.corp:3128
export https_proxy=http://proxy.corp:3128
```

With a reverse proxy the client does nothing special - it just calls `https://app.example.com`.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/gateway` | Reverse proxy routes |
| `/etc/nginx/sites-enabled/gateway` | Symlink enabling the routes |
| `/etc/nginx/proxy_params` | Standard headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` |
| `/var/log/nginx/error.log` | Shows "connect() failed" if a backend is down |
| `/etc/squid/squid.conf` | (Forward proxy, if you use Squid) its main config |

## ✅ Verify it works

```bash
curl -s -H "Host: app.local" http://127.0.0.1/orders/
# orders service

curl -s -H "Host: app.local" http://127.0.0.1/users/
# users service

# backend logs show the request came from 127.0.0.1 (Nginx), not from the real client
```

## ⚠️ Common mistakes

- Mixing up the two: remember **forward = client's agent**, **reverse = server's agent**.
- Forgetting `X-Forwarded-For`, so backends log only the proxy's IP.
- Trailing-slash confusion in `proxy_pass`: `proxy_pass http://127.0.0.1:5001/;` strips the location prefix; `proxy_pass http://127.0.0.1:5001;` keeps the full original URI.
- Building an open forward proxy by accident - anyone on the internet can then use your server to hide their traffic.

## 🔁 Follow-up questions interviewers ask

- **Is a load balancer a reverse proxy?** A Layer 7 load balancer is a reverse proxy that spreads requests over several backends.
- **Is a CDN a reverse proxy?** Yes - a CDN edge is a distributed caching reverse proxy in front of your origin.
- **What is a transparent proxy?** A proxy that intercepts traffic without the client being configured (usually done at network level).
- **What is an API gateway?** A reverse proxy with extra API features: auth, rate limits, request transformation, API keys.

---
[⬅️ Previous](03-why-nginx-in-front-of-nodejs.md) · [🏠 Index](../README.md) · [Next ➡️](05-apache-vs-nginx.md)

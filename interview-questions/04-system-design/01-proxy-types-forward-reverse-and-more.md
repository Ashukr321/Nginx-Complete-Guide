# Q: What is a proxy? Explain forward proxy, reverse proxy, and the other proxy types you would use in a system design.

> **Level:** System Design · **Asked in:** DevOps, SRE, Backend, Cloud, System Design round

## 🎯 Short answer (say this in the interview)

A **proxy** is a middleman that receives a request and sends it on to someone else. The type depends on **whose side it works for**. A **forward proxy** works for the **clients**: it hides them from the internet and controls their outbound traffic (e.g. Squid in an office). A **reverse proxy** works for the **servers**: clients only see the proxy, which hides the backends and adds TLS, caching and routing (e.g. Nginx, HAProxy, Envoy). The other "boxes" in a system design diagram are specialised reverse proxies: a **load balancer** spreads traffic over many servers, an **API gateway** adds API concerns like auth, API keys and rate limits, a **CDN** is a reverse proxy cache spread around the world, and a **sidecar proxy** in a service mesh sits next to every service to handle service-to-service traffic (mTLS, retries, metrics). A **transparent proxy** intercepts traffic without the client being configured for it. In a design, I usually draw: client → CDN → load balancer → API gateway / Nginx → services, with sidecars inside the cluster.

## 🧩 Scenario

You are in a system design round: *"Design the backend for a food delivery app."* You draw boxes for the mobile app, services and database. The interviewer stops you: *"What sits between the phone and your services? Why a CDN **and** a load balancer **and** an API gateway — aren't they all proxies?"* You need to name each proxy type, say what job it does, and explain why each layer exists. Separately, the company's security team wants all office laptops to reach the internet only through an approved proxy that blocks some sites — that is a different kind of proxy.

## 💼 Use case

- **Forward proxy:** office internet filtering and logging, giving private servers controlled outbound access, caching package downloads.
- **Reverse proxy:** one public entry point, TLS termination, hiding backend IPs, path/host routing (Nginx in front of Node.js, Java, Python apps).
- **Load balancer:** horizontal scaling and failover across many identical servers.
- **API gateway:** a public API used by mobile apps and partners — auth, per-key rate limits, routing to microservices.
- **CDN:** serving images, JS/CSS and video close to users; absorbing traffic spikes and DDoS.
- **Sidecar / service mesh:** many microservices that need mTLS, retries, timeouts and tracing without changing app code.
- **Transparent proxy:** network-level filtering (schools, ISPs, corporate gateways) without configuring each device.

## ⚙️ How it works

**Where it sits in an HLD diagram:** Users → CDN → Load balancer → API gateway / Nginx reverse proxy → Services (each with a sidecar) → DB; office users → forward proxy → internet.

**Forward proxy — works for the client, hides the client**

```text
  Office laptops (configured to use proxy:3128)
  ┌────────┐
  │ Laptop ├──┐
  └────────┘  │      ┌──────────────┐          ┌──────────────┐
  ┌────────┐  ├─────►│ Forward proxy├─────────►│ example.com  │
  │ Laptop ├──┘      │ (Squid)      │          │ sees only the│
  └────────┘         │ allow/deny,  │          │ proxy's IP   │
                     │ log, cache   │          └──────────────┘
                     └──────────────┘
```

**Reverse proxy — works for the server, hides the servers**

```text
                     ┌──────────────┐          ┌───────────────┐
  Internet users ───►│ Reverse proxy├─────────►│ app :3000     │  private IP
  (know only         │ (Nginx)      │          └───────────────┘
   app.example.com)  │ TLS, routing,│          ┌───────────────┐
                     │ caching      ├─────────►│ api :8080     │  private IP
                     └──────────────┘          └───────────────┘
```

**Load balancer — a reverse proxy whose main job is spreading load**

```text
                   ┌──► app-1
  clients ───► LB ─┼──► app-2      (round robin / least connections / hash,
                   └──► app-3       removes dead servers)
```

**API gateway — a reverse proxy that understands APIs**

```text
                          ┌─ check JWT / API key
                          ├─ rate limit per key
  mobile / partners ─► API GW ─┬─► /users   ─► user-service
                          │    ├─► /orders  ─► order-service
                          │    └─► /payments─► payment-service
                          └─ log + metrics per API
```

**CDN — many reverse proxy caches near the users**

```text
  User in Mumbai ──► CDN edge (Mumbai)    ──┐ cache HIT  → answer from edge
  User in London ──► CDN edge (London)    ──┤ cache MISS → fetch once from origin
  User in NY     ──► CDN edge (New York)  ──┘                 │
                                                              ▼
                                                   Origin (Nginx + app)
```

**Sidecar proxy / service mesh — a proxy next to every service**

```text
  ┌──────────── Pod A ────────────┐            ┌──────────── Pod B ────────────┐
  │ order-svc ─► Envoy sidecar ───┼── mTLS ───►│ Envoy sidecar ─► payment-svc  │
  └───────────────────────────────┘            └───────────────────────────────┘
               ▲  config (routes, certs, retries) pushed by the control plane (Istio)
```

**Transparent proxy — intercepts without client configuration**

```text
  Laptop (no proxy settings) ──► Router/firewall redirects port 80 ──► Proxy ──► Internet
  Client thinks it talks directly to the website.
```

**Comparison table**

| Type | Whose side? | Hides whom? | Main job | Example tools |
|---|---|---|---|---|
| Forward proxy | Client | The clients | Control, filter, log and cache outbound traffic | Squid |
| Reverse proxy | Server | The servers | Single entry point, TLS, routing, caching | Nginx, HAProxy, Envoy |
| Load balancer | Server | The servers | Spread traffic, health checks, failover | Nginx, HAProxy, AWS ALB (L7), AWS NLB (L4) |
| API gateway | Server | The services | Auth, API keys, rate limits, routing, transformation, analytics | Kong (built on Nginx/OpenResty), AWS API Gateway |
| CDN | Server (origin owner) | The origin | Cache content at edges near users, absorb spikes/DDoS | Cloudflare, Amazon CloudFront, Akamai |
| Sidecar proxy / service mesh | Each service | Network details from the app | Service-to-service mTLS, retries, timeouts, telemetry | Envoy in Istio, Linkerd (its own Rust proxy) |
| Transparent proxy | Network owner | Usually the clients | Intercept/filter without client config | Squid in intercept mode, ISP/firewall proxies |

**Memory trick:** *Forward = the client's bodyguard* (goes out on behalf of the user). *Reverse = the server's receptionist* (greets visitors so they never walk into the back office). Everything else is a receptionist with a specialty: LB = **shares** the work, API gateway = **checks the ID**, CDN = **receptionists in every city**, sidecar = **a personal assistant at every desk**.

Nginx details (load balancing methods, caching, rate limiting) are covered in [load balancing methods](../02-intermediate/03-load-balancing-methods.md), [proxy caching](../03-advanced/06-proxy-caching.md) and [rate limiting](../03-advanced/04-rate-limiting.md). The basic forward vs reverse question is in [reverse proxy vs forward proxy](../01-basic-fresher/04-reverse-proxy-vs-forward-proxy.md).

**Why Nginx is not your forward proxy for HTTPS:** when a browser uses a forward proxy for `https://` sites, it sends `CONNECT example.com:443` and asks the proxy to open a raw TCP tunnel. **Core Nginx does not support `CONNECT`** — it rejects it with a 4xx error. Nginx can forward plain `http://` requests, and a third-party module (`ngx_http_proxy_connect_module`) adds CONNECT, but it needs patching and compiling Nginx. For a real forward proxy, use **Squid**.

## 🛠️ Practical: step by step

**Part A — Nginx as a minimal reverse proxy**

1. **Start a test backend** on the Nginx server (it is private: bound to 127.0.0.1)

```bash
mkdir -p /tmp/app && echo "hello from the hidden app on :3000" > /tmp/app/index.html
nohup python3 -m http.server 3000 --bind 127.0.0.1 --directory /tmp/app >/dev/null 2>&1 &
```

2. **Create the reverse proxy** — file: `/etc/nginx/sites-available/app.conf`

```nginx
server {
    listen 80;
    server_name app.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;                              # the hidden backend
        proxy_set_header Host              $host;                      # keep the original host
        proxy_set_header X-Real-IP         $remote_addr;               # real client IP for the app
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

3. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/app.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -s -H "Host: app.example.com" http://127.0.0.1/
```

**Part B — Squid as a forward proxy (Ubuntu 22.04/24.04)**

Assume the proxy server is `10.0.0.5` and office clients are in `10.0.0.0/24`.

1. **Install Squid**

```bash
sudo apt update
sudo apt install -y squid
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.bak
```

2. **Allow your network and block some sites** — file: `/etc/squid/squid.conf`

Open the file and find the line `# INSERT YOUR OWN RULE(S) HERE TO ALLOW ACCESS FROM YOUR CLIENTS`. Add these lines right below it (they must come **before** the final `http_access deny all`, because Squid uses the first rule that matches):

```text
# Who may use this proxy
acl office_net src 10.0.0.0/24

# Sites we do not allow (leading dot = domain and all subdomains)
acl blocked_sites dstdomain .facebook.com .tiktok.com

http_access deny blocked_sites
http_access allow office_net
```

The default file already contains `http_port 3128` and the safety rules `http_access deny !Safe_ports` and `http_access deny CONNECT !SSL_ports` (HTTPS tunnels only to port 443). On Ubuntu you can also put your own rules in a file under `/etc/squid/conf.d/`, which is included before `http_access deny all`.

3. **Check the syntax, restart, and open the port only to the office network**

```bash
sudo squid -k parse                     # prints the config; errors are shown with "ERROR"/"FATAL"
sudo systemctl restart squid
sudo systemctl status squid --no-pager
sudo ufw allow from 10.0.0.0/24 to any port 3128 proto tcp   # if ufw is enabled
```

4. **Use the proxy from a client in 10.0.0.0/24**

```bash
curl -x http://10.0.0.5:3128 -I https://example.com
# or for the whole shell session:
export http_proxy=http://10.0.0.5:3128 https_proxy=http://10.0.0.5:3128
curl -I https://example.com
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/app.conf` | Nginx reverse proxy to the hidden backend on `127.0.0.1:3000` |
| `/etc/nginx/sites-enabled/app.conf` | Symlink that activates it |
| `/etc/squid/squid.conf` | Squid forward proxy config: port, ACLs, `http_access` rules |
| `/etc/squid/conf.d/` | Optional place for your own Squid rules on Ubuntu |
| `/var/log/squid/access.log` | Every request through the forward proxy (allowed and denied) |
| `/var/log/nginx/access.log` | Requests hitting the reverse proxy |

## ✅ Verify it works

Reverse proxy: the client talks only to Nginx, and the backend port is not reachable from outside.

```bash
curl -s -H "Host: app.example.com" http://<nginx-public-ip>/     # works
curl -s --max-time 3 http://<nginx-public-ip>:3000/               # fails: backend bound to 127.0.0.1
```

Forward proxy (example output):

```text
$ curl -x http://10.0.0.5:3128 -I https://example.com
HTTP/1.1 200 Connection established

HTTP/2 200
content-type: text/html
...
```

Blocked site (example output):

```text
$ curl -x http://10.0.0.5:3128 -I https://www.facebook.com
HTTP/1.1 403 Forbidden
...
curl: (56) CONNECT tunnel failed, response 403
```

Squid log:

```bash
sudo tail -n 5 /var/log/squid/access.log
```

Example lines:

```text
1730368800.123    210 10.0.0.21 TCP_TUNNEL/200 6012 CONNECT example.com:443 - HIER_DIRECT/93.184.215.14 -
1730368805.456      0 10.0.0.21 TCP_DENIED/403 3920 CONNECT www.facebook.com:443 - HIER_NONE/- text/html
```

Proof that Nginx is not an HTTPS forward proxy: point `curl -x` at an Nginx server and request an `https://` URL — the `CONNECT` is rejected with a 4xx error and curl reports `CONNECT tunnel failed`.

## ⚠️ Common mistakes

- Mixing up the two: "Nginx in front of my app" is a **reverse** proxy, not a forward proxy.
- Trying to build an HTTPS forward proxy with stock Nginx — no `CONNECT` support in core; use Squid.
- Adding Squid allow rules **after** `http_access deny all` — they never match.
- Leaving a forward proxy open to the internet (`http_access allow all`) — it becomes an open proxy that attackers use to hide their traffic.
- Drawing a CDN, LB and API gateway in an HLD without saying what each one adds — the interviewer wants the **reason** for each layer.
- Saying a forward proxy can read HTTPS content — with `CONNECT` it only sees the hostname and port, unless you set up TLS interception (SSL bump) with your own CA on every client.

## 🔁 Follow-up questions interviewers ask

1. **Is a load balancer a reverse proxy?**
   An L7 load balancer is a reverse proxy focused on spreading traffic. An L4 load balancer (like AWS NLB) works on TCP connections and does not read HTTP at all.
2. **Do you need both an API gateway and a load balancer?**
   Often yes: a cloud LB gives a highly available entry point, and the gateway adds API logic. For a small system, one Nginx can do both — the trade-off is fewer moving parts vs fewer gateway features.
3. **Why use a service mesh instead of retries and mTLS in the app code?**
   The sidecar gives the same behaviour to every service in every language. The trade-off is extra latency per hop, more memory per pod, and a more complex platform to operate.
4. **What is the difference between a CDN and Nginx caching?**
   Both are reverse proxy caches; a CDN has many edge locations near users, while Nginx caching runs in your own data center next to the app.
5. **How does a transparent proxy differ from a forward proxy?**
   A forward proxy is configured on the client; a transparent proxy intercepts traffic at the network (router/firewall) so the client does not know it exists.

---
[⬅️ Previous](../03-advanced/11-nginx-in-docker-and-kubernetes-ingress.md) · [🏠 Index](../README.md) · [Next ➡️](02-load-balancer-and-horizontal-scaling.md)

# Q: How do you pass the real client IP and protocol from Nginx to your backend?

> **Level:** Intermediate · **Asked in:** DevOps, Backend, Full-stack, SRE

## 🎯 Short answer (say this in the interview)

When Nginx is a reverse proxy, the backend sees **Nginx's IP** (`127.0.0.1`) as the client and plain `http` as the protocol. So I set headers with `proxy_set_header`: `Host $host`, `X-Real-IP $remote_addr`, `X-Forwarded-For $proxy_add_x_forwarded_for`, and `X-Forwarded-Proto $scheme`. The app must then be told to trust the proxy — for Express that is `app.set('trust proxy', 1)`, after which `req.ip` and `req.protocol` are correct. If Nginx itself sits behind a cloud load balancer or Cloudflare, I use the **realip module** (`set_real_ip_from` + `real_ip_header`) so Nginx's own `$remote_addr` becomes the real client IP. I only trust these headers from known proxy IPs, because clients can fake `X-Forwarded-For`.

## 🧩 Scenario

Your Express API behind Nginx logs every request as coming from `127.0.0.1`. Rate limiting blocks *everyone* at once because all users share that one IP. Your app also builds password-reset links as `http://...` even though users are on HTTPS, and secure cookies are not being set. Later, you put the whole thing behind an AWS ALB, and now Nginx logs show the ALB's private IPs instead of users.

![Reverse proxy scenario](../../resoruces/scenario_reverse_proxy.png)

## 💼 Use case

- Correct client IPs in app logs, analytics, fraud checks, geo-IP.
- Per-IP rate limiting in the app or in Nginx (`limit_req_zone $binary_remote_addr ...`).
- Generating correct absolute URLs and redirects (`https://`), secure cookies, OAuth callback URLs.
- Multi-tenant apps that route by `Host` header.

## ⚙️ How it works

```text
 Client 203.0.113.7
      |   HTTPS
      v
 +-----------+   X-Forwarded-For: 203.0.113.7
 | Cloud LB  |   (connects to Nginx from 10.0.1.5)
 | 10.0.1.5  |
 +-----+-----+
       |  HTTP
       v
 +---------------------------------------------------+
 | Nginx                                             |
 |  without realip: $remote_addr = 10.0.1.5   (LB)   |
 |  with realip:    $remote_addr = 203.0.113.7 (user)|
 |                                                   |
 |  proxy_set_header X-Real-IP $remote_addr;         |
 |  proxy_set_header X-Forwarded-For                 |
 |                   $proxy_add_x_forwarded_for;     |
 |  proxy_set_header X-Forwarded-Proto $scheme;      |
 +----------------------+----------------------------+
                        |  HTTP to 127.0.0.1:5000
                        v
 +---------------------------------------------------+
 | Express (trust proxy = 1)                         |
 |  req.ip       -> 203.0.113.7                      |
 |  req.protocol -> https / http (from X-Fwd-Proto)  |
 +---------------------------------------------------+
```

### The headers

| Header | Value | Meaning |
|---|---|---|
| `Host` | `$host` | Original domain (default would be the `proxy_pass` host, e.g. `127.0.0.1:5000`) |
| `X-Real-IP` | `$remote_addr` | The single IP that connected to Nginx (the client, or after realip, the real client) |
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for` | Incoming `X-Forwarded-For` **plus** `$remote_addr` appended: `client, proxy1, proxy2` |
| `X-Forwarded-Proto` | `$scheme` | `http` or `https` as seen by Nginx |

`$host` vs `$http_host`: `$host` is the hostname (no port, lower-cased, falls back to `server_name` if the header is missing); `$http_host` is the raw `Host` header including any port.

### Ubuntu's `proxy_params` file

Ubuntu ships `/etc/nginx/proxy_params` with these lines, so you can just `include proxy_params;`:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

### Spoofing risk

`X-Forwarded-For` is just a header — any client can send `X-Forwarded-For: 1.2.3.4`. `$proxy_add_x_forwarded_for` *appends* to whatever the client sent, so the **leftmost** value is untrusted. Rules:

- Trust only IPs added by proxies **you control** (count from the right).
- In Nginx, use `set_real_ip_from` only for your LB/CDN IP ranges.
- In Express, use `trust proxy` with a hop count (`1`) or the proxy IPs — **not** `true`, which trusts the leftmost (spoofable) value.
- If Nginx is the first hop on the internet, you can overwrite instead of append: `proxy_set_header X-Forwarded-For $remote_addr;`.

## 🛠️ Practical: step by step

### Part A — Nginx directly on the internet → Node app

1. Create the site config.

```bash
sudo nano /etc/nginx/sites-available/api
```

```nginx
# File: /etc/nginx/sites-available/api
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;

        # Either include Ubuntu's file...
        # include proxy_params;

        # ...or set them explicitly (same effect, but uses $host):
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

2. Tell Express to trust exactly one proxy (Nginx).

```js
// server.js
const express = require('express');
const app = express();

// Trust the first proxy hop (Nginx). Do NOT use `true` in production.
app.set('trust proxy', 1);

app.get('/whoami', (req, res) => {
  res.json({
    ip: req.ip,                       // real client IP
    protocol: req.protocol,           // 'https' when X-Forwarded-Proto is https
    secure: req.secure,
    host: req.hostname,
    xff: req.headers['x-forwarded-for'],
  });
});

app.listen(5000, '127.0.0.1', () => console.log('API on 127.0.0.1:5000'));
```

### Part B — Nginx behind a cloud load balancer or Cloudflare (realip module)

The `ngx_http_realip_module` is included in Ubuntu's Nginx package. It replaces `$remote_addr` with the IP from a header, **only** when the request comes from a trusted address.

```bash
sudo nano /etc/nginx/conf.d/realip.conf
```

```nginx
# File: /etc/nginx/conf.d/realip.conf   (loaded inside http {})

# --- Behind AWS ALB / GCP LB / Azure LB inside your VPC ---
set_real_ip_from 10.0.0.0/16;          # your VPC / LB subnet (adjust!)
real_ip_header   X-Forwarded-For;
real_ip_recursive on;                  # skip all trusted IPs from the right,
                                       # take the first untrusted one = client

# --- OR behind Cloudflare (use ONE setup, not both) ---
# Get the current ranges from https://www.cloudflare.com/ips/ and keep them updated.
# set_real_ip_from 173.245.48.0/20;
# set_real_ip_from 103.21.244.0/22;
# ... (all Cloudflare IPv4 and IPv6 ranges) ...
# real_ip_header CF-Connecting-IP;
```

After this, `$remote_addr` in logs, `limit_req`, `allow/deny` and `X-Real-IP` is the real client IP.

> If the cloud LB terminates TLS, `$scheme` in Nginx is `http`. Forward the LB's value instead:
> `proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;` (only when every request comes through that LB).

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/api` | Reverse proxy server block with `proxy_set_header` lines |
| `/etc/nginx/proxy_params` | Ubuntu's ready-made set of the four proxy headers |
| `/etc/nginx/conf.d/realip.conf` | `set_real_ip_from` / `real_ip_header` for LB or Cloudflare |
| `server.js` (your app) | `app.set('trust proxy', 1)` so Express reads the headers |
| `/var/log/nginx/access.log` | First column (`$remote_addr`) should now show real client IPs |

## ✅ Verify it works

```bash
sudo nginx -t
sudo systemctl reload nginx

curl -s -H 'Host: api.example.com' http://127.0.0.1/whoami
# {"ip":"127.0.0.1","protocol":"http","secure":false,"host":"api.example.com","xff":"127.0.0.1"}
# (from your laptop over the internet you'd see your public IP instead of 127.0.0.1)

# Spoof test: the fake value is kept in XFF but req.ip stays the real IP
curl -s -H 'Host: api.example.com' -H 'X-Forwarded-For: 6.6.6.6' http://127.0.0.1/whoami
# {"ip":"127.0.0.1", ... "xff":"6.6.6.6, 127.0.0.1"}

# Check the first column of access logs
sudo tail -n 3 /var/log/nginx/access.log | awk '{print $1}'
```

## ⚠️ Common mistakes

- Not setting `Host` → apps that route by host or build URLs see `127.0.0.1:5000`.
- Using `app.set('trust proxy', true)` → Express trusts the leftmost XFF value, which the client controls.
- Using `set_real_ip_from 0.0.0.0/0` → anyone can fake their IP with a header.
- Adding one `proxy_set_header` inside a `location` and losing all the ones from the `server` block — `proxy_set_header` is **not inherited** if the current level defines any.
- Forwarding `X-Forwarded-Proto $scheme` when TLS is terminated at an outer LB → app thinks every request is `http` and loops redirects to HTTPS.
- Forgetting to update Cloudflare IP ranges when they change.
- Logging `$http_x_forwarded_for` and treating it as trustworthy.

## 🔁 Follow-up questions interviewers ask

- **Difference between `X-Real-IP` and `X-Forwarded-For`?** `X-Real-IP` is one IP (the direct client of Nginx); `X-Forwarded-For` is a comma-separated chain of all hops.
- **What does `$proxy_add_x_forwarded_for` do?** Takes the incoming `X-Forwarded-For` and appends `$remote_addr`; if there was none, it equals `$remote_addr`.
- **What does `real_ip_recursive on` change?** It walks the header from the right and skips every trusted proxy IP, returning the last non-trusted one instead of just the rightmost.
- **What is the standard alternative to X-Forwarded-*?** The `Forwarded` header (RFC 7239), e.g. `Forwarded: for=203.0.113.7;proto=https`. Fewer tools use it, so X-Forwarded-* is still the de-facto standard.
- **How do you get the client IP through a TCP (layer 4) load balancer that can't add HTTP headers?** The PROXY protocol (`listen 80 proxy_protocol;` + `real_ip_header proxy_protocol;`) for TCP load balancers like AWS NLB.

---
[⬅️ Previous](05-try-files-react-spa-routing.md) · [🏠 Index](../README.md) · [Next ➡️](07-rewrite-vs-return-redirects.md)

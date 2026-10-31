# Q: What is the difference between SSL termination, SSL passthrough and re-encryption (end-to-end TLS)? When do you use each?

> **Level:** System Design · **Asked in:** DevOps, SRE, Security/Platform Engineer, Backend, System Design round

## 🎯 Short answer (say this in the interview)

They differ in **where TLS is decrypted**.

- **SSL termination:** Nginx holds the certificate, decrypts HTTPS, and talks plain HTTP to the backends. It is the most common setup. Nginx can then do all **L7 work**: path routing, caching, compression, rate limiting, adding headers, WAF. Certificates are managed in one place. The downside is that traffic inside the network is unencrypted.
- **SSL passthrough:** Nginx **does not decrypt**. It uses the `stream {}` module with `ssl_preread on` to read only the **SNI** hostname from the TLS ClientHello, then forwards the raw encrypted TCP stream to the right backend, which holds its own certificate. It is truly end-to-end, but Nginx loses all L7 features. It can't see paths, headers or cookies, and it can't add `X-Forwarded-For`.
- **Re-encryption (TLS bridging):** Nginx terminates TLS, inspects and routes at L7, then opens a **new TLS connection** to the backend with `proxy_pass https://`. It should verify that backend's certificate (`proxy_ssl_verify on`). You get L7 features and encryption in transit, at the cost of extra CPU and certificate management.

My default is termination. I choose re-encryption when compliance (PCI DSS, HIPAA, zero-trust) needs encryption inside the network. I choose passthrough when the backend must own the key or do client-certificate (mTLS) auth itself.

## 🧩 Scenario

A fintech company runs a public website, an internal admin panel, and a payment service behind one Nginx tier. Security says: "Card data must be encrypted on every network hop, including inside the VPC." The payment team also insists their service holds its own private key and verifies client certificates from partner banks itself. The website team just wants caching and gzip. You need one design that satisfies all three.

## 💼 Use case

- **Termination:** normal websites and APIs, SPAs, anything needing caching, routing, rate limiting, WAF and central certificates (Let's Encrypt on Nginx).
- **Re-encryption:** regulated data (payments, health), zero-trust networks, backends in another data center/cloud reached over untrusted links, service meshes.
- **Passthrough:** backends that must own their keys (HSM, partner certs), end-to-end mTLS to the app, non-HTTP TLS protocols, multi-tenant setups where the proxy operator must not see the traffic.

## ⚙️ How it works

**Where it sits in an HLD diagram:** `Client ──TLS──► Nginx edge (terminate | passthrough | re-encrypt) ──HTTP or TLS──► App tier`

**1) SSL termination**

```text
                  HTTPS (TLS)                        plain HTTP
 client ═══════════════════════════► NGINX ───────────────────────────► app :3000
                                     cert + key here
                                     sees URL, headers, cookies → routing, cache, gzip, WAF
```

**2) SSL passthrough (L4, `stream` module)**

```text
                  HTTPS (TLS)                     same TLS bytes, untouched
 client ═══════════════════════════► NGINX ═════════════════════════════► app :443
                                     stream { ssl_preread on; }            cert + key here
                                     reads ONLY the SNI "pay.example.com"
                                     from ClientHello → picks the upstream
                                     cannot see URL / headers / cookies
```

**3) Re-encryption / TLS bridging (end-to-end TLS with L7)**

```text
                  HTTPS (TLS #1)                   HTTPS (TLS #2, new connection)
 client ═══════════════════════════► NGINX ═════════════════════════════► app :8443
                                     public cert here     proxy_ssl_verify on   internal cert here
                                     decrypt → L7 work → encrypt again          (often from a private CA)
```

**Comparison**

| | Termination | Passthrough | Re-encryption |
|---|---|---|---|
| Nginx context | `http` | `stream` | `http` |
| Where the cert lives | Nginx | Backend | Nginx (public) + backend (internal) |
| Traffic Nginx → app | Plain HTTP | Original TLS | New TLS |
| L7 features (path routing, cache, headers, gzip, WAF) | ✅ | ❌ (route by SNI, IP or port only) | ✅ |
| Client IP for the backend | `X-Forwarded-For` header | Only via PROXY protocol | `X-Forwarded-For` header |
| TLS CPU cost on Nginx | 1 handshake per client connection | Almost none | Client handshake + upstream handshake (reduced by upstream keepalive and session reuse) |
| Cert management | Simplest (one place) | Every backend | Both places |
| Typical reason | Default for web/API | Backend must own keys / do mTLS itself | Compliance, zero trust |

**mTLS (mutual TLS)** fits on top of these:

- Client → Nginx mTLS: `ssl_verify_client on;` + `ssl_client_certificate` (termination or re-encryption).
- Nginx → backend mTLS: `proxy_ssl_certificate` + `proxy_ssl_certificate_key`, so Nginx proves its identity to the app (re-encryption).
- Client → app mTLS with nothing in between: use passthrough.

Getting public certificates on Nginx is covered in [HTTPS with Certbot](../02-intermediate/04-https-ssl-certbot-setup.md).

## 🛠️ Practical: step by step

A local lab on one Ubuntu 22.04/24.04 machine. Self-signed certificates and high ports keep it away from your real sites on 80/443.

| Port | Role |
|---|---|
| `127.0.0.1:9000` | Plain HTTP backend |
| `127.0.0.1:9001` | TLS backend "app1" (own cert) |
| `127.0.0.1:9002` | TLS backend "app2" (own cert) |
| `10443` | Front: **termination** → 9000 |
| `11443` | Front: **passthrough** (stream, SNI) → 9001 / 9002 |
| `12443` | Front: **re-encryption** → 9001 with verification |

1. **Create lab certificates**

```bash
sudo mkdir -p /etc/nginx/lab-tls
for n in app1 app2; do
  sudo openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout /etc/nginx/lab-tls/$n.key -out /etc/nginx/lab-tls/$n.crt \
    -subj "/CN=$n.example.com" -addext "subjectAltName=DNS:$n.example.com"
done
```

2. **Backends and the two HTTP-based fronts (termination + re-encryption)**. File: `/etc/nginx/sites-available/tls-lab.conf`

```nginx
# ---------- backends ----------
server {                                   # plain HTTP backend
    listen 127.0.0.1:9000;
    location / { return 200 "plain backend: got '$scheme' from proxy\n"; }
}
server {                                   # TLS backend app1 (owns its cert)
    listen 127.0.0.1:9001 ssl;
    ssl_certificate     /etc/nginx/lab-tls/app1.crt;
    ssl_certificate_key /etc/nginx/lab-tls/app1.key;
    location / { return 200 "app1 TLS backend: got '$scheme', SNI='$ssl_server_name'\n"; }
}
server {                                   # TLS backend app2
    listen 127.0.0.1:9002 ssl;
    ssl_certificate     /etc/nginx/lab-tls/app2.crt;
    ssl_certificate_key /etc/nginx/lab-tls/app2.key;
    location / { return 200 "app2 TLS backend: got '$scheme', SNI='$ssl_server_name'\n"; }
}

# ---------- 1) SSL TERMINATION ----------
server {
    listen 10443 ssl;
    server_name app1.example.com;
    ssl_certificate     /etc/nginx/lab-tls/app1.crt;      # cert lives on the proxy
    ssl_certificate_key /etc/nginx/lab-tls/app1.key;

    location / {
        proxy_pass http://127.0.0.1:9000;                 # plain HTTP inside
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# ---------- 3) RE-ENCRYPTION ----------
server {
    listen 12443 ssl;
    server_name app1.example.com;
    ssl_certificate     /etc/nginx/lab-tls/app1.crt;      # public-facing cert
    ssl_certificate_key /etc/nginx/lab-tls/app1.key;

    location / {
        proxy_pass https://127.0.0.1:9001;                # new TLS connection to the backend
        proxy_ssl_verify on;                              # default is OFF → would accept any cert!
        proxy_ssl_trusted_certificate /etc/nginx/lab-tls/app1.crt;  # CA (here: the self-signed cert)
        proxy_ssl_verify_depth 2;
        proxy_ssl_name app1.example.com;                  # name to verify (default: host in proxy_pass)
        proxy_ssl_server_name on;                         # send SNI to the backend (default: off)
        proxy_ssl_protocols TLSv1.2 TLSv1.3;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

3. **Enable the `stream` module for passthrough.** On Ubuntu it is a dynamic module from the `libnginx-mod-stream` package (often already installed with `nginx`):

```bash
sudo apt install -y libnginx-mod-stream
ls /etc/nginx/modules-enabled/ | grep stream          # expect: 50-mod-stream.conf
nginx -V 2>&1 | tr ' ' '\n' | grep -E 'stream'      # look for --with-stream_ssl_preread_module
```

4. **Add a `stream {}` block in the main context of `/etc/nginx/nginx.conf`.** It must be **outside** `http {}`. Appending to the end of the file puts it in the main context:

```bash
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
sudo mkdir -p /etc/nginx/stream.d
sudo tee -a /etc/nginx/nginx.conf > /dev/null <<'EOF'

# L4 (TCP/UDP) proxying: main context, NOT inside http {}
stream {
    include /etc/nginx/stream.d/*.conf;
}
EOF
```

5. **Passthrough config: route by SNI without decrypting.** File: `/etc/nginx/stream.d/passthrough.conf`

```nginx
# ---------- 2) SSL PASSTHROUGH ----------
map $ssl_preread_server_name $tls_backend {
    app1.example.com   app1_tls;
    app2.example.com   app2_tls;
    default            app1_tls;
}

upstream app1_tls { server 127.0.0.1:9001; }
upstream app2_tls { server 127.0.0.1:9002; }

server {
    listen 11443;                 # no 'ssl' here: Nginx never decrypts
    ssl_preread on;               # peek at ClientHello to read SNI
    proxy_pass $tls_backend;
    proxy_connect_timeout 3s;
    # proxy_protocol on;          # optional: pass real client IP (backend must 'listen ... proxy_protocol')
}
```

6. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/tls-lab.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

In production, passthrough usually listens on `443`. The same IP:port can't be used by both an `http` `listen 443 ssl` and a `stream` `listen 443`. Use different IPs/ports, or let `stream` own 443 and pass "terminate here" hostnames to an internal `http` server on another port.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/lab-tls/` | Lab certificates and keys for app1 / app2 |
| `/etc/nginx/sites-available/tls-lab.conf` | Backends + termination (10443) + re-encryption (12443) in the `http` context |
| `/etc/nginx/nginx.conf` | Main config. The `stream {}` block is added at the end, in the main context. |
| `/etc/nginx/stream.d/passthrough.conf` | `map $ssl_preread_server_name`, upstreams, and the passthrough server (11443) |
| `/etc/nginx/modules-enabled/50-mod-stream.conf` | Loads the dynamic stream module (from `libnginx-mod-stream`) |
| `/var/log/nginx/error.log` | `upstream SSL certificate verify error` when re-encryption verification fails |

## ✅ Verify it works

```bash
# 1) Termination: the backend sees plain http
curl -sk --resolve app1.example.com:10443:127.0.0.1 https://app1.example.com:10443/

# 2) Passthrough: routed by SNI, and the backend itself did the TLS
curl -sk --resolve app1.example.com:11443:127.0.0.1 https://app1.example.com:11443/
curl -sk --resolve app2.example.com:11443:127.0.0.1 https://app2.example.com:11443/

# 3) Re-encryption: the backend sees https from Nginx, with SNI
curl -sk --resolve app1.example.com:12443:127.0.0.1 https://app1.example.com:12443/
```

Example output:

```text
plain backend: got 'http' from proxy
app1 TLS backend: got 'https', SNI='app1.example.com'
app2 TLS backend: got 'https', SNI='app2.example.com'
app1 TLS backend: got 'https', SNI='app1.example.com'
```

Prove that passthrough hands the client the **backend's** certificate (Nginx has no cert on 11443):

```bash
openssl s_client -connect 127.0.0.1:11443 -servername app2.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject
```

Example output: `subject=CN = app2.example.com`

Prove that re-encryption **verifies** the backend: temporarily set `proxy_ssl_name wrong.example.com;`, reload, and request port 12443 again. You should get `502 Bad Gateway` and an `upstream SSL certificate does not match "wrong.example.com"` line in `/var/log/nginx/error.log`. Then change it back.

## ⚠️ Common mistakes

- Putting `stream {}` inside `http {}` or in `sites-available/`. It must be in the **main context**, otherwise `nginx -t` fails with `"stream" directive is not allowed here`.
- `unknown directive "stream"`: the stream module isn't loaded. Install `libnginx-mod-stream` and keep `include /etc/nginx/modules-enabled/*.conf;` at the top of `nginx.conf`.
- Re-encryption with `proxy_ssl_verify` left **off** (the default). The traffic is encrypted, but Nginx would happily talk to an impostor, so the "end-to-end security" is weaker than it looks.
- Forgetting `proxy_ssl_server_name on` when the backend serves several names by SNI. The backend returns the wrong/default cert and verification fails.
- Expecting path-based routing, caching or `X-Forwarded-For` with passthrough. At L4 Nginx can only see the SNI, IP and port.
- Clients without SNI (very old ones) under passthrough. They hit the `default` backend.
- Thinking termination is "insecure". It is standard practice when the internal network is trusted and controlled. Choose re-encryption when policy or threat model says otherwise.

## 🔁 Follow-up questions interviewers ask

1. **Trade-off: termination vs re-encryption?**
   Termination is simpler and cheaper (one handshake, one place for certs) but traffic inside is plain. Re-encryption keeps every hop encrypted and still allows L7 features, at the cost of extra CPU, latency for new upstream connections, and internal certificate management. Upstream keepalive reduces the handshake cost.
2. **How does Nginx route TLS traffic it cannot decrypt?**
   The SNI hostname is sent in clear text in the TLS ClientHello. `ssl_preread on` reads it into `$ssl_preread_server_name`, and a `map` picks the upstream. (With Encrypted Client Hello, the real SNI is hidden from the proxy, so this would not work.)
3. **How does the backend get the client IP under passthrough?**
   Enable `proxy_protocol on;` in the stream server and `listen 443 ssl proxy_protocol;` (plus `set_real_ip_from` / `real_ip_header proxy_protocol`) on the backend.
4. **Where do internal certificates for re-encryption come from?**
   Usually a private CA (e.g. HashiCorp Vault PKI, cert-manager, AWS Private CA, or a service mesh that issues short-lived certs automatically). Nginx trusts that CA with `proxy_ssl_trusted_certificate`.
5. **Where does TLS end in a typical cloud setup?**
   Often at the cloud load balancer (ALB) with a managed certificate, then HTTP or re-encrypted HTTPS to Nginx. Or an NLB in TCP mode passes TLS through to Nginx, which terminates it. Both are valid, so state where TLS ends in your diagram.

---
[⬅️ Previous](08-rate-limiting-algorithms.md) · [🏠 Index](../README.md) · [Next ➡️](10-design-scalable-web-app-with-nginx.md)

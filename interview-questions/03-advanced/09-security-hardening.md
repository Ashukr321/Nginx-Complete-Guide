# Q: How do you secure and harden an Nginx server?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Security Engineer, Platform Engineer

## 🎯 Short answer (say this in the interview)

I harden Nginx in layers. **Hide information**: `server_tokens off` so the version isn't shown. **Strong TLS**: only TLS 1.2/1.3, HTTP → HTTPS redirect, and HSTS. **Security headers** with `always`: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`. **Reduce attack surface**: limit HTTP methods, set `client_max_body_size`, deny access to hidden files like `.git` and `.env`, and restrict admin paths by IP plus basic auth. **Limit abuse**: rate limiting, and fail2ban to ban repeat offenders. **Least privilege**: workers run as `www-data`, config and keys are not world-readable. Then I verify with `curl -I`, securityheaders.com and SSL Labs.

## 🧩 Scenario

A security audit of your company's public website finds: the Nginx version is visible in error pages, `https://site.com/.git/config` is downloadable, there is no HSTS, TLS 1.0 is still enabled, and `/admin` is open to the whole internet. You have one day to fix all findings and show proof to the auditor.

## 💼 Use case

- Passing security audits / pen tests (PCI-DSS, SOC 2, ISO 27001 checklists).
- Any internet-facing Nginx: websites, APIs, reverse proxies.
- Protecting admin panels (Grafana, Jenkins, WordPress admin) published behind Nginx.

## ⚙️ How it works

```text
 internet
    │
    ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ NGINX (defence in depth)                                       │
 │  1. TLS 1.2/1.3 only, HTTP→HTTPS, HSTS                         │
 │  2. rate limit (limit_req) + fail2ban bans repeat offenders    │
 │  3. method allow-list, body size limit, timeouts               │
 │  4. deny hidden files (.git, .env, .htpasswd)                  │
 │  5. /admin → IP allow-list + basic auth                        │
 │  6. security headers on every response                         │
 │  7. server_tokens off (no version leak)                        │
 │  workers run as www-data, keys readable only by root           │
 └────────────────────────────────────────────────────────────────┘
    │
    ▼
 backend app
```

**Security headers explained**

| Header | Protects against |
|---|---|
| `Strict-Transport-Security` (HSTS) | Browser always uses HTTPS for your domain → stops SSL-stripping downgrade attacks |
| `X-Frame-Options: SAMEORIGIN` | Clickjacking (your page loaded in an attacker's iframe) |
| `X-Content-Type-Options: nosniff` | Browser "guessing" a file type and executing it as script |
| `Referrer-Policy` | Leaking full URLs (with tokens/IDs) to other sites |
| `Content-Security-Policy` | XSS — controls which sources scripts, styles, images may load from |

`always` matters: without it, `add_header` only applies to 200, 201, 204, 206, 301, 302, 303, 304, 307 and 308 responses — not to error pages.

## 🛠️ Practical: step by step

1. **Hide the version and set global limits** — file: `/etc/nginx/nginx.conf`, inside `http { }`

```nginx
http {
    server_tokens off;            # "Server: nginx" instead of "Server: nginx/1.24.0 (Ubuntu)"

    client_max_body_size 10m;     # reject huge bodies early (413)
    client_body_timeout 10s;      # slow-loris style protection
    client_header_timeout 10s;
    keepalive_timeout 30s;
    send_timeout 10s;

    # ... rest of the default Ubuntu http block ...
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

2. **Reusable security headers snippet** — file: `/etc/nginx/snippets/security-headers.conf`

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# Start strict, then loosen for what your app really needs (CDNs, analytics, etc.)
add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'" always;
```

3. **TLS settings snippet** — file: `/etc/nginx/snippets/tls.conf` (based on Mozilla's "intermediate" profile)

```nginx
# /etc/nginx/snippets/tls.conf
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;    # TLS 1.3 + modern clients pick well on their own
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
```

> Ubuntu's default `nginx.conf` also has an `ssl_protocols` line in the `http` block. Set it once in one place to avoid confusion (remove TLSv1/TLSv1.1 there, or delete that line and use the snippet).

4. **Create basic-auth credentials for the admin area**

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd admin       # -c creates the file; omit -c to add more users
sudo chown root:www-data /etc/nginx/.htpasswd
sudo chmod 640 /etc/nginx/.htpasswd
```

5. **The hardened site** — file: `/etc/nginx/sites-available/site.conf`

```nginx
# Redirect all HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name site.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name site.example.com;

    ssl_certificate     /etc/letsencrypt/live/site.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/site.example.com/privkey.pem;
    include snippets/tls.conf;
    include snippets/security-headers.conf;

    root /var/www/site;
    index index.html;

    # Allow only the methods the app uses
    if ($request_method !~ ^(GET|HEAD|POST)$) {
        return 405;
    }

    # Block hidden files and folders (.git, .env, .htpasswd) but keep Let's Encrypt working
    location ~ /\.(?!well-known) {
        deny all;
        access_log off;
        log_not_found off;
    }

    # Block common sensitive file types
    location ~* \.(bak|old|sql|swp|ini|log)$ {
        deny all;
    }

    # Admin: office/VPN IPs only AND a password
    location /admin/ {
        satisfy all;                     # both IP rule and password must pass
        allow 203.0.113.0/24;            # office network (example)
        allow 10.8.0.0/24;               # VPN (example)
        deny  all;

        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        # add_header in a location replaces inherited ones → re-include the headers
        include snippets/security-headers.conf;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

6. **Rate-limit logins** (see the rate limiting question) — `limit_req_zone` in `http`, `limit_req` on `/login`.

7. **Least privilege on files**

```bash
# Config: owned by root, not writable by the worker user
sudo chown -R root:root /etc/nginx
sudo chmod -R go-w /etc/nginx
# Workers read the htpasswd file at request time, so give www-data read access back
sudo chown root:www-data /etc/nginx/.htpasswd && sudo chmod 640 /etc/nginx/.htpasswd

# Private keys: root only (the master reads them as root before dropping privileges)
sudo ls -l /etc/letsencrypt/live/site.example.com/
sudo chmod 600 /etc/ssl/private/*.key 2>/dev/null || true

# Web root: readable by www-data, not writable unless the app must upload
sudo chown -R root:www-data /var/www/site
sudo find /var/www/site -type d -exec chmod 750 {} \;
sudo find /var/www/site -type f -exec chmod 640 {} \;

# Workers should run as www-data
ps -o user,cmd -C nginx
```

8. **Ban repeat offenders with fail2ban** (reads Nginx logs and blocks IPs in the firewall)

```bash
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.d/nginx.local > /dev/null <<'EOF'
[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
EOF
sudo systemctl restart fail2ban
sudo fail2ban-client status
```

9. **Apply**

```bash
sudo ln -s /etc/nginx/sites-available/site.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | `server_tokens off`, global body size and timeouts |
| `/etc/nginx/snippets/security-headers.conf` | Reusable security headers |
| `/etc/nginx/snippets/tls.conf` | TLS protocols, ciphers, session settings |
| `/etc/nginx/sites-available/site.conf` | Redirect, method limits, hidden-file blocks, admin protection |
| `/etc/nginx/.htpasswd` | Basic-auth users (hashed passwords) |
| `/etc/letsencrypt/live/<domain>/` | Certificates and private key |
| `/etc/fail2ban/jail.d/nginx.local` | fail2ban jails for Nginx |

## ✅ Verify it works

```bash
curl -sI https://site.example.com/
```

Example output:

```text
HTTP/1.1 200 OK
Server: nginx
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; ...
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://site.example.com/.git/config   # expect 403
curl -s -o /dev/null -w "%{http_code}\n" https://site.example.com/.env          # expect 403
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE https://site.example.com/    # expect 405
curl -s -o /dev/null -w "%{http_code}\n" https://site.example.com/admin/        # expect 403 from outside the allowed IPs, 401 from inside without a password
curl -sI http://site.example.com/ | head -n 1                                   # expect 301

# TLS 1.1 must be refused, TLS 1.2 accepted
openssl s_client -connect site.example.com:443 -tls1_1 </dev/null 2>&1 | grep -iE "alert|no protocols|handshake failure"
openssl s_client -connect site.example.com:443 -tls1_2 </dev/null 2>&1 | grep -E "Protocol"
```

> On Ubuntu 22.04+ (OpenSSL 3), your local `openssl` client may refuse TLS 1.1 by itself, so a failure there doesn't prove the server refused it. SSL Labs (below) or `nmap --script ssl-enum-ciphers -p 443 site.example.com` gives a reliable server-side answer.

Online checks: **https://securityheaders.com** (headers grade) and **https://www.ssllabs.com/ssltest/** (TLS grade).

## ⚠️ Common mistakes

- Adding headers without `always` — they disappear on 404/500 pages.
- Adding an `add_header` inside a `location` and losing all headers from the `server` block (inheritance is all-or-nothing per level).
- Enabling HSTS with `preload` or a long `max-age` before every subdomain supports HTTPS — browsers will refuse HTTP for months.
- A CSP copied from the internet that breaks the app; roll it out first with `Content-Security-Policy-Report-Only`.
- Blocking `/.well-known/` with the hidden-files rule and breaking Let's Encrypt renewals.
- Relying on IP allow-lists behind a load balancer without `real_ip` configured — `$remote_addr` is the LB, not the user.
- Making the web root writable by `www-data` "just in case".

## 🔁 Follow-up questions interviewers ask

1. **What does `server_tokens off` actually change?**
   The `Server` header and default error pages show `nginx` without the version, so attackers can't easily match known CVEs to your version.
2. **What is the difference between `satisfy all` and `satisfy any`?**
   `all`: client must pass both IP rules and auth. `any`: either an allowed IP or valid credentials is enough.
3. **Why is X-XSS-Protection not in your list?**
   Modern browsers removed the XSS auditor; the header is deprecated. CSP is the real XSS defence.
4. **How do you rotate or renew certificates safely?**
   Certbot renews automatically and its deploy hook runs `systemctl reload nginx`; reload picks up the new cert with no downtime.
5. **Is Nginx a WAF?**
   Not by itself. You can add ModSecurity (open-source connector) or NGINX App Protect (commercial), or use a cloud WAF in front.

---
[⬅️ Previous](08-performance-tuning.md) · [🏠 Index](../README.md) · [Next ➡️](10-upstream-health-checks-and-failover.md)

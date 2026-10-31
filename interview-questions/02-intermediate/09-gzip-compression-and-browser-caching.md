# Q: How do you enable gzip compression and browser caching in Nginx?

> **Level:** Intermediate · **Asked in:** DevOps, Frontend/Full-stack, Performance engineering, SRE

## 🎯 Short answer (say this in the interview)

For compression I turn on `gzip on;` and list the text types to compress with `gzip_types` (HTML is always included), set `gzip_min_length` so tiny files aren't compressed, a moderate `gzip_comp_level` like 5, and `gzip_vary on` so caches store compressed and uncompressed versions separately. Brotli compresses better but needs a third-party module. For browser caching I use `expires` or an explicit `add_header Cache-Control` — long, `immutable` caching for fingerprinted assets like `app.3f9a1c.js`, and `no-cache` for HTML. I watch out for the `add_header` inheritance gotcha: if a `location` has any `add_header`, it loses all `add_header` lines from the `server` level. I verify with `curl -H 'Accept-Encoding: gzip' -I` and look for `Content-Encoding: gzip` and the `Cache-Control` header.

## 🧩 Scenario

Lighthouse gives your site a poor performance score: "Enable text compression" and "Serve static assets with an efficient cache policy". Your 1.2 MB JavaScript bundle is sent uncompressed, and returning visitors download the same CSS, JS and images on every visit.

![Static assets scenario](../../resoruces/scenario_static_assets.png)

## 💼 Use case

- Any website or SPA serving HTML/CSS/JS/JSON/SVG.
- JSON APIs behind Nginx (compress responses from the backend).
- Reducing bandwidth costs and improving load time on mobile networks.
- CDN-friendly headers: `Cache-Control` and `Vary` tell CDNs what they may cache.

## ⚙️ How it works

### Compression

```text
Browser                                   Nginx                         Disk / Backend
   |  GET /app.js                           |                                |
   |  Accept-Encoding: gzip, br  --------->  |  read app.js (big, text) <------|
   |                                        |  type in gzip_types?  yes      |
   |                                        |  size >= gzip_min_length? yes  |
   |                                        |  compress on the fly           |
   |  <--------- 200 OK                     |                                |
   |             Content-Encoding: gzip     |                                |
   |             Vary: Accept-Encoding      |                                |
   |  browser decompresses and runs JS      |                                |
```

- Only **text** formats benefit: HTML, CSS, JS, JSON, SVG, XML, plain text, fonts like `.ttf`/`.otf`.
- **Don't** gzip JPEG, PNG, WebP, MP4, ZIP, WOFF2 — they are already compressed; you only waste CPU.

### Browser caching

```text
First visit:                                Repeat visit (within max-age):
Browser --GET /assets/app.3f9a1c.js-->      Browser: "I have it, still fresh"
        <--200 + Cache-Control:             -> loads from disk cache,
           public, max-age=31536000,           NO request to the server at all
           immutable

Browser --GET /index.html-->                Browser --GET /index.html (If-None-Match/ETag)-->
        <--200 + Cache-Control: no-cache            <--304 Not Modified (tiny, fast)
```

| Header | Set by | Meaning |
|---|---|---|
| `Cache-Control: max-age=N` | `expires` or `add_header` | Fresh for N seconds — no request needed |
| `Cache-Control: no-cache` | `add_header` | Store it, but revalidate every time (ETag/Last-Modified → 304) |
| `Cache-Control: no-store` | `add_header` | Never store (sensitive data) |
| `immutable` | `add_header` | File will never change at this URL — don't even revalidate |
| `Expires: <date>` | `expires` | Older HTTP/1.0 header; `expires` sets it **and** `Cache-Control: max-age` |
| `ETag` / `Last-Modified` | Nginx automatically for static files | Used for 304 revalidation |

## 🛠️ Practical: step by step

### 1. Enable gzip globally

Ubuntu's `/etc/nginx/nginx.conf` already has `gzip on;` with the other gzip lines commented out. Rather than editing the main file, put the settings in their own file (and comment out the `gzip on;` line in `nginx.conf` to avoid a "directive is duplicate" error):

```bash
sudo sed -i 's/^\(\s*\)gzip on;/\1# gzip on;  # moved to conf.d\/gzip.conf/' /etc/nginx/nginx.conf
grep -n 'gzip' /etc/nginx/nginx.conf
sudo nano /etc/nginx/conf.d/gzip.conf
```

```nginx
# File: /etc/nginx/conf.d/gzip.conf   (included inside http {})

gzip on;
gzip_vary on;                 # add "Vary: Accept-Encoding" for caches/CDNs
gzip_proxied any;             # also compress responses to proxied requests (CDN in front)
gzip_comp_level 5;            # 1 = fastest, 9 = smallest; 4-6 is a good balance (default 1)
gzip_min_length 256;          # don't compress tiny responses (default 20 bytes)
gzip_types                    # text/html is ALWAYS compressed, don't list it
    text/plain
    text/css
    text/xml
    text/javascript
    application/javascript
    application/json
    application/xml
    application/rss+xml
    application/manifest+json
    image/svg+xml;
# Types must match what /etc/nginx/mime.types assigns (e.g. .ttf/.otf are not
# mapped there by default, so they'd be served as application/octet-stream).
```

### 2. Browser caching rules per site

```bash
sudo nano /etc/nginx/sites-available/mysite
```

```nginx
# File: /etc/nginx/sites-available/mysite
server {
    listen 80;
    server_name mysite.example.com;

    root /var/www/mysite;
    index index.html;

    # Security header set at server level...
    add_header X-Content-Type-Options "nosniff" always;

    # HTML: always revalidate so users get new deploys
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        # GOTCHA: because this location has its own add_header,
        # X-Content-Type-Options from the server level is NOT inherited.
        # Repeat it here (or use an include file with all common headers):
        add_header X-Content-Type-Options "nosniff" always;
    }

    # Fingerprinted build assets (e.g. app.3f9a1c.js): cache 1 year
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        access_log off;
    }

    # Images/fonts without hashes in the name: shorter cache using "expires"
    # expires 30d  ->  Expires: <date>  +  Cache-Control: max-age=2592000
    location ~* \.(?:png|jpe?g|gif|webp|avif|ico|svg|woff2?)$ {
        expires 30d;
        add_header X-Content-Type-Options "nosniff" always;
        access_log off;
    }
}
```

**The `add_header` inheritance rule:** `add_header` directives are inherited from the previous level (http → server → location) **only if the current level has no `add_header` of its own**. One `add_header` in a location wipes out all inherited ones. Common fix: put shared headers in a snippet (`/etc/nginx/snippets/security-headers.conf`) and `include` it in every location that adds headers. (Very recent mainline releases add an `add_header_inherit` directive to change this behaviour — check your version's docs before relying on it.)

Also note: without `always`, `add_header` only applies to success and redirect codes (200, 201, 204, 206, 301, 302, 303, 304, 307, 308), not to 404/500.

### 3. Enable and reload

```bash
sudo ln -s /etc/nginx/sites-available/mysite /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. (Optional) Brotli

Brotli is **not** part of core Nginx; it comes from the third-party `ngx_brotli` module. On recent Ubuntu releases the module may be available as packages (search with `apt search libnginx-mod-http-brotli`). If installed:

```nginx
# File: /etc/nginx/conf.d/brotli.conf  (only if the brotli module is installed and loaded)
brotli on;
brotli_comp_level 5;
brotli_types text/plain text/css application/javascript application/json image/svg+xml;
```

Keep gzip on as well — clients that don't send `br` in `Accept-Encoding` still get gzip.

### 5. (Optional) Pre-compressed files

`gzip_static on;` makes Nginx serve `app.js.gz` if it exists next to `app.js`, so you compress once at build time at level 9 with zero runtime CPU. The `gzip_static` module is included in Ubuntu's Nginx build.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Ubuntu default `gzip on;` lives here (commented out when moved) |
| `/etc/nginx/conf.d/gzip.conf` | All gzip settings in one place, applies to every site |
| `/etc/nginx/sites-available/mysite` | Per-site `Cache-Control` / `expires` rules |
| `/etc/nginx/snippets/` | Good place for a shared headers file to `include` |
| `/etc/nginx/mime.types` | Maps file extensions to the MIME types used by `gzip_types` |
| `/var/www/mysite/assets/` | Fingerprinted build output that gets long caching |

## ✅ Verify it works

```bash
sudo nginx -t
sudo systemctl reload nginx

# gzip: must show Content-Encoding: gzip and Vary
curl -s -I -H 'Accept-Encoding: gzip' -H 'Host: mysite.example.com' \
     http://127.0.0.1/assets/app.3f9a1c.js
# HTTP/1.1 200 OK
# Content-Type: application/javascript
# Content-Encoding: gzip
# Vary: Accept-Encoding
# Cache-Control: public, max-age=31536000, immutable

# Without Accept-Encoding: no compression
curl -s -I -H 'Host: mysite.example.com' http://127.0.0.1/assets/app.3f9a1c.js | grep -i content-encoding
# (no output)

# Compare transferred sizes
curl -s -H 'Host: mysite.example.com' -o /dev/null -w 'plain: %{size_download} bytes\n' \
     http://127.0.0.1/assets/app.3f9a1c.js
curl -s -H 'Host: mysite.example.com' -H 'Accept-Encoding: gzip' -o /dev/null \
     -w 'gzip:  %{size_download} bytes\n' http://127.0.0.1/assets/app.3f9a1c.js

# HTML: must be no-cache
curl -s -I -H 'Host: mysite.example.com' http://127.0.0.1/ | grep -i cache-control
# Cache-Control: no-cache

# Image with expires
curl -s -I -H 'Host: mysite.example.com' http://127.0.0.1/logo.png | grep -iE 'expires|cache-control'
# Expires: <date 30 days from now>
# Cache-Control: max-age=2592000
```

Replace `app.3f9a1c.js` / `logo.png` with real files from your build. In Chrome DevTools → Network, the "Size" column shows `(disk cache)` / `(memory cache)` for cached assets.

## ⚠️ Common mistakes

- Listing `text/html` in `gzip_types` → harmless but triggers a `duplicate MIME type "text/html"` warning; it is always compressed.
- Compressing images/videos/WOFF2 → no size gain, only CPU cost.
- `gzip_comp_level 9` everywhere → much more CPU for a small extra saving.
- Forgetting `gzip_proxied` when a CDN/proxy sends requests with a `Via` header → Nginx skips compression for them (default is `off`).
- Long-caching files that **don't** have a hash in the name → users stuck with old CSS after a deploy.
- Using both `expires 1y;` and `add_header Cache-Control "..."` in one block → two `Cache-Control` headers.
- The `add_header` inheritance trap → security headers (HSTS, CSP) silently missing in some locations.
- Testing with `curl` without `-H 'Accept-Encoding: gzip'` and concluding gzip "doesn't work".

## 🔁 Follow-up questions interviewers ask

- **What does `gzip_vary on` do and why does it matter?** Adds `Vary: Accept-Encoding`, so CDNs/proxies cache compressed and uncompressed copies separately and never send gzip to a client that can't handle it.
- **`no-cache` vs `no-store`?** `no-cache` = may store but must revalidate (fast 304s); `no-store` = never store at all (use for sensitive pages).
- **`expires` vs `add_header Cache-Control`?** `expires` sets both `Expires` and `Cache-Control: max-age` from one value; `add_header` gives full control (e.g. `immutable`, `public`, `private`).
- **gzip vs brotli?** Brotli usually gives smaller text files at similar speed, but it needs a third-party module in open-source Nginx; gzip is built in and universally supported.
- **How do cache-busting filenames work?** Build tools put a content hash in the filename; new code → new name → browsers fetch it, while old names can be cached forever.

---
[⬅️ Previous](08-virtual-hosts-multiple-websites.md) · [🏠 Index](../README.md) · [Next ➡️](10-deploy-mern-app-with-nginx.md)

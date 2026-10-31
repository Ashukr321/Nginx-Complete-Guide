# Q: What is a CDN, and how is it different from caching in Nginx? When would you use each?

> **Level:** System Design · **Asked in:** DevOps, SRE, Backend, Frontend/Platform, System Design round

## 🎯 Short answer (say this in the interview)

A **CDN** (Content Delivery Network) is a large set of cache servers, called **edge locations** or PoPs, spread around the world. Users are sent to the nearest edge. If the edge has the file (**cache hit**), it answers right away. If not (**cache miss**), it fetches the file from my **origin server** (here, Nginx), stores it for its **TTL**, and serves it. **Nginx `proxy_cache`** is also a cache, but it runs in **my own data center or region, in front of my app servers**. A CDN cuts **latency and bandwidth for users far away** and absorbs traffic spikes and DDoS at the edge. Nginx caching cuts **load on my backend**. They work together in layers: **browser → CDN → Nginx proxy_cache → app → Redis → DB**. The origin controls them with `Cache-Control` headers. `max-age` is for browsers, `s-maxage` is for shared caches like the CDN. `private`/`no-store` keeps user data out of shared caches. For invalidation I prefer **versioned file names** (`app.3f9a1c.js`) over purging. If all users are in one region and traffic is modest, Nginx caching alone is often enough.

## 🧩 Scenario

An e-commerce site runs in one AWS region (Mumbai). Users in India get pages in about 100 ms, but users in the US and Europe see slow page loads because every image and JS file crosses the world. During a big sale, the product-list API is hit thousands of times per second with the same response. The origin's outbound bandwidth bill is high. The architect asks you: "Do we need a CDN, or is Nginx caching enough? And how do we make sure users never see an old price after a change?"

## 💼 Use case

- **CDN:** static assets (JS, CSS, images, fonts, videos), downloads, public pages for a global audience, edge DDoS/WAF protection, lower origin bandwidth.
- **Nginx `proxy_cache`:** caching slow backend responses close to the app, microcaching dynamic pages for 1–10 s, serving stale content when the app is down, internal APIs that a CDN never sees.
- **Both together:** a global site where the CDN serves assets and public pages, and Nginx protects the app from requests the CDN passes through (misses, expired items, uncacheable routes).

## ⚙️ How it works

**Where it sits in an HLD diagram:** `User → DNS → CDN edge (cache) → [miss] → Nginx origin (proxy_cache) → App → Redis → DB`

**Layered caching: each layer protects the next one**

```text
  User in London                                   Origin region (e.g. Mumbai)
 ┌─────────────┐   ┌───────────────────────┐      ┌──────────────────────────────────────────────┐
 │ Browser     │   │ CDN edge (London PoP) │      │ Nginx (origin)     App        Redis     DB    │
 │ cache       │──►│ cache                 │─────►│ proxy_cache   ──►  Node  ──►  cache ──► SQL   │
 │ max-age     │   │ s-maxage / CDN TTL    │ miss │ proxy_cache_valid  in-memory  objects  truth │
 └─────────────┘   └───────────────────────┘      └──────────────────────────────────────────────┘
   0 network hops     short hop, near user          long hop across the world, only on CDN miss

  Hit at browser  → no request at all
  Hit at CDN      → served from the edge, origin never sees it
  Hit at Nginx    → app never sees it
  Hit at Redis    → DB never sees it
```

**CDN vs Nginx caching**

| | CDN | Nginx `proxy_cache` |
|---|---|---|
| Where it runs | Provider's edge locations worldwide (CloudFront, Cloudflare, Akamai, Fastly…) | Your servers, next to your app |
| Main benefit | Low latency for distant users, less origin bandwidth, edge DDoS absorption | Less load on app/DB, stale-on-error, microcaching |
| What it caches well | Static files, public pages, public API responses | Backend responses (HTML, JSON), including internal traffic |
| Who controls TTL | Origin headers (`Cache-Control`, `s-maxage`) + CDN rules | `proxy_cache_valid` + upstream headers |
| Invalidation | Provider purge API/console (can take a short time to reach all edges) | Delete cache files, third-party purge module, or `proxy_cache_purge` (**Nginx Plus**) |
| Cost model | Pay per GB/request to the provider | Your own disk/RAM/CPU |
| Sees client IP directly | Yes | No. Nginx sees the CDN's IP and must read `X-Forwarded-For` / provider header |

**Cache-Control headers the origin should send**

| Content | Header from Nginx origin | Effect |
|---|---|---|
| Fingerprinted assets (`app.3f9a1c.js`) | `public, max-age=31536000, immutable` | Browser + CDN keep it for a year. A new deploy uses a new file name, so no purge needed. |
| `index.html` / HTML shell | `no-cache` | Caches may store it but must revalidate (`ETag`/`Last-Modified`) each time, so new deploys show up immediately |
| Public API data (product list) | `public, max-age=0, s-maxage=60` | Browser always asks again; **CDN and other shared caches** keep it 60 s |
| User-specific data (cart, account) | `private, no-store` | Never stored by CDN or proxies |

`s-maxage` applies **only to shared caches** (CDNs, proxies) and overrides `max-age` for them. This lets the CDN absorb traffic while browsers still get fresh data.

**Cache invalidation options (the "hard problem")**

1. **Versioned file names / URLs:** `app.3f9a1c.js` and `logo.png?v=42`. Best option: nothing to purge.
2. **Short TTL:** the data can be at most N seconds old. Simple and predictable.
3. **Purge API:** call the CDN after a deploy or price change. Good for emergencies. It is a separate step that can fail, so don't build your whole design on it.

## 🛠️ Practical: step by step

The Nginx `proxy_cache` setup itself is covered in [Proxy caching](../03-advanced/06-proxy-caching.md). Here we focus on the **origin side**: sending the right headers so a CDN (and browsers) cache the right things for the right time.

1. **Create demo content and a fake API backend** (Ubuntu 22.04/24.04 with Nginx installed)

```bash
sudo mkdir -p /var/www/shop/assets
echo '<h1>Shop</h1><script src="/assets/app.3f9a1c.js"></script>' | sudo tee /var/www/shop/index.html
echo 'console.log("v1");' | sudo tee /var/www/shop/assets/app.3f9a1c.js

# Fake API on 127.0.0.1:3000 (python3 is preinstalled on Ubuntu)
mkdir -p /tmp/api/api/products /tmp/api/api/account
echo '[{"id":1,"price":499}]' > /tmp/api/api/products/index.html
echo '{"user":"asha","cart":3}' > /tmp/api/api/account/index.html
nohup python3 -m http.server 3000 --bind 127.0.0.1 --directory /tmp/api >/dev/null 2>&1 &
```

2. **Configure the origin with per-route caching rules**. File: `/etc/nginx/sites-available/origin.conf`

```nginx
server {
    listen 80;
    server_name origin.example.com;          # the CDN is configured to fetch from this host
    root /var/www/shop;

    # 1) Fingerprinted static assets: the file name changes on every build,
    #    so caching "forever" is safe. No 'always' → 404s are NOT cached for a year.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # 2) HTML shell: may be stored, but must be revalidated every time,
    #    so a new deploy is visible immediately.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri /index.html;          # SPA fallback → ends up in the block above
    }

    # 3) Public API: browsers re-ask every time, the CDN may keep it 60 s.
    location /api/products/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_hide_header Cache-Control;     # don't let the app's header conflict with ours
        add_header Cache-Control "public, max-age=0, s-maxage=60";
    }

    # 4) Per-user data: never stored in any shared cache.
    #    'always' → also on errors, so a 500 with user data is not cached either.
    location /api/account/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "private, no-store" always;
    }
}
```

3. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/origin.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

4. **Put a CDN in front (provider-side steps, no Nginx change)**
   - Create a distribution/zone with **origin = `origin.example.com`** and point `www.example.com` (DNS CNAME) to the CDN.
   - Tell the CDN to **respect origin `Cache-Control` headers** (e.g. a CloudFront cache policy that uses origin headers; on Cloudflare, add a Cache Rule if you want HTML/JSON cached, because by default it caches only common static file extensions).
   - Make sure the cache key **does not include cookies** for public routes, or every user gets a separate copy.
   - Restrict the origin so only the CDN can reach it (provider IP ranges in a firewall/security group), otherwise attackers can bypass the CDN.

5. **Restore the real client IP at the origin.** Behind a CDN, `$remote_addr` is the CDN's IP. Use `set_real_ip_from <CDN ranges>` + `real_ip_header X-Forwarded-For` (or the provider's header, e.g. `CF-Connecting-IP`). See [proxy headers and real client IP](../02-intermediate/06-proxy-headers-real-client-ip.md).

6. **Invalidate after an urgent change** (only when versioned names/TTL are not enough)

```bash
# AWS CloudFront (AWS CLI v2)
aws cloudfront create-invalidation --distribution-id E1ABCDEF2GHIJK --paths "/index.html" "/api/products/*"

# Cloudflare (API token with Cache Purge permission)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"files":["https://www.example.com/index.html"]}'
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/origin.conf` | Origin server: sets `Cache-Control` per route so the CDN and browsers cache correctly |
| `/etc/nginx/sites-enabled/origin.conf` | Symlink that activates it |
| `/var/www/shop/` | Static files: HTML shell + fingerprinted assets |
| `/etc/nginx/conf.d/*.conf` | Where `proxy_cache_path` lives if you also cache at the origin (see 06-proxy-caching) |
| `/var/log/nginx/access.log` | On the origin, a working CDN shows up as **fewer** requests for cached paths |
| CDN console / API | Origin host, cache policy, purge/invalidation |

## ✅ Verify it works

Check the headers the origin sends:

```bash
for p in /assets/app.3f9a1c.js /index.html /api/products/ /api/account/; do
  echo "== $p"; curl -sI -H "Host: origin.example.com" "http://127.0.0.1$p" | grep -i '^cache-control'
done
```

Example output:

```text
== /assets/app.3f9a1c.js
Cache-Control: public, max-age=31536000, immutable
== /index.html
Cache-Control: no-cache
== /api/products/
Cache-Control: public, max-age=0, s-maxage=60
== /api/account/
Cache-Control: private, no-store
```

Once a CDN is in front, request the same URL twice through the CDN hostname and look at the provider's cache header and `Age`:

```bash
curl -sI https://www.example.com/assets/app.3f9a1c.js | grep -iE '^(x-cache|cf-cache-status|age):'
```

Example output (the header name depends on the provider: CloudFront uses `X-Cache`, Cloudflare uses `cf-cache-status`):

```text
x-cache: Hit from cloudfront
age: 112
```

The first request is usually a miss, and later ones are hits. `Age` shows how many seconds the object has been in the cache.

## ⚠️ Common mistakes

- Caching `index.html` for a long time. Users keep loading old JS file names after a deploy. Cache assets long and HTML short/`no-cache`.
- Sending user-specific responses without `private`/`no-store`, so the CDN serves one user's cart to another user. This is a real data-leak risk.
- Forgetting that an `add_header` inside a `location` **replaces all** `add_header` lines from the `server`/`http` level (security headers disappear on that route).
- Including cookies or every query string in the CDN cache key. The hit ratio drops close to zero.
- Leaving the origin open to the internet so attackers bypass the CDN and its WAF/DDoS protection.
- Relying only on purge for correctness. Use versioned URLs or short TTLs, and keep purge for emergencies.
- Rate limiting by `$remote_addr` behind a CDN without the real-IP setup. All users share the CDN's IPs and get blocked together.

## 🔁 Follow-up questions interviewers ask

1. **What's the difference between `max-age` and `s-maxage`?**
   `max-age` applies to every cache, including the browser. `s-maxage` applies only to shared caches (CDN, proxies) and overrides `max-age` there.
2. **Trade-off: long TTL vs short TTL?**
   A long TTL gives a higher hit ratio, less origin load, and lower cost, but data can be stale. A short TTL gives fresher data but more origin traffic. Versioned URLs let you have long TTLs without staleness for assets.
3. **If you have a CDN, do you still need Nginx caching?**
   Often yes. The CDN doesn't see internal traffic, each edge PoP misses separately, and Nginx can serve stale on backend failure. If CDN hit ratios are high and the app is cheap to call, you may skip it.
4. **When is Nginx caching alone enough?**
   When users are mostly in one region near your servers, traffic is moderate, and the goal is to protect the backend rather than reduce global latency.
5. **How does a CDN handle a cache miss storm (thundering herd)?**
   Many CDNs collapse concurrent misses for the same object into one origin request (often called request collapsing or origin shield). At the origin, Nginx's `proxy_cache_lock` does the same.

---
[⬅️ Previous](05-api-gateway-vs-reverse-proxy.md) · [🏠 Index](../README.md) · [Next ➡️](07-consistent-hashing-and-sticky-sessions.md)

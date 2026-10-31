# Q: How do you set up caching of backend responses in Nginx? How do you bypass and purge the cache?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Performance Engineer

## 🎯 Short answer (say this in the interview)

I define a cache on disk with `proxy_cache_path` in the `http` block (folder, `levels`, a `keys_zone` in shared memory for the keys, `max_size`, `inactive`), then enable it in a location with `proxy_cache`, decide how long to keep each status code with `proxy_cache_valid`, and control what makes a unique entry with `proxy_cache_key`. For resilience I add `proxy_cache_use_stale` so users get the old copy if the backend is down, and `proxy_cache_lock` so only one request refreshes a missing entry. I expose `$upstream_cache_status` in an `X-Cache-Status` header to see HIT/MISS. Logged-in users bypass the cache using `proxy_cache_bypass` and `proxy_no_cache` on a session cookie. Purging with `proxy_cache_purge` is an **Nginx Plus** feature; in open source you delete the cache file, use a third-party module, or keep TTLs short (microcaching).

## 🧩 Scenario

A news site's homepage and article pages are rendered by a slow PHP/Node backend (hundreds of milliseconds per page). When a story goes viral, the backend CPU hits 100% and pages time out. Most visitors are anonymous and see the same page. Logged-in editors must always see fresh content. You need to cut backend load dramatically without showing editors stale pages.

## 💼 Use case

- Caching HTML for anonymous users on content sites (news, blogs, e-commerce category pages).
- Caching expensive, read-only API responses (product catalogue, exchange rates).
- **Microcaching**: caching dynamic pages for 1–10 seconds, which absorbs traffic spikes while staying almost real-time.
- Serving stale content when the backend is down (`proxy_cache_use_stale`).

## ⚙️ How it works

```text
 client ──► nginx ──► key = $scheme$request_method$host$request_uri
                         │
                         ├─ found & fresh in cache?  ── yes ──► serve from disk   X-Cache-Status: HIT
                         │
                         └─ no ──► proxy_cache_lock: only 1 request goes to backend,
                                   others wait for it
                                       │
                                       ▼
                                   backend responds 200
                                       │
                                       ├─► save to /var/cache/nginx/app/<l1>/<l2>/<md5(key)>
                                       └─► send to client                  X-Cache-Status: MISS

 backend down + stale copy exists ──► proxy_cache_use_stale ──► serve old copy  X-Cache-Status: STALE
 cookie "session" present        ──► proxy_cache_bypass     ──► go to backend   X-Cache-Status: BYPASS
```

**`proxy_cache_path` parameters**

```nginx
proxy_cache_path /var/cache/nginx/app levels=1:2 keys_zone=app_cache:10m max_size=1g inactive=60m use_temp_path=off;
```

| Parameter | Meaning |
|---|---|
| `/var/cache/nginx/app` | Folder where cached responses are stored as files |
| `levels=1:2` | Two-level sub-folders (e.g. `c/29/`) so one folder doesn't hold millions of files |
| `keys_zone=app_cache:10m` | Shared-memory zone name and size for keys + metadata (docs: ~8,000 keys per 1 MB) |
| `max_size=1g` | Max disk usage; the cache manager deletes least-recently-used files above this |
| `inactive=60m` | Remove items not requested for 60 min, even if still "valid" |
| `use_temp_path=off` | Write files directly into the cache folder (avoids extra copying between folders) |

**`$upstream_cache_status` values**: `MISS`, `HIT`, `EXPIRED`, `STALE`, `UPDATING`, `REVALIDATED`, `BYPASS`.

**What Nginx does NOT cache by default**: responses with `Set-Cookie`, responses with `Cache-Control: private`, `no-cache` or `no-store`, `Expires` in the past, and methods other than `GET`/`HEAD`. Backend headers like `Cache-Control: max-age` also take priority over `proxy_cache_valid`.

## 🛠️ Practical: step by step

1. **Create the cache folder**

```bash
sudo mkdir -p /var/cache/nginx/app
sudo chown -R www-data:www-data /var/cache/nginx
```

2. **Define the cache and bypass rules** — file: `/etc/nginx/conf.d/cache.conf` (http context)

```nginx
# /etc/nginx/conf.d/cache.conf

# Main cache: 10 MB of keys, up to 1 GB on disk
proxy_cache_path /var/cache/nginx/app levels=1:2 keys_zone=app_cache:10m
                 max_size=1g inactive=60m use_temp_path=off;

# Skip cache for logged-in users: $skip_cache = 1 if a "session" cookie exists
map $cookie_session $skip_cache {
    default 1;
    ""      0;
}
```

3. **Use it in the site** — file: `/etc/nginx/sites-available/news.conf`

```nginx
upstream news_backend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name news.example.com;

    location / {
        proxy_pass http://news_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        proxy_cache app_cache;                                  # which zone to use
        proxy_cache_key "$scheme$request_method$host$request_uri"; # what makes an entry unique
        proxy_cache_valid 200 301 302 10m;                      # cache good responses 10 min
        proxy_cache_valid 404 1m;                               # cache "not found" briefly
        proxy_cache_methods GET HEAD;                           # default; never cache POST

        # Logged-in users: don't read from cache, don't write to cache
        proxy_cache_bypass $skip_cache;
        proxy_no_cache     $skip_cache;

        # Backend down or slow? Serve stale content instead of an error
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;   # refresh expired items in the background

        # Only one request per key goes to the backend on a MISS (stops a stampede)
        proxy_cache_lock on;
        proxy_cache_lock_timeout 5s;

        # Debug header: HIT / MISS / BYPASS / STALE / EXPIRED ...
        add_header X-Cache-Status $upstream_cache_status always;
    }

    # Microcaching example: dynamic API cached for just 1 second
    location /api/live/ {
        proxy_pass http://news_backend;
        proxy_set_header Host $host;

        proxy_cache app_cache;
        proxy_cache_key "$scheme$request_method$host$request_uri";
        proxy_cache_valid 200 1s;
        proxy_cache_use_stale updating;
        proxy_cache_lock on;
        add_header X-Cache-Status $upstream_cache_status always;
    }

    # Never cache admin/auth pages
    location /admin/ {
        proxy_pass http://news_backend;
        proxy_set_header Host $host;
        proxy_cache off;
    }
}
```

4. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/news.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

5. **Purging the cache**

| Option | Open source? | How |
|---|---|---|
| `proxy_cache_purge` directive | ❌ Nginx Plus only | Send a `PURGE` request to a configured location |
| `ngx_cache_purge` third-party module | ✅ (Debian/Ubuntu: `sudo apt install libnginx-mod-http-cache-purge`; otherwise compile it) | Adds its own `proxy_cache_purge` directive / purge location in open source |
| Delete the cache file | ✅ | Find the file containing the key and remove it |
| Clear everything | ✅ | Remove all files in the cache folder |
| Short TTLs / microcaching | ✅ | Content expires quickly, no purge needed |

Delete one URL's cache file (each file has a `KEY:` line inside it):

```bash
sudo grep -rl "KEY: httpGETnews.example.com/article/42" /var/cache/nginx/app | sudo xargs -r rm -f
```

Clear the whole cache:

```bash
sudo find /var/cache/nginx/app -type f -delete
```

The cache file name is the MD5 of the key, so you can also compute the exact path:

```bash
echo -n "httpGETnews.example.com/article/42" | md5sum
# example: b7c94a1fbe85d06e5d5a3d4b0f3e1c29  → file /var/cache/nginx/app/9/c2/b7c94a1fbe85d06e5d5a3d4b0f3e1c29
# with levels=1:2 the folders are the LAST char, then the 2 chars before it
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/conf.d/cache.conf` | `proxy_cache_path` and the bypass `map` (http context) |
| `/etc/nginx/sites-available/news.conf` | Enables caching per location |
| `/var/cache/nginx/app/` | Cached responses on disk |
| `/var/log/nginx/access.log` | Add `$upstream_cache_status` to a custom `log_format` to measure hit ratio |

## ✅ Verify it works

```bash
# First request: MISS, second: HIT
curl -s -o /dev/null -D - http://news.example.com/ | grep -i x-cache-status
curl -s -o /dev/null -D - http://news.example.com/ | grep -i x-cache-status
```

Expected:

```text
X-Cache-Status: MISS
X-Cache-Status: HIT
```

```bash
# Logged-in user bypasses the cache
curl -s -o /dev/null -D - -H "Cookie: session=abc123" http://news.example.com/ | grep -i x-cache-status
```

Expected: `X-Cache-Status: BYPASS`

```bash
# Stop the backend and request again: you should get STALE after the entry expires, not 502
sudo ls -R /var/cache/nginx/app | head      # files are being written
```

To track the hit ratio, add a log format in `/etc/nginx/conf.d/cache.conf`:

```nginx
log_format cache '$remote_addr [$time_local] "$request" $status cache=$upstream_cache_status';
```

and in the server block: `access_log /var/log/nginx/news_cache.log cache;`. Then:

```bash
awk '{print $NF}' /var/log/nginx/news_cache.log | sort | uniq -c
```

## ⚠️ Common mistakes

- Backend sends `Set-Cookie` on every response (e.g. a session cookie for anonymous users) → Nginx never caches. Fix the app, or use `proxy_ignore_headers Set-Cookie;` together with `proxy_hide_header Set-Cookie;` carefully.
- Caching pages for logged-in users and leaking one user's data to another. Always bypass on the session cookie.
- Using a cache key without `$host` on a server that serves several domains.
- Forgetting `always` on `add_header`, so the header is missing on error responses — and remember that an `add_header` inside a `location` stops inheriting `add_header` lines from the `server` block.
- Cache folder owned by root → `[crit] ... mkdir() ... failed (13: Permission denied)` in the error log.
- Expecting `proxy_cache_purge` to work on a plain Ubuntu install — it is built into Nginx Plus only; on open source you must first add the third-party `ngx_cache_purge` module (`libnginx-mod-http-cache-purge`).

## 🔁 Follow-up questions interviewers ask

1. **What's the difference between `proxy_cache_bypass` and `proxy_no_cache`?**
   `proxy_cache_bypass` means "don't read from cache for this request"; `proxy_no_cache` means "don't save this response to cache". You usually set both.
2. **What does `inactive` do compared to `proxy_cache_valid`?**
   `proxy_cache_valid` decides when an entry becomes stale; `inactive` deletes entries that nobody requested for that long, fresh or not.
3. **What is microcaching and why is it useful?**
   Caching dynamic content for about 1 second. Under heavy load, thousands of requests per second become roughly one backend request per second per URL.
4. **What does `proxy_cache_lock` prevent?**
   The "thundering herd": many simultaneous MISSes for the same key all hitting the backend at once.
5. **Is the cache shared between multiple Nginx servers?**
   No, each server has its own disk cache. For a shared cache you'd use a CDN or a separate caching layer.

---
[⬅️ Previous](05-websocket-proxy.md) · [🏠 Index](../README.md) · [Next ➡️](07-troubleshooting-502-504-413-403-404.md)

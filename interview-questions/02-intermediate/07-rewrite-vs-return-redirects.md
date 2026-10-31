# Q: What is the difference between `rewrite` and `return` in Nginx? How do you do redirects?

> **Level:** Intermediate · **Asked in:** DevOps, Backend, Full-stack, SEO-heavy web teams

## 🎯 Short answer (say this in the interview)

`return` stops processing immediately and sends a status code (and for redirects, a `Location` URL) — it is simple, fast and easy to read, so I use it for most redirects like HTTP→HTTPS or www→non-www. `rewrite` uses a **regex** to change the URI; it can either change it **internally** (the browser never sees it, using the `last` or `break` flags) or send an **external redirect** (`redirect` = 302, `permanent` = 301). I use `rewrite` only when I need regex captures to transform part of the URL. For status codes: **301** is permanent and cacheable, **302** is temporary, and **307/308** are the same but guarantee the HTTP method and body are kept (important for POST).

## 🧩 Scenario

Your company is rebranding and restructuring the site:

- `http://` must go to `https://`.
- `www.example.com` must go to `example.com` (one canonical domain for SEO).
- Old blog URLs `/blog/2023/my-post` must move to `/articles/my-post`.
- `/old-pricing.html` must go to `/pricing`.
- `/about/` and `/about` must not be two different pages (trailing slash).

Search rankings must not drop, and old links shared on social media must keep working.

![Rewrite and redirect scenario](../../resoruces/scenario_rewrite_redirect.png)

## 💼 Use case

- Domain migrations, rebrands, HTTP→HTTPS, canonical host.
- Moving pages after a CMS/framework change.
- Pretty URLs mapped internally to scripts (`/product/42` → `/product.php?id=42`).
- Temporary maintenance redirects (302/307).
- API versioning (`/v1/users` → internally `/users` on a v1 backend).

## ⚙️ How it works

```text
             return 301 https://example.com$request_uri;
Request  --> [ server/location ] --> STOP --> 301 + Location header --> browser makes NEW request
             (no regex, no further processing)

             rewrite ^/blog/\d+/(.+)$ /articles/$1 permanent;
Request  --> regex match? --yes--> build new URL from captures ($1)
                  |                       |
                  no                 flag decides:
                  |                  +-- permanent -> 301 to browser
             continue                +-- redirect  -> 302 to browser
             processing              +-- last      -> internal: search locations again with new URI
                                     +-- break     -> internal: stay in this location, stop rewrites
```

### `rewrite` flags

| Flag | What happens | Browser sees new URL? |
|---|---|---|
| `last` | Stops rewrite directives here, then **re-searches locations** with the new URI | No (internal) |
| `break` | Stops rewrite directives, **stays in the current location** with the new URI | No (internal) |
| `redirect` | Returns **302** with the new URL | Yes |
| `permanent` | Returns **301** with the new URL | Yes |
| *(none)* | Continues to the next rewrite directive | No |

If the replacement starts with `http://`, `https://` or `$scheme`, Nginx sends a redirect (302 by default) even without a flag.

### Redirect status codes

| Code | Type | Browser caches? | Method on follow-up |
|---|---|---|---|
| **301** Moved Permanently | Permanent | Yes (aggressively) | May change POST → GET |
| **302** Found | Temporary | No (by default) | May change POST → GET |
| **307** Temporary Redirect | Temporary | No (by default) | **Same method + body** |
| **308** Permanent Redirect | Permanent | Yes | **Same method + body** |

### Why prefer `return`?

- No regex evaluation → simpler and cheaper.
- Intent is obvious when reading the config.
- Easy to choose any code: `return 301`, `302`, `307`, `308`, or even `return 410;` (gone) / `return 444;` (close connection).
- `rewrite` only gives you 301/302 for redirects.

## 🛠️ Practical: step by step

1. Create the config.

```bash
sudo nano /etc/nginx/sites-available/example.com
```

```nginx
# File: /etc/nginx/sites-available/example.com

# --- 1. HTTP -> HTTPS (all hosts) ---
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;

    return 301 https://example.com$request_uri;   # one hop, straight to canonical host
}

# --- 2. www -> non-www over HTTPS ---
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;   # cert must cover www too
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    return 301 https://example.com$request_uri;
}

# --- 3. Main site ---
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    root /var/www/example.com;
    index index.html;

    # 3a. Single old page -> new page: exact match + return (fastest, clearest)
    location = /old-pricing.html {
        return 301 /pricing;
    }

    # 3b. Pattern of old URLs -> new structure: needs regex captures, so use rewrite
    #     /blog/2023/my-post  ->  /articles/my-post
    rewrite ^/blog/\d{4}/([^/]+)/?$ /articles/$1 permanent;

    # 3c. Remove trailing slash (except for "/" itself):  /about/ -> /about
    #     Only for paths that are not real directories.
    location ~ ^(.+)/$ {
        if (!-d $request_filename) {
            return 301 $1$is_args$args;
        }
        try_files $uri/ =404;
    }

    # 3d. Internal rewrite (user still sees /product/42)
    #     /product/42 -> /product.html?id=42   (served by the "/" location below)
    location /product/ {
        rewrite ^/product/(\d+)$ /product.html?id=$1 last;
        return 404;
    }

    # 3e. Temporary maintenance redirect that keeps POST bodies intact
    # location /checkout {
    #     return 307 /maintenance;
    # }

    location / {
        try_files $uri $uri.html $uri/ =404;   # /pricing -> pricing.html
    }
}
```

Notes on the config:

- `$request_uri` = original path **plus** query string (`/a?b=1`). Use it in `return` to keep query strings.
- In `rewrite`, the original query string is **appended automatically**. Add a trailing `?` to the replacement to drop it: `rewrite ^/old$ /new? permanent;`.
- `if` with `return` inside a location is one of the safe uses of `if` ("if is evil" applies mainly to other directives inside `if`).

2. Test and reload.

```bash
sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/example.com` | All redirect and rewrite rules |
| `/etc/nginx/sites-enabled/example.com` | Symlink that activates it |
| `/etc/letsencrypt/live/example.com/` | Certificate used by the HTTPS server blocks |
| `/var/log/nginx/error.log` | With `rewrite_log on;` + `error_log ... notice;`, shows each rewrite step |
| `/var/log/nginx/access.log` | Shows 301/302 responses for old URLs |

## ✅ Verify it works

Use `curl -I` (headers only) — it does **not** follow redirects, so you see each hop:

```bash
curl -I http://www.example.com/page?x=1
# HTTP/1.1 301 Moved Permanently
# Location: https://example.com/page?x=1

curl -I https://www.example.com/
# HTTP/2 301   (or HTTP/1.1 301 if HTTP/2 isn't enabled)
# location: https://example.com/

curl -I https://example.com/old-pricing.html
# 301 ... Location: https://example.com/pricing

curl -I https://example.com/blog/2023/my-post
# 301 ... Location: https://example.com/articles/my-post

curl -I https://example.com/about/
# 301 ... Location: https://example.com/about

# Follow the whole chain and count hops (should be 1 hop for each old URL)
curl -sIL -o /dev/null -w 'final=%{url_effective} code=%{http_code} redirects=%{num_redirects}\n' \
     http://www.example.com/blog/2023/my-post
```

Debug rewrites by temporarily adding inside the `server` block:

```nginx
rewrite_log on;
error_log /var/log/nginx/error.log notice;
```

## ⚠️ Common mistakes

- Testing a 301 in a browser, getting it wrong, and the browser **caches the bad redirect**. Test with `curl`, or use 302 until you are sure.
- Redirect chains: `http://www` → `https://www` → `https://` (two hops). Redirect straight to the final URL.
- Using `$uri` instead of `$request_uri` in `return` → query strings are lost.
- Redirect loops: a rule that matches its own target (e.g. adding a trailing slash in one place and removing it in another).
- Using `rewrite ... last` inside a location that the new URI matches again → loop; Nginx stops after 10 cycles and returns 500.
- Using `rewrite` with `permanent` for POST endpoints → clients may switch to GET. Use `return 308`.
- Forgetting that the HTTPS `www` server block needs a certificate that includes `www.example.com`, otherwise the browser shows a cert error before the redirect.

## 🔁 Follow-up questions interviewers ask

- **`last` vs `break`?** `last` restarts location matching with the new URI; `break` keeps processing in the current location. Inside `location`, use `break` when the new URI should be served right there.
- **301 vs 308?** Both are permanent; 308 guarantees the method and body are preserved, so it's safe for POST/PUT APIs.
- **How do you redirect a whole old domain to a new one?** `server { server_name old.com www.old.com; return 301 https://new.com$request_uri; }`.
- **How would you manage hundreds of old→new URLs?** Use a `map $request_uri $new_uri { /old-a /new-a; ... }` in `http` and `if ($new_uri) { return 301 $new_uri; }` in the server — faster and cleaner than hundreds of rewrites.
- **Why is `if` called "evil" in Nginx?** Inside `location`, `if` creates a hidden nested location and many directives behave unexpectedly; only `return` and `rewrite ... last` are considered fully safe inside it.

---
[⬅️ Previous](06-proxy-headers-real-client-ip.md) · [🏠 Index](../README.md) · [Next ➡️](08-virtual-hosts-multiple-websites.md)

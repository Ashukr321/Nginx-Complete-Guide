# Q: What is the difference between `root` and `alias` in Nginx?

> **Level:** Intermediate · **Asked in:** DevOps, Backend, Full-stack, Linux Admin

## 🎯 Short answer (say this in the interview)

Both tell Nginx where files live on disk, but they build the file path differently. With `root`, Nginx **appends the full request URI** to the root path. With `alias`, Nginx **replaces the matched location part** of the URI with the alias path. So `root` is best when the folder structure on disk matches the URL, and `alias` is used when the URL and the disk folder have different names. With `alias`, trailing slashes must match on both the `location` and the `alias`, or you get broken paths or even a path-traversal security hole.

## 🧩 Scenario

Your React build lives in `/var/www/shop/`, but product images are uploaded to `/data/uploads/images/` by the backend. You want the URL `https://shop.example.com/images/shoe.png` to serve `/data/uploads/images/shoe.png`. You try `root /data/uploads/images;` and get a 404, because Nginx looks for `/data/uploads/images/images/shoe.png`. This is exactly where `alias` is needed.

## 💼 Use case

- `root`: the main site folder (`root /var/www/example.com;`) — URL path and disk path line up.
- `alias`: map a URL to a folder with a different name — `/media/` → `/srv/uploads/`, `/docs/` → `/opt/app/build/html/`.
- `alias`: serving Django/Flask `static` files collected into a different folder.
- `alias`: exposing one specific file under a different URL (`location = /robots.txt { alias /srv/seo/robots.txt; }`).

## ⚙️ How it works

```text
Request:  GET /images/shoe.png

ROOT                                         ALIAS
location /images/ {                          location /images/ {
    root /data/uploads;                          alias /data/uploads/images/;
}                                            }

path = root + full URI                       path = alias + (URI minus "/images/")
     = /data/uploads + /images/shoe.png           = /data/uploads/images/ + shoe.png
     = /data/uploads/images/shoe.png              = /data/uploads/images/shoe.png
```

Same result, different math. Now a case where they differ:

```text
Request:  GET /media/cat.jpg     Files on disk:  /srv/uploads/cat.jpg

root /srv/uploads;     -> /srv/uploads/media/cat.jpg   (404, wrong folder)
alias /srv/uploads/;   -> /srv/uploads/cat.jpg         (200, correct)
```

### Path-resolution examples

| location | directive | Request | File Nginx opens |
|---|---|---|---|
| `location /` | `root /var/www/site;` | `/about.html` | `/var/www/site/about.html` |
| `location /img/` | `root /var/www/site;` | `/img/a.png` | `/var/www/site/img/a.png` |
| `location /img/` | `alias /data/pics/;` | `/img/a.png` | `/data/pics/a.png` |
| `location /img/` | `alias /data/pics;` *(no slash)* | `/img/a.png` | `/data/picsa.png` ❌ |
| `location /img` *(no slash)* | `alias /data/pics/;` | `/img../etc/passwd` | `/data/pics/../etc/passwd` ⚠️ traversal |
| `location = /robots.txt` | `alias /srv/seo/robots.txt;` | `/robots.txt` | `/srv/seo/robots.txt` |

### The trailing-slash gotcha

Rule of thumb: **if the `location` ends with `/`, the `alias` must end with `/` too** (and vice versa).

- `location /img/` + `alias /data/pics` → `/data/picsa.png` (missing slash glues names together).
- `location /img` + `alias /data/pics/` → `/img../secret` becomes `/data/pics/../secret`. This is the well-known **"off-by-slash" path traversal** bug — an attacker can read files *outside* the intended folder.

### `alias` inside a regex location

With a regex location, Nginx cannot know which part of the URI to "cut off". So you must **capture** the part you need and use it in `alias`:

```nginx
# /thumbs/abc.jpg -> /data/thumbnails/abc.jpg
location ~ ^/thumbs/(.+\.(?:jpg|png|webp))$ {
    alias /data/thumbnails/$1;
}
```

If you write `alias /data/thumbnails/;` without `$1` in a regex location, every request maps to the folder itself, not the file.

### Other differences

| | `root` | `alias` |
|---|---|---|
| Allowed contexts | `http`, `server`, `location`, `if in location` | `location` only |
| Path built from | root + full URI | alias + URI after the location prefix |
| Typical use | Main document root | URL name ≠ folder name |
| Can be inherited | Yes (set once in `server`) | No (location only) |

## 🛠️ Practical: step by step

1. Create test folders and files.

```bash
sudo mkdir -p /var/www/rootdemo/images /data/uploads/pics
echo "home page"            | sudo tee /var/www/rootdemo/index.html
echo "image via ROOT"       | sudo tee /var/www/rootdemo/images/root.txt
echo "image via ALIAS"      | sudo tee /data/uploads/pics/alias.txt
echo "secret, keep out"     | sudo tee /data/uploads/secret.txt
```

2. Create the site config.

```bash
sudo nano /etc/nginx/sites-available/rootdemo
```

```nginx
# File: /etc/nginx/sites-available/rootdemo
server {
    listen 80;
    server_name rootdemo.local;

    # root set at server level: inherited by every location below
    root /var/www/rootdemo;
    index index.html;

    # /images/root.txt -> /var/www/rootdemo/images/root.txt
    location /images/ {
        # uses the inherited root; nothing else needed
    }

    # /media/alias.txt -> /data/uploads/pics/alias.txt
    # Note: BOTH the location and alias end with "/"
    location /media/ {
        alias /data/uploads/pics/;
    }

    # Regex + alias: capture the filename and use it
    # /thumb/alias.txt -> /data/uploads/pics/alias.txt
    location ~ ^/thumb/([a-z0-9._-]+)$ {
        alias /data/uploads/pics/$1;
    }
}
```

3. Enable and reload.

```bash
sudo ln -s /etc/nginx/sites-available/rootdemo /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/rootdemo` | Server block with `root` and `alias` examples |
| `/etc/nginx/sites-enabled/rootdemo` | Symlink that activates it |
| `/var/www/rootdemo/` | Document root used by `root` |
| `/data/uploads/pics/` | Folder exposed under `/media/` using `alias` |
| `/var/log/nginx/error.log` | Shows the exact path Nginx tried: `open() "/path/..." failed (2: No such file or directory)` |

## ✅ Verify it works

```bash
curl -s -H 'Host: rootdemo.local' http://127.0.0.1/images/root.txt
# image via ROOT

curl -s -H 'Host: rootdemo.local' http://127.0.0.1/media/alias.txt
# image via ALIAS

curl -s -H 'Host: rootdemo.local' http://127.0.0.1/thumb/alias.txt
# image via ALIAS

# Traversal attempt must NOT return the secret (expect 404 or 400)
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is \
     -H 'Host: rootdemo.local' 'http://127.0.0.1/media../secret.txt'
# 404
```

When you get a 404, check the error log — it prints the exact file path Nginx built:

```bash
sudo tail -n 5 /var/log/nginx/error.log
```

## ⚠️ Common mistakes

- Using `root` when the URL name differs from the folder name → Nginx looks in `root + /url-prefix/` and returns 404.
- Mismatched trailing slashes with `alias` → glued paths (`/data/picsa.png`) or a path-traversal hole.
- Using `alias` in a regex location without a capture variable (`$1`).
- Putting `alias` in the `server` block — it is only valid inside `location`.
- Using `root` inside every location instead of setting it once at `server` level.
- Combining `alias` with `try_files` carelessly — the combination has long-standing quirks; test it, or prefer `root` where possible.
- Forgetting file permissions: Nginx runs workers as `www-data` on Ubuntu, which needs read on files and execute (`x`) on every parent folder.

## 🔁 Follow-up questions interviewers ask

- **Which one would you use for the main website folder?** `root`, set once at the `server` level so all locations inherit it.
- **Why is `location /img` + `alias /data/img/` dangerous?** A request like `/img../secret` maps to `/data/img/../secret`, letting attackers read outside the folder (off-by-slash traversal).
- **Can `alias` point to a single file?** Yes, e.g. `location = /favicon.ico { alias /srv/brand/favicon.ico; }`.
- **How do you debug which file path Nginx tried?** Look at `/var/log/nginx/error.log`; failed `open()` lines show the full path.
- **If both could work, which is preferred?** `root` — it is simpler and has fewer edge cases. The Nginx docs suggest `root` when the location matches the last part of the alias path.

---
[⬅️ Previous](01-location-matching-order.md) · [🏠 Index](../README.md) · [Next ➡️](03-load-balancing-methods.md)

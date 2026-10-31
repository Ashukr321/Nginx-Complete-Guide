# Q: How does Nginx `location` matching work? In what order are `=`, `^~`, `~`, `~*` and prefix matches evaluated?

> **Level:** Intermediate · **Asked in:** DevOps, SRE, Backend, Full-stack

## 🎯 Short answer (say this in the interview)

Nginx first checks **exact matches** (`location = /path`) — if one matches, it stops right there. Then it finds the **longest matching prefix** location; if that longest prefix is marked `^~`, it stops and uses it. Otherwise it checks the **regex locations** (`~` case-sensitive, `~*` case-insensitive) **in the order they appear in the config**, and the first regex that matches wins. If no regex matches, it falls back to the longest prefix it remembered earlier. Named locations (`@name`) are never matched by a URL — they are only used for internal redirects like `try_files` and `error_page`.

## 🧩 Scenario

Your site has a homepage, a `/static/` folder of images, an `/api/` backend, and a rule that caches every `.jpg/.png/.css/.js` file. A user reports that images inside `/static/` are not getting your special `/static/` headers — instead they get the "cache images" rule. You need to understand *why* the regex location beat your prefix location, and fix it.

## 💼 Use case

- Routing `/api/` to a backend and everything else to static files.
- Giving the homepage (`= /`) or a health check (`= /health`) a fast, exact rule.
- Applying cache headers to file extensions with regex (`~* \.(css|js)$`).
- Protecting a folder from regex rules with `^~` (e.g., `/uploads/` should never run through a PHP regex).
- Fallback handling with named locations (`@backend`, `@fallback`).

## ⚙️ How it works

The five kinds of `location`:

| Modifier | Example | Meaning |
|---|---|---|
| `=` | `location = /login` | Exact match only. Highest priority. |
| `^~` | `location ^~ /static/` | Prefix match; if it is the **longest** prefix, **skip regex checks**. |
| `~` | `location ~ \.php$` | Regex, **case-sensitive**. |
| `~*` | `location ~* \.(jpg\|png)$` | Regex, **case-insensitive**. |
| *(none)* | `location /api/` | Plain prefix match. |
| `@` | `location @fallback` | Named location. Not used for normal URL matching. |

The decision flow:

```text
                Request URI (normalized, no query string)
                               |
                               v
              +-----------------------------------+
   yes        | 1. Any  location = <uri>  match?  |
  <-----------+-----------------------------------+
  USE IT                       | no
                               v
              +-----------------------------------+
              | 2. Find the LONGEST matching      |
              |    prefix (plain or ^~).          |
              |    Remember it.                   |
              +-----------------------------------+
                               |
                               v
              +-----------------------------------+
   yes        | 3. Is that longest prefix ^~ ?    |
  <-----------+-----------------------------------+
  USE IT                       | no
                               v
              +-----------------------------------+
   first      | 4. Check regex (~ and ~*) in the  |
   match      |    ORDER THEY APPEAR in config.   |
  <-----------+-----------------------------------+
  USE IT                       | none matched
                               v
              +-----------------------------------+
              | 5. Use the remembered longest     |
              |    prefix from step 2.            |
              +-----------------------------------+
```

Key points:

- For prefix locations, **order in the file does not matter** — longest wins.
- For regex locations, **order in the file matters** — first match wins.
- Matching uses the URI **without** the query string (`?id=5` is ignored).
- If nothing matches at all and there is no `location /`, Nginx uses the `server` level settings (usually resulting in a 404).

## 🛠️ Practical: step by step

1. Create a test site config.

```bash
sudo nano /etc/nginx/sites-available/location-demo
```

2. Paste this config. Each location returns a text label so you can *see* which block won.

```nginx
# File: /etc/nginx/sites-available/location-demo
server {
    listen 80;
    server_name location-demo.local;

    default_type text/plain;

    # 1) Exact match: only "/" exactly (not "/about")
    location = / {
        return 200 "A: exact = /\n";
    }

    # 2) Plain prefix: matches anything starting with /
    #    This is the "catch-all" block.
    location / {
        return 200 "B: prefix /\n";
    }

    # 3) Plain prefix for the API
    location /api/ {
        return 200 "C: prefix /api/\n";
    }

    # 4) ^~ prefix: if this is the longest prefix, regex is skipped
    location ^~ /static/ {
        return 200 "D: ^~ /static/\n";
    }

    # 5) Case-sensitive regex: .php files
    location ~ \.php$ {
        return 200 "E: regex ~ \\.php$\n";
    }

    # 6) Case-insensitive regex: image/css/js files
    location ~* \.(jpg|jpeg|png|css|js)$ {
        return 200 "F: regex ~* images/css/js\n";
    }

    # 7) Exact match for a health check
    location = /health {
        access_log off;
        return 200 "G: exact = /health\n";
    }

    # 8) Named location: only reachable via internal redirect
    location /app/ {
        # Try the file; if missing, jump to @fallback
        root /var/www/location-demo;
        try_files $uri @fallback;
    }

    location @fallback {
        return 200 "H: named @fallback\n";
    }
}
```

3. Enable it, test, reload.

```bash
sudo ln -s /etc/nginx/sites-available/location-demo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

4. Send requests with the right `Host` header (no DNS needed).

```bash
for p in / /about /api/users /api/logo.png /static/logo.png /static/a.php \
         /images/LOGO.PNG /index.php /INDEX.PHP /health /health/ /app/missing; do
  printf '%-20s -> ' "$p"
  curl -s -H 'Host: location-demo.local' "http://127.0.0.1$p"
done
```

### Worked table: which block wins?

| URL | Matching candidates | Winner | Why |
|---|---|---|---|
| `/` | `= /`, `/` | **A** | Exact match wins immediately. |
| `/about` | `/` | **B** | Only prefix that matches; no regex matches. |
| `/api/users` | `/`, `/api/` | **C** | Longest prefix `/api/`; no regex matches. |
| `/api/logo.png` | `/`, `/api/`, regex F | **F** | Longest prefix `/api/` is *not* `^~`, so regex is checked and F matches. |
| `/static/logo.png` | `/`, `^~ /static/`, regex F | **D** | Longest prefix is `^~` → regex is skipped. |
| `/static/a.php` | `/`, `^~ /static/`, regex E | **D** | Same reason — `^~` blocks regex. |
| `/images/LOGO.PNG` | `/`, regex F | **F** | `~*` is case-insensitive. |
| `/index.php` | `/`, regex E | **E** | First matching regex in config order. |
| `/INDEX.PHP` | `/` | **B** | `~` is case-sensitive, so E fails; F does not match `.php`. Falls back to prefix. |
| `/health` | `= /health`, `/` | **G** | Exact match. |
| `/health/` | `/` | **B** | `= /health` does not match `/health/` — exact means exact. |
| `/app/missing` | `/`, `/app/` | **H** | `/app/` wins, file not found, `try_files` jumps to `@fallback`. |

### Named locations (`@name`)

- Defined with `location @name { ... }`.
- Cannot be matched by a client URL; only reached by **internal redirects**: `try_files ... @name`, `error_page 404 = @name`, etc.
- Cannot be nested inside other locations and cannot contain nested locations.
- Common real use:

```nginx
location / {
    try_files $uri $uri/ @backend;   # serve static file if it exists, else ask the app
}

location @backend {
    proxy_pass http://127.0.0.1:3000;
}
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/location-demo` | The server block with all the test `location` blocks |
| `/etc/nginx/sites-enabled/location-demo` | Symlink that makes Nginx load the config |
| `/etc/nginx/nginx.conf` | Main config; its `http {}` block includes `sites-enabled/*` |
| `/var/log/nginx/error.log` | Shows config errors and "open() failed" messages for missing files |

## ✅ Verify it works

```bash
sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

sudo systemctl reload nginx

curl -s -H 'Host: location-demo.local' http://127.0.0.1/static/logo.png
# D: ^~ /static/

curl -s -H 'Host: location-demo.local' http://127.0.0.1/api/logo.png
# F: regex ~* images/css/js
```

To see Nginx's decision in detail, temporarily set `error_log /var/log/nginx/error.log debug;` (needs a binary built `--with-debug`; check with `nginx -V 2>&1 | grep -o with-debug`) and look for `test location:` lines.

## ⚠️ Common mistakes

- Thinking prefix locations are matched in file order — they are not; **longest prefix wins**.
- Forgetting that a **regex beats a plain prefix** even if the prefix is longer. Use `^~` when a folder must not be touched by regex rules.
- Putting a broad regex (like `~ \.php$`) *above* a more specific regex — the first regex in the file wins.
- Expecting `location = /health` to match `/health/` or `/health?x=1` — the slash breaks it; the query string is ignored, so `?x=1` *does* still match.
- Writing `location ~ \.PHP$` and wondering why `.php` is not matched — `~` is case-sensitive.
- Trying to request `@fallback` from a browser — named locations are internal only.

## 🔁 Follow-up questions interviewers ask

- **Does the order of prefix locations in the file matter?** No. Nginx always picks the longest matching prefix. Only regex locations depend on order.
- **When would you use `^~`?** When a path (like `/static/` or `/uploads/`) must be handled by its prefix block and never "stolen" by a regex location, e.g. a PHP regex.
- **Is the query string part of location matching?** No. Matching uses the normalized URI path only. Use `$arg_name` or `$args` if you need the query.
- **Can locations be nested?** Yes, prefix and regex locations can be nested (e.g. a regex inside `location /images/`), but `=` exact locations and named `@` locations cannot contain nested locations.
- **What is `location = /` good for?** The homepage is requested very often; an exact match stops the search immediately, which is a tiny but free optimization.

---
[⬅️ Previous](../01-basic-fresher/12-what-is-load-balancing-basics.md) · [🏠 Index](../README.md) · [Next ➡️](02-root-vs-alias.md)

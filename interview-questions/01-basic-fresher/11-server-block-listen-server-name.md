# Q: What is a server block? How do `listen` and `server_name` work, and how does Nginx choose which server handles a request?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Backend, Hosting/Support

## 🎯 Short answer (say this in the interview)

A **server block** (`server { }` inside `http`) is a virtual host - one website or app. **`listen`** says which IP and port the block accepts connections on (e.g. `listen 80;`, `listen 443 ssl;`, `listen [::]:80;` for IPv6). **`server_name`** lists the domain names it answers. For each request Nginx first keeps only the server blocks whose `listen` matches the IP:port the connection came in on, then compares the HTTP **Host** header with `server_name`: exact name first, then the longest wildcard starting with `*`, then the longest wildcard ending with `*`, then the first matching regex. If nothing matches, the **`default_server`** for that port handles it - or, if none is marked, the **first** server block defined for that port.

## 🧩 Scenario

One Ubuntu server hosts `shop.example.com`, `blog.example.com` and an API. Someone points a random domain at your IP, and visitors of that random domain see your shop - not good. Another day, after adding a new site, `curl http://<server-ip>` shows the blog instead of the welcome page. Both problems come from how Nginx picks a server block, and both are fixed with a proper `default_server`.

## 💼 Use case

- Name-based virtual hosting: many domains on one IP and port.
- Redirecting `www` → non-`www` and HTTP → HTTPS with small extra server blocks.
- A catch-all default server that rejects unknown hosts or direct-IP access.
- Subdomain wildcards (`*.example.com`) for multi-tenant apps.
- Separate blocks per port (e.g. a public site on 80 and an internal status page on 8080).

## ⚙️ How it works

### Selection algorithm

```text
                    Client connects to 203.0.113.10:80
                    sends "Host: blog.example.com"
                                 |
 STEP 1: match listen  ----------+   keep only server blocks listening on
                                 |   203.0.113.10:80 / *:80
                                 v
 STEP 2: match server_name against the Host header, in this order:
         a) exact name                    blog.example.com
         b) longest wildcard with * first *.example.com
         c) longest wildcard with * last  blog.example.*
         d) first regex that matches      ~^blog\d*\.example\.com$  (config order)
                                 |
                       matched? -+- yes -> that server block
                                 |
                                 no
                                 v
 STEP 3: default server for that IP:port
         -> the block with "listen 80 default_server;"
         -> if none: the FIRST server block for that port
            (with sites-enabled/*, files are read in alphabetical order)
```

Important: `server_name` is only compared **inside** the group selected by `listen`. A server with the perfect `server_name` but a different port is never considered.

### `server_name` forms

| Form | Example | Matches |
|---|---|---|
| Exact | `server_name example.com www.example.com;` | Only those names |
| Leading wildcard | `server_name *.example.com;` | `a.example.com`, `a.b.example.com` (not `example.com`) |
| Trailing wildcard | `server_name www.example.*;` | `www.example.org`, `www.example.co.uk` |
| Special dot form | `server_name .example.com;` | `example.com` **and** `*.example.com` |
| Regex (starts with `~`) | `server_name ~^(?<user>.+)\.example\.net$;` | Any match; captures usable as `$user` |
| Empty | `server_name "";` | Requests with **no** Host header |
| `_` | `server_name _;` | Nothing special - an invalid name that never matches; used with `default_server` for catch-alls |

### `listen` forms

| Directive | Meaning |
|---|---|
| `listen 80;` | All IPv4 addresses (`0.0.0.0:80`) |
| `listen [::]:80;` | All IPv6 addresses; on Linux it is IPv6-only by default, so add **both** lines for dual stack |
| `listen 127.0.0.1:8080;` | Only localhost, port 8080 |
| `listen 80 default_server;` | This block is the fallback for port 80 (only one per IP:port) |
| `listen 443 ssl;` | HTTPS - needs `ssl_certificate` and `ssl_certificate_key` |
| `listen 443 ssl http2;` | Older syntax for HTTP/2; newer versions (1.25.1+) use a separate `http2 on;` directive |

If a server block has no `listen` at all, it listens on `*:80` (when Nginx runs as root).

## 🛠️ Practical: step by step

### 1. Create content for two sites

```bash
sudo mkdir -p /var/www/shop /var/www/blog
echo 'SHOP' | sudo tee /var/www/shop/index.html
echo 'BLOG' | sudo tee /var/www/blog/index.html
```

### 2. Create the server blocks

`/etc/nginx/sites-available/shop`:

```nginx
# /etc/nginx/sites-available/shop
server {
    listen 80;
    listen [::]:80;
    server_name shop.example.com;          # exact match
    root /var/www/shop;
    index index.html;
}

# redirect www.shop.example.com -> shop.example.com
server {
    listen 80;
    listen [::]:80;
    server_name www.shop.example.com;
    return 301 http://shop.example.com$request_uri;
}
```

`/etc/nginx/sites-available/blog`:

```nginx
# /etc/nginx/sites-available/blog
server {
    listen 80;
    listen [::]:80;
    server_name .blog.example.com;         # blog.example.com and any *.blog.example.com
    root /var/www/blog;
    index index.html;
}
```

### 3. Create an explicit catch-all default server

`/etc/nginx/sites-available/00-default`:

```nginx
# /etc/nginx/sites-available/00-default
# Handles every request whose Host matches no other server_name on port 80
# (unknown domains, direct IP access, scanners).
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;                         # "no name"; default_server makes it the catch-all

    return 444;                            # nginx-specific: close the connection, no response
}
```

### 4. Enable and reload

```bash
# Ubuntu's own "default" site also uses default_server on port 80 -> disable it,
# otherwise nginx -t fails with "a duplicate default server for 0.0.0.0:80"
sudo rm -f /etc/nginx/sites-enabled/default

sudo ln -s /etc/nginx/sites-available/00-default /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/shop       /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/blog       /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/00-default` | Catch-all server with `default_server` |
| `/etc/nginx/sites-available/shop`, `blog` | Name-based virtual hosts |
| `/etc/nginx/sites-enabled/*` | Symlinks; alphabetical order decides the "first server" if no default is set |
| `/etc/nginx/sites-enabled/default` | Ubuntu's default site - also a `default_server`, so disabled here |
| `/etc/nginx/nginx.conf` | `include /etc/nginx/sites-enabled/*;` inside `http` |
| `/var/www/shop`, `/var/www/blog` | Document roots |

## ✅ Verify it works

```bash
sudo nginx -t

curl -s -H "Host: shop.example.com" http://127.0.0.1/
# SHOP
curl -s -H "Host: blog.example.com" http://127.0.0.1/
# BLOG
curl -s -H "Host: dev.blog.example.com" http://127.0.0.1/
# BLOG        (matched by .blog.example.com)
curl -sI -H "Host: www.shop.example.com" http://127.0.0.1/
# HTTP/1.1 301 Moved Permanently
# Location: http://shop.example.com/
curl -s -H "Host: random.com" http://127.0.0.1/
# curl: (52) Empty reply from server      <- 444 from the catch-all
curl -s -g http://[::1]/ -H "Host: shop.example.com"   # -g: treat [ ] literally
# SHOP        (IPv6 works because of listen [::]:80)

# see all server_names and listens Nginx actually loaded
sudo nginx -T | grep -E '^\s*(listen|server_name)'
```

## ⚠️ Common mistakes

- Believing `server_name _;` alone makes a catch-all. It does not - **`default_server`** does. Without it, the first server block for that port wins.
- Two `default_server` on the same IP:port → `nginx: [emerg] a duplicate default server for 0.0.0.0:80`.
- Two blocks with the same `server_name` and port → warning `conflicting server name "..." on 0.0.0.0:80, ignored` - only the first is used.
- Only `listen 80;` and no `listen [::]:80;` → IPv6 visitors cannot connect.
- Testing with `curl http://<ip>` and expecting a named site - with an IP the Host header is the IP, so the default server answers. Use `-H "Host: ..."`.
- Very long or many server names → `could not build server_names_hash, you should increase server_names_hash_bucket_size` - uncomment `server_names_hash_bucket_size 64;` in `nginx.conf`.

## 🔁 Follow-up questions interviewers ask

- **What happens if no server_name matches and there is no `default_server`?** The first server block defined for that IP:port handles the request.
- **What does `return 444` do?** It is an Nginx-specific code that closes the connection without sending a response - good for dropping unknown hosts.
- **How do HTTPS requests pick a server before the Host header is decrypted?** Through **SNI** (Server Name Indication) in the TLS handshake; Nginx uses it to choose the certificate and server block.
- **Can `listen` with a specific IP change the result?** Yes. Blocks listening on `192.0.2.1:80` and `*:80` are different groups; a connection to `192.0.2.1:80` only checks the blocks for that exact address.
- **How do you redirect HTTP to HTTPS?** A port-80 server block with `return 301 https://$host$request_uri;`.

---
[⬅️ Previous](10-serve-static-website.md) · [🏠 Index](../README.md) · [Next ➡️](12-what-is-load-balancing-basics.md)

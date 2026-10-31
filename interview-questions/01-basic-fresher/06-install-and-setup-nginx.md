# Q: How do you install and set up Nginx?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Linux Admin, Cloud, Full-stack

## 🎯 Short answer (say this in the interview)

On Ubuntu/Debian I run `sudo apt update && sudo apt install nginx`; on RHEL/Rocky/Amazon Linux it is `sudo dnf install nginx`. If I need the latest version I add the **official nginx.org repository** and choose **stable** or **mainline**. After installing, I enable and start it with `sudo systemctl enable --now nginx`, open ports 80/443 in the firewall (`ufw allow 'Nginx Full'` or firewalld), check `nginx -v`, and open the server IP in a browser to see the welcome page. For containers I use the official image, e.g. `docker run -p 8080:80 nginx`.

## 🧩 Scenario

You get a fresh Ubuntu 24.04 EC2 instance and a ticket: "Install Nginx, make sure it starts on boot, is reachable on port 80, and shows our own landing page instead of the default welcome page." You also need to tell a teammate how to run the same thing locally on their Mac and in Docker.

## 💼 Use case

- Fresh VM provisioning (often automated with Ansible, cloud-init, or Terraform `user_data`).
- Docker images for static frontends (`FROM nginx`).
- Local development on macOS/Windows to test configs.
- Choosing distro package (stable, older, patched by the distro, has `sites-available`) vs nginx.org package (newer versions, `conf.d` layout).

## ⚙️ How it works

```text
              Where does the package come from?

  +----------------------+    +---------------------------+    +------------------+
  | Distro repo          |    | nginx.org official repo   |    | Docker Hub       |
  | apt / dnf "nginx"    |    | stable  (even minor, e.g. |    | image "nginx"    |
  | version chosen by    |    |          1.<even>.x)      |    | (built from the  |
  | the distro, security |    | mainline (odd minor,      |    |  nginx.org pkg)  |
  | patches backported   |    |          newest features) |    |                  |
  +----------+-----------+    +-------------+-------------+    +--------+---------+
             |                              |                           |
             +---------------+--------------+                           |
                             v                                          v
            /usr/sbin/nginx + /etc/nginx + systemd unit         container on port 80
                             |
       systemctl enable --now nginx  ->  firewall 80/443  ->  curl http://server-ip
```

**Stable vs mainline (nginx.org):** *mainline* is the active development branch (odd minor number) and gets new features and all fixes. *stable* (even minor number) only receives important bug/security fixes. nginx.org itself recommends mainline for most users; many companies still pick stable for fewer changes.

## 🛠️ Practical: step by step

### 1. Ubuntu / Debian (distro package - the default choice)

```bash
sudo apt update
sudo apt install -y nginx
# apt starts nginx and enables it on boot automatically on Ubuntu/Debian
```

### 2. Ubuntu / Debian from the official nginx.org repo (newer version)

```bash
# prerequisites (on Debian use debian-archive-keyring instead of ubuntu-keyring)
sudo apt install -y curl gnupg2 ca-certificates lsb-release ubuntu-keyring

# import the nginx signing key
curl -fsSL https://nginx.org/keys/nginx_signing.key | gpg --dearmor \
  | sudo tee /usr/share/keyrings/nginx-archive-keyring.gpg >/dev/null

# add the STABLE repo ...
echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/ubuntu $(lsb_release -cs) nginx" \
  | sudo tee /etc/apt/sources.list.d/nginx.list

# ... OR the MAINLINE repo instead (use only one of the two):
# echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/mainline/ubuntu $(lsb_release -cs) nginx" \
#   | sudo tee /etc/apt/sources.list.d/nginx.list

# prefer nginx.org packages over the Ubuntu ones
printf "Package: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n" \
  | sudo tee /etc/apt/preferences.d/99nginx

sudo apt update
sudo apt install -y nginx
```

> The nginx.org package uses `/etc/nginx/conf.d/default.conf` (no `sites-available`/`sites-enabled`), runs workers as user `nginx`, and serves `/usr/share/nginx/html`. It may not start automatically - run step 7.
> If Ubuntu's nginx was installed before, remove it first (`sudo apt remove nginx nginx-common`) to avoid file conflicts.

### 3. RHEL / Rocky / AlmaLinux / Amazon Linux

```bash
# RHEL 8/9, Rocky, Alma, Amazon Linux 2023 - package from the distro (AppStream)
sudo dnf install -y nginx

# Older CentOS 7 (yum) - needs EPEL first
# sudo yum install -y epel-release && sudo yum install -y nginx

# Amazon Linux 2 (old) uses extras
# sudo amazon-linux-extras install nginx1
```

Official nginx.org repo on RHEL-family - create `/etc/yum.repos.d/nginx.repo`:

```ini
# /etc/yum.repos.d/nginx.repo
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/$releasever/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true

[nginx-mainline]
name=nginx mainline repo
baseurl=http://nginx.org/packages/mainline/centos/$releasever/$basearch/
gpgcheck=1
enabled=0
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
```

```bash
sudo dnf install -y nginx
# to switch to mainline:
# sudo dnf config-manager --set-enabled nginx-mainline && sudo dnf install -y nginx
```

> RHEL-family packages do **not** start Nginx automatically. Also, SELinux is on by default: to let Nginx proxy to a backend port run `sudo setsebool -P httpd_can_network_connect 1`.

### 4. Docker (official image)

```bash
# quickest test: host port 8080 -> container port 80
docker run -d --name web -p 8080:80 nginx
curl -I http://localhost:8080

# serve your own files and config (read-only mounts)
mkdir -p ~/site/html
echo '<h1>Hello from Docker Nginx</h1>' > ~/site/html/index.html
cat > ~/site/default.conf <<'EOF'
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

docker rm -f web
docker run -d --name web -p 8080:80 \
  -v ~/site/html:/usr/share/nginx/html:ro \
  -v ~/site/default.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx

docker exec web nginx -t          # test config inside the container
docker exec web nginx -s reload   # reload after editing mounted files
docker logs web                   # access/error logs go to stdout/stderr
```

Or bake it into an image with a `Dockerfile`:

```dockerfile
FROM nginx
COPY default.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/
```

### 5. macOS (Homebrew)

```bash
brew install nginx
brew services start nginx        # start now and at login
curl -I http://localhost:8080    # Homebrew's config listens on 8080 (no sudo needed)
# config: /opt/homebrew/etc/nginx/nginx.conf   (Intel Macs: /usr/local/etc/nginx/)
# docroot: /opt/homebrew/var/www               (Intel Macs: /usr/local/var/www)
nginx -t
brew services stop nginx
```

### 6. Windows (zip) - for learning only

1. Download the zip from `https://nginx.org/en/download.html` and extract it to `C:\nginx`.
2. In Command Prompt:

   ```bat
   cd C:\nginx
   start nginx
   tasklist /fi "imagename eq nginx.exe"
   nginx -s reload
   nginx -s quit
   ```

3. Config is `C:\nginx\conf\nginx.conf`, files in `C:\nginx\html`, logs in `C:\nginx\logs`.

> The nginx.org docs list known limitations for the Windows build (e.g. it uses the `select()` method and has performance/scalability limits). **Do not use it in production** - use Linux, or Docker/WSL2 on Windows.

### 7. Post-install setup (Linux)

```bash
# start now + start on boot
sudo systemctl enable --now nginx
systemctl status nginx --no-pager

# firewall - Ubuntu (ufw). ALWAYS allow SSH before enabling ufw on a remote server!
sudo ufw app list                  # shows: Nginx Full, Nginx HTTP, Nginx HTTPS, OpenSSH
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'        # 80 + 443  ('Nginx HTTP' = 80 only)
sudo ufw enable
sudo ufw status

# firewall - RHEL family (firewalld)
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload

# version info
nginx -v      # version only
nginx -V      # version + compiler + configure arguments (built-in modules, paths)
```

On a cloud VM also open ports 80/443 in the **security group / network firewall** - `ufw` alone is not enough.

### 8. Replace the default page

```bash
# Ubuntu apt package: the default site serves /var/www/html
ls /var/www/html                    # index.nginx-debian.html
echo '<h1>Welcome to MyCompany</h1>' | sudo tee /var/www/html/index.html
# index.html is listed before index.nginx-debian.html in the default site, so it wins

# nginx.org package / RHEL / Docker: the page is /usr/share/nginx/html/index.html
# echo '<h1>Welcome to MyCompany</h1>' | sudo tee /usr/share/nginx/html/index.html
```

The relevant part of Ubuntu's default site, `/etc/nginx/sites-available/default`:

```nginx
# /etc/nginx/sites-available/default  (trimmed)
server {
    listen 80 default_server;          # catch-all for port 80 (IPv4)
    listen [::]:80 default_server;     # and IPv6

    root /var/www/html;                # document root

    # first file that exists is served for "/"
    index index.html index.htm index.nginx-debian.html;

    server_name _;                     # "no real name" - default_server makes it the catch-all

    location / {
        try_files $uri $uri/ =404;
    }
}
```

### 9. Uninstall

```bash
# Ubuntu/Debian
sudo systemctl stop nginx
sudo apt remove nginx              # removes the program, keeps /etc/nginx config
sudo apt purge nginx nginx-common  # also removes config files
sudo apt autoremove --purge        # removes leftover dependencies (e.g. libnginx-mod-*)
# logs and web root are not removed: /var/log/nginx, /var/www/html

# RHEL family
sudo dnf remove nginx              # changed config files may be kept as *.rpmsave

# Docker
docker rm -f web && docker rmi nginx

# macOS
brew services stop nginx && brew uninstall nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/usr/sbin/nginx` | The binary (Linux packages) |
| `/etc/nginx/nginx.conf` | Main config |
| `/etc/nginx/sites-available/default` | Ubuntu's default site (welcome page) |
| `/etc/nginx/conf.d/default.conf` | Default site for nginx.org packages and Docker |
| `/var/www/html/` | Ubuntu web root |
| `/usr/share/nginx/html/` | Web root for nginx.org / RHEL / Docker |
| `/lib/systemd/system/nginx.service` | systemd unit (RHEL: `/usr/lib/systemd/system/nginx.service`) |
| `/etc/apt/sources.list.d/nginx.list`, `/etc/yum.repos.d/nginx.repo` | nginx.org repo definitions |
| `/etc/ufw/applications.d/nginx` | ufw app profiles (`Nginx Full`, etc.) on Ubuntu |

## ✅ Verify it works

```bash
nginx -v
# nginx version: nginx/1.xx.x (Ubuntu)

sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

systemctl is-enabled nginx    # enabled
systemctl is-active nginx     # active

sudo ss -tlnp | grep nginx
# LISTEN 0 511 0.0.0.0:80  ... users:(("nginx",pid=...))
# LISTEN 0 511    [::]:80  ... users:(("nginx",pid=...))

curl -I http://localhost
# HTTP/1.1 200 OK
# Server: nginx/1.xx.x (Ubuntu)
# Content-Type: text/html

curl -s http://localhost | head -n 3   # your new page
```

From your laptop open `http://<server-public-ip>` in a browser.

## ⚠️ Common mistakes

- Running `ufw enable` before `ufw allow OpenSSH` on a remote server - you lock yourself out.
- Opening the OS firewall but forgetting the cloud security group (or the other way round).
- Port 80 already used (Apache installed) - Nginx fails with `bind() to 0.0.0.0:80 failed (98: Address already in use)`. Check with `sudo ss -tlnp | grep :80`.
- Following a tutorial written for the Ubuntu package (`sites-enabled`) on an nginx.org/RHEL/Docker install that only reads `conf.d/*.conf`.
- Forgetting `systemctl enable` on RHEL - Nginx is gone after reboot.
- Using `apt remove` and expecting config to be gone - use `purge`.

## 🔁 Follow-up questions interviewers ask

- **Distro package or nginx.org package?** Distro: simpler, security patches backported, older version. nginx.org: newer features and fixes, slightly different layout.
- **What is the difference between `nginx -v` and `nginx -V`?** `-v` prints the version; `-V` also prints compiler and `configure` arguments, so you can see which modules are built in.
- **How do you check which modules are installed?** `nginx -V 2>&1 | tr ' ' '\n' | grep -- --with` and, on Ubuntu, `ls /etc/nginx/modules-enabled/`.
- **How do you install Nginx automatically on many servers?** Configuration management (Ansible `apt`/`dnf` + `service` modules), cloud-init, or a baked machine image / Docker image.
- **Why does the Docker image log to the terminal?** In the official image `/var/log/nginx/access.log` and `error.log` are symlinks to `/dev/stdout` and `/dev/stderr`, so `docker logs` shows them.

---
[⬅️ Previous](05-apache-vs-nginx.md) · [🏠 Index](../README.md) · [Next ➡️](07-nginx-folder-structure-and-files.md)

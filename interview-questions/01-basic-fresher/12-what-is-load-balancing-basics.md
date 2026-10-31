# Q: What is load balancing and how does Nginx do it?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Cloud, Backend

## 🎯 Short answer (say this in the interview)

Load balancing means spreading incoming requests across **several copies of an application** so no single server is overloaded, and so the app keeps working if one copy fails. In Nginx you define a group of backends in an **`upstream`** block and send traffic to it with **`proxy_pass http://<upstream-name>;`**. The default method is **round robin** (each server in turn); others are `weight`, `least_conn`, `ip_hash` and `hash`. Open-source Nginx does **passive** health checks - if a server fails (`max_fails` within `fail_timeout`) it is skipped for a while; **active** health checks (`health_check`) are an **Nginx Plus** feature.

## 🧩 Scenario

Your Node.js API on one EC2 instance hits 100% CPU at peak hours. Node runs JavaScript on a single main thread, so one process cannot use all CPU cores. You start two copies of the API on ports 3001 and 3002 (later on separate servers) and put Nginx in front to share the traffic. When you deploy, you restart one copy at a time and the users notice nothing.

![Load balancer scenario](../../resoruces/scenario_load_balancer.png)

## 💼 Use case

- Scaling a web app horizontally (more instances instead of a bigger server).
- High availability: one instance can crash or be updated while others serve traffic.
- Using all CPU cores with single-threaded runtimes (Node.js, Python workers).
- Rolling deployments and blue/green switching.
- Spreading load across app servers behind one public IP/domain.

## ⚙️ How it works

```text
                        Clients
                           |
                 http://api.example.com
                           |
                  +--------v---------+
                  |      Nginx       |
                  |  upstream        |
                  |  node_backend    |
                  +---+----------+---+
         request 1,3,5|          |request 2,4,6      (round robin)
                      v          v
            +-------------+  +-------------+
            | Node app A  |  | Node app B  |
            | :3001       |  | :3002       |
            +-------------+  +-------------+

 If app B stops responding: requests to it fail -> Nginx tries the next
 server (proxy_next_upstream) and marks B unavailable for fail_timeout.
```

| Method | Directive (in `upstream`) | How it picks a server | Use when |
|---|---|---|---|
| Round robin | *(default, nothing to write)* | In turn: A, B, A, B... | Servers are similar |
| Weighted | `server ... weight=3;` | Servers with higher weight get more requests | Servers have different sizes |
| Least connections | `least_conn;` | Server with fewest active connections | Requests have very different durations |
| IP hash | `ip_hash;` | Same client IP → same server | Simple "sticky sessions" |
| Generic hash | `hash $request_uri consistent;` | Same key → same server | Cache-friendly routing |
| Random | `random two least_conn;` | Random (optionally best of two) | Many load balancers sharing backends |
| Least time | `least_time` | Fastest response | **Nginx Plus only** |

Useful `server` parameters (open source): `weight=N`, `max_fails=N` (default 1), `fail_timeout=T` (default 10s), `backup` (used only when others are down), `down` (marked offline).

## 🛠️ Practical: step by step

### 1. Start two Node.js app instances

```bash
sudo apt update && sudo apt install -y nodejs nginx
mkdir -p ~/lb-demo && cd ~/lb-demo

cat > app.js <<'EOF'
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  // each instance says who it is, so we can see the balancing
  res.end(`Hello from app on port ${port}\n`);
}).listen(port, '127.0.0.1');
console.log(`listening on ${port}`);
EOF

PORT=3001 node app.js &
PORT=3002 node app.js &

curl -s http://127.0.0.1:3001/   # Hello from app on port 3001
curl -s http://127.0.0.1:3002/   # Hello from app on port 3002
```

(In production you would run them with PM2, systemd or containers so they restart automatically.)

### 2. Create the load balancer config

Create `/etc/nginx/sites-available/lb-demo`:

```nginx
# /etc/nginx/sites-available/lb-demo

# group of backend servers
upstream node_backend {
    # default method = round robin
    server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:3002 max_fails=3 fail_timeout=10s;

    # other options (uncomment one to try):
    # least_conn;                         # pick the server with fewest active connections
    # ip_hash;                            # same client IP -> same server
    # server 127.0.0.1:3003 backup;       # only used if the others are down
}

server {
    listen 80;
    listen [::]:80;
    server_name lb.local;

    location / {
        proxy_pass http://node_backend;   # name of the upstream, not a host

        # pass client details to the apps
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # on these errors, try the next server in the group
        proxy_next_upstream error timeout http_502 http_503;
        proxy_connect_timeout 2s;
    }
}
```

### 3. Enable, test, reload

```bash
sudo ln -s /etc/nginx/sites-available/lb-demo /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Try weights

Change the two `server` lines in `/etc/nginx/sites-available/lb-demo` to:

```nginx
    server 127.0.0.1:3001 weight=3;       # gets ~3 of every 4 requests
    server 127.0.0.1:3002 weight=1;
```

Then `sudo nginx -t && sudo systemctl reload nginx` and run the curl loop again.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/lb-demo` | `upstream` group + server block with `proxy_pass` |
| `/etc/nginx/sites-enabled/lb-demo` | Symlink enabling it |
| `~/lb-demo/app.js` | The demo Node app (two instances on 3001 and 3002) |
| `/var/log/nginx/error.log` | Shows `connect() failed ... while connecting to upstream` when a backend is down |
| `/var/log/nginx/access.log` | Every balanced request |

## ✅ Verify it works

```bash
sudo nginx -t
# ... syntax is ok / test is successful

for i in $(seq 1 6); do curl -s -H "Host: lb.local" http://127.0.0.1/; done
# Hello from app on port 3001
# Hello from app on port 3002
# Hello from app on port 3001
# Hello from app on port 3002
# Hello from app on port 3001
# Hello from app on port 3002

# simulate a failure: stop the app on port 3002
pkill -f "node app.js"; PORT=3001 node app.js &      # restart only 3001
for i in $(seq 1 4); do curl -s -H "Host: lb.local" http://127.0.0.1/; done
# Hello from app on port 3001   (x4) - Nginx skips the dead server, users get no errors

sudo tail -n 3 /var/log/nginx/error.log
# ... connect() failed (111: Connection refused) while connecting to upstream ... 127.0.0.1:3002 ...
```

The exact order of the first round can start with either server - what matters is that requests alternate.

## ⚠️ Common mistakes

- Writing `proxy_pass http://node_backend/;` with an extra slash or a path without understanding it changes how the URI is passed.
- Expecting open-source Nginx to have `health_check` or a live status dashboard - those are **Nginx Plus only**. Open source has passive checks (`max_fails`, `fail_timeout`) and the basic `stub_status` page.
- Storing user sessions in app memory - with round robin the next request may hit another instance and the user is "logged out". Use a shared store (Redis) or `ip_hash` as a quick fix.
- Putting `upstream` inside a `server` block - it must be in `http` context (a file in `sites-enabled/` or `conf.d/` is fine, since they are included in `http`).
- Forgetting the backends must be reachable from Nginx (bound to the right IP, firewall/security groups open between them).

## 🔁 Follow-up questions interviewers ask

- **What is the default load-balancing method?** Weighted round robin (all weights = 1 by default).
- **How do you get sticky sessions in open-source Nginx?** `ip_hash` or `hash $cookie_<name>`; cookie-based `sticky` is Nginx Plus only.
- **What is the difference between passive and active health checks?** Passive: Nginx notices failures on real requests. Active: Nginx sends periodic test requests (`health_check`, Nginx Plus only).
- **What is the `backup` parameter?** The server only receives traffic when all non-backup servers are unavailable.
- **Layer 4 vs Layer 7 load balancing?** L7 (`http` + `upstream`) understands HTTP (paths, headers); L4 (`stream` module) balances raw TCP/UDP connections, e.g. databases.

---
[⬅️ Previous](11-server-block-listen-server-name.md) · [🏠 Index](../README.md) · [Next ➡️](../02-intermediate/01-location-matching-order.md)

# Q: Where does a load balancer sit in a system design, and how does it help you scale horizontally?

> **Level:** System Design · **Asked in:** DevOps, Backend, SRE, Cloud, System Design round

## 🎯 Short answer (say this in the interview)

There are two ways to handle more traffic. **Vertical scaling** means a bigger machine (more CPU/RAM) — simple, but it has a hard upper limit, usually needs downtime, and is still one machine. **Horizontal scaling** means more machines of the same size. A **load balancer** makes horizontal scaling possible: it is the single address clients call, and it spreads requests across many app servers, skips servers that fail health checks, and lets me add or remove servers without clients noticing. For this to work the app servers must be **stateless** — no user sessions or uploaded files kept on local disk or memory. I move sessions to **Redis**, files to object storage like S3, and data to a shared database. In the HLD the request path is: **DNS → CDN → load balancer → app servers → cache → database**. In the cloud, the app servers are in an **autoscaling group** registered behind a managed LB (e.g. AWS ALB), so servers are added and removed automatically based on load.

## 🧩 Scenario

Your startup's API runs on one 4-CPU VM behind Nginx. A marketing campaign is coming and traffic is expected to grow many times over. Upgrading to a bigger VM needs a restart, and if that one VM dies the whole product is down. Your lead asks: *"Design it so we can just add servers. What has to change in the app, and where does the load balancer go?"* When you try putting two app servers behind Nginx, users get logged out randomly — because each server keeps its own sessions in memory.

## 💼 Use case

- Handling growth or traffic spikes by adding servers instead of buying a bigger one.
- Removing a single app server as a single point of failure.
- Rolling deployments: take one server out, update it, put it back.
- Autoscaling: more servers during the day, fewer at night to save cost.

## ⚙️ How it works

**Where it sits in an HLD diagram:** Client → DNS → CDN → **Load balancer** → App servers (stateless, N copies) → Cache (Redis) → Database.

```text
            ┌───────┐   app.example.com → LB address
  User ───► │  DNS  │
            └───┬───┘
                ▼
            ┌───────┐   static files, images served from the edge
            │  CDN  │
            └───┬───┘   dynamic requests continue to origin
                ▼
       ┌─────────────────┐
       │  Load balancer  │  Nginx / HAProxy / AWS ALB
       │  health checks  │
       └──┬─────┬─────┬──┘
          ▼     ▼     ▼
       ┌─────┐┌─────┐┌─────┐     ← stateless app servers (add more = more capacity)
       │app-1││app-2││app-3│ ...
       └──┬──┘└──┬──┘└──┬──┘
          └──────┼──────┘
         ┌───────┴────────┐
         ▼                ▼
   ┌───────────┐   ┌──────────────┐
   │  Redis    │   │  Database    │   ← shared state lives here, not on app servers
   │ sessions, │   │ (primary +   │
   │ cache     │   │  replicas)   │
   └───────────┘   └──────────────┘
```

**Vertical vs horizontal scaling**

| | Vertical (scale up) | Horizontal (scale out) |
|---|---|---|
| How | Bigger machine | More machines |
| Limit | Largest available instance | Much higher; also limited by shared parts like the DB |
| Downtime to scale | Usually a restart | No — add servers behind the LB |
| Failure | One machine = one SPOF | One server dies, others keep serving |
| App changes needed | None | App must be stateless |
| Needs a load balancer | No | Yes |

**Why stateless matters**

```text
  Stateful (broken):                         Stateless (works):
  req 1 → app-1  (session saved in app-1 RAM)   req 1 → app-1 ─┐
  req 2 → app-2  (no session → "please login")  req 2 → app-2 ─┼─► Redis (session)
                                                 req 3 → app-3 ─┘
```

Sticky sessions (`ip_hash`, or Nginx Plus `sticky`) can hide the problem, but users are still logged out when "their" server dies, and load becomes uneven. Moving state out is the real fix.

**What to move out of the app server**

| State | Move it to |
|---|---|
| Login sessions | Redis (or a JWT stored on the client) |
| Uploaded files | Object storage (S3, MinIO) or shared storage |
| Cache | Redis / Memcached |
| Scheduled jobs (cron) | One worker / a job queue, not every app server |
| Data | Shared database |

**Static upstream vs autoscaling:** an Nginx `upstream` lists fixed IPs. When servers appear and disappear automatically, either (a) put a **cloud LB** (AWS ALB + Auto Scaling Group / target group) in front — instances register themselves, or (b) regenerate the Nginx upstream with a tool such as consul-template, or (c) in Kubernetes, let the Service/Ingress track pods. (Re-resolving DNS names inside `upstream` with `server ... resolve` was Nginx Plus-only and arrived in open-source Nginx only in 1.27.3; the Ubuntu 22.04/24.04 packages are older.)

Load balancing methods (round robin, `least_conn`, `ip_hash`, `hash`, weights) are covered in [load balancing methods](../02-intermediate/03-load-balancing-methods.md); failover in [health checks and failover](../03-advanced/10-upstream-health-checks-and-failover.md).

## 🛠️ Practical: step by step

This demo runs on one Ubuntu VM; in real life each backend is a separate server.

1. **Start two app "servers"** that tell you who answered

```bash
for p in 8081 8082; do
  mkdir -p /tmp/app-$p
  echo "served by app-$p" > /tmp/app-$p/index.html
  nohup python3 -m http.server $p --bind 127.0.0.1 --directory /tmp/app-$p >/dev/null 2>&1 &
done
```

2. **Put Nginx in front as the load balancer** — file: `/etc/nginx/sites-available/scale.conf`

```nginx
upstream app_servers {
    least_conn;                                   # send to the server with fewest active connections
    server 127.0.0.1:8081 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:8082 max_fails=3 fail_timeout=10s;
    keepalive 32;                                 # reuse connections to backends
}

server {
    listen 80;
    server_name scale.example.com;

    location / {
        proxy_pass http://app_servers;
        proxy_http_version 1.1;                   # needed for upstream keepalive
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/scale.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

3. **Scale out: add a third server** — start it, add one line, reload (no downtime)

```bash
mkdir -p /tmp/app-8083 && echo "served by app-8083" > /tmp/app-8083/index.html
nohup python3 -m http.server 8083 --bind 127.0.0.1 --directory /tmp/app-8083 >/dev/null 2>&1 &
```

In `/etc/nginx/sites-available/scale.conf`, add inside `upstream app_servers`:

```nginx
    server 127.0.0.1:8083 max_fails=3 fail_timeout=10s;
```

```bash
sudo nginx -t && sudo systemctl reload nginx     # graceful: old workers finish their requests
```

4. **Make the app stateless: shared sessions in Redis**

Install Redis on a separate server (here `10.0.0.30`) that every app server can reach:

```bash
sudo apt install -y redis-server
```

File: `/etc/redis/redis.conf` — listen on the private IP and require a password:

```text
bind 127.0.0.1 10.0.0.30
requirepass Change-This-Strong-Password
```

```bash
sudo systemctl restart redis-server
redis-cli -h 10.0.0.30 -a 'Change-This-Strong-Password' ping     # expect: PONG
```

Then point the app's session store at Redis using your framework's library, for example `connect-redis` (Express), `django-redis` with `SESSION_ENGINE = "django.contrib.sessions.backends.cache"` (Django), Spring Session Data Redis (Spring Boot), or `session.save_handler = redis` with the `php-redis` extension (PHP). Only allow port 6379 from the app servers' subnet in the firewall.

5. **Cloud version (AWS, concept)**

```text
Route 53 → CloudFront → ALB (listener :443) → Target group ← Auto Scaling Group
                                                             (min 2, desired 3, max 10,
                                                              scale on CPU or requests per target)
```

The ASG launches instances from a launch template, registers them in the target group, and the ALB health-checks them — no Nginx upstream edits needed. Nginx often still runs on each instance as a local reverse proxy.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/scale.conf` | `upstream` with the app servers and the load-balancing server block |
| `/etc/nginx/sites-enabled/scale.conf` | Symlink that activates it |
| `/etc/redis/redis.conf` | Redis bind address and password for the shared session store |
| `/var/log/nginx/access.log` | Add `$upstream_addr` to see which server handled each request |
| `/tmp/app-808x/` | Demo backends |

## ✅ Verify it works

Requests spread across all servers:

```bash
for i in $(seq 1 9); do curl -s -H "Host: scale.example.com" http://127.0.0.1/; done | sort | uniq -c
```

Example output (with `least_conn` and quick sequential requests the split is roughly even, not exact):

```text
      3 served by app-8081
      3 served by app-8082
      3 served by app-8083
```

Kill one server and confirm the service stays up:

```bash
pkill -f "http.server 8082"
for i in $(seq 1 6); do curl -s -o /dev/null -w "%{http_code}\n" -H "Host: scale.example.com" http://127.0.0.1/; done
```

Expect only `200` (Nginx retries the failed connection on another server).

Sessions: log in, then check that the session key is in Redis (with `connect-redis` the default key prefix is `sess:`):

```bash
redis-cli -h 10.0.0.30 -a 'Change-This-Strong-Password' --scan --pattern 'sess:*' | head
```

## ⚠️ Common mistakes

- Scaling out a **stateful** app — users get logged out or lose uploads depending on which server they hit.
- Using sticky sessions as the permanent fix instead of moving state out.
- Forgetting that the **database** becomes the bottleneck once app servers scale — add caching, read replicas, connection pooling.
- Making the load balancer itself the new single point of failure — see [single point of failure and HA](04-single-point-of-failure-high-availability.md).
- Running the same cron job on every app server after scaling out — it now runs N times.
- Hardcoding instance IPs in an Nginx `upstream` while an autoscaling group replaces instances — traffic goes to dead IPs.

## 🔁 Follow-up questions interviewers ask

1. **Vertical or horizontal scaling — when would you choose vertical?**
   For a small app or a database that is hard to shard, a bigger machine is simpler and cheaper to run. The trade-off is a hard size limit and a single point of failure.
2. **How do you scale the database when app servers are already horizontal?**
   Cache hot reads in Redis, add read replicas for read traffic, then partition/shard data if writes are the limit.
3. **Sticky sessions vs Redis sessions?**
   Sticky is zero app change but uneven load and lost sessions on failure; Redis needs an app change and another component, but any server can serve any user.
4. **How does the load balancer know a new server is ready?**
   Health checks: it sends traffic only after the server passes them (cloud LBs and Nginx Plus actively probe; open-source Nginx detects failures passively).
5. **What metric would you autoscale on?**
   CPU utilisation is the common default; requests per target or queue length often track real load better for web/API servers.

---
[⬅️ Previous](01-proxy-types-forward-reverse-and-more.md) · [🏠 Index](../README.md) · [Next ➡️](03-l4-vs-l7-load-balancing.md)

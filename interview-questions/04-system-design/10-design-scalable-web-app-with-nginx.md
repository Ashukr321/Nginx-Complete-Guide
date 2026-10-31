# Q: Design a scalable, highly available web application. Where does Nginx fit, and how does each tier scale?

> **Level:** System Design · **Asked in:** DevOps, Backend, SRE, Platform Engineer, System Design (HLD) round

## 🎯 Short answer (say this in the interview)

I start by clarifying requirements and doing a rough estimate, then draw this path:

> **DNS → CDN → L4 load balancer (cloud LB, or a keepalived pair with a virtual IP) → a tier of Nginx reverse proxies → stateless Node.js app servers → Redis → a primary database with read replicas.** Media goes to object storage behind the CDN. Slow work (emails, thumbnails) goes through a message queue to workers.

**What Nginx does:** it is the L7 entry point. It terminates TLS, routes `/api`, `/ws` and static paths, load-balances across app servers with passive health checks and retries, rate-limits, compresses, microcaches, and adds `X-Forwarded-*` and request-ID headers.

**How each tier scales:**

- Nginx and app servers scale **horizontally** because they hold no state.
- Sessions and hot data live in **Redis**.
- The database scales reads with **replicas** and caching, and writes later with partitioning/sharding.

**Failures:** every tier has at least two instances. If an Nginx node dies, the LB/VIP moves traffic. If an app node dies, Nginx retries elsewhere. If the DB primary fails, a replica is promoted.

**Observability:** access logs with upstream timings, plus `stub_status` → Prometheus exporter → Grafana alerts.

## 🧩 Scenario

The interviewer says: *"Design a web application like a simple online marketplace: users browse products, log in, upload product photos, and place orders. It should handle growth and stay up if a server dies. Show me where Nginx fits."* You have about 40 minutes. They want structure and trade-offs, not a perfect answer.

## 💼 Use case

- The classic HLD round opener ("design a scalable web app / URL shortener / e-commerce site").
- Explaining your current company's architecture in a DevOps interview.
- A reference architecture for moving a single-server app (one VM with Nginx + Node + DB) to a production-ready setup.

## ⚙️ How it works

**Where it sits in an HLD diagram:** `Users → DNS → CDN → L4 LB / keepalived VIP → Nginx tier → App tier → Redis / DB / Queue / Object storage`

### Step 1: Clarify requirements (ask, then write them on the board)

**Functional**
- Browse/search products, view product pages.
- Sign up / log in, keep a session.
- Upload product images.
- Place orders. Send a confirmation email (can be async).

**Non-functional**
- High availability: no single point of failure, target "three nines" or better.
- Low latency for browsing (p95 under a few hundred ms), global users.
- Read-heavy traffic, with spikes during sales.
- Security: HTTPS everywhere, rate limiting on login.
- Consistency: orders/payments strongly consistent. Product listings can be slightly stale (seconds).

### Step 2: Back-of-envelope estimate

> **All numbers below are ASSUMPTIONS for the exercise**. State them out loud and adjust to what the interviewer says.

| Assumption | Value |
|---|---|
| Daily active users (DAU) | 1,000,000 |
| API requests per user per day | 20 |
| Peak traffic vs average | 5× |
| Read : write ratio | 10 : 1 |
| Image uploads per day | 100,000 (about 1 in 10 users) |
| Average image size | 500 KB |
| Average API response size | 20 KB |
| Requests one Node instance handles at our latency target | 300 req/s (**must be measured with a load test**) |

```text
 Requests/day   = 1,000,000 × 20                = 20,000,000
 Average RPS    = 20,000,000 / 86,400 s         ≈ 231 req/s
 Peak RPS       = 231 × 5                       ≈ 1,160 req/s
   reads        ≈ 1,160 × 10/11                 ≈ 1,050 req/s  → mostly Redis / replicas / CDN
   writes       ≈ 1,160 × 1/11                  ≈ 105 req/s    → DB primary

 App instances  = 1,160 / 300                   ≈ 4 at peak → run 6 (N+2 headroom, spread over 2+ zones)
 Nginx nodes    = 2–3 is plenty for this RPS (Nginx is rarely the bottleneck) → 2 minimum for HA

 Image storage  = 100,000 × 0.5 MB              = 50 GB/day  ≈ 18 TB/year → object storage, not DB/disk
 API egress     = 1,160 × 20 KB                 ≈ 23 MB/s    ≈ 185 Mbit/s at peak (static/media via CDN)
```

The conclusion to say out loud: *"Read-heavy, moderate write rate. So I'll cache aggressively (CDN, Redis), add read replicas, keep the app stateless so I can scale it horizontally, and put images in object storage behind the CDN."*

### Step 3: The architecture

```text
                              Users (browser / mobile)
                                        │
                                        ▼
                         DNS (e.g. Route 53 / Cloudflare DNS)
                                        │
                                        ▼
                ┌──────── CDN edge (cache, WAF, DDoS absorption) ────────┐
                │  static JS/CSS, product images  ◄── cache hit          │
                └────────────────────────┬───────────────────────────────┘
                                         │ /api, /ws, cache misses
                                         ▼
          L4 entry:  cloud load balancer (NLB/ALB)   ── or on-prem ──   keepalived pair
                     (multi-AZ, managed)                                (one virtual IP, VRRP failover)
                                         │
                     ┌───────────────────┼───────────────────┐
                     ▼                   ▼                   ▼
                ┌─────────┐         ┌─────────┐         ┌─────────┐
                │ Nginx 1 │         │ Nginx 2 │         │ Nginx 3 │   TLS, routing, LB, rate limit,
                └────┬────┘         └────┬────┘         └────┬────┘   microcache, gzip, WS upgrade
                     └───────────┬───────┴───────────┬───────┘
              ┌──────────┬───────┴──┬──────────┬─────┴────┐
              ▼          ▼          ▼          ▼          ▼
           App 1      App 2      App 3      App 4  ...  App N        stateless Node.js (auto-scaled)
              │          │          │          │          │
              ├──────────┴────┬─────┴──────────┴──────────┤
              ▼               ▼                           ▼
        ┌──────────┐   ┌──────────────┐          ┌────────────────────┐
        │  Redis   │   │ DB primary   │─repl.───►│ read replica 1..n   │
        │ sessions │   │ (writes)     │          │ (reads)            │
        │ cache    │   └──────────────┘          └────────────────────┘
        │ counters │
        └──────────┘          ┌───────────────────────┐      ┌──────────────────────────┐
                              │ Object storage (S3)   │◄─────│ App gives pre-signed URL │
                              │ product images        │      │ → browser uploads direct │
                              └──────────┬────────────┘      └──────────────────────────┘
                                         └──► served to users through the CDN

        App ──► Message queue (SQS / RabbitMQ / Kafka) ──► Worker pool (emails, thumbnails, reports)
```

### Step 4: What Nginx does at each point

| Job | How | Deep dive |
|---|---|---|
| Reverse proxy / single entry point | Hides app servers, one public endpoint | [Proxy types](01-proxy-types-forward-reverse-and-more.md) |
| TLS termination (or re-encryption for compliance) | `listen 443 ssl` + certs, or `proxy_pass https://` | [09 - SSL termination](09-ssl-termination-passthrough-reencryption.md) |
| Path routing | `/api/` → app upstream, `/ws/` → socket upstream, `/` → SPA | [API gateway vs reverse proxy](05-api-gateway-vs-reverse-proxy.md) |
| Load balancing + failover | `upstream` with `least_conn`, `max_fails`, `proxy_next_upstream` | [Load balancing](../02-intermediate/03-load-balancing-methods.md), [Health checks](../03-advanced/10-upstream-health-checks-and-failover.md) |
| Rate limiting (per node, per IP) | `limit_req` on `/login`, `/api` | [08 - Rate-limit algorithms](08-rate-limiting-algorithms.md) |
| Caching | Microcache public API responses, correct `Cache-Control` for the CDN | [06 - CDN vs Nginx caching](06-cdn-vs-nginx-caching.md) |
| Sticky routing (only if needed) | `hash $cookie_x consistent` | [07 - Consistent hashing](07-consistent-hashing-and-sticky-sessions.md) |
| WebSockets (live order status) | `Upgrade`/`Connection` headers | [WebSocket proxy](../03-advanced/05-websocket-proxy.md) |
| Observability | Access logs with `$upstream_response_time`, `$request_id`, and `stub_status` | (below) |

Related: [horizontal scaling](02-load-balancer-and-horizontal-scaling.md), [L4 vs L7 load balancing](03-l4-vs-l7-load-balancing.md) (cloud NLB vs Nginx), and [single point of failure & HA](04-single-point-of-failure-high-availability.md) (the keepalived pair).

### Step 5: Scaling each tier

| Tier | How it scales | Watch out for |
|---|---|---|
| CDN | Provider scales it | Cache key design, hit ratio |
| L4 LB / keepalived | Managed LB scales itself. keepalived is active-passive, so scale up or use multiple VIPs + DNS. | keepalived needs L2 adjacency or cloud-specific support |
| Nginx tier | Horizontal: add nodes behind the LB, all with identical config (from Git/Ansible/image) | Per-node rate limits and caches (see 06 and 08) |
| App tier | Horizontal + auto-scaling on CPU/RPS. **Stateless** (sessions in Redis) | Startup time, DB connection count grows with instances (use a pooler) |
| Redis | Replica + automatic failover (Sentinel / managed), then Redis Cluster for more memory/throughput | Treat as a cache where possible, so losing it is slow but not fatal |
| Database | Read replicas for reads, vertical scale for writes, then partitioning/sharding | Replication lag: read-your-own-writes should go to the primary |
| Object storage | Practically unlimited, managed | Serve via CDN, upload directly with pre-signed URLs |
| Queue + workers | Add workers when queue depth grows | Idempotent jobs (a message may be delivered twice) |

### Step 6: Failure scenarios (interviewers love these)

| What fails | What happens | Why users don't notice (much) |
|---|---|---|
| **One Nginx node dies** | Cloud LB health check marks it unhealthy, or keepalived moves the VIP to the backup within seconds | At least 2 Nginx nodes in different zones. In-flight requests on that node may fail and clients retry. |
| **One app node dies** | Nginx gets `connection refused`/timeout. With `proxy_next_upstream`, the request is retried on another node, and the node is marked down for `fail_timeout`. | N+2 app capacity. Auto-scaling/orchestrator replaces the node. |
| **Redis primary dies** | Sentinel/managed service promotes a replica | Sessions may need re-login if not replicated. Cache misses go to the DB briefly. |
| **DB primary dies** | A replica is promoted (managed DB failover or Patroni-style tooling), and the app reconnects via a DNS/endpoint that follows the primary | Writes fail for the failover window. Reads continue on replicas. Recent writes not yet replicated may be lost (async replication). |
| **Whole availability zone down** | LB stops sending traffic there | Every tier is spread over at least 2 zones |
| **Traffic spike** | CDN + Nginx microcache absorb reads, `limit_req` sheds abuse, app auto-scales | Queue absorbs async work, so write spikes don't block users |

### Step 7: Observability

- **Logs:** Nginx access log with `$request_id`, `$status`, `$request_time`, `$upstream_addr`, `$upstream_response_time`, shipped to ELK/Loki. Pass `X-Request-ID` to the app so one request can be traced across tiers.
- **Metrics:** `stub_status` (active connections, accepted/handled connections, total requests) → `nginx-prometheus-exporter` → Prometheus → Grafana. App metrics (RPS, p95/p99 latency, error rate), Redis hit ratio, DB replication lag, queue depth.
- **Alerts:** 5xx rate, p99 latency, "no live upstreams" in error logs, replication lag, disk/cert expiry.
- **Health endpoints:** `/health` on each app for LB/orchestrator checks.

### Step 8: The 60-second summary (say this at the end)

> "Users hit DNS, then a CDN that serves static files and images and absorbs DDoS. Dynamic traffic goes to a managed load balancer, or a keepalived pair on-prem, in front of at least two Nginx nodes. Nginx terminates TLS, routes by path, rate-limits, microcaches, and load-balances to a stateless Node.js tier with retries on failure. Sessions and hot data live in Redis. The database is a primary for writes with read replicas for reads. Images go straight to object storage via pre-signed URLs and are served through the CDN. Slow work like emails goes through a queue to workers. Every tier runs at least two instances across zones, so any single node can die. With my assumptions, about 1,200 RPS at peak, that's 2–3 Nginx nodes and about 6 app instances. I'd watch it with Nginx logs and `stub_status` metrics in Prometheus and Grafana. To grow further, I'd scale the app horizontally, add replicas and caching for reads, and eventually shard the database for writes."

## 🛠️ Practical: step by step

A local lab with Docker Desktop (Windows/macOS) or Docker Engine (Linux). One Nginx container fronts a **scalable** `app` service (Node + Express) that keeps a **shared counter in Redis**. You'll see different containers answer while the counter stays consistent, which is exactly the "stateless app + shared state" idea.

1. **Create the project folder**

```bash
mkdir -p nginx-scale-lab/app
cd nginx-scale-lab
```

Final layout:

```text
nginx-scale-lab/
├── docker-compose.yml
├── nginx.conf
└── app/
    ├── Dockerfile
    ├── package.json
    └── server.js
```

2. **The app**. File: `nginx-scale-lab/app/server.js`

```js
// Stateless app: no data in memory, the counter lives in Redis.
const express = require('express');
const os = require('os');
const { createClient } = require('redis');

const redis = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redis.on('error', (err) => console.error('Redis error:', err.message));

const app = express();

app.get('/health', (req, res) => res.send('ok'));

app.get('/', async (req, res) => {
  try {
    const visits = await redis.incr('visits');          // atomic, shared by all replicas
    res.json({ servedBy: os.hostname(), visits, requestId: req.get('X-Request-ID') });
  } catch (err) {
    res.status(503).json({ error: 'redis unavailable', servedBy: os.hostname() });
  }
});

redis.connect().then(() => {
  app.listen(3000, () => console.log(`app ${os.hostname()} listening on 3000`));
});
```

File: `nginx-scale-lab/app/package.json`

```json
{
  "name": "scale-lab-app",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.19.2",
    "redis": "^4.6.13"
  }
}
```

File: `nginx-scale-lab/app/Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
```

3. **Nginx config** (replaces the image's main config). File: `nginx-scale-lab/nginx.conf`

```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    log_format lab '$remote_addr "$request" $status rid=$request_id '
                   'upstream=$upstream_addr ustatus=$upstream_status rt=$request_time urt=$upstream_response_time';
    access_log /dev/stdout lab;

    upstream app_backend {
        # "app" is the compose service name. Docker's DNS returns one IP per replica.
        # Nginx resolves this name ONCE at startup/reload → reload after scaling.
        server app:3000 max_fails=3 fail_timeout=10s;
        keepalive 16;                                    # reuse connections to the app tier
    }

    # Alternative that re-resolves at runtime without reload (no upstream block features):
    #   resolver 127.0.0.11 valid=10s;                   # Docker's embedded DNS
    #   set $app_upstream http://app:3000;               # inside location
    #   proxy_pass $app_upstream;
    # Nginx 1.27.3+ also supports 'server app:3000 resolve;' in an upstream with 'zone' + 'resolver'.

    server {
        listen 80;

        location / {
            proxy_pass http://app_backend;
            proxy_http_version 1.1;
            proxy_set_header Connection "";              # needed for upstream keepalive
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Request-ID $request_id;   # trace one request across tiers

            proxy_connect_timeout 2s;                    # fail fast on a dead replica…
            proxy_next_upstream error timeout http_502 http_503;   # …and retry on another one
            proxy_next_upstream_tries 2;
        }

        location = /nginx_status {                       # metrics for the Prometheus exporter
            stub_status;
            access_log off;
            allow 127.0.0.1;
            allow 10.0.0.0/8;
            allow 172.16.0.0/12;
            allow 192.168.0.0/16;                        # Docker networks
            deny all;
        }
    }
}
```

4. **Compose file**. File: `nginx-scale-lab/docker-compose.yml`

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"                 # only Nginx is published to the host
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app

  app:
    build: ./app
    # No container_name and no host ports → the service can be scaled.
    environment:
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 2                 # default: 2 replicas
    depends_on:
      - redis

  redis:
    image: redis:7-alpine

  nginx-exporter:
    image: nginx/nginx-prometheus-exporter:1.1.0
    command: ["--nginx.scrape-uri=http://nginx:80/nginx_status"]
    ports:
      - "9113:9113"               # Prometheus would scrape http://<host>:9113/metrics
    depends_on:
      - nginx
```

5. **Start it with 2 replicas, then scale to 3**

```bash
docker compose up -d --build
docker compose ps

docker compose up -d --scale app=3          # start a third replica
docker compose exec nginx nginx -s reload   # make Nginx re-resolve "app" → now 3 IPs
```

6. **Send traffic** (Git Bash, WSL, Linux or macOS shell; in PowerShell use `curl.exe`)

```bash
for i in $(seq 1 9); do curl -s http://localhost:8080/; echo; done
```

7. **Simulate failures**

```bash
# App node dies: stop one replica while traffic flows
docker stop $(docker compose ps -q app | head -n 1)
for i in $(seq 1 6); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/; done
docker compose up -d --scale app=3          # bring the replica back
docker compose exec nginx nginx -s reload   # in case its IP changed

# Shared dependency dies: stop Redis → app answers 503 (shows why Redis needs HA)
docker compose stop redis
curl -s http://localhost:8080/; echo
docker compose start redis
```

8. **Clean up**

```bash
docker compose down
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `nginx-scale-lab/docker-compose.yml` | Defines Nginx, the scalable `app` service, Redis, and the Prometheus exporter |
| `nginx-scale-lab/nginx.conf` | Main Nginx config: upstream to `app:3000`, retries, keepalive, request IDs, `stub_status` |
| `nginx-scale-lab/app/server.js` | Stateless Express app, shared counter via Redis `INCR` |
| `nginx-scale-lab/app/package.json` | App dependencies (`express`, `redis`) |
| `nginx-scale-lab/app/Dockerfile` | Builds the app image on `node:20-alpine` |
| `/etc/nginx/nginx.conf` (inside the container) | Where the bind-mounted config ends up |

## ✅ Verify it works

Example output of step 6 (container IDs will differ). **Different `servedBy` values, but `visits` always goes up by one**, because the state is shared in Redis, not stored in any one app:

```text
{"servedBy":"8c1f2a9d3b10","visits":1,"requestId":"3e0f5b7c9a1d4e2f8b6a0c3d5e7f9a1b"}
{"servedBy":"f42b6c1e7d55","visits":2,"requestId":"9a1b3c5d7e9f1a2b3c4d5e6f7a8b9c0d"}
{"servedBy":"1d7e9a3c5f22","visits":3,"requestId":"0b2d4f6a8c0e2a4c6e8a0b2d4f6a8c0e"}
{"servedBy":"8c1f2a9d3b10","visits":4,"requestId":"..."}
```

See which upstream answered each request, and the retries during the failure test:

```bash
docker compose logs nginx --tail 10
```

Example line after stopping a replica (the first try failed, and the request was retried on another one, so the client still got `200`):

```text
172.18.0.1 "GET / HTTP/1.1" 200 rid=... upstream=172.18.0.4:3000, 172.18.0.5:3000 ustatus=504, 200 rt=2.004 urt=2.001, 0.003
```

The stopped container's IP no longer answers, so the first attempt usually waits up to `proxy_connect_timeout` (2s) and shows as `504`. If the connection is refused instead, you'll see `502` and almost no delay. After `max_fails` failures, Nginx skips that IP for `fail_timeout`.

Metrics:

```bash
curl -s http://localhost:8080/nginx_status
curl -s http://localhost:9113/metrics | grep -E '^nginx_(up|connections_active|http_requests_total)'
```

Example output:

```text
nginx_connections_active 1
nginx_http_requests_total 27
nginx_up 1
```

## ⚠️ Common mistakes

- **Starting the design with boxes before requirements and numbers.** Interviewers grade the process: clarify, estimate, design, then go deep.
- **A single Nginx (or single anything) in the "HA" design.** Every tier needs at least 2 instances in different zones, including the LB entry (managed LB or keepalived pair).
- **Stateful app servers** (in-memory sessions, local uploads). They make horizontal scaling and failover hard. Move state to Redis/DB/object storage.
- **Uploading images through Nginx → app → DB.** It wastes app capacity and DB space. Use pre-signed URLs to object storage and serve through the CDN.
- **Reading from replicas right after a write.** Replication lag shows users stale data. Send read-your-own-writes to the primary.
- In the lab: setting `container_name` on `app` or publishing its port. `--scale` then fails with name or port conflicts.
- In the lab: forgetting that Nginx resolved `app` at startup, so new replicas get no traffic until `nginx -s reload` (or until you use `resolver 127.0.0.11` with a variable).
- Not mentioning observability and failure handling. "How do you know it's broken?" is always the next question.

## 🔁 Follow-up questions interviewers ask

1. **Trade-off: cloud load balancer vs keepalived + Nginx on VMs?**
   A managed LB is multi-zone, auto-scaling and needs no maintenance, but costs money and is provider-specific. keepalived is free and simple on-prem, but it is active-passive and you run it yourself.
2. **Why put Nginx behind a cloud LB at all? Isn't that two load balancers?**
   The cloud LB gives a highly available entry point. Nginx adds rich L7 control (caching, rate limiting, rewrites, microcaching, consistent config across clouds/on-prem). In Kubernetes, the Ingress controller (often Nginx) plays this role. See [Nginx in Docker & Kubernetes](../03-advanced/11-nginx-in-docker-and-kubernetes-ingress.md).
3. **The database is the bottleneck. What next?**
   In order: add indexes and fix queries, cache hot reads in Redis, add read replicas, use connection pooling, scale the primary vertically, and finally partition/shard by a key (e.g. `user_id`) or split services with separate databases.
4. **How would you do zero-downtime deployments?**
   Rolling or blue-green: start new app instances, wait for `/health`, add them to the upstream/target group, drain old ones, and `nginx -s reload` for config changes (it doesn't drop connections).
5. **How do you make orders reliable if the email service is down?**
   Write the order in a DB transaction, publish an "order created" event to the queue (outbox pattern for safety), and let workers retry the email with idempotency. The user's order never waits on email.

---
[⬅️ Previous](09-ssl-termination-passthrough-reencryption.md) · [🏠 Index](../README.md)

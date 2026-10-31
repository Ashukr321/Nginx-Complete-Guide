# Q: What is the difference between L4 and L7 load balancing? When would you use each?

> **Level:** System Design · **Asked in:** DevOps, SRE, Network, Cloud, Backend, System Design round

## 🎯 Short answer (say this in the interview)

The names come from the OSI model. An **L4 (transport layer) load balancer** works with **TCP/UDP connections**: it only sees IP addresses and ports, picks a backend when a connection opens, and then just moves bytes back and forth. It does not understand HTTP, so it is fast, simple and works for **any protocol** — PostgreSQL, Redis, MQTT, gRPC, or HTTPS that it passes through without decrypting. An **L7 (application layer) load balancer** understands **HTTP**: it terminates TLS, reads the URL, host, headers and cookies, and can route `/api` to one service and `/images` to another, add headers, cache, compress, and retry a single request on another server. That flexibility costs more CPU per request and means it must hold the TLS certificates. In Nginx, L4 is the **`stream {}`** block and L7 is the **`http {}`** block. In AWS, **NLB** is L4 and **ALB** is L7. A common design is L4 at the edge for raw speed or non-HTTP traffic, and L7 behind it for smart HTTP routing.

## 🧩 Scenario

Your team runs a web app and a PostgreSQL cluster with one primary and two read replicas. The web traffic needs path-based routing (`/api` → API servers, `/` → frontend) and HTTPS termination. The reporting service needs to spread its read-only SQL connections across the two replicas through one address. An interviewer asks: *"Would you use the same load balancer for both? Which layer, and why?"*

## 💼 Use case

**L4 (Nginx `stream`, HAProxy `mode tcp`, AWS NLB):**
- Databases and caches: PostgreSQL/MySQL read replicas, Redis, RabbitMQ, MQTT.
- TLS passthrough when the backend must terminate TLS itself (end-to-end encryption, client certificates).
- Very high connection counts, UDP (DNS, syslog, game servers), static IPs for firewall allow-lists.

**L7 (Nginx `http`, HAProxy `mode http`, Envoy, AWS ALB):**
- Websites and REST/gRPC APIs needing path/host/header routing.
- TLS termination, caching, compression, auth, rate limiting, request retries.
- Canary releases by header or cookie, per-request metrics and logs.

## ⚙️ How it works

**Where it sits in an HLD diagram:** Client → **L4 LB** (TCP: DBs, non-HTTP, TLS passthrough) or **L7 LB** (HTTP: TLS termination, path routing) → backends; often Client → L4 (NLB) → L7 (Nginx/Ingress) → services.

```text
 OSI layer           What the LB can see                      Example decision
 ─────────           ───────────────────                      ────────────────
 L7 Application  ─►  method, URL, Host, headers, cookies,     "/api/* → api pool",
                     body (after TLS is decrypted)            "cookie beta=1 → canary"
 L6/L5               (TLS / sessions)
 L4 Transport    ─►  src/dst IP + port, TCP/UDP              "port 5432 → db pool"
 L3 Network          IP packets
```

```text
 L4 load balancer (one decision per CONNECTION)

  client ══TCP══► [ L4 LB ] ══same bytes══► backend
                   picks backend on connect,
                   cannot read the encrypted/HTTP payload

 L7 load balancer (one decision per REQUEST)

  client ══TLS══► [ L7 LB ] ──GET /api/orders──► api pool
                   decrypts,  ──GET /img/a.png──► static pool
                   reads HTTP ──Host: admin.*────► admin pool
```

**Comparison**

| | L4 | L7 |
|---|---|---|
| Unit of balancing | TCP connection / UDP datagram | HTTP request |
| Can see | IPs, ports | Plus URL, host, headers, cookies, body |
| Protocols | Any TCP/UDP | HTTP/1.1, HTTP/2, gRPC, WebSocket (HTTP-based) |
| TLS | Usually passthrough (backend decrypts); can also terminate | Terminates TLS (needs the certificate) |
| Smart routing | By port; by SNI hostname with `ssl_preread` | Path, host, header, cookie, method |
| Caching, compression, auth, header changes | No | Yes |
| Retry a failed request on another server | Only a failed **connect** | Yes, per request |
| Client IP for backend | Lost unless PROXY protocol or transparent mode | `X-Forwarded-For` header |
| CPU per request | Lower (no parsing/decryption) | Higher |
| Nginx | `stream {}` (`ngx_stream_*` modules) | `http {}` |
| AWS | NLB | ALB |
| Others | HAProxy `mode tcp`, LVS/IPVS | HAProxy `mode http`, Envoy, Traefik |

**TLS implications:** at L4 with passthrough, the certificate and private key stay on the backends and traffic is encrypted end to end, but the LB cannot look inside. At L7 the LB holds the certificate, sees plaintext, and can re-encrypt to backends if needed. An L4 LB can still route HTTPS by hostname using the **SNI** value from the TLS ClientHello (Nginx `ssl_preread`) without decrypting.

**Important L4 behaviour:** a long-lived connection stays on one backend. A Redis or database client with a connection pool of 10 connections gets those 10 spread across backends — individual queries are not balanced.

**AWS NLB vs ALB**

| | NLB (L4) | ALB (L7) |
|---|---|---|
| Listeners | TCP, UDP, TLS | HTTP, HTTPS |
| Routing | By port | Path, host, header, query string, method, source IP |
| Static IP | One per AZ, can use Elastic IPs | No static IP (use its DNS name) |
| Client IP | Preserved for instance/IP targets (configurable), or PROXY protocol v2 | `X-Forwarded-For` header |
| Extras | Good for non-HTTP, PrivateLink | AWS WAF, OIDC/Cognito auth, gRPC, redirects/fixed responses |

Nginx HTTP load balancing methods are covered in [load balancing methods](../02-intermediate/03-load-balancing-methods.md).

## 🛠️ Practical: step by step

Goal: Nginx as an **L4** load balancer for Redis (easy to test on one VM), plus the same pattern for PostgreSQL read replicas.

1. **Make sure the stream module is installed and loaded**

On Ubuntu, `stream` is a dynamic module in the package `libnginx-mod-stream` (already pulled in by the default `nginx` install on some releases; installing it again is harmless):

```bash
sudo apt install -y libnginx-mod-stream
ls /etc/nginx/modules-enabled/ | grep stream       # expect: 50-mod-stream.conf
```

The `include /etc/nginx/modules-enabled/*.conf;` line at the top of `/etc/nginx/nginx.conf` loads it.

2. **Start two Redis instances as test backends** (demo only — in real life these would be replicas on separate servers)

```bash
sudo apt install -y redis-server
redis-server --port 6381 --daemonize yes --save "" --appendonly no
redis-server --port 6382 --daemonize yes --save "" --appendonly no
redis-cli -p 6381 ping      # expect: PONG
```

3. **Add a top-level `stream {}` block** — file: `/etc/nginx/nginx.conf`

`stream {}` must be in the **main context** — a sibling of `http {}`, never inside it. On Ubuntu, files in `conf.d/` and `sites-enabled/` are included **inside** `http {}`, so they cannot hold a `stream` block. Add this to the very end of `/etc/nginx/nginx.conf`, after the closing `}` of `http`:

```nginx
stream {
    include /etc/nginx/stream.d/*.conf;
}
```

```bash
sudo mkdir -p /etc/nginx/stream.d
```

4. **Create the L4 load balancer** — file: `/etc/nginx/stream.d/redis-lb.conf`

```nginx
# Log format for TCP sessions (stream has its own log variables)
log_format tcp_lb '$remote_addr [$time_local] $protocol $status '
                  'sent=$bytes_sent recv=$bytes_received time=$session_time '
                  'upstream=$upstream_addr';
access_log /var/log/nginx/stream_access.log tcp_lb;

upstream redis_pool {
    least_conn;                                       # good for long-lived connections
    server 127.0.0.1:6381 max_fails=2 fail_timeout=10s;
    server 127.0.0.1:6382 max_fails=2 fail_timeout=10s;
}

server {
    listen 6390;                                      # clients connect here
    proxy_pass redis_pool;                            # no "http://" — this is raw TCP
    proxy_connect_timeout 2s;                         # fail over quickly if a backend is down
    proxy_timeout 10m;                                # idle timeout for the TCP session
}
```

5. **Same pattern for PostgreSQL read replicas** — file: `/etc/nginx/stream.d/pg-read.conf` (use your replica IPs)

```nginx
upstream pg_replicas {
    least_conn;
    server 10.0.0.21:5432 max_fails=2 fail_timeout=10s;
    server 10.0.0.22:5432 max_fails=2 fail_timeout=10s;
}

server {
    listen 5433;                                      # apps send READ-ONLY connections here
    proxy_pass pg_replicas;
    proxy_connect_timeout 2s;
    proxy_timeout 1h;                                 # long idle DB connections
}
```

Note: Nginx open source checks only whether the TCP connection works. It does not know which node is the primary or whether a replica is lagging — tools like Patroni + HAProxy or PgBouncer handle that.

6. **Optional: route HTTPS by hostname at L4 without decrypting (SNI)** — file: `/etc/nginx/stream.d/sni.conf`

Check that your build has the module: `nginx -V 2>&1 | grep -o ssl_preread`. Only use this if port 443 is not already used by an `http` server block.

```nginx
map $ssl_preread_server_name $tls_backend {
    app.example.com    10.0.0.31:443;
    admin.example.com  10.0.0.32:443;
    default            10.0.0.31:443;
}

server {
    listen 443;
    ssl_preread on;                                   # read SNI from ClientHello, no decryption
    proxy_pass $tls_backend;
}
```

7. **Test and reload**

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Main context; holds the `stream { include ... }` block next to `http {}` |
| `/etc/nginx/modules-enabled/50-mod-stream.conf` | Loads the dynamic `stream` module on Ubuntu |
| `/etc/nginx/stream.d/redis-lb.conf` | L4 Redis load balancer (`upstream` + `server` in stream context) |
| `/etc/nginx/stream.d/pg-read.conf` | L4 load balancer for PostgreSQL read replicas |
| `/etc/nginx/stream.d/sni.conf` | Optional SNI-based TLS passthrough |
| `/var/log/nginx/stream_access.log` | One line per TCP session with the chosen upstream |

## ✅ Verify it works

Each new connection asks Redis which port it is — so you see which backend was picked:

```bash
for i in 1 2 3 4; do redis-cli -p 6390 CONFIG GET port | tail -n 1; done
```

Example output:

```text
6381
6382
6381
6382
```

Check Nginx is listening and see the session log:

```bash
sudo ss -ltnp | grep 6390
sudo tail -n 3 /var/log/nginx/stream_access.log
```

Example log line:

```text
127.0.0.1 [31/Oct/2026:10:15:02 +0000] TCP 200 sent=36 recv=33 time=0.003 upstream=127.0.0.1:6382
```

Failover: stop one backend and connect again — all connections go to the other one.

```bash
redis-cli -p 6382 shutdown nosave
redis-cli -p 6390 CONFIG GET port | tail -n 1      # expect: 6381
```

## ⚠️ Common mistakes

- Putting `stream {}` inside `http {}` or in `conf.d/` / `sites-enabled/` on Ubuntu → `"stream" directive is not allowed here`.
- Module not loaded → `unknown directive "stream"`; install `libnginx-mod-stream` and check `modules-enabled`.
- Writing `proxy_pass http://redis_pool;` in a stream server — stream uses `proxy_pass redis_pool;`.
- Expecting L4 to balance individual queries — it balances **connections**.
- Load-balancing **writes** across independent databases/Redis instances — data ends up split and inconsistent; L4 balancing of data stores is for replicas/read traffic or for clustered systems built for it.
- Losing the client IP at L4 and breaking IP allow-lists — use PROXY protocol (`proxy_protocol on;`) only if the backend understands it.

## 🔁 Follow-up questions interviewers ask

1. **Which is faster, L4 or L7?**
   L4 usually uses less CPU per connection because it does not parse HTTP or decrypt TLS. The trade-off is no content-based routing, caching or per-request retries.
2. **Can an L4 load balancer route HTTPS by domain name?**
   Yes, using the SNI hostname from the TLS handshake (Nginx `ssl_preread`), without decrypting — but not by URL path, which is encrypted.
3. **Why put an NLB in front of an Nginx/Ingress L7 layer?**
   NLB gives static IPs, handles huge connection counts and any protocol; Nginx behind it does TLS and path routing. Common in Kubernetes ingress setups.
4. **How does the backend see the real client IP behind an L4 LB?**
   PROXY protocol (Nginx `proxy_protocol on;` in stream, AWS NLB proxy protocol v2) or client IP preservation, since there is no `X-Forwarded-For` header at L4.
5. **Is gRPC L4 or L7?**
   gRPC runs over HTTP/2 with long-lived connections; L4 balancing pins all calls of a connection to one server, so L7 (per-request) balancing spreads load better.

---
[⬅️ Previous](02-load-balancer-and-horizontal-scaling.md) · [🏠 Index](../README.md) · [Next ➡️](04-single-point-of-failure-high-availability.md)

# Q: What is an API gateway, and how is it different from a reverse proxy or a load balancer?

> **Level:** System Design · **Asked in:** DevOps, Backend, SRE, Platform Engineer, System Design round

## 🎯 Short answer (say this in the interview)

All three sit in front of backends, but they work at different levels. A **load balancer** spreads traffic across identical copies of **one** service and removes dead ones. A **reverse proxy** is the general tool: single entry point, TLS termination, routing, caching, hiding backends (Nginx does both of these). An **API gateway** is a reverse proxy specialised for **APIs** in a microservices system: it is the one front door for all clients and handles the cross-cutting API concerns so each service doesn't have to — **authentication** (JWT/OAuth/API keys), **rate limiting and quotas per API key or customer**, **routing** `/users`, `/orders`, `/payments` to different microservices, **request/response transformation**, sometimes **aggregating** several service calls into one response, and **per-API analytics**. Nginx can be a lightweight gateway with path routing, `auth_request` and `limit_req`. When I need a developer portal, key management, plugins, analytics or distributed rate limits, I choose a real gateway like **Kong** (built on Nginx/OpenResty) or a managed one like **AWS API Gateway**.

## 🧩 Scenario

Your company split a monolith into `users`, `orders` and `catalog` microservices. The mobile app and two external partners call them. Today every service checks API keys in its own code — three different implementations, one with a bug. A partner script went into a loop and sent huge traffic to `orders`, slowing it down for everyone. The interviewer asks: *"How would you design the entry point so auth and rate limits are done once, each partner is limited separately, and clients see one API?"*

## 💼 Use case

- One public API domain (`api.example.com`) in front of many microservices.
- API keys / JWT checked once at the edge; services trust a header like `X-Client-Id`.
- Per-customer rate limits and quotas (free vs paid plans).
- Versioning and routing (`/v1/` → old service, `/v2/` → new service).
- Mobile vs web clients needing different response shapes → backend-for-frontend.
- Usage analytics and billing per API key.

## ⚙️ How it works

**Where it sits in an HLD diagram:** Clients (mobile, web, partners) → CDN / cloud LB → **API gateway** (auth, rate limit, route) → Microservices → their databases.

```text
                         ┌──────────────────── API GATEWAY ─────────────────────┐
  Mobile app ──┐         │ 1. TLS termination                                  │
  Web SPA    ──┼──HTTPS─►│ 2. Authenticate (API key / JWT)       ── 401 if bad  │
  Partners   ──┘         │ 3. Rate limit per key                 ── 429 if over │
                         │ 4. Route by path / version                          │
                         │ 5. Transform (add X-Client-Id, strip headers)       │
                         │ 6. Log + metrics per API key                        │
                         └─────┬──────────────┬───────────────┬────────────────┘
                               ▼              ▼               ▼
                        /api/users/    /api/orders/    /api/catalog/
                        users-svc      orders-svc      catalog-svc
                           │               │                │
                         users DB       orders DB       catalog DB
```

**Load balancer vs reverse proxy vs API gateway**

| | Load balancer | Reverse proxy | API gateway |
|---|---|---|---|
| Main question it answers | "Which copy of this service?" | "Which backend gets this request, and how do I protect it?" | "Who is this API client, are they allowed, and which service handles it?" |
| Routing | To identical servers | Host/path to different apps | Path/version/method to microservices |
| Auth | No | Basic (IP allow-lists, basic auth) | JWT, OAuth2, API keys, mTLS |
| Rate limits | No / basic | Per IP or any variable (`limit_req`) | Per key / plan / quota, often shared across nodes |
| Transformation | No | Headers, simple rewrites | Headers, body, protocol (REST ↔ gRPC), aggregation |
| Analytics / portal / key management | No | Logs only | Yes (usually) |
| Examples | AWS NLB/ALB, HAProxy, Nginx `upstream` | Nginx, HAProxy, Envoy | Kong, AWS API Gateway, Apigee, Tyk, Nginx (light) |

In practice the layers stack: **cloud LB → API gateway (several replicas) → services**, and each service may have its own load-balanced instances.

**Backend-for-frontend (BFF):** instead of one gateway serving every client, each client type gets its own thin gateway/service that calls the microservices and returns exactly what that client needs (aggregation lives here).

```text
  Mobile app ──► Mobile BFF ──┐
                              ├──► users-svc, orders-svc, catalog-svc
  Web app    ──► Web BFF    ──┘
  (one call "GET /home" → BFF calls 3 services → one small response for the phone)
```

**What Nginx open source can and can't do as a gateway**

| Need | Nginx open source |
|---|---|
| Path-based routing to microservices | Yes — `location` + `proxy_pass` |
| Auth via an external auth service | Yes — `auth_request` (module `ngx_http_auth_request_module`) |
| Rate limit per API key | Yes — `limit_req_zone $http_x_api_key` (counters per Nginx node) |
| Native JWT validation | `auth_jwt` is **Nginx Plus only**; open source uses `auth_request` to an auth service, njs, or OpenResty/Lua |
| Response aggregation | Not natively — use a BFF service, njs, or OpenResty |
| Developer portal, key self-service, usage plans | No — Kong, AWS API Gateway, Apigee |

Rate limiting details are in [rate limiting](../03-advanced/04-rate-limiting.md); upstream details in [load balancing methods](../02-intermediate/03-load-balancing-methods.md).

## 🛠️ Practical: step by step

Goal: Nginx as a lightweight API gateway on one Ubuntu VM — three demo microservices, API-key auth through `auth_request`, and a rate limit per API key.

1. **Check that `auth_request` is available** (Ubuntu's `nginx` package includes it)

```bash
nginx -V 2>&1 | grep -o auth_request
# expect: auth_request
```

2. **Start three demo microservices**

```bash
for svc in users:8001 orders:8002 catalog:8003; do
  name=${svc%%:*}; port=${svc##*:}
  mkdir -p /tmp/$name && echo "{\"service\":\"$name\"}" > /tmp/$name/index.html
  nohup python3 -m http.server $port --bind 127.0.0.1 --directory /tmp/$name >/dev/null 2>&1 &
done
curl -s http://127.0.0.1:8001/     # expect: {"service":"users"}
```

3. **Create the gateway config** — file: `/etc/nginx/sites-available/api-gateway.conf`

This file is included inside `http {}` (via `sites-enabled`), so `limit_req_zone`, `upstream` and `map` are allowed here.

```nginx
# ---------- Rate limit: 10 requests/second PER API KEY ----------
limit_req_zone $http_x_api_key zone=per_api_key:10m rate=10r/s;

# ---------- Microservices ----------
upstream users_svc   { server 127.0.0.1:8001; }
upstream orders_svc  { server 127.0.0.1:8002; }
upstream catalog_svc { server 127.0.0.1:8003; }
upstream auth_svc    { server 127.0.0.1:9000; }

# ---------- DEMO auth service (stand-in for a real one) ----------
# In production this is your own auth service that checks keys/JWTs in a DB or IdP.
map $http_x_api_key $api_key_owner {
    default         "";
    "demo-key-123"  "team-mobile";
    "demo-key-456"  "partner-acme";
}

server {
    listen 127.0.0.1:9000;
    location = /validate {
        if ($api_key_owner = "") { return 401; }          # unknown key
        add_header X-Client-Id $api_key_owner always;      # tell the gateway who the client is
        return 204;                                        # 2xx = allowed
    }
}

# ---------- The API gateway ----------
server {
    listen 80;
    server_name api.example.com;
    default_type application/json;

    # A key is mandatory: requests with an EMPTY key are NOT counted by limit_req
    if ($http_x_api_key = "") {
        return 401 '{"error":"missing X-Api-Key header"}\n';
    }

    # Applied to every location below (inherited)
    auth_request     /_auth;                               # subrequest: 2xx allow, 401/403 deny
    auth_request_set $client_id $upstream_http_x_client_id;
    limit_req        zone=per_api_key burst=20 nodelay;    # short bursts OK, then 429
    limit_req_status 429;

    proxy_set_header Host            $host;
    proxy_set_header X-Client-Id     $client_id;           # services trust this, not the key
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Api-Key       "";                   # don't leak the key to services

    # Internal auth subrequest
    location = /_auth {
        internal;
        auth_request off;
        proxy_pass http://auth_svc/validate;
        proxy_pass_request_body off;                       # auth needs headers, not the body
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI    $request_uri;
        proxy_set_header X-Original-Method $request_method;
    }

    # Path-based routing; trailing "/" on proxy_pass strips the /api/<svc>/ prefix
    location /api/users/   { proxy_pass http://users_svc/; }
    location /api/orders/  { proxy_pass http://orders_svc/; }
    location /api/catalog/ { proxy_pass http://catalog_svc/; }

    location / {
        auth_request off;
        return 404 '{"error":"unknown API route"}\n';
    }
}
```

Note: the `/_auth` location defines its own `proxy_set_header` lines, so it does not inherit the server-level ones; it still receives the original client headers (including `X-Api-Key`), because a subrequest copies the client's request headers.

4. **Enable and reload**

```bash
sudo ln -s /etc/nginx/sites-available/api-gateway.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

5. **When to move to a real gateway**

| Choose | When |
|---|---|
| Nginx as gateway | Few services, simple key/JWT checks via an auth service, team already runs Nginx, low cost |
| Kong (open source or Enterprise) | Many services/teams, plugins (JWT, OAuth2, key-auth, rate limiting with Redis-backed counters shared across nodes), declarative config, self-hosted or in Kubernetes |
| AWS API Gateway | Serverless/Lambda backends, want a managed service with usage plans + API keys, throttling, Cognito/JWT authorizers; you accept per-request pricing and AWS lock-in |

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/sites-available/api-gateway.conf` | Rate-limit zone, upstreams, demo auth service and the gateway server block |
| `/etc/nginx/sites-enabled/api-gateway.conf` | Symlink that activates it |
| `/var/log/nginx/access.log` | Per-request log; add `$http_x_api_key` or `$client_id` to a `log_format` for per-client analytics |
| `/var/log/nginx/error.log` | `limiting requests, excess: ... by zone "per_api_key"` messages |
| `/tmp/users`, `/tmp/orders`, `/tmp/catalog` | Demo microservices |

## ✅ Verify it works

```bash
H="Host: api.example.com"

# 1. No key → 401 from the gateway itself
curl -s -o /dev/null -w "%{http_code}\n" -H "$H" http://127.0.0.1/api/users/

# 2. Wrong key → 401 from auth_request
curl -s -o /dev/null -w "%{http_code}\n" -H "$H" -H "X-Api-Key: wrong" http://127.0.0.1/api/users/

# 3. Valid key → routed to the right service
curl -s -H "$H" -H "X-Api-Key: demo-key-123" http://127.0.0.1/api/users/
curl -s -H "$H" -H "X-Api-Key: demo-key-123" http://127.0.0.1/api/orders/
```

Example output:

```text
401
401
{"service":"users"}
{"service":"orders"}
```

Rate limit per key — 30 quick requests with one key, then one request with the other key:

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" -H "$H" -H "X-Api-Key: demo-key-123" http://127.0.0.1/api/catalog/
done | sort | uniq -c

curl -s -o /dev/null -w "%{http_code}\n" -H "$H" -H "X-Api-Key: demo-key-456" http://127.0.0.1/api/catalog/
```

Example output (the exact split depends on timing; with `burst=20 nodelay` about 21 pass):

```text
     21 200
      9 429
200
```

The second key still gets `200` — each key has its own bucket, so one noisy partner can't block the others.

```bash
sudo grep "per_api_key" /var/log/nginx/error.log | tail -n 2
```

## ⚠️ Common mistakes

- Rate limiting by `$http_x_api_key` without rejecting empty keys — requests with no key are **not limited at all**.
- Forgetting `proxy_pass_request_body off;` and `proxy_set_header Content-Length "";` in the auth location — large uploads are sent to the auth service too.
- Using `auth_jwt` on open-source Nginx — it is **Nginx Plus only** (`unknown directive "auth_jwt"`).
- Passing the raw API key or JWT on to every microservice when only the identity (`X-Client-Id`) is needed.
- Letting clients reach services directly (bypassing the gateway) — services must only accept traffic from the gateway network, or they must not trust `X-Client-Id`.
- Putting business logic in the gateway — it becomes a "mini monolith" every team has to change; keep it to cross-cutting concerns.
- Running several gateway nodes with local `limit_req` counters and expecting an exact global limit — each node counts separately.
- Making the gateway a single point of failure — run several replicas behind an LB (see [single point of failure and HA](04-single-point-of-failure-high-availability.md)).

## 🔁 Follow-up questions interviewers ask

1. **Do you need an API gateway if you already have a load balancer?**
   For one service, often no. With many services and external clients, the gateway centralises auth, limits and routing; the trade-off is an extra hop, extra latency, and a critical component to keep highly available.
2. **Where should JWT validation happen — gateway or service?**
   Usually at the gateway (one place, fewer bugs), with services trusting a signed identity header or re-checking for sensitive actions. Zero-trust designs validate in both places, at the cost of extra work per request.
3. **How do you do rate limiting across many gateway nodes?**
   Use a shared counter store such as Redis (e.g. Kong's rate-limiting plugin with the redis policy), or accept approximate per-node limits (limit ÷ number of nodes).
4. **API gateway vs service mesh?**
   The gateway handles **north-south** traffic (clients → system); a service mesh handles **east-west** traffic (service → service). Many systems use both.
5. **What is a backend-for-frontend and why use it?**
   A separate gateway/service per client type (mobile, web) that aggregates calls and shapes responses for that client, so the shared gateway stays simple and mobile apps make fewer round trips.

---
[⬅️ Previous](04-single-point-of-failure-high-availability.md) · [🏠 Index](../README.md) · [Next ➡️](06-cdn-vs-nginx-caching.md)

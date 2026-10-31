# Q: How do you run Nginx in Docker, and how does Nginx work as a Kubernetes Ingress controller?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Cloud Engineer

## 🎯 Short answer (say this in the interview)

In Docker I use the official `nginx` image: I put my server config in `/etc/nginx/conf.d/default.conf` and static files in `/usr/share/nginx/html`. For a React app I use a **multi-stage Dockerfile** — a Node stage builds the app, and a small Nginx stage copies only the build output. With docker-compose, Nginx and the API share a network, so `proxy_pass http://api:3000` works by **service name** through Docker's DNS. Logs go to stdout/stderr so `docker logs` works. In Kubernetes, an **Ingress** is just a YAML resource with host/path routing rules; an **Ingress controller** (for example one based on Nginx) watches those resources and generates the real Nginx config. There are two different Nginx-based controllers: the community **ingress-nginx** (`kubernetes/ingress-nginx`), which has been announced for retirement so teams are migrating to alternatives and the **Gateway API**, and F5's **NGINX Ingress Controller** (`nginxinc/kubernetes-ingress`).

## 🧩 Scenario

Your team has a React frontend and a Node.js API. Today they run on a VM with a hand-edited Nginx. The company is moving to containers: first docker-compose for local development and staging, then Kubernetes for production with HTTPS on `app.example.com`. You must containerize the frontend with Nginx, wire it to the API, and expose both through a Kubernetes Ingress.

## 💼 Use case

- Serving a built SPA (React/Vue/Angular) from a tiny Nginx container.
- Local dev/staging stacks with docker-compose (Nginx as the single entry point).
- Kubernetes clusters where one Ingress controller routes all HTTP(S) traffic to many services by host and path.
- TLS termination at the cluster edge with certificates stored as Kubernetes Secrets (often issued by cert-manager).

## ⚙️ How it works

**Docker / docker-compose**

```text
 browser ──► host :80 ──► ┌──────────────── docker network "appnet" ───────────────┐
                          │  web (nginx)                       api (node)           │
                          │  /usr/share/nginx/html  (React)                         │
                          │  /api/*  ── proxy_pass http://api:3000 ──►  :3000      │
                          │           (Docker DNS resolves "api" → container IP)    │
                          └─────────────────────────────────────────────────────────┘
   docker logs web  ◄── access.log → /dev/stdout, error.log → /dev/stderr
```

**Kubernetes Ingress**

```text
 internet ──► LoadBalancer Service (cloud LB) ──► Ingress controller pods (nginx inside)
                                                       │  watches Ingress objects via the API server
                                                       │  and rewrites its own nginx.conf
                     ┌─────────────────────────────────┴─────────────────────┐
   host app.example.com, path /      ──► Service "frontend" ──► frontend pods
   host app.example.com, path /api   ──► Service "api"      ──► api pods
   TLS: Secret "app-tls" (tls.crt / tls.key)
```

**Ingress resource vs Ingress controller**

| | Ingress (resource) | Ingress controller |
|---|---|---|
| What it is | A YAML object: "route host X path Y to Service Z" | A running program (pods) that implements those rules |
| Does it handle traffic? | No — it's only configuration | Yes — it is the actual proxy (Nginx, Traefik, HAProxy, cloud LB...) |
| Without the other | An Ingress with no controller does nothing | A controller with no Ingress routes nothing |

**The two Nginx-based controllers (common interview trap)**

| | ingress-nginx | NGINX Ingress Controller |
|---|---|---|
| Maintained by | Kubernetes community | F5 / NGINX |
| Repo | `kubernetes/ingress-nginx` | `nginxinc/kubernetes-ingress` |
| Annotation prefix | `nginx.ingress.kubernetes.io/...` | `nginx.org/...` (and its own CRDs like `VirtualServer`) |
| Underlying Nginx | Open source Nginx (with Lua/OpenResty) | Open source Nginx or Nginx Plus |
| Status | **Announced for retirement**; teams are migrating to other controllers or Gateway API implementations | Actively maintained by F5 |

## 🛠️ Practical: step by step

### Part A — Nginx in Docker

1. **Run the official image and look inside**

```bash
docker run -d --name web -p 8080:80 nginx:stable
curl -I http://localhost:8080
docker exec web ls /etc/nginx/conf.d /usr/share/nginx/html
docker exec web ls -l /var/log/nginx       # access.log -> /dev/stdout, error.log -> /dev/stderr
docker logs web
docker rm -f web
```

2. **Project layout**

```text
myapp/
├── frontend/          # React app (package.json, src/, ...)
│   ├── Dockerfile
│   └── nginx/default.conf
├── api/               # Node.js API listening on 3000
│   ├── Dockerfile
│   └── server.js
└── docker-compose.yml
```

3. **Nginx config for the container** — file: `frontend/nginx/default.conf` (copied to `/etc/nginx/conf.d/default.conf`)

```nginx
# /etc/nginx/conf.d/default.conf inside the container
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # React Router: unknown paths fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Long cache for hashed build assets
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API → the "api" service on the shared Docker network
    location /api/ {
        proxy_pass http://api:3000;            # service name, resolved by Docker DNS
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

4. **Multi-stage Dockerfile** — file: `frontend/Dockerfile`

```dockerfile
# ---------- Stage 1: build the React app ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # Vite outputs to /app/dist (Create React App uses /app/build)

# ---------- Stage 2: serve with nginx ----------
FROM nginx:stable-alpine
# Replace the default server config with ours
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
# Copy only the built static files (no node_modules, no source code)
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# The base image already runs: nginx -g 'daemon off;'
```

5. **API Dockerfile** — file: `api/Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

6. **docker-compose** — file: `docker-compose.yml`

```yaml
services:
  api:
    build: ./api
    expose:
      - "3000"              # reachable inside the network only, not from the host
    networks:
      - appnet

  web:
    build: ./frontend
    ports:
      - "80:80"             # the only public entry point
    depends_on:
      - api                 # start api first so nginx can resolve "api" at startup
    networks:
      - appnet

networks:
  appnet:
```

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f web
```

> Nginx resolves `api` when it **starts**. If the `api` container doesn't exist yet, Nginx fails with `host not found in upstream "api"`. If the API container is recreated with a new IP, reload Nginx (`docker compose exec web nginx -s reload`) or use a `resolver 127.0.0.11` with a variable in `proxy_pass` for dynamic lookups.

### Part B — Nginx as a Kubernetes Ingress controller

7. **Install the community ingress-nginx controller with Helm** (still widely deployed; check the project's retirement notice before choosing it for new clusters)

```bash
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace

kubectl get pods -n ingress-nginx
kubectl get svc -n ingress-nginx ingress-nginx-controller    # EXTERNAL-IP = your entry point
kubectl get ingressclass                                      # expect: nginx
```

8. **Create the TLS secret**

```bash
kubectl create namespace myapp
kubectl create secret tls app-tls --cert=tls.crt --key=tls.key -n myapp
```

(In production, cert-manager usually creates and renews this Secret automatically.)

9. **The Ingress resource** — file: `k8s/ingress.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  namespace: myapp
  annotations:
    # ingress-nginx annotations (prefix nginx.ingress.kubernetes.io)
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"      # = client_max_body_size
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"   # seconds
    nginx.ingress.kubernetes.io/ssl-redirect: "true"        # HTTP → HTTPS
    nginx.ingress.kubernetes.io/limit-rps: "20"             # simple per-IP rate limit
spec:
  ingressClassName: nginx            # which controller handles this Ingress
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls            # Secret with tls.crt / tls.key
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api            # Service in the same namespace
                port:
                  number: 3000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
```

```bash
kubectl apply -f k8s/ingress.yaml
```

(Assumes `Deployment` + `Service` objects named `frontend` (port 80) and `api` (port 3000) already exist in the `myapp` namespace.)

10. **See the Nginx config the controller generated**

```bash
POD=$(kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ingress-nginx "$POD" -- nginx -T | grep -A3 "server_name app.example.com"
kubectl logs -n ingress-nginx "$POD" --tail=20
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/conf.d/default.conf` (container) | Server config in the official image; replace it with your own |
| `/usr/share/nginx/html` (container) | Default web root of the official image |
| `/etc/nginx/nginx.conf` (container) | Main config; includes `conf.d/*.conf` |
| `/var/log/nginx/*.log` (container) | Symlinked to `/dev/stdout` and `/dev/stderr` → `docker logs` |
| `frontend/Dockerfile` | Multi-stage build: Node build → Nginx runtime |
| `docker-compose.yml` | Runs `web` + `api` on the shared `appnet` network |
| `k8s/ingress.yaml` | Ingress rules: host, paths, TLS secret, annotations |
| Secret `app-tls` | TLS certificate and key used by the Ingress controller |

## ✅ Verify it works

**Docker**

```bash
curl -I http://localhost/                    # expect HTTP/1.1 200 OK (React index.html)
curl -s http://localhost/api/health          # expect the API's JSON response
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/some/react/route   # expect 200
docker compose exec web nginx -t             # config test inside the container
docker compose logs web | tail -n 5          # access log lines appear here
```

**Kubernetes**

```bash
kubectl get ingress -n myapp
```

Example output:

```text
NAME    CLASS   HOSTS             ADDRESS        PORTS     AGE
myapp   nginx   app.example.com   203.0.113.50   80, 443   2m
```

```bash
kubectl describe ingress myapp -n myapp      # rules, backends, and events
# Test before DNS exists: pin the hostname to the LB IP
curl -I --resolve app.example.com:443:203.0.113.50 https://app.example.com/
curl -s --resolve app.example.com:443:203.0.113.50 https://app.example.com/api/health
```

## ⚠️ Common mistakes

- Using `proxy_pass http://localhost:3000` inside the Nginx container — `localhost` is the Nginx container itself, not the API. Use the service name.
- Copying the whole Node project (with `node_modules`) into the Nginx image instead of using a multi-stage build.
- Forgetting `try_files ... /index.html` → React routes give 404 on refresh.
- Writing logs to files inside the container instead of stdout — logs vanish with the container and `docker logs` is empty.
- Creating an Ingress without `ingressClassName` (or with the wrong one) — no controller picks it up and nothing happens.
- Mixing annotations of the two controllers: `nginx.ingress.kubernetes.io/*` is ignored by F5's controller and `nginx.org/*` is ignored by ingress-nginx.
- TLS Secret in a different namespace than the Ingress — the controller can't use it and serves its default fake certificate.

## 🔁 Follow-up questions interviewers ask

1. **What's the difference between a Kubernetes Service of type LoadBalancer and an Ingress?**
   A LoadBalancer Service gives one external IP per service (L4). An Ingress shares one entry point and routes many hosts/paths (L7) to many services.
2. **What is the Gateway API and why does it matter here?**
   It's the newer Kubernetes API for traffic routing (`Gateway`, `HTTPRoute`), more expressive and role-oriented than Ingress. With ingress-nginx being retired, many teams are moving to Gateway API implementations.
3. **How do you pass custom Nginx settings through ingress-nginx?**
   With annotations on the Ingress or the controller's ConfigMap. Snippet annotations (raw Nginx config) are disabled by default for security.
4. **Why does the official Nginx image run in the foreground?**
   A container lives as long as its main process; the image runs `nginx -g 'daemon off;'` so Nginx stays PID 1 instead of forking into the background.
5. **How do you run Nginx in a container as non-root?**
   Use `nginxinc/nginx-unprivileged`, which listens on port 8080 and runs as an unprivileged user, so it can't bind ports below 1024.

---
[⬅️ Previous](10-upstream-health-checks-and-failover.md) · [🏠 Index](../README.md) · [Next ➡️](../04-system-design/01-proxy-types-forward-reverse-and-more.md)

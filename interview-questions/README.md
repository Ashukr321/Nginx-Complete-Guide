# 🎯 Nginx Interview Questions — Practical Answers

Every question is its own file, and every file follows the same structure:

| Section | What you get |
|---|---|
| 🎯 **Short answer** | What to say out loud in the interview (3–5 sentences) |
| 🧩 **Scenario** | A realistic situation where this comes up |
| 💼 **Use case** | Where it's used in real production |
| ⚙️ **How it works** | The mechanism, with a diagram |
| 🛠️ **Practical: step by step** | Real commands and complete, commented config — and which file it goes in |
| 📁 **Files involved** | Which Nginx files/folders matter and what each does |
| ✅ **Verify it works** | Commands to prove it, with expected output |
| ⚠️ **Common mistakes** | What usually breaks |
| 🔁 **Follow-up questions** | What the interviewer asks next |

> 💡 **How to study:** read the short answer, then actually *do* the practical section on a VM or in Docker. Being able to say "I set this up myself" beats any memorized answer.

---

## 🟢 Level 1 — Basic (Fresher, 0–2 years)

Folder: [`01-basic-fresher/`](01-basic-fresher/)

| # | Question |
|---|---|
| 01 | [What is Nginx and what is it used for?](01-basic-fresher/01-what-is-nginx.md) |
| 02 | [Web server vs application server?](01-basic-fresher/02-web-server-vs-application-server.md) |
| 03 | [Why use Nginx if Node.js can already serve HTTP?](01-basic-fresher/03-why-nginx-in-front-of-nodejs.md) |
| 04 | [Reverse proxy vs forward proxy?](01-basic-fresher/04-reverse-proxy-vs-forward-proxy.md) |
| 05 | [Apache vs Nginx?](01-basic-fresher/05-apache-vs-nginx.md) |
| 06 | [How do you install and set up Nginx?](01-basic-fresher/06-install-and-setup-nginx.md) ⭐ |
| 07 | [Explain the Nginx folder structure and every file](01-basic-fresher/07-nginx-folder-structure-and-files.md) ⭐ |
| 08 | [Structure of nginx.conf — blocks, directives, contexts](01-basic-fresher/08-nginx-conf-structure-blocks-directives.md) |
| 09 | [Essential commands — start, stop, test, reload](01-basic-fresher/09-nginx-commands-start-stop-reload.md) |
| 10 | [How do you host a static website?](01-basic-fresher/10-serve-static-website.md) |
| 11 | [Server blocks, `listen` and `server_name`](01-basic-fresher/11-server-block-listen-server-name.md) |
| 12 | [What is load balancing? (basics)](01-basic-fresher/12-what-is-load-balancing-basics.md) |

## 🟡 Level 2 — Intermediate (2–5 years)

Folder: [`02-intermediate/`](02-intermediate/)

| # | Question |
|---|---|
| 01 | [How does `location` matching order work?](02-intermediate/01-location-matching-order.md) |
| 02 | [`root` vs `alias`](02-intermediate/02-root-vs-alias.md) |
| 03 | [Load-balancing methods](02-intermediate/03-load-balancing-methods.md) |
| 04 | [Enable HTTPS with Let's Encrypt / Certbot](02-intermediate/04-https-ssl-certbot-setup.md) |
| 05 | [`try_files` and React/SPA routing](02-intermediate/05-try-files-react-spa-routing.md) |
| 06 | [Proxy headers and the real client IP](02-intermediate/06-proxy-headers-real-client-ip.md) |
| 07 | [`rewrite` vs `return` — redirects](02-intermediate/07-rewrite-vs-return-redirects.md) |
| 08 | [Hosting multiple websites (virtual hosts)](02-intermediate/08-virtual-hosts-multiple-websites.md) |
| 09 | [Gzip compression and browser caching](02-intermediate/09-gzip-compression-and-browser-caching.md) |
| 10 | [Deploy a MERN / Node + React app end to end](02-intermediate/10-deploy-mern-app-with-nginx.md) ⭐ |
| 11 | [Access and error logs](02-intermediate/11-access-and-error-logs.md) |

## 🔴 Level 3 — Advanced (DevOps / SRE)

Folder: [`03-advanced/`](03-advanced/)

| # | Question |
|---|---|
| 01 | [Master/worker architecture and event-driven I/O](03-advanced/01-master-worker-event-driven-architecture.md) |
| 02 | [The C10K problem](03-advanced/02-c10k-problem.md) |
| 03 | [Zero-downtime reload and signals](03-advanced/03-zero-downtime-reload-and-signals.md) |
| 04 | [Rate limiting](03-advanced/04-rate-limiting.md) |
| 05 | [WebSocket proxy](03-advanced/05-websocket-proxy.md) |
| 06 | [Proxy caching](03-advanced/06-proxy-caching.md) |
| 07 | [Troubleshooting 502 / 504 / 413 / 403 / 404](03-advanced/07-troubleshooting-502-504-413-403-404.md) ⭐ |
| 08 | [Performance tuning](03-advanced/08-performance-tuning.md) |
| 09 | [Security hardening](03-advanced/09-security-hardening.md) |
| 10 | [Upstream health checks and failover](03-advanced/10-upstream-health-checks-and-failover.md) |
| 11 | [Nginx in Docker and Kubernetes Ingress](03-advanced/11-nginx-in-docker-and-kubernetes-ingress.md) |

## 🏛️ Level 4 — System Design (HLD rounds)

Folder: [`04-system-design/`](04-system-design/) — where Nginx fits in architecture diagrams, the concepts it implements, and the trade-offs to talk about.

| # | Question |
|---|---|
| 01 | [Proxy types — forward, reverse, LB, API gateway, CDN, sidecar](04-system-design/01-proxy-types-forward-reverse-and-more.md) ⭐ |
| 02 | [Load balancer and horizontal scaling](04-system-design/02-load-balancer-and-horizontal-scaling.md) |
| 03 | [L4 vs L7 load balancing](04-system-design/03-l4-vs-l7-load-balancing.md) |
| 04 | [Single point of failure and high availability (keepalived)](04-system-design/04-single-point-of-failure-high-availability.md) ⭐ |
| 05 | [API gateway vs reverse proxy](04-system-design/05-api-gateway-vs-reverse-proxy.md) |
| 06 | [CDN vs Nginx caching](04-system-design/06-cdn-vs-nginx-caching.md) |
| 07 | [Consistent hashing and sticky sessions](04-system-design/07-consistent-hashing-and-sticky-sessions.md) |
| 08 | [Rate-limiting algorithms (leaky bucket, token bucket…)](04-system-design/08-rate-limiting-algorithms.md) |
| 09 | [SSL termination vs passthrough vs re-encryption](04-system-design/09-ssl-termination-passthrough-reencryption.md) |
| 10 | [Design a scalable web app with Nginx (full HLD walkthrough)](04-system-design/10-design-scalable-web-app-with-nginx.md) ⭐ |

⭐ = most frequently asked / most practical — do these hands-on first.

---

🔙 Back to the [Nginx Complete Learning Roadmap](../README.md) · [Web Servers Explained](../WEB-SERVER-GUIDE.md)

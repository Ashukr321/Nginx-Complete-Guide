# Q: What is the C10K problem, and how does Nginx solve it?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Performance Engineer

## 🎯 Short answer (say this in the interview)

The C10K problem is the challenge of handling **10,000 concurrent client connections** on a single server. The name comes from Dan Kegel's 1999 article. Traditional servers created one thread or process per connection, so 10,000 connections meant 10,000 threads, each with its own stack memory and scheduler overhead. Nginx solves it with an **event-driven, non-blocking** design: a small, fixed number of worker processes each run an event loop on `epoll`/`kqueue` and handle thousands of connections. To actually reach high concurrency you also have to raise OS limits such as open files (`ulimit -n`, `worker_rlimit_nofile`) and the listen backlog (`net.core.somaxconn`).

## 🧩 Scenario

An e-commerce site runs a flash sale. Thousands of mobile users on slow networks open connections at the same time and keep them alive. The old Apache prefork server ran out of processes and RAM, and new users got timeouts. The team puts Nginx in front. On the first load test, Nginx still logs `Too many open files`. You need to explain why the architecture handles it and which OS limits still need tuning.

## 💼 Use case

- Any public website or API with many idle or slow keep-alive clients (mobile apps, long polling, WebSockets).
- Edge reverse proxies that hold client connections while slow backends respond.
- Capacity planning and load testing before big launches.

## ⚙️ How it works

**Thread-per-connection (the old way)**

```text
 10,000 clients
     │
     ▼
 ┌──────────────────────────────────────────────────────────┐
 │ server                                                   │
 │  thread 1  ── waits on client 1 (blocked)                │
 │  thread 2  ── waits on client 2 (blocked)                │
 │  ...                                                     │
 │  thread 10000 ── waits on client 10000 (blocked)         │
 │                                                          │
 │  cost: 10,000 stacks in memory + CPU spent switching     │
 │        between threads that are mostly idle              │
 └──────────────────────────────────────────────────────────┘
```

Each thread reserves its own stack (on Linux the default stack size limit is often 8 MB of virtual memory, see `ulimit -s`), and the kernel must schedule and context-switch all of them. Most of these threads are just **waiting** for a slow client.

**Event loop (the Nginx way)**

```text
 10,000 clients
     │
     ▼
 ┌──────────────────────────────────────────────────────────┐
 │ nginx                                                    │
 │  worker 1 (1 thread) ── epoll ── ~2,500 sockets          │
 │  worker 2 (1 thread) ── epoll ── ~2,500 sockets          │
 │  worker 3 (1 thread) ── epoll ── ~2,500 sockets          │
 │  worker 4 (1 thread) ── epoll ── ~2,500 sockets          │
 │                                                          │
 │  each connection = a small state struct + buffers,       │
 │  not a whole thread. Idle connections cost very little.  │
 └──────────────────────────────────────────────────────────┘
```

The worker asks the kernel "which of my sockets are ready?" and only does work for those. Idle keep-alive connections cost a little memory and one file descriptor each, not a thread.

**The OS limits you still hit**

```text
 client ──► kernel accept queue ──► nginx worker ──► file descriptor
             (net.core.somaxconn,     (worker_          (ulimit -n /
              listen backlog=)         connections)      worker_rlimit_nofile)
```

| Limit | What it controls | Where to change |
|---|---|---|
| `ulimit -n` / `LimitNOFILE` | Max open files (every socket is a file) for a process | systemd override for `nginx.service` |
| `worker_rlimit_nofile` | Max open files per Nginx worker | `/etc/nginx/nginx.conf` (main context) |
| `worker_connections` | Max connections per worker | `events {}` block |
| `net.core.somaxconn` | Max length of the kernel accept queue for a listening socket | `/etc/sysctl.d/*.conf` |
| `listen ... backlog=` | Accept queue length Nginx requests (default 511 on Linux) | `listen` directive |
| `fs.file-max` | System-wide max open files | sysctl (rarely needs changing on modern kernels) |

## 🛠️ Practical: step by step

1. **Check current limits**

```bash
ulimit -n                                  # your shell's soft limit (often 1024)
cat /proc/$(cat /run/nginx.pid)/limits | grep "open files"   # master
cat /proc/$(pgrep -f "nginx: worker" | head -1)/limits | grep "open files"  # a worker
sysctl net.core.somaxconn
```

2. **Raise the open-files limit for the Nginx service** (systemd ignores `/etc/security/limits.conf` for services)

```bash
sudo systemctl edit nginx
```

Add this in the editor (it is saved to `/etc/systemd/system/nginx.service.d/override.conf`):

```ini
[Service]
LimitNOFILE=65535
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart nginx
```

3. **Tune Nginx** — file: `/etc/nginx/nginx.conf`

```nginx
# /etc/nginx/nginx.conf

user www-data;
worker_processes auto;          # one worker per core
worker_rlimit_nofile 65535;     # each worker may open up to 65535 fds

events {
    worker_connections 16384;   # keep this below worker_rlimit_nofile
    multi_accept on;            # accept all new connections in one go
}

http {
    keepalive_timeout 30s;      # don't keep idle clients forever
    # ... rest of the default http block ...
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

4. **Raise the kernel accept queue** — file: `/etc/sysctl.d/99-nginx.conf`

```bash
sudo tee /etc/sysctl.d/99-nginx.conf > /dev/null <<'EOF'
# Max pending connections waiting in the accept queue per listening socket
net.core.somaxconn = 65535
# Allow more half-open (SYN) connections during bursts
net.ipv4.tcp_max_syn_backlog = 65535
# More local ports for outgoing connections to upstreams (reverse proxy)
net.ipv4.ip_local_port_range = 1024 65535
EOF
sudo sysctl --system
```

5. **Ask Nginx for a bigger backlog** — file: `/etc/nginx/sites-available/default`

```nginx
server {
    listen 80 default_server backlog=65535;   # capped by net.core.somaxconn
    listen [::]:80 default_server;
    root /var/www/html;
    index index.html;
}
```

> Note: the `backlog` parameter can be set only once per `ip:port` across all server blocks.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

6. **Simulate concurrent load** (run from a different machine if possible so the load tool doesn't compete for CPU)

```bash
sudo apt install -y apache2-utils wrk

# ab: 20,000 total requests, 1,000 at a time, with keep-alive
ab -n 20000 -c 1000 -k http://SERVER_IP/

# wrk: 4 threads, 10,000 open connections, for 30 seconds
ulimit -n 65535          # the load generator also needs enough fds
wrk -t4 -c10000 -d30s http://SERVER_IP/
```

7. **Watch connections while the test runs**

```bash
watch -n1 "ss -s"
ss -tan state established '( sport = :80 )' | wc -l
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | `worker_processes`, `worker_rlimit_nofile`, `worker_connections`, `multi_accept` |
| `/etc/systemd/system/nginx.service.d/override.conf` | `LimitNOFILE` for the Nginx service |
| `/etc/sysctl.d/99-nginx.conf` | Kernel limits: `somaxconn`, SYN backlog, local port range |
| `/etc/nginx/sites-available/default` | `listen ... backlog=` |
| `/var/log/nginx/error.log` | Shows `Too many open files` or `worker_connections are not enough` |

## ✅ Verify it works

```bash
cat /proc/$(pgrep -f "nginx: worker" | head -1)/limits | grep "open files"
sysctl net.core.somaxconn
ss -ltn 'sport = :80'
```

Example output:

```text
Max open files            65535                65535                files
net.core.somaxconn = 65535
State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port
LISTEN  0       65535          0.0.0.0:80          0.0.0.0:*
```

For a listening socket, `Send-Q` shows the backlog size. During the `wrk` run, check that the error log has no new `Too many open files` or `worker_connections are not enough` lines:

```bash
sudo tail -f /var/log/nginx/error.log
```

`wrk` prints requests/sec, latency and a `Socket errors` line. Compare runs before and after tuning on the same hardware; your own numbers are the only ones that matter.

## ⚠️ Common mistakes

- Editing `/etc/security/limits.conf` and expecting it to affect the systemd service. It doesn't; use `LimitNOFILE` or `worker_rlimit_nofile`.
- Setting `worker_connections` higher than the file-descriptor limit.
- Raising `backlog=` in Nginx but not `net.core.somaxconn` (the kernel silently caps it).
- Running the load tool on the same small VM as Nginx and blaming Nginx for the results.
- Forgetting that the load-generating machine also needs `ulimit -n` raised, otherwise `wrk` reports socket errors.
- Assuming C10K is "solved" just by using Nginx — a slow backend or database can still be the bottleneck.

## 🔁 Follow-up questions interviewers ask

1. **Is C10K still a problem today?**
   For Nginx at the network level, mostly no; the conversation has moved to C10M (millions). But OS limits, memory, and backends still need tuning.
2. **Why not just add more threads?**
   Threads cost memory and context switches even when idle. An event loop keeps the cost per idle connection very small.
3. **What error appears when fds run out?**
   `accept4() failed (24: Too many open files)` or `socket() failed (24: Too many open files)` in `error.log`.
4. **What is the accept queue?**
   Connections that finished the TCP handshake but were not yet `accept()`-ed by the app. If it overflows, new connections are dropped or reset.
5. **Does C10K mean 10K requests per second?**
   No. It is about 10K **concurrent connections**, not throughput.

---
[⬅️ Previous](01-master-worker-event-driven-architecture.md) · [🏠 Index](../README.md) · [Next ➡️](03-zero-downtime-reload-and-signals.md)

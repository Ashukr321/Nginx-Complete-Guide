# Q: Explain Nginx's architecture. What are the master and worker processes, and why is Nginx called "event-driven"?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Backend

## 🎯 Short answer (say this in the interview)

Nginx runs one **master process** (as root) and a few **worker processes** (as an unprivileged user like `www-data`). The master only reads the config, binds ports and manages workers; the workers do all the real work of handling client connections. Each worker is single-threaded and runs an **event loop** using the OS's efficient notification API (`epoll` on Linux, `kqueue` on BSD/macOS), so one worker can juggle thousands of connections without blocking on any one of them. That is why Nginx uses little memory and scales to many concurrent connections, unlike the classic "one thread or process per connection" model.

## 🧩 Scenario

Your team moved a Node.js API behind Nginx. During a marketing campaign, traffic jumps to several thousand concurrent users. The Node app struggles, but Nginx itself stays at low CPU and memory. Your manager asks: "Why is Nginx not breaking a sweat, and how many users can it hold before it does?" You need to explain the master/worker model, `worker_processes`, `worker_connections`, and the max-clients formula.

## 💼 Use case

- Sizing an Nginx server (CPU cores, `worker_connections`, file-descriptor limits) before a launch.
- Explaining why a `reload` does not drop traffic (the master starts new workers and old ones finish gracefully).
- Debugging "worker_connections are not enough" errors in production.
- Understanding why a slow upstream does **not** freeze Nginx, but a slow disk read sometimes can.

## ⚙️ How it works

![Nginx architecture](../../resoruces/nginx_server_architecture%20(1).png)

```text
                      ┌───────────────────────────────────────┐
                      │  MASTER process  (runs as root)       │
                      │  - reads /etc/nginx/nginx.conf        │
                      │  - binds ports 80 / 443               │
                      │  - starts / stops / reloads workers   │
                      │  - does NOT serve any requests        │
                      └───────┬───────────┬───────────┬───────┘
                              │ fork      │ fork      │ fork
              ┌───────────────▼──┐ ┌──────▼─────────┐ ┌▼────────────────────┐
              │ WORKER 1         │ │ WORKER 2       │ │ cache manager /     │
              │ (www-data)       │ │ (www-data)     │ │ cache loader        │
              │ event loop       │ │ event loop     │ │ (only if            │
              │ thousands of     │ │ thousands of   │ │  proxy_cache_path   │
              │ connections      │ │ connections    │ │  is configured)     │
              └───────┬──────────┘ └──────┬─────────┘ └─────────────────────┘
                      │                   │
                      ▼                   ▼
                 clients / upstreams (all sockets are non-blocking)
```

**Process types**

| Process | User | Job |
|---|---|---|
| Master | root | Reads/validates config, opens listening sockets and log files, forks workers, handles signals (reload, stop, reopen logs). Needs root to bind ports below 1024. |
| Worker | `www-data` on Ubuntu (set by the `user` directive) | Accepts connections, reads requests, serves files, proxies to upstreams, writes responses. |
| Cache manager | `www-data` | Runs periodically and removes cache entries to keep the cache under `max_size`. Only exists if `proxy_cache_path` (or similar) is configured. |
| Cache loader | `www-data` | Runs once at startup to load cache metadata from disk into shared memory, then exits. |

**The event loop inside one worker**

```text
   worker event loop (single thread)
   ┌────────────────────────────────────────────────────────────┐
   │ 1. epoll_wait()  →  "which sockets are ready?"             │
   │ 2. socket A readable   → read request bytes, parse headers │
   │ 3. socket B writable   → send next chunk of response       │
   │ 4. upstream C readable → read backend reply, forward it    │
   │ 5. nothing ready on D  → skip it, do NOT wait for it       │
   │ 6. go back to step 1                                       │
   └────────────────────────────────────────────────────────────┘
```

A worker never says "I will wait here until this client sends more data." Every socket is **non-blocking**. If a socket is not ready, the worker moves on to another one and gets notified by the kernel later. This is why one worker can handle many slow clients at the same time.

**Why workers don't block (and the one caveat)**

- Network I/O (clients and upstreams) is fully non-blocking and event-driven.
- Disk I/O is the exception: a regular file read can block the worker if the file is not in the OS page cache. For heavy static-file workloads on slow disks, Nginx offers `aio threads;` (thread pools) to move blocking reads off the event loop.

**Max clients formula**

```text
max_clients = worker_processes × worker_connections
```

Caveat: `worker_connections` counts **all** connections a worker has open, including connections **to upstream servers**, not just clients. When Nginx is a reverse proxy, each client request usually uses two connections (client → Nginx and Nginx → backend), so a rough estimate is:

```text
max_clients (reverse proxy) ≈ (worker_processes × worker_connections) / 2
```

The real limit is also capped by the open-files limit (`worker_rlimit_nofile` / `ulimit -n`), because every connection is a file descriptor.

## 🛠️ Practical: step by step

1. **Install Nginx (Ubuntu 22.04/24.04)**

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

2. **Check how many CPU cores you have** (with `worker_processes auto`, Nginx starts one worker per core)

```bash
nproc
```

3. **Look at the top of the main config** — file: `/etc/nginx/nginx.conf`

```nginx
# /etc/nginx/nginx.conf  (main context — top of the file)

user www-data;                 # workers run as this unprivileged user
worker_processes auto;         # one worker per CPU core
pid /run/nginx.pid;            # master process PID is written here
worker_rlimit_nofile 65535;    # max open files (fds) per worker

events {
    worker_connections 4096;   # max simultaneous connections PER worker
    # use epoll;               # Linux picks epoll automatically; no need to set it
    # multi_accept on;         # accept all pending connections at once
}

http {
    include /etc/nginx/mime.types;
    # ... rest of the default Ubuntu http block ...
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

4. **Test and reload**

```bash
sudo nginx -t
sudo systemctl reload nginx
```

5. **See the processes**

```bash
ps -ef | grep [n]ginx
```

Example output on a 2-core VM:

```text
root        1201       1  0 10:00 ?        00:00:00 nginx: master process /usr/sbin/nginx -g daemon on; master_process on;
www-data    1202    1201  0 10:00 ?        00:00:00 nginx: worker process
www-data    1203    1201  0 10:00 ?        00:00:00 nginx: worker process
```

Notice: the master's parent is PID 1 (systemd), and the workers' parent (PPID) is the master.

6. **(Optional) See the cache processes appear** — add a cache path in a file such as `/etc/nginx/conf.d/cache.conf`:

```nginx
# /etc/nginx/conf.d/cache.conf  (included inside the http block)
proxy_cache_path /var/cache/nginx/demo levels=1:2 keys_zone=demo_cache:10m max_size=100m inactive=10m;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
ps -ef | grep [n]ginx
```

Example output (the loader disappears after about a minute once it has finished):

```text
root        1201       1  0 10:00 ?  00:00:00 nginx: master process /usr/sbin/nginx -g daemon on; master_process on;
www-data    1310    1201  0 10:05 ?  00:00:00 nginx: worker process
www-data    1311    1201  0 10:05 ?  00:00:00 nginx: worker process
www-data    1312    1201  0 10:05 ?  00:00:00 nginx: cache manager process
www-data    1313    1201  0 10:05 ?  00:00:00 nginx: cache loader process
```

7. **Check that your build supports thread pools** (used by `aio threads` for blocking disk reads). On Linux, Nginx picks `epoll` automatically, so there is nothing to configure for the event method.

```bash
nginx -V 2>&1 | tr ' ' '\n' | grep -- '--with-threads'
```

Expected output: `--with-threads` (the Ubuntu package is built with it).

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Main config: `user`, `worker_processes`, `worker_rlimit_nofile`, `events { worker_connections }` |
| `/run/nginx.pid` | PID of the master process (used for signals) |
| `/etc/nginx/conf.d/*.conf` | Extra http-level config (e.g. `proxy_cache_path`) |
| `/var/log/nginx/error.log` | Shows warnings like `worker_connections are not enough` |
| `/var/cache/nginx/` | Cache files managed by the cache manager/loader processes |

## ✅ Verify it works

```bash
# 1. Count workers — should equal nproc when worker_processes auto
ps -ef | grep "[n]ginx: worker" | wc -l
nproc

# 2. Confirm users: master = root, workers = www-data
ps -o user,pid,ppid,cmd -C nginx

# 3. Confirm the open-files limit a worker actually got
cat /proc/$(pgrep -f "nginx: worker" | head -1)/limits | grep "open files"
```

Example output of step 3 (after setting `worker_rlimit_nofile 65535`):

```text
Max open files            65535                65535                files
```

## ⚠️ Common mistakes

- Setting `worker_processes` much higher than the number of cores. More workers than cores just adds context switching.
- Raising `worker_connections` without raising the file-descriptor limit. You will see `Too many open files` in `error.log`.
- Forgetting that upstream connections also count toward `worker_connections` when proxying.
- Thinking the master serves requests. It does not; only workers do.
- Running workers as root (`user root;`). A bug in a worker would then have full system access.
- Putting `worker_connections` outside the `events` block — it is only valid inside `events {}`.

## 🔁 Follow-up questions interviewers ask

1. **Why does the master need root?**
   To bind privileged ports (80/443) and open files like certificates and logs. Workers then drop to an unprivileged user.
2. **What happens if a worker crashes?**
   The master notices (via SIGCHLD) and starts a replacement worker automatically. Other workers keep serving traffic.
3. **What is the difference between epoll and select/poll?**
   `select`/`poll` scan the whole list of sockets on every call (cost grows with connections). `epoll` returns only the sockets that are ready, so it scales to many connections.
4. **Can a single worker still block?**
   Yes, on blocking disk reads or heavy CPU work (e.g. large gzip at a high level). Use `aio threads`, page cache, and sensible gzip levels to reduce this.
5. **How many clients can this server handle?**
   Roughly `worker_processes × worker_connections`, halved when reverse proxying, and also limited by file descriptors, memory, and how fast the backend is.

---
[⬅️ Previous](../02-intermediate/11-access-and-error-logs.md) · [🏠 Index](../README.md) · [Next ➡️](02-c10k-problem.md)

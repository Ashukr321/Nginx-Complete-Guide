# Q: How does Nginx reload its configuration with zero downtime? Which signals does it use?

> **Level:** Advanced · **Asked in:** DevOps, SRE, Platform Engineer, Release Engineer

## 🎯 Short answer (say this in the interview)

I always run `sudo nginx -t` first and only then `sudo nginx -s reload` (or `systemctl reload nginx`). A reload sends **SIGHUP** to the master. The master re-reads and validates the config; if it is valid, it starts **new workers** with the new config and tells the **old workers to shut down gracefully**: they stop accepting new connections but finish the requests they are already serving. The listening sockets stay open the whole time, so no client is refused. If the new config is invalid, the master logs an error and keeps running with the old config and old workers, so a bad reload does not take the site down.

## 🧩 Scenario

You need to add a new `location /api/v2/` block to a busy production server at 2 PM. A `restart` would kill every in-flight request, including file uploads and payment calls. You must apply the change without dropping a single connection, and you need to prove it worked.

## 💼 Use case

- Deploying config changes (new vhost, new upstream, SSL certificate renewal) during business hours.
- Certbot renewals: the renew hook usually runs `systemctl reload nginx` so the new certificate is picked up.
- Log rotation: `logrotate` sends **USR1** so Nginx reopens its log files.
- Upgrading the Nginx binary itself without downtime (USR2 + WINCH + QUIT).

## ⚙️ How it works

```text
  admin: nginx -t  ✔  then  nginx -s reload   (= kill -HUP <master pid>)
                                │
                                ▼
                      ┌──────────────────────┐
                      │ MASTER receives HUP  │
                      │ 1. re-read config    │
                      │ 2. validate it       │──── invalid? ──► log [emerg] in error.log,
                      │ 3. open new sockets  │                  keep OLD workers running.
                      │    / logs if needed  │                  Nothing changes.
                      └──────────┬───────────┘
                                 │ valid
              ┌──────────────────┴───────────────────┐
              ▼                                      ▼
   start NEW workers (new config)        send QUIT to OLD workers
   they accept NEW connections           they stop accepting, finish
                                         in-flight requests, then exit
              │                                      │
              └──────── listening socket on :80/:443 stays open ───┘
                         (owned by the master) → no refused clients
```

**Signals the master understands**

| Signal | `nginx -s` equivalent | What it does |
|---|---|---|
| `TERM`, `INT` | `nginx -s stop` | Fast shutdown: workers exit immediately, in-flight requests are cut. |
| `QUIT` | `nginx -s quit` | Graceful shutdown: finish current requests, then exit. |
| `HUP` | `nginx -s reload` | Reload config, start new workers, gracefully stop old ones. |
| `USR1` | `nginx -s reopen` | Reopen log files (used after log rotation). |
| `USR2` | — | Start a new master with a **new binary** (on-the-fly upgrade). |
| `WINCH` | — | Gracefully shut down the workers of a master (master stays alive). |

**On-the-fly binary upgrade**

```text
 old master (pid 100) + old workers
        │  kill -USR2 100
        ▼
 /run/nginx.pid renamed to /run/nginx.pid.oldbin
 new master (pid 200) starts with the NEW binary + new workers
 → both old and new workers accept traffic for a moment
        │  kill -WINCH 100     (old workers finish and exit, old master stays)
        ▼
 only new workers serve traffic. Test it.
        │
        ├── all good  → kill -QUIT 100   (old master exits, upgrade done)
        └── problem   → kill -HUP 100    (old master starts its workers again)
                        kill -QUIT 200   (new master exits, rollback done)
```

## 🛠️ Practical: step by step

1. **Make a config change** — file: `/etc/nginx/sites-available/default`

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root /var/www/html;
    index index.html;

    # NEW: a simple endpoint to prove the reload took effect
    location = /version {
        default_type text/plain;
        return 200 "config v2\n";
    }
}
```

2. **Validate, then reload** (the `&&` means reload only runs if the test passes)

```bash
sudo nginx -t && sudo nginx -s reload
# or, the systemd way on Ubuntu:
sudo nginx -t && sudo systemctl reload nginx
```

Expected output of `nginx -t`:

```text
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

3. **Watch the workers get replaced** (worker PIDs change, master PID stays the same)

```bash
ps -o pid,ppid,user,cmd -C nginx      # before
sudo nginx -s reload
ps -o pid,ppid,user,cmd -C nginx      # after: new worker PIDs, same master PID
```

During the reload you may briefly see old workers labelled `nginx: worker process is shutting down` while they finish long requests.

4. **Prove there is no downtime** — run this in a second terminal while you reload several times:

```bash
while true; do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost/version
  sleep 0.1
done
```

You should see only `200` lines, never `000` (connection refused) or `502`.

5. **See what happens with a broken config**

```bash
# introduce a typo (missing semicolon) on purpose
sudo sed -i 's|return 200 "config v2\\n";|return 200 "config v2\\n"|' /etc/nginx/sites-available/default
sudo nginx -t                    # fails and tells you the file and line
sudo nginx -s reload             # also fails: the nginx CLI parses the config before signalling
sudo kill -HUP $(cat /run/nginx.pid)   # send HUP straight to the master to see ITS behaviour
sudo tail -n 3 /var/log/nginx/error.log
curl -s http://localhost/version # still works: old config is still running
```

Example error-log line (written by the master, which then keeps the old workers):

```text
[emerg] 2345#2345: unexpected "}" in /etc/nginx/sites-enabled/default:13
```

Fix the typo (add the `;` back), then `sudo nginx -t && sudo systemctl reload nginx`.

> Note: `systemctl restart nginx` with a broken config is different — it **stops** Nginx first and then fails to start, which is real downtime. That is why you never skip `nginx -t`.

6. **Reopen logs after rotation** (what `/etc/logrotate.d/nginx` does on Ubuntu)

```bash
sudo mv /var/log/nginx/access.log /var/log/nginx/access.log.1
sudo nginx -s reopen          # same as: sudo kill -USR1 $(cat /run/nginx.pid)
ls -l /var/log/nginx/         # a fresh access.log is created
```

7. **On-the-fly binary upgrade** (after the new binary has been installed at `/usr/sbin/nginx`)

```bash
sudo kill -USR2 $(cat /run/nginx.pid)          # start new master with new binary
ls /run/nginx.pid*                              # nginx.pid (new) and nginx.pid.oldbin (old)
sudo kill -WINCH $(cat /run/nginx.pid.oldbin)  # old workers finish and exit
curl -I http://localhost/                       # test the new version
sudo kill -QUIT $(cat /run/nginx.pid.oldbin)   # old master exits — done
```

> Package managers usually handle upgrades with a restart or their own upgrade logic. Practise the manual USR2 method on a test VM; in production it is mostly used with custom-built Nginx binaries.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/nginx/nginx.conf` | Main config re-read on every reload |
| `/etc/nginx/sites-available/default` | The vhost we changed |
| `/run/nginx.pid` | Master PID — target for `kill -HUP/-USR1/-USR2` |
| `/run/nginx.pid.oldbin` | Old master's PID during a binary upgrade |
| `/var/log/nginx/error.log` | Shows `[emerg]` when a reload is rejected |
| `/etc/logrotate.d/nginx` | Rotates logs and signals Nginx to reopen them |
| `/usr/lib/systemd/system/nginx.service` | Defines what `systemctl reload nginx` runs |

## ✅ Verify it works

```bash
curl -s http://localhost/version
```

Expected: `config v2`

```bash
sudo grep -E "reconfiguring|signal" /var/log/nginx/error.log | tail
```

These messages are logged at `notice` level. With Ubuntu's default `error_log /var/log/nginx/error.log;` (level `error`) you will not see them. To see them temporarily, set `error_log /var/log/nginx/error.log notice;` in `nginx.conf`. Example output:

```text
[notice] 1201#1201: signal 1 (SIGHUP) received from 2400, reconfiguring
[notice] 1201#1201: reconfiguring
[notice] 1201#1201: start worker process 2401
[notice] 1202#1202: gracefully shutting down
```

## ⚠️ Common mistakes

- Running `systemctl restart` instead of `reload` for config changes — restart drops in-flight connections.
- Skipping `nginx -t` and finding out about a typo only when a later restart (or server reboot) fails.
- Expecting old workers to vanish immediately. Long requests or WebSockets keep old workers alive; use `worker_shutdown_timeout 30s;` (main context) to cap how long they can linger.
- Forgetting `nginx -t` may need `sudo` — without it you get permission errors on certificates or the PID file, not real config errors.
- Sending signals to a worker PID instead of the master PID.

## 🔁 Follow-up questions interviewers ask

1. **What's the difference between `reload` and `restart`?**
   Reload keeps the master and listening sockets and swaps workers gracefully. Restart stops everything and starts again, dropping connections.
2. **What does `nginx -T` do?**
   Tests the config and also prints the full, merged configuration (all included files), which is great for debugging.
3. **Why might old workers stay around for a long time after reload?**
   They are still serving long-lived connections (downloads, WebSockets). `worker_shutdown_timeout` forces them to close after a time limit.
4. **What does `nginx -s reopen` do and when is it used?**
   Sends USR1 so Nginx reopens log files; logrotate uses it after moving the old logs.
5. **How do you roll back a failed binary upgrade?**
   Send HUP to the old master to bring its workers back, then QUIT to the new master.

---
[⬅️ Previous](02-c10k-problem.md) · [🏠 Index](../README.md) · [Next ➡️](04-rate-limiting.md)

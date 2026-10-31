# Q: What are the essential Nginx commands? What is the difference between reload and restart?

> **Level:** Basic (Fresher) · **Asked in:** DevOps, SRE, Linux Admin, Support/Operations

## 🎯 Short answer (say this in the interview)

I always run **`sudo nginx -t`** first to test the config, and then **`sudo systemctl reload nginx`** to apply it. `nginx -T` tests and prints the full merged config. `nginx -s` sends signals to the running master: `reload` (re-read config), `quit` (graceful stop), `stop` (fast stop) and `reopen` (reopen log files). With systemd I use `start`, `stop`, `restart`, `reload`, `status`, `enable`, and `journalctl -u nginx` for logs. **Reload** is graceful: the master starts new workers with the new config and lets old workers finish their current requests, so there is no downtime; and if the new config is invalid, the old one keeps running. **Restart** stops the whole process and starts it again, which drops connections - needed only for things like a binary upgrade or after some changes that reload cannot apply.

## 🧩 Scenario

It is Friday evening and you must change a `proxy_pass` port on a production server that handles live traffic. A restart would cut active downloads and WebSocket connections, and if the config has a typo, Nginx would not come back up at all. The safe path: edit → `sudo nginx -t` → `sudo systemctl reload nginx` → check status and logs → `curl` the site.

## 💼 Use case

- Daily config changes on production (test + reload).
- CI/CD pipelines and Ansible handlers (`nginx -t` as a validation step, then reload).
- Log rotation (`nginx -s reopen` / `USR1` signal, used by logrotate).
- Troubleshooting a failed start (`systemctl status`, `journalctl -u nginx`).
- Containers (`docker exec <name> nginx -s reload`).

## ⚙️ How it works

### Signals behind the commands

| Command | Signal to master | What happens |
|---|---|---|
| `nginx -s reload` / `systemctl reload nginx` | `HUP` | Check new config → start new workers → old workers finish requests and exit |
| `nginx -s quit` | `QUIT` | Graceful shutdown: finish current requests, then exit |
| `nginx -s stop` | `TERM` | Fast shutdown: exit immediately |
| `nginx -s reopen` | `USR1` | Reopen log files (after logrotate moved them) |
| (manual) `kill -USR2 <pid>` | `USR2` | Start a new binary for live upgrade (advanced) |

`nginx -s ...` finds the master using the PID file (`/run/nginx.pid` on Ubuntu).

### Reload vs restart

```text
RELOAD (graceful, no downtime)
  master (pid 1000) -- HUP --> parse new config
        |                  |
        |   config OK?  ---+--- NO  -> log "[emerg] ..." in error.log,
        |                  |          keep old workers, keep serving (old config)
        |                 YES
        v
  start NEW workers (new config) ----> new requests go here
  tell OLD workers to finish        ----> old requests complete, then old workers exit
  master PID stays the same

RESTART (stop + start)
  stop master + all workers   -> open connections are dropped
  start again                 -> systemd runs "nginx -t" first (ExecStartPre)
                                 if the config is broken -> nginx stays DOWN
```

Ubuntu's unit file (`systemctl cat nginx`) shows this:

```text
ExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'
ExecStart=/usr/sbin/nginx -g 'daemon on; master_process on;'
ExecReload=/usr/sbin/nginx -g 'daemon on; master_process on;' -s reload
```

So `systemctl reload nginx` does `nginx -s reload`. If the config is bad, the reload command may look fine to you while Nginx silently keeps the old config - that is why you **test first**.

## 🛠️ Practical: step by step

### 1. Test and inspect config

```bash
sudo nginx -t                  # test syntax + files (certs, includes) of /etc/nginx/nginx.conf
sudo nginx -t -q               # same, but print only errors (good for scripts)
sudo nginx -T                  # test AND print the full merged config (all includes)
sudo nginx -T | less           # scroll through it
sudo nginx -T | grep -n server_name     # find every server_name
sudo nginx -t -c /path/to/other.conf    # test a different main config file
```

### 2. Version and build info

```bash
nginx -v                       # nginx version: nginx/1.xx.x (Ubuntu)
nginx -V                       # + compiler and ./configure arguments (modules, paths)
nginx -h                       # list all command-line options
```

### 3. Control the running process with signals (`-s`)

```bash
sudo nginx -s reload           # re-read config gracefully
sudo nginx -s reopen           # reopen log files
sudo nginx -s quit             # graceful stop
sudo nginx -s stop             # fast stop
sudo nginx                     # start (without systemd) using /etc/nginx/nginx.conf
sudo nginx -c /etc/nginx/test.conf   # start with another main config file
sudo nginx -g 'daemon off;'    # run in foreground (this is how Docker runs it)
```

> On a systemd server prefer `systemctl` for start/stop so systemd knows the real state. Mixing `sudo nginx` (manual start) with `systemctl` can confuse it.

### 4. systemd commands

```bash
sudo systemctl start nginx
sudo systemctl stop nginx
sudo systemctl restart nginx      # full stop + start (drops connections)
sudo systemctl reload nginx       # graceful config reload
sudo systemctl reload-or-restart nginx   # reload if running, else start
systemctl status nginx --no-pager # state, PIDs, last log lines
sudo systemctl enable nginx       # start on boot
sudo systemctl disable nginx      # do not start on boot
sudo systemctl enable --now nginx # enable + start in one command
systemctl is-active nginx         # active / inactive / failed
```

### 5. Logs

```bash
sudo journalctl -u nginx -n 50 --no-pager   # last 50 lines from systemd about nginx
sudo journalctl -u nginx -f                 # follow live
sudo journalctl -u nginx --since "10 min ago"
sudo tail -f /var/log/nginx/error.log       # nginx's own error log
sudo tail -f /var/log/nginx/access.log      # every request
```

### 6. The safe "test then reload" habit

Use `&&` so the reload only runs if the test passes:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Or keep it as a small shell function in `~/.bashrc`:

```bash
# ~/.bashrc
ngx-reload() {
  sudo nginx -t && sudo systemctl reload nginx && echo "nginx reloaded OK"
}
```

Full workflow for any change:

```bash
sudo cp /etc/nginx/sites-available/api /etc/nginx/sites-available/api.bak.$(date +%F)   # 1. backup (outside sites-enabled!)
sudo nano /etc/nginx/sites-available/api                                               # 2. edit
sudo nginx -t                                                                          # 3. test
sudo systemctl reload nginx                                                            # 4. apply
systemctl status nginx --no-pager                                                      # 5. still active?
curl -I http://localhost/                                                              # 6. works?
sudo tail -n 20 /var/log/nginx/error.log                                               # 7. any new errors?
```

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/usr/sbin/nginx` | The binary that all `nginx ...` commands run |
| `/etc/nginx/nginx.conf` | Config tested by `nginx -t` (unless `-c` is given) |
| `/run/nginx.pid` | Master PID; `nginx -s` uses it to send signals |
| `/lib/systemd/system/nginx.service` | Defines what `systemctl start/stop/reload` actually run |
| `/var/log/nginx/error.log` | Shows reload failures (`[emerg]`) and runtime errors |
| `/etc/logrotate.d/nginx` | Rotates logs and makes nginx reopen them (USR1) |

## ✅ Verify it works

```bash
sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

# prove reload is graceful: master PID stays the same, worker PIDs change
ps -o pid,ppid,cmd -C nginx
sudo systemctl reload nginx
ps -o pid,ppid,cmd -C nginx
#   PID  PPID CMD
#  1000     1 nginx: master process /usr/sbin/nginx -g daemon on; master_process on;
#  2345  1000 nginx: worker process          <- new PIDs after reload

systemctl status nginx --no-pager | head -n 5
# Active: active (running) since ...

curl -I http://localhost/
# HTTP/1.1 200 OK
```

What a failed test looks like:

```text
nginx: [emerg] unexpected "}" in /etc/nginx/sites-enabled/api:14
nginx: configuration file /etc/nginx/nginx.conf test failed
```

## ⚠️ Common mistakes

- Running `restart` for every small change - it drops connections; use `reload`.
- Reloading without `nginx -t`, then thinking the change is live when Nginx actually rejected it and kept the old config.
- Restarting with a broken config → Nginx does not start → full outage.
- Running `nginx -t` without `sudo` → false errors like `open() "/run/nginx.pid" failed (13: Permission denied)` or cannot read SSL keys.
- Saving backup files (e.g. `api.bak`) inside `sites-enabled/` - they get loaded too.
- Starting Nginx manually with `sudo nginx` and then `systemctl start nginx` fails with "Address already in use".

## 🔁 Follow-up questions interviewers ask

- **When do you need a restart instead of reload?** After upgrading the Nginx binary (or use the USR2 live upgrade), or if a reload cannot apply something (rare); most config changes, including new SSL certificates, only need a reload.
- **What is the difference between `-s stop` and `-s quit`?** `stop` = fast shutdown (TERM); `quit` = graceful, waits for current requests (QUIT).
- **What is `nginx -T` used for?** To see the final config after all `include`s - useful for debugging and for sharing config in a ticket.
- **How does logrotate work with Nginx?** It renames the log files and then signals Nginx (USR1 / `reopen`) to open new files.
- **How do you reload Nginx in Docker?** `docker exec <container> nginx -t && docker exec <container> nginx -s reload`.

---
[⬅️ Previous](08-nginx-conf-structure-blocks-directives.md) · [🏠 Index](../README.md) · [Next ➡️](10-serve-static-website.md)

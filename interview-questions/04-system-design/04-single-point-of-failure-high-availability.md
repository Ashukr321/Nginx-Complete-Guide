# Q: If Nginx is your only load balancer, isn't it a single point of failure? How do you make it highly available?

> **Level:** System Design · **Asked in:** DevOps, SRE, Platform Engineer, Cloud, System Design round

## 🎯 Short answer (say this in the interview)

Yes. A **single point of failure (SPOF)** is any component whose failure takes the whole system down, and one Nginx box in front of ten app servers is exactly that. To remove it I run **at least two** Nginx nodes with the **same config** and make failover automatic. On-prem or on VMs, the classic way is **active-passive with keepalived**: both nodes run Nginx, keepalived uses the **VRRP** protocol to give a **floating virtual IP (VIP)** to the MASTER; DNS points to the VIP. A `vrrp_script` checks Nginx every few seconds, and if Nginx or the whole node dies, the BACKUP takes the VIP within a few seconds. For **active-active**, both nodes serve traffic — via DNS records for both, or two VIPs. In the cloud I usually put a **managed load balancer** (AWS NLB/ALB, which is already redundant across availability zones) in front of several Nginx nodes, because floating IPs don't work there by plain ARP. Either way, configs must be kept **in sync** with automation, and I measure the result in **"nines"**: 99.9% is about 8.76 hours of downtime a year, 99.99% about 52.6 minutes.

## 🧩 Scenario

Your company's whole product goes through one Nginx VM at `192.168.1.10`. One night the VM's host has a hardware fault: Nginx is gone, the ten healthy app servers behind it receive no traffic, and the site is down for 40 minutes until someone rebuilds the VM. The post-incident review action item: *"The load balancer must survive the loss of one node with no manual work."* In the system design round, the interviewer points at your single LB box and asks the same question.

## 💼 Use case

- On-prem / bare-metal / VM data centers where you control layer 2 networking → keepalived + VIP.
- Cloud deployments → cloud LB in front of an Nginx fleet (or Nginx as Kubernetes Ingress with multiple replicas).
- Any SLA/SLO target like 99.9% or 99.99% that one machine cannot meet.
- Zero-downtime maintenance: patch or reboot one LB node while the other serves traffic.

## ⚙️ How it works

**Where it sits in an HLD diagram:** Users → DNS (VIP or cloud LB) → **Nginx LB pair (MASTER + BACKUP, keepalived)** → App servers → DB.

**Before: SPOF**

```text
  Users ──► nginx-1 (192.168.1.10) ──► app-1 … app-10
                 ✖  dies → everything is down, even though all apps are healthy
```

**Active-passive with keepalived (VRRP + floating VIP)**

```text
                          DNS: app.example.com → 192.168.1.100 (VIP)
                                        │
                      ┌─────────────────┴─────────────────┐
                      ▼                                    ▼
          ┌──────────────────────┐   VRRP adverts   ┌──────────────────────┐
          │ lb1  192.168.1.11    │ ◄──────────────► │ lb2  192.168.1.12    │
          │ MASTER, priority 110 │  (every 1s)      │ BACKUP, priority 100 │
          │ holds VIP .100       │                  │ waiting              │
          │ nginx + keepalived   │                  │ nginx + keepalived   │
          └──────────┬───────────┘                  └──────────┬───────────┘
                     └──────────────┬─────────────────────────┘
                                    ▼
                         app-1  app-2  app-3 ...

  lb1's nginx check fails (or lb1 dies, adverts stop)
     → lb2 becomes MASTER, adds 192.168.1.100 to its interface,
       sends gratuitous ARP so the switch/router learns the new MAC
     → clients keep using the same IP; failover usually takes a few seconds
```

**Active-active options**

```text
  A) DNS round robin:    app.example.com → 192.168.1.100 (VIP-A, MASTER on lb1)
                                          → 192.168.1.101 (VIP-B, MASTER on lb2)
     Each node is BACKUP for the other's VIP → both serve traffic, either can take both.

  B) Cloud LB in front:  Users → AWS NLB (multi-AZ, managed) → nginx-a, nginx-b, nginx-c → apps
```

| Approach | Pros | Cons |
|---|---|---|
| Active-passive (keepalived VIP) | Simple, fast failover, clients use one IP | Backup node idle; needs L2 network that allows VRRP/gratuitous ARP |
| Active-active, DNS round robin only | Both nodes used | DNS caching (TTL) — clients keep hitting a dead IP until they retry/re-resolve |
| Active-active, two VIPs + keepalived | Both used, fast failover | Each node must handle 100% load alone |
| Cloud LB in front of Nginx fleet | Provider runs HA across AZs; autoscaling | Cost, another hop, less control |

**Availability "nines" — the math**

Downtime per year = (1 − availability) × 365 days × 24 h = (1 − A) × 8,760 h.

| Availability | Downtime per year | Downtime per month (year ÷ 12) |
|---|---|---|
| 99% ("two nines") | 87.6 h ≈ 3.65 days | ≈ 7.3 h |
| 99.9% ("three nines") | 0.001 × 8,760 h = **8.76 h** | ≈ 43.8 min |
| 99.95% | 4.38 h | ≈ 21.9 min |
| 99.99% ("four nines") | 0.0001 × 525,600 min = **52.56 min** | ≈ 4.4 min |
| 99.999% ("five nines") | ≈ 5.26 min | ≈ 26 s |

- **Components in series** (all must work): A = A1 × A2. LB 99.9% × app tier 99.9% ≈ 99.8%.
- **Redundant components in parallel** (one is enough): A = 1 − (1 − A1) × (1 − A2). Two 99.9% LBs → 1 − 0.001 × 0.001 = 99.9999% **in theory** — this assumes independent failures and instant failover, which real systems never fully have (same rack, same bad config, same bug).

Health checks for the **app servers** behind Nginx are covered in [health checks and failover](../03-advanced/10-upstream-health-checks-and-failover.md). This page is about the LB tier itself.

## 🛠️ Practical: step by step

Lab: two Ubuntu VMs on the same subnet — `lb1` = `192.168.1.11`, `lb2` = `192.168.1.12`, VIP = `192.168.1.100`, interface `eth0` (check yours with `ip -br addr`).

1. **Install Nginx and keepalived on both nodes**

```bash
sudo apt update
sudo apt install -y nginx keepalived
```

2. **Put an identical Nginx config on both nodes** (your normal `upstream` + `server` config). For the demo, make each node say who it is:

```bash
echo "served by $(hostname)" | sudo tee /var/www/html/index.html
```

Nginx `listen 80;` binds to all addresses, so it accepts traffic on the VIP when the VIP arrives. (Only if you write `listen 192.168.1.100:80;` do you need `net.ipv4.ip_nonlocal_bind = 1` in `/etc/sysctl.conf` on both nodes, so Nginx can start on the node that doesn't hold the VIP.)

3. **Allow VRRP between the nodes** — VRRP is IP protocol 112, sent to multicast `224.0.0.18`. If you use a host firewall, allow it from the peer, e.g. on lb1:

```bash
sudo iptables -I INPUT -p 112 -s 192.168.1.12 -j ACCEPT    # on lb2 use -s 192.168.1.11
```

(Make it permanent with your firewall tool; with no firewall rules nothing is needed.)

4. **keepalived config on lb1 (MASTER)** — file: `/etc/keepalived/keepalived.conf`

```text
global_defs {
    router_id lb1
    enable_script_security          # refuse check scripts that non-root users could modify
    script_user root
}

# Health check: exit code 0 = nginx running, non-zero = failed
vrrp_script chk_nginx {
    script "/usr/bin/systemctl is-active --quiet nginx"
    interval 2                      # run every 2 seconds
    fall 2                          # 2 failures in a row = FAULT
    rise 2                          # 2 successes in a row = OK again
}

vrrp_instance VI_1 {
    state MASTER                    # starting role; the priority decides the real winner
    interface eth0                  # NIC that carries the VIP
    virtual_router_id 51            # must be the same on both nodes, unique on this LAN
    priority 110                    # higher wins
    advert_int 1                    # send VRRP advertisement every 1 second

    authentication {                # simple shared password (max 8 chars); not real security
        auth_type PASS
        auth_pass Lb2026ha
    }

    virtual_ipaddress {
        192.168.1.100/24 dev eth0   # the floating IP clients use
    }

    track_script {
        chk_nginx                   # if it fails, this node goes to FAULT and releases the VIP
    }
}
```

5. **keepalived config on lb2 (BACKUP)** — file: `/etc/keepalived/keepalived.conf`

```text
global_defs {
    router_id lb2
    enable_script_security
    script_user root
}

vrrp_script chk_nginx {
    script "/usr/bin/systemctl is-active --quiet nginx"
    interval 2
    fall 2
    rise 2
}

vrrp_instance VI_1 {
    state BACKUP                    # different from lb1
    interface eth0
    virtual_router_id 51            # SAME as lb1
    priority 100                    # LOWER than lb1
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass Lb2026ha          # SAME as lb1
    }

    virtual_ipaddress {
        192.168.1.100/24 dev eth0   # SAME VIP
    }

    track_script {
        chk_nginx
    }
}
```

The check could also be `script "/usr/bin/pidof nginx"`; `systemctl is-active` is a bit stricter because it follows the service state. If the network blocks multicast, add `unicast_src_ip 192.168.1.11` and `unicast_peer { 192.168.1.12 }` (swapped on lb2) inside `vrrp_instance`.

6. **Start keepalived on both nodes**

```bash
sudo systemctl enable --now keepalived
sudo systemctl status keepalived --no-pager
```

7. **Keep Nginx configs in sync** — the BACKUP is useless if its config is old. Use Ansible or a Git-based pipeline in real life; a simple manual version run from lb1:

```bash
sudo nginx -t && \
rsync -az --delete --rsync-path="sudo rsync" /etc/nginx/ admin@192.168.1.12:/etc/nginx/ && \
ssh admin@192.168.1.12 'sudo nginx -t && sudo systemctl reload nginx' && \
sudo systemctl reload nginx
```

(`admin` must have passwordless `sudo` for `rsync`, `nginx` and `systemctl` on lb2. Keep TLS certificates in sync too, or renew them on both nodes.)

8. **Cloud caveat (AWS and similar)** — VPCs don't support multicast, and a gratuitous ARP does not move an IP in a cloud network. Options:

- Use **unicast** VRRP (`unicast_peer`) and a `notify_master` script that moves an **Elastic IP** to the new master through the AWS API, for example — file: `/etc/keepalived/takeover-eip.sh` (on each node, with its own instance ID; the instance's IAM role needs `ec2:AssociateAddress`):

```bash
#!/bin/bash
# Called by keepalived when this node becomes MASTER: move the Elastic IP here.
aws ec2 associate-address \
  --allocation-id eipalloc-0123456789abcdef0 \
  --instance-id i-0aaaabbbbccccdddd \
  --allow-reassociation
```

and in `vrrp_instance`: `notify_master "/etc/keepalived/takeover-eip.sh"`. Failover then also depends on the AWS API call and takes longer than on a LAN.

- Or, simpler and usually preferred: put an **AWS NLB/ALB** (multi-AZ, managed by AWS) in front of two or more Nginx instances in different AZs, and drop keepalived.

## 📁 Files involved

| File / Folder | What it does here |
|---|---|
| `/etc/keepalived/keepalived.conf` | VRRP instance, VIP, priority and Nginx health-check script (one per node) |
| `/etc/keepalived/takeover-eip.sh` | Cloud only: moves the Elastic IP to the new MASTER |
| `/etc/nginx/` | Must be identical on both nodes (synced by rsync/Ansible/Git) |
| `/var/www/html/index.html` | Demo page showing which node answered |
| `journalctl -u keepalived` | keepalived state changes (MASTER / BACKUP / FAULT) |
| `/etc/sysctl.conf` | `net.ipv4.ip_nonlocal_bind = 1` only if Nginx listens on the VIP explicitly |

## ✅ Verify it works

1. The VIP is on lb1:

```bash
ip -br addr show eth0          # on lb1
```

Example output:

```text
eth0             UP             192.168.1.11/24 192.168.1.100/24
```

2. From a client, watch which node answers:

```bash
while true; do curl -s --max-time 1 http://192.168.1.100/; sleep 0.5; done
```

3. On lb1, stop Nginx:

```bash
sudo systemctl stop nginx
```

The client loop switches from `served by lb1` to `served by lb2` after a few seconds. On lb2:

```bash
ip -br addr show eth0                                   # now shows 192.168.1.100
sudo journalctl -u keepalived --since "5 min ago" | grep -i state
```

Example output:

```text
Keepalived_vrrp[812]: (VI_1) Entering MASTER STATE
```

On lb1 you see a line such as `VRRP_Script(chk_nginx) failed` and `(VI_1) Entering FAULT STATE`.

4. Start Nginx on lb1 again: `sudo systemctl start nginx`. Because lb1 has the higher priority, it takes the VIP back (preemption). Add `nopreempt` (with `state BACKUP` on both nodes) if you prefer to avoid a second switch.

## ⚠️ Common mistakes

- Different `virtual_router_id` or `auth_pass` on the two nodes — both become MASTER (**split brain**, both hold the VIP).
- Firewall or cloud network blocking VRRP (protocol 112 / multicast) — also causes split brain.
- Health-checking only the node, not Nginx — the VIP stays on a node whose Nginx is dead.
- Forgetting to sync Nginx configs and certificates — failover works but the BACKUP serves an old site or an expired certificate.
- Expecting keepalived's gratuitous ARP to work on AWS/Azure/GCP — use a cloud LB or an API-based IP move.
- Using DNS round robin alone and calling it HA — clients cache DNS and keep sending traffic to a dead node.
- Making the LB redundant but leaving another SPOF: one database, one Redis, one NAT gateway, one AZ.

## 🔁 Follow-up questions interviewers ask

1. **Active-passive or active-active — which would you pick?**
   Active-passive is simpler and failover is predictable, but half the hardware sits idle. Active-active uses both, but each node must still handle full load alone if the other fails, so you don't really save capacity.
2. **What is split brain and how do you prevent it?**
   Both nodes think they are MASTER and claim the VIP. Prevent it by allowing VRRP traffic, using unicast peers on networks without multicast, and monitoring for the VIP on two nodes.
3. **How fast is keepalived failover?**
   With `advert_int 1`, the backup takes over when it stops hearing adverts for about three intervals plus a small skew, so typically a few seconds; existing TCP connections on the dead node are lost and clients must reconnect.
4. **How do you get from 99.9% to 99.99%?**
   Remove every SPOF (LB, DB, network, AZ), automate failover, and cut recovery time with monitoring and tested runbooks — the budget drops from about 8.76 hours to about 52.6 minutes a year.
5. **Why not just use a cloud load balancer?**
   In the cloud you usually should — it is already redundant across AZs. keepalived fits on-prem, bare metal, or when you need full control.

---
[⬅️ Previous](03-l4-vs-l7-load-balancing.md) · [🏠 Index](../README.md) · [Next ➡️](05-api-gateway-vs-reverse-proxy.md)

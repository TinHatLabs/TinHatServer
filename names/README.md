# Tin Hat names service

Gives every Tin Hat Server `<name>.tinhat.me`, so friends only type `crew`.

| What | How |
|---|---|
| Registration | a **server code** (`TN-XXXX-XXXX`, made by the service's admins, single use) + a proof of work + name rules (`tinhat_names/rules.py`). Names are never given out twice |
| Address | the A record is the box's **own public address as this service sees it**; boxes call `/v1/update` every 10 minutes |
| Certificates | Caddy's stock `acmedns` module on the box posts DNS-01 values to `/update` (acme-dns protocol, box id + secret). CAA on the zone allows only Let's Encrypt and only DNS-01, so no certificate exists for a name this service didn't approve |
| Outside check | `/v1/probe` connects back to the caller's own address only: TLS 443 with a nonce, TCP 7881, a UDP 7882 echo |
| Abuse | only A/AAAA + a short-lived TXT per name, no mail (null MX, SPF -all, DMARC reject), limits per address and per day, a daily "still a Tin Hat server" re-check, suspension in one command, an audit log kept 90 days |
| DNS | Cloudflare API, DNS-only records (never proxied). The token lives only here |

## Run it
1. **Where:** a Linux machine with a public address (Debian 13), behind a reverse proxy (nginx, Caddy) that holds the
   certificates.
   - The service listens on `127.0.0.1:8095`.
   - Two sites on the proxy: `names.tinhat.dev` (the API) and `tinhat.me` (the "go to your server" page), both with
     Let's Encrypt certificates.
   - DNS: `names.tinhat.dev` and the `tinhat.me` apex point at the machine's public address.
2. **Code:** `/opt/tinhat-names` (this folder). Install `deploy/tinhat-names.service` and create a `tinhat-names`
   user.
3. **`/etc/tinhat-names/config.json`:**
   ```json
   {"listen": "127.0.0.1:8095", "trust_proxy": true, "trusted_proxies": ["127.0.0.1", "<the proxy's address>"],
    "zone": "tinhat.me", "api_url": "https://names.tinhat.dev",
    "apex_ip": "<the public IP>", "dns": {"token_file": "/etc/tinhat-names/cloudflare.token"}}
   ```
   `"reserved": ["…"]` adds names nobody may register (your own, say) to the built-in list in `tinhat_names/rules.py`.
   `/.well-known/security.txt` lists `"security_contact"` first (default `security@tinhat.me`), then `"abuse_contact"`
   (default `abuse@tinhat.me`); `"security_contact": ""` leaves only the abuse address.
   **If Tin Hat servers can run in the same building** (behind the same router as this service): they reach it through
   the router's NAT loopback, which shows the router's own LAN address as theirs. Add
   `"hairpin_from": ["<the router's LAN address>"], "hairpin_public": "names.tinhat.dev"` (or the public IP itself) so
   they are told the building's public address and the outside check probes that. Leave both out otherwise.
4. **The Cloudflare token:** "Edit zone DNS" + "Zone:Read", restricted to tinhat.me and to the machine's IP. Save it in
   `/etc/tinhat-names/cloudflare.token` (0600, owner tinhat-names).
5. **The admin token:** `openssl rand -hex 24 > /etc/tinhat-names/admin.token` (0600). The admin API (the
   `tinhat-names` command below) has its own port, `admin_listen` (`127.0.0.1:8096`), which must stay loopback and must
   never be what a proxy or tunnel points at: the public port has no admin routes at all, and the admin port refuses
   anything carrying a proxy's forwarding headers.
6. **Start:** `systemctl enable --now tinhat-names`. At start it writes the zone's protective records:
   - MX `.`;
   - SPF;
   - `_dmarc`;
   - CAA `letsencrypt.org; validationmethods=dns-01` + `issuewild ";"`.

## Day to day (on the machine it runs on)
```
tinhat-names code new --note "Sam's server"     # one server code; give it to the person setting up
tinhat-names code list
tinhat-names list                               # names, state, address, last seen, version
tinhat-names suspend NAME reason…               # stops resolving within a minute; owner sees a dashboard notice
tinhat-names unsuspend NAME
tinhat-names notice NAME text…                  # a message on that server's dashboard
tinhat-names events [NAME]                      # the audit log
```

## Backups and moving (so names outlive this machine)
Every night `deploy/tinhat-names-backup.timer` runs `tinhat-names backup`: the database (an online copy, consistent
while the service runs), its settings and keys (config, admin and Cloudflare tokens, the proof-of-work key) and an
export of the zone as Cloudflare has it, into an **encrypted restic repository on another machine**. Kept 14 daily,
8 weekly, 12 monthly.

1. Pick where copies go (never this machine): another server over SFTP, an S3 bucket, Backblaze B2, a restic REST
   server. Put it in `config.json`:
   ```json
   "backup": {"repository": "sftp:backup@other-host:/srv/tinhat-names",
              "options": ["sftp.command=ssh -i /etc/tinhat-names/backup.key -o BatchMode=yes backup@other-host -s sftp"]}
   ```
   (S3 / B2: `"repository": "s3:https://…/bucket/tinhat-names"` and `"env_file": "/etc/tinhat-names/backup.env"` with
   the storage's keys, `KEY=VALUE` per line.) When this machine may not connect to the one that keeps the copies, a
   repository here that the other machine pulls every night (rsync over SSH, a snapshot per pull) works too:
   `"repository": "/var/lib/tinhat-names/restic"`. The copies must still end up elsewhere.
2. The encryption password: `openssl rand -base64 32 > /etc/tinhat-names/backup.pass` (0600, owner tinhat-names).
   **Keep a copy somewhere else** (a password manager the second account holder can reach): a copy can't be opened
   without it.
3. `cp deploy/tinhat-names-backup.{service,timer} /etc/systemd/system/ && systemctl enable --now tinhat-names-backup.timer`
4. Check it now and then: `tinhat-names backup --check` restores the newest copy into a scratch folder and opens its
   database (`--list` lists the copies).

**Restore / move to another machine:** install the service there (steps above, same config), then
`systemctl stop tinhat-names`, `RESTIC_REPOSITORY=… RESTIC_PASSWORD_FILE=… restic restore latest --target /tmp/r`,
copy `names.db` to `/var/lib/tinhat-names/` and the files in `etc/` back to `/etc/tinhat-names/` (pow.key to
`/var/lib/tinhat-names/`), point `names.tinhat.dev` at the new machine, `systemctl start tinhat-names`. Boxes call
`/v1/update` every 10 minutes, so addresses that changed since the copy catch up by themselves; a name registered after
the copy would have to register again. If the DNS account itself were lost, `zone.json` in the copy has every record.

## Testing
A closed test network (outside this repository) runs it against a Cloudflare API stand-in and Pebble; there it serves
TLS itself, and its per-address limits are relaxed because every test home shares one address.

## Tests
`python3 -m unittest tests.test_rules_pow` covers the name rules, look-alikes, proof of work, codes, never reusing a
name, and the TXT rotation.

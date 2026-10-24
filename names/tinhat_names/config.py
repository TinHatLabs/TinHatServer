"""Settings for the Tin Hat names service. A JSON file overrides the defaults (deep merge one level)."""
import copy
import json

DEFAULTS = {
    # Where the service listens. Production sits behind the reverse proxy (TLS there, trust_proxy on); the lab serves
    # TLS itself with the lab CA's certificate.
    "listen": "127.0.0.1:8095",
    # The admin API (the tinhat-names command) has its own port, loopback only. Never point a proxy or tunnel at it.
    "admin_listen": "127.0.0.1:8096",
    "tls_cert": None,
    "tls_key": None,
    "trust_proxy": False,  # take the client address from X-Forwarded-For (only through the proxies below)
    # Every proxy between the internet and this service, by address (e.g. the local nginx and a front proxy).
    "trusted_proxies": ["127.0.0.1", "::1"],
    # NAT loopback: a server on the same network as this service reaches it through that network's router, which
    # hands its own LAN-side address over as the caller's (192.168.1.1, say). Callers from these addresses are taken to
    # be at hairpin_public: the network's public address, or a name that resolves to it (re-read every 5 minutes). Off
    # when empty; never needed when this service runs somewhere of its own.
    "hairpin_from": [],
    "hairpin_public": None,
    "zone": "tinhat.me",  # people's servers live at <name>.<zone>
    "reserved": [],  # more names nobody may register, on top of rules.py's (exact match, e.g. the operators' own)
    "apex_ip": None,  # A record for the zone apex (the "go to your server" page); None = leave it alone
    "api_url": "https://names.tinhat.dev",  # how boxes reach this service (also the acme-dns server_url)
    "db": "/var/lib/tinhat-names/names.db",
    "invite_only": True,  # registration needs a server code (decided 2026-10-18)
    "pow_bits": 24,  # leading zero bits of sha256 for a registration (~16M hashes, a few seconds per core)
    "ttl": 60,
    "limits": {
        "register_per_ip_per_day": 1,
        "live_per_ip": 3,
        "new_per_day": 6,  # keeps new certificates far below Let's Encrypt's 50 per week per domain
        "ip_changes_per_day": 6,
        "txt_per_day": 30,
        "probes_per_hour": 20,
    },
    "dns": {
        "backend": "cloudflare",
        "api_base": "https://api.cloudflare.com/client/v4",
        "token_file": "/etc/tinhat-names/cloudflare.token",
        "ca_file": None,  # extra CA for the API endpoint (the lab mock)
    },
    "probe": {"ca_file": None, "timeout": 6},  # extra CA for checking boxes' certificates (lab: Pebble's root)
    "admin_token_file": "/etc/tinhat-names/admin.token",
    "abuse_contact": "abuse@tinhat.me",
    # security.txt's first Contact (RFC 9116 lists them by preference; that file is for security reports); abuse@
    # follows it. "" = abuse_contact only.
    "security_contact": "security@tinhat.me",
    # None: the zone takes no mail at all (null MX, SPF -all). "cloudflare": Cloudflare Email Routing receives mail for
    # the zone itself (abuse@, security@ forwarded to the team): its MX and SPF records are left to it.
    "mail": None,
    "acme_txt_lifetime": 600,
    "retention_days": 90,
    "recheck_hours": 24,  # how often every active name is checked to still be a Tin Hat server
    "recheck_strikes": 3,  # answers-but-isn't-Tin-Hat this many checks in a row → suspended
    "secret_key_file": "/var/lib/tinhat-names/pow.key",
    # Nightly backups (tinhat_names/backup.py, deploy/tinhat-names-backup.timer): restic, encrypted, OFF this machine.
    "backup": {
        "repository": None,  # sftp:user@host:/path · s3:https://…/bucket/path · b2:bucket:path · rest:https://…
        "password_file": "/etc/tinhat-names/backup.pass",  # restic's encryption password (keep a copy elsewhere too)
        "env_file": None,  # the storage's credentials (AWS_ACCESS_KEY_ID=…, B2_ACCOUNT_ID=…), KEY=VALUE per line
        # restic -o options, e.g. ["sftp.command=ssh -i /etc/tinhat-names/backup.key -o BatchMode=yes user@host -s sftp"]
        "options": [],
        "staging": "/var/lib/tinhat-names/backup-staging",
        "keep": {"daily": 14, "weekly": 8, "monthly": 12},
    },
}


def load(path: str | None) -> dict:
    cfg = copy.deepcopy(DEFAULTS)
    if path:
        with open(path) as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


def loopback(listen: str) -> tuple[str, int]:
    """admin_listen as (host, port): only a loopback address will do (the admin API is never reachable from anywhere
    else, and its token never leaves the machine)."""
    host, port = listen.rsplit(":", 1)
    host = host.strip("[]")
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit(f"admin_listen must be a loopback address (127.0.0.1:PORT), not {listen}")
    return host, int(port)

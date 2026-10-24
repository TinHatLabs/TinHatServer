"""The owner's own domain ("domain" mode): nothing depends on tinhat.me.

The certificate comes by DNS-01 through the owner's DNS provider (Caddy's provider modules: cloudflare, porkbun,
desec, duckdns, built into our Caddy image), with an API token the owner pastes at setup (kept in secrets.json). The
manager keeps the domain's address record pointing at the home where it can (Cloudflare now; others are the owner's
job, e.g. their router's dynamic DNS) and says so plainly.
"""
import ipaddress
import json
import logging
import re
import secrets
import socket
import struct

import aiohttp

from . import environment, hw, names, state

log = logging.getLogger("tinhat.owndomain")

PROVIDERS = {
    "cloudflare": {"label": "Cloudflare", "fields": ["token"], "keeps_address": True,
                   "help": "An API token with Zone → Zone → Read and Zone → DNS → Edit for this domain's zone (My Profile → API Tokens)."},
    "porkbun": {"label": "Porkbun", "fields": ["apiKey", "secretKey"], "keeps_address": False,
                "help": "An API key and secret (Account → API Access), with API access switched on for this domain."},
    "desec": {"label": "deSEC", "fields": ["token"], "keeps_address": False,
              "help": "A token from deSEC's Token Management."},
    "duckdns": {"label": "DuckDNS", "fields": ["token"], "keeps_address": False,
                "help": "Your DuckDNS token (the domain must be one of yours under duckdns.org)."},
    # Not a DNS provider: the owner's own reverse proxy has the certificate and sends the domain to PROXY_PORT.
    "proxy": {"label": "your own reverse proxy", "fields": [], "keeps_address": False,
              "help": "Your reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager) gets the certificate and sends "
                      "the domain to this server."},
}
PROXY_PORT = 8080  # behind the owner's reverse proxy: plain HTTP, home-network addresses only
HOST_RE = re.compile(r"^(?=.{4,253}\Z)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")  # \Z: no line break
# What API keys and tokens are made of. They go into the Caddyfile as bare words, so nothing that means something to it
# (quotes, braces, comments, placeholders, whitespace) may come along.
TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=:-]{1,400}$")


def validate(answers: dict) -> tuple[dict | None, str | None]:
    domain = str(answers.get("name", "")).strip().lower().rstrip(".")
    if not HOST_RE.match(domain):
        return None, "Type the full domain for your server, like chat.example.com."
    zone = environment.env()["zone"]
    if domain.endswith(".local") or domain == zone or domain.endswith("." + zone):
        return None, f"Use a domain you own. For a name under {zone}, choose Friends anywhere instead."
    d = answers.get("domain") or {}
    provider = d.get("provider")
    if provider not in PROVIDERS:
        return None, "Choose your DNS provider."
    creds = {f: str(d.get(f, "")).strip() for f in PROVIDERS[provider]["fields"]}
    if not all(creds.values()):
        return None, f"Paste your {PROVIDERS[provider]['label']} API details."
    if not all(TOKEN_RE.fullmatch(v) for v in creds.values()):
        return None, (f"That doesn't look like a {PROVIDERS[provider]['label']} API key. Paste it exactly as shown, "
                      f"without spaces or quotes.")
    if provider == "duckdns" and not domain.endswith(".duckdns.org"):
        return None, "With DuckDNS, the domain is one of yours under duckdns.org."
    return {"domain": domain, "provider": provider, "creds": creds}, None


def caddy_tls(provider: str, creds: dict) -> str:
    """The `tls` block's DNS line(s) for Caddy's provider module."""
    if not all(TOKEN_RE.fullmatch(str(creds.get(f, ""))) for f in PROVIDERS.get(provider, {}).get("fields", [])):
        raise ValueError(f"{provider}: an API key with characters the Caddyfile can't take")
    if provider == "cloudflare":
        return f"\t\tdns cloudflare {creds['token']}\n"
    if provider == "porkbun":
        return f"\t\tdns porkbun {{\n\t\t\tapi_key {creds['apiKey']}\n\t\t\tapi_secret_key {creds['secretKey']}\n\t\t}}\n"
    if provider == "desec":
        return f"\t\tdns desec {{\n\t\t\ttoken {creds['token']}\n\t\t}}\n"
    if provider == "duckdns":
        return f"\t\tdns duckdns {creds['token']}\n"
    raise ValueError(provider)


def proxy_snippets(sn: str, lan_ip: str, upload_mb: int) -> dict:
    """What the owner puts in their reverse proxy, for the four common ones. Calls don't go through it (TCP 7881 and
    UDP 7882 come straight to this box), so only the web side is here."""
    up = f"http://{lan_ip}:{PROXY_PORT}"
    body = max(int(upload_mb or 100), 1) + 5  # the biggest file people can send, plus room for the request around it
    nginx = f"""# Once, in the http {{ }} block (WebSockets for calls' sign-in):
map $http_upgrade $connection_upgrade {{
    default upgrade;
    ''      close;
}}

server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {sn};
    # ssl_certificate and ssl_certificate_key: your certificate for {sn}

    client_max_body_size {body}m;

    location / {{
        proxy_pass {up};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }}
}}
"""
    caddy = f"""{sn} {{
	reverse_proxy {lan_ip}:{PROXY_PORT}
}}
"""
    traefik = f"""# In a file-provider (dynamic configuration) file:
http:
  routers:
    tinhat:
      rule: "Host(`{sn}`)"
      entryPoints: [websecure]
      service: tinhat
      tls:
        certResolver: letsencrypt  # your certificate resolver's name
  services:
    tinhat:
      loadBalancer:
        servers:
          - url: "{up}"
"""
    npm = (f"Hosts → Proxy Hosts → Add Proxy Host\n"
           f"Details: Domain Names {sn}, Scheme http, Forward Hostname / IP {lan_ip}, Forward Port {PROXY_PORT}, "
           f"Websockets Support on\n"
           f"SSL: Request a new SSL Certificate, Force SSL on\n"
           f"Advanced (custom Nginx configuration): client_max_body_size {body}m;\n")
    return {"nginx": nginx, "caddy": caddy, "traefik": traefik, "npm": npm}


def proxy_info(st: dict | None = None, upload_mb: int | None = None) -> dict | None:
    """Behind the owner's reverse proxy: where it should send the domain, and the settings for the common proxies."""
    st = st if st is not None else state.load_state()
    if not state.behind_proxy(st):
        return None
    lan = (st.get("ports") or {}).get("lan_ip") or next(iter(hw.addresses()), None) or "<this server's address>"
    mb = upload_mb or (st.get("features") or {}).get("uploadMb") or 100
    return {"serverName": st.get("server_name"), "lanIp": lan, "port": PROXY_PORT,
            "snippets": proxy_snippets(st.get("server_name") or "chat.example.com", lan, mb)}


def settings() -> tuple[str | None, dict]:
    d = state.load_secrets().get("domain") or {}
    return d.get("provider"), d.get("creds") or {}


# Where else the home's public address can be read, if the Tin Hat names service is ever unreachable (or gone): an
# own domain must not depend on it for this.
IP_ECHOES = ("https://1.1.1.1/cdn-cgi/trace", "https://api.ipify.org")


def is_public_v4(ip: str | None) -> bool:
    """A public IPv4 address. A private one means the answer came back through the router's NAT loopback (the server
    is in the same house as the service it asked): announcing that to callers outside would break their calls."""
    try:
        a = ipaddress.ip_address(str(ip or ""))
    except ValueError:
        return False
    return a.version == 4 and a.is_global and not a.is_multicast  # Python counts 224/4 as global


async def public_ip() -> str | None:
    """The home's public address, as the outside sees it: the names service answers anyone (no registration); a public
    "what's my address" service when it doesn't, or when its answer isn't a public address."""
    try:
        ip = (await names.info()).get("your_ip")
        if is_public_v4(ip):
            return ip
        if ip:
            log.info("the names service sees this server at %s (not a public address): asking elsewhere", ip)
    except names.NamesError:
        pass
    for url in environment.env().get("ip_echoes", IP_ECHOES):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
                async with s.get(url, ssl=environment.ssl_context()) as r:
                    text = (await r.text()).strip()
            ip = next((l[3:] for l in text.splitlines() if l.startswith("ip=")), text)  # cdn-cgi/trace: ip=…
            if is_public_v4(ip):
                return ip
        except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
            continue
    return None


def resolves_to(domain: str) -> list[str]:
    """Where the domain points as the internet sees it: asked of public resolvers directly. The box's own lookups would
    say 127.0.1.1 (/etc/hosts names the box after itself), and a home's DNS may answer differently ("split horizon")."""
    for server in environment.env().get("public_dns") or ["1.1.1.1", "9.9.9.9"]:
        try:
            got = _dns_a(domain, server)
        except (OSError, ValueError, struct.error):
            continue
        if got is not None:
            return got
    return []


def _dns_a(name: str, server: str, timeout: float = 3.0) -> list[str] | None:
    """One A query to one resolver over UDP. [] for no such name or no A record."""
    qid = secrets.randbits(16)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.rstrip(".").split(".")) + b"\0"
    query = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0) + qname + struct.pack(">HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(query, (server, 53))
        data, _ = sock.recvfrom(4096)
    rid, flags, qd, an = struct.unpack(">HHHH", data[:8])
    if rid != qid or not flags & 0x8000:
        raise ValueError("not our answer")
    if flags & 0xF == 3:  # NXDOMAIN
        return []
    if flags & 0xF:
        raise ValueError(f"rcode {flags & 0xF}")

    def skip(i: int) -> int:
        while True:
            n = data[i]
            if n & 0xC0 == 0xC0:
                return i + 2
            if n == 0:
                return i + 1
            i += n + 1

    i = 12
    for _ in range(qd):
        i = skip(i) + 4
    out = set()
    for _ in range(an):
        i = skip(i)
        rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", data[i:i + 10])
        i += 10
        if rtype == 1 and rdlen == 4:
            out.add(socket.inet_ntoa(data[i:i + 4]))
        i += rdlen
    return sorted(out)


async def set_address(domain: str, ip: str) -> bool:
    """Point the domain's A record at ip through the provider's API. False: this provider isn't done by us."""
    provider, creds = settings()
    if provider == "cloudflare":
        await _cloudflare_set_a(domain, ip, creds["token"])
        return True
    return False


async def keep_current(st: dict) -> str | None:
    """The background loop's job for own domains: the current public address; the record follows it if we can."""
    ip = await public_ip()
    if not ip:
        return None
    if ip != (st.get("domain_status") or {}).get("ip4"):
        try:
            moved = await set_address(st["server_name"], ip)
        except DNSAPIError as e:
            log.warning("couldn't update %s: %s", st["server_name"], e)
            state.save_state(domain_status={"ip4": None, "error": str(e)})
            return ip
        state.save_state(domain_status={"ip4": ip, "updated": moved, "error": None})
        log.info("%s: public address %s (%s)", st["server_name"], ip, "record updated" if moved else "owner keeps the record")
    return ip


# ---- Cloudflare's API -------------------------------------------------------------------------------------------------

class DNSAPIError(Exception):
    pass


async def _cf(session: aiohttp.ClientSession, method: str, path: str, token: str, body: dict | None = None) -> dict:
    base = environment.env().get("cloudflare_api", "https://api.cloudflare.com/client/v4")
    async with session.request(method, base + path, json=body, ssl=environment.ssl_context(),
                               headers={"Authorization": f"Bearer {token}"}) as r:
        try:
            j = await r.json(content_type=None)
        except (ValueError, json.JSONDecodeError):
            j = {}
        if r.status >= 400 or not j.get("success", False):
            errs = "; ".join(e.get("message", "") for e in j.get("errors") or []) or f"HTTP {r.status}"
            raise DNSAPIError(f"Cloudflare said: {errs}")
        return j


async def _cloudflare_set_a(domain: str, ip: str, token: str) -> None:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
        zones = (await _cf(s, "GET", "/zones?per_page=50", token)).get("result") or []
        zone = max((z for z in zones if domain == z["name"] or domain.endswith("." + z["name"])),
                   key=lambda z: len(z["name"]), default=None)
        if zone is None:
            raise DNSAPIError(f"the token can't see a zone for {domain}")
        recs = (await _cf(s, "GET", f"/zones/{zone['id']}/dns_records?type=A&name={domain}", token)).get("result") or []
        body = {"type": "A", "name": domain, "content": ip, "ttl": 60, "proxied": False}
        if recs:
            if recs[0].get("content") != ip:
                await _cf(s, "PUT", f"/zones/{zone['id']}/dns_records/{recs[0]['id']}", token, body)
        else:
            await _cf(s, "POST", f"/zones/{zone['id']}/dns_records", token, body)

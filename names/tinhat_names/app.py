"""The Tin Hat names service: gives every Tin Hat server `<name>.tinhat.me`, keeps its address current, publishes the
DNS-01 records its certificates need, checks it from outside, and keeps the names from being abused.

Boxes authenticate with the box id + secret they got at registration (HTTPS only). The acme-dns style /update
endpoint uses the same pair (X-Api-User / X-Api-Key), so Caddy's stock `acmedns` DNS module gets certificates through
this service: CAA on the zone only lets Let's Encrypt issue via DNS-01, and only this service writes the TXT records,
so no certificate exists for a name we didn't approve (docs/REMOTE-ACCESS.md, "Stopping abuse").
"""
import argparse
import asyncio
import html
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import ssl
import time

from aiohttp import web

from . import config as config_mod
from . import pow as pow_mod
from . import probe, rules
from .db import DB
from .dns_cloudflare import Cloudflare, DNSError
from .relay_api import RelayAPI

log = logging.getLogger("tinhat-names")
DAY, HOUR = 86400, 3600
TXT_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # an ACME DNS-01 value: base64url sha256, 43 chars
HOST_RE = re.compile(r"^(?=.{4,253}\Z)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")  # an own domain's name


def jerr(status: int, code: str, message: str, **extra):
    return web.json_response({"ok": False, "error": code, "message": message, **extra}, status=status)


class Service:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        os.makedirs(os.path.dirname(cfg["db"]), exist_ok=True)
        self.db = DB(cfg["db"])
        self.key = pow_mod.load_key(cfg["secret_key_file"])
        self.zone = cfg["zone"]
        self.reserved = frozenset(str(x).strip().lower() for x in cfg.get("reserved") or [])
        with open(cfg["dns"]["token_file"]) as f:
            token = f.read().strip()
        self.dns = Cloudflare(cfg["dns"]["api_base"], token, self.zone, cfg["ttl"], cfg["dns"].get("ca_file"))
        self.probe_ctx = probe.tls_context(cfg["probe"].get("ca_file"))
        self.moved_changes: dict[str, float] = {}  # name -> when its new address was last set (/v1/moved)
        self.used_nonces: dict[str, float] = {}
        try:
            with open(cfg["admin_token_file"]) as f:
                self.admin_token = f.read().strip()
        except FileNotFoundError:
            self.admin_token = None
        self.dns_lock = asyncio.Lock()
        self.relays = RelayAPI(self)  # Tin Hat Relay places (relay_api.py, docs/RELAY.md)

    # ---- helpers ----------------------------------------------------------------------------------------------
    def client_ip(self, req: web.Request) -> str:
        """The caller's address. Behind proxies (trust_proxy): X-Forwarded-For read from the right, skipping the
        proxies we trust, so the first address no trusted proxy vouches for is the caller. Addresses a caller wrote
        into the header themselves sit further left and are never reached. It matters: /v1/probe-open connects to it."""
        return self.hairpin(self._caller(req))

    def _caller(self, req: web.Request) -> str:
        ip = req.remote or ""
        trusted = set(self.cfg.get("trusted_proxies") or ("127.0.0.1", "::1"))
        if not self.cfg["trust_proxy"] or ip not in trusted:
            return ip
        hops = [h.strip() for h in req.headers.get("X-Forwarded-For", "").split(",") if h.strip()]
        for hop in reversed(hops):
            if hop not in trusted:
                return hop
        return req.headers.get("X-Real-IP", "").strip() or ip

    def hairpin(self, ip: str) -> str:
        """A caller on this service's own network arrives from the router's LAN-side address (NAT loopback): it is
        at the network's public address. Only for the configured router addresses, and only a usable public IPv4 one
        (a name is resolved in the background, hairpin_refresh; until it is, the caller stays unmapped)."""
        if not self.unmapped(ip):
            return ip
        return self._hairpin_literal() or getattr(self, "_hairpin_public", None) or ip

    def unmapped(self, ip: str) -> bool:
        """The caller is that router itself: its public address is the mapping's (when it's known)."""
        return bool(ip) and ip in (self.cfg.get("hairpin_from") or ())

    def hairpin_unknown(self, ip: str) -> bool:
        """A hairpin caller whose public address isn't known yet: never register, point, or probe it as the router."""
        return self.unmapped(ip) and self.hairpin(ip) == ip

    @staticmethod
    def usable_v4(value) -> bool:
        try:
            a = ipaddress.ip_address(str(value or ""))
        except ValueError:
            return False
        return a.version == 4 and a.is_global and not a.is_multicast

    def _hairpin_literal(self) -> str | None:
        want = str(self.cfg.get("hairpin_public") or "")
        return want if self.usable_v4(want) else None

    async def resolve_hairpin(self) -> str | None:
        """The mapping's name, resolved now (bounded): its first usable public IPv4 address, or None."""
        want = str(self.cfg.get("hairpin_public") or "")
        if not want:
            return None
        try:
            ipaddress.ip_address(want)
            return self._hairpin_literal()  # a literal: only if it's a usable public IPv4 address
        except ValueError:
            pass
        try:
            infos = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
                want, None, family=socket.AF_INET, type=socket.SOCK_STREAM), 10)
        except (OSError, asyncio.TimeoutError) as e:
            log.warning("hairpin: couldn't resolve %s: %s", want, e)
            return None
        return next((i[4][0] for i in infos if self.usable_v4(i[4][0])), None)

    async def hairpin_refresh(self) -> None:
        """Keep the mapping's address current. A failed lookup keeps the last good one (never the router's own)."""
        while True:
            got = await self.resolve_hairpin()
            if got:
                if got != getattr(self, "_hairpin_public", None):
                    log.info("hairpin: callers from %s are at %s", ", ".join(self.cfg.get("hairpin_from") or []), got)
                self._hairpin_public = got
            await asyncio.sleep(300 if getattr(self, "_hairpin_public", None) else 30)

    def box(self, req: web.Request, body: dict | None = None):
        user = req.headers.get("X-Api-User") or (body or {}).get("box_id")
        key = req.headers.get("X-Api-Key") or (body or {}).get("secret")
        return self.db.auth(user, key)

    def fqdn(self, name: str) -> str:
        return f"{name}.{self.zone}"

    def state(self, row) -> dict:
        return {"name": row["name"], "fqdn": self.fqdn(row["name"]), "status": row["status"], "ip4": row["ip4"],
                "ip6": row["ip6"], "reason": row["reason"] if row["status"] != "active" else None}

    async def set_address(self, name: str, ip: str):
        a = ipaddress.ip_address(ip)
        async with self.dns_lock:
            if a.version == 4:
                await self.dns.set_rrset(self.fqdn(name), "A", [ip])
            else:
                await self.dns.set_rrset(self.fqdn(name), "AAAA", [ip])

    async def remove_from_dns(self, name: str):
        async with self.dns_lock:
            await self.dns.delete_all(self.fqdn(name))
            await self.dns.delete_all(f"_acme-challenge.{self.fqdn(name)}")

    # ---- public: info, check, challenge, register -------------------------------------------------------------
    async def info(self, req):
        return web.json_response({"ok": True, "zone": self.zone, "invite_only": self.cfg["invite_only"],
                                  "pow_bits": self.cfg["pow_bits"], "your_ip": self.client_ip(req),
                                  "acme_server": self.cfg["api_url"],
                                  "relay_available": self.relays.store.pick() is not None})

    def availability(self, name: str) -> tuple[bool, str, str]:
        ok, code, msg = rules.check(name, self.reserved)
        if not ok:
            return ok, code, msg
        if self.db.name(name) is not None:
            return False, "taken", "That name is taken. Pick another one."
        return True, "ok", ""

    async def check(self, req):
        name = (req.query.get("name") or "").strip().lower()
        ok, code, msg = self.availability(name)
        out = {"ok": ok, "name": name, "fqdn": self.fqdn(name) if ok else None, "code": code, "message": msg}
        if "code" in req.query:  # the wizard checks the server code as it's typed (no use is spent)
            out["code_ok"] = (not self.cfg["invite_only"]) or self.db.code_ok(req.query["code"])
        out["invite_only"] = self.cfg["invite_only"]
        return web.json_response(out)

    async def challenge(self, req):
        return web.json_response({"ok": True, **pow_mod.make(self.key, self.cfg["pow_bits"])})

    async def register(self, req):
        ip = self.client_ip(req)
        if self.hairpin_unknown(ip):
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        try:
            body = await req.json()
        except ValueError:
            return jerr(400, "bad-request", "Expected JSON.")
        name = (body.get("name") or "").strip().lower()
        code = (body.get("code") or "").strip().upper()
        lim = self.cfg["limits"]
        ok, why, msg = self.availability(name)
        if not ok:
            self.db.event("register-refused", name, ip, why)
            return jerr(409 if why == "taken" else 400, why, msg)
        if self.cfg["invite_only"] and not self.db.code_ok(code):
            self.db.event("register-refused", name, ip, "code")
            return jerr(403, "code", "That server code isn't valid (or was already used).")
        nonce, solution = body.get("nonce") or "", str(body.get("solution") or "")
        good, why = pow_mod.check(self.key, nonce, name, solution, self.cfg["pow_bits"])
        if not good or nonce in self.used_nonces:
            return jerr(400, "pow", f"Registration check failed ({why or 'already used'}). Try again.")
        now = time.time()
        if self.db.count("register", now - DAY, ip=ip) >= lim["register_per_ip_per_day"]:
            return jerr(429, "limit-ip", "This internet connection already registered a server today. Try tomorrow.")
        if self.db.live_for_ip(ip) >= lim["live_per_ip"]:
            return jerr(429, "limit-live", "This internet connection already has the most servers allowed.")
        if self.db.new_since(now - DAY) >= lim["new_per_day"]:
            return jerr(429, "limit-global", "Lots of new servers today. Please try again in a few hours.")
        self.used_nonces[nonce] = now + 900
        try:
            box_id, secret = self.db.create(name, ip, code or None)
        except Exception:
            return jerr(409, "taken", "That name was just taken. Pick another one.")
        if code:
            self.db.use_code(code)
            self.db.set(name, code=code)
        self.db.set(name, version=str(body.get("version") or "")[:32])
        try:
            await self.set_address(name, ip)
            self.db.set(name, **({"ip4": ip} if ":" not in ip else {"ip6": ip}), last_change=now)
        except DNSError as e:
            log.error("register %s: DNS: %s", name, e)
            self.db.event("dns-error", name, ip, str(e))
        self.db.event("register", name, ip, f"code={code}")
        return web.json_response({"ok": True, "name": name, "fqdn": self.fqdn(name), "box_id": box_id,
                                  "secret": secret, "ip": ip,
                                  "acme": {"server_url": self.cfg["api_url"], "username": box_id, "password": secret,
                                           "subdomain": name}})

    # ---- box: keep the address current, notices ---------------------------------------------------------------
    async def update(self, req):
        ip = self.client_ip(req)
        if self.hairpin_unknown(ip):
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        try:
            body = await req.json()
        except ValueError:
            body = {}
        row = self.box(req, body)
        if row is None:
            return self.unknown_box(req, body)
        name = row["name"]
        self.db.set(name, last_seen=time.time(), version=str(body.get("version") or row["version"] or "")[:32])
        notices = self.db.take_notices(name)
        if row["status"] != "active":
            return web.json_response({"ok": False, **self.state(row), "notices": notices})
        relay = self.relays.on_update(name, ip)
        if relay is not None:  # relayed: the name stays on the relay; the home's own address is only remembered
            return web.json_response({"ok": True, **self.state(self.db.name(name)), "changed": False, "notices": notices,
                                      "relay": relay})
        cur = row["ip4"] if ":" not in ip else row["ip6"]
        changed = False
        if ip != cur:
            if self.db.count("ip-change", time.time() - DAY, name=name) >= self.cfg["limits"]["ip_changes_per_day"]:
                self.db.event("ip-change-refused", name, ip, f"was {cur}")
                return jerr(429, "limit-ip-change", "This server's address changed too often today.",
                            **self.state(row), notices=notices)
            try:
                await self.set_address(name, ip)
            except DNSError as e:
                return jerr(502, "dns", f"Couldn't update the address: {e}")
            self.db.set(name, **({"ip4": ip} if ":" not in ip else {"ip6": ip}), last_change=time.time())
            self.db.event("ip-change", name, ip, f"was {cur}")
            changed = True
        row = self.db.name(name)
        return web.json_response({"ok": True, **self.state(row), "changed": changed, "notices": notices})

    def unknown_box(self, req, body: dict | None = None):
        user = req.headers.get("X-Api-User") or (body or {}).get("box_id")
        key = req.headers.get("X-Api-Key") or (body or {}).get("secret")
        if self.db.moved(user, key):
            return jerr(401, "moved", "This server's name was moved to another computer (restored from a backup), "
                                      "so this one can't use it any more.")
        return jerr(401, "auth", "Unknown server.")

    async def rotate(self, req):
        """A restored server takes its name over: a new key for it, and the old computer's key stops working."""
        try:
            body = await req.json()
        except ValueError:
            body = {}
        row = self.box(req, body)
        reopened = False
        if row is None:
            # An earlier key, while the Tin Hat team has opened the name for one more move (allow-move): the computer
            # that took the name over died before it was backed up, and only an older copy is left.
            user = req.headers.get("X-Api-User") or body.get("box_id")
            key = req.headers.get("X-Api-Key") or body.get("secret")
            old = self.db.by_old_key(user, key)
            if old is None or not (old["move_open_until"] or 0) > time.time():
                return self.unknown_box(req, body)
            row, reopened = old, True
        name = row["name"]
        secret = self.db.rotate(name)
        if reopened:
            self.db.set(name, move_open_until=None)  # once
        # The old computer's relay tunnel must not carry the name a moment longer: drop its place (the new computer's
        # /v1/update right after this points the name at its home, and it asks for a place of its own if it uses one).
        await self.relays.drop(name, "moved to another computer")
        self.db.event("rotate", name, self.client_ip(req), ("from an earlier key (allow-move) · " if reopened else "")
                      + str(body.get("why") or "")[:100])
        return web.json_response({"ok": True, **self.state(row), "box_id": row["box_id"], "secret": secret,
                                  "acme": {"server_url": self.cfg["api_url"], "username": row["box_id"],
                                           "password": secret, "subdomain": name}})

    async def release(self, req):
        row = self.box(req)
        if row is None:
            return jerr(401, "auth", "Unknown server.")
        await self.relays.drop(row["name"])
        await self.remove_from_dns(row["name"])
        self.db.set(row["name"], status="retired", reason="released by its owner")
        self.db.event("release", row["name"], self.client_ip(req))
        return web.json_response({"ok": True})

    async def moved_to(self, req):
        """The server moved to its own domain ("Move to your own domain" on its dashboard): the name stays its own
        while it holds it (its address and certificate keep working, so apps that still use the name find the
        server), and the name's page sends visitors to the new address."""
        row = self.box(req)
        if row is None:
            return jerr(401, "auth", "Unknown server.")
        try:
            body = await req.json()
        except ValueError:
            body = {}
        to = str(body.get("to") or "").strip().lower().rstrip(".")
        if to and (not HOST_RE.match(to) or to.endswith("." + self.zone) or to == self.zone):
            return jerr(400, "format", "That isn't a domain of your own.")
        if to:
            # Not an open redirect on our domain: once an hour per name, and only to a server that says it was this one
            if time.time() - self.moved_changes.get(row["name"], 0) < 3600:
                return jerr(429, "slow-down", "The new address can change once an hour.")
            why = await probe.moved_here(to, self.fqdn(row["name"]), self.probe_ctx, float(self.cfg["probe"]["timeout"]))
            if why:
                return jerr(400, "not-moved", why)
            self.moved_changes[row["name"]] = time.time()
        self.db.set(row["name"], moved_to=to or None)
        self.db.event("moved-to", row["name"], self.client_ip(req), to or "(cleared)")
        return web.json_response({"ok": True, "moved_to": to or None})

    # ---- acme-dns compatible DNS-01 endpoint (Caddy's `acmedns` module) ---------------------------------------
    async def acme_update(self, req):
        try:
            body = await req.json()
        except ValueError:
            return web.json_response({"error": "malformed_json_payload"}, status=400)
        row = self.box(req)
        if row is None:
            return web.json_response({"error": "forbidden"}, status=401)
        name, value = row["name"], str(body.get("txt") or "")
        sub = str(body.get("subdomain") or name)
        if sub != name:
            return web.json_response({"error": "forbidden"}, status=401)
        if row["status"] != "active":
            self.db.event("txt-refused", name, self.client_ip(req), row["status"])
            return web.json_response({"error": "forbidden"}, status=403)
        if not TXT_RE.match(value):
            return web.json_response({"error": "bad_txt"}, status=400)
        if self.db.count("txt", time.time() - DAY, name=name) >= self.cfg["limits"]["txt_per_day"]:
            return web.json_response({"error": "too_many_updates"}, status=429)
        values = self.db.add_txt(name, value)
        try:
            async with self.dns_lock:
                await self.dns.set_rrset(f"_acme-challenge.{self.fqdn(name)}", "TXT", [f'"{v}"' for v in values])
        except DNSError as e:
            log.error("txt %s: %s", name, e)
            return web.json_response({"error": "dns_error"}, status=502)
        self.db.event("txt", name, self.client_ip(req))
        return web.json_response({"txt": value})

    # ---- probe: check the caller from outside -----------------------------------------------------------------
    async def probe(self, req):
        ip = self.client_ip(req)
        if self.hairpin_unknown(ip):
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        try:
            body = await req.json()
        except ValueError:
            body = {}
        row = self.box(req, body)
        if row is None:
            return jerr(401, "auth", "Unknown server.")
        name = row["name"]
        if self.db.count("probe", time.time() - HOUR, name=name) >= self.cfg["limits"]["probes_per_hour"]:
            return jerr(429, "limit-probe", "Too many checks this hour. Try again later.")
        self.db.event("probe", name, ip)
        nonce = str(body.get("nonce") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", nonce):
            return jerr(400, "bad-request", "Bad nonce.")
        checks = body.get("checks") or ["tls443", "tcp7881"]
        timeout = float(self.cfg["probe"]["timeout"])
        # A relayed server is checked where friends reach it: its relay, on its own call port (TCP and UDP).
        target, tcp_port, udp_port = ip, 7881, 7882
        via = self.relays.target(name)
        if via:
            target, tcp_port = via
            udp_port = tcp_port
        jobs = {}
        if "tls443" in checks:
            jobs["tls443"] = probe.tls443(target, self.fqdn(name), nonce, self.probe_ctx, timeout)
        if "tcp7881" in checks:
            jobs["tcp7881"] = probe.tcp(target, tcp_port, timeout)
        if "udp7882" in checks:
            jobs["udp7882"] = probe.udp_echo(target, udp_port, nonce, timeout)
        results = dict(zip(jobs, await asyncio.gather(*jobs.values())))
        return web.json_response({"ok": True, "ip": ip, "fqdn": self.fqdn(name), "results": results,
                                  "via": "relay" if via else None, "target": target,
                                  "ports": {"tcp": tcp_port, "udp": udp_port}})

    async def probe_open(self, req):
        """The outside check for a server on its owner's own domain, which has no account here: a proof of work for
        that domain instead of a key, and the service only ever connects back to the address the request comes from
        (with the domain as the TLS name), so it can't be aimed at anyone else."""
        ip = self.client_ip(req)
        if self.hairpin_unknown(ip):
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        try:
            body = await req.json()
        except ValueError:
            return jerr(400, "bad-request", "Expected JSON.")
        host = str(body.get("host") or "").strip().lower().rstrip(".")
        if not HOST_RE.match(host) or host == self.zone or host.endswith("." + self.zone):
            return jerr(400, "bad-request", "That isn't a domain this check is for.")
        pow_nonce, solution = str(body.get("pow_nonce") or ""), str(body.get("solution") or "")
        good, why = pow_mod.check(self.key, pow_nonce, host, solution, self.cfg["pow_bits"])
        if not good or pow_nonce in self.used_nonces:
            return jerr(400, "pow", f"The check's proof of work failed ({why or 'already used'}). Try again.")
        nonce = str(body.get("nonce") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", nonce):
            return jerr(400, "bad-request", "Bad nonce.")
        now = time.time()
        if self.db.count("probe-open", now - HOUR, ip=ip) >= self.cfg["limits"]["probes_per_hour"]:
            return jerr(429, "limit-probe", "Too many checks this hour. Try again later.")
        self.used_nonces[pow_nonce] = now + 900
        self.db.event("probe-open", host, ip)
        checks = [c for c in (body.get("checks") or ["tls443"]) if c in ("tls443", "tcp7881", "udp7882")]
        timeout = float(self.cfg["probe"]["timeout"])
        jobs = {}
        if "tls443" in checks:
            jobs["tls443"] = probe.tls443(ip, host, nonce, self.probe_ctx, timeout)
        if "tcp7881" in checks:
            jobs["tcp7881"] = probe.tcp(ip, 7881, timeout)
        if "udp7882" in checks:
            jobs["udp7882"] = probe.udp_echo(ip, 7882, nonce, timeout)
        results = dict(zip(jobs, await asyncio.gather(*jobs.values())))
        return web.json_response({"ok": True, "ip": ip, "host": host, "results": results})

    # ---- the zone apex: "go to your server" -------------------------------------------------------------------
    def page(self, title: str, body: str, status: int = 200) -> web.Response:
        z = html.escape(self.zone)
        doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>
:root{{--bg:#0f1115;--fg:#e8e6e3;--muted:#9aa0a6;--line:#2a2e36;--accent:#e0b04a;color-scheme:dark}}
@media (prefers-color-scheme: light){{:root{{--bg:#fafaf7;--fg:#1b1d21;--muted:#5f6368;--line:#dcdcd6;--accent:#9a6b00;color-scheme:light}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{max-width:34rem;margin:0 auto;padding:12vh max(16px,env(safe-area-inset-right)) 4rem max(16px,env(safe-area-inset-left))}}
h1{{font-size:1.6rem;margin:0 0 .5rem}} p{{color:var(--muted)}} a{{color:var(--accent)}}
form{{display:flex;gap:.5rem;margin:1.5rem 0}} .box{{flex:1;display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}}
input{{flex:1;min-width:0;border:0;background:transparent;color:var(--fg);font:inherit;padding:.7rem .8rem}}
.suffix{{padding:.7rem .8rem .7rem 0;color:var(--muted)}} button{{border:0;border-radius:10px;padding:0 1.1rem;font:inherit;
background:var(--accent);color:#1b1d21;font-weight:600}} small{{color:var(--muted)}}
</style></head><body><main>{body}
<p><small>{z} gives names to Tin Hat servers that people run for themselves and their friends.
Report abuse: <a href="mailto:{html.escape(self.cfg['abuse_contact'])}">{html.escape(self.cfg['abuse_contact'])}</a></small></p>
</main></body></html>"""
        return web.Response(text=doc, content_type="text/html", status=status,
                            headers={"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
                                     "Cache-Control": "no-cache", "Referrer-Policy": "no-referrer",
                                     "X-Content-Type-Options": "nosniff", "Content-Security-Policy":
                                     "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"})

    def go_form(self, value: str = "") -> str:
        return (f'<form method="get" action="/go"><label class="box"><input name="n" value="{html.escape(value)}" '
                f'placeholder="your server" autocapitalize="none" autocomplete="off" spellcheck="false" '
                f'aria-label="Server name"><span class="suffix">.{html.escape(self.zone)}</span></label>'
                f'<button>Go</button></form>')

    async def apex(self, req):
        return self.page("Tin Hat servers", "<h1>Go to your server</h1><p>Type the name your friend gave you, "
                                             "like <b>crew</b>.</p>" + self.go_form())

    async def go(self, req):
        n = (req.query.get("n") or req.match_info.get("n") or "").strip().lower()
        n = n.removesuffix("." + self.zone)
        row = self.db.name(n) if rules.NAME_RE.match(n or "") else None
        if row is None or row["status"] != "active":
            return self.page("No such server", f"<h1>No server called “{html.escape(n)}”</h1><p>Check the spelling "
                                               f"with whoever invited you.</p>" + self.go_form(n), 404)
        moved = row["moved_to"] if "moved_to" in row.keys() else None
        if moved:  # a page, not a redirect: the server's owner set where it went, we only checked it said so
            m = html.escape(moved)
            return self.page(f"{n} moved", f"<h1>“{html.escape(n)}” moved to its own address</h1><p>The server's owner "
                                           f"moved it to <b>{m}</b>. Sign in there with the same username and "
                                           f"password.</p><p><a href=\"https://{m}/\">Open {m}</a></p>")
        raise web.HTTPFound(f"https://{self.fqdn(n)}/")

    def security_txt_text(self) -> str:
        """RFC 9116: Contact lines by preference — security reports first, then abuse — an Expires, the language."""
        exp = time.strftime("%Y-%m-%dT00:00:00Z", time.gmtime(time.time() + 300 * DAY))
        contacts = []
        for c in (self.cfg.get("security_contact"), self.cfg.get("abuse_contact")):
            c = str(c or "").strip()
            if c and c not in contacts:
                contacts.append(c)
        return "".join(f"Contact: mailto:{c}\n" for c in contacts) + f"Expires: {exp}\nPreferred-Languages: en\n"

    async def security_txt(self, req):
        return web.Response(text=self.security_txt_text(), content_type="text/plain")

    # ---- admin (own loopback listener + token) ---------------------------------------------------------------
    # The admin API is served only by make_admin_app() on admin_listen (127.0.0.1:8096), never by the public app: a
    # tunnel or proxy in front of the public port connects from loopback too, so "comes from 127.0.0.1" alone would let
    # the internet in. Anything a proxy adds (forwarding headers) is refused as well, in case one is ever pointed here.
    FORWARDED = ("X-Forwarded-For", "X-Real-IP", "Forwarded", "Cf-Connecting-Ip", "Cf-Ray", "True-Client-Ip",
                 "X-Forwarded-Host")

    def admin_ok(self, req) -> bool:
        tok = req.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        return bool(self.admin_token) and secrets.compare_digest(tok, self.admin_token) and \
            req.remote in ("127.0.0.1", "::1") and not any(h in req.headers for h in self.FORWARDED)

    async def admin(self, req):
        if not self.admin_ok(req):
            raise web.HTTPNotFound()
        what, arg = req.match_info["what"], req.match_info.get("arg", "")
        body = {}
        if req.method == "POST":
            try:
                body = await req.json()
            except ValueError:
                body = {}
        if what == "codes" and req.method == "POST":
            code = self.db.new_code(int(body.get("uses", 1)), body.get("days", 30), str(body.get("note", "")))
            self.db.event("code-new", detail=f"{code} {body.get('note', '')}")
            return web.json_response({"ok": True, "code": code})
        if what == "codes" and req.method == "GET":
            return web.json_response({"ok": True, "codes": [dict(r) for r in self.db.codes()]})
        if what == "revoke":
            return web.json_response({"ok": self.db.revoke_code(arg)})
        if what == "names":
            return web.json_response({"ok": True, "names": [
                {k: r[k] for k in r.keys() if k != "secret_hash"} for r in self.db.names(req.query.get("status"))]})
        if what == "events":
            return web.json_response({"ok": True, "events": [dict(r) for r in self.db.events(arg or None)]})
        if what.startswith("relay-"):
            return await self.relays.admin(what, arg, body)
        if what == "notice-all" and req.method == "POST":
            n = self.db.notice_all(str(body.get("text") or ""), str(body.get("level") or "info"))
            self.db.event("notice-all", detail=str(body.get("text") or "")[:200])
            return web.json_response({"ok": True, "servers": n})
        row = self.db.name(arg)
        if row is None:
            return jerr(404, "unknown", "No such name.")
        reason = str(body.get("reason") or "")
        if what == "suspend":
            await self.remove_from_dns(arg)
            self.db.set(arg, status="suspended", reason=reason or "suspended")
            self.db.notice(arg, f"This server's name was suspended: {reason or 'see the abuse contact'}.", "error")
            self.db.event("suspend", arg, detail=reason)
            await self.relays.name_suspended(arg, True)
        elif what == "unsuspend":
            self.db.set(arg, status="active", reason=None, strikes=0)
            if row["ip4"]:
                await self.set_address(arg, row["ip4"])
            self.db.notice(arg, "This server's name works again.", "info")
            self.db.event("unsuspend", arg, detail=reason)
            await self.relays.name_suspended(arg, False)
        elif what == "retire":
            await self.remove_from_dns(arg)
            self.db.set(arg, status="retired", reason=reason or "retired")
            self.db.event("retire", arg, detail=reason)
            await self.relays.drop(arg)
        elif what == "notice":
            self.db.notice(arg, str(body.get("text") or ""), str(body.get("level") or "info"))
        elif what == "allow-move":  # one more move from an earlier copy (its owner lost the computer holding the name)
            hours = max(1.0, min(float(body.get("hours") or 24), 168.0))
            self.db.set(arg, move_open_until=time.time() + hours * HOUR)
            self.db.event("allow-move", arg, detail=f"{hours:g} h {reason}".strip())
        else:
            raise web.HTTPNotFound()
        return web.json_response({"ok": True, **self.state(self.db.name(arg))})

    # ---- background ------------------------------------------------------------------------------------------
    async def housekeeping(self):
        last_recheck = 0.0
        while True:
            try:
                for name in self.db.expire_txt(self.cfg["acme_txt_lifetime"]):
                    async with self.dns_lock:
                        vals = self.db.txt_values(name)
                        await self.dns.set_rrset(f"_acme-challenge.{self.fqdn(name)}", "TXT", [f'"{v}"' for v in vals])
                now = time.time()
                self.used_nonces = {k: v for k, v in self.used_nonces.items() if v > now}
                await self.relays.tick()
                if now - last_recheck > self.cfg["recheck_hours"] * HOUR:
                    last_recheck = now
                    self.db.prune(self.cfg["retention_days"])
                    await self.recheck_all()
            except Exception:
                log.exception("housekeeping")
            await asyncio.sleep(30)

    async def recheck_all(self):
        """Every active name must still be a Tin Hat server. Unreachable is fine (an off gaming PC); answering as
        something else, several checks in a row, gets the name suspended and the owner told."""
        for row in self.db.names("active"):
            if not row["ip4"]:
                continue
            verdict = await probe.still_tinhat(row["ip4"], self.fqdn(row["name"]), self.probe_ctx,
                                               float(self.cfg["probe"]["timeout"]))
            if verdict == "yes":
                if row["strikes"]:
                    self.db.set(row["name"], strikes=0)
            elif verdict == "no":
                strikes = row["strikes"] + 1
                self.db.set(row["name"], strikes=strikes)
                self.db.event("recheck-fail", row["name"], row["ip4"], f"strike {strikes}")
                if strikes >= self.cfg["recheck_strikes"]:
                    await self.remove_from_dns(row["name"])
                    self.db.set(row["name"], status="suspended", reason="no longer answers as a Tin Hat server")
                    self.db.notice(row["name"], "This server's name was suspended because the address no longer "
                                                "answers as a Tin Hat server.", "error")
                    self.db.event("suspend", row["name"], detail="auto: recheck")

    async def on_start(self, app):
        await self.dns.start()
        await self.dns.baseline(self.cfg.get("apex_ip"), self.cfg.get("mail"))
        app["bg"] = asyncio.create_task(self.housekeeping())
        if self.cfg.get("hairpin_from") and self.cfg.get("hairpin_public"):
            app["hairpin"] = asyncio.create_task(self.hairpin_refresh())

    async def on_stop(self, app):
        app["bg"].cancel()
        if "hairpin" in app:
            app["hairpin"].cancel()
        await self.dns.close()


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception:
        log.exception("%s %s", request.method, request.path)
        return jerr(500, "internal", "Something went wrong on the names service.")


def make_app(cfg: dict) -> web.Application:
    svc = Service(cfg)
    app = web.Application(middlewares=[errors], client_max_size=16 * 1024)
    app["svc"] = svc
    app.add_routes([
        web.get("/", svc.apex), web.get("/go", svc.go), web.get("/.well-known/security.txt", svc.security_txt),
        web.get("/v1/info", svc.info), web.get("/v1/check", svc.check), web.post("/v1/challenge", svc.challenge),
        web.post("/v1/register", svc.register), web.post("/v1/update", svc.update),
        web.post("/v1/release", svc.release), web.post("/v1/rotate", svc.rotate), web.post("/v1/probe", svc.probe),
        web.post("/v1/moved", svc.moved_to),
        web.post("/v1/probe-open", svc.probe_open),
        web.post("/update", svc.acme_update), *svc.relays.routes(),
        web.get(r"/{n:[a-z0-9-]{4,32}}", svc.go),
    ])
    async def service(app):
        await svc.on_start(app)
        yield
        await svc.on_stop(app)

    app.cleanup_ctx.append(service)
    app["admin"] = make_admin_app(svc)
    return app


def make_admin_app(svc: Service) -> web.Application:
    """The admin API (tinhat-names code/list/suspend/relay …): its own app on its own loopback port (admin_listen),
    which no tunnel or proxy forwards."""
    app = web.Application(middlewares=[errors], client_max_size=64 * 1024)
    app.add_routes([web.route("*", "/v1/admin/{what}", svc.admin), web.route("*", "/v1/admin/{what}/{arg}", svc.admin)])
    return app


_loopback = config_mod.loopback


def main():
    ap = argparse.ArgumentParser(description="Tin Hat names service")
    ap.add_argument("-c", "--config", default=os.environ.get("TINHAT_NAMES_CONFIG", "/etc/tinhat-names/config.json"))
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    cfg = config_mod.load(a.config)
    ssl_ctx = None
    if cfg.get("tls_cert"):
        ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_ctx.load_cert_chain(cfg["tls_cert"], cfg["tls_key"])
    host, port = cfg["listen"].rsplit(":", 1)
    admin_host, admin_port = _loopback(cfg["admin_listen"])
    app = make_app(cfg)

    async def admin_site(app):
        # after the service started (cleanup_ctx order), and stopped before it
        runner = web.AppRunner(app["admin"], access_log=None)
        await runner.setup()
        try:
            await web.TCPSite(runner, admin_host, admin_port).start()
            yield
        finally:
            await runner.cleanup()

    app.cleanup_ctx.append(admin_site)
    web.run_app(app, host=host, port=int(port), ssl_context=ssl_ctx, print=None, access_log=None)


if __name__ == "__main__":
    main()

"""The names service's side of the Tin Hat Relay (docs/RELAY.md): it hands relay places to registered servers, keeps
each relay's list of places current through the relay's control API, counts traffic against monthly allowances, and
points a relayed server's name at its relay.

Boxes (authenticated like /v1/update: X-Api-User / X-Api-Key):
  POST   /v1/relay  {"public_key": "<WireGuard key>"}  → a place (relay endpoint + key, tunnel address, call port)
  GET    /v1/relay                                     → the place, its state and this month's traffic (or null)
  DELETE /v1/relay                                     → give it back; the name points at the home again
Relays (their control API, pinned certificate + bearer token): PUT /v1/places with every place they carry.
"""
import asyncio
import base64
import binascii
import logging
import re
import ssl
import time

import aiohttp
from aiohttp import web

from .relays import GB, Full, RelayStore, next_month_name

log = logging.getLogger("tinhat-names.relay")
DAY = 86400

DEFAULTS = {
    "quota_gb": 100,          # each server's monthly allowance through a relay (both directions, tunnel bytes)
    "warn_at": 0.8,           # the owner hears about it at 80 %
    "sync_seconds": 300,      # how often every relay gets its list and reports traffic
    "requests_per_day": 10,   # a box asking for (or re-keying) a place
    "idle_days": 30,          # a server away this long gives its seat back (it asks again by itself when it returns)
}

NOTICES = {
    "warn": ("info", "Your server has used {pct} % of this month's Tin Hat relay allowance ({quota} GB). If it runs "
                     "out, calls through the relay stop until {next}; chat keeps working."),
    "calls-paused": ("warn", "Your server used this month's Tin Hat relay allowance ({quota} GB), so calls with "
                             "friends outside your home are paused until {next}. Chat keeps working."),
    "paused": ("error", "Your server used twice this month's Tin Hat relay allowance, so the relay has paused it until "
                        "{next}. Until then nobody can reach it by its name."),
    "back": ("info", "The Tin Hat relay carries your server's calls and chat again."),
}


def _key_ok(k: str) -> bool:
    try:
        return len(base64.b64decode(k, validate=True)) == 32
    except (binascii.Error, ValueError, TypeError):
        return False


class RelayError(Exception):
    pass


class RelayAPI:
    def __init__(self, svc):
        self.svc = svc
        self.cfg = {**DEFAULTS, **(svc.cfg.get("relay") or {})}
        self.store = RelayStore(svc.db.c)
        self.last_sync = 0.0
        self.locks: dict[str, asyncio.Lock] = {}

    @property
    def default_quota(self) -> int:
        return int(float(self.cfg["quota_gb"]) * GB)

    def routes(self) -> list:
        return [web.post("/v1/relay", self.post), web.get("/v1/relay", self.get), web.delete("/v1/relay", self.delete)]

    # ---- talking to a relay ----------------------------------------------------------------------------------------
    async def call(self, relay, method: str, path: str, body=None, timeout: float = 20) -> dict:
        try:
            token = open(relay["token_file"]).read().strip()
            ctx = ssl.create_default_context(cafile=relay["cert_file"])  # its own certificate, pinned
        except OSError as e:
            raise RelayError(f"relay {relay['id']}: {e}") from e
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as s:
                async with s.request(method, relay["url"].rstrip("/") + path, json=body, ssl=ctx,
                                     headers={"Authorization": f"Bearer {token}"}) as r:
                    data = await r.json(content_type=None)
                    if r.status >= 400 or not data.get("ok"):
                        raise RelayError(f"relay {relay['id']}: {r.status} {data.get('message') or data.get('error')}")
                    return data
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError) as e:
            raise RelayError(f"relay {relay['id']}: {type(e).__name__}: {e}") from e

    async def fetch_status(self, url: str, token_file: str, cert_file: str) -> dict:
        fake = {"id": url, "url": url, "token_file": token_file, "cert_file": cert_file}
        return await self.call(fake, "GET", "/v1/status")

    async def sync(self, relay_id: str) -> bool:
        """Send the relay its whole list of places; count the traffic it reports. True if the relay took it."""
        lock = self.locks.setdefault(relay_id, asyncio.Lock())
        async with lock:
            relay = self.store.relay(relay_id)
            if relay is None:
                return False
            try:
                res = await self.call(relay, "PUT", "/v1/places", {"places": self.store.desired(relay_id, self.svc.zone)})
            except RelayError as e:
                self.store.set_relay(relay_id, last_error=str(e)[:300])
                log.error("sync %s: %s", relay_id, e)
                return False
            self.store.set_relay(relay_id, last_sync=time.time(), last_error=None)
        changed = False
        for name, u in (res.get("usage") or {}).items():
            events = self.store.record_usage(name, int(u.get("bytes", 0)), self.default_quota, self.cfg["warn_at"])
            changed |= any(e in ("calls-paused", "paused", "back") for e in events)
            self.tell(name, events)
        if changed:  # a place changed state: the relay must hear it now, not in five minutes
            return await self.sync(relay_id)
        return True

    def tell(self, name: str, events: list[str]) -> None:
        p = self.store.place(name)
        for ev in events:
            level, text = NOTICES[ev]
            q = self.store.quota(p, self.default_quota) if p else self.default_quota
            pct = int(100 * (p["bytes_month"] if p else 0) / q) if q else 0
            self.svc.db.notice(name, text.format(quota=round(q / GB), pct=pct, next=next_month_name()), level)
            self.svc.db.event(f"relay-{ev}", name, detail=f"{(p['bytes_month'] if p else 0) / GB:.1f} GB of {q / GB:.0f}")

    async def tick(self) -> None:
        """From the names service's housekeeping (every 30 s): a new month, and every relay's list + traffic."""
        rolled = self.store.rollover()
        for name, ev in rolled.items():
            self.tell(name, ev)
        if rolled or time.time() - self.last_sync >= float(self.cfg["sync_seconds"]):
            self.last_sync = time.time()
            for p in self.store.idle(time.time() - float(self.cfg["idle_days"]) * DAY):
                self.store.remove_place(p["name"])
                self.svc.db.event("relay-off", p["name"], detail=f"away {self.cfg['idle_days']} days: seat freed")
            for r in self.store.relays():
                await self.sync(r["id"])

    # ---- what a box sees -------------------------------------------------------------------------------------------
    def doc(self, p) -> dict:
        r = self.store.relay(p["relay_id"])
        q = self.store.quota(p, self.default_quota)
        return {"ok": True, "fqdn": f"{p['name']}.{self.svc.zone}",
                "relay": {"id": r["id"], "public_ip": r["public_ip"], "endpoint": r["wg_endpoint"],
                          "public_key": r["wg_public_key"], "tunnel_ip": r["tunnel_ip"]},
                "tunnel_ip": p["tunnel_ip"], "ports": {"tcp": p["port"], "udp": p["port"]},
                "status": p["status"], "reason": p["reason"] if p["status"] == "suspended" else None,
                "usage": {"month": p["month"], "bytes": p["bytes_month"], "quota": q}, "keepalive": 25}

    def target(self, name: str) -> tuple[str, int] | None:
        """Where the outside check connects for a relayed server: the relay's address and the server's port."""
        p = self.store.place(name)
        if p is None:
            return None
        return self.store.relay(p["relay_id"])["public_ip"], p["port"]

    def on_update(self, name: str, ip: str) -> dict | None:
        """/v1/update from a relayed server: its name stays on the relay; remember where the home is."""
        p = self.store.place(name)
        if p is None:
            return None
        if ip and p["home_ip"] != ip:
            self.store.set_place(name, home_ip=ip)
        return self.doc(self.store.place(name))

    async def drop(self, name: str, why: str = "name gone") -> None:
        """The name is gone (released or retired), or it moved to another computer: free its place, so the relay stops
        carrying the name to the old computer's tunnel at once (the new computer asks for a place of its own)."""
        p = self.store.place(name)
        if p is not None:
            self.store.remove_place(name)
            self.svc.db.event("relay-off", name, detail=why)
            await self.sync(p["relay_id"])

    async def name_suspended(self, name: str, suspended: bool) -> None:
        p = self.store.place(name)
        if p is None:
            return
        if suspended:
            self.store.set_place(name, status="suspended", reason="name suspended")
        elif p["status"] == "suspended" and p["reason"] == "name suspended":
            self.store.set_place(name, status="active", reason=None)
            self.store.recheck_quota(name, self.default_quota)
        await self.sync(p["relay_id"])

    # ---- box endpoints -----------------------------------------------------------------------------------------------
    async def _box(self, req):
        try:
            body = await req.json() if req.can_read_body else {}
        except ValueError:
            body = {}
        row = self.svc.box(req, body)
        return row, body

    async def post(self, req):
        from .app import jerr
        row, body = await self._box(req)
        if row is None:
            return self.svc.unknown_box(req, body)
        name, ip = row["name"], self.svc.client_ip(req)
        if self.svc.hairpin_unknown(ip):  # never the local router's own address (app.py hairpin)
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        if row["status"] != "active":
            return jerr(403, row["status"], "This server's name isn't active, so it can't use the relay.")
        key = str(body.get("public_key") or "")
        if not _key_ok(key):
            return jerr(400, "bad-key", "That isn't a WireGuard public key.")
        if self.svc.db.count("relay-request", time.time() - DAY, name=name) >= int(self.cfg["requests_per_day"]):
            return jerr(429, "limit-relay", "This server asked for the relay too often today. Try again tomorrow.")
        self.svc.db.event("relay-request", name, ip)
        p = self.store.place(name)
        if p is not None:
            if p["public_key"] != key:
                self.store.set_place(name, public_key=key)
                self.svc.db.event("relay-rekey", name, ip)
            if p["home_ip"] != ip:
                self.store.set_place(name, home_ip=ip)
            if not await self.sync(p["relay_id"]):
                return jerr(502, "relay-down", "Couldn't reach the Tin Hat relay. Try again in a few minutes.")
        else:
            try:
                p = self.store.create_place(name, key, ip)
            except Full:
                if not self.store.relays():
                    return jerr(503, "relay-none", "The Tin Hat relay isn't available yet.")
                return jerr(503, "relay-full", "The Tin Hat relay is full right now. Try again later.")
            if not await self.sync(p["relay_id"]):
                self.store.remove_place(name)
                return jerr(502, "relay-down", "Couldn't reach the Tin Hat relay. Try again in a few minutes.")
        relay = self.store.relay(p["relay_id"])
        if row["ip4"] != relay["public_ip"]:
            try:
                await self.svc.set_address(name, relay["public_ip"])
            except Exception as e:  # noqa: BLE001 — DNSError and friends: the place stays, the box can ask again
                log.error("relay %s: DNS: %s", name, e)
                return jerr(502, "dns", "Couldn't point your server's name at the relay. Try again in a few minutes.")
            self.svc.db.set(name, ip4=relay["public_ip"], last_change=time.time())
        self.svc.db.event("relay-on", name, ip, f"{relay['id']} {p['tunnel_ip']} port {p['port']}")
        return web.json_response(self.doc(self.store.place(name)))

    async def get(self, req):
        row, body = await self._box(req)
        if row is None:
            return self.svc.unknown_box(req, body)
        p = self.store.place(row["name"])
        return web.json_response(self.doc(p) if p else {"ok": True, "relay": None})

    async def delete(self, req):
        from .app import jerr
        row, body = await self._box(req)
        if row is None:
            return self.svc.unknown_box(req, body)
        name, ip = row["name"], self.svc.client_ip(req)
        if self.svc.hairpin_unknown(ip):  # never the local router's own address (app.py hairpin)
            return jerr(503, "hairpin", "This service can't tell your public address right now. Try again in a minute.")
        p = self.store.place(name)
        if p is not None:
            self.store.remove_place(name)
            await self.sync(p["relay_id"])  # if the relay is unreachable now, the next sync takes the place away
        if row["status"] == "active" and row["ip4"] != ip and ":" not in ip:
            try:
                await self.svc.set_address(name, ip)
            except Exception as e:  # noqa: BLE001
                log.error("relay off %s: DNS: %s", name, e)
                return jerr(502, "dns", "The relay let go, but your server's name couldn't be pointed home yet. It "
                                        "will be within ten minutes.")
            self.svc.db.set(name, ip4=ip, last_change=time.time())
        self.svc.db.event("relay-off", name, ip)
        return web.json_response({"ok": True, "ip4": ip})

    # ---- admin (tinhat-names relay …) --------------------------------------------------------------------------------
    async def admin(self, what: str, arg: str, body: dict) -> web.Response:
        from .app import jerr
        ok = lambda **kw: web.json_response({"ok": True, **kw})  # noqa: E731
        if what == "relay-add":
            rid = str(body.get("id") or "")
            if not re.fullmatch(r"[a-z0-9-]{1,32}", rid):
                return jerr(400, "bad-request", "A relay id is lowercase letters, digits and dashes.")
            try:
                info = await self.fetch_status(body["url"], body["token_file"], body["cert_file"])
            except (RelayError, KeyError) as e:
                return jerr(502, "relay-down", f"Couldn't ask the relay who it is: {e}")
            self.store.add_relay(rid, body["url"], body["token_file"], body["cert_file"], info, body.get("capacity"))
            self.svc.db.event("relay-add", detail=f"{rid} {info['public_ip']}")
            synced = await self.sync(rid)
            return ok(relay=dict(self.store.relay(rid)), synced=synced)
        if what == "relay-list":
            return ok(relays=[{**{k: r[k] for k in r.keys() if k != "token_file"}, "places": self.store.load(r["id"])}
                              for r in self.store.relays()], default_quota=self.default_quota)
        if what == "relay-places":
            return ok(places=[{**dict(p), "quota": self.store.quota(p, self.default_quota)}
                              for p in self.store.places(arg or None)])
        if what in ("relay-drain", "relay-activate"):
            if self.store.relay(arg) is None:
                return jerr(404, "unknown", "No such relay.")
            self.store.set_relay(arg, status="draining" if what == "relay-drain" else "active")
            return ok(relay=dict(self.store.relay(arg)))
        if what == "relay-sync":
            ids = [arg] if arg else [r["id"] for r in self.store.relays()]
            return ok(synced={i: await self.sync(i) for i in ids})
        p = self.store.place(arg)
        if p is None and what in ("relay-suspend", "relay-unsuspend") and self.svc.db.name(arg) is not None:
            # Its relay is off right now: remembered, and applied when it asks for a place again.
            reason = (str(body.get("reason") or "") or "suspended by the Tin Hat team") if what == "relay-suspend" else None
            self.store.remember_suspension(arg, reason)
            self.svc.db.event(what, arg, detail=(reason or "") + " (no place now)")
            return ok(place={"name": arg, "status": "suspended" if reason else "active", "note": "no relay place now"})
        if p is None:
            return jerr(404, "unknown", "That server has no relay place.")
        if what == "relay-suspend":
            reason = str(body.get("reason") or "") or "suspended by the Tin Hat team"
            self.store.set_place(arg, status="suspended", reason=reason)
            self.svc.db.notice(arg, f"The Tin Hat relay stopped carrying your server: {reason}", "error")
            self.svc.db.event("relay-suspend", arg, detail=reason)
        elif what == "relay-unsuspend":
            self.store.set_place(arg, status="active", reason=None)
            self.store.recheck_quota(arg, self.default_quota)
            self.svc.db.notice(arg, NOTICES["back"][1], "info")
            self.svc.db.event("relay-unsuspend", arg)
        elif what == "relay-quota":
            gb = body.get("gb")
            q = None if gb in (None, "", "default") else int(float(gb) * GB)
            self.store.set_place(arg, quota_bytes=q)
            self.tell(arg, self.store.recheck_quota(arg, self.default_quota))
            self.svc.db.event("relay-quota", arg, detail=f"{gb} GB")
        else:
            raise web.HTTPNotFound()
        await self.sync(p["relay_id"])
        p = self.store.place(arg)
        return ok(place={**dict(p), "quota": self.store.quota(p, self.default_quota)})

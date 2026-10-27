"""The relay's control API (HTTPS, a bearer token, and only from the names service's addresses) and its upkeep.

The names service owns the list of places; it sends the whole list (PUT /v1/places) whenever something changes and
every few minutes, and gets each place's traffic back in the answer. The relay keeps the last list on disk and applies
it again at boot, so a restarted relay serves everyone before the names service calls.

  GET /v1/status   who this relay is: public address, WireGuard key and port, tunnel network, port range, capacity
  PUT /v1/places   {"places": [...]} → applied exactly (see render.py); answers usage per place
  GET /v1/usage    usage per place
"""
import argparse
import asyncio
import json
import logging
import os
import secrets
import ssl
import time

from aiohttp import web

from . import __version__, pyenv, render, system
from . import config as config_mod

log = logging.getLogger("tinhat-relay")


class Relay:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        with open(cfg["token_file"]) as f:
            self.token = f.read().strip()
        self.state = self._load()
        self.lock = asyncio.Lock()
        self.wg_key = system.wg_public_key(cfg)

    # ---- state on disk ----
    def _load(self) -> dict:
        try:
            with open(self.cfg["state_file"]) as f:
                s = json.load(f)
        except (FileNotFoundError, ValueError):
            s = {}
        s.setdefault("places", [])
        s.setdefault("usage", {})
        return s

    def _save(self) -> None:
        system.write_if_changed(self.cfg["state_file"], json.dumps(self.state, indent=1, sort_keys=True) + "\n", 0o600)

    # ---- applying ----
    def _collect(self) -> None:
        """Fold the kernel's counters into the running totals (WireGuard per peer, nftables per call port)."""
        render.accumulate(self.state["usage"], self.state["places"], system.wg_peers(self.cfg), system.nft_counters())

    def apply(self, places: list[dict]) -> dict:
        """Make the machine match `places` (already checked). Counts traffic up to this moment first."""
        system.ensure_wg(self.cfg)
        self._collect()
        rules = render.nft_ruleset(self.cfg, places)
        old = {p["name"] for p in self.state["places"]}
        self.state["places"] = places
        wg = system.wg_reconcile(self.cfg, places)
        if system.digest(rules) != self.state.get("nft_digest") or not system.run(
                "nft", "list", "table", "inet", "tinhat_relay", check=False):
            render.counters_restart(self.state["usage"])
        nft = system.nft_apply(self.cfg, rules)
        self.state["nft_digest"] = system.digest(rules)
        hap = system.haproxy_apply(self.cfg, render.sni_map(places))
        now = {p["name"] for p in places}
        for gone in old - now:
            self.state["usage"].pop(gone, None)
        self._save()
        if nft or hap or wg["added_or_changed"] or wg["removed"]:
            log.info("applied %d places (wg %s, nft %s, haproxy %s)", len(places), wg, "new" if nft else "same",
                     "reloaded" if hap else "same")
        return {"places": len(places), "wg": wg, "nft_changed": nft, "haproxy_reloaded": hap}

    def usage(self, names: list[str] | None = None) -> dict:
        self._collect()
        self._save()
        return render.public_usage(self.state["usage"], names or [p["name"] for p in self.state["places"]])

    def status(self) -> dict:
        c = self.cfg
        return {"ok": True, "relay_id": c["relay_id"], "version": __version__, "public_ip": c["public_ip"],
                "wg": {"public_key": self.wg_key, "port": c["wg_port"], "endpoint": f"{c['public_ip']}:{c['wg_port']}"},
                "tunnel_net": c["tunnel_net"], "tunnel_ip": c["tunnel_ip"], "ports": c["ports"],
                "capacity": c["capacity"], "places": len(self.state["places"]),
                # what it answers with: Tin Hat's pinned aiohttp, or the system's (and why)
                "aiohttp": {k: pyenv.CURRENT.get(k) for k in ("runtime", "aiohttp", "reason")} if pyenv.CURRENT else None}

    # ---- HTTP ----
    def _allowed(self, req: web.Request) -> bool:
        tok = req.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        return bool(tok) and secrets.compare_digest(tok, self.token) and \
            system.in_any(req.remote or "", self.cfg["control_allow"])

    @web.middleware
    async def guard(self, req, handler):
        if not self._allowed(req):
            log.warning("refused %s %s from %s", req.method, req.path, req.remote)
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        try:
            return await handler(req)
        except render.PlaceError as e:
            return web.json_response({"ok": False, "error": "bad-places", "message": str(e)}, status=400)
        except system.SystemError_ as e:
            log.error("apply failed: %s", e)
            return web.json_response({"ok": False, "error": "apply", "message": str(e)}, status=500)

    async def h_status(self, req):
        return web.json_response(self.status())

    async def h_places(self, req):
        try:
            body = await req.json()
        except ValueError:
            return web.json_response({"ok": False, "error": "bad-request"}, status=400)
        places = render.check_places(body.get("places") or [], self.cfg)
        async with self.lock:
            before = [p["name"] for p in self.state["places"]]
            pre = await asyncio.to_thread(self.usage, before)  # last counts for places about to leave
            res = await asyncio.to_thread(self.apply, places)
            usage = await asyncio.to_thread(self.usage)
        for n, u in pre.items():
            usage.setdefault(n, u)
        return web.json_response({"ok": True, **res, "usage": usage, "at": int(time.time())})

    async def h_usage(self, req):
        async with self.lock:
            usage = await asyncio.to_thread(self.usage)
        return web.json_response({"ok": True, "usage": usage, "at": int(time.time())})

    # ---- upkeep ----
    async def upkeep(self):
        """Every minute: count traffic (so restarts lose little), and put the interface back if it went missing."""
        while True:
            await asyncio.sleep(60)
            try:
                async with self.lock:
                    if system.run("ip", "link", "show", self.cfg["wg_if"], check=False) == "":
                        log.warning("%s was gone; applying again", self.cfg["wg_if"])
                        await asyncio.to_thread(self.apply, self.state["places"])
                    else:
                        await asyncio.to_thread(self.usage)
            except Exception:  # noqa: BLE001 — upkeep must go on
                log.exception("upkeep")


def make_app(relay: Relay) -> web.Application:
    app = web.Application(middlewares=[relay.guard], client_max_size=1 << 20)
    app.add_routes([web.get("/v1/status", relay.h_status), web.put("/v1/places", relay.h_places),
                    web.get("/v1/usage", relay.h_usage)])

    async def start(app):
        app["upkeep"] = asyncio.create_task(relay.upkeep())

    async def stop(app):
        app["upkeep"].cancel()
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main():
    ap = argparse.ArgumentParser(description="Tin Hat relay")
    ap.add_argument("-c", "--config", default=os.environ.get("TINHAT_RELAY_CONFIG", "/etc/tinhat-relay/config.json"))
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    cfg = config_mod.load(a.config)
    relay = Relay(cfg)
    # Serve everyone it served before the restart, before the names service gets in touch.
    relay.apply(render.check_places(relay.state["places"], cfg))
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(cfg["control_cert"], cfg["control_key"])
    host, port = cfg["control_listen"].rsplit(":", 1)
    web.run_app(make_app(relay), host=host, port=int(port), ssl_context=ctx, print=None, access_log=None)


if __name__ == "__main__":
    main()

"""The box's side of the Tin Hat names service (names/ in this repo; names.tinhat.dev in production).

The box registers `<name>.tinhat.me` once (with a server code and a proof of work), then keeps its address current,
asks the service to check it from outside, and picks up notices for its owner (shown on the dashboard).
The credentials (box id + secret) live in secrets.json; the same pair works as acme-dns credentials for Caddy.
"""
import asyncio
import logging
import time

import aiohttp

from . import config, environment, pow_client, state

log = logging.getLogger("tinhat.names")


class NamesError(Exception):
    def __init__(self, msg: str, code: str = "", status: int = 0):
        super().__init__(msg)
        self.code, self.status = code, status


def _url(path: str) -> str:
    return environment.env()["names_url"].rstrip("/") + path


def zone() -> str:
    return environment.env()["zone"]


async def _call(method: str, path: str, *, json=None, params=None, auth: bool = False, timeout: float = 20) -> dict:
    headers = {}
    if auth:
        creds = state.load_secrets().get("names") or {}
        headers = {"X-Api-User": creds.get("box_id", ""), "X-Api-Key": creds.get("secret", "")}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as s:
            async with s.request(method, _url(path), json=json, params=params, headers=headers,
                                 ssl=environment.ssl_context()) as r:
                try:
                    body = await r.json(content_type=None)
                except ValueError:
                    body = {}
                if r.status >= 400 or body.get("ok") is False and body.get("error"):
                    raise NamesError(body.get("message") or f"The names service answered {r.status}.",
                                     body.get("error", ""), r.status)
                return body
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
        raise NamesError("Can't reach the Tin Hat names service. Check that this server is online.", "offline") from e


async def info() -> dict:
    return await _call("GET", "/v1/info")


async def check(name: str, code: str | None = None) -> dict:
    params = {"name": name}
    if code:
        params["code"] = code
    try:
        return await _call("GET", "/v1/check", params=params)
    except NamesError as e:
        if e.code == "offline":
            raise
        return {"ok": False, "message": str(e), "code": e.code}


async def register(name: str, code: str) -> dict:
    """Solve the proof of work (a few seconds of one core) and take the name. Keeps the credentials."""
    ch = await _call("POST", "/v1/challenge", json={})
    solution = await asyncio.to_thread(pow_client.solve, ch["nonce"], name, int(ch["bits"]))
    res = await _call("POST", "/v1/register", json={"name": name, "code": code, "nonce": ch["nonce"],
                                                    "solution": solution, "version": config.VERSION}, timeout=40)
    state.save_secrets(names={"name": name, "fqdn": res["fqdn"], "box_id": res["box_id"], "secret": res["secret"],
                              "acme": res["acme"], "ip": res.get("ip")})
    log.info("registered %s from %s", res["fqdn"], res.get("ip"))
    return res


def creds() -> dict | None:
    return state.load_secrets().get("names")


TAKEOVER_FILE = config.STATE_DIR / "names-takeover.json"


async def rotate(why: str = "restored from a backup") -> dict:
    """Take the name over on this computer (after a restore): the names service issues a new key, and the old
    computer's key stops working, so the two can't fight over the name."""
    res = await _call("POST", "/v1/rotate", json={"why": why}, auth=True)
    new = {**(creds() or {}), "secret": res["secret"], "acme": res["acme"]}
    state.save_secrets(names=new)
    # Also outside the files a restore puts back: if this restore is started over from the beginning, the new key
    # isn't overwritten by the backup's old one (that would leave the name with a key no computer has).
    state.write_json(TAKEOVER_FILE, {"fqdn": res.get("fqdn"), "names": new, "at": int(time.time())}, 0o600)
    log.info("took over %s (key rotated)", res.get("fqdn"))
    return res


async def update() -> dict:
    """Keep the address current (the service sees our public address); returns state + notices for the owner."""
    try:
        res = await _call("POST", "/v1/update", json={"version": config.VERSION}, auth=True)
    except NamesError as e:
        if e.code == "moved":  # restored on another computer: that one has the name now
            state.save_state(names_status={"status": "moved", "ip4": None, "reason": str(e), "checked": int(time.time())})
        if e.status in (401, 403, 429):
            return {"ok": False, "status": "error", "error": e.code, "message": str(e)}
        raise
    if res.get("notices"):
        st = state.load_state()
        notices = (st.get("names_notices") or []) + res["notices"]
        state.save_state(names_notices=notices[-20:])
    state.save_state(names_status={"status": res.get("status"), "ip4": res.get("ip4"), "reason": res.get("reason"),
                                   "checked": int(time.time())})
    return res


async def probe(nonce: str, checks: list[str]) -> dict:
    return await _call("POST", "/v1/probe", json={"nonce": nonce, "checks": checks}, auth=True, timeout=45)


async def probe_open(host: str, nonce: str, checks: list[str]) -> dict:
    """The outside check for a server with its own domain: no names account, so a proof of work instead. The service
    connects back only to the address the request comes from, with `host` as the TLS name."""
    ch = await _call("POST", "/v1/challenge", json={})
    solution = await asyncio.to_thread(pow_client.solve, ch["nonce"], host, int(ch["bits"]))
    return await _call("POST", "/v1/probe-open", json={"pow_nonce": ch["nonce"], "solution": solution, "host": host,
                                                        "nonce": nonce, "checks": checks}, timeout=45)


async def release() -> None:
    await _call("POST", "/v1/release", json={}, auth=True)


async def tell_moved(to: str | None) -> dict:
    """After "Move to your own domain": the name stays this server's (its address and certificate keep working for
    apps that still use it), and the name's page on the names service sends visitors to `to`. None undoes it."""
    return await _call("POST", "/v1/moved", json={"to": to or ""}, auth=True)


async def keep_former() -> dict:
    """Moved to its own domain (move.py) from this tinhat.me name: keep the old name pointing here while the server
    holds it. Its own status (former_name_status), never names_status: that one decides whether this server moved to
    another computer, and the old name going elsewhere doesn't make the own-domain server a copy that must stand down."""
    st = state.load_state()
    if (st.get("former_name_status") or {}).get("status") == "moved":
        return st["former_name_status"]
    try:
        res = await _call("POST", "/v1/update", json={"version": config.VERSION}, auth=True)
        doc = {"status": res.get("status"), "ip4": res.get("ip4"), "checked": int(time.time())}
    except NamesError as e:
        if e.code == "offline":
            return st.get("former_name_status") or {}
        doc = {"status": "moved" if e.code == "moved" else "error", "error": str(e), "checked": int(time.time())}
    state.save_state(former_name_status=doc)
    return doc

"""The box's side of the Tin Hat names service (names/ in this repo; names.tinhat.dev in production).

The box registers `<name>.tinhat.me` once (with a server code and a proof of work), then keeps its address current,
asks the service to check it from outside, and picks up notices for its owner (shown on the dashboard).
The credentials (box id + secret) live in secrets.json; the same pair works as acme-dns credentials for Caddy.
"""
import asyncio
import logging
import socket
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


#: the address families the box speaks to the names service over: the service puts the CALLER's address under the name
#: (A for an IPv4 caller, AAAA for an IPv6 one) and leaves the other record alone, so a box with both talks over both
#: (assembly-038: a dual-stack box that reached the service over IPv6 only got an AAAA record, and IPv4-only friends
#: couldn't connect)
FAMILIES = ((socket.AF_INET, "ipv4"), (socket.AF_INET6, "ipv6"))
#: one family's attempt, at most (a family without a route fails at once; a black-holed one waits this long)
FAMILY_TIMEOUT = 12


async def _call(method: str, path: str, *, json=None, params=None, auth: bool = False, timeout: float = 20,
                family: int = 0) -> dict:
    """One request to the names service; `family` (socket.AF_INET / AF_INET6) pins the address family, 0 = any."""
    headers = {}
    if auth:
        creds = state.load_secrets().get("names") or {}
        headers = {"X-Api-User": creds.get("box_id", ""), "X-Api-Key": creds.get("secret", "")}
    try:
        conn = aiohttp.TCPConnector(family=family) if family else None
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), connector=conn) as s:
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


async def info(family: int = 0) -> dict:
    return await _call("GET", "/v1/info", family=family, timeout=FAMILY_TIMEOUT if family else 20)


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
    # the registration set only the family it came over: the other one right away (a failure is fine, the regular
    # update tries again)
    try:
        upd = await update()
        res = {**res, "ip4": upd.get("ip4"), "ip6": upd.get("ip6")}
    except NamesError as e:
        log.info("after registering: the address update didn't go through yet (%s)", e)
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


#: a family that had an address and keeps failing this long is worth a warning in the log (once an hour after that)
FAMILY_WARN_AFTER = 3600


def _note_families(ok_families: set[str], errors_by_family: dict[str, "NamesError"], res: dict | None) -> None:
    """The log says what happened per family (launch-gate, 2026-10-28: a silent success and a silent wrong-family call
    looked the same): one info line when the service's answer CHANGES ip4/ip6, one warning an hour while a family that
    had an address keeps failing. Kept in state.json as names_families."""
    st = state.load_state()
    prev = st.get("names_status") or {}
    track = dict(st.get("names_families") or {})
    fqdn = (creds() or {}).get("fqdn") or "this server's name"
    now = int(time.time())
    if res is not None:
        for key, rr in (("ip4", "A"), ("ip6", "AAAA")):
            if res.get(key) != prev.get(key):
                log.info("names: %s %s → %s (was %s)", rr, fqdn, res.get(key) or "none", prev.get(key) or "none")
    for fam, label in FAMILIES:
        t = dict(track.get(label) or {})
        if label in ok_families:
            if t.get("failing_since"):
                log.info("names: the update over %s works again", label)
            t = {"ok_at": now}
        elif label in errors_by_family:
            had = prev.get("ip4" if fam == socket.AF_INET else "ip6") or t.get("ok_at")
            t.setdefault("failing_since", now)
            if had and now - t["failing_since"] > FAMILY_WARN_AFTER and now - t.get("warned_at", 0) >= FAMILY_WARN_AFTER:
                log.warning("names: the update over %s has failed for %d min (%s); %s may be out of date for %s",
                            label, (now - t["failing_since"]) // 60, errors_by_family[label],
                            "A" if fam == socket.AF_INET else "AAAA", fqdn)
                t["warned_at"] = now
        track[label] = t
    state.save_state(names_families=track)


async def _update_each() -> tuple[dict | None, list[NamesError]]:
    """POST /v1/update once per address family this box has (FAMILIES). Returns the last answer that went through
    (it carries both ip4 and ip6 as the service now holds them; notices from every answer merged) and the errors of the
    families that didn't. A family without a route ("offline") is skipped quietly (but tracked: _note_families)."""
    last, errors, notices, ok, by_family = None, [], [], set(), {}
    for fam, label in FAMILIES:
        try:
            res = await _call("POST", "/v1/update", json={"version": config.VERSION}, auth=True, family=fam,
                              timeout=FAMILY_TIMEOUT)
        except NamesError as e:
            if e.code != "offline":
                log.info("names update over %s: %s", label, e)
            errors.append(e)
            by_family[label] = e
            continue
        notices += res.get("notices") or []
        last = res
        ok.add(label)
    if last is not None:
        last = {**last, "notices": notices}
    try:
        _note_families(ok, by_family, last)
    except Exception:  # noqa: BLE001 — the log lines must never stop the update
        log.exception("names: noting the families")
    return last, errors


#: the names service's limits as the box words them (names/tinhat_names: register_per_ip_per_day = 1 per internet address,
#: ip_changes_per_day = 6 per name, both over the last 24 hours) — assembly-038, launch-gate: a VPS reinstalled the same
#: day met them with no hint that they pass
LIMIT_HINTS = {
    "limit-ip": " If you reinstalled this server today, this clears within a day: the names service takes one new "
                "registration per internet address in 24 hours.",
    "limit-ip-change": " If you reinstalled or moved this server today, this clears within a day: a name's address may "
                       "change 6 times in 24 hours.",
}


#: where the box says it in its own words instead of the service's: "already registered a server today. Try tomorrow."
#: plus the hint read twice over on a VPS reinstalled the same day (sec-round2 item 3)
LIMIT_WORDS = {
    "limit-ip": "This internet address already got a new Tin Hat name in the last 24 hours, and the names service gives "
                "one a day per address. If you reinstalled this server today, set it up again tomorrow: the limit "
                "clears within a day of that registration.",
}


def explain(e: NamesError) -> str:
    """The service's words, plus when a limit clears (or the box's own words for it: LIMIT_WORDS)."""
    if e.code in LIMIT_WORDS:
        return LIMIT_WORDS[e.code]
    return str(e) + LIMIT_HINTS.get(e.code, "")


def _rank(e: NamesError) -> tuple:
    """Which family's error speaks for the box: "moved" first, then an auth/limit answer, then any other, no route last."""
    return (e.code != "moved", e.status not in (401, 403, 429), e.code == "offline")


async def update() -> dict:
    """Keep the address current, over IPv4 and IPv6 (the service sees our public address per family: A + AAAA);
    returns state + notices for the owner."""
    res, errors = await _update_each()
    moved = next((x for x in errors if x.code == "moved"), None)
    if res is None or moved is not None:
        # nothing went through, or one family says the name moved (that answer is authoritative whatever the other
        # family said: a takeover in progress; Astra, assembly-038): moved first, then an auth/limit answer, then any
        # other error, "no route" last
        e = min(errors, key=_rank) if errors else NamesError("No answer.", "offline")
        if e.code == "moved":  # restored on another computer: that one has the name now
            state.save_state(names_status={"status": "moved", "ip4": None, "ip6": None, "reason": str(e),
                                           "checked": int(time.time())})
        if e.status in (401, 403, 429):
            return {"ok": False, "status": "error", "error": e.code, "message": explain(e)}
        raise e
    if res.get("notices"):
        st = state.load_state()
        notices = (st.get("names_notices") or []) + res["notices"]
        state.save_state(names_notices=notices[-20:])
    state.save_state(names_status={"status": res.get("status"), "ip4": res.get("ip4"), "ip6": res.get("ip6"),
                                   "reason": res.get("reason"), "checked": int(time.time())})
    return res


async def probe(nonce: str, checks: list[str], family: int = 0, timeout: float = 45) -> dict:
    """The service checks the address the request comes from: `family` picks which of the box's addresses."""
    return await _call("POST", "/v1/probe", json={"nonce": nonce, "checks": checks}, auth=True, timeout=timeout,
                       family=family)


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
    res, errors = await _update_each()
    moved = next((x for x in errors if x.code == "moved"), None)
    if res is not None and moved is None:
        doc = {"status": res.get("status"), "ip4": res.get("ip4"), "ip6": res.get("ip6"), "checked": int(time.time())}
    else:
        e = moved or next((x for x in sorted(errors, key=_rank) if x.code != "offline"), None)
        if e is None:
            return st.get("former_name_status") or {}
        doc = {"status": "moved" if e.code == "moved" else "error", "error": str(e), "checked": int(time.time())}
    state.save_state(former_name_status=doc)
    return doc

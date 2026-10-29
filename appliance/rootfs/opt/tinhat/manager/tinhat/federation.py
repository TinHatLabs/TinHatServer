"""Connections between Tin Hat servers (docs/FEDERATION.md): off by default, made with a connection code, both owners
agree, either can disconnect.

  1. Owner A makes a code on A's dashboard (single use, 24 hours) and gives it to owner B.
  2. B enters A's name ("crew") and the code. B's server asks A's server: POST https://crew.tinhat.me/_tinhat/federation/request
     {from: "squad.tinhat.me", code, nonce}.
  3. A checks the code, then calls back https://squad.tinhat.me/_tinhat/federation/confirm/<nonce>: only the real
     squad.tinhat.me (its DNS name + certificate) can answer, so nobody can connect in someone else's name.
  4. Both add each other to Synapse's federation allowlist and restart Synapse.
Disconnecting removes the other server from the allowlist and tells it (it checks the call came from us the same way).

A plain Matrix server (not Tin Hat: no connection codes) is allowed by name instead: the owner types it, it goes on the
allowlist, and nothing is asked of the other side (it federates openly, or it has us on its own list).

state.json: `connections` (Tin Hat servers, by code), `allowed_servers` (Matrix servers, by name) and `federation`, the
list Synapse is given (install.py writes homeserver.yaml from it): always both lists together, written here only. An
entry of `federation` in neither list was put there by hand (before 0.3.1 an owner could only edit state.json): adopt()
keeps it as a server allowed by name, so the first change made in the dashboard never drops it.
"""
import asyncio
import logging
import re
import secrets
import time

import aiohttp

from . import compose, config, environment, limits, owndomain, state

log = logging.getLogger("tinhat.federation")

CODE_HOURS = 24
_ALPHA = config.INVITE_ALPHABET


LOCAL_SUFFIXES = (".local", ".lan", ".home", ".internal", ".localhost", ".home.arpa", ".localdomain")


def new_code() -> str:
    return "TC-" + "-".join("".join(secrets.choice(_ALPHA) for _ in range(4)) for _ in range(2))


def normalize(server: str) -> str | None:
    """'crew', 'crew.tinhat.me', 'https://crew.tinhat.me/' → 'crew.tinhat.me'; an owner's own domain as it is
    ('chat.example.com'). Never an address, a port or a home-network name: the other side proves who it is by answering
    on https://<name>/ with a valid certificate, so only names that can have one make sense."""
    zone = environment.env()["zone"]
    s = (server or "").strip().lower().removeprefix("https://").removeprefix("http://").split("/")[0].rstrip(".")
    if not s:
        return None
    if "." not in s:
        s = f"{s}.{zone}"
    if s.endswith("." + zone):
        label = s[: -len(zone) - 1]
        if not label or "." in label or not label.replace("-", "").isalnum():
            return None
        return s
    if not owndomain.HOST_RE.match(s) or s.endswith(LOCAL_SUFFIXES):
        return None
    return s


def normalize_matrix(server: str) -> tuple[str | None, str | None]:
    """A Matrix server's name as the owner may type it: 'example.org', 'https://example.org/', or someone's Matrix ID
    on it ('@max:example.org') → ('example.org', None); otherwise (None, why not). The name is kept as written (a
    server name is compared as written, so 'Example.org' stays that); the rules are checked without regard to case.
    Only names that can have a certificate, like normalize(): never an address, a port or a home-network name. A
    tinhat.me name is a Tin Hat server: those connect with a code, so both owners agree."""
    s = (server or "").strip()
    if s.startswith("@") and ":" in s:  # a person's Matrix ID: the server is everything after the first colon
        s = s.split(":", 1)[1]
    for scheme in ("https://", "http://"):
        if s[:len(scheme)].lower() == scheme:
            s = s[len(scheme):]
    s = s.split("/")[0].rstrip(".")
    low = s.lower()
    zone = environment.env()["zone"]
    if not s:
        return None, "Type the other server's name, like example.org."
    if ":" in s:
        return None, "Leave out the port: type just the server's name, like example.org."
    if low == zone or low.endswith("." + zone):
        return None, ("That's a Tin Hat server: connect to it with a connection code from its owner "
                      "(Connect to a server, above), so both of you agree.")
    if low.endswith(LOCAL_SUFFIXES) or not s.isascii() or not owndomain.HOST_RE.match(low):
        return None, ("Use the server's name as it appears after the colon in people's Matrix IDs, like example.org: "
                      "not an address or a home-network name.")
    return s, None


def connections() -> list[dict]:
    return state.load_state().get("connections") or []


def allowed() -> list[dict]:
    """Matrix servers the owner allowed by name: [{server, since, by}] (by "hand" = adopted from a hand-set list)."""
    return state.load_state().get("allowed_servers") or []


def _servers(st: dict) -> set[str]:
    return {c["server"] for c in st.get("connections") or []} | {a["server"] for a in st.get("allowed_servers") or []}


def allowlist() -> list[str]:
    """Every server this one federates with: the Tin Hat connections and the servers allowed by name."""
    return sorted(_servers(state.load_state()))


def _connected() -> set[str]:
    return {c["server"] for c in connections()}


def adopt() -> list[str]:
    """Keep what's on Synapse's list but in neither of ours (set by hand in state.json before 0.3.1, or restored from
    such a backup): each becomes a server allowed by name, so no later rewrite of the list drops it. Run at every
    start, by the update's migration and before every change. Returns what it adopted; writes only then."""
    st = state.load_state()
    known = _servers(st)
    found = []
    for s in st.get("federation") or []:
        if not isinstance(s, str):
            log.warning("federation list: ignored a %s entry (not a server name)", type(s).__name__)
            continue
        s = s.strip()
        if s and s not in known and s not in found:
            found.append(s)
    if found:
        now = int(time.time())
        kept = list(st.get("allowed_servers") or []) + [{"server": s, "since": now, "by": "hand"} for s in found]
        # Synapse's list = both of ours, which now hold every name it had: nothing on it is lost
        state.save_state(allowed_servers=kept, federation=sorted(_servers({**st, "allowed_servers": kept})))
        log.info("kept %s on the federation list as allowed by name (set by hand before)", ", ".join(found))
    return found


# A handshake nonce as this code makes them (secrets.token_urlsafe(16) = 22 characters); anything else is refused
# before it is put into the peer's confirm URL (security review, server manager lows; sec-night-2 2026-10-27).
NONCE_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
# /_tinhat/federation/disconnect: each call makes us ask the named server back over HTTPS, so it is throttled per
# caller (and all callers together, limits.OVERALL) like a connection request.
DISCONNECT_WINDOW, DISCONNECT_MOST = 600, 20


def confirm_ok(body: object, server: str, me: str | None) -> bool:
    """The peer's confirm answer: it is `server`, and the nonce was made for talking to us (`me`)."""
    if not isinstance(body, dict) or body.get("server") != server or not me or not isinstance(body.get("to"), str):
        return False
    return body["to"].strip().lower().rstrip(".") == me.lower().rstrip(".")  # (the peer's normalize() of our name)


class Federation:
    def __init__(self, apply_cb, busy=lambda: None):
        self.apply_cb = apply_cb  # async (allowlist) -> (ok, message): rewrite homeserver.yaml + restart Synapse
        self.busy = busy  # () -> why the owner's changes must wait now (a move running), else None
        self.pending: dict[str, tuple[str, float]] = {}  # nonce -> (server we're talking to, expiry)
        self.fails = limits.Fails("connect", "disconnect")  # wrong connection codes / disconnect calls, per caller
        self.lock = asyncio.Lock()
        self.apply_lock = asyncio.Lock()
        self.applying = False

    # ---- our side of a request ---------------------------------------------------------------------------------
    def confirm(self, nonce: str) -> str | None:
        """The server a pending nonce of ours was made for — once: a nonce answers one confirm (the peer asks exactly
        once), so an observed one can't be replayed."""
        hit = self.pending.pop(nonce, None)
        if hit and hit[1] > time.time():
            return hit[0]
        return None

    async def _post(self, url: str, body: dict) -> tuple[int, dict]:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as s:
                async with s.post(url, json=body, ssl=environment.ssl_context()) as r:
                    try:
                        return r.status, await r.json(content_type=None)
                    except ValueError:
                        return r.status, {}
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
            return 0, {"error": f"Couldn't reach that server ({type(e).__name__})."}

    async def connect_to(self, server: str, code: str, by: str) -> tuple[bool, str]:
        me = state.load_state().get("server_name")
        target = normalize(server)
        if not target:
            return False, (f"Use the other server's name, like “crew” or “crew.{environment.env()['zone']}”, or its "
                           "whole address if it has its own domain (like chat.example.com).")
        if target == me:
            return False, "That's this server."
        if target in _connected():  # one allowed by name may still connect with a code (and stays allowed)
            return False, "Already connected."
        nonce = secrets.token_urlsafe(16)
        self.pending[nonce] = (target, time.time() + 300)
        try:
            st, body = await self._post(f"https://{target}/_tinhat/federation/request",
                                        {"from": me, "code": (code or "").strip().upper(), "nonce": nonce})
        finally:
            self.pending.pop(nonce, None)
        if st == 0:
            return False, (f"Couldn't reach {target}. Check that it's switched on and that friends outside its home can "
                           "reach it (its dashboard's Network tab says), then try again.")
        if st != 200 or not body.get("ok"):
            return False, body.get("error") or f"{target} said no (HTTP {st})."
        async with self.lock:
            await self._add(target, by)
        return True, f"Connected to {target}."

    # ---- their side: a request arrives ------------------------------------------------------------------------
    async def _confirm_caller(self, server: str, nonce: str) -> bool:
        """Only the real `server` (its DNS name + certificate) can answer its own confirm URL with that nonce, and the
        nonce must have been made for talking to US (its `to`): one made for another server proves nothing here."""
        if not NONCE_RE.fullmatch(nonce or ""):
            return False
        me = state.load_state().get("server_name")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as s:
                async with s.get(f"https://{server}/_tinhat/federation/confirm/{nonce}", ssl=environment.ssl_context(),
                                 allow_redirects=False) as r:
                    if r.status != 200:
                        return False
                    return confirm_ok(await r.json(content_type=None), server, me)
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError, AttributeError):
            return False

    async def handle_request(self, frm: str, code: str, nonce: str, who: str) -> tuple[int, dict]:
        """`who`: the caller's address (web._client). Wrong codes count per caller (limits.py), so a stranger posting
        junk can't block real connection requests; a try is counted before the confirm round trip."""
        now = time.time()
        if self.fails.limited("connect", who, 600, 20):
            return 429, {"ok": False, "error": "Too many attempts. Try again later."}
        self.fails.failed("connect", who)
        st = state.load_state()
        if st.get("phase") != "ready" or not state.public_mode(st):
            return 403, {"ok": False, "error": "That server doesn't take connections."}
        server = normalize(frm)
        codes = st.get("connect_codes") or []
        hit = next((c for c in codes if c["code"] == (code or "").upper() and not c.get("used") and c["expires"] > now), None)
        if not server or hit is None:
            return 403, {"ok": False, "error": "That connection code isn't valid (or was already used, or expired)."}
        # Prove the caller really is `server`: only it can answer its own confirm URL.
        if not await self._confirm_caller(server, nonce):
            return 403, {"ok": False, "error": f"Couldn't confirm the request came from {server}."}
        self.fails.forgive("connect", who)
        async with self.lock:  # the code again, as it is now: two requests with one code, or one revoked meanwhile
            now = time.time()
            codes = state.load_state().get("connect_codes") or []
            hit = next((c for c in codes if c["code"] == (code or "").upper() and not c.get("used") and c["expires"] > now), None)
            if hit is None:
                return 403, {"ok": False, "error": "That connection code isn't valid (or was already used, or expired)."}
            hit["used"] = True
            hit["used_by"] = server
            state.save_state(connect_codes=codes)
            await self._add(server, f"code {hit['code']}")  # nothing in it awaits: the code and the list in one go
        return 200, {"ok": True, "server": st.get("server_name")}

    async def handle_disconnect(self, frm: str, nonce: str, who: str = "") -> tuple[int, dict]:
        """`who`: the caller's address (web._client). Throttled (each call makes us ask the named server back), counted
        before the round trip and taken back when the disconnect was real."""
        if self.fails.limited("disconnect", who, DISCONNECT_WINDOW, DISCONNECT_MOST):
            return 429, {"ok": False, "error": "Too many attempts. Try again later."}
        self.fails.failed("disconnect", who)
        if not NONCE_RE.fullmatch(nonce or ""):
            return 400, {"ok": False, "error": "Bad request."}
        server = normalize(frm)
        if not server or server not in _connected():  # a server allowed by name is the owner's to remove, not theirs
            return 200, {"ok": True}
        if not await self._confirm_caller(server, nonce):
            return 403, {"ok": False, "error": "Couldn't confirm the request."}
        self.fails.forgive("disconnect", who)
        async with self.lock:
            await self._remove(server, notify=False)
        return 200, {"ok": True}

    # ---- both sides ---------------------------------------------------------------------------------------------
    async def disconnect(self, server: str) -> tuple[bool, str]:
        target = normalize(server)
        if not target or target not in _connected():
            return False, "Not connected to that server."
        async with self.lock:
            await self._remove(target, notify=True)
        return True, f"Disconnected from {target}."

    # ---- Matrix servers allowed by name (no handshake: they aren't Tin Hat servers) --------------------------
    async def allow(self, server: str, by: str) -> tuple[bool, str]:
        target, why = normalize_matrix(server)
        if not target:
            return False, why
        if target.lower() == str(state.load_state().get("server_name") or "").lower():
            return False, "That's this server."
        async with self.lock:
            adopt()
            st = state.load_state()
            if target.lower() in {c["server"].lower() for c in st.get("connections") or []}:
                return False, f"{target} is already connected (Other Tin Hat servers)."
            kept = st.get("allowed_servers") or []
            if target.lower() in {a["server"].lower().rstrip(".") for a in kept}:
                return False, f"{target} is already allowed."
            if why := self.busy():  # checked right before the write: nothing awaited in between
                return False, why
            kept = kept + [{"server": target, "since": int(time.time()), "by": by}]
            self._save(st, allowed_servers=kept)
        log.info("allowed %s by name (%s)", target, by)
        return True, f"Allowed {target}. The chat server restarts to apply it (a few seconds)."

    async def disallow(self, server: str) -> tuple[bool, str]:
        target = server or ""
        async with self.lock:
            adopt()
            st = state.load_state()
            kept = st.get("allowed_servers") or []
            left = [a for a in kept if a["server"] != target]  # exactly the entry the dashboard shows, never a look-alike
            if len(left) == len(kept):
                return False, "That server isn't on the list."
            if why := self.busy():
                return False, why
            self._save(st, allowed_servers=left)
        log.info("removed %s from the servers allowed by name", target)
        return True, f"Removed {target}. People here and there can't reach each other any more."

    def make_code(self, by: str) -> dict:
        now = time.time()
        codes = [c for c in (state.load_state().get("connect_codes") or []) if c["expires"] > now - 7 * 86400]
        c = {"code": new_code(), "created": int(now), "expires": int(now + CODE_HOURS * 3600), "by": by, "used": False}
        codes.append(c)
        state.save_state(connect_codes=codes)
        return c

    def revoke_code(self, code: str) -> bool:
        codes = state.load_state().get("connect_codes") or []
        left = [c for c in codes if c["code"] != code.upper()]
        state.save_state(connect_codes=left)
        return len(left) != len(codes)

    def _schedule_apply(self):
        """Synapse only reads its allowlist at start: restart it in the background (both sides answer first)."""
        async def run():
            async with self.apply_lock:
                self.applying = True
                try:
                    ok, msg = await self.apply_cb(allowlist())
                    log.info("allowlist applied (%s): %s", ok, msg)
                finally:
                    self.applying = False
        asyncio.get_running_loop().create_task(run())

    def _save(self, st: dict, **lists):
        """Change our lists and Synapse's list in ONE write (both lists, never just the connections), then apply."""
        new = {**st, **lists}
        state.save_state(**lists, federation=sorted(_servers(new)))
        self._schedule_apply()

    async def _add(self, server: str, by: str):
        adopt()
        st = state.load_state()
        conns = [c for c in st.get("connections") or [] if c["server"] != server]
        conns.append({"server": server, "since": int(time.time()), "by": by})
        # one allowed by name keeps that entry too: ending the connection (either side) never takes the owner's own
        # allowance away; the owner removes it under Other Matrix servers
        self._save(st, connections=conns)
        log.info("connected %s (%s)", server, by)

    async def _remove(self, server: str, notify: bool):
        adopt()
        st = state.load_state()
        conns = [c for c in st.get("connections") or [] if c["server"] != server]
        self._save(st, connections=conns)
        if notify:
            nonce = secrets.token_urlsafe(16)
            self.pending[nonce] = (server, time.time() + 120)
            try:
                await self._post(f"https://{server}/_tinhat/federation/disconnect",
                                 {"from": state.load_state().get("server_name"), "nonce": nonce})
            finally:
                self.pending.pop(nonce, None)
        log.info("disconnected %s", server)

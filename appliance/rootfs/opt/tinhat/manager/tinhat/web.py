"""The manager's HTTP side (127.0.0.1:8090, always behind the box's Caddy):

  /                         the setup wizard (before setup) or the new-device welcome page (after)
  /admin/                   the dashboard (https only; sign in with an admin's Tin Hat account)
  /admin/ui/*               the pages' CSS/JS/images
  /admin/ca.crt             the box's certificate authority (home-network mode), for new devices
  /admin/setup/*            the wizard's API (gone once the server is set up)
  /admin/api/*              the dashboard's API
  /tinhat-api/admin/*       Caddy maps the Tin Hat API's /api/admin/* here: invite codes with the same shapes as
                            the Tin Hat API's invites.mjs (api/tinhat-api), so Tin Hat's own Settings → Invites works here
"""
import asyncio
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

from . import apiconf, newcomers, backup, gameservers, bench, compose, config, console, environment, federation, hw, limits, lkadmin, mdns, move, moved, names, owndomain, reach, recovery, relay, repairs, sessions, sshaccess, state, support, updates
from . import pyenv, templates
from .install import Installer, validate, write_synapse_config
from .synapse import Synapse

log = logging.getLogger("tinhat.web")

SETUP_COOKIE = "tinhat_setup"
ADMIN_COOKIE = "tinhat_admin"
SESSION_HOURS = 12
CODE_RE_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")


def _json(data, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


def _err(msg: str, status: int) -> web.Response:
    return _json({"error": msg}, status)


def _https(req: web.Request) -> bool:
    return req.headers.get("X-Forwarded-Proto", "").lower() == "https"


_cache: dict[str, tuple[float, object]] = {}


def _cached(name: str, ttl: float, make):
    hit = _cache.get(name)
    now = time.monotonic()
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = make()
    _cache[name] = (now, value)
    return value


def _proxies() -> set[str] | None:
    """The proxies Caddy trusts besides home addresses: only behind the owner's own reverse proxy (CADDY_PROXY), where
    one on this same machine connects from its own addresses (the ones written into that Caddyfile). None: Caddy
    trusts no proxy. Worked out once a minute, not per request (hw.addresses() runs `ip`)."""
    def make():
        if not (state.load_state().get("mode") == "domain" and owndomain.settings()[0] == "proxy"):
            return None
        return {a for a in hw.addresses() if ":" not in a} | {a for a in owndomain.proxies() if "/" not in a}
    return _cached("proxies", 60, make)


def _home_nets() -> list:
    """This machine's own on-link IPv6 networks (limits.home), once a minute."""
    return _cached("home-nets", 60, hw.ipv6_nets)


def _client(req: web.Request) -> str:
    """The caller's address (limits.client), worked out once per request."""
    try:
        return req["tinhat_client"]
    except KeyError:
        pass
    who = limits.client(req.headers.get("X-Forwarded-For", ""), req.remote, _proxies)
    req["tinhat_client"] = who
    return who


def _home(req: web.Request) -> bool:
    return limits.home(_client(req), _home_nets())


def _peer(req: web.Request) -> str:
    """Behind the owner's reverse proxy: the address that connected to the proxy port (Caddy's X-Tinhat-Peer on the
    dashboard's route, which replaces whatever a caller sent). "" in every other mode, or when it isn't an address."""
    if not state.behind_proxy():
        return ""
    a = limits._ip(req.headers.get("X-Tinhat-Peer", ""))
    return str(a) if a is not None else ""


async def apply_proxy_addresses(new: list[str]) -> tuple[bool, str]:
    """Save the proxy list and put it live. Success only once the web server runs it (second review): the Caddyfile is
    written beside the live one (Caddyfile.new), validated, and only then swapped in and reloaded (review of 116d103,
    #5: a manager restart between writing and validating must never leave an unchecked file for Caddy's next start).
    A refused file changes nothing; a failed reload puts the previous Caddyfile and state back and reloads them. The
    caller holds _apply_lock (the dashboard) or is the console; the state is read here, under it. -> (ok, why not)."""
    from . import install
    st = state.load_state()
    before = dict(st.get("domain") or {})
    dom = {k: v for k, v in before.items() if k != "proxies"}
    if new:
        dom["proxies"] = new
    live = config.CADDYFILE
    staged = live.with_name(live.name + ".new")
    old = live.read_bytes() if live.exists() else None
    old_mode = (live.stat().st_mode & 0o777) if live.exists() else 0o644
    state.save_state(domain=dom)
    try:
        install.refresh_configs(caddyfile_to=staged)
        if not staged.exists():
            state.save_state(domain=before)
            return False, "no Caddyfile was written"
        rc, out = await compose.caddy_validate(f"/etc/caddy/{staged.name}")
        if rc != 0:
            state.save_state(domain=before)
            return False, f"validate: {out[-400:]}"
        os.replace(staged, live)
        rc, out = await compose.caddy_reload()
        if rc == 0:
            return True, ""
        why = f"reload: {out[-400:]}"
        state.save_state(domain=before)
        if old is not None:
            fd, tmp = tempfile.mkstemp(dir=live.parent, prefix=f".{live.name}.")
            with os.fdopen(fd, "wb") as f:
                f.write(old)
            os.chmod(tmp, old_mode)
            os.replace(tmp, live)
        await compose.caddy_reload()  # best effort: the previous Caddyfile is what ran before
        return False, why
    finally:
        staged.unlink(missing_ok=True)


def _page(name: str) -> web.FileResponse:
    return web.FileResponse(config.UI_DIR / name, headers={"Cache-Control": "no-cache",
                                                          "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https: http:; frame-ancestors 'none'"})


def _mint() -> str:
    pick = lambda n: "".join(secrets.choice(config.INVITE_ALPHABET) for _ in range(n))  # noqa: E731
    return f"{config.INVITE_PREFIX}{pick(4)}-{pick(4)}"


def _shape(t: dict) -> dict:
    """An invite code in the shape the Tin Hat API's invites.mjs returns (Tin Hat's Settings → Invites reads it)."""
    now_ms = time.time() * 1000
    used = (t.get("completed") or 0) + (t.get("pending") or 0)
    return {
        "code": t.get("token"),
        "usesAllowed": t.get("uses_allowed"),
        "pending": t.get("pending") or 0,
        "completed": t.get("completed") or 0,
        "expiresAt": t.get("expiry_time"),
        "active": (t.get("expiry_time") is None or t["expiry_time"] > now_ms)
        and (t.get("uses_allowed") is None or used < t["uses_allowed"]),
    }


class Manager:
    def __init__(self) -> None:
        self.synapse = Synapse()
        self.checker = reach.Checker()
        self.installer = Installer(self.synapse, self.checker)
        self.network_busy = False
        self._bg_update: asyncio.Task | None = None  # an owner-started update download (kept so it is not collected)
        self._bg_backup: asyncio.Task | None = None  # a backup, a test restore or a download being made
        self._bg_tick_update: asyncio.Task | None = None  # the nightly update work (can take minutes)
        # an owner's allow/remove is re-checked against a running move right before it is written (the move refuses
        # to start while the list isn't empty: both checks run without an await in between)
        self.federation = federation.Federation(
            self._apply_federation, busy=lambda: "The server is moving to its new address; try again when it's done."
            if self.mover.running else None)
        # The setup page's unlock survives the manager restarting too (an update before a restore restarts it).
        self.setup_sessions = sessions.Sessions(4, config.STATE_DIR / "setup-sessions.json")
        self.sessions = sessions.Sessions(SESSION_HOURS)  # survives the manager restarting (updates)
        # "Move to your own domain" (move.py); the owner's dashboard sign-in follows the account to its new name
        self.mover = move.Mover(self.synapse, self.checker, on_switched=self.sessions.rename)
        self._move_checking = asyncio.Lock()
        self.fails = limits.Fails("unlock", "login", "restore", "recover", "recover-start", "backup-pw", "people-password")
        self.operators: dict[str, tuple[bool, float]] = {}
        self.bench: dict | None = None      # processor + disk, measured on the box (bench.py)
        self.net: dict | None = None        # what the wizard's browser measured between itself and the box
        self._bench_lock = asyncio.Lock()
        self._apply_lock = asyncio.Lock()  # one settings change at a time
        self._noise = os.urandom(1 << 20)   # 1 MiB of random bytes for the download test (incompressible)

    # ---- helpers ------------------------------------------------------------------------------------------------

    def _limited(self, kind: str, req: web.Request, window: float, most: int, overall: bool = True) -> bool:
        # per caller + all together (limits.py); behind the owner's own proxy a "home" address is only what a header
        # says, so there it doesn't skip the together-ceiling
        return self.fails.limited(kind, _client(req), window, most, overall,
                                  trust_home=_proxies() is None, own_nets=_home_nets())

    def _failed(self, kind: str, req: web.Request) -> None:
        """Count a try. Where a try awaits anything, count it first and _forgive it when it turns out right."""
        self.fails.failed(kind, _client(req))

    def _forgive(self, kind: str, req: web.Request) -> None:
        self.fails.forgive(kind, _client(req))

    def _setup_ok(self, req: web.Request) -> bool:
        t = req.cookies.get(SETUP_COOKIE, "")
        return self.setup_sessions.get(t) is not None

    def _admin(self, req: web.Request) -> dict | None:
        if not _https(req):
            return None
        return self.sessions.get(req.cookies.get(ADMIN_COOKIE, ""))

    @staticmethod
    def _csrf_ok(req: web.Request) -> bool:
        # Every state-changing call from our pages carries this header; a cross-site form can't add it.
        return req.headers.get("X-Tinhat") == "1"

    def _system_token(self) -> str | None:
        return state.load_secrets().get("system_token")

    async def _is_operator(self, mxid: str) -> bool:
        hit = self.operators.get(mxid)
        if hit and time.time() - hit[1] < 60:
            return hit[0]
        tok = self._system_token()
        ok = bool(tok) and await self.synapse.is_admin(mxid, tok)
        self.operators[mxid] = (ok, time.time())
        return ok

    # ---- pages --------------------------------------------------------------------------------------------------

    async def root(self, req: web.Request) -> web.StreamResponse:
        if state.phase() == "ready":
            return _page("welcome.html")
        return _page("setup.html")

    async def admin_page(self, req: web.Request) -> web.StreamResponse:
        st = state.load_state()
        if st.get("phase") != "ready":
            raise web.HTTPFound("/")
        if not _https(req):
            raise web.HTTPFound(f"https://{st['server_name']}/admin/")
        if req.path == "/admin":
            raise web.HTTPFound("/admin/")
        return _page("admin.html")

    async def ui(self, req: web.Request) -> web.StreamResponse:
        rel = req.match_info["path"]
        if rel == "logo.svg":
            p = config.WEB_DIR / "appicon" / "tinhat.svg"
        else:
            p = (config.UI_DIR / rel).resolve()
            if config.UI_DIR.resolve() not in p.parents:
                raise web.HTTPNotFound()
        if not p.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Cache-Control": "no-cache"})

    async def ca(self, req: web.Request) -> web.StreamResponse:
        p = config.CA_DIR / "root.crt"
        st = state.load_state()
        if st.get("phase") != "ready" or not p.is_file():
            raise web.HTTPNotFound()
        name = st.get("server_name", "server").replace(".", "-")
        return web.Response(body=p.read_bytes(), content_type="application/x-x509-ca-cert",
                            headers={"Content-Disposition": f'attachment; filename="tinhat-{name}.crt"', "Cache-Control": "no-cache"})

    async def name_check(self, req: web.Request) -> web.Response:
        """The computer this server was just restored on tells this one (moved.py): GET a challenge, then POST its proof
        that it holds a restored copy, and this one stands down at once. Without a proof, a tinhat.me name asks the
        names service now instead (at most every 20 seconds)."""
        if req.method == "GET":
            return _json(moved.challenge())
        try:
            body = await req.json() if req.can_read_body else {}
        except ValueError:
            body = {}
        return _json(await moved.check_now(body.get("nonce"), body.get("proof"), body.get("to")))

    # ---- setup wizard API ---------------------------------------------------------------------------------------

    async def setup_status(self, req: web.Request) -> web.Response:
        st = state.load_state()
        ready = st.get("phase") == "ready"
        session = self._setup_ok(req)
        # Once set up, a stranger (no setup or dashboard session, not on the home network or this machine: the welcome
        # page, the tray and the updater are) learns only what the welcome and sign-in pages need: not the version,
        # how the server reaches the internet, or where a restored copy came from. The edition and platform stay: the
        # "Forgot your password?" card picks its instructions from them (docker exec / sudo / the tray), also when
        # the owner is away from home (review of 116d103, #6).
        told = not ready or session or self._admin(req) is not None or _home(req)
        out = {"phase": st.get("phase", "unconfigured"), "serverName": st.get("server_name"),
               "mode": st.get("mode", "lan"), "zone": environment.env()["zone"], "moved": moved.is_moved(st),
               "unlocked": session or ready, "setupSession": session,
               "edition": config.edition(), "platform": "windows" if updates.wsl() else None}
        if told:
            out.update(version=config.VERSION, proxyOnly=config.proxy_only())
        rf = st.get("restored_from") or {}
        if ready and session and rf and time.time() - rf.get("at", 0) < 86400:
            out["restoredFrom"] = {"at": rf.get("at"), "backupTime": rf.get("backup_time"),  # the last page says so
                                   "toldOld": rf.get("told_old"), "oldAddresses": rf.get("old_addresses") or []}
        if ready and state.public_mode(st) and told:
            if session:
                out["network"] = self._network_doc()  # the wizard's last page shows the outside check's results
                await self._relay_offer(out["network"])
            last = st.get("reach") or {}
            out["reach"] = {"ok": bool(last.get("ok")), "at": last.get("at")}  # the welcome page's one line about it
            out["relay"] = {"on": relay.on(), "cgnat": (st.get("ports") or {}).get("kind") == "cgnat"}
        if out["unlocked"] and st.get("phase") != "ready":
            out["progress"] = {**self.installer.progress(), "question": relay.question()}
            out["addresses"] = hw.addresses()
            out["restoring"] = bool(st.get("restoring"))  # a restore under way or stopped: the page keeps its words
            if st.get("phase") == "failed":
                out["error"] = st.get("error")
                out["errorDetails"] = st.get("error_details", "")
        return _json(out)

    async def setup_unlock(self, req: web.Request) -> web.Response:
        if state.phase() == "ready":
            return _err("This server is already set up.", 409)
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if self._limited("unlock", req, 600, 10):
            return _err("Too many wrong codes. Wait a few minutes, then try again.", 429)
        self._failed("unlock", req)  # counted before anything is awaited; taken back when right
        body = await req.json()
        typed = "".join(ch for ch in str(body.get("code", "")) if ch.isdigit())
        want = (state.setup_code() or "").replace("-", "")
        if not want or not secrets.compare_digest(typed, want):
            return _err("That code doesn't match. Check the code on your server's screen.", 403)
        self._forgive("unlock", req)
        tok = self.setup_sessions.new("setup")
        resp = _json({"ok": True})
        resp.set_cookie(SETUP_COOKIE, tok, httponly=True, samesite="Strict", path="/", max_age=4 * 3600)
        return resp

    async def setup_probe(self, req: web.Request) -> web.Response:
        if state.phase() == "ready":
            return _err("This server is already set up.", 409)
        if not self._setup_ok(req):
            return _err("Enter the setup code first.", 401)
        p = await asyncio.to_thread(hw.probe)
        return _json({"probe": p, "advice": hw.advise(p, self.bench, self.net)})

    # ---- the wizard's tests: processor + disk on the box, network between the browser and the box -------------

    def _setup_gate(self, req: web.Request) -> web.Response | None:
        if state.phase() == "ready":
            return _err("This server is already set up.", 409)
        if not self._setup_ok(req):
            return _err("Enter the setup code first.", 401)
        return None

    async def setup_bench(self, req: web.Request) -> web.Response:
        # (an aiohttp response is a mapping with no items: falsy, so it is compared with None, never tested for truth)
        if (bad := self._setup_gate(req)) is not None or not self._csrf_ok(req):
            return bad if bad is not None else _err("Bad request.", 400)
        async with self._bench_lock:  # one run at a time; a second click waits for the first
            self.bench = await asyncio.to_thread(bench.run, str(config.STATE_DIR))
        return _json(self.bench)

    async def speed_ping(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        return _json({"t": time.time()})

    async def speed_down(self, req: web.Request) -> web.StreamResponse:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        try:
            mb = max(1, min(100, int(req.query.get("mb", "8"))))
        except ValueError:
            mb = 8
        resp = web.StreamResponse(headers={"Content-Type": "application/octet-stream", "Cache-Control": "no-store",
                                           "Content-Length": str(mb << 20)})
        await resp.prepare(req)
        for _ in range(mb):
            await resp.write(self._noise)
        await resp.write_eof()
        return resp

    async def speed_up(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        n = 0
        async for chunk in req.content.iter_chunked(1 << 16):
            n += len(chunk)
            if n > 100 << 20:
                return _err("Too much data.", 413)
        return _json({"bytes": n})

    async def setup_assess(self, req: web.Request) -> web.Response:
        """The browser hands over what it measured; the answer is every verdict (checks + features)."""
        # (an aiohttp response is a mapping with no items: falsy, so it is compared with None, never tested for truth)
        if (bad := self._setup_gate(req)) is not None or not self._csrf_ok(req):
            return bad if bad is not None else _err("Bad request.", 400)
        body = await req.json()
        net = body.get("net") or None
        if net:
            def num(k):
                v = net.get(k)
                return round(float(v), 1) if isinstance(v, (int, float)) and v >= 0 else None
            net = {"down": num("down"), "up": num("up"), "rtt": num("rtt")}
            if net["down"] is None or net["up"] is None:
                net = None
        if net:  # a browser on the server itself (Tin Hat Server for Windows: the same PC) measures the PC, not the network
            try:
                who = ipaddress.ip_address(_client(req))
                net["local"] = who.is_loopback or str(who) in await asyncio.to_thread(hw.addresses)
            except ValueError:
                pass
        self.net = net
        p = await asyncio.to_thread(hw.probe)
        return _json({"probe": p, "bench": self.bench, "net": self.net, "advice": hw.advise(p, self.bench, self.net)})

    async def setup_install(self, req: web.Request) -> web.Response:
        if state.phase() == "ready":
            return _err("This server is already set up.", 409)
        if not self._setup_ok(req) or not self._csrf_ok(req):
            return _err("Enter the setup code first.", 401)
        if self.installer.running:
            return _err("Setup is already running.", 409)
        answers, problem = validate(await req.json())
        if problem:
            return _err(problem, 400)
        p = await asyncio.to_thread(hw.probe)
        if not hw.advise(p)["ready"]:
            return _err("This machine is too small for Tin Hat Server (it needs 2 GB of memory and 4 GB of free disk).", 400)
        state.save_state(assessment={"bench": self.bench, "net": self.net, "at": int(time.time())})
        self.installer.start(answers)
        return _json({"ok": True, "serverName": answers["server_name"]}, 202)

    async def setup_names(self, req: web.Request) -> web.Response:
        """The wizard's live check of a from-anywhere name (and the server code, when given)."""
        if (bad := self._setup_gate(req)) is not None:
            return bad
        name = (req.query.get("name") or "").strip().lower()
        try:
            if not name:
                info = await names.info()
                return _json({"ok": True, "online": True, "zone": info.get("zone"), "inviteOnly": info.get("invite_only")})
            res = await names.check(name, req.query.get("code"))
        except names.NamesError as e:
            return _json({"ok": False, "online": False, "message": str(e)})
        return _json({"online": True, "ok": res.get("ok"), "message": res.get("message", ""), "fqdn": res.get("fqdn"),
                      "codeOk": res.get("code_ok"), "inviteOnly": res.get("invite_only")})

    async def probe_answer(self, req: web.Request) -> web.Response:
        """The names service's outside check fetches this through the router: answering proves port 443 reaches us."""
        nonce = req.match_info["nonce"]
        if self.checker.answers(nonce):
            return web.Response(text=nonce, content_type="text/plain", headers={"Cache-Control": "no-store"})
        raise web.HTTPNotFound()

    # ---- dashboard API ------------------------------------------------------------------------------------------

    async def login(self, req: web.Request) -> web.Response:
        if not _https(req) or not self._csrf_ok(req):
            return _err("Open the dashboard over https.", 400)
        if state.phase() != "ready":
            return _err("This server isn't set up yet.", 409)
        if self._limited("login", req, 300, 8):
            return _err("Too many tries. Wait a few minutes, then try again.", 429)
        self._failed("login", req)  # counted before anything is awaited; taken back when right (or not a try)
        body = await req.json()
        user = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not user or not password:
            self._forgive("login", req)
            return _err("Enter your username and password.", 400)
        st, res = await self.synapse.login(user, password, "Tin Hat Server dashboard", client=_client(req))
        if st == 429:
            self._forgive("login", req)
            return _err(_slow_down(res), 429)
        if st != 200 or "access_token" not in res:
            return _err("That username and password didn't work.", 403)
        self._forgive("login", req)
        mxid = res["user_id"]
        # The session only needs to know who you are; the dashboard works through the box's own admin
        # account, so the sign-in token is thrown away again (no stray "device" in your account).
        await self.synapse.logout(res["access_token"])
        if not await self._is_operator(mxid):
            return _err("That account isn't an admin of this server.", 403)
        tok = self.sessions.new(mxid)
        resp = _json({"ok": True, "mxid": mxid})
        resp.set_cookie(ADMIN_COOKIE, tok, httponly=True, secure=True, samesite="Strict", path="/admin")
        log.info("dashboard sign-in: %s", mxid)
        return resp

    async def login_token(self, req: web.Request) -> web.Response:
        """"Continue as …": the dashboard is on the same origin as Tin Hat Web, so it can hand over the Tin Hat session
        this browser already has. The token only proves who you are (whoami); it is not kept, and the app's session
        stays signed in."""
        if not _https(req) or not self._csrf_ok(req):
            return _err("Open the dashboard over https.", 400)
        if state.phase() != "ready":
            return _err("This server isn't set up yet.", 409)
        # A session token can't be guessed, so many strangers' wrong passwords never block this way in (no overall limit).
        if self._limited("login", req, 300, 8, overall=False):
            return _err("Too many tries. Wait a few minutes, then try again.", 429)
        self._failed("login", req)  # counted before anything is awaited; taken back when right
        body = await req.json()
        mxid = await self.synapse.whoami(str(body.get("token", "")))
        if not mxid:
            return _err("That Tin Hat session has ended. Sign in with your password instead.", 403)
        self._forgive("login", req)
        if not await self._is_operator(mxid):
            return _err("That account isn't an admin of this server.", 403)
        tok = self.sessions.new(mxid)
        resp = _json({"ok": True, "mxid": mxid})
        resp.set_cookie(ADMIN_COOKIE, tok, httponly=True, secure=True, samesite="Strict", path="/admin")
        log.info("dashboard sign-in (Tin Hat session): %s", mxid)
        return resp

    async def logout(self, req: web.Request) -> web.Response:
        self.sessions.drop(req.cookies.get(ADMIN_COOKIE, ""))
        resp = _json({"ok": True})
        resp.del_cookie(ADMIN_COOKIE, path="/admin")
        return resp

    async def me(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s:
            return _err("Sign in first.", 401)
        st = state.load_state()
        return _json({"mxid": s["mxid"], "serverName": st.get("server_name"), "mode": st.get("mode", "lan"),
                      "zone": environment.env()["zone"]})

    async def overview(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        st = state.load_state()
        ps = await compose.ps()
        wanted = ["caddy", "postgres", "synapse"] + (["livekit", "lk-jwt"] if st.get("calls", True) else [])
        services = []
        for svc in wanted:
            info = ps.get(svc, {})
            ok = info.get("state") == "running" and info.get("health") in ("", "healthy")
            services.append({"id": svc, "label": compose.LABELS[svc], "ok": ok, "state": info.get("state") or "not running",
                             "health": info.get("health", ""), "status": info.get("status", "")})
        p = await asyncio.to_thread(hw.probe)
        assessed = st.get("assessment") or {}
        tok = self._system_token()
        people = [u for u in await self.synapse.users(tok) if not u.get("name", "").startswith(f"@{config.SYSTEM_LOCALPART}:")] if tok else []
        web_version = ""
        try:
            import json as _j
            web_version = _j.loads((config.WEB_DIR / "version.json").read_text()).get("version", "")
        except (OSError, ValueError):
            pass
        return _json({
            "serverName": st.get("server_name"), "mode": st.get("mode"), "version": config.VERSION, "webVersion": web_version,
            "installedAt": st.get("installed_at"), "services": services, "probe": p, "moved": moved.is_moved(st),
            "advice": hw.advise(p, assessed.get("bench"), assessed.get("net")), "features": st.get("features"),
            "api": apiconf.doc(st), "python": pyenv.CURRENT or None,
            "counts": {"people": len([u for u in people if not u.get("deactivated")]), "rooms": await self.synapse.room_count(tok) if tok else None},
            "watch": await self._watch(),
        })

    async def _watch(self) -> list[dict]:
        """What the owner should look at besides the services: backups and updates (round 6: the Overview said
        "healthy" while backups couldn't run)."""
        out = []
        b, bs = backup.settings(), backup.status()
        if not b.get("dest") or not state.load_secrets().get("backup_password"):
            out.append({"level": "warn", "text": "Backups aren't set up yet."})
        elif b.get("dest") == "usb" and not any(x.get("uuid") == (b.get("usb") or {}).get("uuid")
                                                for x in await asyncio.to_thread(backup.drives)):
            out.append({"level": "bad", "text": "Backups can't run: their USB drive isn't plugged into this server."})
        elif bs.get("phase") == "failed":
            out.append({"level": "bad", "text": "The last backup didn't work."})
        elif (bs.get("last") or {}).get("at") and time.time() - bs["last"]["at"] > 3 * 86400:
            out.append({"level": "warn", "text": f"The last backup was {int((time.time() - bs['last']['at']) // 86400)} days ago."})
        up = updates.status().get("phase")
        if up == "broken":
            out.append({"level": "bad", "text": "The last update needs attention."})
        elif up == "rolled-back":
            out.append({"level": "warn", "text": "The last update didn't start properly, so the server went back to the version before."})
        if (pyenv.CURRENT or {}).get("runtime") == "system":
            off = pyenv.is_off(config.STATE_DIR)
            why = ("because it was turned off on this machine (`tinhat pyenv on` turns it back on)" if off else
                   f"because Tin Hat's own copy didn't pass its check: {pyenv.CURRENT.get('reason')}")
            todo = ("" if off else
                    "What to do: update to the next version when it's out (`docker compose pull && docker compose up -d` "
                    "where its compose file is); it sets Tin Hat's copy up again. If this is still here after an update, "
                    "make a backup and set Tin Hat Server up again from it. " if config.compose_edition() else
                    "What to do: install the next update when Updates offers it (it sets Tin Hat's copy up again). If "
                    "this is still here after an update, make a backup and reinstall Tin Hat Server from it. ")
            out.append({"level": "warn", "text": "This server runs on an older web toolkit with known security problems "
                        f"(the operating system's aiohttp {pyenv.CURRENT.get('aiohttp') or ''}), {why}. Everything still "
                        f"works. {todo}The support report has the details."})
        return out

    async def people(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        tok = self._system_token()
        out = []
        for u in await self.synapse.users(tok):
            if u.get("name", "").startswith(f"@{config.SYSTEM_LOCALPART}:"):
                continue
            out.append({"mxid": u.get("name"), "name": u.get("displayname") or u.get("name"), "admin": bool(u.get("admin")),
                        "deactivated": bool(u.get("deactivated")), "created": u.get("creation_ts"), "lastSeen": u.get("last_seen_ts")})
        out.sort(key=lambda x: (x["deactivated"], -(x["created"] or 0)))
        return _json({"people": out})

    async def people_password(self, req: web.Request) -> web.Response:
        """People → Set a new password, for someone who forgot theirs (this server sends no email). The server makes the
        password: the owner sees it once and hands it over; it is never kept or logged. The person signs in with it and
        picks their own in the app (Settings → Devices & security → Change password). Their devices stay signed in unless the
        owner asks: a signed-out device that held the only copy of their message keys loses their old messages."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if self._limited("people-password", req, 3600, 30):
            return _err("That's a lot of new passwords in one hour. Try again later.", 429)
        self._failed("people-password", req)  # each one counts toward that ceiling
        try:
            body = await req.json()
        except ValueError:
            return _err("Bad request.", 400)
        sn = state.load_state().get("server_name", "")
        mxid = str(body.get("mxid", "")).strip()
        if not sn or not re.fullmatch(r"@[a-z0-9._=/+-]+:" + re.escape(sn), mxid):
            return _err("That isn't an account on this server.", 400)
        if mxid == f"@{config.SYSTEM_LOCALPART}:{sn}":
            return _err("That's the server's own account.", 400)
        if mxid == s.get("mxid"):
            return _err("Change your own password in the Tin Hat app: Settings → Devices & security → Change password.", 400)
        tok = self._system_token()
        # The caller's dashboard sign-in may be older than a demotion: they must still be an active admin right now.
        st, me_u = await self.synapse.user(s.get("mxid", ""), tok)
        if st != 200 or me_u.get("admin") is not True or me_u.get("deactivated"):
            self.sessions.drop_for(s.get("mxid", ""))
            return _err("You aren't an admin of this server any more. Sign in again.", 401)
        st, u = await self.synapse.user(mxid, tok)
        if st == 404:
            return _err(f"There's no {mxid} on this server.", 404)
        if st != 200:
            return _err(f"The chat server said {st}.", 502)
        if u.get("deactivated"):
            return _err(f"{mxid} was removed from this server.", 400)
        pw = "-".join("".join(secrets.choice(config.PASSWORD_ALPHABET) for _ in range(4)) for _ in range(4))
        out_everywhere = body.get("signOutEverywhere") is True
        st, out = await self.synapse.req("POST", f"/_synapse/admin/v1/reset_password/{quote(mxid, safe='')}", tok,
                                         json={"new_password": pw, "logout_devices": out_everywhere})
        if st != 200:
            return _err(f"The chat server didn't take the new password ({(out or {}).get('error') or st}).", 502)
        # their dashboard sign-ins end either way: one may be in the wrong hands, and it could reset others
        dropped = self.sessions.drop_for(mxid)
        log.info("%s set a new password for %s (signed out everywhere: %s; dashboard sign-ins ended: %d)",
                 s.get("mxid"), mxid, out_everywhere, dropped)
        return _json({"ok": True, "mxid": mxid, "password": pw, "signedOut": out_everywhere})

    async def invites_list(self, req: web.Request, admin_ok: bool = False) -> web.Response:
        if not admin_ok and not self._admin(req):
            return _err("Sign in first.", 401)
        st, body = await self.synapse.tokens(self._system_token())
        if st != 200:
            return _err(f"The chat server said {st}.", 502)
        lst = sorted((_shape(t) for t in body.get("registration_tokens", [])),
                     key=lambda a: (not a["active"], -(a["expiresAt"] or float("inf"))))
        s = self._admin(req)
        app_device = await self._has_app_device(s["mxid"]) if s else True
        st = state.load_state()
        return _json({"invites": lst, "server": st.get("server_name"), "web": apiconf.settings(st)["web"],
                      "now": int(time.time() * 1000), "adminHasAppDevice": app_device})

    async def _has_app_device(self, mxid: str) -> bool:
        """Has this person signed in to Tin Hat on a device that can read encrypted messages (uploaded its keys)?
        The dashboard's own sign-in makes a device too, but never keys. Unsure (an error) counts as yes."""
        st, body = await self.synapse.req("POST", "/_matrix/client/v3/keys/query", self._system_token(),
                                          json={"device_keys": {mxid: []}})
        if st != 200:
            return True
        return bool((body.get("device_keys") or {}).get(mxid))

    async def invites_create(self, req: web.Request, who: str | None = None) -> web.Response:
        if who is None:
            s = self._admin(req)
            if not s or not self._csrf_ok(req):
                return _err("Sign in first.", 401)
            who = s["mxid"]
        try:
            body = await req.json()
        except ValueError:
            body = {}
        uses = body.get("uses", 1)
        days = body.get("days", 7)
        if not isinstance(uses, int) or not isinstance(days, int) or not (0 <= uses <= 1000) or not (0 <= days <= 3650):
            return _err("uses 0..1000 (0 = unlimited), days 0..3650 (0 = never)", 400)
        payload = {"token": _mint(), "uses_allowed": None if uses == 0 else uses,
                   "expiry_time": None if days == 0 else int(time.time() * 1000) + days * 86_400_000}
        st, res = await self.synapse.token_new(self._system_token(), payload)
        if st != 200:
            return _err(res.get("error") or f"The chat server said {st}.", 502)
        log.info("%s minted %s (uses %s, days %s)", who, res.get("token"), uses or "unlimited", days or "never")
        return _json({"invite": _shape(res)})

    async def invites_delete(self, req: web.Request, who: str | None = None) -> web.Response:
        if who is None:
            s = self._admin(req)
            if not s or not self._csrf_ok(req):
                return _err("Sign in first.", 401)
            who = s["mxid"]
        code = req.match_info["code"]
        if not code or len(code) > 64 or not set(code) <= CODE_RE_CHARS:
            return _err("bad code", 400)
        st, res = await self.synapse.token_delete(self._system_token(), code)
        if st == 404:
            return _err("That code is already gone", 404)
        if st != 200:
            return _err(f"The chat server said {st}.", 502)
        log.info("%s revoked %s", who, code)
        return _json({"ok": True})

    async def set_features(self, req: web.Request) -> web.Response:
        """Change what the server runs after setup (the dashboard's Features card)."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        body = await req.json()
        st = state.load_state()
        cur = st.get("features") or {"calls": st.get("calls", True), "previews": False, "directory": True, "uploadMb": 100}
        new = dict(cur)
        for k in ("calls", "previews", "directory"):
            if k in body:
                new[k] = bool(body[k])
        if "uploadMb" in body:
            if body["uploadMb"] not in hw.UPLOAD_CHOICES:
                return _err("Pick one of the offered file sizes.", 400)
            new["uploadMb"] = body["uploadMb"]
        if new["previews"] and not cur.get("previews") and not await asyncio.to_thread(hw.online):
            return _err("Link previews need the server to be online, and it isn't.", 400)
        changed = [k for k in ("calls", "previews", "directory", "uploadMb") if new.get(k) != cur.get(k)]
        if not changed:
            return _json({"ok": True, "changed": []})
        async with self._apply_lock:
            sn = st["server_name"]
            if {"previews", "directory", "uploadMb"} & set(changed):
                fed = None if st.get("mode", "lan") == "lan" else (st.get("federation") or [])
                write_synapse_config(sn, state.load_secrets(), new, fed)
                rc, out = await compose.restart("synapse")
                for _ in range(120):
                    if await self.synapse.healthy():
                        break
                    await asyncio.sleep(1)
                else:
                    return _err("The chat server didn't come back after the change. Open Maintenance and restart it.", 500)
            if "calls" in changed:
                from . import install
                install.write_wellknowns(st, sn, new["calls"])
                if new["calls"]:
                    rc, out = await compose.up("livekit", "lk-jwt")
                    if state.public_mode(st):  # the call ports need opening on the router too
                        asyncio.create_task(self.checker.open_ports(True))
                else:
                    rc, out = await compose.run("stop", "livekit", "lk-jwt", timeout=120)
                if rc != 0:
                    return _err("Couldn't switch calls " + ("on" if new["calls"] else "off") + ".", 500)
            state.save_state(features=new, calls=new["calls"])
        log.info("%s changed features: %s", s["mxid"], ", ".join(f"{k}={new[k]}" for k in changed))
        return _json({"ok": True, "changed": changed, "features": new})

    async def set_api_features(self, req: web.Request) -> web.Response:
        """The Features card's extras (the Tin Hat API on this server): the owner's own API keys, Memories with the
        recorder's account, phone notifications, a TURN server for calls. Writes the API's files, recreates its
        containers (so a changed environment takes effect), and the well-known says what is on (apiconf.py)."""
        s_ = self._admin(req)
        if not s_ or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        body = await req.json()
        st, s = state.load_state(), state.load_secrets()
        if st.get("phase") != "ready":
            return _err("Finish setup first.", 409)
        changed, new_secrets = [], {}
        for key, label in apiconf.KEY_LABELS.items():
            field = key.replace("_key", "Key")
            if field not in body:
                continue
            v = str(body[field] or "").strip()
            if v and (len(v) > 200 or any(c in v for c in " \t\n\r\"'")):
                return _err(f"That doesn't look like a {label} key.", 400)
            if v != (s.get(key) or ""):
                new_secrets[key] = v or None
                changed.append(field)
        api = dict(st.get("api") or {})
        if "memories" in body:
            on = bool(body["memories"])
            rec = str(body["recorder"] if body.get("recorder") is not None else api.get("recorder") or "").strip()
            if on and not re.match(r"^@[^:\s@]+:[A-Za-z0-9.\-]+(:\d+)?$", rec):
                return _err("Type the recorder's account, like @recorder:your.server.", 400)
            if on != bool(api.get("memories")) or rec != str(api.get("recorder") or ""):
                api["memories"], api["recorder"] = on, rec
                changed.append("memories")
        if "phonePush" in body:
            on = body["phonePush"] is True
            if on != (api.get("phone_push") is not False):
                api["phone_push"] = on
                changed.append("phonePush")
        if "web" in body:
            w = str(body["web"] or "").strip().lower()
            w = re.sub(r"^https?://", "", w).rstrip("/").rstrip(".")
            if w == st.get("server_name"):
                w = ""
            if w and st.get("mode") != "domain":
                return _err("A separate web app address is only for a server on your own domain.", 400)
            if w and not owndomain.HOST_RE.match(w):
                return _err("Type the web app's address as a name, like tinhat.example.com.", 400)
            if w != str(api.get("web") or ""):
                api["web"] = w
                changed.append("web")
        turn_changed = False
        if "turn" in body:
            t, err = apiconf.valid_turn(body["turn"])
            if err:
                return _err(err, 400)
            cred = str((body["turn"] or {}).get("credential") or "") if t else ""
            if t and not cred and not s.get("turn_credential"):
                return _err("Type the TURN credential (its password).", 400)
            if t != api.get("turn") or (t and cred and cred != s.get("turn_credential")):
                api["turn"] = t
                if t and cred:
                    new_secrets["turn_credential"] = cred
                if not t:
                    new_secrets["turn_credential"] = None
                changed.append("turn")
                turn_changed = True
        if not changed:
            return _json({"ok": True, "changed": [], "api": apiconf.doc(st, s)})
        async with self._apply_lock:
            if new_secrets:
                s = state.save_secrets(**new_secrets)
            st = state.save_state(api=api)
            from . import install
            if apiconf.write(st, s):
                # Recreated, not restarted: `compose restart` keeps a container's old environment, so a changed env
                # file (PUSH_RELAY when phone notifications go off or on, WEB_BASE) would never reach the running API.
                rc, out = await compose.run("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api", "games",
                                            timeout=180)
                if rc != 0:
                    log.warning("restarting the extras: %s", out[-400:])
            install.write_wellknowns(st, st["server_name"], st.get("calls", True))
            if turn_changed:
                install.refresh_configs()
                if st.get("calls", True):
                    await compose.restart("livekit")
        log.info("%s changed extras: %s", s_["mxid"], ", ".join(changed))
        return _json({"ok": True, "changed": changed, "api": apiconf.doc(st, s)})

    async def _spaces(self) -> tuple[list[dict], bool]:
        """This server's spaces (Synapse's room list, room_type m.space), for the game-servers card's picker; False
        when the list couldn't be read whole (the card says so and keeps the current choice)."""
        tok = self._system_token()
        out, frm, ok = [], 0, bool(tok)
        while tok and frm is not None:
            if frm >= 20000:
                ok = False
                break
            st, body = await self.synapse.req("GET", f"/_synapse/admin/v1/rooms?limit=500&from={frm}", token=tok)
            if st != 200:
                ok = False
                break
            for r in body.get("rooms") or []:
                if r.get("room_type") == "m.space":
                    out.append({"id": r.get("room_id"), "name": r.get("name") or r.get("canonical_alias") or r.get("room_id"),
                                "members": r.get("joined_members") or 0})
            frm = body.get("next_batch")
        return sorted(out, key=lambda x: (-x["members"], str(x["name"]).lower())), ok

    async def gameservers_doc(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        spaces, ok = await self._spaces()
        return _json({**gameservers.doc(), "spaces": spaces, "spacesComplete": ok})

    async def gameservers_connect(self, req: web.Request) -> web.Response:
        """Ask the owner's panel which servers the key sees (nothing is saved)."""
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        body = await req.json()
        try:
            found = await gameservers.discover(str(body.get("url") or ""), body.get("key") if body.get("key") else None)
        except gameservers.GameServersError as e:
            return _err(str(e), 400)
        return _json(found)

    async def gameservers_save(self, req: web.Request) -> web.Response:
        s_ = self._admin(req)
        if not s_ or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        st = state.load_state()
        if st.get("phase") != "ready":
            return _err("Finish setup first.", 409)
        body = await req.json()
        async with self._apply_lock:
            try:
                d = gameservers.save(body)
            except gameservers.GameServersError as e:
                return _err(str(e), 400)
            from . import install
            install.write_wellknowns(st, st["server_name"], st.get("calls", True))  # the apps show the widget now
        log.info("%s set up the game servers (%d)", s_["mxid"], len(d["servers"]))
        return _json({"ok": True, **d})

    async def gameservers_remove(self, req: web.Request) -> web.Response:
        s_ = self._admin(req)
        if not s_ or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        async with self._apply_lock:
            gameservers.remove()
            st = state.load_state()
            if st.get("phase") == "ready":
                from . import install
                install.write_wellknowns(st, st["server_name"], st.get("calls", True))
        log.info("%s removed the game servers", s_["mxid"])
        return _json({"ok": True, **gameservers.doc()})

    async def reports_list(self, req: web.Request) -> web.Response:
        """Problem reports and shared logs people sent to this server (the API stores them; apiconf.reports)."""
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return _json({"reports": await asyncio.to_thread(apiconf.reports)})

    async def report_file(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        p = apiconf.report_path(req.query.get("kind", ""), req.query.get("name", ""))
        if p is None:
            return _err("No such report.", 404)
        return web.FileResponse(p, headers={"Content-Disposition": f'attachment; filename="{p.name}"',
                                            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    def _network_doc(self) -> dict:
        st = state.load_state()
        out = {"mode": st.get("mode", "lan"), "serverName": st.get("server_name"), "busy": self.network_busy,
               "addresses": hw.addresses(), "moved": moved.is_moved(st)}
        if state.public_mode(st):
            out.update(ports=st.get("ports"), reach=st.get("reach"), names=st.get("names_status"),
                       notices=st.get("names_notices") or [],
                       summary=reach.summary(st.get("ports"), st.get("reach"), owndomain.proxy_info(st)),
                       relay=relay.status_doc(), proxy=owndomain.proxy_info(st))
        if st.get("mode") == "domain":
            provider = (st.get("domain") or {}).get("provider")
            info = owndomain.PROVIDERS.get(provider) or {}
            ds = st.get("domain_status") or {}
            out["domain"] = {"provider": provider, "label": info.get("label", provider), "keepsAddress": bool(info.get("keeps_address")),
                             "ip4": ds.get("ip4"), "error": ds.get("error")}
        return out

    async def _network_doc_full(self) -> dict:
        doc = self._network_doc()
        await self._relay_offer(doc)
        return doc

    async def _relay_offer(self, doc: dict) -> None:
        """The relay is offered only for a tinhat.me name (it passes on names the names service knows), and only while
        the names service has one to give."""
        if isinstance(doc.get("relay"), dict) and not doc["relay"].get("on"):
            doc["relay"]["available"] = doc.get("mode") == "anywhere" and await relay.is_available()

    async def network(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        doc = self._network_doc()
        await self._relay_offer(doc)
        if isinstance(doc.get("proxy"), dict):  # where this page came through: the proxy card offers it
            doc["proxy"]["peer"] = _peer(req) or None
        if doc.get("domain"):  # where the domain points now, next to where the home is: the owner's job for most providers
            doc["domain"]["resolves"] = await asyncio.to_thread(owndomain.resolves_to, doc["serverName"])
            doc["domain"]["home"] = await owndomain.public_ip()
        return _json(doc)

    async def network_check(self, req: web.Request) -> web.Response:
        """Open the router's ports again and check from outside (pauses calls for a few seconds)."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        st = state.load_state()
        if not state.public_mode(st):
            return _err("This server is set up for the home network only.", 400)
        if not await self._check_now(st):
            return _err("A check is already running.", 409)
        log.info("%s ran the outside check", s["mxid"])
        return _json(await self._network_doc_full())

    async def network_proxy(self, req: web.Request) -> web.Response:
        """Dashboard → Network → Who counts as your proxy: the address(es) the owner's reverse proxy connects from.
        Named, only they (and this machine) may connect to the proxy port and write the caller's address; [] = every
        home-network address, as before. A list that leaves out the address this very request came through is refused:
        saving it would lock the owner out (`tinhat proxy-addresses --clear` on the console is the way back)."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        st = state.load_state()
        if not state.behind_proxy(st):
            return _err("This server isn't behind your own reverse proxy.", 400)
        try:
            body = await req.json()
        except ValueError:
            return _err("Bad request.", 400)
        new, problem = owndomain.parse_proxies(body.get("addresses") if isinstance(body, dict) else None)
        if problem is not None:
            return _err(problem, 400)
        if (refused := owndomain.proxy_save_problem(new, _peer(req), hw.addresses())) is not None:
            return _err(refused, 409)
        async with self._apply_lock:   # the state is read inside apply_proxy_addresses, under the lock (review #5)
            ok, why = await apply_proxy_addresses(new)
            if not ok:
                log.warning("proxy addresses %s not applied: %s", new, why)
                return _err("The web server didn't take these settings; nothing changed.", 500)
        _cache.pop("proxies", None)
        log.info("%s set the reverse proxy's addresses: %s", s["mxid"], ", ".join(new) or "any home-network address")
        return _json({"ok": True, "trusted": new})

    async def setup_network_check(self, req: web.Request) -> web.Response:
        """Check again from the setup page's last screen, on the home network. Right after setup is when owners fix
        their router, and from home the dashboard may not open yet (no NAT loopback). Needs the setup session."""
        if not self._setup_ok(req) or not self._csrf_ok(req):
            return _err("This only works in the browser that did the setup, for a few hours after it.", 401)
        st = state.load_state()
        if st.get("phase") != "ready" or not state.public_mode(st):
            return _err("This server is set up for the home network only.", 409)
        if not await self._check_now(st):
            return _err("A check is already running.", 409)
        log.info("outside check from the setup page")
        return _json(await self._network_doc_full())

    async def _check_now(self, st: dict) -> bool:
        """Open the ports again and check from outside (pauses calls for a few seconds). False if one is running."""
        if self.network_busy:
            return False
        self.network_busy = True
        try:
            calls = st.get("calls", True)
            await self.checker.open_ports(calls)
            await self.checker.outside(calls)
        finally:
            self.network_busy = False
        return True

    # ---- updates -----------------------------------------------------------------------------------------------
    # ---- Maintenance → Move to your own domain (move.py) ----------------------------------------------------------

    def _move_doc(self) -> dict:
        st = state.load_state()
        return {"progress": self.mover.progress(), "server_name": st.get("server_name"), "mode": st.get("mode", "lan"),
                "former": [{"name": f["name"], "mode": f.get("mode"), "at": f.get("at"), "released": f.get("released"),
                            "pending": bool(f.get("pending"))} for f in move.former_names(st)],
                "providers": {k: {"label": v["label"], "fields": v["fields"]} for k, v in owndomain.PROVIDERS.items()},
                "proxy_only": config.proxy_only(), "relay": relay.on(), "behind_proxy": state.behind_proxy(st)}

    def _moving(self) -> web.Response | None:
        """While the server moves to its new address, nothing else restarts its parts or rewrites its settings."""
        if self.mover.running:
            return _err("The server is moving to its new address; try again when it's done.", 409)
        return None

    def _move_busy(self) -> str | None:
        """Why a move can't start right now (it pauses chat and changes the configs others write)."""
        if self.mover.running:
            return "A move is running already."
        if self._move_checking.locked():
            return "The check is still running; try again in a moment."
        if updates.status().get("phase") in ("downloading", "installing", "rolling-back"):
            return "An update is being installed; move after it's done."
        if self._bg_backup is not None and not self._bg_backup.done():
            return "A backup is running; move after it's done."
        if self.network_busy:
            return "A network check is running; try again in a minute."
        if self._bg_tick_update is not None and not self._bg_tick_update.done():
            return "The nightly update check is running; try again in a minute."
        return None

    async def move_let_go(self, req: web.Request) -> web.Response:
        """Let go of an old address (the move card): the server stops answering it; a tinhat.me name goes back to the
        names service for good. The owner types the name to confirm."""
        s_ = self._admin(req)
        if not s_ or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        try:
            body = await req.json()
        except ValueError:
            return _err("That request wasn't understood.", 400)
        name = str((body or {}).get("name") or "") if isinstance(body, dict) else ""
        if not name or str(body.get("confirm") or "").strip().lower() != name:
            return _err(f"Type {name or 'the old address'} to confirm.", 400)
        busy = self._move_busy()
        if busy:
            return _err(busy, 409)
        async with self._move_checking:  # nothing else rewrites the settings meanwhile (a move or its check)
            try:
                line = await move.let_go(name)
            except move.MoveError as e:
                return _err(str(e), 409)
        log.info("%s let go of the old address %s", s_["mxid"], name)
        return _json({**self._move_doc(), "message": line})

    async def move_get(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return _json(self._move_doc())

    async def move_check(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if self.mover.running:
            return _err("A move is running already.", 409)
        try:
            answers = await req.json()
        except ValueError:
            return _err("That request wasn't understood.", 400)
        if self._move_checking.locked():
            return _err("A check is running already.", 409)
        async with self._move_checking:
            if self.mover.running:  # started while this request was read
                return _err("A move is running already.", 409)
            return _json(await self.mover.check(answers if isinstance(answers, dict) else {}))

    async def move_start(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        try:
            answers = await req.json()
        except ValueError:
            return _err("That request wasn't understood.", 400)
        if not isinstance(answers, dict):
            return _err("That request wasn't understood.", 400)
        busy = self._move_busy()
        if busy:
            return _err(busy, 409)
        own, problem = owndomain.validate({"name": answers.get("name", ""), "domain": answers.get("domain") or {}})
        if problem:
            return _err(problem, 400)
        # The page asks the owner to type the new name before it sends this.
        if str(answers.get("confirm") or "").strip().lower().rstrip(".") != own["domain"]:
            return _err(f"Type {own['domain']} to confirm the move.", 400)
        problem = self.mover.start(answers)
        if problem:
            return _err(problem, 409)
        log.info("%s started a move to %s", s["mxid"], own["domain"])
        return _json(self._move_doc())

    async def updates_get(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return _json(updates.doc())

    async def updates_check(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        await updates.check()
        return _json(updates.doc())

    async def updates_install(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if updates.status().get("phase") not in ("available", "staged"):
            return _err("There's no update to install.", 409)
        if self.mover.running:
            return _err("The server is moving to its new address; update after it's done.", 409)
        if self.network_busy:
            return _err("A network check is running; try again in a minute.", 409)

        # Busy before answering, so the page shows the update under way at once (it follows it from here).
        updates.set_status(phase="downloading" if updates.status().get("phase") == "available" else "installing",
                           step="starting", message=None)

        async def go():
            try:
                if updates.status().get("phase") == "downloading":
                    await updates.download()
                updates.start_install(f"by {s['mxid']}")
            except Exception as e:  # noqa: BLE001 — the card shows what went wrong
                log.exception("update install")
                updates.set_status(phase="available", message=f"The update didn't start: {e}")
        self._bg_update = asyncio.create_task(go())
        log.info("%s asked to install the update", s["mxid"])
        return _json(updates.doc())

    async def updates_settings(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        body = await req.json()
        changes = {}
        if "auto" in body:
            changes["auto"] = bool(body["auto"])
        if isinstance(body.get("tz"), str) and 0 < len(body["tz"]) < 64:
            changes["tz"] = body["tz"]
        updates.save_settings(**changes)
        return _json(updates.doc())

    # ---- a forgotten admin password: a code on the server's own screen ------------------------------------------
    async def recover_start(self, req: web.Request) -> web.Response:
        if state.phase() != "ready":
            return _err("This server isn't set up yet.", 409)
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if self._limited("recover-start", req, 3600, 6):
            return _err("Too many tries. Wait an hour, then try again.", 429)
        self._failed("recover-start", req)
        secs = recovery.start()
        log.info("recovery code shown on the console (asked from %s)", _client(req))
        return _json({"ok": True, "minutes": secs // 60})

    async def recover_finish(self, req: web.Request) -> web.Response:
        if state.phase() != "ready":
            return _err("This server isn't set up yet.", 409)
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if self._limited("recover", req, 3600, 10):
            return _err("Too many wrong codes. Wait an hour, then ask for a new one.", 429)
        self._failed("recover", req)  # counted before anything is awaited; taken back when right
        body = await req.json()
        if not recovery.check(body.get("code", "")):
            return _err("That code doesn't match the one on the server's screen (or it's more than 10 minutes old, or "
                        "had too many wrong tries: ask for a new one).", 403)
        self._forgive("recover", req)
        sn = state.load_state().get("server_name", "")
        user = str(body.get("username", "")).strip().lower().lstrip("@").split(":", 1)[0]
        mxid = f"@{user}:{sn}"
        pw = str(body.get("password", ""))
        if len(pw) < 8:
            return _err("Use a password of at least 8 characters.", 400)
        tok = self._system_token()
        if not user or user == config.SYSTEM_LOCALPART or not await self.synapse.is_admin(mxid, tok):
            return _err(f"{mxid} isn't an admin of this server.", 400)
        st, out = await self.synapse.req("POST", f"/_synapse/admin/v1/reset_password/{quote(mxid)}", tok,
                                         json={"new_password": pw, "logout_devices": bool(body.get("logoutDevices"))})
        if st != 200:
            return _err(f"The chat server didn't take the new password ({out.get('error') or st}).", 502)
        recovery.clear()
        log.info("admin password reset with a console code for %s (sign out everywhere: %s)", mxid, bool(body.get("logoutDevices")))
        return _json({"ok": True, "mxid": mxid})

    async def support_report(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return web.Response(text=await support.report(), content_type="text/plain",
                            headers={"Cache-Control": "no-store"})

    # ---- command-line access (SSH), off by default --------------------------------------------------------------
    async def ssh_get(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return _json(await asyncio.to_thread(sshaccess.status, hw.addresses()))

    async def ssh_post(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        body = await req.json()
        action = body.get("action")
        try:
            if action == "on":
                await asyncio.to_thread(sshaccess.turn_on, body.get("key") or None, body.get("password") or None)
            elif action == "add-key":
                await asyncio.to_thread(sshaccess.add_key, str(body.get("key", "")))
            elif action == "remove-key":
                await asyncio.to_thread(sshaccess.remove_key, str(body.get("fingerprint", "")))
            elif action == "off":
                await asyncio.to_thread(sshaccess.turn_off)
            else:
                return _err("Bad request.", 400)
        except sshaccess.SSHError as e:
            return _err(str(e), 400)
        log.info("%s: command-line access %s", s["mxid"], action)
        return _json(await asyncio.to_thread(sshaccess.status, hw.addresses()))

    # ---- backups -----------------------------------------------------------------------------------------------
    def _backup_doc(self) -> dict:
        st, s = backup.settings(), state.load_secrets()
        return {"settings": {"dest": st.get("dest"), "usb": st.get("usb"), "smb": st.get("smb")},
                "hasPassword": bool(s.get("backup_password")), "status": backup.status(),
                "busy": bool(self._bg_backup and not self._bg_backup.done()), "nightAt": "2:30 AM"}

    async def backups_get(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        return _json({**self._backup_doc(), "drives": await asyncio.to_thread(backup.drives)})

    async def backups_settings(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        body = await req.json()
        pw = body.get("password")
        if pw is not None:
            pw = str(pw)
            if len(pw) < 10:
                return _err("Use a backup password of at least 10 characters.", 400)
            if state.load_secrets().get("backup_password") and (backup.status().get("last") or {}).get("at"):
                return _err("This server's backups already have a password.", 409)
            state.save_secrets(backup_password=pw)
        dest = body.get("dest")
        if dest == "usb":
            d = next((x for x in await asyncio.to_thread(backup.drives) if x["uuid"] == body.get("uuid")), None)
            if d is None:
                return _err("That drive isn't plugged in any more.", 400)
            state.save_state(backups={"dest": "usb", "usb": {k: d[k] for k in ("uuid", "label", "model", "size", "fstype")}})
        elif dest == "smb":
            share, user = str(body.get("share", "")).strip(), str(body.get("user", "")).strip()
            if not share or "/" not in share.replace("\\", "/"):
                return _err("Type the shared folder like \\\\computer\\folder or //computer/folder.", 400)
            if backup.control_chars(share, user, str(body.get("smbPassword") or "")):
                return _err("The shared folder, user name or password has a line break or control character in it.", 400)
            if body.get("smbPassword") is not None:
                state.save_secrets(backup_smb_password=str(body["smbPassword"]))
            state.save_state(backups={"dest": "smb", "smb": {"share": share, "user": user}})
        elif dest == "none":
            state.save_state(backups={})
        return _json({**self._backup_doc(), "drives": await asyncio.to_thread(backup.drives)})

    def _backup_task(self, coro) -> web.Response | None:
        if self._bg_backup and not self._bg_backup.done():
            coro.close()
            return _err("A backup is already running.", 409)
        if self.mover.running:
            coro.close()
            return _err("The server is moving to its new address; back up after it's done.", 409)
        async def run():
            try:
                await coro
            except Exception as e:  # noqa: BLE001 — shown on the card
                log.exception("backup task")
                backup.set_status(running=False, message=str(e))
        self._bg_backup = asyncio.create_task(run())
        return None

    async def backups_run(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        busy = self._backup_task(backup.backup_now("by owner"))
        return busy if busy is not None else _json(self._backup_doc())

    async def backups_test(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        # The drill a real move needs: the owner types the backup password (the server never shows it), then the
        # newest copy is opened and checked.
        if self._limited("backup-pw", req, 600, 10):
            return _err("Too many tries. Wait a few minutes.", 429)
        try:
            typed = str((await req.json()).get("password", ""))
        except ValueError:
            typed = ""
        saved = state.load_secrets().get("backup_password") or ""
        if not typed or not secrets.compare_digest(typed.encode(), saved.encode()):
            self._failed("backup-pw", req)
            return _err("That isn't this server's backup password. Without the right one, a backup can't be opened "
                        "anywhere: if it's lost, choose Change and set a new one, then back up again.", 400)
        async def test():
            backup.set_status(testing=True)
            try:
                await backup.test_restore()
            except backup.BackupError as e:
                backup.set_status(test={"at": int(time.time()), "ok": False, "error": str(e)})
            finally:
                backup.set_status(testing=False)
        busy = self._backup_task(test())
        return busy if busy is not None else _json(self._backup_doc())

    async def backups_download_make(self, req: web.Request) -> web.Response:
        if not self._admin(req) or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        media = bool((await req.json()).get("media", True))
        async def make():
            backup.cleanup_downloads(0)
            backup.set_status(download={"making": True})
            try:
                f = await backup.download_file(media)
                backup.set_status(download={"making": False, "token": f.parent.name, "name": f.name,
                                            "size": f.stat().st_size, "at": int(time.time()),
                                            "counts": state.read_json(backup.STAGING / "backup.json", {}).get("counts")})
            except backup.BackupError as e:
                backup.set_status(download={"making": False, "error": str(e)})
        busy = self._backup_task(make())
        return busy if busy is not None else _json(self._backup_doc())

    async def backups_download_get(self, req: web.Request) -> web.StreamResponse:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        d = backup.status().get("download") or {}
        if d.get("token") != req.match_info["token"]:
            raise web.HTTPNotFound()
        f = backup.DIR / d["token"] / d["name"]
        if not f.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(f, headers={"Content-Disposition": f'attachment; filename="{d["name"]}"',
                                            "Content-Type": "application/x-tar", "Cache-Control": "no-store"})

    # ---- restore (the setup page's other way in) -----------------------------------------------------------------
    def _restore_repo(self, src: dict) -> str:
        server = str(src.get("server", ""))
        if "/" in server or not server:
            raise backup.BackupError("Pick a backup.")
        if src.get("type") == "usb":
            root = backup.mount_usb(str(src.get("uuid", "")))
        elif src.get("type") == "upload":
            root = config.STATE_DIR / "restore" / "upload"
        else:
            raise backup.BackupError("Pick a backup.")
        repo = root / backup.REPO_DIR / server
        if not (repo / "config").is_file():
            raise backup.BackupError("There's no Tin Hat backup there.")
        return str(repo)

    async def restore_sources(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        out = []
        for d in await asyncio.to_thread(backup.drives):
            try:
                mp = await asyncio.to_thread(backup.mount_usb, d["uuid"])
                out.append({**d, "servers": backup.find_servers(mp)})
            except backup.BackupError:
                out.append({**d, "servers": [], "unreadable": True})
        await asyncio.to_thread(backup.unmount_all)
        up = backup.find_servers(config.STATE_DIR / "restore" / "upload")
        return _json({"drives": out, "uploaded": up})

    async def restore_upload(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        work = config.STATE_DIR / "restore"
        shutil.rmtree(work / "upload", ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        tar = work / "upload.tar"
        with open(tar, "wb") as f:
            async for chunk in req.content.iter_chunked(1 << 20):
                f.write(chunk)
        try:
            await asyncio.to_thread(_untar, tar, work / "upload")
        except (tarfile.TarError, OSError) as e:
            return _err(f"That file isn't a Tin Hat backup ({e}).", 400)
        finally:
            tar.unlink(missing_ok=True)
        servers = backup.find_servers(work / "upload")
        if not servers:
            return _err("That file isn't a Tin Hat backup.", 400)
        return _json({"uploaded": servers})

    async def restore_open(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        if not self._csrf_ok(req) or self._limited("restore", req, 600, 10):
            return _err("Too many tries. Wait a few minutes, then try again.", 429)
        self._failed("restore", req)  # counted before anything is awaited; taken back when it isn't a wrong password
        forgiven = False
        body = await req.json()
        pw = str(body.get("password", ""))
        try:
            repo = await asyncio.to_thread(self._restore_repo, body.get("source") or {})
            ok = await asyncio.to_thread(backup.repo_exists, repo, pw)
            if ok is not True:
                return _err("That password doesn't open this backup.", 403)
            self._forgive("restore", req)
            forgiven = True
            snaps = await asyncio.to_thread(backup.snapshots, repo, pw)
            metas = []
            for sn in snaps[:10]:
                raw = await asyncio.to_thread(backup.read_from_snapshot, repo, pw, sn["id"], "backup.json")
                metas.append({**sn, "meta": json.loads(raw) if raw else {}})
        except backup.BackupError as e:
            if not forgiven:  # not a wrong password (the share or drive is missing, …)
                self._forgive("restore", req)
            return _err(str(e), 400)
        return _json({"snapshots": metas})

    async def restore_password(self, req: web.Request) -> web.Response:
        """Right after a restore: the admin account is as it was when the copy was made, password included. The
        browser that did the restore may set a new one (an owner who changed it after the copy)."""
        if not self._setup_ok(req) or not self._csrf_ok(req):
            return _err("This only works in the browser that did the restore, for a few hours after it.", 401)
        st = state.load_state()
        rf = st.get("restored_from") or {}
        if st.get("phase") != "ready" or not rf or time.time() - rf.get("at", 0) > 86400 or not st.get("admin"):
            return _err("This is only for right after a restore. Use “Forgot your password?” on the dashboard instead.", 409)
        pw = str((await req.json()).get("password", ""))
        if len(pw) < 8:
            return _err("Use a password of at least 8 characters.", 400)
        code, out = await self.synapse.req("POST", f"/_synapse/admin/v1/reset_password/{quote(st['admin'])}",
                                           self._system_token(), json={"new_password": pw, "logout_devices": False})
        if code != 200:
            return _err(f"The chat server didn't take the new password ({out.get('error') or code}).", 502)
        log.info("admin password set after the restore for %s", st["admin"])
        return _json({"ok": True, "mxid": st["admin"]})

    async def setup_update(self, req: web.Request) -> web.Response:
        """Before setup or a restore: bring this computer to the newest version first (a backup from a newer version
        needs it). GET: where it is; POST: check, download and install (the page follows GET)."""
        if (bad := self._setup_gate(req)) is not None:
            return bad
        if req.method == "GET":
            return _json({"installed": config.VERSION, "status": updates.status()})
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if self.installer.running:
            return _err("Setup is already running.", 409)
        if (updates.status().get("phase") or "") in ("downloading", "installing"):
            return _json({"installed": config.VERSION, "status": updates.status()}, 202)

        before = updates.status().get("phase") or "current"
        before = before if before in ("available", "current", "blocked", "done", "rolled-back") else "current"

        async def run():
            try:
                st = await updates.check()
                if st.get("phase") != "available":
                    # every outcome but "available" puts the phase back (an unreachable channel only sets check_error
                    # and would leave "downloading" for good: no daily check, no night install, Install refused)
                    ph = st.get("phase") if st.get("phase") in ("current", "blocked") else before
                    updates.set_status(phase=ph, message=st.get("check_error") or st.get("message")
                                       or "No newer version is out for this computer.")
                    return
                await updates.download()
                updates.start_install("before setup")
            except Exception as e:  # noqa: BLE001 — the page shows what went wrong
                log.exception("update before setup")
                updates.set_status(phase="available", message=f"The update didn't work: {e}")
        updates.set_status(phase="downloading", message=None)
        asyncio.create_task(run())
        return _json({"installed": config.VERSION, "status": updates.status()}, 202)

    async def restore_start(self, req: web.Request) -> web.Response:
        if (bad := self._setup_gate(req)) is not None:
            return bad
        if not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if self.installer.running:
            return _err("Setup is already running.", 409)
        body = await req.json()
        pw = str(body.get("password", ""))
        try:
            repo = await asyncio.to_thread(self._restore_repo, body.get("source") or {})
            snaps = await asyncio.to_thread(backup.snapshots, repo, pw)
            snap = next((x for x in snaps if x["id"] == body.get("snapshot")), snaps[0] if snaps else None)
            if snap is None:
                return _err("There's no backup in there.", 400)
            raw = await asyncio.to_thread(backup.read_from_snapshot, repo, pw, snap["id"], "state/state.json")
            old = json.loads(raw) if raw else {}
            raw_meta = await asyncio.to_thread(backup.read_from_snapshot, repo, pw, snap["id"], "backup.json")
            made_by = str((json.loads(raw_meta) if raw_meta else {}).get("version") or "")
        except (backup.BackupError, ValueError) as e:
            return _err(str(e), 400)
        if made_by and updates.newer(made_by, config.VERSION):
            # A newer version's database may not open in this one: update this computer first (setup_update).
            return _json({"error": f"This copy is from Tin Hat Server {made_by}, newer than this computer's "
                                   f"{config.VERSION}. Update this computer first: it takes a minute or two.",
                          "code": "needs-update", "version": made_by}, 409)
        sn = old.get("server_name")
        if not isinstance(sn, str) or not owndomain.HOST_RE.fullmatch(sn) or old.get("mode", "lan") not in ("lan", "anywhere", "domain"):
            return _err("This backup doesn't say which server it is.", 400)
        a = {"mode": old.get("mode", "lan"), "server_name": sn, "name": sn.split(".")[0],
             "calls": old.get("calls", True), "features": old.get("features") or {},
             "restore": {"repo": repo, "password": pw, "snapshot": snap["id"], "time": snap["time"]}}
        self.installer.start_restore(a)
        log.info("restoring %s from snapshot %s", sn, snap["id"])
        return _json({"ok": True, "serverName": sn, "mode": a["mode"]}, 202)

    # ---- the Tin Hat relay (relay.py): on and off -------------------------------------------------------------

    async def _relay_switch(self, want: bool, st: dict, who: str) -> web.Response:
        if self.network_busy:
            return _err("A check is already running. Try again in a moment.", 409)
        calls = st.get("calls", True)
        if want:
            self.network_busy = True
            try:
                await relay.enable(calls)
                await self.checker.outside(calls)
            except relay.RelayError as e:
                return _err(str(e), 502)
            finally:
                self.network_busy = False
            log.info("%s turned the Tin Hat relay on", who)
            return _json(await self._network_doc_full())

        async def later():  # answer first: this very page may be coming through the relay
            await asyncio.sleep(2)
            self.network_busy = True
            try:
                await relay.disable(calls)
                await self.checker.open_ports(calls)
                await self.checker.outside(calls)
            except relay.RelayError as e:
                log.warning("relay off: %s", e)
                state.save_state(relay={**relay.info(), "error": str(e)})
            finally:
                self.network_busy = False
        asyncio.create_task(later())
        log.info("%s turned the Tin Hat relay off", who)
        return _json({**(await self._network_doc_full()), "pending": "off"}, 202)

    async def network_relay(self, req: web.Request) -> web.Response:
        """Dashboard → Network: the Tin Hat relay on or off."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        st = state.load_state()
        if st.get("mode") != "anywhere":
            return _err("This server is set up for the home network only.", 400)
        return await self._relay_switch(bool((await req.json()).get("on")), st, s["mxid"])

    async def setup_relay(self, req: web.Request) -> web.Response:
        """The setup page: answer "use the relay?" while installing, or switch it from the last page."""
        if not self._setup_ok(req) or not self._csrf_ok(req):
            return _err("This only works in the browser that did the setup, for a few hours after it.", 401)
        use = bool((await req.json()).get("use"))
        st = state.load_state()
        if st.get("phase") == "installing":
            return _json({"ok": relay.answer(use)})
        if st.get("phase") != "ready" or st.get("mode") != "anywhere":
            return _err("This server is set up for the home network only.", 409)
        return await self._relay_switch(use, st, "the setup page")

    async def home_relay(self, req: web.Request) -> web.Response:
        """The home-network page (http://<name>.local): switch the Tin Hat relay ON with an admin's password. Behind carrier
        NAT without the relay, the server's name points at an address nothing reaches, so its owner can't open the
        dashboard, not even at home: this is the way back. Home network only, and it can only turn the relay on."""
        if _https(req) or not self._csrf_ok(req):
            return _err("Bad request.", 400)
        if not _home(req):
            return _err("This only works from the server's home network.", 403)
        st = state.load_state()
        if st.get("phase") != "ready" or st.get("mode") != "anywhere":
            return _err("This server is set up for the home network only.", 409)
        if self._limited("login", req, 300, 8):
            return _err("Too many tries. Wait a few minutes, then try again.", 429)
        self._failed("login", req)  # counted before anything is awaited; taken back when right (or not a try)
        body = await req.json()
        code, res = await self.synapse.login(str(body.get("username", "")).strip(), str(body.get("password", "")),
                                             "Tin Hat Server home page", client=_client(req))
        if code == 429:
            self._forgive("login", req)
            return _err(_slow_down(res), 429)
        if code != 200 or "access_token" not in res:
            return _err("That username and password didn't work.", 403)
        self._forgive("login", req)
        await self.synapse.logout(res["access_token"])
        if not await self._is_operator(res["user_id"]):
            return _err("That account isn't an admin of this server.", 403)
        return await self._relay_switch(True, st, res["user_id"])

    async def notices_seen(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        state.save_state(names_notices=[])
        return _json({"ok": True})

    # ---- connections to other Tin Hat servers (federation by consent) ------------------------------------------

    async def _apply_federation(self, allow: list[str]) -> tuple[bool, str]:
        if self.mover.running:  # the move refuses connected servers; this one waits for the next change
            return False, "the server is moving to its new address"
        async with self._apply_lock:
            st = state.load_state()
            feats = st.get("features") or {"calls": st.get("calls", True), "previews": False, "directory": True, "uploadMb": 100}
            write_synapse_config(st["server_name"], state.load_secrets(), feats, allow)
            rc, out = await compose.restart("synapse")
            for _ in range(120):
                if await self.synapse.healthy():
                    return True, f"allowlist {allow}"
                await asyncio.sleep(1)
            return False, "the chat server didn't come back"

    async def fed_confirm(self, req: web.Request) -> web.Response:
        server = self.federation.confirm(req.match_info["nonce"])
        if not server:
            raise web.HTTPNotFound()
        return _json({"server": state.load_state().get("server_name"), "to": server})

    async def fed_request(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
        except ValueError:
            return _json({"ok": False, "error": "Bad request."}, 400)
        st, out = await self.federation.handle_request(str(body.get("from", "")), str(body.get("code", "")),
                                                        str(body.get("nonce", "")), _client(req))
        return _json(out, st)

    async def fed_disconnect(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
        except ValueError:
            return _json({"ok": False, "error": "Bad request."}, 400)
        st, out = await self.federation.handle_disconnect(str(body.get("from", "")), str(body.get("nonce", "")))
        return _json(out, st)

    async def connections_get(self, req: web.Request) -> web.Response:
        if not self._admin(req):
            return _err("Sign in first.", 401)
        federation.adopt()  # a hand-set entry (or one from a restored backup) shows up as allowed by name
        st = state.load_state()
        now = time.time()
        codes = [c for c in (st.get("connect_codes") or []) if not c.get("used") and c["expires"] > now]
        return _json({"mode": st.get("mode", "lan"), "serverName": st.get("server_name"), "zone": environment.env()["zone"],
                      "connections": federation.connections(), "allowed": federation.allowed(), "codes": codes,
                      "applying": self.federation.applying})

    async def connections_code(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        if not state.public_mode():
            return _err("Connections need a server that's reachable from anywhere.", 400)
        c = self.federation.make_code(s["mxid"])
        log.info("%s made connection code %s", s["mxid"], c["code"])
        return _json(c)

    async def connections_code_delete(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        return _json({"ok": self.federation.revoke_code(req.match_info["code"])})

    async def connections_add(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        if not state.public_mode():
            return _err("Connections need a server that's reachable from anywhere.", 400)
        body = await req.json()
        ok, msg = await self.federation.connect_to(str(body.get("server", "")), str(body.get("code", "")), s["mxid"])
        log.info("%s connect %s: %s", s["mxid"], body.get("server"), msg)
        return _json({"ok": True, "message": msg}) if ok else _err(msg, 400)

    async def connections_delete(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        ok, msg = await self.federation.disconnect(req.match_info["server"])
        log.info("%s disconnect %s: %s", s["mxid"], req.match_info["server"], msg)
        return _json({"ok": True, "message": msg}) if ok else _err(msg, 400)

    async def allowed_add(self, req: web.Request) -> web.Response:
        """Allow a Matrix server by name (one that isn't Tin Hat, so there's no connection code to exchange)."""
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        if not state.public_mode():
            return _err("Other servers need this one to be reachable from anywhere.", 400)
        try:
            body = await req.json()
        except ValueError:
            return _err("Bad request.", 400)
        if not isinstance(body, dict) or not isinstance(body.get("server"), str) or len(body["server"]) > 300:
            return _err("Type the other server's name, like example.org.", 400)
        ok, msg = await self.federation.allow(body["server"], s["mxid"])
        log.info("%s allow %r by name: %s", s["mxid"], body["server"][:80], msg)
        return _json({"ok": True, "message": msg}) if ok else _err(msg, 400)

    async def allowed_delete(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        ok, msg = await self.federation.disallow(req.match_info["server"])
        log.info("%s remove allowed %s: %s", s["mxid"], req.match_info["server"][:80], msg)
        return _json({"ok": True, "message": msg}) if ok else _err(msg, 400)

    async def restart_service(self, req: web.Request) -> web.Response:
        s = self._admin(req)
        if not s or not self._csrf_ok(req):
            return _err("Sign in first.", 401)
        if (busy := self._moving()) is not None:
            return busy
        svc = req.match_info["svc"]
        if svc not in compose.SERVICES:
            return _err("No such service.", 404)
        log.info("%s restarts %s", s["mxid"], svc)
        rc, out = await compose.restart(svc)
        return _json({"ok": rc == 0, "output": out[-500:]}, 200 if rc == 0 else 500)

    # ---- Tin Hat API: /api/admin/invites (Bearer = the caller's Matrix token) -----------------------------------

    async def _bearer_operator(self, req: web.Request) -> tuple[str | None, web.Response | None]:
        auth = req.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            return None, _err("Missing access token", 401)
        mxid = await self.synapse.whoami(auth.split(None, 1)[1].strip())
        if not mxid:
            return None, _err("Invalid access token", 401)
        if not await self._is_operator(mxid):
            return None, _err("Only a server admin can manage invite codes", 403)
        return mxid, None

    async def api_invites_list(self, req: web.Request) -> web.Response:
        _, bad = await self._bearer_operator(req)
        if bad is not None:  # a response is falsy (an empty mapping): never `bad or …`
            return bad
        return await self.invites_list(req, admin_ok=True)

    async def api_invites_create(self, req: web.Request) -> web.Response:
        who, bad = await self._bearer_operator(req)
        if bad is not None:
            return bad
        return await self.invites_create(req, who=who)

    async def api_invites_delete(self, req: web.Request) -> web.Response:
        who, bad = await self._bearer_operator(req)
        if bad is not None:
            return bad
        return await self.invites_delete(req, who=who)


def build_app() -> web.Application:
    m = Manager()
    # Request bodies are never decompressed here: nothing sends the manager a compressed one, and an upload that
    # inflates (restore_upload writes what it reads to disk) is a disk-filling bomb (M15; Caddy refuses them first).
    app = web.Application(client_max_size=1024 * 64, handler_args={"auto_decompress": False})
    app["manager"] = m
    r = app.router
    r.add_get("/", m.root)
    r.add_get("/welcome", m.root)
    r.add_get("/admin", m.admin_page)
    r.add_get("/admin/", m.admin_page)
    r.add_get("/admin/ui/{path:.+}", m.ui)
    r.add_get("/admin/ca.crt", m.ca)
    r.add_get("/admin/name-check", m.name_check)
    r.add_post("/admin/name-check", m.name_check)
    r.add_get("/admin/setup/status", m.setup_status)
    r.add_post("/admin/setup/unlock", m.setup_unlock)
    r.add_get("/admin/setup/probe", m.setup_probe)
    r.add_post("/admin/setup/install", m.setup_install)
    r.add_post("/admin/setup/bench", m.setup_bench)
    r.add_post("/admin/setup/assess", m.setup_assess)
    r.add_get("/admin/setup/speed/ping", m.speed_ping)
    r.add_get("/admin/setup/speed/down", m.speed_down)
    r.add_post("/admin/setup/speed/up", m.speed_up)
    r.add_get("/admin/setup/names", m.setup_names)
    r.add_post("/admin/setup/network/check", m.setup_network_check)
    r.add_get("/.well-known/tinhat/probe/{nonce}", m.probe_answer)
    r.add_get("/admin/api/network", m.network)
    r.add_post("/admin/api/network/check", m.network_check)
    r.add_post("/admin/api/network/notices-seen", m.notices_seen)
    r.add_get("/admin/api/support-report", m.support_report)
    r.add_get("/admin/api/ssh", m.ssh_get)
    r.add_post("/admin/api/ssh", m.ssh_post)
    r.add_post("/admin/recover/start", m.recover_start)
    r.add_post("/admin/recover/finish", m.recover_finish)
    r.add_get("/admin/api/backups", m.backups_get)
    r.add_post("/admin/api/backups/settings", m.backups_settings)
    r.add_post("/admin/api/backups/run", m.backups_run)
    r.add_post("/admin/api/backups/test", m.backups_test)
    r.add_post("/admin/api/backups/download", m.backups_download_make)
    r.add_get("/admin/api/backups/download/{token}", m.backups_download_get)
    r.add_get("/admin/setup/restore/sources", m.restore_sources)
    r.add_post("/admin/setup/restore/upload", m.restore_upload)
    r.add_post("/admin/setup/restore/open", m.restore_open)
    r.add_post("/admin/setup/restore/start", m.restore_start)
    r.add_get("/admin/setup/update", m.setup_update)
    r.add_post("/admin/setup/update", m.setup_update)
    r.add_post("/admin/setup/restore/password", m.restore_password)
    r.add_get("/admin/api/move", m.move_get)
    r.add_post("/admin/api/move/check", m.move_check)
    r.add_post("/admin/api/move/start", m.move_start)
    r.add_post("/admin/api/move/let-go", m.move_let_go)
    r.add_get("/admin/api/updates", m.updates_get)
    r.add_post("/admin/api/updates/check", m.updates_check)
    r.add_post("/admin/api/updates/install", m.updates_install)
    r.add_post("/admin/api/updates/settings", m.updates_settings)
    r.add_post("/admin/api/network/relay", m.network_relay)
    r.add_post("/admin/api/network/proxy", m.network_proxy)
    r.add_post("/admin/setup/relay", m.setup_relay)
    r.add_post("/admin/home/relay", m.home_relay)
    r.add_get("/_tinhat/federation/confirm/{nonce}", m.fed_confirm)
    r.add_post("/_tinhat/federation/request", m.fed_request)
    r.add_post("/_tinhat/federation/disconnect", m.fed_disconnect)
    r.add_get("/admin/api/connections", m.connections_get)
    r.add_post("/admin/api/connections/codes", m.connections_code)
    r.add_delete("/admin/api/connections/codes/{code}", m.connections_code_delete)
    r.add_post("/admin/api/connections", m.connections_add)
    r.add_delete("/admin/api/connections/{server}", m.connections_delete)
    r.add_post("/admin/api/allowed-servers", m.allowed_add)
    r.add_delete("/admin/api/allowed-servers/{server}", m.allowed_delete)
    r.add_post("/admin/api/login", m.login)
    r.add_post("/admin/api/login-token", m.login_token)
    r.add_post("/admin/api/logout", m.logout)
    r.add_get("/admin/api/me", m.me)
    r.add_get("/admin/api/overview", m.overview)
    r.add_get("/admin/api/people", m.people)
    r.add_post("/admin/api/people/password", m.people_password)
    r.add_get("/admin/api/invites", m.invites_list)
    r.add_post("/admin/api/invites", m.invites_create)
    r.add_delete("/admin/api/invites/{code}", m.invites_delete)
    r.add_post("/admin/api/services/{svc}/restart", m.restart_service)
    r.add_post("/admin/api/features", m.set_features)
    r.add_post("/admin/api/features/api", m.set_api_features)
    r.add_get("/admin/api/features/gameservers", m.gameservers_doc)
    r.add_post("/admin/api/features/gameservers/connect", m.gameservers_connect)
    r.add_post("/admin/api/features/gameservers", m.gameservers_save)
    r.add_delete("/admin/api/features/gameservers", m.gameservers_remove)
    r.add_get("/admin/api/reports", m.reports_list)
    r.add_get("/admin/api/reports/file", m.report_file)
    r.add_get("/tinhat-api/admin/invites", m.api_invites_list)
    r.add_post("/tinhat-api/admin/invites", m.api_invites_create)
    r.add_delete("/tinhat-api/admin/invites/{code}", m.api_invites_delete)

    async def on_startup(app: web.Application) -> None:
        try:
            updates.clear_stale_download()  # no download can be running yet: a "downloading" now is left from before
        except Exception:  # noqa: BLE001
            log.exception("couldn't check the update status")
        try:
            federation.adopt()  # never lose a hand-set federation entry to the first change made in the dashboard
        except Exception:  # noqa: BLE001  (the manager must come up; the next change adopts it again)
            log.exception("couldn't check the federation list")
        m.mover.resume()  # a restart in the middle of a move (or a rollback that didn't finish): on in the background
        app["bg"] = asyncio.create_task(_background(m))

    async def on_cleanup(app: web.Application) -> None:
        app["bg"].cancel()
        await m.synapse.close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def _keep_reachable(m: Manager, tick: int) -> None:
    """Reachable from anywhere: keep the name pointing at this home (every 10 min; the names service for a tinhat.me
    name, the owner's DNS provider for their own domain), keep the router's ports open (every 5), and when the home's
    public address changes, tell the call service (it announces that address to callers)."""
    st = state.load_state()
    if st.get("phase") != "ready" or not state.public_mode(st):
        return
    if moved.is_moved(st):  # restored on another computer: nothing here may hold the name, its ports or the relay
        await moved.stand_down()
        return
    if tick % 60 == 1:
        if st.get("mode") == "domain":
            ip = await owndomain.keep_current(st)
            await _keep_former_name(st)
        else:
            try:
                res = await names.update()
            except names.NamesError as e:
                log.warning("names update: %s", e)
                if e.code == "moved":
                    await moved.stand_down()
                    return
                if e.code == "offline":  # the dashboard says so (and since when); a later answer clears it
                    ns = dict(state.load_state().get("names_status") or {})
                    ns.setdefault("unreachable_since", int(time.time()))
                    state.save_state(names_status=ns)
                return
            relay.note_update(res)
            ip = res.get("ip4")
            if ip and not owndomain.is_public_v4(ip):  # NAT loopback: the call server needs the real public address
                ip = await owndomain.public_ip()
        if owndomain.is_public_v4(ip) and ip != st.get("livekit_public_ip") and st.get("calls", True) and not relay.on():
            s = state.load_secrets()
            state.write_text(config.LIVEKIT_DIR / "livekit.yaml", relay.livekit_yaml(s, ip), 0o600)
            state.save_state(livekit_public_ip=ip)
            rc, out = await compose.restart("livekit")
            log.info("public address now %s; livekit restarted (rc %s)", ip, rc)
    if relay.on():  # through the Tin Hat relay: keep the tunnel healthy; the router has nothing to open
        calls = st.get("calls", True)
        await relay.tick(calls, tick)
        last, h = state.load_state().get("reach") or {}, relay.info().get("health") or {}
        # The tunnel is up but the last check from outside failed (a relay outage, say): check again, at most every
        # 10 min and never during a call (it pauses the call server a few seconds).
        if tick % 6 == 4 and h.get("ok") and not last.get("ok") and time.time() - (last.get("at") or 0) > 600 \
                and not m.network_busy and (not calls or await lkadmin.call_in_progress() is False):
            m.network_busy = True
            try:
                out = await m.checker.outside(calls)
                log.info("automatic outside check through the relay: %s", "reachable" if out.get("ok") else "not reachable")
            finally:
                m.network_busy = False
        return
    # Ports: renew every 5 min (the leases are 10); every 2 min while one is missing (another device let go of it, a
    # router came back).
    mapped = (st.get("ports") or {}).get("mapped") or []
    calls = st.get("calls", True)
    direct = (st.get("ports") or {}).get("kind") == "direct"  # its own public address: no router to ask
    need = set(reach.ports(calls, state.behind_proxy(st)))  # the optional port 80 never counts here
    missing = not direct and not need <= {(x.get("proto"), x.get("port")) for x in mapped if x.get("ok")}
    if tick % (12 if missing else 30) == 2 and not m.network_busy:
        m.network_busy = True
        try:
            before = {(x["proto"], x["port"]) for x in mapped if x.get("ok")} & need
            rep = await m.checker.open_ports(calls)
            now_ok = {(x["proto"], x["port"]) for x in rep.get("mapped") or [] if x.get("ok")} & need
            opened, lost = now_ok - before, before - now_ok
            last = st.get("reach") or {}
            # Check from outside again when a port opened or got lost, and every 30 min while not reachable, so the
            # dashboard says what's true; never while people are in a call (it pauses the call server a few seconds).
            why = ("ports opened" if opened else "a port was lost" if lost
                   else "every 30 min" if not last.get("ok") and time.time() - (last.get("at") or 0) > 1800 else None)
            if why:
                if calls and await lkadmin.call_in_progress() is not False:
                    log.info("outside check postponed (%s): a call is going on, or the call server didn't answer", why)
                else:
                    out = await m.checker.outside(calls)
                    log.info("automatic outside check (%s): %s", why, "reachable" if out.get("ok") else "not reachable")
        except Exception:  # noqa: BLE001 — a flaky router must not stop the loop
            log.exception("port renewal")
        finally:
            m.network_busy = False


async def _keep_former_name(st: dict) -> None:
    """Moved from a tinhat.me name to its own domain (move.py): the old name keeps pointing at this home while the
    server holds it, so apps that still use it find the server (its page on the names service says where it went)."""
    if not names.creds() or not any(f.get("mode") == "anywhere" for f in move.held_former_names(st)):
        return
    if st.get("former_told") != st.get("server_name"):  # the move couldn't tell the names service: now
        try:
            await names.tell_moved(st.get("server_name"))
            state.save_state(former_told=st.get("server_name"))
        except names.NamesError as e:
            log.info("former name: telling the names service: %s", e)
    doc = await names.keep_former()
    if doc.get("status") not in ("active", None):
        log.info("former name: %s", doc)


def _slow_down(res: dict) -> str:
    """The chat server's own brake on sign-in tries (several in a row for one account, or from one address): say so,
    never "wrong password" (the password may well be right)."""
    mins = max(1, round(int(res.get("retry_after_ms") or 60000) / 60000))
    return (f"Too many sign-in tries just now, for this account or from this network. Wait about {mins} "
            f"minute{'s' if mins != 1 else ''}, then try again (the password may well be right).")


async def _guard(what: str, coro) -> None:
    try:
        await coro
    except Exception:  # noqa: BLE001 — logged; the loop goes on
        log.exception("%s failed", what)


def _untar(tar: Path, dest: Path) -> None:
    with tarfile.open(tar) as t:
        t.extractall(dest, filter="data")


async def _background(m: Manager) -> None:
    """Keep the console banner current, keep tinhat.local answering, drop expired sessions, stay reachable."""
    tick = 0
    while True:
        tick += 1
        if m.mover.running:  # a move pauses chat and rewrites the configs: nothing else touches them meanwhile
            await asyncio.sleep(10)
            continue
        try:
            await _keep_reachable(m, tick)
        except Exception:  # noqa: BLE001
            log.exception("reachability tick failed")
        if tick % 6 == 3 and state.phase() == "ready":  # once a minute: the daily check, the night install
            if m._bg_tick_update is None or m._bg_tick_update.done():
                m._bg_tick_update = asyncio.create_task(_guard("update tick", updates.tick(lkadmin.call_in_progress)))
            if backup.due() and (m._bg_backup is None or m._bg_backup.done()):
                m._bg_backup = asyncio.create_task(_guard("nightly backup", backup.backup_now("nightly")))
            if not repairs.done("general_calls"):
                await _guard("repair: General's calls", repairs.general_calls(m.synapse))
        if state.phase() == "ready" and not moved.is_moved():  # new people land in #general (never guests)
            await _guard("newcomers", newcomers.tick(m.synapse))
        try:
            console.refresh()
            await mdns.keep_setup_alias(state.phase() == "ready")
            mdns.reclaim_name(state.phase() == "ready" and not moved.is_moved())
            m.setup_sessions.prune()
            m.sessions.prune()
        except Exception:  # noqa: BLE001
            log.exception("background tick failed")
        await asyncio.sleep(10)


def startup_checks() -> None:
    """Before serving: make sure the web server is up to show the wizard (or the whole server, once set up)."""
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(config.STATE_DIR, 0o700)  # secrets inside (LiveKit's, the database's): root only, whatever made it
        lk = config.LIVEKIT_DIR / "livekit.yaml"
        if lk.exists():
            os.chmod(lk, 0o600)  # older servers wrote it 0644
    except OSError as e:
        log.warning("couldn't tighten the state folder's permissions: %s", e)
    st = state.load_state()
    if st.get("phase") == "installing":  # the box restarted in the middle of setup
        state.save_state(phase="failed", error="The server restarted during setup. Press Try again.")
    if not config.COMPOSE_ENV.exists():
        state.write_text(config.COMPOSE_ENV, "", 0o600)
    apiconf.ensure_dirs()  # compose reads the API's env_file for every command, even before setup
    if st.get("phase") == "ready":
        try:
            apiconf.write(st)  # the extras' settings always match this server (no empty env after a reinstall)
        except Exception as e:  # noqa: BLE001
            log.warning("writing the extras' settings failed: %s", e)
    for d in (config.CADDY_DIR / "etc", config.CADDY_DIR / "data", config.CADDY_DIR / "config", config.WELLKNOWN_DIR,
              config.LIVEKIT_DIR, config.CA_DIR):
        d.mkdir(parents=True, exist_ok=True)
    if state.phase() != "ready":
        state.setup_code()
        if not config.CADDYFILE.exists():
            from . import templates
            state.write_text(config.CADDYFILE, templates.CADDY_SETUP_PROXY_ONLY if config.proxy_only() else templates.CADDY_SETUP, 0o644)
    console.refresh(force=True)


async def bring_up() -> None:
    st = state.load_state()
    if st.get("phase") == "ready" and moved.is_moved(st):  # stood down: only the dashboard, at home
        services = ["caddy"]
        await mdns.release_name()
    elif st.get("phase") == "ready" and move.unresolved():  # the move's recovery starts chat once it's consistent
        services = ["caddy", "postgres"]
    elif st.get("phase") == "ready":
        services = ["caddy", "postgres", "synapse"] + (["livekit", "lk-jwt"] if st.get("calls", True) else []) + ["api", "games"]
    else:
        services = ["caddy"]
    rc, out = await compose.up(*services)
    if rc != 0:
        log.error("compose up %s failed: %s", services, out[-800:])

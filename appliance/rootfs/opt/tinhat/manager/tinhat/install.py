"""The setup job: turns the wizard's answers into a running server.

Every step can run again safely, so "Try again" after a failure just reruns the job:
secrets are generated once and kept, accounts that already exist are reused, rooms that exist are kept.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import ssl
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from aiohttp.abc import AbstractResolver

from . import apiconf, compose, config, console, environment, hw, names, owndomain, relay, state, templates
from .synapse import Synapse

log = logging.getLogger("tinhat.install")

STEPS = [
    ("prepare", "Preparing your server"),
    ("database", "Starting the database"),
    ("chat", "Starting the chat server"),
    ("accounts", "Creating your admin account"),
    ("secure", "Securing connections (HTTPS)"),
    ("calls", "Starting voice and video calls"),
    ("finish", "Finishing up"),
]
# From anywhere: reserve the name first (it becomes part of every address), get a real certificate, open the router's
# ports and check from outside. Ports and the outside check never stop the install: they report what to fix.
STEPS_ANYWHERE = [
    ("name", "Reserving your server's name"),
    ("prepare", "Preparing your server"),
    ("database", "Starting the database"),
    ("chat", "Starting the chat server"),
    ("accounts", "Creating your admin account"),
    ("secure", "Getting a certificate (HTTPS)"),
    ("ports", "Opening ports on your router"),
    ("calls", "Starting voice and video calls"),
    ("outside", "Checking from outside your home"),
    ("finish", "Finishing up"),
]

# The owner's own domain: nothing depends on tinhat.me. The domain is pointed at the home first (through the provider's
# API where we can), the certificate comes by DNS-01 through the same provider.
STEPS_DOMAIN = [
    ("dns", "Pointing your domain at your home"),
    ("prepare", "Preparing your server"),
    ("database", "Starting the database"),
    ("chat", "Starting the chat server"),
    ("accounts", "Creating your admin account"),
    ("secure", "Getting a certificate (HTTPS)"),
    ("ports", "Opening ports on your router"),
    ("calls", "Starting voice and video calls"),
    ("outside", "Checking from outside your home"),
    ("finish", "Finishing up"),
]

# Restoring a backup on a new computer (or the same one, reinstalled): the same server comes back, with its name,
# people, rooms and messages. From anywhere, the name moves here and the old computer's key to it stops working.
STEPS_RESTORE = [
    ("restore", "Opening the backup"),
    ("restoredb", "Restoring the database"),
    ("chat", "Starting the chat server"),
    ("secure", "Securing connections (HTTPS)"),
    ("calls", "Starting voice and video calls"),
    ("finish", "Finishing up"),
]
STEPS_RESTORE_ANYWHERE = [
    ("restore", "Opening the backup"),
    ("restoredb", "Restoring the database"),
    ("chat", "Starting the chat server"),
    ("takeover", "Moving the server's name to this computer"),
    ("secure", "Getting a certificate (HTTPS)"),
    ("ports", "Opening ports on your router"),
    ("calls", "Starting voice and video calls"),
    ("outside", "Checking from outside your home"),
    ("finish", "Finishing up"),
]

NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$")
ANYWHERE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$")
SERVER_CODE_RE = re.compile(r"^TN-[A-Z2-9]{4}-[A-Z2-9]{4}$")
USER_RE = re.compile(r"^[a-z0-9._=/+-]{1,64}$")


class InstallError(Exception):
    """msg = what a person reads; details = the log lines behind it (shown folded away)."""

    def __init__(self, msg: str, details: str = ""):
        super().__init__(msg)
        self.details = details


def validate(answers: dict) -> tuple[dict | None, str | None]:
    """The wizard's answers, cleaned — or the first thing wrong with them, in words a person understands."""
    name = str(answers.get("name", "")).strip().lower()
    mode = answers.get("mode", "lan")
    zone = environment.env()["zone"]
    for suffix in (".local", "." + zone):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    code = ""
    own = None  # the own-domain details (mode "domain")
    if config.proxy_only() and not (mode == "domain" and (answers.get("domain") or {}).get("provider") == "proxy"):
        return None, ("Another web server on this machine has ports 80 and 443, so this server can only run behind "
                      "your reverse proxy: choose My own domain, then My own reverse proxy.")
    if mode == "lan":
        if not NAME_RE.match(name):
            return None, "The server name can use lowercase letters, numbers and dashes (2 to 30 of them), and can't start or end with a dash."
    elif mode == "domain":
        if not answers.get("domain"):  # Try again after the page was reloaded: the browser never keeps the API token
            saved = state.load_secrets().get("domain") or {}
            if saved.get("provider") and state.load_state().get("server_name") == name.rstrip("."):
                answers = {**answers, "domain": {"provider": saved["provider"], **(saved.get("creds") or {})}}
        own, problem = owndomain.validate(answers)
        if problem:
            return None, problem
        name = own["domain"]
    elif mode == "anywhere":
        if not ANYWHERE_NAME_RE.match(name) or "--" in name:
            return None, "Use 4 to 32 lowercase letters, numbers or single dashes, starting and ending with a letter or number."
        code = str(answers.get("code", "")).strip().upper()
        if code and not SERVER_CODE_RE.match(code):
            return None, "Server codes look like TN-ABCD-EFGH."
    else:
        return None, "Choose home network or from anywhere."
    admin = answers.get("admin") or {}
    username = str(admin.get("username", "")).strip().lower()
    if username.startswith("@"):
        username = username[1:].split(":", 1)[0]
    if not USER_RE.match(username) or username == config.SYSTEM_LOCALPART:
        return None, "Usernames are lowercase letters, numbers, dots, dashes and underscores."
    password = str(admin.get("password", ""))
    if len(password) < 8:
        return None, "Use a password of at least 8 characters."
    display = str(admin.get("displayName", "")).strip()[:64] or username
    from .hw import UPLOAD_CHOICES
    f = answers.get("features") or {}
    upload = f.get("uploadMb", 100)
    features = {
        "calls": bool(f.get("calls", answers.get("calls", True))),
        "previews": bool(f.get("previews", False)),
        "directory": bool(f.get("directory", True)),
        "uploadMb": upload if upload in UPLOAD_CHOICES else 100,
    }
    return {
        "name": name.split(".")[0] if mode == "domain" else name,  # the machine's own short name
        "server_name": f"{name}.local" if mode == "lan" else name if mode == "domain" else f"{name}.{zone}",
        "domain": own,
        "mode": mode,
        "code": code,
        "username": username,
        "password": password,
        "display_name": display,
        "calls": features["calls"],
        "features": features,
    }, None


def general_room_request(sn: str) -> dict:
    """The createRoom request for #general, the first room (newcomers.py joins every new account to it). NOT end-to-end
    encrypted (decided 2026-10-23): newcomers are joined without an invite, so they'd see everything said before they
    came in locked; like a public room inside a space, it stays readable for people who join later. Only an admin (100)
    could turn encryption on there. A server set up before this keeps its #general as it is."""
    return {
        "preset": "public_chat",
        "visibility": "public",
        "room_alias_name": "general",
        "name": "General",
        "topic": f"Welcome to {sn}!",
        # The server's own room never leaves it, even after the owner connects other servers.
        "creation_content": {"m.federate": False},
        # Members may start and join calls here (joining one is a room state event); the rest as usual.
        "power_level_content_override": {"events": {
            "m.room.name": 50, "m.room.power_levels": 100, "m.room.history_visibility": 100,
            "m.room.canonical_alias": 50, "m.room.avatar": 50, "m.room.tombstone": 100,
            "m.room.server_acl": 100, "m.room.encryption": 100, "org.matrix.msc3401.call.member": 0}},
        "initial_state": [
            {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "shared"}},
        ],
    }


class Installer:
    def __init__(self, synapse: Synapse, checker=None):
        self.synapse = synapse
        self.checker = checker  # reach.Checker, shared with the web side (it answers the outside check's nonce)
        self.task: asyncio.Task | None = None
        # After a restart in the middle of setup (or after it stopped), show the plan of the mode it was in.
        st = state.load_state()
        unfinished = st.get("phase") in ("installing", "failed")
        self.reset_progress(st.get("mode", "lan") if unfinished else "lan", restore=unfinished and bool(st.get("restoring")))

    def reset_progress(self, mode: str = "lan", restore: bool = False) -> None:
        if restore:
            self.plan = STEPS_RESTORE_ANYWHERE if mode == "anywhere" else STEPS_RESTORE
        else:
            self.plan = {"anywhere": STEPS_ANYWHERE, "domain": STEPS_DOMAIN}.get(mode, STEPS)
        self.steps = [{"id": i, "label": l, "status": "pending", "detail": ""} for i, l in self.plan]
        self.error: str | None = None
        self.details: str = ""
        self.started: float | None = None

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def progress(self) -> dict:
        return {"steps": self.steps, "error": self.error, "details": self.details, "running": self.running,
                "elapsed": int(time.time() - self.started) if self.started else 0}

    def start(self, answers: dict) -> None:
        if self.running:
            return
        self.reset_progress(answers["mode"])
        self.started = time.time()
        state.save_state(phase="installing", server_name=answers["server_name"], mode=answers["mode"])
        self.task = asyncio.create_task(self._run(answers))

    def start_restore(self, a: dict) -> None:
        """a: the backup's server (mode, server_name, name, calls, features) + a["restore"] = {repo, password,
        snapshot, time}."""
        if self.running:
            return
        self.reset_progress(a["mode"], restore=True)
        self.started = time.time()
        state.save_state(phase="installing", server_name=a["server_name"], mode=a["mode"], restoring=True)
        self.task = asyncio.create_task(self._run(a))

    def _step(self, sid: str, status: str, detail: str = "") -> None:
        for s in self.steps:
            if s["id"] == sid:
                s["status"], s["detail"] = status, detail
        log.info("step %s: %s %s", sid, status, detail)

    async def _run(self, a: dict) -> None:
        sid = ""
        try:
            for sid, _ in self.plan:
                if sid == "calls" and not a["calls"]:
                    self._step(sid, "skipped", "Calls are switched off.")
                    continue
                self._step(sid, "running")
                detail = await getattr(self, f"_s_{sid}")(a)
                if isinstance(detail, tuple):  # (status, detail): a step that reports instead of failing
                    self._step(sid, *detail)
                else:
                    self._step(sid, "done", detail or "")
        except InstallError as e:
            self._fail(sid, str(e), e.details)
        except Exception as e:  # noqa: BLE001 — anything unexpected still lands on the progress screen
            log.exception("install step %s crashed", sid)
            self._fail(sid, "Something unexpected went wrong.", f"{type(e).__name__}: {e}")

    def _fail(self, sid: str, msg: str, details: str = "") -> None:
        self._step(sid, "failed", msg)
        self.error, self.details = msg, details
        log.error("install failed at %s: %s | %s", sid, msg, details[-2000:])
        state.save_state(phase="failed", failed_step=sid, error=msg, error_details=details[-4000:])

    # ---- steps ----------------------------------------------------------------------------------------------

    async def _s_name(self, a: dict) -> str:
        have = names.creds()
        if have and have.get("name") == a["name"]:
            return f"{a['server_name']} is yours."
        if have:  # a retried install with a different name: give the old one back first
            try:
                await names.release()
            except names.NamesError:
                pass
        try:
            res = await names.register(a["name"], a.get("code", ""))
        except names.NamesError as e:
            raise InstallError(str(e) + (" Go back to the Name step to change it." if e.code in ("taken", "code", "format",
                               "system", "brand", "phish", "offensive", "punycode") else ""), e.code)
        state.save_state(names_status={"status": "active", "ip4": res.get("ip"), "checked": int(time.time()), "reason": None})
        return f"{res['fqdn']} now points to your home ({res.get('ip')})."

    async def _s_prepare(self, a: dict) -> str:
        s = state.load_secrets()
        sn = a["server_name"]
        lan = a["mode"] == "lan"
        bundle = environment.write_bundle() if not lan else None
        state.write_text(config.COMPOSE_ENV, templates.compose_env(sn, s, lan=lan, bundle=bool(bundle)), 0o600)
        # The project's backend network exists once a service on it is created: Synapse's config names the box's
        # address on it (the Tin Hat API's push gateway listens there, apiconf.py).
        rc, out = await compose.run("create", "--no-build", "--pull", "never", "postgres", timeout=300)
        if rc != 0:
            raise InstallError("The database container couldn't be created.", _tail(out))
        write_synapse_config(sn, s, a["features"], None if lan else (state.load_state().get("federation") or []))
        apiconf.write(state.load_state() | {"server_name": sn}, s)

        config.POSTGRES_DIR.mkdir(parents=True, exist_ok=True)
        public_ip = None if lan else (state.load_state().get("names_status") or {}).get("ip4") or \
            (names.creds() or {}).get("ip")
        if not lan and not owndomain.is_public_v4(public_ip):  # nothing known yet, or the router's NAT loopback
            public_ip = await owndomain.public_ip()  # answered: ask an address echo (None if nobody knows)
        state.write_text(config.LIVEKIT_DIR / "livekit.yaml", relay.livekit_yaml(s, public_ip), 0o600)
        if public_ip:
            state.save_state(livekit_public_ip=public_ip)
        wk = config.WELLKNOWN_DIR / ".well-known" / "matrix"
        feats = apiconf.features(state.load_state() | {"calls": a["calls"]}, s)
        state.write_text(wk / "client", templates.wellknown_client(sn, a["calls"], config.VERSION, features=feats), 0o644)
        state.write_text(wk / "server", templates.wellknown_server(sn), 0o644)
        config.CA_DIR.mkdir(parents=True, exist_ok=True)
        _hosts_entry(sn, a["name"])
        return ""

    async def _s_database(self, a: dict) -> str:
        rc, out = await compose.up("postgres")
        if rc != 0:
            raise InstallError("The database didn't start.", _tail(out))
        for _ in range(120):
            st = (await compose.ps()).get("postgres", {})
            if st.get("health") == "healthy":
                return ""
            if st.get("state") in ("exited", "dead"):
                raise InstallError("The database stopped.", _tail(await compose.logs('postgres')))
            await asyncio.sleep(1)
        raise InstallError("The database didn't become ready within 2 minutes.")

    async def _s_chat(self, a: dict) -> str:
        rc, out = await compose.up("synapse")
        if rc != 0:
            raise InstallError("The chat server didn't start.", _tail(out))
        # The first start creates the database tables; on a small box that takes a minute or two.
        for i in range(300):
            if await self.synapse.healthy():
                return ""
            if i and i % 10 == 0:
                st = (await compose.ps()).get("synapse", {})
                if st.get("state") in ("exited", "dead"):
                    raise InstallError("The chat server stopped.", _tail(await compose.logs('synapse')))
            await asyncio.sleep(1)
        raise InstallError("The chat server didn't come up within 5 minutes.", _tail(await compose.logs('synapse')))

    async def _s_accounts(self, a: dict) -> str:
        s = state.load_secrets()
        sn = a["server_name"]
        sysid = f"@{config.SYSTEM_LOCALPART}:{sn}"

        # 1. The box's own admin account (holds the token the dashboard uses; never signs in anywhere else).
        token = s.get("system_token")
        if not token or await self.synapse.whoami(token) != sysid:
            st, body = await self.synapse.register_with_secret(s["registration_shared_secret"], config.SYSTEM_LOCALPART,
                                                               s["system_password"], True, "Tin Hat Server")
            if st != 200:
                st, body = await self.synapse.login(config.SYSTEM_LOCALPART, s["system_password"], "Tin Hat Server (system)")
            if st != 200 or "access_token" not in body:
                raise InstallError(f"Couldn't create the server's system account: {body.get('error', st)}")
            token = body["access_token"]
            state.save_secrets(system_token=token)

        # 2. The person's admin account.
        mxid = f"@{a['username']}:{sn}"
        st, body = await self.synapse.register_with_secret(s["registration_shared_secret"], a["username"], a["password"], True,
                                                           a["display_name"])
        if st == 200:
            user_token = body["access_token"]
        elif body.get("errcode") == "M_USER_IN_USE":
            # A retried install: make the account match what was typed this time.
            await self.synapse.set_user(mxid, token, password=a["password"], admin=True, displayname=a["display_name"],
                                        logout_devices=False)
            st, body = await self.synapse.login(a["username"], a["password"], "Tin Hat Server setup")
            if st != 200:
                raise InstallError(f"Couldn't sign in to your account: {body.get('error', st)}")
            user_token = body["access_token"]
        else:
            raise InstallError(f"Couldn't create your account: {body.get('error', st)}")

        # 3. The first room, so the people you invite land somewhere (newcomers.py joins them to it).
        try:
            st, body = await self.synapse.req("GET", f"/_matrix/client/v3/directory/room/%23general%3A{sn}", token=user_token)
            if st != 200:
                st, body = await self.synapse.req("POST", "/_matrix/client/v3/createRoom", token=user_token,
                                                  json=general_room_request(sn))
                if st != 200:
                    log.warning("could not create #general: %s", body)
        finally:
            await self.synapse.logout(user_token)
        state.save_state(admin=mxid)
        return mxid

    async def _s_secure(self, a: dict) -> str:
        if a["mode"] == "anywhere":
            return await self._secure_anywhere(a)
        if a["mode"] == "domain":
            return await self._secure_domain(a)
        sn = a["server_name"]
        new = config.CADDYFILE.with_name("Caddyfile.new")
        state.write_text(new, templates.caddy_lan(sn), 0o644)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
        if rc != 0:
            raise InstallError("The web server's new settings were rejected.", _tail(out))
        os.replace(new, config.CADDYFILE)
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise InstallError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload()
        if rc != 0:
            raise InstallError("The web server didn't take its new settings.", _tail(out))
        # Caddy makes its local certificate authority the first time it needs a certificate.
        for _ in range(60):
            if config.CA_ROOT.exists():
                break
            await asyncio.sleep(1)
        else:
            raise InstallError("The server's certificate authority wasn't created.")
        config.CA_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(config.CA_ROOT, config.CA_DIR / "root.crt")
        os.chmod(config.CA_DIR / "root.crt", 0o644)
        # Prove the whole chain: https with this CA, through Caddy, to Synapse.
        ctx = ssl.create_default_context(cafile=str(config.CA_DIR / "root.crt"))
        last = ""
        for _ in range(30):
            try:
                conn = aiohttp.TCPConnector(ssl=ctx, resolver=_FixedResolver(sn))
                async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=10)) as s:
                    async with s.get(f"https://{sn}/_matrix/client/versions") as r:
                        if r.status == 200:
                            return ""
                        last = f"HTTP {r.status}"
            except (aiohttp.ClientError, OSError, TimeoutError) as e:
                last = str(e)
            await asyncio.sleep(1)
        raise InstallError(f"HTTPS didn't work yet ({last}).")

    async def _secure_anywhere(self, a: dict) -> str:
        sn = a["server_name"]
        acme = (names.creds() or {}).get("acme")
        if not acme:
            raise InstallError("This server has no name yet. Press Try again.")
        e = environment.env()
        new = config.CADDYFILE.with_name("Caddyfile.new")
        state.write_text(new, templates.caddy_anywhere(sn, acme, e["acme_directory"], environment.has_extra_roots(),
                                                       proxy_from=relay.proxy_from()), 0o600)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
        if rc != 0:
            raise InstallError("The web server's new settings were rejected.", _tail(out))
        os.replace(new, config.CADDYFILE)
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise InstallError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:
            raise InstallError("The web server didn't take its new settings.", _tail(out))
        # Caddy now asks Let's Encrypt (Pebble in the lab) for a certificate; the names service answers the DNS check.
        return await _wait_https(sn)

    async def _secure_domain(self, a: dict) -> str:
        sn = a["server_name"]
        provider, creds = owndomain.settings()
        if not provider:
            raise InstallError("The domain's DNS provider details are missing. Go back to the Name step.")
        if provider == "proxy":
            return await self._secure_proxy(a)
        e = environment.env()
        new = config.CADDYFILE.with_name("Caddyfile.new")
        state.write_text(new, templates.caddy_domain(sn, owndomain.caddy_tls(provider, creds), e["acme_directory"],
                                                     environment.has_extra_roots()), 0o600)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
        if rc != 0:
            raise InstallError("The web server's new settings were rejected.", _tail(out))
        os.replace(new, config.CADDYFILE)
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise InstallError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:
            raise InstallError("The web server didn't take its new settings.", _tail(out))
        # Let's Encrypt checks a record your DNS provider's API puts up: a wrong token shows here, in Caddy's log.
        return await _wait_https(sn, provider=owndomain.PROVIDERS[provider]["label"])

    async def _secure_proxy(self, a: dict) -> str:
        return await secure_proxy(a["server_name"])

    async def _s_dns(self, a: dict):
        own = a["domain"]
        state.save_secrets(domain={"provider": own["provider"], "creds": own["creds"]})
        state.save_state(domain={"provider": own["provider"], **({"proxies": own["proxies"]} if own.get("proxies") else {})})
        sn = a["server_name"]
        label = owndomain.PROVIDERS[own["provider"]]["label"]
        ip = await owndomain.public_ip()
        if not ip:
            return ("warn", "Couldn't find your home's public address, so the domain wasn't pointed yet. "
                            "The dashboard keeps trying.")
        try:
            moved = await owndomain.set_address(sn, ip)
        except owndomain.DNSAPIError as e:
            raise InstallError(f"{label} didn't accept the change ({e}). Check the API token and that it can edit "
                               f"this domain's DNS, then press Try again.")
        if moved:
            state.save_state(domain_status={"ip4": ip, "updated": True, "error": None}, livekit_public_ip=ip)
            return f"{sn} now points to your home ({ip}) through {label}."
        state.save_state(livekit_public_ip=ip)
        now = await asyncio.to_thread(owndomain.resolves_to, sn)
        if ip in now:
            return f"{sn} already points to your home ({ip})."
        where = "at your domain's DNS provider" if own["provider"] == "proxy" else f"in your {label} settings"
        return ("warn", f"Point {sn} at {ip} (an A record) {where}; friends need it to find the server. If your "
                        "home's address changes, your router's dynamic DNS can keep it current.")

    async def _s_ports(self, a: dict):
        rep = await self.checker.open_ports(a["calls"])
        kind, method = rep.get("kind"), rep.get("method")
        # Carrier NAT: offer the Tin Hat relay instead of a dead end (relay.py). Only for tinhat.me names: the relay
        # passes on names the names service knows.
        if a["mode"] == "anywhere" and (kind == "cgnat" or relay.on()):
            return await relay.setup_step(lambda st, d: self._step("ports", st, d), a["calls"])
        if kind == "cgnat":
            return ("warn", "Your internet provider doesn't allow incoming connections (carrier NAT).")
        if kind == "double-nat":
            return ("warn", "There are two routers in a row; the outside check below says what to change.")
        if kind == "direct":
            return ("done", "This server has its own public address; there are no router ports to open.")
        mapped = rep.get("mapped") or []
        if method and mapped and all(m["ok"] for m in mapped):
            how = "UPnP" if method == "upnp" else "NAT-PMP"
            took = sorted({m["took_over"] for m in mapped if m.get("took_over")})
            return ("done", f"Your router opened them ({how})." +
                    (f" They were still set for an earlier Tin Hat Server ({', '.join(took)}), which is gone." if took else ""))
        if method:
            ok = [f"{m['proto']} {m['port']}" for m in mapped if m["ok"]]
            bad = [m for m in mapped if not m["ok"]]
            holders = sorted({m["holder"] for m in bad if m.get("holder")})
            why = (f": another device ({', '.join(holders)}) already uses " + ("it" if len(bad) == 1 else "them")
                   if bad and all(m.get("taken") for m in bad) and holders else "")
            names = ", ".join(f"{m['proto']} {m['port']}" for m in bad)
            return ("warn", ("Your router opened " + ", ".join(ok) + ", but not " if ok else "Your router didn't open ")
                    + names + why + ". The check below says what to change.")
        return ("warn", "Your router didn't answer the automatic request; the check below says what to set.")

    async def _s_outside(self, a: dict):
        from . import reach
        out = await self.checker.outside(a["calls"])
        st = state.load_state()
        sm = reach.summary(st.get("ports"), out, owndomain.proxy_info(st))
        return ("done" if sm["level"] == "good" else "warn", sm["headline"])

    async def _s_calls(self, a: dict) -> str:
        rc, out = await compose.up("livekit", "lk-jwt")
        if rc != 0:
            raise InstallError("The call server didn't start.", _tail(out))
        checks = {"livekit": "http://127.0.0.1:7880/", "lk-jwt": "http://127.0.0.1:8070/healthz"}
        down: list[str] = []
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
            for _ in range(60):
                down = []
                for svc, url in checks.items():
                    try:
                        async with s.get(url) as r:
                            if r.status != 200:
                                down.append(svc)
                    except (aiohttp.ClientError, OSError, TimeoutError):
                        down.append(svc)
                if not down:
                    return ""
                await asyncio.sleep(1)
        logs = "\n".join(f"--- {svc} ---\n{_tail(await compose.logs(svc))}" for svc in down)
        raise InstallError("The call server didn't come up." if "livekit" in down else "Call sign-in didn't come up.", logs)

    async def _s_restore(self, a: dict) -> str:
        from . import backup
        r = a["restore"]
        work = config.STATE_DIR / "restore"
        files = work / "files"
        shutil.rmtree(files, ignore_errors=True)
        files.mkdir(parents=True)
        res = await asyncio.to_thread(backup.restic, r["repo"], r["password"], "restore", r["snapshot"],
                                      "--target", str(files), timeout=6 * 3600)
        if res.returncode != 0:
            raise InstallError("Couldn't read the backup.", backup._why(res))
        root = files / str(backup.STAGING).lstrip("/")
        if not (root / "db.dump").exists() or not (root / "state" / "synapse" / "signing.key").exists():
            raise InstallError("The backup is missing the database or the server's identity (signing key).")
        for item in backup.STATE_ITEMS:
            if item in ("state.json", "environment.json"):  # state is merged below; the environment is this box's
                continue
            src, dst = root / "state" / item, config.STATE_DIR / item
            if not src.exists():
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        old = state.read_json(root / "state" / "state.json", {})
        drop = {"phase", "ports", "reach", "assessment", "failed_step", "error", "error_details", "names_notices",
                "connect_codes", "names_status", "restoring", "livekit_public_ip",
                "restored_from"}  # a copy of a server that was itself restored once: this restore is the one to remember
        meta = state.read_json(root / "backup.json", {})
        if isinstance(old.get("domain"), dict):  # the proxy this copy sits behind may connect from elsewhere: named
            old["domain"] = {k: v for k, v in old["domain"].items() if k != "proxies"}  # again in the dashboard
        state.save_state(**{k: v for k, v in old.items() if k not in drop},
                         restored_from={"at": int(time.time()), "snapshot": r["snapshot"], "backup_time": r.get("time"),
                                        "backup_version": meta.get("version"), "old_addresses": meta.get("addresses") or []})
        media = files / str(backup.MEDIA).lstrip("/")
        if media.exists():
            shutil.rmtree(backup.MEDIA, ignore_errors=True)
            shutil.move(str(media), str(backup.MEDIA))
        backup.MEDIA.mkdir(parents=True, exist_ok=True)
        shutil.move(str(root / "db.dump"), str(work / "db.dump"))
        meta = state.read_json(root / "backup.json", {})
        shutil.rmtree(files, ignore_errors=True)
        config.POSTGRES_DIR.mkdir(parents=True, exist_ok=True)
        _chown_tree(config.SYNAPSE_DIR, config.SYNAPSE_UID)
        _hosts_entry(a["server_name"], a["name"])
        refresh_configs(force=True)
        c = meta.get("counts") or {}
        return (f"The backup from {(meta.get('created') or '?')[:16].replace('T', ' ')} UTC"
                + (f": {_n(c.get('people'), 'person', 'people')}, {_n(c.get('rooms'), 'room', 'rooms')}, "
                   f"{_n(c.get('messages'), 'message', 'messages')}." if c else "."))

    async def _s_restoredb(self, a: dict) -> str:
        await self._s_database(a)  # the database server, empty
        pw = state.load_secrets()["postgres_password"]
        dump = config.STATE_DIR / "restore" / "db.dump"
        psql = ("exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", "postgres", "-c")
        # The restored settings carry the database password; a database server started before on this box may
        # have another one, so set it, then replace the empty database with the backup's.
        for sql in (f"ALTER ROLE synapse WITH PASSWORD '{pw}'", "DROP DATABASE IF EXISTS synapse WITH (FORCE)",
                    "CREATE DATABASE synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"):
            rc, out = await compose.run(*psql, sql, timeout=300)
            if rc != 0:
                raise InstallError("Couldn't prepare the database for the backup.", _tail(out))
        with open(dump, "rb") as f:
            proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_restore", "-U",
                                                        "synapse", "-d", "synapse", "--no-owner", stdin=f,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), 6 * 3600)
        if proc.returncode != 0:
            raise InstallError("The database in the backup couldn't be restored.", _tail(out.decode(errors="replace")))
        dump.unlink(missing_ok=True)
        if a.get("mode") != "anywhere":  # (a tinhat.me name: right after the name moves here, in _s_takeover)
            rf = state.load_state().get("restored_from") or {}
            told = await _tell_old_computer(rf.get("old_addresses") or [], a["server_name"])
            state.save_state(restored_from={**rf, "told_old": told})
        return ""

    async def _s_takeover(self, a: dict) -> str:
        try:
            # Started over after an earlier try already took the name over: that try's key, not the backup's.
            kept = state.read_json(names.TAKEOVER_FILE, {})
            if kept.get("fqdn") == a["server_name"] and kept.get("names"):
                state.save_secrets(names=kept["names"])
                res = await names.update()
                if res.get("ok") is False:
                    raise names.NamesError(res.get("message") or "that key didn't work", res.get("error") or "")
            else:
                await names.rotate()
                res = await names.update()
        except names.NamesError as e:
            if e.code == "moved":
                raise InstallError("This backup's name has already moved to another computer (it was restored there "
                                   "from a copy too). Use the newest backup, or the computer that has the name now.")
            raise InstallError(f"Couldn't move the name to this computer: {e}")
        if res.get("ok") is False:
            raise InstallError(f"Couldn't move the name to this computer: {res.get('message')}")
        if owndomain.is_public_v4(res.get("ip4")):
            state.save_state(livekit_public_ip=res["ip4"])
        refresh_configs(force=True)
        # Tell the computer the backup came from, so it stands down now instead of within ten minutes (moved.py).
        rf = state.load_state().get("restored_from") or {}
        told = await _tell_old_computer(rf.get("old_addresses") or [], a["server_name"])
        state.save_state(restored_from={**rf, "told_old": told})
        down = [ip for ip, how in told.items() if how == "stood down"]
        return (f"{a['server_name']} now points to this computer ({res.get('ip4')}). The old computer can't use the "
                "name any more" + (f", and it stopped chat and calls ({', '.join(down)})." if down else "."))

    async def _s_finish(self, a: dict) -> str:
        if a.get("restore"):
            from . import backup
            await asyncio.to_thread(backup.unmount_all)
            names.TAKEOVER_FILE.unlink(missing_ok=True)  # the move is done: the key is in the secrets for good
        installed = state.load_state().get("installed_at") if a.get("restore") else None
        state.save_state(phase="ready", server_name=a["server_name"], mode=a["mode"], calls=a["calls"], features=a["features"],
                         installed_at=installed or datetime.now(timezone.utc).isoformat(timespec="seconds"),
                         version=config.VERSION, failed_step=None, error=None, restoring=None)
        try:
            config.SETUP_CODE_FILE.unlink()
        except FileNotFoundError:
            pass
        st = state.load_state()
        apiconf.write(st, state.load_secrets())
        write_wellknowns(st, a["server_name"], a["calls"])
        rc, out = await compose.up("api", "games")
        if rc != 0:
            log.error("the Tin Hat API didn't start: %s", _tail(out))
        console.refresh(force=True)
        # Rename the box last (tinhat.local → <name>.local), after the wizard has had time to show the finish
        # page, which already links to the new name.
        asyncio.get_running_loop().call_later(8, _rename_host, a["name"], a["server_name"])
        return ""


async def _tell_old_computer(addrs: list[str], server_name: str) -> dict:
    """Right after the restore: tell the computer the backup came from (its home addresses are in the backup) that its
    copy moved here, with proof that this computer holds a restored copy (moved.py), so it stands down at once: chat
    and calls off, the router's ports, the relay and the home-network name let go. Returns {address: what happened}."""
    from . import moved
    out: dict[str, str] = {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
        # Only plausible addresses of a computer (the same computer set up again is skipped), never redirected.
        for ip, bases in moved.old_bases(addrs, set(hw.addresses())):
            out[ip] = "no answer"
            for base in bases:
                try:
                    async with s.get(f"{base}/admin/name-check", allow_redirects=False) as r:
                        if r.status != 200:
                            continue
                        nonce = (await r.json()).get("nonce") or ""
                    body = {"nonce": nonce, "proof": moved.proof(nonce, server_name), "to": next(iter(hw.addresses()), "")}
                    async with s.post(f"{base}/admin/name-check", json=body, headers={"X-Tinhat": "1"},
                                      allow_redirects=False) as r:
                        d = await r.json() if r.status == 200 else {}
                        out[ip] = "stood down" if d.get("moved") else "not yet"
                        break
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError):
                    continue
    log.info("told the old computer: %s", out or "no addresses in the backup")
    return out


class _FixedResolver(AbstractResolver):
    """Resolve the server's own name to 127.0.0.1 (mDNS isn't for the box's own lookups)."""

    def __init__(self, name: str):
        self.name = name

    async def resolve(self, host, port=0, family=0):
        return [{"hostname": host, "host": "127.0.0.1", "port": port, "family": 2, "proto": 0, "flags": 0}]

    async def close(self):
        pass


_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


async def _wait_https(sn: str, provider: str | None = None) -> str:
    """Wait for the web server to answer over HTTPS with a real certificate for sn (up to ~8 minutes)."""
    ctx = environment.ssl_context()
    last = ""
    for i in range(240):
        try:
            conn = aiohttp.TCPConnector(ssl=ctx, resolver=_FixedResolver(sn))
            async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(f"https://{sn}/_matrix/client/versions") as r:
                    if r.status == 200:
                        return f"A certificate for {sn} is in place."
                    last = f"HTTP {r.status}"
        except (aiohttp.ClientError, OSError, TimeoutError) as ex:
            last = str(ex)
        await asyncio.sleep(1 if i < 30 else 2)
    log_text = await compose.logs("caddy", 600)
    lines = cert_log(log_text, sn)
    raise InstallError("The certificate didn't arrive within a few minutes." + cert_hint(lines, provider),
                       f"last: {last}\n" + ("\n".join(lines) if lines else _tail(log_text, 40)))


async def _wait_cert(sn: str, provider: str | None = None, seconds: int = 480) -> None:
    """Wait until the web server presents a valid certificate for sn; any answer behind it will do (the move's
    temporary "moving here" site answers 503)."""
    ctx = environment.ssl_context()
    last = ""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            conn = aiohttp.TCPConnector(ssl=ctx, resolver=_FixedResolver(sn))
            async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(f"https://{sn}/"):
                    return
        except (aiohttp.ClientError, OSError, TimeoutError) as ex:
            last = str(ex)
        await asyncio.sleep(2)
    log_text = await compose.logs("caddy", 600)
    lines = cert_log(log_text, sn)
    raise InstallError("The certificate didn't arrive within a few minutes." + cert_hint(lines, provider),
                       f"last: {last}\n" + ("\n".join(lines) if lines else _tail(log_text, 40)))


def cert_log(text: str, name: str | None = None, n: int = 12) -> list[str]:
    """Caddy's certificate lines (its tls.* and ACME loggers), short; with `name`, not the lines about other names
    (a former name's renewal). The rest of its log (every request it couldn't pass on, say while chat is paused) says
    nothing about the certificate."""
    out = []
    for line in (text or "").splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        lg = str(d.get("logger", "")) if isinstance(d, dict) else ""
        about = d.get("identifier") or d.get("identifiers") if isinstance(d, dict) else None
        if name and about and name not in (about if isinstance(about, list) else [about]):
            continue
        if lg.startswith("tls") or "acme" in lg:
            err = str(d.get("error") or "")
            out.append(f"{lg}: {d.get('msg', '')}" + (f" ({err[:300]})" if err else ""))
    return out[-n:]


def cert_hint(lines: list[str], provider: str | None) -> str:
    """What most likely kept the certificate away, from Caddy's certificate lines."""
    t = " ".join(lines).lower()
    unreachable = any(w in t for w in ("no such host", "i/o timeout", "connection refused", "network is unreachable"))
    if unreachable and "directory" in t:
        return " The server couldn't reach the certificate authority (Let's Encrypt): check its internet connection."
    if unreachable and provider:
        return f" The server couldn't reach {provider}: check its internet connection."
    if provider and any(w in t for w in ("unauthorized", "forbidden", "authentication", "invalid api", " 401", " 403")):
        return f" {provider} refused the change: check that the API token can edit this domain's DNS."
    if "rate limit" in t or "ratelimit" in t or "too many" in t:
        return " The certificate authority is limiting new certificates for this domain just now; try again later."
    return f" Check that the {provider} API token can edit this domain's DNS." if provider else ""


def refresh_configs(force: bool = False, caddyfile_to=None) -> list[str]:
    """Write every generated config again from what the box already knows (state, secrets, the name's credentials):
    after an update brought new templates, or after a restore. The signing key and the database are never touched.
    caddyfile_to: write the Caddyfile there instead of the live one (web.apply_proxy_addresses validates it first).
    Returns the files whose contents changed (the caller restarts what uses them)."""
    st = state.load_state()
    if st.get("phase") != "ready" and not force:
        return []
    s = state.load_secrets()
    sn = st["server_name"]
    lan = st.get("mode", "lan") == "lan"
    calls = st.get("calls", True)
    features = st.get("features") or {"calls": calls, "previews": False, "uploadMb": 100, "directory": True}
    wk = config.WELLKNOWN_DIR / ".well-known" / "matrix"
    files = [config.COMPOSE_ENV, config.SYNAPSE_DIR / "homeserver.yaml", config.SYNAPSE_DIR / "log.config",
             config.LIVEKIT_DIR / "livekit.yaml", wk / "client", wk / "server", config.CADDYFILE, apiconf.ENV]
    before = {f: f.read_bytes() if f.exists() else None for f in files}
    bundle = environment.write_bundle() if not lan else None
    state.write_text(config.COMPOSE_ENV, templates.compose_env(sn, s, lan=lan, bundle=bool(bundle)), 0o600)
    write_synapse_config(sn, s, features, None if lan else (st.get("federation") or []))
    apiconf.write(st, s)
    public_ip = None if lan else st.get("livekit_public_ip") or (st.get("names_status") or {}).get("ip4")
    if not owndomain.is_public_v4(public_ip):  # a private one (NAT loopback) would break outside callers' calls
        public_ip = None
    # Through the Tin Hat relay the call server listens on the relay's port and announces the relay (relay.py).
    state.write_text(config.LIVEKIT_DIR / "livekit.yaml", relay.livekit_yaml(s, public_ip), 0o600)
    write_wellknowns(st, sn, calls)
    caddyfile, mode = None, 0o644
    if lan:
        caddyfile = templates.caddy_lan(sn)
    elif st.get("mode") == "domain":
        provider, creds = owndomain.settings()
        if provider == "proxy":
            caddyfile = templates.caddy_proxy(sn, owndomain.PROXY_PORT, config.proxy_only(), owndomain.proxies(st))
        elif provider:
            e = environment.env()
            caddyfile = templates.caddy_domain(sn, owndomain.caddy_tls(provider, creds), e["acme_directory"],
                                               environment.has_extra_roots())
            mode = 0o600
    else:
        acme = (names.creds() or {}).get("acme")
        if acme:
            e = environment.env()
            caddyfile = templates.caddy_anywhere(sn, acme, e["acme_directory"], environment.has_extra_roots(),
                                                 proxy_from=relay.proxy_from())
            mode = 0o600
    if caddyfile is not None:
        former = [f for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name") and f["name"] != sn]
        if former:  # moved to its own domain (move.py): the old names keep answering while they last
            caddyfile = templates.with_former_names(caddyfile, sn, [(f["name"], _former_tls(f, s)) for f in former])
            mode = 0o600
        state.write_text(caddyfile_to or config.CADDYFILE, caddyfile, mode)
    return [str(f) for f in files if (f.read_bytes() if f.exists() else None) != before[f]]


def write_wellknowns(st: dict, sn: str, calls: bool) -> None:
    """/.well-known/matrix/{client,server}: this server's (with the names it had before: dev.tinhat.moved_from), and
    each former name's (where the server went: dev.tinhat.moved_to). refresh_configs and the Features card."""
    wk = config.WELLKNOWN_DIR / ".well-known" / "matrix"
    former = [f["name"] for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name") and f["name"] != sn]
    held = {f["name"] for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name") and not f.get("released")}
    feats, rec = apiconf.features(st), apiconf.recorder(st)
    state.write_text(wk / "client", templates.wellknown_client(sn, calls, config.VERSION, former, features=feats, recorder=rec), 0o644)
    state.write_text(wk / "server", templates.wellknown_server(sn), 0o644)
    for name in former:
        if not templates.is_hostname(name):
            continue
        if name not in held:  # let go of: no site answers it any more, so its own .well-known goes too
            shutil.rmtree(config.WELLKNOWN_DIR / "former" / name, ignore_errors=True)
            continue
        fwk = config.WELLKNOWN_DIR / "former" / name / ".well-known" / "matrix"
        state.write_text(fwk / "client", templates.wellknown_former_client(sn, calls, config.VERSION, feats, rec), 0o644)
        state.write_text(fwk / "server", templates.wellknown_server(sn), 0o644)


def _former_tls(f: dict, s: dict) -> str | None:
    """How a former name gets its certificate here (templates.with_former_names), or None when it doesn't come here
    any more: behind the owner's reverse proxy the router sends 443 to that proxy."""
    if f.get("released"):  # let go of (the move card): media only
        return None
    if config.proxy_only():  # another web server on this machine has 443: no site of ours there
        return None
    provider, _ = owndomain.settings()
    if provider == "proxy":  # behind the owner's proxy: nothing reaches this server except through it (no site here
        return None          # for an old name, a .local one included, that would go around the proxy's own rules)
    if f.get("mode") == "lan":
        return "internal"  # the server's own CA: the devices that trusted it still do (on the home network)
    try:
        if f.get("mode") == "anywhere":
            nc = s.get("names") or {}
            if nc.get("fqdn") == f["name"] and nc.get("acme"):
                return templates.acmedns_tls(nc["acme"])
        elif f.get("mode") == "domain":
            d = (s.get("former_domains") or {}).get(f["name"]) or {}
            if d.get("provider") and d["provider"] != "proxy":
                return owndomain.caddy_tls(d["provider"], d.get("creds") or {})
    except ValueError:
        pass
    return None


async def secure_proxy(sn: str, write: bool = True) -> str:
    """Behind the owner's reverse proxy: the plain port for it, and the box's own certificate on its loopback
    addresses (its own services check sign-ins through https://<name>). Setup's last step, and a move's "secure"
    (write=False: the move's switch wrote and checked the Caddyfile already, with the former names' media)."""
    port = owndomain.PROXY_PORT
    shared = config.proxy_only()
    if write:
        new = config.CADDYFILE.with_name("Caddyfile.new")
        state.write_text(new, templates.caddy_proxy(sn, port, shared, owndomain.proxies()), 0o644)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
        if rc != 0:
            raise InstallError("The web server's new settings were rejected.", _tail(out))
        os.replace(new, config.CADDYFILE)
    rc, out = await compose.up("caddy")
    if rc != 0:
        raise InstallError("The web server didn't start.", _tail(out))
    rc, out = await compose.caddy_reload()
    if rc != 0:
        raise InstallError("The web server didn't take its new settings.", _tail(out))
    for _ in range(0 if shared else 60):
        if config.CA_ROOT.exists():
            break
        await asyncio.sleep(1)
    else:
        if not shared:
            raise InstallError("The server's own certificate authority wasn't created.")
    if not shared:
        config.CA_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(config.CA_ROOT, config.CA_DIR / "root.crt")
        os.chmod(config.CA_DIR / "root.crt", 0o644)
    # The call sign-in service trusts that root from now on (with the system's roots, for connected servers).
    bundle = environment.write_bundle()
    state.write_text(config.COMPOSE_ENV, templates.compose_env(sn, state.load_secrets(), lan=False,
                                                               bundle=bool(bundle)), 0o600)
    last = ""
    for _ in range(30):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(f"http://127.0.0.1:{port}/_matrix/client/versions", headers={"Host": sn}) as r:
                    plain = r.status == 200
                    last = f"port {port}: HTTP {r.status}"
            if shared and plain:  # nothing of its own on 443 to check: the outside check sees the proxy
                lan = (hw.addresses() or ["this server's address"])[0]
                return (f"Ready for your reverse proxy: send https://{sn} to http://{lan}:{port}. The dashboard's "
                        "Network tab has the settings for nginx, Caddy, Traefik and Nginx Proxy Manager.")
            ctx = ssl.create_default_context(cafile=str(config.CA_DIR / "root.crt"))
            conn = aiohttp.TCPConnector(ssl=ctx, resolver=_FixedResolver(sn))
            async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(f"https://{sn}/_matrix/client/versions") as r:
                    if plain and r.status == 200:
                        lan = (hw.addresses() or ["this server's address"])[0]
                        return (f"Ready for your reverse proxy: send https://{sn} to http://{lan}:{port}. The "
                                "dashboard's Network tab has the settings for nginx, Caddy, Traefik and Nginx Proxy "
                                "Manager.")
                    last = f"own certificate: HTTP {r.status}"
        except (aiohttp.ClientError, OSError, TimeoutError) as e:
            last = str(e)
        await asyncio.sleep(1)
    raise InstallError(f"The web server didn't answer for your reverse proxy yet ({last}).",
                       _tail(await compose.logs("caddy"), 40))


def write_synapse_config(server_name: str, secrets: dict, features: dict, federation: list[str] | None = None) -> None:
    """homeserver.yaml + log config + signing key (kept if it exists), owned by the Synapse container's user.
    federation=None: home-network mode; a list: from anywhere, federating only with those servers."""
    syn = config.SYNAPSE_DIR
    (syn / "media_store").mkdir(parents=True, exist_ok=True)
    extra = []
    if federation is not None and environment.write_bundle() is not None:
        extra = environment.synapse_root_files()
    state.write_text(syn / "homeserver.yaml",
                     templates.homeserver_yaml(server_name, secrets, features, federation, extra,
                                               push_gateway=apiconf.docker_gateway()), 0o600)
    state.write_text(syn / "log.config", templates.LOG_CONFIG, 0o644)
    if not (syn / "signing.key").exists():
        state.write_text(syn / "signing.key", templates.signing_key(), 0o600)
    _chown_tree(syn, config.SYNAPSE_UID)


def _n(n, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _tail(text: str, n: int = 25) -> str:
    lines = [_ANSI.sub("", l).rstrip() for l in (text or "").strip().splitlines() if l.strip()]
    return "\n".join(lines[-n:])[-3000:] or "no details"


def _chown_tree(path, uid: int) -> None:
    for root, dirs, files in os.walk(path):
        os.chown(root, uid, uid)
        for f in files:
            os.chown(os.path.join(root, f), uid, uid)


def _hosts_entry(server_name: str, short: str) -> None:
    """127.0.1.1 = this box's own name(s), Debian style; host-network containers (lk-jwt) read it too. On the owner's
    own Linux machine that line stays the machine's: the server's name gets a tagged line of its own instead."""
    if config.own_machine():
        return _hosts_entry_own(server_name)
    try:
        lines = open("/etc/hosts").read().splitlines()
    except OSError:
        lines = []
    lines = [l for l in lines if not l.startswith("127.0.1.1")]
    lines.insert(1 if lines else 0, f"127.0.1.1\t{server_name} {short}")
    state.write_text(Path("/etc/hosts"), "\n".join(lines) + "\n", 0o644)


def _hosts_entry_own(server_name: str) -> None:
    """On the owner's own Linux machine: one line of our own (tagged), so the machine's name keeps its 127.0.1.1."""
    if config.compose_edition():  # Docker owns the container's /etc/hosts; lk-jwt gets the name by extra_hosts
        return
    try:
        lines = open("/etc/hosts").read().splitlines()
    except OSError:
        lines = []
    lines = [l for l in lines if not l.rstrip().endswith("# tinhat-server")]
    # Behind a reverse proxy on this same machine the box has no HTTPS of its own: its name leads to that proxy, at the
    # machine's own address (where the router sends 443).
    ip = (hw.addresses() or [config.SELF_IP_OWN])[0] if config.proxy_only() else config.SELF_IP_OWN
    lines.append(f"{ip}\t{server_name}\t# tinhat-server")
    state.write_text(Path("/etc/hosts"), "\n".join(lines) + "\n", 0o644)


def _rename_host(short: str, server_name: str) -> None:
    if config.own_machine():  # the owner's machine keeps its own name
        _hosts_entry_own(server_name)
        return
    try:
        subprocess.run(["hostnamectl", "set-hostname", short], check=False, timeout=20)
        _hosts_entry(server_name, short)
        subprocess.run(["systemctl", "restart", "avahi-daemon"], check=False, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("rename to %s failed: %s", short, e)
    console.refresh(force=True)

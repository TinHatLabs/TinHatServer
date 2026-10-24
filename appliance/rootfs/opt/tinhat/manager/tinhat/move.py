"""Move to your own domain: this server under a new name, with everyone's accounts, rooms and messages.

Maintenance → "Move to your own domain". The owner gives the domain and its DNS provider (as setup's "My own domain"
asks). The server first gets the new address's certificate (DNS-01, so a token that can't edit the domain costs
nothing), then pauses chat, saves a copy of everything (the rollback), rebuilds its chat database under the new name
(move_synapse.py, in a one-off container of its own Synapse image: every account renamed, every message re-hashed and
re-signed, rooms keep their ids so encrypted history still opens), switches its address and starts chat again. Everyone
signs in again at the new address with the same username and password and unlocks with their Security Key: their message
keys come back from their own key backup, and their app makes a fresh encryption identity under the same Security Key
(the old ones were signed over the old name).

The old name keeps answering while it lasts (a tinhat.me name as long as this server holds it, a .local name on the
home network): apps that still use it reach the same chat server, its .well-known says where the server went,
browsers are sent to the new address, and media of the old name (also inside encrypted messages) comes from here.

If anything fails before chat runs under the new name, the copy goes back: the server is as it was, under its old name.
A restart in the middle does the same (or finishes the move, once chat and HTTPS already run under the new name); a
rollback that couldn't finish is tried again at every start, and until then chat stays off and no other move starts.
"""
import asyncio
import json
import logging
import os
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from . import compose, config, environment, hw, moved, names, owndomain, relay, state, templates

log = logging.getLogger("tinhat.move")

DIR = config.STATE_DIR / "move"
STATUS = DIR / "status.json"
SCRIPT = Path(__file__).with_name("move_synapse.py")
STEPS = [
    ("check", "Checking the new address"),
    ("certificate", "Getting the new address's certificate"),
    ("stop", "Pausing chat"),
    ("export", "Saving a copy of everything"),
    ("rebuild", "Moving every account, room and message to the new name"),
    ("switch", "Switching to the new address"),
    ("chat", "Starting chat under the new name"),
    ("secure", "Opening the new address (HTTPS)"),
    ("tell", "Pointing the old address to the new one"),
    ("outside", "Checking from outside your home"),
]
# Once these are done the move stays done, even across a restart: chat runs under the new name and people may use it.
POINT_OF_NO_RETURN = "secure"
CONTAINER = "tinhat-move"  # the rebuild's one-off container (named, so a restart in the middle can stop it)
CALL_MEMBER_TYPES = ("org.matrix.msc3401.call.member", "m.call.member")  # the calls' membership state (MSC4143)
REBUILD_SILENCE = 3 * 3600  # the rebuild says something at least this often (one table, one batch); else it's stuck


class MoveError(Exception):
    def __init__(self, msg: str, details: str = ""):
        super().__init__(msg)
        self.details = details


def _tail(text: str, n: int = 25) -> str:
    return "\n".join((text or "").strip().splitlines()[-n:])


def former_names(st: dict | None = None) -> list[dict]:
    """The names this server had before (newest last): [{"name", "mode", "at"}]."""
    st = st if st is not None else state.load_state()
    return [f for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name")]


def held_former_names(st: dict | None = None) -> list[dict]:
    """The former names this server still answers (not let go)."""
    return [f for f in former_names(st) if not f.get("released")]


def can_let_go(st: dict, name: str) -> dict | None:
    """The former name's entry if the owner can let go of it now: still held, or a let-go that didn't finish."""
    return next((f for f in former_names(st) if f["name"] == name and (not f.get("released") or f.get("pending"))), None)


def marked(st: dict, name: str, **fields) -> list[dict]:
    """The former names with `name`'s entry changed (pure: tests use it). A field set to None goes."""
    out = []
    for f in former_names(st):
        if f["name"] == name:
            f = {**f, **fields}
            f = {k: v for k, v in f.items() if v is not None}
        out.append(f)
    return out


def _mark(name: str, **fields) -> None:
    state.save_state(former_names=marked(state.load_state(), name, **fields))


async def let_go(name: str) -> str:
    """Let go of a former name (the move card's "Let go…"): the server stops answering it. Its entry stays, marked
    released, so its media (mxc://name/…, also inside encrypted messages) keeps opening here. A tinhat.me name that is
    this server's own registration goes back to the names service for good (nobody can have it again); an old own
    domain's DNS settings are forgotten. Each step is written down before the next, so pressing Let go again finishes
    one that stopped half-way (a lost answer from the names service, a web server that didn't reload)."""
    from . import install
    st = state.load_state()
    f = can_let_go(st, name)
    if f is None:
        raise MoveError(f"{name} isn't an old address this server still answers.")
    nc = names.creds() or {}
    note = ""
    if f.get("mode") == "anywhere" and not f.get("released"):
        if nc.get("fqdn") == name:  # this server's own registration of that name, and only that
            _mark(name, pending=True)  # written first: if the answer gets lost, the next Let go finishes it
            try:
                await names.release()
            except names.NamesError as e:
                raise MoveError(f"The names service didn't confirm letting go of {name} ({e}). Press Let go again to "
                                "finish: it's safe to repeat.")
            state.save_secrets(names=None)  # its registration went with it
            state.save_state(former_told=None)
            note = " The name went back to the Tin Hat names service for good."
        else:
            note = (" This server doesn't hold its tinhat.me registration any more, so the names service wasn't asked "
                    "(the name stays with whoever holds it).")
    if f.get("mode") == "domain":
        fd = dict(state.load_secrets().get("former_domains") or {})
        if fd.pop(name, None) is not None:
            state.save_secrets(former_domains=fd)
    _mark(name, released=f.get("released") or int(time.time()), pending=True)  # the web server's settings still to apply
    install.refresh_configs(force=True)  # its site and its .well-known go; its media stays
    rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile")
    if rc == 0:
        rc, out = await compose.caddy_reload(force=True)
    if rc != 0:
        told = " (the names service has let go of it already)" if note.startswith(" The name went") else ""
        raise MoveError(f"The web server didn't take its settings without {name} yet{told}: press Let go again to "
                        "finish.", _tail(out))
    _mark(name, pending=None)
    log.info("let go of the former name %s", name)
    return f"This server no longer answers {name}.{note} Pictures and files from before the move still open."


def new_server_name(old: str, new: str, st: dict) -> dict:
    """The state after the switch (pure: tests use it)."""
    out = dict(st)
    out["former_names"] = [f for f in former_names(st) if f["name"] != new] + [
        {"name": old, "mode": st.get("mode", "lan"), "at": int(time.time())}]
    out["server_name"] = new
    out["mode"] = "domain"
    if isinstance(out.get("admin"), str) and out["admin"].endswith(":" + old):
        out["admin"] = out["admin"][: -len(old)] + new
    return out


def unresolved() -> bool:
    """A move the box was in the middle of, or a rollback that didn't finish: chat must not start on its own (bring_up
    leaves it to the move's recovery, which starts it once the server is consistent again)."""
    return (state.read_json(STATUS, {}) or {}).get("status") in ("running", "rolling-back")


def services(st: dict | None = None) -> list[str]:
    """What runs on a ready server (as bring_up starts it): no call service when calls are off."""
    st = st if st is not None else state.load_state()
    return ["caddy", "postgres", "synapse"] + (["livekit", "lk-jwt"] if st.get("calls", True) else []) + ["api", "games"]


class Mover:
    def __init__(self, synapse, checker=None, on_switched=None):
        self.synapse, self.checker = synapse, checker  # checker: reach.Checker (the outside check at the end)
        self.on_switched = on_switched  # (old, new): the dashboard's sign-ins follow their accounts to the new name
        self.task: asyncio.Task | None = None
        doc = state.read_json(STATUS, {}) or {}
        self.doc = doc if doc.get("steps") else self._fresh("", "")

    @staticmethod
    def _fresh(old: str, new: str) -> dict:
        return {"status": "idle", "from": old, "to": new, "started": None, "finished": None, "error": None,
                "details": "", "work": None,
                "steps": [{"id": i, "label": l, "status": "pending", "detail": ""} for i, l in STEPS]}

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def progress(self) -> dict:
        return {**self.doc, "running": self.running}

    def _save(self) -> None:
        try:  # a full disk must never stop a rollback: the status file is the dashboard's, not the move's
            state.write_json(STATUS, self.doc, 0o600)
        except OSError as e:
            log.error("move status not saved: %s", e)

    def _step(self, sid: str, status: str, detail: str = "") -> None:
        for s in self.doc["steps"]:
            if s["id"] == sid:
                s["status"], s["detail"] = status, detail
        self._save()
        log.info("move step %s: %s %s", sid, status, detail)

    def _steps_done(self, upto: str) -> bool:
        ids = [i for i, _ in STEPS]
        st = {s["id"]: s["status"] for s in self.doc["steps"]}
        return all(st.get(i) in ("done", "warn") for i in ids[: ids.index(upto) + 1])

    # ---- the owner's side ---------------------------------------------------------------------------------
    async def check(self, answers: dict) -> dict:
        """What the dashboard shows before the owner says go: the new name (checked as setup checks it), what
        moves, and anything in the way. Nothing changes."""
        st = state.load_state()
        old = st.get("server_name") or ""
        if st.get("phase") != "ready":
            return {"ok": False, "problem": "This server isn't set up yet."}
        own, problem = owndomain.validate(_answers(answers))
        if problem:
            return {"ok": False, "problem": problem}
        problem = _in_the_way(st, own, old) or self._blocked()
        if problem:
            return {"ok": False, "problem": problem}
        rc, out = await self._rebuild(old, own["domain"], check=True)
        if rc != 0:
            return {"ok": False, "problem": _last(out).get("error") or "The chat database couldn't be checked.",
                    "details": _tail(out)}
        counts = _last(out, "result")
        ip = await owndomain.public_ip()
        points = await asyncio.to_thread(owndomain.resolves_to, own["domain"])
        label = owndomain.PROVIDERS[own["provider"]]["label"]
        keeps = owndomain.PROVIDERS[own["provider"]].get("keeps_address")
        warnings = []
        proxy = None
        if own["provider"] == "proxy":
            proxy = owndomain.proxy_info({**st, "server_name": own["domain"], "mode": "domain",
                                          "domain": {"provider": "proxy"}})
            warnings.append(f"Before you move, set your reverse proxy to send https://{own['domain']} to "
                            f"http://{proxy['lanIp']}:{proxy['port']} (the settings for the common proxies are below). "
                            "The move checks that it does before anything changes, and stops if it doesn't.")
            if not points:
                warnings.append(f"{own['domain']} isn't in public DNS yet: point it at your reverse proxy (an A record) "
                                "before you move, or friends outside won't find the server.")
            elif ip and ip not in points:
                warnings.append(f"In public DNS {own['domain']} points to {', '.join(points)}, not your home ({ip}). "
                                "Fine if your reverse proxy runs elsewhere (a rented server); if it runs at home, point "
                                "the name there first. The move's own check uses this server's DNS, which may differ.")
            if st.get("mode", "lan") == "lan":
                warnings.append(f"Afterwards this server is reached through your proxy: {old} stops leading here "
                                f"(everyone signs in at {own['domain']}).")
            elif not state.behind_proxy(st):
                warnings.append(f"Today this server answers your router's ports 80 and 443 itself. Behind your proxy "
                                "the router sends them to the proxy instead; calls still need ports 7881 and 7882 "
                                f"sent to this server. {old} keeps working only if your proxy sends it here too.")
        elif ip and ip not in points and not keeps:
            warnings.append(f"{own['domain']} doesn't point to your home ({ip}) yet: point it there (an A record) "
                            f"in your {label} settings before you move, or friends won't find the server.")
        if st.get("mode", "lan") == "lan":
            warnings.append("This server was set up for your home network only. With its own domain friends can "
                            "reach it from anywhere: the server asks your router to open the ports it needs and "
                            "checks from outside at the end, as setup does.")
        return {"ok": True, "from": old, "to": own["domain"], "provider": own["provider"], "label": label,
                "people": max(0, (counts.get("users") or 1) - 1), "rooms": counts.get("rooms"),
                "events": counts.get("events"), "ip": ip, "points": points, "warnings": warnings, "proxy": proxy}

    def _blocked(self) -> str | None:
        if self.running:
            return "A move is running already."
        if self.doc.get("status") == "rolling-back":
            return ("The last move couldn't be put back completely yet; the server tries again at every start. Get "
                    "help on the Maintenance tab if this stays.")
        return None

    def start(self, answers: dict) -> str | None:
        """Start the move in the background; the reason it can't start, if one."""
        st = state.load_state()
        if st.get("phase") != "ready":
            return "This server isn't set up yet."
        own, problem = owndomain.validate(_answers(answers))
        if problem:
            return problem
        problem = _in_the_way(st, own, st.get("server_name", "")) or self._blocked()
        if problem:
            return problem
        self.doc = self._fresh(st.get("server_name", ""), own["domain"])
        self.doc.update(status="running", started=int(time.time()))
        self._save()
        self.task = asyncio.create_task(self._run(own))
        return None

    def resume(self) -> bool:
        """At start: a move the restart interrupted, or a rollback that didn't finish, goes on in the background (the
        dashboard answers meanwhile; bring_up leaves chat to it)."""
        if self.doc.get("status") not in ("running", "rolling-back"):
            return False
        self.task = asyncio.create_task(self._recover())
        return True

    # ---- the steps ------------------------------------------------------------------------------------------
    async def _run(self, own: dict) -> None:
        old, new = self.doc["from"], self.doc["to"]
        sid = ""
        try:
            sid = "check"
            self._step(sid, "running")
            rc, out = await self._rebuild(old, new, check=True)
            if rc != 0:
                raise MoveError(_last(out).get("error") or "The chat database couldn't be checked.", _tail(out))
            self._step(sid, "done", f"{new}: {owndomain.PROVIDERS[own['provider']]['label']}")

            sid = "certificate"
            self._step(sid, "running")
            self._step(sid, "done", await self._certificate(new, own))

            sid = "stop"  # before the copy: nothing anyone does during the move can be lost by a rollback
            self._step(sid, "running")
            rc, out = await compose.run("stop", "synapse", "lk-jwt", "livekit", timeout=300)
            if rc != 0:
                raise MoveError("Chat didn't pause.", _tail(out))
            self._step(sid, "done")

            sid = "export"
            self._step(sid, "running")
            work = await self._export(old)
            self._step(sid, "done", f"A copy of the chat database and the settings, kept on this server ({work.name}).")

            sid = "rebuild"
            self._step(sid, "running")
            (work / "rebuilding").write_text("1")  # from here on a restart in the middle puts the copy back
            rc, out = await self._rebuild(old, new, progress=lambda d: self._step("rebuild", "running", d))
            if rc in (2, 3):  # refused (3) or rolled back (2) by the rebuild itself: nothing in the database changed
                (work / "rebuilding").unlink()
            if rc != 0:
                raise MoveError(_last(out).get("error") or "The chat database couldn't be moved.", _tail(out))
            res = _last(out, "result")
            (work / "rebuilt").write_text(json.dumps(res))
            self._step(sid, "done", f"{res.get('events', 0)} messages and events moved, everyone signed out.")

            sid = "switch"
            self._step(sid, "running")
            await self._switch(old, new, own)
            (work / "switched").write_text("1")
            if self.on_switched:
                self.on_switched(old, new)
            self._step(sid, "done", await self._point(new, own))

            sid = "chat"  # before HTTPS: its check goes through the web server to chat, as people's apps do
            self._step(sid, "running")
            self._step(sid, "done", await self._chat(old, new))

            sid = "secure"
            self._step(sid, "running")
            self._step(sid, "done", await self._secure(new, own))

            await self._finish(old, new)
        except Exception as e:  # noqa: BLE001 — every failure ends on the dashboard, and puts the server back
            msg = str(e) if isinstance(e, MoveError) else "Something unexpected went wrong."
            details = e.details if isinstance(e, MoveError) else f"{type(e).__name__}: {e}"
            if not isinstance(e, MoveError):
                log.exception("move step %s crashed", sid)
            if sid and (self._steps_done(POINT_OF_NO_RETURN) or self._live()):
                # People could already use the new address (behind the owner's proxy it's live as soon as chat answers
                # on the proxy port): going back would throw away what they wrote. The move stays, with what to fix.
                log.error("move: %s failed after the new address went live: kept", sid)
                self._step(sid, "warn", f"{msg} The move stays (people could already use {new}; going back would lose "
                                        "what they wrote): Maintenance → Services → Restart, or Get help.")
                await self._finish_live(old, new, own)
                return
            self._step(sid, "failed", msg)
            self.doc.update(error=msg, details=_tail(details))
            await self._roll_back_and_record(old)

    def _live(self) -> bool:
        """Has the new address gone live (people could write there)? Kept on disk with this move's copy."""
        w = self._work()
        return w is not None and (w / "live").exists()

    def _mark_live(self) -> None:
        w = self._work()
        if w is not None:
            (w / "live").write_text("1")

    async def _finish_live(self, old: str, new: str, own: dict | None) -> None:
        """A move past its live mark that hit a problem (or a restart): the steps it didn't finish, best effort, never
        a rollback; then the names service and the outside check."""
        st = {s["id"]: s["status"] for s in self.doc["steps"]}
        if st.get("chat") != "done":  # what the chat step didn't finish (the server's own sign-in, General, calls)
            self._step("chat", "running")
            rc, out = await compose.up(*services())
            try:
                for _ in range(90):
                    if await self.synapse.healthy():
                        break
                    await asyncio.sleep(2)
                self._step("chat", "done", await self._chat_settle(old, new))
            except Exception as e:  # noqa: BLE001
                self._step("chat", "warn", f"{e} The move stays: Maintenance → Services → Restart, or Get help.")
        if st.get("secure") not in ("done", "warn"):
            self._step("secure", "running")
            try:
                self._step("secure", "done", await self._secure(new, own or {"provider": "proxy"}))
            except Exception as e:  # noqa: BLE001
                self._step("secure", "warn", f"{e} The move stays: Maintenance → Services → Restart, or Get help.")
        await self._finish(old, new)

    async def _finish(self, old: str, new: str) -> None:
        """After chat and HTTPS run under the new name: the names service, the outside check, done. Never undoes."""
        self._step("tell", "running")
        self._step("tell", "done", await self._tell(old, new))
        self._step("outside", "running")
        level, line = await self._outside()
        self._step("outside", level, line)
        work = self._work()
        if work is not None:
            try:
                (work / "done").write_text("1")
            except OSError:
                pass
        self.doc.update(status="done", finished=int(time.time()))
        self._save()
        log.info("moved %s → %s", old, new)

    async def _rebuild(self, old: str, new: str, check: bool = False, progress=None) -> tuple[int, str]:
        """move_synapse.py in a one-off container of this server's Synapse image, on the database's network."""
        image = await _inspect("tinhat-synapse-1", "{{.Config.Image}}")
        net = await _inspect("tinhat-postgres-1", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}")
        if not image or not net:
            return 2, json.dumps({"error": "The chat server's containers aren't there."})
        await _remove_container()  # one left over from a restart in the middle
        cmd = ["docker", "run", "--rm", "--name", CONTAINER, "--network", net.split()[0],
               "-v", f"{config.SYNAPSE_DIR}:/data",
               "-v", f"{SCRIPT}:/move_synapse.py:ro", "--entrypoint", "python", image, "/move_synapse.py", old, new]
        if check:
            cmd.append("--check")
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        lines = []
        assert proc.stdout is not None
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), REBUILD_SILENCE)
            except asyncio.TimeoutError:
                await _remove_container()
                lines.append(json.dumps({"error": "The rebuild stopped answering (hours without progress). Nothing "
                                                  "was changed."}))
                await proc.wait()
                return 2, "\n".join(lines)
            if not raw:
                break
            line = raw.decode(errors="replace").rstrip()
            lines.append(line)
            if progress:
                try:
                    p = json.loads(line)
                except ValueError:
                    continue
                if p.get("phase") == "events" and p.get("total"):
                    progress(f"Messages and events: {p['done']} of {p['total']}")
                elif p.get("phase") == "tables" and p.get("total"):
                    progress(f"Everything else: {round(100 * p['done'] / p['total'])} %")
                elif p.get("phase") == "verify" and p.get("total"):
                    progress(f"Checking: {p['done']} of {p['total']}")
        rc = await proc.wait()
        return rc, "\n".join(lines)

    async def _certificate(self, new: str, own: dict) -> str:
        """The new address's certificate before anything changes (behind the owner's reverse proxy: the check that the
        new address leads here, _proxy_check). It comes by DNS-01 through the owner's provider, so
        the domain needn't point here yet, and a token that can't edit the domain shows here, when nothing has moved.
        The web server gets a temporary site for the new name that only says "moving here"; the certificate stays in
        its store for the real site after the switch."""
        from . import install
        if own["provider"] == "proxy":
            return await self._proxy_check(new)
        label = owndomain.PROVIDERS[own["provider"]]["label"]
        e = environment.env()
        site = templates.caddy_preflight(new, owndomain.caddy_tls(own["provider"], own["creds"]), e["acme_directory"],
                                         environment.has_extra_roots())
        bundle = environment.write_bundle()
        if bundle:  # the lab: the web server trusts the lab's roots when it talks to the DNS provider's API
            st, s = state.load_state(), state.load_secrets()
            state.write_text(config.COMPOSE_ENV, templates.compose_env(st["server_name"], s, lan=st.get("mode") == "lan",
                                                                       bundle=True), 0o600)
        current = config.CADDYFILE.read_text() if config.CADDYFILE.exists() else ""
        nxt = config.CADDYFILE.with_name("Caddyfile.new")
        state.write_text(nxt, current + site, 0o600)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
        if rc != 0:
            raise MoveError("The web server's settings for the new address were rejected.", _tail(out))
        os.replace(nxt, config.CADDYFILE)
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise MoveError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:
            raise MoveError("The web server didn't take its new settings.", _tail(out))
        try:
            await install._wait_cert(new, provider=label)
        except install.InstallError as ex:
            raise MoveError(str(ex), ex.details)
        return f"A certificate for {new} is ready (through {label})."

    async def _proxy_check(self, new: str) -> str:
        """Behind the owner's reverse proxy the proxy holds the new address's certificate, so before anything changes
        the move asks https://NEW for a one-off token, the way people's apps will come (DNS, the proxy, its certificate,
        then this server's proxy port), and goes on only when it gets this server's answer."""
        import aiohttp
        port = owndomain.PROXY_PORT
        current = config.CADDYFILE.read_text() if config.CADDYFILE.exists() else ""
        if f"http://:{port} {{" not in current:  # not behind a proxy yet: the proxy's port, for this check only
            nxt = config.CADDYFILE.with_name("Caddyfile.new")
            state.write_text(nxt, current + templates.caddy_proxy_preflight(port, hw.addresses()), 0o644)
            await self._load_caddyfile(nxt)
        elif "/_tinhat/move-check" not in current:  # a Caddyfile from before this check existed: today's settings
            from . import install
            install.refresh_configs(force=True)
            await self._load_caddyfile(None)
        # The token is a file the web server serves itself, on the proxy port only: a proxy sent to another port of
        # this server (80, 443) doesn't pass, and the manager never hands it out.
        tdir = config.WELLKNOWN_DIR / "move-check"
        if not templates.is_hostname(new):
            raise MoveError("That isn't an address this server can check.")
        tfile = tdir / new  # served only for requests to NEW itself (the web server looks it up by the request's name)
        token = secrets.token_urlsafe(24)
        tdir.mkdir(parents=True, exist_ok=True)
        os.chmod(tdir, 0o755)
        state.write_text(tfile, token, 0o644)
        last = ""
        try:
            for _ in range(10):
                try:
                    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10),
                                                     auto_decompress=False) as s:
                        # a new address each time: a cache in between can't answer with an earlier "not found"
                        url = f"https://{new}/_tinhat/move-check?n={secrets.token_urlsafe(9)}"
                        async with s.get(url, ssl=environment.ssl_context(), allow_redirects=False,
                                         headers={"Cache-Control": "no-cache"}) as r:
                            body = (await r.content.read(512)).decode(errors="replace").strip()  # never more
                            if r.status == 200 and body == token:
                                return f"Your reverse proxy sends {new} here."
                            last = f"HTTP {r.status}" + (": another server answered" if r.status == 200 else "")
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                    last = _why(e, new)
                await asyncio.sleep(3)
        finally:
            try:
                tfile.unlink()
            except OSError:
                pass
        lan = (hw.addresses() or ["this server's address"])[0]
        raise MoveError(f"https://{new} doesn't lead to this server yet ({last}). Set your reverse proxy to send "
                        f"https://{new} to http://{lan}:{port} (with a certificate for {new}), then try again. "
                        "Nothing changed.")

    async def _load_caddyfile(self, nxt: Path | None) -> None:
        """The web server on a new Caddyfile (nxt: checked first, then put in place; None: the one in place)."""
        if nxt is not None:
            rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
            if rc != 0:
                raise MoveError("The web server's settings for your reverse proxy were rejected.", _tail(out))
            os.replace(nxt, config.CADDYFILE)
        else:
            rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile")
            if rc != 0:
                raise MoveError("The web server's settings were rejected.", _tail(out))
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise MoveError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:
            raise MoveError("The web server didn't take its new settings.", _tail(out))

    def _work(self) -> Path | None:
        """This move's own copy (never another move's): the folder its export made, if it's this move's."""
        w = self.doc.get("work")
        if not w:
            return None
        p = Path(w)
        try:
            ok = p.is_dir() and p.parent == DIR and (p / "from").read_text() == (self.doc.get("from") or "")
        except OSError:
            ok = False
        return p if ok else None

    async def _export(self, old: str) -> Path:
        _prune()
        size = await _db_size()
        need = 4 * size + (2 << 30)  # the copy, the rebuild's new row versions (2-3x the database), a margin
        free = shutil.disk_usage(config.STATE_DIR).free
        if free < need:
            raise MoveError(f"Not enough free disk space for the move: it needs about {_gb(need)} GB free (a copy of "
                            f"the chat database and room to rebuild it), and {_gb(free)} GB are. Free some space, then "
                            "try again.")
        work = DIR / time.strftime("%Y%m%d-%H%M%S")
        work.mkdir(parents=True, mode=0o700)
        (work / "from").write_text(old)
        self.doc["work"] = str(work)
        self._save()
        dump = work / "db.dump"
        with open(dump, "wb") as f:
            os.chmod(dump, 0o600)
            proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_dump", "-U",
                                                        "synapse", "-Fc", "synapse", stdout=f,
                                                        stderr=asyncio.subprocess.PIPE)
            _, err = await asyncio.wait_for(proc.communicate(), 3 * 3600)
        if proc.returncode != 0:
            raise MoveError("The copy of the chat database couldn't be made.", err.decode(errors="replace"))
        rc, out = await _pg_restore_list(dump)
        if rc != 0:
            raise MoveError("The copy of the chat database couldn't be read back.", _tail(out))
        free = shutil.disk_usage(config.STATE_DIR).free
        if free < 3 * size + (1 << 30):
            raise MoveError(f"After the copy there isn't room left to rebuild the chat database (about "
                            f"{_gb(3 * size + (1 << 30))} GB needed, {_gb(free)} GB free).")
        for src in (config.STATE_FILE, config.SECRETS_FILE, config.CADDYFILE, config.SYNAPSE_DIR / "homeserver.yaml"):
            if src.exists():
                shutil.copy2(src, work / src.name)
                os.chmod(work / src.name, 0o600)
        return work

    async def _switch(self, old: str, new: str, own: dict) -> None:
        """The box's own settings under the new name; then every config written again from them, the web server's
        checked before anything can load it."""
        from . import install
        st = state.load_state()
        s = state.load_secrets()
        if st.get("mode") == "domain":  # an own domain before: its DNS settings stay, for its certificate
            former = dict(s.get("former_domains") or {})
            former[old] = s.get("domain") or {}
            state.save_secrets(former_domains=former)
        state.save_secrets(domain={"provider": own["provider"], "creds": own["creds"]})
        nxt = new_server_name(old, new, st)
        nxt["domain"] = {"provider": own["provider"]}
        state.save_state(**{k: nxt[k] for k in ("former_names", "server_name", "mode", "admin", "domain")
                            if k in nxt}, former_told=None)
        install._hosts_entry(new, _short_name())  # 127.0.1.1: the new name (lk-jwt checks sign-ins through it)
        install.refresh_configs(force=True)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile")
        if rc != 0:
            raise MoveError("The web server's settings for the new address were rejected.", _tail(out))

    async def _point(self, new: str, own: dict) -> str:
        """The domain pointed at the home where the provider's API can; the call server told the home's address."""
        from . import install
        label = owndomain.PROVIDERS[own["provider"]]["label"]
        ip = await owndomain.public_ip()
        if own["provider"] == "proxy":  # the domain leads to the owner's proxy (checked before the move)
            if ip:
                state.save_state(livekit_public_ip=ip)
                install.refresh_configs(force=True)  # livekit.yaml: calls announce the home's address from the start
            return f"Your reverse proxy sends {new} here (checked before the move)."
        if not ip:
            return "Couldn't find your home's public address; the dashboard keeps trying."
        try:
            pointed = await owndomain.set_address(new, ip)
        except owndomain.DNSAPIError as e:
            raise MoveError(f"{label} didn't accept the change ({e}). Check the API token and that it can edit this "
                            f"domain's DNS.")
        state.save_state(livekit_public_ip=ip, **({"domain_status": {"ip4": ip, "updated": True, "error": None}}
                                                 if pointed else {}))
        install.refresh_configs(force=True)  # livekit.yaml: calls announce the home's address from the start
        return f"{new} now points to your home ({ip}) through {label}." if pointed else f"{new} should point to your home ({ip})."

    async def _secure(self, new: str, own: dict) -> str:
        from . import install
        if own["provider"] == "proxy":
            return await self._secure_proxy(new)
        rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile")
        if rc != 0:
            raise MoveError("The web server's new settings were rejected.", _tail(out))
        rc, out = await compose.up("caddy")
        if rc != 0:
            raise MoveError("The web server didn't start.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:
            raise MoveError("The web server didn't take its new settings.", _tail(out))
        try:
            return await install._wait_https(new, provider=owndomain.PROVIDERS[own["provider"]]["label"])
        except install.InstallError as e:
            raise MoveError(str(e), e.details)

    async def _secure_proxy(self, new: str) -> str:
        """Behind the owner's reverse proxy: the box's own certificate on its loopback addresses (its services check
        sign-ins through https://NEW), then the call sign-in restarted to trust it. The proxy itself was checked before
        the move (the token through https://NEW); from here on this server's own /etc/hosts sends NEW to its loopback,
        so what's checked now is the other half: chat behind the proxy port and on the box's own HTTPS."""
        from . import install
        self._mark_live()  # the web server takes the new settings next: from then on people can sign in at NEW
        try:
            await install.secure_proxy(new, write=False)
        except install.InstallError as e:
            raise MoveError(str(e), e.details)
        rc, out = await compose.up(*services())  # the call sign-in's new settings (the box's own certificate root)
        if rc != 0:
            raise MoveError("The call service didn't start again.", _tail(out))
        return f"Chat answers {new} on this server's proxy port; your reverse proxy sends {new} here."

    async def _chat(self, old: str, new: str) -> str:
        if state.behind_proxy():
            # Behind the owner's proxy the new address is open the moment chat answers on the proxy port (the web server
            # took its new settings at the switch): from here on nothing rolls back, written down before chat starts.
            self._mark_live()
        rc, out = await compose.up(*services())
        if rc != 0:
            raise MoveError("Chat didn't start again.", _tail(out))
        for _ in range(90):
            if await self.synapse.healthy():
                break
            await asyncio.sleep(2)
        else:
            raise MoveError("Chat didn't come back up under the new name.", await compose.logs("synapse", 60))
        return await self._chat_settle(old, new)

    async def _chat_settle(self, old: str, new: str) -> str:
        """Chat answers under the new name: the server's own account signs in again, General's topic, calls from before
        the move ended. (Again on its own when a live move's chat step didn't get this far.)"""
        import aiohttp
        s = state.load_secrets()  # everyone was signed out, the system account too: its own sign-in again
        for attempt in range(5):  # a chat server that just started may drop the first connections
            try:
                st, body = await self.synapse.login(config.SYSTEM_LOCALPART, s["system_password"],
                                                    "Tin Hat Server (system)")
                break
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                if attempt == 4:
                    raise MoveError("The server's own account couldn't reach chat under the new name.", str(e))
                await asyncio.sleep(3)
        if st != 200 or "access_token" not in body:
            raise MoveError("The server's own account couldn't sign in under the new name.", json.dumps(body)[:500])
        if body.get("user_id") != f"@{config.SYSTEM_LOCALPART}:{new}":
            raise MoveError("The chat server answered with the wrong name.", body.get("user_id", ""))
        state.save_secrets(system_token=body["access_token"])
        await self._general_topic(old, new, body["access_token"])
        ended = await self._end_calls(body["access_token"])
        return "Chat is up under the new name." + (f" {ended} call membership(s) from before the move ended." if ended else "")

    async def _general_topic(self, old: str, new: str, token: str) -> None:
        """General's topic said "Welcome to OLD!": now the new name (best effort). General is the owner's room (setup
        made it as the owner), so the change is made as the owner through Synapse's admin login, which makes no new
        device (as repairs.general_calls does)."""
        try:
            code, res = await self.synapse.req("GET", f"/_matrix/client/v3/directory/room/{_q('#general:' + new)}")
            if code != 200:
                return
            room = res["room_id"]
            code, res = await self.synapse.req("GET", f"/_synapse/admin/v1/rooms/{_q(room)}/state", token)
            topic = next((e for e in res.get("state", []) if e.get("type") == "m.room.topic"), None) if code == 200 else None
            if not topic or (topic.get("content") or {}).get("topic") != f"Welcome to {old}!":
                return
            owner = state.load_state().get("admin") or ""
            code, res = await self.synapse.req("POST", f"/_synapse/admin/v1/users/{_q(owner)}/login", token,
                                               json={"valid_until_ms": int(time.time() * 1000) + 120_000})
            if code != 200:
                return
            as_owner = res["access_token"]
            text = f"Welcome to {new}!"
            try:
                await self.synapse.req("PUT", f"/_matrix/client/v3/rooms/{_q(room)}/state/m.room.topic", as_owner,
                                       json={"topic": text, "m.topic": {"m.text": [{"body": text}]}})
            finally:
                await self.synapse.logout(as_owner)
        except Exception as e:  # noqa: BLE001
            log.warning("General's topic: %s", e)

    async def _rooms(self, token: str) -> list[str]:
        """Every room on the server (Synapse's admin API, page by page)."""
        out: list[str] = []
        start = 0
        for _ in range(1000):
            code, res = await self.synapse.req("GET", f"/_synapse/admin/v1/rooms?limit=500&from={start}", token)
            if code != 200:
                break
            out += [r["room_id"] for r in res.get("rooms", [])]
            nxt = res.get("next_batch")
            if nxt is None or not res.get("rooms"):
                break
            start = int(nxt)
        return out

    async def _end_calls(self, token: str) -> int:
        """Calls going on when the move started: their members' devices were signed out, but their call memberships
        (state naming those devices) would keep each call "going" for hours, and joining clients follow the oldest
        membership's call service, at the old address. Each one is ended as its member's app ends it on hanging up
        (empty content), through Synapse's admin login (no new device). Best effort; returns how many."""
        logins: dict[str, str | None] = {}
        ended = 0
        try:
            for room in await self._rooms(token):
                code, st = await self.synapse.req("GET", f"/_synapse/admin/v1/rooms/{_q(room)}/state", token)
                for ev in st.get("state", []) if code == 200 else []:
                    if ev.get("type") not in CALL_MEMBER_TYPES or not ev.get("content"):
                        continue
                    who = ev.get("sender") or ""
                    if who not in logins:
                        c, r = await self.synapse.req("POST", f"/_synapse/admin/v1/users/{_q(who)}/login", token,
                                                      json={"valid_until_ms": int(time.time() * 1000) + 120_000})
                        logins[who] = r.get("access_token") if c == 200 else None
                    if not logins[who]:
                        continue
                    c, _ = await self.synapse.req(
                        "PUT", f"/_matrix/client/v3/rooms/{_q(room)}/state/{_q(ev['type'])}/{_q(ev.get('state_key', ''))}",
                        logins[who], json={})
                    ended += c == 200
        except Exception as e:  # noqa: BLE001 — a call that stays "going" expires by itself
            log.warning("ending calls from before the move: %s", e)
        finally:
            for t in logins.values():
                if t:
                    await self.synapse.logout(t)
        return ended

    async def _tell(self, old: str, new: str) -> str:
        # Behind the owner's reverse proxy the old name has no site here (only its media, under the new name): it leads
        # here only if the proxy sends it here too.
        proxied = state.behind_proxy()
        if not old.endswith("." + environment.env()["zone"]) or not names.creds():
            if proxied:
                return (f"{old} leads here only while your reverse proxy sends it here; pictures and files from "
                        f"before the move still open. Everyone signs in at {new}.")
            return f"{old} answers here while it lasts: apps that use it reach this server and learn the new address."
        try:
            await names.tell_moved(new)
        except names.NamesError as e:
            return f"The names service didn't answer ({e}); {old} still points here, and the dashboard tells it later."
        state.save_state(former_told=new)
        if proxied:
            return f"The names service knows where the server went; {old} leads here only if your reverse proxy sends it here too."
        return f"{old} still points here and says where the server went; the names service knows too."

    async def _outside(self) -> tuple[str, str]:
        """Open the router's ports and check from outside, as setup does. Never undoes the move: it says what to fix
        (the dashboard's Network tab keeps checking)."""
        if self.checker is None:
            return "done", "The dashboard's Network tab checks from outside."
        from . import reach
        try:
            calls = state.load_state().get("calls", True)
            await self.checker.open_ports(calls)
            out = await self.checker.outside(calls)
            st = state.load_state()
            sm = reach.summary(st.get("ports"), out, owndomain.proxy_info(st))
            return ("done" if sm["level"] == "good" else "warn"), sm["headline"]
        except Exception as e:  # noqa: BLE001 — the move is done; the Network tab checks again
            log.warning("outside check after the move: %s", e)
            return "warn", "The check from outside didn't run; the dashboard's Network tab checks again."

    async def _roll_back_and_record(self, old: str) -> None:
        """Put the server back; the move's status says how it went. A rollback that couldn't finish stays
        "rolling-back": the next start tries again, and until then chat stays off and no move starts."""
        self.doc["status"] = "rolling-back"
        self._save()
        try:
            back = await self._roll_back(self._work(), old)
        except Exception as e:  # noqa: BLE001
            log.exception("move rollback failed")
            self.doc.update(details=(self.doc.get("details") or "") + "\n" +
                            f"Putting the server back hasn't worked yet ({type(e).__name__}: {e}). The server tries "
                            "again at every start; the copy from before the move is kept. Get help on the Maintenance "
                            "tab if this stays.")
            self._save()
            return
        self.doc.update(status="failed", finished=int(time.time()),
                        details=((self.doc.get("details") or "") + ("\n" + back if back else "")).strip())
        self._save()

    async def _roll_back(self, work: Path | None, old: str) -> str:
        """Put everything back as it was before the move (raises when it can't). Returns a line for the details."""
        from . import install
        rebuilt = work is not None and ((work / "rebuilt").exists() or (work / "rebuilding").exists())
        switched = work is not None and (work / "switched").exists()
        if rebuilt and not (work / "restored").exists():
            await _remove_container()
            await compose.run("stop", "synapse", "lk-jwt", "livekit", timeout=300)
            await _restore_db(work / "db.dump")
            (work / "restored").write_text("1")  # done once: a retry (say, the web server didn't reload) never repeats it
        if switched or rebuilt:
            for name, dst in (("state.json", config.STATE_FILE), ("secrets.json", config.SECRETS_FILE)):
                if (work / name).exists():
                    shutil.copy2(work / name, dst)
            install._hosts_entry(old, _short_name())
            if switched and self.on_switched:
                self.on_switched(self.doc.get("to") or "", old)
        # Every config from the (restored) state: also the certificate step's temporary site and compose.env.
        install.refresh_configs(force=True)
        rc, out = await compose.up(*services())
        if rc != 0:
            raise MoveError("The server's parts didn't start again.", _tail(out))
        rc, out = await compose.caddy_reload(force=True)
        if rc != 0:  # stays "rolling-back": tried again at the next start
            raise MoveError("The web server didn't take the restored settings.", _tail(out))
        if switched and old.endswith("." + environment.env()["zone"]) and names.creds():
            try:  # it may have been told already: the name's page sends visitors here again
                await names.tell_moved(None)
            except names.NamesError as e:
                log.warning("names service: %s", e)
        if work is not None:
            (work / "rolled-back").write_text("1")
        return f"Nothing changed: the server is back as {old}." if (rebuilt or switched) else ""

    # ---- after a restart in the middle of a move ------------------------------------------------------------
    async def _recover(self) -> None:
        old, new = self.doc.get("from") or "", self.doc.get("to") or ""
        if self.doc.get("status") == "running" and (self._steps_done(POINT_OF_NO_RETURN) or self._live()):
            # Chat already ran under the new name where people could use it: the move stays and finishes.
            log.warning("the server restarted after the move had gone through: finishing it")
            await compose.up(*services())
            for sid in ("tell", "outside"):
                if next(s["status"] for s in self.doc["steps"] if s["id"] == sid) == "running":
                    self._step(sid, "pending")
            for sid in ("chat", "secure"):
                if next(s["status"] for s in self.doc["steps"] if s["id"] == sid) == "running":
                    self._step(sid, "pending")
            await self._finish_live(old, new, None)
            return
        if self.doc.get("status") == "running":
            log.warning("the server restarted during a move: putting it back")
            running = next((s["id"] for s in self.doc["steps"] if s["status"] == "running"), "check")
            self._step(running, "failed", "The server restarted in the middle of the move.")
            self.doc.update(error="The server restarted in the middle of the move.")
        else:
            log.warning("a move's rollback didn't finish before: trying again")
        await _wait_postgres()
        await self._roll_back_and_record(old)


def _answers(answers: dict) -> dict:
    """The owner's answers, the way owndomain.validate takes them (anything that isn't an object is no answer)."""
    d = answers.get("domain") if isinstance(answers, dict) else None
    return {"name": str(answers.get("name", "") if isinstance(answers, dict) else ""),
            "domain": d if isinstance(d, dict) else {}}


def _in_the_way(st: dict, own: dict, old: str) -> str | None:
    """Why this server can't move to `own` now, if something is in the way (pure apart from the relay's state)."""
    if own["domain"] == old:
        return "That's this server's name already."
    if moved.is_moved(st):
        return "This server moved to another computer, so it can't move to a new address."
    if config.proxy_only() and own["provider"] != "proxy":
        return ("This server shares its machine with another web server (it has ports 80 and 443), so it stays behind "
                "your reverse proxy: choose My own reverse proxy.")
    if relay.on():
        return ("This server is reached through the Tin Hat relay, which carries tinhat.me names only. Your own domain "
                "needs your router to let friends reach this server directly (ports 443, 7881 and 7882). The "
                "dashboard's Network tab shows what your router allows.")
    if st.get("federation"):
        return ("This server talks to other servers (Network: Other Tin Hat servers, Other Matrix servers). Rooms from "
                "before a move can't be shared with them afterwards and those links would stop working: disconnect or "
                "remove them first, then move, then connect again.")
    return None


async def _chat_on_proxy_port(new: str) -> bool:
    """Does chat answer for NEW on the proxy port (what the owner's proxy sends people to)?"""
    import aiohttp
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.get(f"http://127.0.0.1:{owndomain.PROXY_PORT}/_matrix/client/versions",
                             headers={"Host": new}) as r:
                return r.status == 200
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
        return False


def _why(e: BaseException, host: str) -> str:
    """Why https://host didn't answer, in words (not the HTTP library's object dump)."""
    import socket
    import aiohttp
    if isinstance(e, aiohttp.ClientConnectorCertificateError):
        return f"its certificate isn't valid: {e.certificate_error}"
    if isinstance(e, aiohttp.ClientConnectorError):
        os_err = getattr(e, "os_error", None)
        if isinstance(os_err, socket.gaierror):
            return f"{host} isn't in DNS yet"
        return f"nothing answers at {host}:443" + (f" ({os_err.strerror})" if getattr(os_err, "strerror", None) else "")
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return "no answer within 10 seconds"
    if isinstance(e, aiohttp.ServerDisconnectedError):
        return "the connection was closed without an answer"
    return str(e) or type(e).__name__


def _q(s: str) -> str:
    return quote(s, safe="")


def _gb(n: int) -> int:
    return max(1, round(n / (1 << 30)))


async def _remove_container() -> None:
    proc = await asyncio.create_subprocess_exec("docker", "rm", "-f", CONTAINER, stdout=asyncio.subprocess.DEVNULL,
                                                stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()


def _last(out: str, key: str | None = None) -> dict:
    """The last JSON line of the rebuild's output (with `key`, that key of the last line that has it)."""
    for line in reversed((out or "").splitlines()):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if key is None:
            return d if isinstance(d, dict) else {}
        if isinstance(d, dict) and key in d:
            return d[key] if isinstance(d[key], dict) else {}
    return {}


async def _inspect(container: str, fmt: str) -> str:
    proc = await asyncio.create_subprocess_exec("docker", "inspect", "-f", fmt, container,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    out, _ = await proc.communicate()
    return out.decode().strip() if proc.returncode == 0 else ""


def _prune(keep: int = 1) -> None:
    """Earlier moves' copies: the newest stays (an extra copy from before the last move), older ones go."""
    if not DIR.exists():
        return
    for p in sorted(DIR.glob("2*"))[:-keep] if keep else sorted(DIR.glob("2*")):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            log.info("removed an earlier move's copy: %s", p.name)


def _short_name() -> str:
    try:
        return Path("/etc/hostname").read_text().strip() or "tinhat"
    except OSError:
        return "tinhat"


async def _db_size() -> int:
    rc, out = await compose.run("exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "synapse", "-tAc",
                                "SELECT pg_database_size('synapse')", timeout=60)
    try:
        return int(out.strip().splitlines()[-1]) if rc == 0 else _du(config.POSTGRES_DIR)
    except (ValueError, IndexError):
        return _du(config.POSTGRES_DIR)


def _du(path: Path) -> int:
    total = 0
    for p in path.rglob("*") if path.exists() else []:
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


async def _wait_postgres(seconds: int = 180) -> None:
    """After a power cut the database may still be recovering for a while: wait until it takes connections."""
    for _ in range(seconds // 2):
        rc, _ = await compose.run("exec", "-T", "postgres", "pg_isready", "-U", "synapse", timeout=20)
        if rc == 0:
            return
        await compose.up("postgres")
        await asyncio.sleep(2)


async def _pg_restore_list(dump: Path) -> tuple[int, str]:
    """Is the copy readable as a whole? (pg_restore --list reads its table of contents.)"""
    with open(dump, "rb") as f:
        proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_restore", "--list",
                                                    stdin=f, stdout=asyncio.subprocess.DEVNULL,
                                                    stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), 600)
    return proc.returncode, err.decode(errors="replace")


async def _restore_db(dump: Path) -> None:
    """The chat database as the copy has it. The copy is checked first (a damaged copy never replaces the database),
    then restored in one transaction (all of it, or the empty database and a retry at the next start)."""
    await _wait_postgres()
    rc, out = await _pg_restore_list(dump)
    if rc != 0:
        raise MoveError("The copy from before the move can't be read, so the chat database was left as it is.", _tail(out))
    psql = ("exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", "postgres", "-c")
    for sql in ("DROP DATABASE IF EXISTS synapse WITH (FORCE)",
                "CREATE DATABASE synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"):
        rc, out = await compose.run(*psql, sql, timeout=300)
        if rc != 0:
            raise MoveError("The chat database couldn't be put back.", _tail(out))
    with open(dump, "rb") as f:
        proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_restore", "-U",
                                                    "synapse", "-d", "synapse", "--no-owner", "--single-transaction",
                                                    "--exit-on-error", stdin=f, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        out, _ = await asyncio.wait_for(proc.communicate(), 6 * 3600)
    if proc.returncode != 0:
        raise MoveError("The chat database couldn't be put back.", _tail(out.decode(errors="replace")))

"""Move to your own domain, the box's side (move.py, templates.py, sessions.py): the state after the switch, what
stops a move before it starts, and what the old name keeps doing here (its media, its .well-known saying where the
server went, its own site that sends browsers on).

Runs anywhere: the modules move.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
FLAGS = {"proxy_only": False, "relay": False, "moved": False}
STATUS_DOC = {}
COMPOSE = []


def _load(name: str, stubs: dict):
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        for k, v in stubs.items():
            sys.modules[f"tinhat.{k}"] = v
        spec = importlib.util.spec_from_file_location(f"tinhat.{name}", PKG / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"tinhat.{name}"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


def _mod(name, **attrs):
    m = types.ModuleType(f"tinhat.{name}")
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


async def _compose_up(*services):
    COMPOSE.append(("up",) + services)
    return 0, ""


TMP = tempfile.TemporaryDirectory()
config = _mod("config", STATE_DIR=pathlib.Path(TMP.name), proxy_only=lambda: FLAGS["proxy_only"])
state = _mod("state", load_state=lambda: {}, read_json=lambda p, d=None: STATUS_DOC.get(str(p), d),
             write_json=lambda *a, **k: None, save_state=lambda **kw: None, behind_proxy=lambda st=None: False)
move = _load("move", {"config": config, "state": state, "compose": _mod("compose", up=_compose_up),
                      "environment": _mod("environment", env=lambda: {"zone": "tinhat.me"}),
                      "names": _mod("names", creds=lambda: None), "owndomain": _mod("owndomain"),
                      "relay": _mod("relay", on=lambda: FLAGS["relay"]),
                      "moved": _mod("moved", is_moved=lambda st=None: FLAGS["moved"]), "templates": _mod("templates"),
                      "hw": _mod("hw", addresses=lambda: ["192.168.1.30"])})
templates = _load("templates", {"config": _mod("config"), "environment": _mod("environment"), "state": _mod("state"),
                                "hw": _mod("hw", addresses=lambda: ["192.168.1.30"])})
sessions = _load("sessions", {"config": config, "state": _mod("state", read_json=lambda p, d=None: d,
                                                               write_json=lambda *a, **k: None)})
ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


class TheSwitch(unittest.TestCase):
    def test_the_new_name_and_the_old_one_kept(self):
        st = {"server_name": "maplehouse.tinhat.me", "mode": "anywhere", "admin": "@alex:maplehouse.tinhat.me",
              "calls": True}
        out = move.new_server_name("maplehouse.tinhat.me", "chat.example.com", st)
        self.assertEqual((out["server_name"], out["mode"], out["admin"]),
                         ("chat.example.com", "domain", "@alex:chat.example.com"))
        self.assertEqual([(f["name"], f["mode"]) for f in out["former_names"]], [("maplehouse.tinhat.me", "anywhere")])
        self.assertEqual(st["server_name"], "maplehouse.tinhat.me")  # the old state isn't changed in place
        self.assertTrue(out["calls"])

    def test_moving_again_keeps_every_old_name_once(self):
        st = move.new_server_name("home.local", "chat.example.com", {"server_name": "home.local", "mode": "lan"})
        st = move.new_server_name("chat.example.com", "chat.example.org", st)
        self.assertEqual([(f["name"], f["mode"]) for f in st["former_names"]],
                         [("home.local", "lan"), ("chat.example.com", "domain")])
        # back to a name it had before: that one isn't a former name any more
        st = move.new_server_name("chat.example.org", "chat.example.com", st)
        self.assertEqual([f["name"] for f in st["former_names"]], ["home.local", "chat.example.org"])

    def test_letting_go_of_an_old_name_keeps_its_entry(self):
        st = {"former_names": [{"name": "home.local", "mode": "lan", "at": 1}, {"name": "maple.tinhat.me", "mode": "anywhere", "at": 2}]}
        self.assertEqual(move.can_let_go(st, "maple.tinhat.me")["mode"], "anywhere")
        self.assertIsNone(move.can_let_go(st, "chat.example.com"))  # never one of its names
        half = {"former_names": move.marked(st, "maple.tinhat.me", released=99, pending=True)}
        self.assertEqual(move.can_let_go(half, "maple.tinhat.me")["released"], 99)  # a let-go that stopped half-way: again
        self.assertEqual([f["name"] for f in move.held_former_names(half)], ["home.local"])
        done = {"former_names": move.marked(half, "maple.tinhat.me", pending=None)}
        self.assertEqual(done["former_names"][1], {"name": "maple.tinhat.me", "mode": "anywhere", "at": 2, "released": 99})
        self.assertIsNone(move.can_let_go(done, "maple.tinhat.me"))  # once only
        self.assertEqual(len(move.former_names(done)), 2)  # still a former name: its media keeps opening here
        self.assertNotIn("released", st["former_names"][1])  # the old state isn't changed in place

    def test_an_admin_on_another_name_stays(self):
        out = move.new_server_name("a.local", "chat.example.com", {"admin": "@alex:a.local.evil.example"})
        self.assertEqual(out["admin"], "@alex:a.local.evil.example")


class InTheWay(unittest.TestCase):
    def tearDown(self):
        FLAGS.update(proxy_only=False, relay=False, moved=False)

    def test_reasons(self):
        own = {"domain": "chat.example.com", "provider": "cloudflare"}
        self.assertIsNone(move._in_the_way({}, own, "home.local"))
        self.assertIn("already", move._in_the_way({}, own, "chat.example.com"))
        # behind the owner's reverse proxy: fine (the move checks the proxy before anything changes)
        self.assertIsNone(move._in_the_way({}, {**own, "provider": "proxy"}, "home.local"))
        # a machine shared with another web server stays behind that one: only "My own reverse proxy" there
        FLAGS["proxy_only"] = True
        self.assertIn("My own reverse proxy", move._in_the_way({}, own, "home.local"))
        self.assertIsNone(move._in_the_way({}, {**own, "provider": "proxy"}, "chat.example.org"))
        FLAGS.update(proxy_only=False, relay=True)
        self.assertIn("relay", move._in_the_way({}, own, "maplehouse.tinhat.me"))
        # moving back to a name it had before is still a move: the relay is still in the way
        self.assertIn("relay", move._in_the_way({"former_names": [{"name": "chat.example.com"}]}, own, "x.tinhat.me"))
        FLAGS["relay"] = False
        self.assertIn("other servers", move._in_the_way({"federation": ["friends.example.org"]}, own, "home.local"))
        FLAGS["moved"] = True
        self.assertIn("another computer", move._in_the_way({}, own, "home.local"))

    def test_answers_that_arent_objects(self):
        self.assertEqual(move._answers({"name": "chat.example.com", "domain": "cloudflare"}),
                         {"name": "chat.example.com", "domain": {}})
        self.assertEqual(move._answers({"domain": {"provider": "desec"}}), {"name": "", "domain": {"provider": "desec"}})


class RebuildOutput(unittest.TestCase):
    def test_the_last_line_with_a_key(self):
        out = "\n".join(['{"phase": "events", "done": 5, "total": 9}', "Traceback: not json",
                         '{"result": {"events": 9, "users": 3}}', '{"phase": "done"}'])
        self.assertEqual(move._last(out, "result"), {"events": 9, "users": 3})
        self.assertEqual(move._last(out), {"phase": "done"})
        self.assertEqual(move._last("", "result"), {})


class FormerNames(unittest.TestCase):
    def setUp(self):
        self.base = templates.caddy_anywhere("chat.example.com", ACME, DIRECTORY, False)

    def test_media_of_the_old_name_comes_from_here(self):
        out = templates.with_former_names(self.base, "chat.example.com", [("home.local", "internal")])
        rule = "^/_matrix/(client/v1/media|media/v3|media/r0)/(download|thumbnail)/home\\.local/(.*)$"
        self.assertEqual(out.count(rule), out.count("\timport tinhat_headers\n"))  # in every site, the old one too
        self.assertIn("rewrite @former0 /_matrix/{re.former0.1}/{re.former0.2}/chat.example.com/{re.former0.3}", out)

    def test_the_old_names_site(self):
        out = templates.with_former_names(self.base, "chat.example.com",
                                          [("home.local", "internal"), ("maplehouse.tinhat.me", templates.acmedns_tls(ACME))])
        site = out[out.index("https://home.local {"):]
        site = site[: site.index("\n}\n")]
        self.assertIn("\ttls internal\n", site)
        self.assertIn("root * /srv/wk/former/home.local", site)
        self.assertIn("reverse_proxy 127.0.0.1:8008", site)  # apps that still use the old name reach the chat server
        self.assertIn("reverse_proxy 127.0.0.1:8090", site)  # and the dashboard (a move in progress is watched there)
        self.assertIn("redir https://chat.example.com{uri} 302", site)
        tinhat = out[out.index("https://maplehouse.tinhat.me {"):]
        self.assertIn("subdomain maplehouse", tinhat[: tinhat.index("\n}\n")])
        lines = [l.strip() for l in out.splitlines()]  # every block that opens closes
        self.assertEqual(sum(l.endswith("{") for l in lines), sum(l == "}" for l in lines))

    def test_media_only_and_names_that_dont_belong(self):
        out = templates.with_former_names(self.base, "chat.example.com", [("home.local", None)])
        self.assertIn("home\\.local", out)
        self.assertNotIn("https://home.local {", out)  # behind the owner's proxy the old name doesn't come here
        for bad in ("chat.example.com", "evil {\n}", "a b.local", "{http.request.host}"):
            self.assertEqual(templates.with_former_names(self.base, "chat.example.com", [(bad, "internal")]), self.base)

    def test_the_new_names_well_known_says_where_it_came_from(self):
        doc = json.loads(templates.wellknown_client("chat.example.com", True, "0.3.0", ["home.local", "maplehouse.tinhat.me"]))
        self.assertEqual(doc["dev.tinhat.moved_from"], ["home.local", "maplehouse.tinhat.me"])
        self.assertNotIn("dev.tinhat.moved_from", json.loads(templates.wellknown_client("chat.example.com", True, "0.3.0")))

    def test_the_proxy_check_before_the_move(self):
        site = templates.caddy_proxy_preflight(8080, ["192.168.1.30", "fe80::1", "evil}"])
        self.assertIn("http://:8080 {", site)
        self.assertIn("@home remote_ip private_ranges 192.168.1.30/32", site)  # the proxy: home network or this machine
        check = site[site.index("handle /_tinhat/move-check {"):]
        check = check[: check.index("\n\t\t}")]
        # the token is a file the web server serves itself, never cached; nothing here reaches the manager or chat
        # ... a file named after the address asked for: a relay through another name of this server finds nothing
        for line in ("header Cache-Control no-store", "root * /srv/wk/move-check", "rewrite * /{http.request.host}",
                     "file_server"):
            self.assertIn(line, check)
        self.assertNotIn("reverse_proxy", site)
        self.assertIn('respond "Only your reverse proxy connects here." 403', site)
        self.assertIn('respond "This Tin Hat server is moving here. Try again in a minute." 503', site)

    def test_the_proxy_port_answers_the_check_too(self):
        site = templates.CADDY_PROXY.format(server_name="chat.example.com", port=8080, own_ips=" 192.168.1.30/32",
                                            own_sites=templates.CADDY_PROXY_OWN_SITES.format(server_name="chat.example.com"),
                                            api_routes=templates.CADDY_API, date="today", trusted="private_ranges", admitted="private_ranges",
                                            headers_snippet=templates.HEADERS_SNIPPET, web_csp="",
                                            app_links=templates.APP_LINKS_ROUTE)
        port = site[site.index("http://:8080 {"):]
        port = port[: port.index("\n}\n")]
        self.assertIn("handle /_tinhat/move-check {", port)  # the proxy port only: not :80, not the box's own HTTPS
        self.assertEqual(site.count("/_tinhat/move-check"), 1)
        lines = [l.strip() for l in site.splitlines()]
        self.assertEqual(sum(l.endswith("{") for l in lines), sum(l == "}" for l in lines))

    def test_the_certificate_before_the_move(self):
        site = templates.caddy_preflight("chat.example.com", "\t\tdns cloudflare tok-EN_1\n", DIRECTORY, True)
        for line in ("https://chat.example.com {", f"dir {DIRECTORY}", "trusted_roots /etc/tinhat-ca/extra-roots.pem",
                     "dns cloudflare tok-EN_1", "respond \"This Tin Hat server is moving here. Try again in a minute.\" 503"):
            self.assertIn(line, site)
        for bad in (("evil {\n}", DIRECTORY), ("chat.example.com", "https://x {\n}")):
            with self.assertRaises(ValueError):
                templates.caddy_preflight(bad[0], "", bad[1], False)

    def test_the_old_names_well_known_says_where_the_server_went(self):
        doc = json.loads(templates.wellknown_former_client("chat.example.com", True, "0.3.0"))
        self.assertEqual(doc["m.homeserver"]["base_url"], "https://chat.example.com")
        self.assertEqual(doc["dev.tinhat.moved_to"], "chat.example.com")


class FakeSynapse:
    """Synapse's admin API as _end_calls sees it: two rooms, call memberships (one already ended)."""
    def __init__(self):
        self.calls, self.logged_out = [], []
        self.state = {"!a:old": [{"type": "org.matrix.msc3401.call.member", "state_key": "_@ann:new_DEV1_m.call",
                                  "sender": "@ann:new", "content": {"device_id": "DEV1"}},
                                 {"type": "m.room.topic", "state_key": "", "sender": "@ann:new", "content": {"topic": "hi"}}],
                      "!b:old": [{"type": "org.matrix.msc3401.call.member", "state_key": "_@bob:new_DEV2_m.call",
                                  "sender": "@bob:new", "content": {}},
                                 {"type": "m.call.member", "state_key": "@ann:new", "sender": "@ann:new",
                                  "content": {"memberships": [{"device_id": "DEV3"}]}}]}

    async def req(self, method, path, token=None, json=None):
        self.calls.append((method, path, token, json))
        if path.startswith("/_synapse/admin/v1/rooms?"):
            return 200, {"rooms": [{"room_id": r} for r in self.state]}
        if path.endswith("/state") and "/admin/" in path:
            room = path.split("/rooms/")[1].split("/state")[0].replace("%21", "!").replace("%3A", ":")
            return 200, {"state": self.state[room]}
        if path.endswith("/login"):
            return 200, {"access_token": "as-" + path.split("/users/")[1].split("/login")[0]}
        return 200, {}

    async def logout(self, token):
        self.logged_out.append(token)


class EndCalls(unittest.TestCase):
    def test_calls_from_before_the_move_end_as_their_members(self):
        import asyncio
        syn = FakeSynapse()
        ended = asyncio.run(move.Mover(syn)._end_calls("systoken"))
        self.assertEqual(ended, 2)  # the already-ended one (empty content) and the topic are left alone
        puts = [(c[1], c[2], c[3]) for c in syn.calls if c[0] == "PUT"]
        self.assertEqual(len(puts), 2)
        for path, token, body in puts:
            self.assertEqual(body, {})
            self.assertIn("call.member", path)
        # each as its own member, one admin login each, all logged out again
        self.assertEqual(sorted(t for _, t, _ in puts), ["as-%40ann%3Anew", "as-%40ann%3Anew"])
        self.assertEqual(syn.logged_out, ["as-%40ann%3Anew"])


class AfterARestart(unittest.TestCase):
    def mover(self, done_until, running):
        m = move.Mover(FakeSynapse())
        m.doc = m._fresh("home.local", "chat.example.com")
        ids = [i for i, _ in move.STEPS]
        for st in m.doc["steps"]:
            st["status"] = "done" if ids.index(st["id"]) <= ids.index(done_until) else "pending"
            if st["id"] == running:
                st["status"] = "running"
        m.doc["status"] = "running"
        return m

    def test_past_the_point_of_no_return_the_move_finishes(self):
        import asyncio
        COMPOSE.clear()
        m = self.mover("secure", "tell")  # chat and HTTPS ran under the new name: people may be using it
        asyncio.run(m._recover())  # a rollback would need compose.run (not stubbed): it would show in the details
        self.assertEqual(m.doc["status"], "done")
        self.assertEqual({s["id"]: s["status"] for s in m.doc["steps"]}["tell"], "done")
        self.assertFalse(m.doc.get("details"))
        self.assertIn(("up", "caddy", "postgres", "synapse", "livekit", "lk-jwt", "api", "games"), COMPOSE)  # chat started again

    def test_behind_a_proxy_the_move_is_live_before_chat_starts(self):
        import asyncio
        m = self.mover("switch", "chat")
        work = move.DIR / "20261021-235959"
        work.mkdir(parents=True, exist_ok=True)
        (work / "from").write_text("home.local")
        m.doc["work"] = str(work)
        seen = []

        async def up(*services):  # chat starting: was the live mark already on disk?
            seen.append((work / "live").exists())
            return 1, "chat didn't start (test)"
        saved = (move.compose.up, state.behind_proxy)
        move.compose.up, state.behind_proxy = up, (lambda st=None: True)
        try:
            with self.assertRaises(move.MoveError):
                asyncio.run(m._chat("home.local", "chat.example.com"))
        finally:
            move.compose.up, state.behind_proxy = saved
        self.assertEqual(seen, [True])
        # a restart now finishes the move: what people may have written under the new name stays
        calls = []

        async def finish(old, new, own):
            calls.append("finish")

        async def roll_back(old):
            calls.append("rollback")
        m._finish_live, m._roll_back_and_record = finish, roll_back
        try:
            asyncio.run(m._recover())
        finally:
            import shutil
            shutil.rmtree(work, ignore_errors=True)  # other tests count the move folders
        self.assertEqual(calls, ["finish"])

    def test_not_behind_a_proxy_a_restart_before_secure_rolls_back(self):
        import asyncio
        m = self.mover("switch", "chat")
        calls = []

        async def finish(old, new, own):
            calls.append("finish")

        async def roll_back(old):
            calls.append("rollback")

        async def no_wait(seconds=180):
            return None
        m._finish_live, m._roll_back_and_record = finish, roll_back
        saved = move._wait_postgres
        move._wait_postgres = no_wait
        try:
            asyncio.run(m._recover())
        finally:
            move._wait_postgres = saved
        self.assertEqual(calls, ["rollback"])

    def test_before_it_the_move_is_undone(self):
        m = self.mover("switch", "chat")
        self.assertFalse(m._steps_done(move.POINT_OF_NO_RETURN))
        self.assertTrue(m._steps_done("switch"))

    def test_only_this_moves_own_copy(self):
        m = move.Mover(FakeSynapse())
        m.doc = m._fresh("home.local", "chat.example.com")
        self.assertIsNone(m._work())  # no copy made yet: nothing to restore
        mine = move.DIR / "20261020-101010"
        mine.mkdir(parents=True)
        (mine / "from").write_text("home.local")
        other = move.DIR / "20261019-090909"
        other.mkdir(parents=True)
        (other / "from").write_text("older.local")
        m.doc["work"] = str(other)  # an earlier move's folder (or a doc pointing elsewhere) is never this move's copy
        self.assertIsNone(m._work())
        m.doc["work"] = "/somewhere/else"
        self.assertIsNone(m._work())
        m.doc["work"] = str(mine)
        self.assertEqual(m._work(), mine)
        move._prune()  # the newest earlier copy stays, older ones go
        self.assertTrue(mine.exists())
        self.assertFalse(other.exists())

    def test_unresolved_keeps_chat_off(self):
        STATUS_DOC[str(move.STATUS)] = {"status": "rolling-back"}
        try:
            self.assertTrue(move.unresolved())
            STATUS_DOC[str(move.STATUS)] = {"status": "failed"}
            self.assertFalse(move.unresolved())
        finally:
            STATUS_DOC.clear()
        self.assertEqual(move.services({"calls": False}), ["caddy", "postgres", "synapse", "api", "games"])


class SignIns(unittest.TestCase):
    def test_dashboard_sign_ins_follow_the_account(self):
        s = sessions.Sessions(1, pathlib.Path(TMP.name) / "s.json")
        a, b = s.new("@alex:home.local"), s.new("@sam:home.local.evil.example")
        s.rename("home.local", "chat.example.com")
        self.assertEqual(s.get(a)["mxid"], "@alex:chat.example.com")
        self.assertEqual(s.get(b)["mxid"], "@sam:home.local.evil.example")


if __name__ == "__main__":
    unittest.main()

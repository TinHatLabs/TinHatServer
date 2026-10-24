"""Matrix servers allowed by name (0.3.1), next to the Tin Hat connections: what an owner may type, and that no change
made in the dashboard ever drops a server from Synapse's list, a hand-set one (in state.json `federation` before the
dashboard had this list) included.

Runs anywhere (no aiohttp needed): federation.py is loaded in a package of its own with the real state.py and
config.py on a temporary state folder, and stand-ins for what reaches the network.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import json
import pathlib
import re
import sys
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "appliance/rootfs/opt/tinhat/manager/tinhat"
NAME = "tinhat_fedtest"  # not "tinhat": other tests put stand-ins there


def _load(name: str, package: types.ModuleType):
    spec = importlib.util.spec_from_file_location(f"{NAME}.{name}", PKG / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{NAME}.{name}"] = mod
    setattr(package, name, mod)
    spec.loader.exec_module(mod)
    return mod


def _setup():
    pkg = types.ModuleType(NAME)
    pkg.__path__ = [str(PKG)]
    sys.modules[NAME] = pkg
    if "aiohttp" not in sys.modules:
        try:
            import aiohttp  # noqa: F401  (the real one when it's there)
        except ImportError:
            stub = types.ModuleType("aiohttp")
            stub.ClientSession, stub.ClientTimeout, stub.ClientError = object, object, Exception
            sys.modules["aiohttp"] = stub
    config = _load("config", pkg)
    state = _load("state", pkg)
    _load("limits", pkg)
    env = types.ModuleType(f"{NAME}.environment")
    env.env = lambda: {"zone": "tinhat.me"}
    env.ssl_context = lambda: None
    pkg.environment = sys.modules[f"{NAME}.environment"] = env
    # owndomain needs the network and more; only its name rule is used here, taken from its source as it is
    src = (PKG / "owndomain.py").read_text()
    host_re = re.search(r'^HOST_RE = (re\.compile\(r".*"\))', src, re.M).group(1)
    od = types.ModuleType(f"{NAME}.owndomain")
    od.HOST_RE = eval(host_re, {"re": re})  # noqa: S307  (our own source line)
    pkg.owndomain = sys.modules[f"{NAME}.owndomain"] = od
    pkg.compose = sys.modules[f"{NAME}.compose"] = types.ModuleType(f"{NAME}.compose")
    fed = _load("federation", pkg)
    return pkg, config, state, fed


PKGMOD, CONFIG, STATE, FED = _setup()


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        CONFIG.STATE_FILE = pathlib.Path(self.dir.name) / "state.json"
        self.applied = []
        self.loop = asyncio.new_event_loop()

        async def apply(allow):
            self.applied.append(list(allow))
            return True, "ok"
        self.f = FED.Federation(apply)

    def tearDown(self):
        self.loop.close()
        self.dir.cleanup()

    def write(self, **st):
        CONFIG.STATE_FILE.write_text(json.dumps(st))

    def st(self) -> dict:
        return json.loads(CONFIG.STATE_FILE.read_text())

    def run_(self, coro):
        async def go():
            out = await coro
            for _ in range(5):  # the background apply task
                await asyncio.sleep(0)
            return out
        return self.loop.run_until_complete(go())


# a server on 0.3.0 whose owner put one plain Matrix server on Synapse's list by hand (state.json)
HAND_SET = {"phase": "ready", "mode": "domain", "server_name": "chat.example.com", "federation": ["matrix.example.org"]}


class Names(unittest.TestCase):
    def test_accepted_forms(self):
        for given in ("matrix.example.org", "matrix.example.org.", " https://matrix.example.org/ ", "HTTP://matrix.example.org/x", "@sam:matrix.example.org", "@Sam:matrix.example.org"):
            self.assertEqual(FED.normalize_matrix(given), ("matrix.example.org", None), given)
        self.assertEqual(FED.normalize_matrix("matrix.example.org")[0], "matrix.example.org")
        # a server name is kept as written (Matrix compares it as written); the rules don't mind the case
        self.assertEqual(FED.normalize_matrix("@Sam:Matrix.Example.org")[0], "Matrix.Example.org")
        self.assertIsNone(FED.normalize_matrix("Crew.TinHat.Me")[0])
        self.assertIsNone(FED.normalize_matrix("NAS.LAN")[0])
        self.assertIsNone(FED.normalize_matrix("exämple.org")[0])  # IDN: only its xn-- form, as Synapse has it

    def test_refused(self):
        for given in ("", "  ", "example.org:8448", "@max:example.org:8448", "https://example.org:443/", "10.0.0.5",
                      "1.2.3.4", "[::1]", "nas.lan", "box.home.arpa", "printer.local", "x.localhost", "crew", "exa mple.org",
                      "a\nb.example.org", "example.org\nx", "-bad.example.org", "e_x.example.org"):
            got, why = FED.normalize_matrix(given)
            self.assertIsNone(got, given)
            self.assertTrue(why, given)

    def test_tinhat_names_connect_with_a_code(self):
        for given in ("crew.tinhat.me", "https://crew.tinhat.me/", "@sam:crew.tinhat.me", "tinhat.me"):
            got, why = FED.normalize_matrix(given)
            self.assertIsNone(got, given)
            self.assertIn("connection code", why)


class Adopt(Base):
    def test_hand_set_entry_is_adopted_once(self):
        self.write(**HAND_SET)
        self.assertEqual(FED.adopt(), ["matrix.example.org"])
        st = self.st()
        self.assertEqual(st["federation"], ["matrix.example.org"])
        self.assertEqual([(a["server"], a["by"]) for a in st["allowed_servers"]], [("matrix.example.org", "hand")])
        before = CONFIG.STATE_FILE.read_bytes()
        self.assertEqual(FED.adopt(), [])  # nothing new: no write
        self.assertEqual(CONFIG.STATE_FILE.read_bytes(), before)
        self.assertEqual(FED.allowlist(), ["matrix.example.org"])

    def test_connections_on_the_list_are_not_adopted(self):
        self.write(federation=["crew.tinhat.me", "matrix.example.org"],
                   connections=[{"server": "crew.tinhat.me", "since": 1, "by": "x"}])
        self.assertEqual(FED.adopt(), ["matrix.example.org"])
        self.assertEqual(self.st()["federation"], ["crew.tinhat.me", "matrix.example.org"])

    def test_nothing_to_adopt(self):
        self.write(mode="domain")
        self.assertEqual(FED.adopt(), [])
        self.assertNotIn("allowed_servers", self.st())
        self.write(mode="domain", federation=[None, 5, "  "])  # junk is not a server name: never on Synapse's list
        self.assertEqual(FED.adopt(), [])

    def test_the_update_migration_adopts(self):
        self.write(**HAND_SET)
        spec = importlib.util.spec_from_file_location("m001", PKG / "migration_steps" / "001_federation_allowed.py")
        mod = importlib.util.module_from_spec(spec)
        saved = sys.modules.get("tinhat")
        sys.modules["tinhat"] = PKGMOD  # the step imports `from tinhat import federation`
        try:
            spec.loader.exec_module(mod)
            self.assertIn("matrix.example.org", mod.run())
            self.assertEqual(mod.run(), "nothing to adopt")  # it may run again after a rolled-back update
        finally:
            if saved is None:
                sys.modules.pop("tinhat", None)
            else:
                sys.modules["tinhat"] = saved
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])


class NeverDropped(Base):
    """0.3.0 wrote Synapse's list from the connections alone: connecting or disconnecting anything dropped the hand-set
    server. Every change now keeps it, also when adopt() never ran before (a 0.3.0 backup restored on 0.3.1)."""

    def test_connect_then_disconnect_keeps_the_hand_set_server(self):
        self.write(**HAND_SET)  # adopt() deliberately not called first
        self.run_(self.f._add("crew.tinhat.me", "code TC-AAAA-BBBB"))
        self.assertEqual(self.st()["federation"], ["crew.tinhat.me", "matrix.example.org"])
        self.assertEqual(self.applied[-1], ["crew.tinhat.me", "matrix.example.org"])
        self.f._post = self._fake_post
        ok, _ = self.run_(self.f.disconnect("crew.tinhat.me"))
        self.assertTrue(ok)
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])
        self.assertEqual(self.applied[-1], ["matrix.example.org"])

    def test_disconnect_by_the_other_side_keeps_it(self):
        self.write(**{**HAND_SET, "connections": [{"server": "crew.tinhat.me", "since": 1, "by": "x"}],
                      "federation": ["crew.tinhat.me", "matrix.example.org"]})
        self.run_(self.f._remove("crew.tinhat.me", notify=False))
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])

    def test_allow_and_remove_by_name(self):
        self.write(**HAND_SET)
        ok, msg = self.run_(self.f.allow("@sam:other.example.org", "@owner:chat.example.com"))
        self.assertTrue(ok, msg)
        self.assertEqual(self.st()["federation"], ["matrix.example.org", "other.example.org"])
        self.assertEqual(self.applied[-1], ["matrix.example.org", "other.example.org"])
        ok, msg = self.run_(self.f.disallow("matrix.example.org"))
        self.assertTrue(ok, msg)
        self.assertEqual(self.st()["federation"], ["other.example.org"])
        self.assertEqual([a["server"] for a in self.st()["allowed_servers"]], ["other.example.org"])
        ok, msg = self.run_(self.f.disallow("matrix.example.org"))
        self.assertFalse(ok)

    def test_remove_exactly_the_entry_shown(self):
        self.write(**{**HAND_SET, "federation": ["Matrix.Example.org", "matrix.example.org"]})  # two spellings, set by hand
        ok, _ = self.run_(self.f.disallow("matrix.example.org."))
        self.assertFalse(ok)  # no look-alikes
        ok, _ = self.run_(self.f.disallow("Matrix.Example.org"))
        self.assertTrue(ok)
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])  # the other spelling stays

    def test_refusals(self):
        self.write(**HAND_SET, connections=[{"server": "crew.tinhat.me", "since": 1, "by": "x"}])
        for given, words in (("chat.example.com", "this server"), ("MATRIX.EXAMPLE.ORG", "already allowed"),
                             ("crew.tinhat.me", "connection code"), ("nas.lan", "not an address"), ("x.org:8448", "port")):
            ok, msg = self.run_(self.f.allow(given, "@owner:chat.example.com"))
            self.assertFalse(ok, given)
            self.assertIn(words, msg, given)
        self.assertEqual(sorted(self.st()["federation"]), ["crew.tinhat.me", "matrix.example.org"])  # adopt() still ran
        self.assertEqual(self.applied, [])  # nothing changed, so Synapse wasn't restarted

    def test_a_connected_own_domain_server_cant_also_be_allowed(self):
        self.write(phase="ready", mode="domain", server_name="chat.example.com",
                   connections=[{"server": "friends.example.net", "since": 1, "by": "x"}], federation=["friends.example.net"])
        ok, msg = self.run_(self.f.allow("friends.example.net", "@owner:chat.example.com"))
        self.assertFalse(ok)
        self.assertIn("already connected", msg)

    def test_their_disconnect_never_removes_a_server_allowed_by_name(self):
        self.write(**HAND_SET)
        st, out = self.run_(self.f.handle_disconnect("matrix.example.org", "nonce"))  # no network: refused before any call
        self.assertEqual((st, out), (200, {"ok": True}))
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])
        self.assertEqual(self.applied, [])

    def test_a_server_allowed_by_name_can_still_connect_with_a_code(self):
        self.write(**{**HAND_SET, "federation": ["friends.example.net", "matrix.example.org"]})
        FED.adopt()
        self.f._post = self._fake_post
        ok, msg = self.run_(self.f.connect_to("friends.example.net", "TC-AAAA-BBBB", "@owner:chat.example.com"))
        self.assertTrue(ok, msg)
        st = self.st()
        self.assertEqual([c["server"] for c in st["connections"]], ["friends.example.net"])
        self.assertEqual(sorted(a["server"] for a in st["allowed_servers"]), ["friends.example.net", "matrix.example.org"])
        self.assertEqual(st["federation"], ["friends.example.net", "matrix.example.org"])
        # ending the connection (here: the other side, confirmed) never takes the owner's own allowance away
        self.run_(self.f._remove("friends.example.net", notify=False))
        self.assertEqual(self.st()["federation"], ["friends.example.net", "matrix.example.org"])
        self.assertEqual(self.st()["connections"], [])

    def test_no_owner_change_while_a_move_runs(self):
        self.write(**HAND_SET)
        self.f.busy = lambda: "moving"
        self.assertEqual(self.run_(self.f.allow("other.example.org", "@owner:chat.example.com")), (False, "moving"))
        self.assertEqual(self.run_(self.f.disallow("matrix.example.org")), (False, "moving"))
        self.assertEqual(self.st()["federation"], ["matrix.example.org"])
        self.assertEqual(self.applied, [])

    async def _fake_post(self, url, body):
        return 200, {"ok": True}


class CodeOnce(Base):
    """A connection code connects one server once, even when two requests with it are being confirmed at the same time,
    and not at all when it was revoked meanwhile (the code is checked again under the lock, after the confirmation)."""

    def setUp(self):
        super().setUp()
        self.write(phase="ready", mode="domain", server_name="chat.example.com", federation=["matrix.example.org"],
                   connect_codes=[{"code": "TC-AAAA-BBBB", "expires": 4102444800, "used": False}])
        self.f.fails.limited = lambda *a, **k: False

    def confirm_after(self, gate):
        async def confirm(server, nonce):
            await gate.wait()
            return True
        self.f._confirm_caller = confirm

    def test_two_requests_one_code(self):
        async def go():
            gate = asyncio.Event()
            self.confirm_after(gate)
            a = asyncio.create_task(self.f.handle_request("one.example.net", "TC-AAAA-BBBB", "n1", "192.0.2.1"))
            b = asyncio.create_task(self.f.handle_request("two.example.net", "tc-aaaa-bbbb", "n2", "192.0.2.2"))
            await asyncio.sleep(0)
            gate.set()
            return await a, await b
        (sa, _), (sb, _) = self.run_(go())
        self.assertEqual(sorted([sa, sb]), [200, 403])
        st = self.st()
        self.assertEqual(len(st["connections"]), 1)
        self.assertIn("matrix.example.org", st["federation"])  # the hand-set server stays through it all
        self.assertTrue(st["connect_codes"][0]["used"])

    def test_revoked_while_confirming(self):
        async def go():
            gate = asyncio.Event()
            self.confirm_after(gate)
            t = asyncio.create_task(self.f.handle_request("one.example.net", "TC-AAAA-BBBB", "n1", "192.0.2.1"))
            await asyncio.sleep(0)
            self.f.revoke_code("TC-AAAA-BBBB")
            gate.set()
            return await t
        st, _ = self.run_(go())
        self.assertEqual(st, 403)
        self.assertEqual(self.st()["connect_codes"], [])
        self.assertEqual(self.st().get("connections") or [], [])


class Wiring(unittest.TestCase):
    """The dashboard's calls and the manager's routes agree; every change needs the sign-in and the CSRF header."""

    def test_routes_and_page(self):
        web = (PKG / "web.py").read_text()
        page = (PKG.parent / "ui" / "admin.js").read_text()
        self.assertIn('r.add_post("/admin/api/allowed-servers", m.allowed_add)', web)
        self.assertIn('r.add_delete("/admin/api/allowed-servers/{server}", m.allowed_delete)', web)
        for fn in ("allowed_add", "allowed_delete"):
            body = web.split(f"async def {fn}(", 1)[1].split("\n    async def ", 1)[0]
            self.assertIn("self._admin(req)", body)
            self.assertIn("self._csrf_ok(req)", body)
            self.assertIn("self._moving()", body)
        self.assertIn('"/admin/api/allowed-servers"', page)
        self.assertIn("`/admin/api/allowed-servers/${encodeURIComponent(x.server)}`", page)
        self.assertIn("federation.adopt()", web.split("async def on_startup(", 1)[1].split("app.on_startup", 1)[0])


if __name__ == "__main__":
    unittest.main()

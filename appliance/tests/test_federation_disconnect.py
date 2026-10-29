"""/_tinhat/federation/disconnect and the handshake nonces (security review, server manager lows; sec-night-2
2026-10-27): the endpoint is throttled per caller (each call makes us ask the named server back), a nonce must have the
shape this code makes before it goes into the peer's confirm URL, a nonce of ours answers one confirm only, and the
peer's confirm must say the nonce was made for talking to us.

Runs anywhere (no aiohttp needed), the same harness as test_federation_allowed.py in a package of its own.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import json
import pathlib
import re
import sys
import tempfile
import time
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "appliance/rootfs/opt/tinhat/manager/tinhat"
NAME = "tinhat_feddisc"


def _load(name, package):
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
            import aiohttp  # noqa: F401
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
    src = (PKG / "owndomain.py").read_text()
    host_re = re.search(r'^HOST_RE = (re\.compile\(r".*"\))', src, re.M).group(1)
    od = types.ModuleType(f"{NAME}.owndomain")
    od.HOST_RE = eval(host_re, {"re": re})  # noqa: S307
    pkg.owndomain = sys.modules[f"{NAME}.owndomain"] = od
    pkg.compose = sys.modules[f"{NAME}.compose"] = types.ModuleType(f"{NAME}.compose")
    return config, state, _load("federation", pkg)


CONFIG, STATE, FED = _setup()
NONCE = "AbCdEfGhIjKlMnOpQrStUv"  # 22 characters, as secrets.token_urlsafe(16)


class Disconnect(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        CONFIG.STATE_FILE = pathlib.Path(self.dir.name) / "state.json"
        CONFIG.STATE_FILE.write_text(json.dumps({
            "phase": "ready", "mode": "anywhere", "server_name": "home.tinhat.me",
            "connections": [{"server": "crew.tinhat.me", "by": "code"}], "federation": ["crew.tinhat.me"]}))
        self.loop = asyncio.new_event_loop()

        async def apply(allow):
            return True, "ok"
        self.f = FED.Federation(apply)
        self.asked = []

        async def confirm(server, nonce):
            self.asked.append((server, nonce))
            return self.answer
        self.answer = False
        self.f._confirm_caller = confirm

    def tearDown(self):
        self.loop.close()
        self.dir.cleanup()

    def call(self, frm="crew.tinhat.me", nonce=NONCE, who="203.0.113.7"):
        return self.loop.run_until_complete(self.f.handle_disconnect(frm, nonce, who))

    def test_a_malformed_nonce_never_reaches_the_peer(self):
        for bad in ("../../admin?x=", "a/b", "short", "", "x" * 65, "nonce with spaces", "AbCdEfGhIjKlMnOp%2F"):
            st, _ = self.call(nonce=bad)
            self.assertEqual(st, 400, bad)
        self.assertEqual(self.asked, [])

    def test_the_endpoint_is_throttled_per_caller(self):
        for _ in range(FED.DISCONNECT_MOST):
            self.assertEqual(self.call()[0], 403)  # not confirmed
        self.assertEqual(self.call()[0], 429)
        self.assertEqual(len(self.asked), FED.DISCONNECT_MOST, "no more round trips once throttled")
        self.assertEqual(self.call(who="198.51.100.9")[0], 403, "another caller still gets through")
        # junk about a server we aren't connected to counts too (no round trip, but a try)
        for _ in range(FED.DISCONNECT_MOST):
            self.call(frm="nobody.tinhat.me", who="192.0.2.50")
        self.assertEqual(self.call(frm="nobody.tinhat.me", who="192.0.2.50")[0], 429)

    def test_a_real_disconnect_is_forgiven_and_done(self):
        self.answer = True
        removed = []

        async def remove(server, notify):
            removed.append(server)
        self.f._remove = remove
        st, out = self.call()
        self.assertEqual((st, out.get("ok")), (200, True))
        self.assertEqual(removed, ["crew.tinhat.me"])
        self.assertEqual(self.f.fails.count("disconnect"), 0)


class Nonces(unittest.TestCase):
    def test_a_nonce_of_ours_answers_one_confirm(self):
        f = FED.Federation(lambda allow: None)
        f.pending[NONCE] = ("crew.tinhat.me", time.time() + 120)
        self.assertEqual(f.confirm(NONCE), "crew.tinhat.me")
        self.assertIsNone(f.confirm(NONCE), "replayed")
        f.pending["old"] = ("crew.tinhat.me", time.time() - 1)
        self.assertIsNone(f.confirm("old"))

    def test_the_peer_must_have_made_it_for_us(self):
        ok = FED.confirm_ok
        self.assertTrue(ok({"server": "crew.tinhat.me", "to": "home.tinhat.me"}, "crew.tinhat.me", "home.tinhat.me"))
        self.assertFalse(ok({"server": "crew.tinhat.me", "to": "other.tinhat.me"}, "crew.tinhat.me", "home.tinhat.me"))
        self.assertFalse(ok({"server": "crew.tinhat.me"}, "crew.tinhat.me", "home.tinhat.me"))
        self.assertFalse(ok({"server": "evil.tinhat.me", "to": "home.tinhat.me"}, "crew.tinhat.me", "home.tinhat.me"))
        self.assertFalse(ok({"server": "crew.tinhat.me", "to": None}, "crew.tinhat.me", None))
        self.assertFalse(ok(["crew.tinhat.me"], "crew.tinhat.me", "home.tinhat.me"))
        self.assertTrue(ok({"server": "crew.tinhat.me", "to": "Home.TinHat.me."}, "crew.tinhat.me", "home.tinhat.me"))

    def test_our_own_nonces_fit_the_rule(self):
        import secrets
        for _ in range(50):
            self.assertTrue(FED.NONCE_RE.fullmatch(secrets.token_urlsafe(16)))


class Wiring(unittest.TestCase):
    def test_the_route_passes_the_caller(self):
        web = (PKG / "web.py").read_text()
        self.assertIn("str(body.get(\"nonce\", \"\")),\n                                                           _client(req))", web)
        src = (PKG / "federation.py").read_text()
        self.assertIn("allow_redirects=False", src)


if __name__ == "__main__":
    unittest.main()

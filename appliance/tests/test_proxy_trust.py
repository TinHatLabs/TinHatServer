"""Behind the owner's reverse proxy: which address(es) count as the proxy (owndomain.parse_proxies / proxies /
proxy_save_problem) and the dashboard's save (web.Manager.network_proxy). Security review 2026-10-26 (detail/07
"Caddy treats every private address as a trusted proxy").

The owndomain part runs anywhere (its imports are stubbed); the web.Manager part needs the real aiohttp and is skipped
where it isn't installed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import json
import pathlib
import sys
import types
import unittest
from unittest import mock

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load_owndomain():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.") or k == "aiohttp"}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        try:
            import aiohttp  # noqa: F401
        except ImportError:
            stub = types.ModuleType("aiohttp")
            stub.ClientSession, stub.ClientTimeout, stub.ClientError = object, object, Exception
            sys.modules["aiohttp"] = stub
        env = types.ModuleType("tinhat.environment")
        env.env = lambda: {"zone": "tinhat.me"}
        st = types.ModuleType("tinhat.state")
        st.behind_proxy = lambda s=None: (s or {}).get("mode") == "domain" and (s.get("domain") or {}).get("provider") == "proxy"
        st.load_state = lambda: {}
        for name, mod in (("environment", env), ("state", st)):
            sys.modules[f"tinhat.{name}"] = mod
            setattr(pkg, name, mod)
        for name in ("hw", "names"):
            m = types.ModuleType(f"tinhat.{name}")
            sys.modules[f"tinhat.{name}"] = m
            setattr(pkg, name, m)
        spec = importlib.util.spec_from_file_location("tinhat.owndomain", PKG / "owndomain.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.owndomain"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.") or k == "aiohttp"]:
            del sys.modules[k]
        sys.modules.update(saved)


owndomain = load_owndomain()
BEHIND = {"mode": "domain", "domain": {"provider": "proxy"}}


class Parse(unittest.TestCase):
    def ok(self, value):
        got, problem = owndomain.parse_proxies(value)
        self.assertIsNone(problem, value)
        return got

    def test_addresses_and_small_networks(self):
        self.assertEqual(self.ok(["192.168.50.2"]), ["192.168.50.2"])
        self.assertEqual(self.ok("192.168.50.2, fd12:3456:789a::5  10.1.2.0/28"), ["192.168.50.2", "fd12:3456:789a::5", "10.1.2.0/28"])
        self.assertEqual(self.ok(["10.0.0.5/32", "10.0.0.5", "FD00::5/128"]), ["10.0.0.5", "fd00::5"])  # one each
        self.assertEqual(self.ok(["10.0.0.9/24"]), ["10.0.0.0/24"])  # host bits dropped
        self.assertEqual(self.ok(["::ffff:192.168.1.5"]), ["192.168.1.5"])  # IPv4-mapped = the IPv4 address
        self.assertEqual(self.ok(["127.0.0.1"]), ["127.0.0.1"])  # a proxy on this machine that connects over loopback
        self.assertEqual(self.ok([]), [])
        self.assertEqual(self.ok(""), [])

    def test_refused(self):
        for bad in (["0.0.0.0/0"], ["::/0"], ["10.0.0.0/7"], ["2001:db8::/31"], ["0.0.0.0"], ["::"], ["224.0.0.1"],
                    ["ff02::1"], ["proxy.example.com"], ["10.0.0.1}"], ["1.2.3.4 import x"], ["10.0.0.1/33"],
                    [f"10.0.0.{i}" for i in range(1, 10)]):
            with self.subTest(value=bad):
                got, problem = owndomain.parse_proxies(bad)
                self.assertIsNone(got)
                self.assertTrue(problem)

    def test_the_wizard_takes_them_too(self):
        got, problem = owndomain.validate({"name": "chat.example.com", "domain": {"provider": "proxy", "proxies": "192.168.50.2"}})
        self.assertIsNone(problem)
        self.assertEqual(got["proxies"], ["192.168.50.2"])
        got, _ = owndomain.validate({"name": "chat.example.com", "domain": {"provider": "proxy"}})
        self.assertNotIn("proxies", got)  # none named: every home-network address, as before
        _, problem = owndomain.validate({"name": "chat.example.com", "domain": {"provider": "proxy", "proxies": "0.0.0.0/0"}})
        self.assertTrue(problem)


class Stored(unittest.TestCase):
    def test_only_behind_a_proxy_and_only_when_still_valid(self):
        self.assertEqual(owndomain.proxies({**BEHIND, "domain": {"provider": "proxy", "proxies": ["192.168.50.2"]}}), ["192.168.50.2"])
        self.assertEqual(owndomain.proxies(BEHIND), [])
        self.assertEqual(owndomain.proxies({"mode": "domain", "domain": {"provider": "cloudflare", "proxies": ["1.2.3.4"]}}), [])
        self.assertEqual(owndomain.proxies({"mode": "anywhere", "domain": {"provider": "proxy", "proxies": ["1.2.3.4"]}}), [])
        # a state.json someone edited by hand: nothing invalid ever reaches the Caddyfile, it falls back to before
        self.assertEqual(owndomain.proxies({**BEHIND, "domain": {"provider": "proxy", "proxies": ["evil}"]}}), [])


class LockOut(unittest.TestCase):
    OWN = ["192.168.1.30", "fe80::1"]

    def test_clearing_is_checked_too(self):
        # second review: clearing means "any home-network address", which shuts out a proxy on a public address
        self.assertIsNone(owndomain.proxy_save_problem([], "192.168.50.2", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem([], "fd12:3456:789a::5", self.OWN))
        p = owndomain.proxy_save_problem([], "203.0.113.9", self.OWN)
        self.assertIn("203.0.113.9", p)
        self.assertIn("locked out", p)
        self.assertTrue(owndomain.proxy_save_problem([], "", self.OWN))  # can't tell: refuse
        self.assertIsNone(owndomain.proxy_save_problem(["203.0.113.9"], "203.0.113.9", self.OWN))  # named: fine
        self.assertEqual(owndomain.effective_proxies([], ["192.168.1.30", "fe80::1"])[-1], "192.168.1.30")

    def test_a_list_that_leaves_this_request_out_is_refused(self):
        p = owndomain.proxy_save_problem(["192.168.50.3"], "192.168.50.2", self.OWN)
        self.assertIn("192.168.50.2", p)
        self.assertIn("lock you out", p)
        self.assertTrue(owndomain.proxy_save_problem(["192.168.50.2"], "", self.OWN))  # can't tell: refuse
        self.assertTrue(owndomain.proxy_save_problem(["192.168.50.2"], "not-an-ip", self.OWN))

    def test_the_peer_inside_the_list_or_this_machine(self):
        self.assertIsNone(owndomain.proxy_save_problem(["192.168.50.2"], "192.168.50.2", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem(["10.1.2.0/28"], "10.1.2.7", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem(["fd12:3456:789a::5"], "fd12:3456:789a::5", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem(["fd12:3456:789a::5"], "::ffff:192.168.1.30", self.OWN))  # this machine
        self.assertTrue(owndomain.proxy_save_problem(["10.1.2.0/28"], "10.1.2.17", self.OWN))

    def test_loopback_may_connect_but_a_proxy_there_must_be_named(self):
        # this machine's loopback always connects (review of 116d103, #1) ...
        self.assertIn("127.0.0.0/8", owndomain.effective_proxies(["192.168.50.2"], []))
        # ... but isn't believed unless named (second review, #5): a proxy on this machine that connects over loopback
        # and is left out would pass every caller on as this machine, so saving that is refused
        self.assertNotIn("127.0.0.0/8", owndomain.trusted_proxies(["192.168.50.2"], []))
        for peer in ("127.0.0.1", "::1"):
            p = owndomain.proxy_save_problem(["192.168.50.2"], peer, self.OWN)
            self.assertIn(peer, p)
            self.assertIn("add", p)
        self.assertIsNone(owndomain.proxy_save_problem(["127.0.0.1"], "127.0.0.1", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem(["192.168.50.2", "::1"], "::1", self.OWN))
        self.assertIsNone(owndomain.proxy_save_problem([], "127.0.0.1", self.OWN))  # unnamed: the home ranges, as before
        self.assertIn("127.0.0.0/8", owndomain.trusted_proxies([], []))


# ---- web.Manager (needs the real aiohttp) ----------------------------------------------------------------------------
try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
except ImportError:
    HAVE_AIOHTTP = False
if HAVE_AIOHTTP:
    import os
    import tempfile
    _OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
    os.environ.setdefault("TINHAT_OPT", str(_OPT))
    sys.path.insert(0, str(_OPT / "manager"))
    os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
    from tinhat import web  # noqa: E402


class Req(dict):
    def __init__(self, headers=None, remote="127.0.0.1", body=None):
        super().__init__()
        self.headers, self.remote, self.cookies, self.body = headers or {}, remote, {}, body

    async def json(self):
        return self.body


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class NetworkProxy(unittest.TestCase):
    BEFORE = {"provider": "proxy"}

    def call(self, body, peer="192.168.50.2", validate=(0, ""), reload=(0, "")):
        m = web.Manager.__new__(web.Manager)
        m._admin = lambda req: {"mxid": "@owner:chat.example.com"}
        m._moving = lambda: None
        m._apply_lock = asyncio.Lock()
        saved = {}
        st = {**BEHIND, "server_name": "chat.example.com", "phase": "ready"}
        st["domain"] = dict(self.BEFORE)
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        live = pathlib.Path(d) / "Caddyfile"
        live.write_text("OLD")
        self.live = live

        def refresh(force=False, caddyfile_to=None):  # what refresh_configs does to the Caddyfile
            (caddyfile_to or live).write_text(f"NEW {saved.get('domain')}")
            return []
        with mock.patch.object(web.state, "load_state", return_value=st), \
                mock.patch.object(web.config, "CADDYFILE", live), \
                mock.patch.object(web.state, "behind_proxy", return_value=True), \
                mock.patch.object(web.state, "save_state", side_effect=lambda **kw: saved.update(kw)), \
                mock.patch.object(web.hw, "addresses", return_value=["192.168.1.30"]), \
                mock.patch("tinhat.install.refresh_configs", side_effect=refresh) as refresh, \
                mock.patch.object(web.compose, "caddy_validate", new=mock.AsyncMock(return_value=validate)) as self.validated, \
                mock.patch.object(web.compose, "caddy_reload", new=mock.AsyncMock(return_value=reload)) as reloaded:
            r = asyncio.run(m.network_proxy(Req({"X-Tinhat": "1", "X-Tinhat-Peer": peer}, body=body)))
        self.assertFalse((live.parent / "Caddyfile.new").exists(), "the staged file never stays behind")
        return r.status, json.loads(r.body), saved, refresh, reloaded

    def test_saved_and_reloaded(self):
        status, body, saved, refresh, reload = self.call({"addresses": ["192.168.50.2"]})
        self.assertEqual(status, 200, body)
        self.assertEqual(saved["domain"], {"provider": "proxy", "proxies": ["192.168.50.2"]})
        self.assertTrue(refresh.called and reload.await_count == 1)
        # written beside the live file, checked there, then swapped in (review of 116d103, #5)
        self.assertEqual(self.validated.await_args.args[0], "/etc/caddy/Caddyfile.new")
        self.assertTrue(self.live.read_text().startswith("NEW"))

    def test_a_lock_out_is_refused_and_nothing_changes(self):
        status, body, saved, refresh, reload = self.call({"addresses": ["192.168.50.3"]})
        self.assertEqual(status, 409)
        self.assertIn("192.168.50.2", body["error"])
        self.assertEqual(saved, {})
        self.assertFalse(refresh.called)
        self.assertEqual(reload.await_count, 0)

    def test_bad_input(self):
        status, body, saved, _, _ = self.call({"addresses": ["0.0.0.0/0"]})
        self.assertEqual(status, 400)
        self.assertEqual(saved, {})

    def test_clearing_goes_back_to_the_home_network(self):
        status, body, saved, _, _ = self.call({"addresses": []}, peer="192.168.50.2")
        self.assertEqual(status, 200, body)
        self.assertEqual(saved["domain"], {"provider": "proxy"})

    def test_clearing_behind_a_public_proxy_is_refused(self):
        self.BEFORE = {"provider": "proxy", "proxies": ["203.0.113.9"]}
        status, body, saved, refresh, reload = self.call({"addresses": []}, peer="203.0.113.9")
        self.assertEqual(status, 409, body)
        self.assertIn("203.0.113.9", body["error"])
        self.assertEqual(saved, {})
        self.assertFalse(refresh.called)

    def test_a_failed_reload_restores_the_old_list_and_says_so(self):
        # second review: the reload failing used to answer ok while Caddy kept trusting the old list
        self.BEFORE = {"provider": "proxy", "proxies": ["192.168.50.2"]}
        status, body, saved, refresh, reload = self.call({"addresses": ["192.168.50.2", "192.168.50.3"]}, reload=(1, "boom"))
        self.assertEqual(status, 500, body)
        self.assertEqual(saved["domain"], {"provider": "proxy", "proxies": ["192.168.50.2"]}, "the old list is back")
        self.assertEqual(self.live.read_text(), "OLD", "the previous Caddyfile is back, byte for byte")
        self.assertEqual(reload.await_count, 2, "and reloaded")

    def test_a_refused_caddyfile_restores_the_old_list(self):
        status, body, saved, refresh, reload = self.call({"addresses": ["192.168.50.2"]}, validate=(1, "bad"))
        self.assertEqual(status, 500, body)
        self.assertEqual(saved["domain"], {"provider": "proxy"})
        self.assertEqual(self.live.read_text(), "OLD", "a refused file never touched the live one")
        self.assertEqual(reload.await_count, 0)


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class Console(unittest.TestCase):
    """`tinhat proxy-addresses`: the way back in, so it can name any address (a public proxy too) without a peer check."""

    def run_cli(self, args, named=()):
        from tinhat import __main__ as cli
        st = {"mode": "domain", "domain": {"provider": "proxy", **({"proxies": list(named)} if named else {})}}
        applied = []

        async def apply(new):
            applied.append(new)
            return True, ""
        with mock.patch("builtins.print") as said:
            rc = cli.proxy_addresses(args, st=st, apply=apply)
        return rc, applied, " ".join(str(c.args[0]) for c in said.call_args_list)

    def test_set_names_a_public_proxy(self):
        rc, applied, said = self.run_cli(["--set", "203.0.113.9,192.168.50.2"])
        self.assertEqual((rc, applied), (0, [["203.0.113.9", "192.168.50.2"]]))
        self.assertIn("203.0.113.9", said)

    def test_clear_warns_about_a_public_one(self):
        rc, applied, said = self.run_cli(["--clear"], named=["203.0.113.9"])
        self.assertEqual((rc, applied), (0, [[]]))
        self.assertIn("isn't a home-network address", said)
        rc, _, said = self.run_cli(["--clear"], named=["192.168.50.2"])
        self.assertNotIn("isn't a home-network address", said)

    def test_bad_input_and_usage(self):
        for args in (["--set"], ["--set", "0.0.0.0/0"], ["--bogus"], ["--clear", "x"]):
            with self.subTest(args=args):
                rc, applied, _ = self.run_cli(args)
                self.assertEqual(rc, 2)
                self.assertEqual(applied, [])
        rc, applied, said = self.run_cli([], named=["192.168.50.2"])
        self.assertEqual((rc, applied), (0, []))
        self.assertIn("192.168.50.2", said)


if __name__ == "__main__":
    unittest.main()

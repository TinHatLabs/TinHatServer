"""Who can open the dashboard (access.py; NEXT-ROUND "Dashboard access", 2026-10-28): the owner's choice, the
setup's question, the Caddy gate in every public Caddyfile, the manager's own check, and the console's way back in.

The access/templates part runs with the real modules on a scratch state folder; the middleware part needs the real
aiohttp (skipped where it isn't installed). With TINHAT_TEST_CADDY=/path/to/caddy (the tinhat/caddy image's binary)
every gated Caddyfile is also adapted by Caddy itself and its routes are checked.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import ipaddress
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

_OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

# the real package, whatever stand-ins other test modules left under tinhat.* while they were collected (and theirs
# are put back afterwards)
_saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _saved:
    del sys.modules[_k]
import tinhat  # noqa: E402
from tinhat import access, hw, state, templates  # noqa: E402
from tinhat import __main__ as cli  # noqa: E402,F401
try:
    import aiohttp
    from aiohttp.test_utils import make_mocked_request
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import install, web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)

# the other template tests load tinhat.* under stubs of their own; the gate imports access/hw/state when it renders, so
# every rendering here runs with the real ones in place
REAL = dict(_real)  # every test runs with these in place (mock.patch.dict)


class Real(unittest.TestCase):
    """Runs each test with the real tinhat modules in sys.modules (the code under test imports some at call time)."""
    def setUp(self):
        p = mock.patch.dict(sys.modules, REAL)
        p.start()
        self.addCleanup(p.stop)

CADDY = os.environ.get("TINHAT_TEST_CADDY")
NETS = [ipaddress.ip_network("2001:db8:aa:1::/64")]
ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


def st(mode="anywhere", choice=None, addresses=()):
    out = {"phase": "ready", "mode": mode}
    if choice is not None:
        out["dashboard_access"] = {"mode": choice, "addresses": list(addresses)}
    return out


class Choice(Real):
    def test_owner_entry(self):
        self.assertEqual(access.owner_entry("203.0.113.7"), "203.0.113.7")
        self.assertEqual(access.owner_entry("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64")
        self.assertEqual(access.owner_entry("::ffff:203.0.113.7"), "203.0.113.7")
        for bad in ("", "nonsense", "127.0.0.1", "::1", "0.0.0.0"):
            self.assertIsNone(access.owner_entry(bad), bad)

    def test_parse(self):
        self.assertEqual(access.parse_addresses("203.0.113.7, 2001:db8:1:2::5/64 203.0.113.7"),
                         (["203.0.113.7", "2001:db8:1:2::/64"], None))
        # a bare IPv6 address counts with its /64 (a device's IPv6 address changes within it); a written prefix stays
        self.assertEqual(access.parse_addresses("2001:db8:1:2::9 2001:db8:3:4::9/128"),
                         (["2001:db8:1:2::/64", "2001:db8:3:4::9/128"], None))
        # saved and read back, a /128 stays a /128 (Astra on be9372e): the neighbour stays out
        s = st(choice="addresses", addresses=access.parse_addresses("2001:db8:3:4::9/128")[0])
        self.assertEqual(access.policy(s)["addresses"], ["2001:db8:3:4::9/128"])
        self.assertTrue(access.allowed("2001:db8:3:4::9", s, NETS))
        self.assertFalse(access.allowed("2001:db8:3:4::a", s, NETS))
        self.assertIn("2001:db8:3:4::9/128", access.caddy_ranges(s, NETS))
        self.assertEqual(access.parse_addresses(["198.51.100.0/24"]), (["198.51.100.0/24"], None))
        for bad in ("0.0.0.0/0", "10.0.0.0/8", "::/0", "2001:db8::/32", "hello", "224.0.0.1"):
            out, problem = access.parse_addresses(bad)
            self.assertEqual(out, [], bad)
            self.assertTrue(problem, bad)
        self.assertTrue(access.parse_addresses([f"203.0.113.{i}" for i in range(9)])[1])

    def test_policy_defaults(self):
        self.assertEqual(access.policy({}), {"mode": "anywhere", "addresses": []})
        self.assertEqual(access.policy({"dashboard_access": {"mode": "bogus"}}), {"mode": "anywhere", "addresses": []})
        self.assertEqual(access.policy({"dashboard_access": "x"}), {"mode": "anywhere", "addresses": []})
        # "addresses" with nothing usable left closes to the home network, never opens to anywhere
        self.assertEqual(access.policy({"dashboard_access": {"mode": "addresses", "addresses": ["0.0.0.0/0"]}})["mode"], "home")
        self.assertEqual(access.policy({"dashboard_access": {"mode": "addresses", "addresses": []}})["mode"], "home")

    def test_allowed(self):
        home_only = st(choice="home")
        mine = st(choice="addresses", addresses=["203.0.113.7", "2001:db8:5:6::/64"])
        for s in (home_only, mine):
            for ip in ("192.168.1.20", "10.0.0.5", "127.0.0.1", "fd00::5", "2001:db8:aa:1::99"):
                self.assertTrue(access.allowed(ip, s, NETS), ip)
            self.assertFalse(access.allowed("198.51.100.9", s, NETS))
            self.assertFalse(access.allowed("", s, NETS))
            self.assertFalse(access.allowed("garbage", s, NETS))
        self.assertTrue(access.allowed("203.0.113.7", mine, NETS))
        self.assertTrue(access.allowed("2001:db8:5:6::abcd", mine, NETS))
        self.assertFalse(access.allowed("203.0.113.8", mine, NETS))
        self.assertFalse(access.allowed("203.0.113.7", home_only, NETS))
        self.assertTrue(access.allowed("198.51.100.9", st(), NETS))  # nothing chosen: anywhere
        # a home-network server: nothing outside reaches it, the choice changes nothing
        self.assertTrue(access.allowed("198.51.100.9", st("lan", "home"), NETS))

    def test_caddy_ranges(self):
        self.assertIsNone(access.caddy_ranges(st(), NETS))
        self.assertIsNone(access.caddy_ranges(st("lan", "home"), NETS))
        mapped = "::ffff:10.0.0.0/104 ::ffff:172.16.0.0/108 ::ffff:192.168.0.0/112 ::ffff:127.0.0.0/104"
        self.assertEqual(access.caddy_ranges(st(choice="home"), NETS), f"private_ranges {mapped} 2001:db8:aa:1::/64")
        # an IPv4 entry goes in IPv4-mapped too: Caddy doesn't unmap ::ffff:203.0.113.7 (Astra on be9372e)
        self.assertEqual(access.caddy_ranges(st("domain", "addresses", ["203.0.113.7"]), NETS),
                         f"private_ranges {mapped} 2001:db8:aa:1::/64 203.0.113.7 ::ffff:203.0.113.7/128")

    def test_lockout(self):
        self.assertIsNone(access.lockout_problem("anywhere", [], "198.51.100.9", NETS))
        self.assertIsNone(access.lockout_problem("home", [], "192.168.1.20", NETS))
        self.assertIsNone(access.lockout_problem("addresses", ["198.51.100.9"], "198.51.100.9", NETS))
        self.assertIn("198.51.100.9", access.lockout_problem("home", [], "198.51.100.9", NETS))
        self.assertIn("2001:db8:9:9::/64", access.lockout_problem("addresses", ["203.0.113.7"], "2001:db8:9:9::1", NETS))

    def test_from_setup(self):
        self.assertEqual(access.from_setup(None, "198.51.100.9", False), ({"mode": "anywhere", "addresses": []}, None))
        self.assertEqual(access.from_setup("anywhere", "198.51.100.9", False)[0]["mode"], "anywhere")
        self.assertEqual(access.from_setup("address", "198.51.100.9", False),
                         ({"mode": "addresses", "addresses": ["198.51.100.9"]}, None))
        self.assertEqual(access.from_setup("address", "2001:db8:9:9::1", False)[0]["addresses"], ["2001:db8:9:9::/64"])
        self.assertTrue(access.from_setup("home", "198.51.100.9", False)[1], "home-only from outside locks the owner out")
        self.assertEqual(access.from_setup("home", "192.168.1.20", True)[0]["mode"], "home")
        self.assertTrue(access.from_setup("address", "", False)[1])
        self.assertTrue(access.from_setup("everything", "198.51.100.9", False)[1])


def rendered(choice=None, addresses=()):
    """Every public Caddyfile, rendered with the real templates for this state (written to the scratch folder)."""
    s = {"phase": "ready", "mode": "anywhere"}
    if choice:
        s["dashboard_access"] = {"mode": choice, "addresses": list(addresses)}
    state.write_json(state.config.STATE_FILE, s, 0o644)
    with mock.patch.dict(sys.modules, REAL), mock.patch.object(hw, "ipv6_nets", lambda: list(NETS)), \
            mock.patch.object(hw, "addresses", lambda: ["192.168.1.30"]):
        anywhere = templates.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, False)
        return {
            "from anywhere": anywhere,
            "from anywhere, relay": templates.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, True, proxy_from="10.99.0.2"),
            "own domain": templates.caddy_domain("chat.example.com", "\t\tdns cloudflare abcDEF123\n", DIRECTORY, False),
            "own reverse proxy": templates.caddy_proxy("chat.example.com", 8080),
            "own reverse proxy on this machine": templates.caddy_proxy("chat.example.com", 8080, shared=True),
            "moved, former names": templates.with_former_names(anywhere, "maplehouse.tinhat.me",
                                                               [("old.example.com", "\t\tdns cloudflare abc\n")]),
        }, templates.caddy_lan("crew.local")


def admin_blocks(cf: str) -> list[list[str]]:
    lines = cf.splitlines()
    out = []
    for i, l in enumerate(lines):
        if l.strip() == "handle @admin {":
            indent = l[: len(l) - len(l.lstrip("\t"))]
            end = next(j for j in range(i + 1, len(lines)) if lines[j] == indent + "}")
            out.append([x.strip() for x in lines[i + 1:end]])
    return out


class Gate(Real):
    def tearDown(self):
        state.config.STATE_FILE.unlink(missing_ok=True)

    def test_anywhere_writes_nothing(self):
        files, lan = rendered()
        for mode, cf in files.items():
            with self.subTest(mode):
                self.assertNotIn("tinhat_admin_away", cf)
                self.assertTrue(admin_blocks(cf))
                self.assertNotIn("{admin_gate}", cf)

    def test_every_admin_route_starts_with_the_gate(self):
        mapped = "::ffff:10.0.0.0/104 ::ffff:172.16.0.0/108 ::ffff:192.168.0.0/112 ::ffff:127.0.0.0/104"
        for choice, addrs, words in (("home", (), f"private_ranges {mapped} 2001:db8:aa:1::/64"),
                                     ("addresses", ("203.0.113.7", "2001:db8:5:6::/64"),
                                      f"private_ranges {mapped} 2001:db8:aa:1::/64 203.0.113.7 ::ffff:203.0.113.7/128 "
                                      "2001:db8:5:6::/64")):
            files, lan = rendered(choice, addrs)
            self.assertNotIn("tinhat_admin_away", lan)  # home network mode: nothing outside reaches it
            for mode, cf in files.items():
                with self.subTest(mode=mode, choice=choice):
                    blocks = admin_blocks(cf)
                    self.assertTrue(blocks)
                    for b in blocks:
                        self.assertEqual(b[:5], ["@tinhat_admin_away {", f"not client_ip {words}",
                                                 "not path /admin/name-check", "}",
                                                 f'respond @tinhat_admin_away "{access.REFUSED}" 403'])
                        if "proxy" in mode:  # no X-Forwarded-For through the owner's proxy: refused too
                            self.assertEqual(b[5:14], ["@tinhat_admin_unnamed {",
                                                       "not header_regexp X-Forwarded-For `^[0-9A-Fa-f:.,\\[\\] ]+$`",
                                                       "not {", "remote_ip 127.0.0.0/8 ::1", "protocol https", "}",
                                                       "not path /admin/name-check",
                                                       "}", f'respond @tinhat_admin_unnamed "{access.REFUSED_UNNAMED}" 403'])
                            b = b[:5] + b[14:]
                        else:
                            self.assertNotIn("tinhat_admin_unnamed", cf)
                        self.assertTrue(b[5].startswith("reverse_proxy 127.0.0.1:8090"))
                    # every route to /admin is one of these: none left ungated
                    self.assertEqual(cf.count("@admin path /admin /admin/*"), len(blocks))
                    self.assertEqual(cf.count("\t\t\tnot client_ip "), len(blocks))
                    lines = [l.strip() for l in cf.splitlines()]
                    self.assertEqual(sum(l.endswith("{") for l in lines), sum(l == "}" for l in lines))

    def test_the_refusal_is_a_plain_caddy_word(self):
        for text in (access.REFUSED, access.REFUSED_UNNAMED):
            self.assertNotIn('"', text)
            self.assertNotIn("{", text)
            self.assertNotIn("\n", text)


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyTakesTheGate(Real):
    def tearDown(self):
        state.config.STATE_FILE.unlink(missing_ok=True)

    def test_adapted(self):
        files, _ = rendered("addresses", ("203.0.113.7",))
        for mode, cf in files.items():
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                (pathlib.Path(d) / "Caddyfile").write_text(cf)
                env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
                r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                   capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-1500:])
                text = r.stdout
                conf = json.loads(text)
                self.assertIn('"client_ip"', text)
                found = []

                def walk(node):
                    if isinstance(node, dict):
                        for m in node.get("match") or []:
                            if isinstance(m, dict) and m.get("not") and any("client_ip" in x for x in m["not"]):
                                found.append(node)
                        for v in node.values():
                            walk(v)
                    elif isinstance(node, list):
                        for v in node:
                            walk(v)
                walk(conf)
                self.assertTrue(found)
                for rt in found:
                    nots = rt["match"][0]["not"]
                    self.assertIn({"path": ["/admin/name-check"]}, nots)
                    ranges = [x["client_ip"]["ranges"] for x in nots if "client_ip" in x][0]
                    self.assertIn("203.0.113.7", ranges)
                    self.assertIn("2001:db8:aa:1::/64", ranges)
                    self.assertIn("192.168.0.0/16", ranges)  # private_ranges, expanded by Caddy
                    resp = [h for h in rt["handle"] if h.get("handler") == "static_response"]
                    self.assertEqual(resp[0]["status_code"], 403)




@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class ManagerGate(Real):
    def tearDown(self):
        state.config.STATE_FILE.unlink(missing_ok=True)

    def run_gate(self, path, ip, s):
        state.write_json(state.config.STATE_FILE, s, 0o644)
        req = make_mocked_request("GET", path, headers={"X-Forwarded-For": ip, "X-Forwarded-Proto": "https"})
        reached = []

        async def handler(r):
            reached.append(r.path)
            return web.web.Response(text="ok")
        with mock.patch.dict(sys.modules, REAL), mock.patch.object(web, "_home_nets", lambda: list(NETS)), \
                mock.patch.object(web, "_proxies", lambda: None):
            resp = asyncio.run(web.dashboard_gate(req, handler))
        return resp.status, bool(reached)

    def test_refuses_outside_addresses_once_ready(self):
        mine = st(choice="addresses", addresses=["203.0.113.7"])
        for path in ("/admin/", "/admin/api/login", "/admin/api/network", "/admin/setup/status", "/admin/recover/start"):
            self.assertEqual(self.run_gate(path, "198.51.100.9", mine), (403, False), path)
            self.assertEqual(self.run_gate(path, "203.0.113.7", mine), (200, True), path)
            self.assertEqual(self.run_gate(path, "192.168.1.20", mine), (200, True), path)
            self.assertEqual(self.run_gate(path, "2001:db8:aa:1::7", mine), (200, True), path)
        # not the dashboard: the web app, the invite codes the apps use, the moved-server handshake
        for path in ("/", "/tinhat-api/admin/invites", "/admin/name-check", "/administrator"):
            self.assertEqual(self.run_gate(path, "198.51.100.9", mine), (200, True), path)
        # anywhere (the default), a home-network server, and before setup is done: no gate
        self.assertEqual(self.run_gate("/admin/", "198.51.100.9", st()), (200, True))
        self.assertEqual(self.run_gate("/admin/", "198.51.100.9", st("lan", "home")), (200, True))
        self.assertEqual(self.run_gate("/admin/setup/status", "198.51.100.9", {**mine, "phase": "installing"}), (200, True))

    def _live(self, text):
        state.config.CADDYFILE.parent.mkdir(parents=True, exist_ok=True)
        state.config.CADDYFILE.write_text(text)

    def test_apply_puts_everything_back_on_an_exception(self):
        before = {"mode": "home", "addresses": []}
        state.write_json(state.config.STATE_FILE, {**st(), "dashboard_access": before}, 0o644)
        self._live("old\n")

        def boom(**kw):
            raise RuntimeError("template broke")
        with mock.patch.object(install, "refresh_configs", boom):
            ok, why = asyncio.run(web._apply_with_caddy(
                lambda cur: ({"dashboard_access": {"mode": "anywhere"}}, {"dashboard_access": cur["dashboard_access"]})))
        self.assertFalse(ok)
        self.assertIn("template broke", why)
        self.assertEqual(state.load_state()["dashboard_access"], before)
        self.assertEqual(state.config.CADDYFILE.read_text(), "old\n")
        self.assertEqual([p.name for p in state.config.CADDYFILE.parent.glob("Caddyfile.new*")], [])

    def test_apply_puts_the_file_back_when_the_reload_fails(self):
        before = {"mode": "home", "addresses": []}
        state.write_json(state.config.STATE_FILE, {**st(), "dashboard_access": before}, 0o644)
        self._live("old\n")
        reloads = []

        def write(caddyfile_to=None, **kw):
            caddyfile_to.write_text("new\n")

        async def validate(path):
            return 0, ""

        async def reload(force=False):
            reloads.append(state.config.CADDYFILE.read_text())
            return (1, "nope") if len(reloads) == 1 else (0, "")
        with mock.patch.object(install, "refresh_configs", write), \
                mock.patch.object(web.compose, "caddy_validate", validate), \
                mock.patch.object(web.compose, "caddy_reload", reload):
            ok, why = asyncio.run(web._apply_with_caddy(
                lambda cur: ({"dashboard_access": {"mode": "anywhere"}}, {"dashboard_access": cur["dashboard_access"]})))
        self.assertFalse(ok)
        self.assertEqual(reloads, ["new\n", "old\n"])
        self.assertEqual(state.config.CADDYFILE.read_text(), "old\n")
        self.assertEqual(state.load_state()["dashboard_access"], before)

    def test_the_loop_takes_out_a_gate_the_choice_dropped(self):
        # a console `anywhere` whose apply failed: the state says anywhere, the file still has the gate
        state.write_json(state.config.STATE_FILE, st(choice="anywhere"), 0o644)
        self._live("\t@admin path /admin /admin/*\n\thandle @admin {\n\t\t@tinhat_admin_away {\n")
        calls = []

        async def apply(change=None):
            calls.append(change)
            return True, ""

        async def reload(force=False):
            calls.append("reload")
            return 0, ""

        async def go():
            m = types.SimpleNamespace(mover=types.SimpleNamespace(running=False), _apply_lock=asyncio.Lock())
            await web._keep_access_gate(m)
        web._gate_reloaded = False
        with mock.patch.object(web, "_apply_with_caddy", apply), mock.patch.object(web, "_home_nets", lambda: []), \
                mock.patch.object(web.compose, "caddy_reload", reload):
            asyncio.run(go())
            self.assertEqual(calls, [None])
            # gate gone from the file (written, but the manager stopped before the reload): Caddy is told once
            # after start, also when the choice has no gate (follow-up review #6)
            web._gate_reloaded = False
            self._live("\t@admin path /admin /admin/*\n\thandle @admin {\n\t\treverse_proxy 127.0.0.1:8090\n")
            calls.clear()
            asyncio.run(go())
            asyncio.run(go())
            self.assertEqual(calls, ["reload"])

    def test_a_cancel_waits_for_the_rollback(self):
        before = {"mode": "home", "addresses": []}
        state.write_json(state.config.STATE_FILE, {**st(), "dashboard_access": before}, 0o644)
        self._live("old\n")
        done = []

        def write(caddyfile_to=None, **kw):
            caddyfile_to.write_text("new\n")

        async def validate(path):
            return 0, ""

        async def reload(force=False):
            if not done:
                done.append("slow reload")
                await asyncio.sleep(5)
            done.append(state.config.CADDYFILE.read_text())
            return 0, ""

        async def go():
            t = asyncio.ensure_future(web._apply_with_caddy(
                lambda cur: ({"dashboard_access": {"mode": "anywhere"}}, {"dashboard_access": before})))
            await asyncio.sleep(0.3)
            t.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await t
            # the lock is free again only after the rollback finished
            async with web._CaddyLock(seconds=1):
                pass
        with mock.patch.object(install, "refresh_configs", write), \
                mock.patch.object(web.compose, "caddy_validate", validate), \
                mock.patch.object(web.compose, "caddy_reload", reload):
            asyncio.run(go())
        self.assertEqual(done, ["slow reload", "old\n"])
        self.assertEqual(state.config.CADDYFILE.read_text(), "old\n")
        self.assertEqual(state.load_state()["dashboard_access"], before)

    def test_console_way_back_in(self):
        calls = []

        async def apply(mode, addrs, who):
            calls.append((mode, addrs, who))
            return True, ""
        s = st(choice="home")
        self.assertEqual(cli.dashboard_access(["anywhere"], s, apply), 0)
        self.assertEqual(calls[-1], ("anywhere", [], "console"))
        self.assertEqual(cli.dashboard_access(["only", "203.0.113.7,", "2001:db8:1:2::9"], s, apply), 0)
        self.assertEqual(calls[-1], ("addresses", ["203.0.113.7", "2001:db8:1:2::/64"], "console"))
        self.assertEqual(cli.dashboard_access(["add", "198.51.100.4"], st(choice="addresses", addresses=["203.0.113.7"]), apply), 0)
        self.assertEqual(calls[-1], ("addresses", ["203.0.113.7", "198.51.100.4"], "console"))
        self.assertEqual(cli.dashboard_access(["only", "0.0.0.0/0"], s, apply), 2)
        self.assertEqual(cli.dashboard_access(["sideways"], s, apply), 2)
        self.assertEqual(cli.dashboard_access([], s, apply), 0)

        async def broken(mode, addrs, who):
            return False, "validate: nope"
        state.write_json(state.config.STATE_FILE, s, 0o644)
        self.assertEqual(cli.dashboard_access(["anywhere"], s, broken), 1)
        self.assertEqual(access.policy()["mode"], "anywhere", "the manager's own check opens even when Caddy refused")


if __name__ == "__main__":
    unittest.main()

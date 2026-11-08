"""Behind the owner's reverse proxy with NO proxy named, every caller at home looked like the proxy (0.3.15; found on a
live server: one shared sign-in limit for everyone at home). Caddy trusts every home-network address then and reads
X-Forwarded-For strictly from the right, so a home caller is "trusted" too and Caddy falls back to the connecting
peer: the proxy.

The fix: Caddy hands the manager the X-Forwarded-For a request ARRIVED with (X-Tinhat-Via), so it can tell "came
through a proxy" from a browser connected straight to the port; a server set up or restored with 0.3.15+ names its
proxy on the owner's first dashboard visit through it; an older one is offered it (Overview + Network).

CaddyInTheLoop runs the product's own dashboard-route header lines through a real Caddy (TINHAT_TEST_CADDY, `caddy` on
PATH, or ~/so-caddy/caddy; skipped when there is none): it fails on a tree without the X-Tinhat-Via line.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import http.client
import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_proxy_trust  # noqa: E402  (its module-level import of tinhat.web, made before other tests stub modules)
from test_proxy_trust import BEHIND, HAVE_AIOHTTP, Req, load_owndomain  # noqa: E402

owndomain = load_owndomain()
PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
OWN = ["192.168.1.30"]  # this machine


class HomeCollapse(unittest.TestCase):
    def test_a_home_proxy_with_none_named(self):
        self.assertEqual(owndomain.home_collapse(BEHIND, "192.168.1.5", "192.168.1.50", OWN), "192.168.1.5")
        self.assertEqual(owndomain.home_collapse(BEHIND, "fd00::5", "fd00::50", OWN), "fd00::5")

    def test_not_the_case(self):
        named = {**BEHIND, "domain": {"provider": "proxy", "proxies": ["192.168.1.5"]}}
        cases = [
            (named, "192.168.1.5", "192.168.1.50"),            # already named
            (BEHIND, "192.168.1.5", ""),                        # a browser straight to the port: no X-Forwarded-For
            (BEHIND, "192.168.1.5", "   "),
            (BEHIND, "203.0.113.9", "192.168.1.50"),            # a proxy on the internet: callers aren't collapsed
            (BEHIND, "", "192.168.1.50"),                       # no peer known
            ({"mode": "domain", "domain": {"provider": "cloudflare"}}, "192.168.1.5", "192.168.1.50"),  # not behind a proxy
            ({"mode": "lan"}, "192.168.1.5", "192.168.1.50"),
        ]
        for st, peer, via in cases:
            with self.subTest((st.get("domain"), peer, via)):
                self.assertIsNone(owndomain.home_collapse(st, peer, via, OWN))

    def test_a_proxy_on_this_same_machine(self):  # review: it collapses its callers the same way
        self.assertEqual(owndomain.home_collapse(BEHIND, "127.0.0.1", "192.168.1.50", OWN), "127.0.0.1")
        self.assertEqual(owndomain.home_collapse(BEHIND, "192.168.1.30", "192.168.1.50", OWN), "192.168.1.30")
        self.assertEqual(owndomain.home_collapse(BEHIND, "100.64.0.9", "192.168.1.50", ["100.64.0.9"]), "100.64.0.9")

    def test_named_by_itself_only_after_a_new_setup(self):
        self.assertIsNone(owndomain.autoname_candidate(BEHIND, "192.168.1.5", "192.168.1.50", OWN, "https"))  # upgraded
        fresh = {**BEHIND, "proxy_autoname": True}
        self.assertEqual(owndomain.autoname_candidate(fresh, "192.168.1.5", "192.168.1.50", OWN, "https"), "192.168.1.5")
        self.assertEqual(owndomain.autoname_candidate(fresh, "192.168.1.5", "192.168.1.50", OWN, "HTTPS"), "192.168.1.5")
        self.assertIsNone(owndomain.autoname_candidate(fresh, "192.168.1.5", "", OWN, "https"))  # never from a direct visit
        # a browser at home that sends its own X-Forwarded-For straight to the port (no HTTPS proxy said so)
        for proto in ("", "http", None):
            self.assertIsNone(owndomain.autoname_candidate(fresh, "192.168.1.7", "1.2.3.4", OWN, proto))


def _dashboard_route() -> str:
    """The body of CADDY_PROXY's dashboard route (the :8090 one that sets X-Tinhat-Peer)."""
    src = (PKG / "templates.py").read_text()
    peer = src.index("header_up X-Tinhat-Peer {{remote_host}}")
    start = src.rindex("reverse_proxy 127.0.0.1:8090 {{", 0, peer) + len("reverse_proxy 127.0.0.1:8090 {{")
    return src[start:src.index("\t\t}}", peer)]


class Template(unittest.TestCase):
    def test_the_dashboard_route_carries_the_arriving_header(self):
        route = _dashboard_route()
        self.assertIn("header_up X-Tinhat-Via {{http.request.header.X-Forwarded-For}}", route)
        self.assertIn("header_up X-Tinhat-Peer {{remote_host}}", route)
        self.assertIn("header_up X-Tinhat-Via-Proto {{http.request.header.X-Forwarded-Proto}}", route)

    def test_setup_finish_arms_it_only_behind_a_proxy_with_none_named(self):
        src = (PKG / "install.py").read_text()
        self.assertIn("if state.behind_proxy(st) and not owndomain.proxies(st):", src)
        self.assertIn("state.save_state(proxy_autoname=True)", src)


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class AutoName(unittest.TestCase):
    def setUp(self):
        self.web = test_proxy_trust.web

    def run_it(self, st, peer="192.168.1.5", via="192.168.1.50", ok=(True, ""), times=1, proto="https", during=None):
        web = self.web
        m = web.Manager.__new__(web.Manager)
        m._apply_lock = asyncio.Lock()
        m._autoname_tried = None
        saved = {}
        apply = mock.AsyncMock(return_value=ok)

        def save(**kw):
            saved.update(kw)
            st.update(kw)
        headers = {"X-Tinhat-Peer": peer, **({"X-Tinhat-Via": via} if via is not None else {}),
                   **({"X-Tinhat-Via-Proto": proto} if proto is not None else {})}
        if during is not None:  # something else holds the apply lock and changes the state meanwhile
            async def go():
                await m._apply_lock.acquire()
                t = asyncio.ensure_future(m._proxy_autoname(Req(headers)))
                await asyncio.sleep(0.05)
                during(st)
                m._apply_lock.release()
                await t
            run = lambda: asyncio.run(go())  # noqa: E731
        else:
            run = lambda: asyncio.run(m._proxy_autoname(Req(headers)))  # noqa: E731
        with mock.patch.object(web.state, "load_state", side_effect=lambda: st), \
                mock.patch.object(web.state, "behind_proxy", side_effect=lambda s=None: (s or st).get("mode") == "domain"
                                  and ((s or st).get("domain") or {}).get("provider") == "proxy"), \
                mock.patch.object(web.state, "save_state", side_effect=save), \
                mock.patch.object(web.hw, "addresses", return_value=OWN), \
                mock.patch.object(web, "apply_proxy_addresses", apply):
            for _ in range(times):
                run()
        return apply, saved

    def test_first_visit_through_the_proxy_names_it(self):
        st = {**BEHIND, "proxy_autoname": True}
        apply, saved = self.run_it(st)
        apply.assert_awaited_once_with(["192.168.1.5"])
        self.assertIsNone(saved["proxy_autoname"])
        self.assertEqual(saved["proxy_autonamed"]["peer"], "192.168.1.5")

    def test_an_upgraded_server_is_never_changed_by_itself(self):
        apply, saved = self.run_it(dict(BEHIND))
        apply.assert_not_awaited()
        self.assertEqual(saved, {})

    def test_a_direct_visit_names_nothing(self):
        for via in ("", None):
            with self.subTest(via):
                apply, saved = self.run_it({**BEHIND, "proxy_autoname": True}, via=via)
                apply.assert_not_awaited()

    def test_a_refused_save_keeps_the_offer_and_retries_only_later(self):
        st = {**BEHIND, "proxy_autoname": True}
        apply, saved = self.run_it(st, ok=(False, "caddy said no"), times=3)
        self.assertEqual(apply.await_count, 1)  # once per 10 minutes, not on every page load
        self.assertTrue(st["proxy_autoname"])

    def test_judged_again_under_the_lock(self):
        for change in (lambda st: st.update(mode="anywhere"),                       # left proxy mode meanwhile
                       lambda st: st.update(domain={"provider": "proxy", "proxies": ["192.168.1.9"]}),  # named meanwhile
                       lambda st: st.update(proxy_autoname=None)):
            with self.subTest(change):
                apply, saved = self.run_it({**BEHIND, "proxy_autoname": True}, during=change)
                apply.assert_not_awaited()

    def test_the_first_try_right_after_boot(self):  # review: a monotonic clock under 600 s mustn't suppress it
        with mock.patch.object(self.web.time, "monotonic", return_value=5.0):
            apply, saved = self.run_it({**BEHIND, "proxy_autoname": True})
        apply.assert_awaited_once()

    def test_without_https_from_the_proxy_nothing_is_named(self):
        apply, saved = self.run_it({**BEHIND, "proxy_autoname": True}, proto=None)
        apply.assert_not_awaited()

    def test_the_owners_own_save_ends_it(self):
        src = (PKG / "web.py").read_text()
        body = src[src.index("    async def network_proxy("):src.index("    async def network_dashboard_access(")]
        self.assertIn("state.save_state(proxy_autoname=None)", body)


def _caddy() -> str | None:
    for c in (os.environ.get("TINHAT_TEST_CADDY"), shutil.which("caddy"), os.path.expanduser("~/so-caddy/caddy")):
        if c and os.access(c, os.X_OK):
            return c
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Echo(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({k.lower(): v for k, v in self.headers.items()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@unittest.skipUnless(_caddy(), "no caddy binary (TINHAT_TEST_CADDY)")
class CaddyInTheLoop(unittest.TestCase):
    """The product's dashboard-route lines (templates.CADDY_PROXY) through a real Caddy, the proxy connecting from
    127.0.0.2 and a visitor at home being 192.168.1.50."""

    PROXY = "127.0.0.2"

    @classmethod
    def setUpClass(cls):
        cls.echo = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Echo)
        threading.Thread(target=cls.echo.serve_forever, daemon=True).start()
        route = _dashboard_route()
        cls.lines = [ln.strip().replace("{{", "{").replace("}}", "}") for ln in route.splitlines()
                     if ln.strip().startswith("header_up")]

    @classmethod
    def tearDownClass(cls):
        cls.echo.shutdown()

    def caddy(self, words: str):
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        port = _free_port()
        (d / "Caddyfile").write_text(
            "{\n\tadmin off\n\tservers {\n\t\ttrusted_proxies static " + words + "\n\t\ttrusted_proxies_strict\n\t}\n}\n"
            f"http://127.0.0.1:{port} {{\n\treverse_proxy 127.0.0.1:{self.echo.server_address[1]} {{\n\t\t"
            + "\n\t\t".join(self.lines) + "\n\t}\n}\n")
        env = {**os.environ, "XDG_DATA_HOME": str(d), "XDG_CONFIG_HOME": str(d), "HOME": str(d)}
        proc = subprocess.Popen([_caddy(), "run", "--config", str(d / "Caddyfile"), "--adapter", "caddyfile"], env=env,
                                stdout=subprocess.DEVNULL, stderr=open(d / "caddy.log", "wb"))
        self.addCleanup(lambda: (proc.terminate(), proc.wait(10)))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        else:
            self.fail("caddy didn't start: " + (d / "caddy.log").read_text()[-500:])
        return port

    def get(self, port: int, headers: dict) -> dict:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10, source_address=(self.PROXY, 0))
        c.request("GET", "/admin/api/network", headers=headers)
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        return json.loads(r.read())

    def test_none_named_a_home_visitor_looks_like_the_proxy(self):
        """The bug, as Caddy really does it: the header the manager believes says the proxy."""
        h = self.get(self.caddy(owndomain_words([])), {"X-Forwarded-For": "192.168.1.50"})
        self.assertEqual(h["x-forwarded-for"], self.PROXY)
        self.assertEqual(h["x-tinhat-peer"], self.PROXY)
        # what the manager needs to see it: the X-Forwarded-For the request arrived with
        self.assertEqual(h.get("x-tinhat-via"), "192.168.1.50")

    def test_named_the_visitor_is_itself(self):
        port = self.caddy(owndomain_words([self.PROXY]))
        self.assertEqual(self.get(port, {"X-Forwarded-For": "192.168.1.50"})["x-forwarded-for"], "192.168.1.50")
        # a visitor's own header can't speak for it: the proxy appends, Caddy reads from the right
        self.assertEqual(self.get(port, {"X-Forwarded-For": "1.2.3.4, 192.168.1.50"})["x-forwarded-for"], "192.168.1.50")

    def test_a_direct_visit_arrives_with_nothing_and_a_sent_via_never_counts(self):
        port = self.caddy(owndomain_words([]))
        self.assertIn(self.get(port, {}).get("x-tinhat-via", ""), ("",))
        sent = self.get(port, {"X-Tinhat-Via": "9.9.9.9", "X-Tinhat-Via-Proto": "https", "X-Tinhat-Peer": "10.9.9.9"})
        self.assertEqual(sent.get("x-tinhat-via", ""), "")
        self.assertEqual(sent.get("x-tinhat-via-proto", ""), "")
        self.assertEqual(sent["x-tinhat-peer"], self.PROXY)
        h = self.get(port, {"X-Forwarded-For": "192.168.1.50", "X-Forwarded-Proto": "https"})
        self.assertEqual(h.get("x-tinhat-via-proto"), "https")


def owndomain_words(proxies: list[str]) -> str:
    """templates.proxy_words, without importing the whole templates module (its imports need the manager's package)."""
    src = (PKG / "templates.py").read_text()
    g: dict = {"re": re}
    exec(re.search(r"(_PROXY_WORD = .*?\n)", src).group(1), g)
    exec(src[src.index("def _proxy_list("):src.index("def admit_words(")], g)
    return g["proxy_words"](proxies)


if __name__ == "__main__":
    unittest.main()

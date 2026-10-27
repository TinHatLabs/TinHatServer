"""The headers every site sends (security review 2026-10-26, M3), HSTS only where the certificate is public, the one
place for Tin Hat Web's Content-Security-Policy, profiles for signed-in callers only, and who counts as the owner's
reverse proxy (templates.py).

Runs anywhere: the modules templates.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import http.client
import http.server
import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import pathlib
import sys
import types
import unittest
from unittest import mock

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        for m in ("config", "environment", "state"):
            sys.modules[f"tinhat.{m}"] = types.ModuleType(f"tinhat.{m}")
        hw = types.ModuleType("tinhat.hw")
        hw.addresses = lambda: ["192.168.1.30"]
        sys.modules["tinhat.hw"] = hw
        spec = importlib.util.spec_from_file_location("tinhat.templates", PKG / "templates.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.templates"] = mod
        spec.loader.exec_module(mod)
        return mod, hw
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


templates, HW = load()

# The policy the web lane verified for the web app (0 violations in two full runs on builder, 2026-10-26).
APP_CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data:; "
           "connect-src 'self' https: wss: blob: data:; worker-src 'self'; frame-src https://www.youtube-nocookie.com "
           "https://player.vimeo.com https://streamable.com https://clips.twitch.tv https://player.twitch.tv "
           "https://open.spotify.com https://embed.music.apple.com https://w.soundcloud.com; object-src 'none'; "
           "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"
SECRETS = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
           "postgres_password": "pg"}
HSTS = 'header Strict-Transport-Security "max-age=31536000"'


def lan():
    return templates.caddy_lan("home.local")


def anywhere():
    return templates.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, False)


def proxy(proxies=None, shared=False, port=8080):
    pkg = types.ModuleType("tinhat")  # caddy_proxy imports hw at call time: this machine's address is 192.168.1.30
    pkg.__path__, pkg.hw = [str(PKG)], HW
    with mock.patch.dict(sys.modules, {"tinhat": pkg, "tinhat.hw": HW}):
        return templates.caddy_proxy("chat.example.com", port, shared, proxies)


def block(text, opener):
    """The text of the block that starts with `opener` (balanced braces)."""
    i = text.index(opener)
    depth, j = 0, i
    while True:
        c = text[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
        j += 1


def sites(caddyfile):
    """Every site block's text (https://… and :port / http://:port), in order."""
    out, i = [], 0
    lines = caddyfile.split("\n")
    for n, line in enumerate(lines):
        if line and not line[0].isspace() and line.endswith("{") and (line.startswith("https://") or line.startswith(":")
                                                                       or line.startswith("http://")):
            out.append(block(caddyfile, line))
    return out


class Headers(unittest.TestCase):
    def test_the_snippet_frames_only_the_same_origin_and_never_overrides(self):
        for name, caddy in (("lan", lan()), ("anywhere", anywhere()), ("proxy", proxy()), ("proxy named", proxy(["192.168.50.2"]))):
            with self.subTest(mode=name):
                snip = block(caddy, "(tinhat_headers) {")
                for line in ("-Server", "Referrer-Policy no-referrer", "X-Content-Type-Options nosniff"):
                    self.assertIn(f"\t\t{line}\n", snip)
                # `?` = only when the response has none: the dashboard's own CSP (frame-ancestors 'none') and the clip
                # routes' sandbox CSP are never replaced. One `?` per directive: in one block Caddy would add them
                # only when ALL were absent.
                self.assertIn("\n\theader ?X-Frame-Options SAMEORIGIN\n", snip)
                self.assertIn("\n\theader ?Content-Security-Policy \"frame-ancestors 'self'\"\n", snip)
                self.assertNotIn("\t\t?", snip)
                self.assertNotIn("Content-Security-Policy", snip.replace("header ?Content-Security-Policy", ""))
                self.assertNotIn("X-Frame-Options", snip.replace("header ?X-Frame-Options", ""))
                self.assertEqual(caddy.count("(tinhat_headers) {"), 1)
                self.assertNotIn("{headers_snippet}", caddy)

    def test_every_site_imports_the_headers(self):
        for name, caddy in (("lan", lan()), ("anywhere", anywhere()), ("proxy", proxy()), ("proxy shared", proxy(shared=True))):
            with self.subTest(mode=name):
                found = sites(caddy)
                self.assertTrue(found)
                for site in found:
                    self.assertIn("\timport tinhat_headers\n", site, site.split("\n", 1)[0])

    def test_former_names_import_them_too(self):
        out = templates.with_former_names(anywhere(), "maplehouse.tinhat.me",
                                          [("home.local", "internal"), ("old.example.com", "\t\tdns cloudflare x\n")])
        for site in sites(out):
            self.assertIn("\timport tinhat_headers\n", site, site.split("\n", 1)[0])


class StrictTransportSecurity(unittest.TestCase):
    def test_public_certificate_only(self):
        main = block(anywhere(), "https://maplehouse.tinhat.me {")
        self.assertEqual(main.count(HSTS), 1)
        self.assertEqual(anywhere().count(HSTS), 1)  # the main site only: never on port 80
        self.assertNotIn("Strict-Transport-Security", lan())  # the server's own CA (.local)
        # behind the owner's reverse proxy: its HTTPS, its HSTS policy
        self.assertNotIn("Strict-Transport-Security", proxy())
        self.assertNotIn("Strict-Transport-Security", proxy(["192.168.50.2"]))

    def test_former_names(self):
        out = templates.with_former_names(anywhere(), "maplehouse.tinhat.me",
                                          [("home.local", "internal"), ("old.example.com", "\t\tdns cloudflare x\n")])
        self.assertEqual(block(out, "https://old.example.com {").count(HSTS), 1)
        self.assertNotIn("Strict-Transport-Security", block(out, "https://home.local {"))
        lan_moved = templates.with_former_names(lan(), "home2.local", [("home.local", "internal")])
        self.assertNotIn("Strict-Transport-Security", lan_moved)


class WebAppCSP(unittest.TestCase):
    """The web app's policy comes with the bundle it fits: csp-ready.json at the web root (the web lane's build writes
    it), never with an older bundle."""

    def marker(self, content):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        if content is not None:
            data = content if isinstance(content, bytes) else (content if isinstance(content, str) else json.dumps(content)).encode()
            (pathlib.Path(d.name) / "csp-ready.json").write_bytes(data)
        return d.name

    def test_no_marker_no_app_csp(self):
        self.assertEqual(templates.web_app_csp(self.marker(None)), "")
        self.assertEqual(templates.web_app_csp(), "")  # no web folder known (config stubbed): nothing
        for caddy in (lan(), anywhere(), proxy()):
            self.assertNotIn("\theader Content-Security-Policy", caddy)
            self.assertNotIn("{web_csp}", caddy)
            self.assertIn("header ?Content-Security-Policy \"frame-ancestors 'self'\"", caddy)  # the default stays

    def test_the_bundles_policy_goes_with_the_web_app_files_only_in_every_mode(self):
        d = self.marker({"csp": 1, "policy": APP_CSP})
        self.assertEqual(templates.web_app_csp(d), APP_CSP)
        with mock.patch.object(templates, "web_app_csp", return_value=APP_CSP):
            for name, caddy in (("lan", lan()), ("anywhere", anywhere()), ("proxy", proxy())):
                with self.subTest(mode=name):
                    line = f'\t\theader Content-Security-Policy "{APP_CSP}"\n'
                    self.assertEqual(caddy.count(line), 1)
                    web = caddy[caddy.index("root * /srv/web"):]
                    self.assertTrue(web.startswith(f"root * /srv/web\n{line}"), "inside the web app's own handle")
                    self.assertEqual(caddy.count("Content-Security-Policy"), 2, "this one + the site-wide ? default")
                    for other in ("handle /_matrix/* {", "@admin path /admin /admin/*", "handle_path /api/* {"):
                        self.assertNotIn(APP_CSP, block(caddy, other))

    def test_a_marker_that_doesnt_check_out_means_no_app_csp_and_a_log_line(self):
        for bad in ("not json", b"\xff\xfe", [], {"csp": 2, "policy": APP_CSP}, {"csp": True, "policy": APP_CSP},
                    {"csp": 1}, {"csp": 1, "policy": 7}, {"policy": APP_CSP},
                    {"csp": 1, "policy": 'default-src "self"; frame-ancestors x'},
                    {"csp": 1, "policy": "frame-ancestors 'none'\nimport evil"},
                    {"csp": 1, "policy": "frame-ancestors {env.X}"}, {"csp": 1, "policy": "frame-ancestors 'none' \\"},
                    {"csp": 1, "policy": "frame-ancestors 'none'`"}, {"csp": 1, "policy": "default-src 'self'"},
                    {"csp": 1, "policy": "default-src 'self'; frame-ancestors 'none'; x " + "a" * 20000}):
            with self.subTest(marker=str(bad)[:60]):
                with self.assertLogs("tinhat.templates", "WARNING"):
                    self.assertEqual(templates.web_app_csp(self.marker(bad)), "")

    def test_web_csp_line_never_writes_a_bad_value(self):
        for bad in ('default-src "self"; frame-ancestors x', "frame-ancestors 'self'\nimport evil", "frame-ancestors {env.X}",
                    "default-src 'self'"):
            with self.subTest(csp=bad), self.assertLogs("tinhat.templates", "WARNING"):
                self.assertEqual(templates.web_csp_line(bad), "")
        self.assertEqual(templates.web_csp_line(""), "")
        self.assertEqual(templates.web_csp_line(APP_CSP), f'\t\theader Content-Security-Policy "{APP_CSP}"\n')


class Profiles(unittest.TestCase):
    def test_signed_in_callers_only(self):
        for fed in (None, ["friends.example"]):
            y = templates.homeserver_yaml("crew.test", SECRETS, {}, fed)
            self.assertEqual(y.count("\nrequire_auth_for_profile_requests: true\n"), 1)
            # noted, not changed (New DM by username looks people up before a shared room exists)
            self.assertNotIn("\nlimit_profile_requests_to_users_who_share_rooms:", y)


class ProxyTrust(unittest.TestCase):
    def test_unnamed_stays_exactly_as_before(self):
        out = proxy()
        self.assertIn("\t\ttrusted_proxies static private_ranges 192.168.1.30/32\n", out)
        self.assertIn("\t@home remote_ip private_ranges 192.168.1.30/32\n", out)

    def test_named_proxy_replaces_the_home_network(self):
        out = proxy(["192.168.50.2", "fd12:3456:789a::5", "10.1.2.0/28"])
        # whose X-Forwarded-For counts: exactly the named proxy (and this machine's own addresses), not loopback
        self.assertIn("\t\ttrusted_proxies static 192.168.50.2 fd12:3456:789a::5 10.1.2.0/28 192.168.1.30/32\n", out)
        # who may connect: that, plus this machine's loopback (the updater's and setup's own checks: review of 116d103, #1)
        self.assertIn("\t@home remote_ip 192.168.50.2 fd12:3456:789a::5 10.1.2.0/28 127.0.0.0/8 ::1/128 192.168.1.30/32\n", out)
        self.assertEqual(templates.admit_words(["127.0.0.0/8", "10.0.0.1"]), "127.0.0.0/8 10.0.0.1 ::1/128")  # not twice
        self.assertEqual(templates.proxy_words(["127.0.0.1"]), "127.0.0.1")  # a proxy on this machine, named: believed
        self.assertNotIn("private_ranges", block(out, "http://:8080 {"))
        self.assertNotIn("trusted_proxies static private_ranges", out)

    def test_only_address_characters_reach_the_caddyfile(self):
        out = proxy(["evil}", "1.2.3.4 import x", 42, "{env.HOME}"])
        self.assertIn("trusted_proxies static private_ranges 192.168.1.30/32", out)  # nothing valid: as before
        self.assertEqual(templates.proxy_words(["10.0.0.1", "x;y"]), "10.0.0.1")
        self.assertEqual(templates.admit_words(["10.0.0.1", "x;y"]), "10.0.0.1 127.0.0.0/8 ::1/128")

    def test_the_dashboard_learns_where_the_proxy_connects_from(self):
        out = proxy(["192.168.50.2"])
        admin = block(out, "handle @admin {")
        self.assertIn("header_up X-Tinhat-Peer {remote_host}", admin)
        self.assertEqual(out.count("X-Tinhat-Peer"), 1)  # the dashboard's route only
        for caddy in (lan(), anywhere()):
            self.assertNotIn("X-Tinhat-Peer", caddy)


CADDY = os.environ.get("TINHAT_TEST_CADDY")


def free_port() -> int:
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


class UpdaterHealthCheck(unittest.TestCase):
    def test_the_updater_checks_the_proxy_port_from_loopback(self):
        # what CaddyRunsIt below sends: the updater's own URL (it runs the INSTALLED code, so it must keep working)
        src = (PKG / "updater.py").read_text()
        self.assertIn('_http_ok("http://127.0.0.1:8080/_matrix/client/versions")', src)
        self.assertIn('f"http://127.0.0.1:{port}/_matrix/client/versions", headers={"Host": sn}', (PKG / "install.py").read_text())


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyRunsIt(unittest.TestCase):
    """Real Caddy (the tinhat/caddy image's 2.10.2) in proxy mode with a NAMED proxy: this machine's loopback still
    reaches the proxy port (the updater's health check and setup's self-check: review of 116d103, #1), but only the
    named proxy's X-Forwarded-For is believed, and a caller can't put an address of its own choosing to the right of
    the one the proxy appends (second review, #5)."""

    def run_caddy(self, proxies, requests):
        """Caddy with `proxies` named, in front of a fake Synapse that records the X-Forwarded-For it is handed; each
        request is (source address, headers) to /_matrix/client/versions. -> [(status, X-Forwarded-For upstream)]."""
        seen = []

        class Synapse(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("X-Forwarded-For"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"versions": ["v1.11"]}')

            def log_message(self, *a):
                pass
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Synapse)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        port = free_port()
        cf = proxy(proxies, shared=True, port=port)
        cf = cf.replace("admin unix//config/caddy-admin.sock", "admin off")
        cf = cf.replace("127.0.0.1:8008", f"127.0.0.1:{upstream.server_address[1]}")
        out = []
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / "Caddyfile").write_text(cf)
            env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
            caddy = subprocess.Popen([CADDY, "run", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
            try:
                for source, headers in requests:
                    status = None
                    for _ in range(100):
                        before = len(seen)
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2, source_address=(source, 0))
                        try:
                            conn.request("GET", "/_matrix/client/versions", headers={"Host": "chat.example.com", **headers})
                            status = conn.getresponse().status
                            break
                        except OSError:
                            time.sleep(0.1)
                        finally:
                            conn.close()
                    out.append((status, seen[before] if len(seen) > before else None))
            finally:
                caddy.terminate()
                try:
                    caddy.wait(10)
                except subprocess.TimeoutExpired:
                    caddy.kill()
                upstream.shutdown()
        return out

    def test_named_proxy_keeps_loopback_in(self):
        cf = proxy(["192.168.1.5"], shared=True)
        self.assertIn("@home remote_ip 192.168.1.5 127.0.0.0/8 ::1/128", cf)
        [(status, xff)] = self.run_caddy(["192.168.1.5"], [("127.0.0.1", {})])
        self.assertEqual(status, 200, "the updater's and setup's own check from 127.0.0.1")
        self.assertEqual(xff, "127.0.0.1")

    def test_a_spoofed_forwarded_for_through_the_named_proxy(self):
        # the named proxy is 127.0.0.2 here (any 127/8 address is this machine's): it appends the caller it saw
        got = self.run_caddy(["127.0.0.2"], [
            ("127.0.0.2", {"X-Forwarded-For": "127.0.0.1, 198.51.100.7"}),
            ("127.0.0.2", {"X-Forwarded-For": "10.0.0.1, ::1, 127.0.0.1, 198.51.100.8"}),
            ("127.0.0.2", {"X-Forwarded-For": "198.51.100.9, 127.0.0.2"}),
            # loopback that isn't the named proxy: it may connect, but what it writes isn't believed
            ("127.0.0.1", {"X-Forwarded-For": "198.51.100.10"}),
            ("127.0.0.1", {"X-Forwarded-For": "198.51.100.11, 127.0.0.2"}),
        ])
        self.assertEqual(got[0], (200, "198.51.100.7"), "the caller the proxy appended, nothing to its left")
        self.assertEqual(got[1], (200, "198.51.100.8"))
        self.assertEqual(got[2], (200, "198.51.100.9"), "the proxy's own address in the chain is skipped")
        self.assertEqual(got[3], (200, "127.0.0.1"), "unnamed loopback: connects, its header isn't believed")
        self.assertEqual(got[4], (200, "127.0.0.1"))

if __name__ == "__main__":
    unittest.main()

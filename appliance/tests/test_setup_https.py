"""P2 (assembly-038 / NEXT-ROUND "Dashboard access"): no secret-taking setup step over plain http on a public address.
A VPS owner's first page is http://<address>/: the setup code, the owner's password, a backup's password and the setup
cookie go only over https (the setup page's own self-signed certificate, setuptls.py, whose fingerprint install.sh
prints) or over plain http from the home network / this machine (an SSH tunnel).

The certificate and template parts need openssl / nothing; the manager parts need the real aiohttp (skipped where it
isn't installed). With TINHAT_TEST_CADDY=/path/to/caddy the setup Caddyfiles are adapted by Caddy itself.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import ipaddress
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
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
from tinhat import access, config, hw, setuptls, state, templates  # noqa: E402
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

CADDY = os.environ.get("TINHAT_TEST_CADDY")
OPENSSL = shutil.which("openssl")
REAL = dict(_real)  # every test runs with these in place (mock.patch.dict)


class Real(unittest.TestCase):
    """Runs each test with the real tinhat modules in sys.modules (the code under test imports some at call time)."""
    def setUp(self):
        p = mock.patch.dict(sys.modules, REAL)
        p.start()
        self.addCleanup(p.stop)
ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


@unittest.skipUnless(OPENSSL, "needs openssl")
class Certificate(Real):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.dir.name)
        self.p = [mock.patch.object(setuptls, "DIR", d), mock.patch.object(setuptls, "CERT", d / "cert.pem"),
                  mock.patch.object(setuptls, "KEY", d / "key.pem"),
                  mock.patch.object(setuptls, "FINGERPRINT_FILE", d / "fp"),
                  mock.patch.object(hw, "addresses", lambda: ["203.0.113.5"]),
                  mock.patch.object(hw, "ipv6_addresses", lambda: ["2001:db8::5"])]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        self.dir.cleanup()

    def test_made_once_and_kept(self):
        with mock.patch.dict(sys.modules, REAL):
            fp = setuptls.ensure()
        self.assertRegex(fp, r"^([0-9A-F]{2}:){31}[0-9A-F]{2}$")
        self.assertEqual(setuptls.FINGERPRINT_FILE.read_text().strip(), fp)
        self.assertEqual(oct(setuptls.KEY.stat().st_mode & 0o777), "0o600")
        # what a browser shows: openssl's own SHA-256 fingerprint of the same certificate
        r = subprocess.run([OPENSSL, "x509", "-in", str(setuptls.CERT), "-noout", "-fingerprint", "-sha256"],
                           capture_output=True, text=True)
        self.assertEqual(r.stdout.strip().split("=", 1)[1], fp)
        text = subprocess.run([OPENSSL, "x509", "-in", str(setuptls.CERT), "-noout", "-text"], capture_output=True,
                              text=True).stdout
        for san in ("IP Address:127.0.0.1", "IP Address:203.0.113.5", "IP Address:2001:DB8:0:0:0:0:0:5"):
            self.assertIn(san, text)
        self.assertTrue(setuptls.made)  # bring_up reloads Caddy with --force for a new certificate
        with mock.patch.dict(sys.modules, REAL):
            self.assertEqual(setuptls.ensure(), fp, "kept: install.sh printed this one")
        self.assertEqual(setuptls.short(fp), f"{fp[:11]} ... {fp[-11:]}")

    def test_no_openssl_no_private_page(self):
        with mock.patch.object(setuptls.shutil, "which", lambda n: None):
            self.assertIsNone(setuptls.ensure())
        self.assertFalse(setuptls.available())
        self.assertFalse(setuptls.FINGERPRINT_FILE.exists())


class SetupCaddyfiles(Real):
    def test_setup_with_its_own_https(self):
        cf = templates.CADDY_SETUP_TLS
        self.assertIn("\nhttps:// {\n\ttls /data/tinhat-setup/cert.pem /data/tinhat-setup/key.pem\n", cf)
        self.assertEqual(cf.count("reverse_proxy 127.0.0.1:8090"), 2)
        self.assertEqual(cf.count("import tinhat_manager_limits"), 2)
        self.assertEqual(cf.count("(tinhat_manager_limits) {"), 1)
        self.assertTrue(cf.startswith("# Tin Hat Server — not set up yet"))  # web.setup_caddyfile rewrites only these
        self.assertNotIn("https://", templates.CADDY_SETUP)

    def public(self, phase, cert, ready_ago=None):
        import time
        doc = {"phase": phase, "mode": "anywhere"}
        if ready_ago is not None:
            doc["ready_at"] = int(time.time()) - ready_ago
        state.write_json(config.STATE_FILE, doc, 0o644)
        with mock.patch.dict(sys.modules, REAL), mock.patch.object(setuptls, "available", lambda: cert), \
                mock.patch.object(hw, "ipv6_nets", lambda: []), mock.patch.object(hw, "addresses", lambda: ["192.168.1.30"]), \
                mock.patch.object(hw, "ipv6_addresses", lambda: ["2001:db8::30"]):
            return {"from anywhere": templates.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, False),
                    "own domain": templates.caddy_domain("chat.example.com", "\t\tdns cloudflare abc\n", DIRECTORY, False),
                    "behind the owner's proxy": templates.caddy_proxy("chat.example.com", 8080)}

    def tearDown(self):
        config.STATE_FILE.unlink(missing_ok=True)

    def test_public_modes_keep_it_only_while_installing(self):
        for mode, cf in self.public("installing", True).items():
            with self.subTest(mode):
                site = cf[cf.index("\nhttps:// {"):]
                if "proxy" in mode:  # next to the box's own https on loopback: the machine's own addresses only
                    self.assertIn("\tbind 192.168.1.30 2001:db8::30\n", site)
                else:  # the named site gets a TLS policy of its own (else it took the setup certificate)
                    self.assertIn("\t\tprotocols tls1.2 tls1.3\n", cf)
                self.assertIn("@setup path / /admin/ui/* /admin/setup/*", site)
                self.assertIn("redir https://", site)
                self.assertIn("import tinhat_manager_limits", site)
                self.assertNotIn("/_matrix", site)
        # a Caddyfile written within the grace after setup keeps it; after it, not
        for mode, cf in self.public("ready", True, ready_ago=60).items():
            with self.subTest(mode=mode, grace=True):
                self.assertIn("tinhat-setup", cf)
        for mode, cf in self.public("ready", True, ready_ago=3600).items():
            with self.subTest(mode=mode, grace=False):
                self.assertNotIn("tinhat-setup", cf)
        for phase, cert in (("ready", True), ("installing", False)):
            for mode, cf in self.public(phase, cert).items():
                with self.subTest(mode=mode, phase=phase, cert=cert):
                    self.assertNotIn("https:// {", cf)
                    self.assertNotIn("tinhat-setup", cf)
                    self.assertNotIn("protocols tls1.2", cf)  # the ready file stays as before

    @unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
    def test_caddy_adapts_them(self):
        files = {"setup": templates.CADDY_SETUP_TLS, **self.public("installing", True)}
        for mode, cf in files.items():
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                (pathlib.Path(d) / "Caddyfile").write_text(cf)
                env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
                r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                   capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-1500:])
                conf = json.loads(r.stdout)
                # every server holding the setup certificate's catch-all policy matches the named site by SNI first
                for name, srv in conf["apps"]["http"]["servers"].items():
                    pols = srv.get("tls_connection_policies") or []
                    tagged = [i for i, p in enumerate(pols) if (p.get("certificate_selection") or {}).get("any_tag")]
                    hosts = {h for r in srv.get("routes") or [] for m in r.get("match") or [] for h in m.get("host") or []}
                    if tagged and hosts:
                        sni = [i for i, p in enumerate(pols) if set((p.get("match") or {}).get("sni") or []) & hosts]
                        self.assertTrue(sni and max(sni) < min(tagged), (mode, name, pols))
                files = conf["apps"]["tls"]["certificates"]["load_files"]
                self.assertTrue(any(f.get("certificate") == "/data/tinhat-setup/cert.pem"
                                    and f.get("key") == "/data/tinhat-setup/key.pem" for f in files), files)
                self.assertIn(":443", json.dumps(conf["apps"]["http"]["servers"]))




@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class Manager(Real):
    def setUp(self):
        super().setUp()
        state.write_json(config.STATE_FILE, {"phase": "unconfigured"}, 0o644)
        config.SETUP_CODE_FILE.write_text("1234-5678\n")
        self.p = [mock.patch.object(web, "_home_nets", lambda: [ipaddress.ip_network("2001:db8:aa:1::/64")]),
                  mock.patch.object(web, "_proxies", lambda: None)]
        for x in self.p:
            x.start()
        self.m = web.Manager()

    def tearDown(self):
        for x in self.p:
            x.stop()
        config.STATE_FILE.unlink(missing_ok=True)
        config.SETUP_CODE_FILE.unlink(missing_ok=True)

    def req(self, method, path, ip, proto, body=None, cookie=None):
        headers = {"X-Forwarded-For": ip, "X-Forwarded-Proto": proto, "X-Tinhat": "1"}
        if cookie:
            headers["Cookie"] = f"{web.SETUP_COOKIE}={cookie}"
        r = make_mocked_request(method, path, headers=headers)
        if body is not None:
            async def js():
                return body
            r.json = js
        return r

    def run_(self, coro):
        return asyncio.run(coro)

    def test_secret_ok(self):
        ok = lambda ip, proto: web._secret_ok(self.req("GET", "/", ip, proto))  # noqa: E731
        self.assertTrue(ok("203.0.113.9", "https"))
        self.assertTrue(ok("192.168.1.20", "http"))
        self.assertTrue(ok("127.0.0.1", "http"), "an SSH tunnel")
        self.assertTrue(ok("2001:db8:aa:1::9", "http"), "the home network's global IPv6")
        self.assertFalse(ok("203.0.113.9", "http"))
        self.assertFalse(ok("2001:db8:ff::9", "http"))

    def test_the_code_never_over_plain_http_from_outside(self):
        resp = self.run_(self.m.setup_unlock(self.req("POST", "/admin/setup/unlock", "203.0.113.9", "http",
                                                      {"code": "1234-5678"})))
        self.assertEqual(resp.status, 403)
        self.assertNotIn("Set-Cookie", resp.headers)
        # refused before the code was read or counted: a right code over http doesn't burn a try either
        self.assertFalse(self.m.fails.limited("unlock", "203.0.113.9", 600, 1, overall=False))
        resp = self.run_(self.m.setup_unlock(self.req("POST", "/admin/setup/unlock", "203.0.113.9", "https",
                                                      {"code": "1234-5678"})))
        self.assertEqual(resp.status, 200)
        c = resp.cookies[web.SETUP_COOKIE]
        self.assertTrue(c["secure"])
        self.assertTrue(c["httponly"])
        tok = c.value
        # the cookie works over https from outside, never over plain http from outside
        self.assertTrue(self.m._setup_ok(self.req("GET", "/", "203.0.113.9", "https", cookie=tok)))
        self.assertFalse(self.m._setup_ok(self.req("GET", "/", "203.0.113.9", "http", cookie=tok)))
        # at home over http: as before (no Secure flag: the page is http)
        resp = self.run_(self.m.setup_unlock(self.req("POST", "/admin/setup/unlock", "192.168.1.20", "http",
                                                      {"code": "1234-5678"})))
        self.assertEqual(resp.status, 200)
        self.assertFalse(resp.cookies[web.SETUP_COOKIE]["secure"])

    def test_status_tells_the_page(self):
        with mock.patch.object(setuptls, "available", lambda: True):
            out = json.loads(self.run_(self.m.setup_status(self.req("GET", "/admin/setup/status", "203.0.113.9", "http"))).text)
            self.assertTrue(out["plainOutside"])
            self.assertTrue(out["secureSetup"])
            self.assertFalse(out["unlocked"])
            for k in ("progress", "addresses", "owner"):
                self.assertNotIn(k, out)
            for ip, proto in (("203.0.113.9", "https"), ("192.168.1.20", "http")):
                out = json.loads(self.run_(self.m.setup_status(self.req("GET", "/admin/setup/status", ip, proto))).text)
                self.assertNotIn("plainOutside", out)
        with mock.patch.object(setuptls, "available", lambda: False):
            out = json.loads(self.run_(self.m.setup_status(self.req("GET", "/admin/setup/status", "203.0.113.9", "http"))).text)
            self.assertFalse(out["secureSetup"])

    def test_install_and_restore_need_the_private_page(self):
        tok = self.m.setup_sessions.new("setup")
        for path, handler in (("/admin/setup/install", self.m.setup_install),
                              ("/admin/setup/restore/password", self.m.restore_password)):
            resp = self.run_(handler(self.req("POST", path, "203.0.113.9", "http", {"admin": {"password": "hunter22"}},
                                              cookie=tok)))
            self.assertEqual(resp.status, 401, path)  # refused as "no setup session", before the body is read

    def test_the_setup_site_goes_half_an_hour_after_setup(self):
        config.CADDYFILE.parent.mkdir(parents=True, exist_ok=True)
        config.CADDYFILE.write_text("https:// {\n\ttls /data/tinhat-setup/cert.pem /data/tinhat-setup/key.pem\n")
        calls = []

        async def apply(change=None):
            calls.append(1)
            return True, ""

        async def go():
            m = SimpleNamespace(mover=SimpleNamespace(running=False), _apply_lock=asyncio.Lock())
            await web._drop_setup_site(m)
        import time
        # ready_at (this install's or restore's end), never installed_at: a restore keeps the old server's
        # installed_at (follow-up review #8)
        for ago, want in ((60, 0), (3600, 1)):
            state.write_json(config.STATE_FILE, {"phase": "ready", "mode": "anywhere", "ready_at": int(time.time()) - ago,
                                                 "installed_at": "2025-01-01T00:00:00+00:00"}, 0o644)
            calls.clear()
            with mock.patch.object(web, "_apply_with_caddy", apply):
                asyncio.run(go())
            self.assertEqual(len(calls), want, ago)

    def test_owner_address_for_the_access_question(self):
        tok = self.m.setup_sessions.new("setup")
        out = json.loads(self.run_(self.m.setup_status(self.req("GET", "/admin/setup/status", "203.0.113.9", "https",
                                                                cookie=tok))).text)
        self.assertEqual(out["owner"], {"address": "203.0.113.9", "atHome": False})
        out = json.loads(self.run_(self.m.setup_status(self.req("GET", "/admin/setup/status", "2001:db8:5:6::7", "https",
                                                                cookie=tok))).text)
        self.assertEqual(out["owner"], {"address": "2001:db8:5:6::/64", "atHome": False})


if __name__ == "__main__":
    unittest.main()

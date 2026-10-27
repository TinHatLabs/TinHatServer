"""The phone apps' links (docs/DEEPLINKS.md): every mode serves /.well-known/apple-app-site-association and
/.well-known/assetlinks.json from /srv/wk as plain JSON, before the web app's catch-all (which would answer index.html);
the documents claim only the web app's room / profile / invitation routes; the names service serves the same two at
tinhat.me; and dev.tinhat.server.web says where the web app is.

Runs anywhere (templates.py's own imports are stubbed). With TINHAT_TEST_CADDY=/path/to/caddy every mode is also
adapted by Caddy itself and the route that answers the two paths is checked in its JSON.
    python3 -m unittest discover -s appliance/tests
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

from test_manager_limits import CADDY, caddyfiles, stubs, templates

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATHS = ("/.well-known/apple-app-site-association", "/.well-known/assetlinks.json")
# the modes whose site is this server's own name (former names and preflights only redirect or wait)
SERVING = ("home network", "from anywhere", "from anywhere, relay, lab roots", "own domain", "own reverse proxy",
           "own reverse proxy on this machine", "moved, former names", "moving (preflight)",
           "moving behind a proxy (preflight)")


def block(cf: str, start: int) -> str:
    """The `{ … }` block that opens on the line at `start` (tabs decide where it ends)."""
    lines = cf[start:].splitlines()
    indent = lines[0][: len(lines[0]) - len(lines[0].lstrip("\t"))]
    end = next(i for i in range(1, len(lines)) if lines[i] == indent + "}")
    return "\n".join(lines[: end + 1])


class TheDocuments(unittest.TestCase):
    def test_apple(self):
        d = json.loads(templates.apple_app_site_association())
        details = d["applinks"]["details"]
        self.assertEqual(len(details), 1)
        self.assertEqual(details[0]["appIDs"], ["3XKTU7LCGT.dev.tinhat.TinHat"])
        comps = details[0]["components"]
        self.assertEqual([c["#"] for c in comps], ["/room/*", "/user/*", "/register", "/register?token=*"])
        for c in comps:  # only the web app's front page with one of its routes in the fragment
            self.assertEqual(c["/"], "/")
            self.assertNotIn("exclude", c)
        self.assertEqual(list(d), ["applinks"])  # links only: no webcredentials (a separate, domain-wide grant)
        self.assertNotIn("paths", details[0])  # the iOS 13+ form only

    def test_android(self):
        d = json.loads(templates.assetlinks())
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["relation"], ["delegate_permission/common.handle_all_urls"])  # no get_login_creds
        t = d[0]["target"]
        self.assertEqual((t["namespace"], t["package_name"]), ("android_app", "dev.tinhat.android"))
        self.assertEqual(len(t["sha256_cert_fingerprints"]), 1)
        self.assertRegex(t["sha256_cert_fingerprints"][0], r"^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$")
        self.assertTrue(t["sha256_cert_fingerprints"][0].startswith("C9:EC:B6:BA"))

    def test_the_names_service_serves_the_same(self):
        sys.path.insert(0, str(ROOT / "names"))
        try:
            from tinhat_names import applinks
        finally:
            sys.path.remove(str(ROOT / "names"))
        self.assertEqual(applinks.apple_app_site_association(), templates.apple_app_site_association())
        self.assertEqual(applinks.assetlinks(), templates.assetlinks())


class TheCaddyfiles(unittest.TestCase):
    def test_every_mode_serves_them_before_the_web_app(self):
        for mode, cf in caddyfiles().items():
            if mode not in SERVING:
                continue
            with self.subTest(mode):
                at = [m.start() for m in re.finditer(r"(?m)^\t+@applinks path ", cf)]
                # once per site of the server's own name (the proxy mode: once in the routes both of its sites import)
                self.assertTrue(at)
                for i in at:
                    line = cf[i:cf.index("\n", i)]
                    self.assertEqual(line.split()[2:], list(PATHS))
                    h = cf.index("handle @applinks {", i)
                    b = block(cf, cf.rindex("\n", 0, h) + 1)
                    self.assertIn("root * /srv/wk\n", b)
                    self.assertIn("header Content-Type application/json\n", b)
                    self.assertIn("file_server", b)
                    self.assertNotIn("redir", b)
                    self.assertNotIn("reverse_proxy", b)  # nothing to sign in to: the files themselves
                    # the web app's catch-all of the same site comes after it
                    rest = cf[h:]
                    self.assertIn("root * /srv/web", rest)

    def test_the_proxy_mode_has_them_in_the_routes_it_imports(self):
        with stubs():
            cf = templates.caddy_proxy("chat.example.com", 8080)
        routes = block(cf, cf.index("(tinhat_routes) {"))
        self.assertIn("handle @applinks {", routes)
        self.assertEqual(cf.count("handle @applinks {"), 1)

    def test_former_names_dont_claim_links(self):
        # a former name only redirects: its links open the browser, which lands on the new name
        cf = caddyfiles()["moved, former names"]
        for name in ("crew.local", "old.example.com"):
            site = block(cf, cf.index(f"https://{name} {{"))
            self.assertNotIn("@applinks", site)

    @unittest.skipUnless(CADDY, "TINHAT_TEST_CADDY not set")
    def test_caddy_routes_them_to_the_files(self):
        for mode in ("home network", "from anywhere", "own domain", "own reverse proxy"):
            cf = caddyfiles()[mode]
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                p = pathlib.Path(d) / "Caddyfile"
                p.write_text(cf)
                out = subprocess.run([CADDY, "adapt", "--config", str(p)], capture_output=True, text=True, check=True)
                doc = json.loads(out.stdout)
                found = []

                def walk(routes, depth=0):
                    for r in routes or []:
                        paths = [p for m in r.get("match") or [] for p in m.get("path") or []]
                        if set(PATHS) <= set(paths):
                            found.append(r)
                        for h in r.get("handle") or []:
                            walk(h.get("routes"), depth + 1)
                for srv in doc["apps"]["http"]["servers"].values():
                    walk(srv.get("routes"))
                self.assertTrue(found)
                for r in found:
                    text = json.dumps(r)
                    self.assertIn('"file_server"', text)
                    self.assertIn('"/srv/wk"', text)
                    self.assertIn('"application/json"', text)


class TheWellKnown(unittest.TestCase):
    def doc(self, **kw):
        return json.loads(templates.wellknown_client("chat.example.com", True, "0.3.5", **kw))["dev.tinhat.server"]

    def test_web_is_the_server_itself_by_default(self):
        self.assertEqual(self.doc()["web"], "https://chat.example.com")

    def test_web_elsewhere(self):
        self.assertEqual(self.doc(web="tinhat.example.com")["web"], "https://tinhat.example.com")

    def test_the_former_name_points_at_the_new_web_app(self):
        d = json.loads(templates.wellknown_former_client("new.example.com", True, "0.3.5", web="tinhat.example.com"))
        self.assertEqual(d["dev.tinhat.server"]["web"], "https://tinhat.example.com")
        self.assertEqual(d["dev.tinhat.moved_to"], "new.example.com")


if __name__ == "__main__":
    unittest.main()

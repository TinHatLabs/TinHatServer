"""The names service's DNS-01 settings go into the Caddyfile as bare words (templates.caddy_anywhere): only what they're
made of is accepted, so nothing that means something to Caddy (quotes, braces, comments, placeholders, line breaks)
can ride along, whoever sent it.

Runs anywhere: the modules templates.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import sys
import types
import unittest

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
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


templates = load()
GOOD = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


class PortEighty(unittest.TestCase):
    def test_the_name_typed_over_http_goes_to_https(self):
        out = templates.caddy_anywhere("maplehouse.tinhat.me", GOOD, DIRECTORY, False)
        site = out[out.index("\n:80 {"):]
        site = site[: site.index("\n}\n") + 3]
        self.assertIn("redir https://maplehouse.tinhat.me{uri} 308", site)  # the server's own name, never the asked Host
        # only the setup's own calls, from the home network, reach the manager (the browser that did the setup over
        # http keeps asking how it's going while the web server switches: found on a real home network, 2026-10-22)
        setup = site[site.index("@setup {"):]
        setup = setup[: setup.index("}")]
        self.assertIn("remote_ip private_ranges", setup)
        self.assertIn("path /admin/setup/*", setup)
        # (assembly-038) plus, from any address, only the setup's read-only progress: GET, that one path
        st = site[site.index("@setupstatus {"):]
        st = st[: st.index("}")]
        self.assertEqual([l.strip() for l in st.splitlines()[1:] if l.strip()],
                         ["method GET", "path /admin/setup/status", "not remote_ip private_ranges"])
        self.assertEqual(site.count("reverse_proxy"), 2)
        self.assertIn("reverse_proxy 127.0.0.1:8090", site[site.index("handle @setup {"):])
        self.assertIn("reverse_proxy 127.0.0.1:8090", site[site.index("handle @setupstatus {"):])
        h = site[site.index("handle @setupstatus {"):site.index("\thandle {")]
        self.assertIn("header_up X-Tinhat-Plain-Outside 1", h, "the manager cuts this answer down by this mark")
        self.assertNotIn("X-Tinhat-Plain-Outside", site[:site.index("handle @setupstatus {")], "never on the home route")
        self.assertLess(site.index("handle @setupstatus {"), site.index("\thandle {"), "the catch-all redirect comes last")
        self.assertNotIn("8008", site)  # never chat
        lines = [l.strip() for l in site.splitlines()]
        self.assertEqual(sum(l.endswith("{") for l in lines), sum(l == "}" for l in lines))


class AcmeValues(unittest.TestCase):
    def test_the_names_services_settings_render(self):
        out = templates.caddy_anywhere("maplehouse.tinhat.me", GOOD, DIRECTORY, False)
        for line in ("username b0x-Id_123", "password s3cr3t-Url_Safe", "subdomain maplehouse",
                     "server_url https://names.tinhat.dev"):
            self.assertIn(line, out)
        lab = {**GOOD, "server_url": "https://names.lab.example:8443/acme"}
        self.assertIn("server_url https://names.lab.example:8443/acme", templates.caddy_anywhere("x.tinhat.me", lab, DIRECTORY, False))

    def test_nothing_that_means_something_to_caddy(self):
        for key, bad in (("password", "x}"), ("password", 'a"b'), ("password", "a b"), ("password", "a\nimport x"),
                         ("username", "{$HOME}"), ("username", "a#b"), ("subdomain", ""),
                         ("server_url", "http://names.tinhat.dev"), ("server_url", "https://a b"),
                         ("server_url", "https://names.tinhat.dev/{x}")):
            with self.subTest(key=key, value=bad), self.assertRaises(ValueError):
                templates.caddy_anywhere("maplehouse.tinhat.me", {**GOOD, key: bad}, DIRECTORY, False)
        with self.assertRaises(ValueError):
            templates.caddy_anywhere("maplehouse.tinhat.me", {}, DIRECTORY, False)


if __name__ == "__main__":
    unittest.main()

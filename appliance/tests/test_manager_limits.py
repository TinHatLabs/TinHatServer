"""M15 stopgap: every Caddy route to the manager (127.0.0.1:8090) refuses compressed bodies and limits the body's size
and how long it may take to arrive; the restore upload keeps a whole backup's room (and no deadline), the speed test
its 110 MB; a Caddyfile that is only the manager (before setup) gets short header/idle timeouts; Synapse's, LiveKit's
and the API's routes are left alone.

Runs anywhere (templates.py's own imports are stubbed). With TINHAT_TEST_CADDY=/path/to/caddy (the tinhat/caddy
image's binary, 2.10.2), every Caddyfile is also adapted by Caddy itself and its JSON is checked route by route.
    python3 -m unittest discover -s appliance/tests
"""
import contextlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
CADDY = os.environ.get("TINHAT_TEST_CADDY")


@contextlib.contextmanager
def stubs():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        for m in ("config", "environment", "state"):
            sys.modules[f"tinhat.{m}"] = types.ModuleType(f"tinhat.{m}")
        sys.modules["tinhat.state"].load_state = lambda: {}  # the dashboard's access gate (access.py): anywhere
        sys.modules["tinhat.state"].public_mode = lambda st=None: False
        hw = types.ModuleType("tinhat.hw")
        hw.addresses = lambda: ["192.168.1.30"]
        hw.ipv6_nets = lambda: []
        sys.modules["tinhat.hw"] = hw
        pkg.hw = hw
        yield
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


with stubs():
    spec = importlib.util.spec_from_file_location("tinhat.templates", PKG / "templates.py")
    templates = importlib.util.module_from_spec(spec)
    sys.modules["tinhat.templates"] = templates
    spec.loader.exec_module(templates)

ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


def caddyfiles() -> dict:
    t = templates
    with stubs():
        anywhere = t.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, False)
        return {
            "setup": t.CADDY_SETUP,
            "setup behind a proxy": t.CADDY_SETUP_PROXY_ONLY,
            "home network": t.caddy_lan("crew.local"),
            "from anywhere": anywhere,
            "from anywhere, relay, lab roots": t.caddy_anywhere("maplehouse.tinhat.me", ACME, DIRECTORY, True,
                                                                 proxy_from="10.99.0.2"),
            "own domain": t.caddy_domain("chat.example.com", "\t\tdns cloudflare abcDEF123\n", DIRECTORY, False),
            "own reverse proxy": t.caddy_proxy("chat.example.com", 8080),
            "own reverse proxy on this machine": t.caddy_proxy("chat.example.com", 8080, shared=True),
            "moved, former names": t.with_former_names(anywhere, "maplehouse.tinhat.me",
                                                       [("crew.local", "internal"), ("old.example.com", "\t\tdns cloudflare abc\n")]),
            "moving (preflight)": anywhere + t.caddy_preflight("new.example.com", "\t\tdns cloudflare abc\n", DIRECTORY, False),
            "moving behind a proxy (preflight)": anywhere + t.caddy_proxy_preflight(8080, ["192.168.1.30"]),
        }


class TheText(unittest.TestCase):
    def test_every_route_to_the_manager_imports_the_limits(self):
        for mode, cf in caddyfiles().items():
            with self.subTest(mode):
                lines = cf.splitlines()
                to_manager = [i for i, l in enumerate(lines) if re.match(r"\t+reverse_proxy 127\.0\.0\.1:8090\b", l)]
                self.assertTrue(to_manager)
                # every mention of the manager's address is one of these (none written another way, none missed)
                self.assertEqual(cf.count("127.0.0.1:8090"), len(to_manager))
                self.assertFalse([l for l in lines if re.match(r"\s*route\b", l)])  # keeps the written order: none
                for i in to_manager:  # right after the directive (and its own block), in the same handle block
                    indent = lines[i][: len(lines[i]) - len(lines[i].lstrip("\t"))]
                    end = i if not lines[i].endswith("{") else next(
                        j for j in range(i + 1, len(lines)) if lines[j] == indent + "}")
                    self.assertEqual(lines[end + 1], f"{indent}import tinhat_manager_limits", f"line {i}: {lines[i]}")
                imports = [i for i, l in enumerate(lines) if l.strip() == "import tinhat_manager_limits"]
                self.assertEqual(len(imports), len(to_manager))  # nothing else gets them (Synapse, calls, the API)
                defs = [i for i, l in enumerate(lines) if l == "(tinhat_manager_limits) {"]
                self.assertEqual(len(defs), 1)
                self.assertLess(defs[0], imports[0])
                others = [i for i, l in enumerate(lines)
                          if i != defs[0] and l and not l[0].isspace() and l.endswith("{") and l != "{"]
                self.assertLess(defs[0], min(others))  # ahead of every other snippet and site that could import it

    def test_only_a_manager_only_caddyfile_changes_its_servers_timeouts(self):
        for mode, cf in caddyfiles().items():
            with self.subTest(mode):
                if mode.startswith("setup"):
                    head = cf[: cf.index("\n}\n")]
                    self.assertIn("\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tidle 2m\n\t\t}", head)
                else:
                    self.assertNotIn("read_header", cf)
                    self.assertNotIn("timeouts {", cf)

    def test_the_limits(self):
        s = templates.MANAGER_LIMITS
        self.assertIn('@tinhat_mgr_encoded header Content-Encoding *\n\trespond @tinhat_mgr_encoded', s)
        self.assertIn("415", s)
        restore = s[s.index("request_body @tinhat_mgr_restore {"):]
        restore = restore[: restore.index("}")]
        self.assertIn("max_size 1TB", restore)  # a whole server's backup
        self.assertNotIn("timeout", restore)  # over a slow network it may take hours
        speed = s[s.index("request_body @tinhat_mgr_speed {"):]
        self.assertIn("max_size 110MB", speed[: speed.index("}")])  # the manager itself stops at 100 MB
        other = s[s.index("@tinhat_mgr_other not path /admin/setup/restore/upload /admin/setup/speed/up"):]
        other = other[other.index("request_body"):]
        other = other[: other.index("}")]
        self.assertIn("max_size 1MB", other)
        self.assertNotIn("timeout", other)  # never for a bodiless request: it would cut a long response (HTTP/1.1)
        blocks = {}
        for name in ("sized", "chunked", "h2", "speed_sized", "speed_chunked", "speed_h2"):
            m = s[s.index(f"@tinhat_mgr_{name} {{"):]
            blocks[name] = (m[: m.index("}")], m[m.index(f"request_body @tinhat_mgr_{name} {{"):].split("}")[0])
        for name, (match, body) in blocks.items():
            with self.subTest(name):
                self.assertTrue("header_regexp Content-Length ^0*[1-9]" in match or "header Transfer-Encoding *" in match
                                or ("protocol http/2\n" in match and "not header Content-Length *" in match))
                self.assertIn("read_timeout 5m" if name.startswith("speed") else "read_timeout 30s", body)
                self.assertNotIn("max_size", body)
        self.assertEqual(s.count("read_timeout"), 6)

    def test_a_template_it_cant_place_them_in_is_refused_not_crashed(self):
        with self.assertRaises(ValueError):
            templates.limit_manager(":80 {\n\treverse_proxy 127.0.0.1:8090\n}\n", template=False)  # no global block
        with self.assertRaises(ValueError):
            templates.limit_manager("{\n}\n:80 {\n\treverse_proxy 127.0.0.1:8090 {\n", template=False)
        self.assertEqual(templates._limited("no global block\n", template=False), "no global block\n")

    def test_the_manager_routes_it_carves_out_exist(self):
        web = (PKG / "web.py").read_text()
        for path in ("/admin/setup/restore/upload", "/admin/setup/speed/up"):
            self.assertIn(f'r.add_post("{path}"', web)
        self.assertIn('handler_args={"auto_decompress": False}', web)  # and the manager itself never inflates one


def walk_routes(node, found):
    """Every list of routes in Caddy's JSON, with its handlers."""
    if isinstance(node, dict):
        if isinstance(node.get("routes"), list):
            found.append(node["routes"])
        for v in node.values():
            walk_routes(v, found)
    elif isinstance(node, list):
        for v in node:
            walk_routes(v, found)
    return found


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyAdaptsThem(unittest.TestCase):
    def test_caddy_takes_each_and_limits_only_the_manager(self):
        for mode, cf in caddyfiles().items():
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                (pathlib.Path(d) / "Caddyfile").write_text(cf)
                env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
                r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                   capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-1500:])
                conf = json.loads(r.stdout)
                checked = 0
                for routes in walk_routes(conf, []):
                    handlers = [h for rt in routes for h in rt.get("handle", [])]
                    order = [h.get("handler") for h in handlers]
                    for rt in routes:  # a body deadline only where the request has a body (Content-Length > 0, chunked)
                        # or is HTTP/2 without a Content-Length (a body with neither header; finding F, 0.3.4)
                        if any(h.get("handler") == "request_body" and h.get("read_timeout") for h in rt.get("handle", [])):
                            self.assertTrue(any("header_regexp" in m and "Content-Length" in m["header_regexp"]
                                                or "Transfer-Encoding" in (m.get("header") or {})
                                                or (m.get("protocol") == "http/2"
                                                    and {"header": {"Content-Length": ["*"]}} in (m.get("not") or []))
                                                for m in rt.get("match", [])),
                                            rt.get("match"))
                    dials = {u.get("dial") for h in handlers if h.get("handler") == "reverse_proxy"
                             for u in h.get("upstreams", [])}
                    bodies = [h for h in handlers if h.get("handler") == "request_body"]
                    if "127.0.0.1:8090" in dials:
                        checked += 1
                        sizes = sorted(h.get("max_size") for h in bodies if h.get("max_size"))
                        self.assertEqual(sizes, [1_000_000, 110_000_000, 1_000_000_000_000])
                        self.assertEqual(sorted(h.get("read_timeout") for h in bodies if h.get("read_timeout")),
                                         [30_000_000_000] * 3 + [300_000_000_000] * 3)
                        self.assertTrue(any(h.get("handler") == "static_response" and h.get("status_code") == 415
                                            for h in handlers))
                        # Caddy sorted them: the limits and the refusal come before the proxy
                        proxy = order.index("reverse_proxy")
                        self.assertLess(max(i for i, h in enumerate(order) if h in ("request_body", "static_response")),
                                        proxy)
                    elif dials & {"127.0.0.1:8008", "127.0.0.1:8070", "127.0.0.1:7880"}:
                        self.assertEqual(bodies, [])  # Synapse and calls: untouched
                self.assertGreater(checked, 0)
                servers = conf["apps"]["http"]["servers"]
                headers = {s.get("read_header_timeout") for s in servers.values()}
                self.assertEqual(headers, {10_000_000_000} if mode.startswith("setup") else {None})


if __name__ == "__main__":
    unittest.main()

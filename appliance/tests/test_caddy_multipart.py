"""Every route to Synapse refuses multipart/form-data in any spelling with 415, before Synapse sees it (GHSA-6wjm-
9p2x-gvpm: Synapse 1.145 refused only the lower-case spelling, and buffered any other in memory before auth; the
image carries upstream's fix too, build/synapse/backports/0001). templates.py's `tinhat_no_multipart` snippet, imported
first in each `handle` that proxies to 127.0.0.1:8008.

Always: every mode's Caddyfile (home network, a tinhat.me name, an own domain, behind the owner's proxy, shared or not,
with a former name) has the snippet once and imports it in every Synapse route; a route without it is caught (a
planted one). With TINHAT_TEST_CADDY (the tinhat/caddy image's caddy binary): real Caddy in proxy mode in front of a
fake Synapse and a fake API: every multipart spelling (mixed case, upper case, parameters, a second Content-Type
header, chunked) gets 415 and never reaches Synapse, JSON still does, and the API's own multipart upload still
reaches the API.
    python3 -m unittest discover -s appliance/tests -p test_caddy_multipart.py
"""
import http.client
import http.server
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import unittest

from test_security_headers import ACME, DIRECTORY, anywhere, free_port, lan, proxy, templates

SNIPPET = ("(tinhat_no_multipart) {\n"
           "\t@tinhat_multipart header_regexp Content-Type (?i)multipart/form-data\n"
           "\trespond @tinhat_multipart 415\n"
           "}\n")
IMPORT = "import tinhat_no_multipart"


def unguarded(caddyfile: str) -> list[str]:
    """The Synapse routes (a `handle` whose first proxy is 127.0.0.1:8008) whose first line isn't the import."""
    lines, bad = caddyfile.split("\n"), []
    for n, line in enumerate(lines):
        if line.strip().startswith("reverse_proxy 127.0.0.1:8008"):
            opener = next(k for k in range(n - 1, -1, -1) if lines[k].strip().startswith(("handle", "route")))
            if lines[opener + 1].strip() != IMPORT:
                bad.append(f"{lines[opener].strip()} (line {opener + 1})")
    return bad


def modes() -> dict[str, str]:
    out = {"home network": lan(), "tinhat.me name": anywhere(), "own proxy": proxy(), "own proxy, shared": proxy(shared=True),
           "own domain": templates.caddy_domain("chat.example.com", "\t\tdns cloudflare TOKEN\n", DIRECTORY, False)}
    out["home network + former name"] = templates.with_former_names(lan(), "home.local", [("old.local", "internal")])
    out["tinhat.me + former name"] = templates.with_former_names(anywhere(), "maplehouse.tinhat.me",
                                                                 [("old.example.com", "\t\tdns cloudflare TOKEN\n")])
    return out


class EveryMode(unittest.TestCase):
    def test_every_synapse_route_imports_the_guard(self):
        for name, cf in modes().items():
            with self.subTest(name):
                self.assertEqual(cf.count(SNIPPET), 1, "the snippet, defined once")
                routes = cf.count("reverse_proxy 127.0.0.1:8008")
                self.assertGreaterEqual(routes, 2, "/_matrix/* and /_synapse/client/*")
                self.assertEqual(unguarded(cf), [])
                self.assertEqual(cf.count(IMPORT), routes, "imported by Synapse routes only")

    def test_a_route_without_it_is_caught(self):
        """The planted positive: the check above can fail."""
        cf = lan()
        first = cf.index("\t\t" + IMPORT + "\n")
        broken = cf[:first] + cf[first + len("\t\t" + IMPORT + "\n"):]
        self.assertEqual(len(unguarded(broken)), 1)
        self.assertIn("handle /_matrix/*", unguarded(broken)[0])

    def test_the_former_site_too(self):
        cf = templates.with_former_names(lan(), "home.local", [("old.local", "internal")])
        site = cf[cf.index("https://old.local {"):]
        self.assertIn(f"handle /_matrix/* {{\n\t\t{IMPORT}\n\t\treverse_proxy 127.0.0.1:8008\n", site)


CADDY = os.environ.get("TINHAT_TEST_CADDY")


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyRefusesIt(unittest.TestCase):
    def test_every_spelling_gets_415_and_never_reaches_synapse(self):
        seen = {"synapse": [], "api": []}

        def backend(name):
            class H(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    n = int(self.headers.get("Content-Length") or 0)
                    if n:
                        self.rfile.read(n)
                    seen[name].append((self.path, self.headers.get_all("Content-Type")))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

                def log_message(self, *a):
                    pass
            s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
            threading.Thread(target=s.serve_forever, daemon=True).start()
            return s
        syn, api = backend("synapse"), backend("api")
        port = free_port()
        cf = proxy(None, shared=True, port=port).replace("admin unix//config/caddy-admin.sock", "admin off")
        cf = cf.replace("127.0.0.1:8008", f"127.0.0.1:{syn.server_address[1]}")
        cf = cf.replace("127.0.0.1:3001", f"127.0.0.1:{api.server_address[1]}")
        body = b"--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nb\r\n--x--\r\n"
        refused = [
            ("/_matrix/client/v3/login", ["multipart/form-data; boundary=x"]),
            ("/_matrix/client/v3/login", ["Multipart/Form-Data; boundary=x"]),
            ("/_matrix/client/v3/login", ["MULTIPART/FORM-DATA; boundary=x"]),
            ("/_matrix/media/v3/upload", ["mUlTiPaRt/fOrM-dAtA"]),
            ("/_matrix/client/v3/login", ["application/json", "Multipart/Form-Data; boundary=x"]),
            ("/_synapse/client/new_user_consent", ["Multipart/Form-Data; boundary=x"]),
        ]
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / "Caddyfile").write_text(cf)
            env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
            caddy = subprocess.Popen([CADDY, "run", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)

            def post(path, ctypes, chunked=False):
                for _ in range(100):
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    try:
                        conn.putrequest("POST", path, skip_host=True)
                        conn.putheader("Host", "chat.example.com")
                        for c in ctypes:
                            conn.putheader("Content-Type", c)
                        if chunked:
                            conn.putheader("Transfer-Encoding", "chunked")
                            conn.endheaders()
                            conn.send(b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body))
                        else:
                            conn.putheader("Content-Length", str(len(body)))
                            conn.endheaders()
                            conn.send(body)
                        return conn.getresponse().status
                    except (ConnectionRefusedError, ConnectionResetError):
                        time.sleep(0.1)
                    finally:
                        conn.close()
                return None
            try:
                for path, ctypes in refused:
                    with self.subTest(path=path, ctypes=ctypes):
                        self.assertEqual(post(path, ctypes), 415)
                self.assertEqual(post("/_matrix/client/v3/login", ["Multipart/Form-Data; boundary=x"], chunked=True), 415)
                self.assertEqual(seen["synapse"], [], "no multipart request reached Synapse")
                self.assertEqual(post("/_matrix/client/v3/login", ["application/json"]), 200)
                self.assertEqual(len(seen["synapse"]), 1, "JSON still reaches Synapse (the negative control)")
                self.assertEqual(post("/api/soundboard/upload", ["multipart/form-data; boundary=x"]), 200)
                self.assertEqual(len(seen["api"]), 1, "the API's own multipart upload isn't affected")
            finally:
                caddy.terminate()
                try:
                    caddy.wait(10)
                except subprocess.TimeoutExpired:
                    caddy.kill()
                syn.shutdown()
                api.shutdown()


if __name__ == "__main__":
    unittest.main()

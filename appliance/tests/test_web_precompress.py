"""The web app's files (templates.WEB_APP / WEB_FILES, build/precompress.py):
 - a hashed bundle file (/assets/*) that isn't there is a 404 nothing keeps (no-store), never index.html + immutable;
   the app's own routes still get index.html
 - a browser that takes brotli gets the build's FILE.br (zstd: FILE.zst), with FILE's own type, 200 (not Caddy
   2.10.2's 206), Vary: Accept-Encoding; any other browser gets FILE as before (on-the-fly encoding or none)
 - index.html is never immutable; /assets/* stay immutable
 - precompress.py makes side files only where they help and refuses any that doesn't decode to its file

Runs anywhere for the text and the build tool (needs the `brotli` and `zstd` commands for the tool's checks). With
TINHAT_TEST_CADDY=/path/to/caddy (2.10.2, the server image's) the web app block itself is served by Caddy from a
temporary folder and every answer is checked over HTTP, with negative controls.
    python3 -m unittest discover -s appliance/tests
"""
import gzip
import http.client
import importlib.util
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from test_manager_limits import caddyfiles, templates, CADDY

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("precompress", ROOT / "build/precompress.py")
precompress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(precompress)

TOOLS = shutil.which("brotli") and shutil.which("zstd")
SERVING = ("home network", "from anywhere", "from anywhere, relay, lab roots", "own domain", "own reverse proxy",
           "own reverse proxy on this machine", "moved, former names")
IMMUTABLE = 'Cache-Control "public, max-age=31536000, immutable"'


def block(text: str, start: int) -> str:
    """The brace block that opens on the line at `start`."""
    depth, i = 0, text.index("{", start)
    for j in range(i, len(text)):
        depth += {"{": 1, "}": -1}.get(text[j], 0)
        if depth == 0:
            return text[start:j + 1]
    raise ValueError("unclosed")


class TheText(unittest.TestCase):
    def test_every_mode_has_the_block_once_per_web_site(self):
        for mode, cf in caddyfiles().items():
            if mode not in SERVING:
                continue
            with self.subTest(mode):
                n = cf.count("\t\troot * /srv/web\n")
                self.assertGreaterEqual(n, 1)
                self.assertEqual(cf.count(templates.web_app_block()), n, "the same block everywhere")
                self.assertEqual(cf.count("\t\t\t@tinhat_web_gone {\n\t\t\t\tnot {\n\t\t\t\t\tfile\n\t\t\t\t\tnot path */\n"), n)
                self.assertEqual(cf.count(IMMUTABLE), n, "immutable once per block")

    def test_immutable_only_on_assets_that_are_there(self):
        web = templates.web_app_block("")
        assets = block(web, web.index("\t\thandle /assets/* {"))
        self.assertIn(f"header @tinhat_web_here {IMMUTABLE}", assets)
        self.assertIn("@tinhat_web_here {\n\t\t\t\tfile\n\t\t\t\tnot path */\n\t\t\t}\n", assets)
        self.assertIn("header @tinhat_web_gone Cache-Control no-store", assets)
        gone = block(assets, assets.index("handle @tinhat_web_gone {"))
        self.assertIn('respond "Not found" 404', gone)
        rest = web.replace(assets, "")
        self.assertNotIn("immutable", rest, "index.html and the app's other files: never immutable")
        self.assertIn('header @fresh Cache-Control "no-cache"', rest)
        self.assertIn("try_files {path} {path}index.html /index.html", rest, "the app's routes keep their fallback")
        self.assertNotIn("try_files", assets, "a missing asset never falls back to index.html")

    def test_the_kinds_match_the_build_tool(self):
        self.assertEqual(tuple(f".{e}" for e, _ in templates.WEB_TYPES), precompress.EXTENSIONS)
        for side in ("br", "zst"):
            m = re.search(rf"@tinhat_web_{side} {{\n\s*path ([^\n]+)\n", templates.WEB_FILES)
            self.assertEqual(m.group(1).split(), [f"*{e}" for e in precompress.EXTENSIONS])

    def test_accept_encoding(self):
        br = re.compile(templates._accepts("br"))
        for yes in ("br", "gzip, deflate, br, zstd", "gzip, deflate, br", "br;q=0.5, gzip", "BR", "gzip,br",
                    "br; q=1", "br;q=1.0", "br;q=0.001", "zstd, br ;q=0.9"):
            self.assertTrue(br.search(yes), yes)
        for no in ("gzip", "gzip, deflate, zstd", "br;q=0", "br;q=0.000", "gzip, br;q=0", "brotli", "x-br", ""):
            self.assertFalse(br.search(no), no)
        self.assertTrue(re.search(templates._accepts("zstd"), "gzip, deflate, zstd"))
        self.assertFalse(re.search(templates._accepts("zstd"), "gzip, zstd;q=0"))


@unittest.skipUnless(TOOLS, "brotli/zstd commands not installed")
class TheBuildTool(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)
        (self.d / "assets").mkdir()
        (self.d / "iconpack").mkdir()
        self.js = self.d / "assets/app-1a2b.js"
        self.js.write_text("export const x = 1;\n" * 2000)
        (self.d / "assets/tiny-9.js").write_text("export{}\n")
        (self.d / "assets/pic.png").write_bytes(b"\x89PNG" + os.urandom(4000))
        (self.d / "assets/noise-3.wasm").write_bytes(os.urandom(5000))  # doesn't compress: no side file
        (self.d / "index.html").write_text("<!doctype html>" + "<p>hi</p>" * 400)
        (self.d / "iconpack/a.svg").write_text("<svg>" + "<g/>" * 1000 + "</svg>")

    def make(self, *a):
        return subprocess.run([sys.executable, ROOT / "build/precompress.py", *a], capture_output=True, text=True)

    def test_make_then_verify(self):
        before = {p: p.read_bytes() for p in self.d.rglob("*") if p.is_file()}
        r = self.make("make", self.d)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.d / "assets/app-1a2b.js.br").is_file())
        self.assertTrue((self.d / "index.html.br").is_file())
        self.assertFalse((self.d / "assets/app-1a2b.js.zst").exists(), "zstd only when asked")
        for none in ("assets/tiny-9.js.br", "assets/pic.png.br", "assets/noise-3.wasm.br", "iconpack/a.svg.br"):
            self.assertFalse((self.d / none).exists(), none)
        for p, data in before.items():
            self.assertEqual(p.read_bytes(), data, "the originals stay as they were")
        self.assertEqual(self.make("verify", self.d).returncode, 0)
        r = self.make("make", self.d, "--zstd")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.d / "assets/app-1a2b.js.zst").is_file())
        r = self.make("verify", self.d)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_verify_refuses_planted_side_files(self):
        self.assertEqual(self.make("make", self.d, "--zstd").returncode, 0)
        good = self.make("verify", self.d)
        self.assertEqual(good.returncode, 0, good.stderr)
        plants = {
            # gzip data under a brotli name: the wrong Content-Encoding for what is in it
            "assets/app-1a2b.js.br": gzip.compress(self.js.read_bytes()),
            # another file's (valid) zstd
            "index.html.zst": subprocess.run(["zstd", "-q", "-c"], input=self.js.read_bytes(), capture_output=True).stdout,
            "assets/gone-7.js.br": (self.d / "index.html.br").read_bytes(),  # no original next to it
            "assets/pic.png.br": b"\x0b\x00\x80",  # a kind that isn't served from a side file
        }
        for rel, data in plants.items():
            with self.subTest(rel):
                p = self.d / rel
                saved = p.read_bytes() if p.exists() else None
                p.write_bytes(data)
                r = self.make("verify", self.d)
                self.assertEqual(r.returncode, 1)
                self.assertIn(pathlib.Path(rel).name, r.stderr)
                if saved is None:
                    p.unlink()
                else:
                    p.write_bytes(saved)
        self.assertEqual(self.make("verify", self.d).returncode, 0, "back to good once the plants are gone")

    def test_stale_side_files_go_and_times_differ(self):
        self.assertEqual(self.make("make", self.d, "--zstd").returncode, 0)
        self.assertTrue((self.d / "assets/app-1a2b.js.zst").is_file())
        t = self.js.stat().st_mtime_ns // 10**9
        self.assertEqual((self.d / "assets/app-1a2b.js.br").stat().st_mtime_ns, (t + 1) * 10**9)
        self.assertEqual((self.d / "assets/app-1a2b.js.zst").stat().st_mtime_ns, (t + 2) * 10**9,
                         "FILE, .br and .zst never share Caddy's ETag (time + size)")
        self.assertEqual(self.make("make", self.d).returncode, 0)
        self.assertFalse((self.d / "assets/app-1a2b.js.zst").exists(), "a run without --zstd leaves no old .zst")
        self.js.write_text("x")  # shrank below the floor: its old copy goes
        self.assertEqual(self.make("make", self.d).returncode, 0)
        self.assertFalse((self.d / "assets/app-1a2b.js.br").exists())
        self.assertEqual(list(self.d.rglob("*.part")), [])

    def test_make_leaves_files_it_doesnt_make(self):
        keep = {self.d / "assets/backup-1.tar.zst": b"\x28\xb5\x2f\xfd" + os.urandom(64),
                self.d / "iconpack/a.svg.br": b"\x0b\x00\x80"}
        for p, data in keep.items():
            p.write_bytes(data)
        self.assertEqual(self.make("make", self.d).returncode, 0)
        for p, data in keep.items():
            self.assertEqual(p.read_bytes(), data, f"{p.name}: not one of make's own")

    def test_a_linked_folder_is_refused(self):
        other = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, other)
        (other / "x-1.js.br").write_bytes(b"\x0b\x00\x80")
        (self.d / "vendor").symlink_to(other, target_is_directory=True)
        r = self.make("verify", self.d)
        self.assertEqual(r.returncode, 1)
        self.assertIn("vendor: a linked folder", r.stderr)

    def test_links_are_refused_and_never_written_through(self):
        outside = self.d.parent / (self.d.name + "-outside.txt")
        outside.write_text("keep me")
        self.addCleanup(outside.unlink)
        side = self.d / "assets/app-1a2b.js.br"
        side.symlink_to(outside)
        r = self.make("verify", self.d)
        self.assertEqual(r.returncode, 1)
        self.assertIn("a link", r.stderr)
        self.assertEqual(self.make("make", self.d).returncode, 0)
        self.assertEqual(outside.read_text(), "keep me", "make never writes through a link")
        self.assertFalse(side.is_symlink())
        self.assertEqual(self.make("verify", self.d).returncode, 0)
        link = self.d / "assets/linked-1.js"
        link.symlink_to(self.js)
        (self.d / "assets/linked-1.js.br").write_bytes(side.read_bytes())
        r = self.make("verify", self.d)
        self.assertEqual(r.returncode, 1)
        self.assertIn("linked-1.js.br: a link", r.stderr)

    def test_record_then_check_without_brotli(self):
        self.assertEqual(self.make("make", self.d, "--zstd").returncode, 0)
        rec = self.d.parent / (self.d.name + ".sha256")
        self.addCleanup(rec.unlink, missing_ok=True)
        r = self.make("record", self.d, rec)
        self.assertEqual(r.returncode, 0, r.stderr)
        bin_ = self.d.parent / (self.d.name + "-bin")
        bin_.mkdir()
        self.addCleanup(shutil.rmtree, bin_)
        env = {**os.environ, "PATH": str(bin_)}  # neither brotli nor zstd, like the release host
        check = lambda: subprocess.run([sys.executable, ROOT / "build/precompress.py", "check", self.d, rec],
                                       capture_output=True, text=True, env=env)
        r = check()
        self.assertEqual(r.returncode, 0, r.stderr)
        side = self.d / "assets/app-1a2b.js.br"
        good = side.read_bytes()
        for name, plant, undo in (
                ("changed", lambda: side.write_bytes(gzip.compress(self.js.read_bytes())), lambda: side.write_bytes(good)),
                ("not in the record", lambda: (self.d / "assets/extra-2.js.br").write_bytes(good),
                 lambda: (self.d / "assets/extra-2.js.br").unlink()),
                ("not there", lambda: side.unlink(), lambda: side.write_bytes(good)),
                ("changed", lambda: self.js.write_text("export const x = 2;\n" * 2000),
                 lambda: self.js.write_text("export const x = 1;\n" * 2000))):
            with self.subTest(name):
                plant()
                r = check()
                self.assertEqual(r.returncode, 1)
                self.assertIn(name, r.stderr)
                undo()
        self.assertEqual(check().returncode, 0, "back to good")
        r = self.make("record", self.d, rec)
        side.write_bytes(b"\x0b\x00\x80")  # recording refuses what doesn't decode
        self.assertEqual(self.make("record", self.d, rec).returncode, 1)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def decode(enc: str, body: bytes) -> bytes:
    if enc == "":
        return body
    if enc == "gzip":
        return gzip.decompress(body)
    cmd = {"br": ["brotli", "-d", "-c"], "zstd": ["zstd", "-d", "-q", "-c"]}[enc]
    r = subprocess.run(cmd, input=body, capture_output=True)
    if r.returncode:
        raise ValueError(f"not {enc}")
    return r.stdout


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK) and TOOLS, "TINHAT_TEST_CADDY isn't set (or no brotli/zstd)")
class OverHTTP(unittest.TestCase):
    """The web app block, exactly as the modes write it, served by Caddy (its root pointed at a temporary folder)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = pathlib.Path(tempfile.mkdtemp())
        w = cls.web = cls.tmp / "web"
        (w / "assets").mkdir(parents=True)
        (w / "call").mkdir()
        cls.files = {
            "index.html": ("<!doctype html><title>Tin Hat</title>" + "<p>app</p>" * 500).encode(),
            "call/index.html": ("<!doctype html><title>door</title>" + "<p>door</p>" * 300).encode(),
            "sw.js": ("self.x=1;\n" * 300).encode(),
            "assets/index-AbC123.js": ("export const app = 'tin hat';\n" * 3000).encode(),
            "assets/index-AbC123.css": ("body{color:#111}\n" * 800).encode(),
            "assets/only-br-Q1.js": ("let a = 42;\n" * 900).encode(),
            "assets/crypto-Z9.wasm": b"\x00asm\x01\x00\x00\x00" + b"\x01\x02\x03\x04" * 4000,
            "sw.jsindex.html": ("<p>decoy</p>" * 300).encode(),
        }
        for rel, data in cls.files.items():
            (w / rel).write_bytes(data)
        subprocess.run([sys.executable, ROOT / "build/precompress.py", "make", w, "--zstd"], check=True,
                       capture_output=True)
        (w / "assets/only-br-Q1.js.zst").unlink()  # this one has brotli only: a zstd browser gets on-the-fly zstd
        cls.port = _free_port()
        site = (f"{{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}}\n"
                f"http://127.0.0.1:{cls.port} {{\n\tencode zstd gzip\n"
                + templates.web_app_block("default-src 'self'; frame-ancestors 'none'").replace("/srv/web", str(w))
                + "}\n")
        (cls.tmp / "Caddyfile").write_text(site)
        env = {"HOME": str(cls.tmp), "XDG_DATA_HOME": str(cls.tmp), "XDG_CONFIG_HOME": str(cls.tmp), "PATH": "/usr/bin:/bin"}
        cls.log = open(cls.tmp / "caddy.log", "wb")
        cls.proc = subprocess.Popen([CADDY, "run", "--adapter", "caddyfile", "--config", str(cls.tmp / "Caddyfile")],
                                    stdout=cls.log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            cls.tearDownClass()
            raise RuntimeError("caddy didn't start: " + (cls.tmp / "caddy.log").read_text()[-1500:])

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.log.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, ae="identity", extra=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers={"Accept-Encoding": ae, **(extra or {})})
        r = c.getresponse()
        body = r.read()
        h = {k.lower(): v for k, v in r.getheaders()}
        h["vary-all"] = ", ".join(v for k, v in r.getheaders() if k.lower() == "vary")
        c.close()
        return r.status, h, body

    def served(self, path, ae, original: bytes):
        """The answer decodes, by its own Content-Encoding, to exactly `original`. Returns (encoding, headers)."""
        st, h, body = self.get(path, ae)
        self.assertEqual(st, 200, f"{path} [{ae}]")
        enc = h.get("content-encoding", "")
        self.assertEqual(decode(enc, body), original, f"{path} [{ae}] as {enc or 'identity'}")
        self.assertIn("Accept-Encoding", h["vary-all"], f"{path} [{ae}]")
        return enc, h

    def test_missing_asset_is_a_404_nobody_keeps(self):
        for path in ("/assets/index-OLD999.js", "/assets/old-part-X.css", "/assets/", "/assets/deeper/x-1.js"):
            for ae in ("identity", "gzip, deflate, br, zstd"):
                with self.subTest(path=path, ae=ae):
                    st, h, body = self.get(path, ae)
                    self.assertEqual(st, 404)
                    self.assertEqual(h.get("cache-control"), "no-store")
                    self.assertNotIn(b"Tin Hat", body, "never the app's page")
                    self.assertNotIn("content-encoding", h)

    def test_the_app_routes_still_get_the_app(self):
        for path in ("/", "/index.html", "/room/abc", "/some/deep/route"):
            for ae in ("gzip, deflate, br, zstd", "identity", "gzip"):
                with self.subTest(path=path, ae=ae):
                    _enc, h = self.served(path, ae, self.files["index.html"])
                    self.assertNotIn("immutable", h.get("cache-control", ""))
                    self.assertTrue(h["content-type"].startswith("text/html"))
        for path in ("/", "/index.html", "/room/abc", "/some/deep/route"):
            with self.subTest(path=path):
                enc, h = self.served(path, "gzip, deflate, br, zstd", self.files["index.html"])
                self.assertEqual(enc, "br", "a folder's address and the app's routes get the pre-compressed page")
                self.assertEqual(h.get("cache-control"), "no-cache", "every page handed out is revalidated")
                _enc, h = self.served(path, "identity", self.files["index.html"])
                self.assertEqual(h.get("cache-control"), "no-cache")
        for path in ("/call/", "/call/legacy.html", "/?join=abc", "/index.html?join=abc", "/guest/", "/guest/x"):  # the door page
            with self.subTest(path=path):
                enc, h = self.served(path, "br", self.files["call/index.html"])
                self.assertEqual(enc, "br")
                self.assertEqual(h.get("cache-control"), "no-cache")

    def test_the_exact_file_comes_first(self):
        # a folder's index only for an address that ends in /: sw.js is sw.js even with an sw.jsindex.html beside it
        for ae in ("br", "identity"):
            self.served("/sw.js", ae, self.files["sw.js"])

    def test_precompressed_when_accepted(self):
        cases = (("/assets/index-AbC123.js", "text/javascript"), ("/assets/index-AbC123.css", "text/css"),
                 ("/assets/crypto-Z9.wasm", "application/wasm"), ("/index.html", "text/html"),
                 ("/sw.js", "text/javascript"))
        for path, ctype in cases:
            rel = path.lstrip("/")
            with self.subTest(path):
                enc, h = self.served(path, "gzip, deflate, br, zstd", self.files[rel])
                self.assertEqual(enc, "br")
                self.assertTrue(h["content-type"].startswith(ctype), h["content-type"])
                enc, h2 = self.served(path, "gzip, deflate, zstd", self.files[rel])
                self.assertEqual(enc, "zstd")
                self.assertTrue(h2["content-type"].startswith(ctype))
                self.assertNotEqual(h.get("etag"), h2.get("etag"), "one ETag per encoding")
                if rel.startswith("assets/"):
                    self.assertEqual(h["cache-control"], "public, max-age=31536000, immutable")

    def test_identity_and_gzip_when_not(self):
        for path in ("/assets/index-AbC123.js", "/assets/crypto-Z9.wasm", "/index.html"):
            rel = path.lstrip("/")
            with self.subTest(path):
                enc, h = self.served(path, "identity", self.files[rel])
                self.assertEqual(enc, "")
                enc_none, h_none = self.served(path, "", self.files[rel])
                self.assertEqual(enc_none, "")
                enc, _ = self.served(path, "gzip", self.files[rel])
                self.assertIn(enc, ("gzip", ""))  # on the fly, as before
                enc, _ = self.served(path, "gzip, br;q=0", self.files[rel])
                self.assertNotEqual(enc, "br", "q=0 refuses brotli")
        enc, _ = self.served("/assets/only-br-Q1.js", "gzip, zstd", self.files["assets/only-br-Q1.js"])
        self.assertEqual(enc, "zstd", "no side file: compressed on the fly")

    def test_not_206(self):
        # Caddy 2.10.2's own `precompressed` answers 206 to a plain GET (caddyserver/caddy#7250)
        for ae in ("br", "zstd"):
            st, h, _ = self.get("/assets/index-AbC123.js", ae)
            self.assertEqual(st, 200)
            self.assertNotIn("content-range", h)
        js = self.files["assets/index-AbC123.js"]
        for rng in ("bytes=0-9", "bytes=0-9,20-29", "bytes=999999999-"):
            with self.subTest(rng):
                st, h, body = self.get("/assets/index-AbC123.js", "br", {"Range": rng})
                self.assertEqual(st, 200, "an encoded copy always goes whole")
                self.assertEqual(decode(h.get("content-encoding", ""), body), js)
                self.assertNotIn("content-range", h)
        st, h, body = self.get("/assets/index-AbC123.js", "identity", {"Range": "bytes=0-9"})
        self.assertEqual((st, body), (206, js[:10]), "the plain file still answers ranges")

    def test_head(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("HEAD", "/assets/index-AbC123.js", headers={"Accept-Encoding": "br"})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Encoding"), "br")
        self.assertTrue(r.getheader("Content-Type").startswith("text/javascript"))
        self.assertEqual(r.read(), b"")
        c.close()

    def test_revalidation(self):
        _, h, _ = self.get("/index.html", "br")
        st, h2, body = self.get("/index.html", "br", {"If-None-Match": h["etag"]})
        self.assertEqual(st, 304)
        self.assertEqual(body, b"")
        st, _, _ = self.get("/index.html", "identity", {"If-None-Match": h["etag"]})
        self.assertEqual(st, 200, "the brotli copy's ETag doesn't match the plain file")

    def test_the_csp_goes_with_every_answer(self):
        for path, ae in (("/assets/index-AbC123.js", "br"), ("/", "br"), ("/assets/nope-1.js", "br")):
            with self.subTest(path):
                _, h, _ = self.get(path, ae)
                self.assertEqual(h.get("content-security-policy"), "default-src 'self'; frame-ancestors 'none'")

    def test_the_checker_catches_a_wrong_side_file(self):
        # negative control: a side file whose content doesn't match its Content-Encoding (gzip data named .br) or
        # its file (another file's brotli) is caught by served(); then put back
        p = self.web / "assets/index-AbC123.js.br"
        good = p.read_bytes()
        st = p.stat()
        try:
            for bad in (gzip.compress(self.files["assets/index-AbC123.js"]), (self.web / "index.html.br").read_bytes()):
                p.write_bytes(bad)
                os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + len(bad)))
                with self.assertRaises((AssertionError, ValueError)):
                    self.served("/assets/index-AbC123.js", "br", self.files["assets/index-AbC123.js"])
        finally:
            p.write_bytes(good)
            os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.served("/assets/index-AbC123.js", "br", self.files["assets/index-AbC123.js"])


if __name__ == "__main__":
    unittest.main()

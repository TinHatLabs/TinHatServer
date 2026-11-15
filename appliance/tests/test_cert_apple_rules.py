"""Every certificate Tin Hat Server (and its lab) makes must pass Apple's TLS leaf rules for iOS 13+.

A phone trusts a home-network server once its root is installed, but Apple's trust still refuses a LEAF that breaks its
rules: an empty subject without a critical subjectAltName ("NonEmptySubject"), no SAN, no EKU serverAuth, more than 825
days, a weak key or a SHA-1 signature. Caddy's `tls internal` (Go's x509) is fine; a hand-made openssl one may not be.

  Parser       malformed encodings are refused (no false pass)
  Rules        the checker itself, against openssl certificates that break each rule (they must FAIL) and the Caddy
               shape (empty subject + critical SAN, must pass)
  LabCA        the lab's own CA (lab/internet/*.sh): their leaf generators, run as written, pass
  CaddyInternal  with TINHAT_TEST_CADDY=/path/to/caddy: real Caddy's `tls internal` leaf, with the home-network
               template's pki block, passes
  Inventory    every place in the tree that makes a certificate (the usual ways, see GENERATOR) is listed here
               with how it is covered, so a new generator doesn't slip in unchecked
The setup page's own certificate (setuptls.py) is checked in test_setup_https (Certificate.test_passes_apple_rules).
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import os
import pathlib
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("cert_apple_check", ROOT / "build" / "cert-apple-check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
OPENSSL = shutil.which("openssl")
CADDY = os.environ.get("TINHAT_TEST_CADDY")
LAB = (ROOT / "lab").is_dir()  # the lab's tooling stays in the private tree (not in the public copy)


def problems(path) -> list:
    return check.check_file(str(path))


def selfsigned(d: pathlib.Path, name: str, *args, key=("-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"),
               days="90", subj="/CN=maple.local", ca_false=True) -> pathlib.Path:
    """A self-signed certificate; marked CA:FALSE unless ca_false=False."""
    out = d / f"{name}.pem"
    if ca_false:
        args = (*args, "-addext", "basicConstraints=critical,CA:FALSE")
    subprocess.run([OPENSSL, "req", "-x509", *key, "-nodes", "-keyout", str(d / f"{name}.key"), "-out", str(out),
                    "-days", days, "-subj", subj, *args], check=True, capture_output=True)
    return out


SAN = ("-addext", "subjectAltName=DNS:maple.local")
EKU = ("-addext", "extendedKeyUsage=serverAuth")


@unittest.skipUnless(OPENSSL, "needs openssl")
class Rules(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = pathlib.Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def only(self, path, rule):
        found = problems(path)
        self.assertEqual([p.split(":")[0] for p in found], [rule], found)

    def test_empty_subject_needs_a_critical_san(self):
        # the shape iOS refused (NonEmptySubject): empty subject, SAN not critical
        self.only(selfsigned(self.d, "nes", *SAN, *EKU, subj="/"), "subject")
        # Caddy's shape: empty subject, SAN critical: passes
        self.assertEqual(problems(selfsigned(self.d, "caddy", "-addext", "subjectAltName=critical,DNS:maple.local",
                                             *EKU, subj="/")), [])
        # a subject: passes with a plain SAN
        self.assertEqual(problems(selfsigned(self.d, "cn", *SAN, *EKU)), [])

    def test_each_other_rule_fails_on_its_own(self):
        self.only(selfsigned(self.d, "nosan", *EKU), "san")
        self.only(selfsigned(self.d, "cnonly", "-addext", "subjectAltName=URI:https://maple.local/", *EKU), "san")
        self.only(selfsigned(self.d, "noeku", *SAN), "eku")
        self.only(selfsigned(self.d, "ca", *SAN, *EKU, "-addext", "basicConstraints=critical,CA:TRUE",
                             ca_false=False), "ca")
        self.only(selfsigned(self.d, "clientonly", *SAN, "-addext", "extendedKeyUsage=clientAuth"), "eku")
        self.only(selfsigned(self.d, "long", *SAN, *EKU, days="826"), "validity")
        self.assertEqual(problems(selfsigned(self.d, "edge", *SAN, *EKU, days="825")), [])
        self.only(selfsigned(self.d, "rsa1024", *SAN, *EKU, key=("-newkey", "rsa:1024")), "key")
        self.assertEqual(problems(selfsigned(self.d, "rsa2048", *SAN, *EKU, key=("-newkey", "rsa:2048"))), [])
        self.only(selfsigned(self.d, "sha1", "-sha1", *SAN, *EKU), "hash")
        rsa = ("-newkey", "rsa:2048")
        self.only(selfsigned(self.d, "pss1", "-sha1", "-sigopt", "rsa_padding_mode:pss", *SAN, *EKU, key=rsa), "hash")
        self.assertEqual(problems(selfsigned(self.d, "pss256", "-sha256", "-sigopt", "rsa_padding_mode:pss", *SAN,
                                             *EKU, key=rsa)), [])
        self.assertEqual(problems(selfsigned(self.d, "p384", *SAN, *EKU, key=("-newkey", "ec", "-pkeyopt",
                                                                              "ec_paramgen_curve:secp384r1"))), [])
        self.assertEqual(problems(selfsigned(self.d, "sha224", "-sha224", *SAN, *EKU)), [])
        self.only(selfsigned(self.d, "k1", *SAN, *EKU, key=("-newkey", "ec", "-pkeyopt",
                                                            "ec_paramgen_curve:secp256k1")), "key")
        self.only(selfsigned(self.d, "ip", "-addext", "subjectAltName=IP:192.0.2.7", *EKU, days="3650"), "validity")

    def test_cli(self):
        good, bad = selfsigned(self.d, "good", *SAN, *EKU), selfsigned(self.d, "bad", *SAN, *EKU, subj="/")
        run = lambda *f: subprocess.run(["python3", "-I", str(ROOT / "build" / "cert-apple-check.py"), *f],
                                        capture_output=True, text=True)
        self.assertEqual(run(str(good)).returncode, 0)
        r = run(str(good), str(bad))
        self.assertEqual(r.returncode, 1)
        self.assertIn("NonEmptySubject", r.stdout)
        der = self.d / "good.der"
        subprocess.run([OPENSSL, "x509", "-in", str(good), "-outform", "DER", "-out", str(der)], check=True)
        self.assertEqual(run(str(der)).returncode, 0)


class Parser(unittest.TestCase):
    """Malformed encodings are refused or don't count (they never pass as a good certificate)."""
    def test_strict_der(self):
        with self.assertRaises(check.Bad):  # a child running past its parent
            check.children(b"\x30\x01\x04\x02ab", 2, 3)
        with self.assertRaises(check.Bad):  # a long-form length that fits the short form
            check.tlv(b"\x04\x81\x01a", 0)
        with self.assertRaises(check.Bad):  # an unterminated OID component (serverAuth + 0x80)
            check.oid(bytes.fromhex("2b0601050507030180"))
        with self.assertRaises(check.Bad):  # a non-minimal OID component
            check.oid(bytes.fromhex("2b8006"))
        self.assertEqual(check.oid(bytes.fromhex("2b06010505070301")), check.SERVER_AUTH)

    def test_basic_constraints(self):
        self.assertFalse(check.is_ca(None))
        self.assertFalse(check.is_ca((True, bytes.fromhex("3000"))))  # CA:FALSE as Go and openssl write it
        self.assertTrue(check.is_ca((True, bytes.fromhex("30030101ff"))))
        self.assertTrue(check.is_ca((True, bytes.fromhex("30060101ff020100"))))  # with pathlen 0
        with self.assertRaises(check.Bad):
            check.is_ca((True, bytes.fromhex("30030101" "01")))  # not DER TRUE/FALSE

    def test_san_contents(self):
        good = b"\x82\x0bmaple.local"
        for bad in (b"\x82\x00", b"\x87\x01\x01"):  # an empty DNS name, a one-byte IP address: also next to a good one
            for body in (bad, good + bad):
                with self.assertRaises(check.Bad):
                    check.san_names(bytes([0x30, len(body)]) + body)
        self.assertEqual(check.san_names(bytes.fromhex("300687047f000001")), 1)  # 127.0.0.1
        self.assertEqual(check.san_names(b"\x30\x0d\x82\x0bmaple.local"), 1)
        with self.assertRaises(check.Bad):  # a SET instead of the SEQUENCE
            check.san_names(bytes.fromhex("3103820161"))

    def test_times(self):
        self.assertEqual(check.when(0x17, b"500101000000Z").year, 1950)
        self.assertEqual(check.when(0x17, b"491231235959Z").year, 2049)
        self.assertEqual(check.when(0x18, b"20500101000000Z").year, 2050)
        with self.assertRaises(check.Bad):
            check.when(0x17, b"5001010000Z")


def _between(text: str, start: str, stop: str) -> str:
    a = text.index(start)
    return text[a:text.index(stop, a)]


@unittest.skipUnless(LAB, "no lab/ in this tree")
@unittest.skipUnless(OPENSSL and shutil.which("bash"), "needs openssl and bash")
class LabCA(unittest.TestCase):
    """The lab's fake internet CA (lab/internet/setup.sh) and the leafs its scripts sign, run as written (only the
    folders moved into a temporary one)."""
    LAB = ROOT / "lab" / "internet"

    def test_lab_leafs_pass(self):
        with tempfile.TemporaryDirectory() as t:
            d = pathlib.Path(t)
            (d / "ca").mkdir()
            (d / "tls").mkdir()
            setup = (self.LAB / "setup.sh").read_text()
            # the CA, the leaf function and the script's own leaf calls, as written
            ca_and_leafs = _between(setup, "if [ ! -f ca/lab-ca.crt ]", "# ---- Cloudflare-mock token")
            self.assertIn("\nleaf ", ca_and_leafs)
            subprocess.run(["bash", "-ec", ca_and_leafs], cwd=d, check=True, capture_output=True)
            expect = set(re.findall(r"^leaf (\S+)", ca_and_leafs, re.M))
            for script in ("github-setup.sh", "owndomain-setup.sh", "updates-setup.sh"):
                body = (self.LAB / script).read_text()
                block = _between(body, "cd /etc/labnet/tls\n", "\nfi\n") + "\nfi\n"
                block = block.split("\n", 1)[1].replace("/tmp/", f"{t}/")  # its scratch files, in here
                subprocess.run(["bash", "-ec", block], cwd=d / "tls", check=True, capture_output=True)
                expect |= {pathlib.Path(x).stem for x in re.findall(r"-out (\S+\.crt)", block)}
            made = sorted((d / "tls").glob("*.crt"))
            self.assertEqual({p.stem for p in made}, expect)
            self.assertGreaterEqual(len(made), 6)
            for crt in made:
                self.assertEqual(problems(crt), [], crt.name)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyInternal(unittest.TestCase):
    def test_tls_internal_leaf_passes(self):
        src = (ROOT / "appliance" / "rootfs" / "opt" / "tinhat" / "manager" / "tinhat" / "templates.py").read_text()
        lan = _between(src, 'CADDY_LAN = """', '\n}}\n')
        pki = _between(lan, "\tpki {{", "\n\t}}") + "\n\t}}"
        pki = pki.replace("{{", "{").replace("}}", "}").replace("{server_name}", "maple.local")
        http, https = _free_port(), _free_port()
        cf = (f"{{\n\tadmin off\n\tskip_install_trust\n\thttp_port {http}\n\thttps_port {https}\n{pki}\n}}\n\n"
              f"https://maple.local:{https} {{\n\ttls internal\n\trespond \"ok\"\n}}\n")
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / "Caddyfile").write_text(cf)
            env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
            log = open(pathlib.Path(d) / "caddy.log", "wb")
            caddy = subprocess.Popen([CADDY, "run", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                     stdout=subprocess.DEVNULL, stderr=log, env=env)
            try:
                ctx = ssl.create_default_context()
                ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
                der, deadline = None, time.monotonic() + 20
                while der is None and time.monotonic() < deadline and caddy.poll() is None:
                    try:
                        with socket.create_connection(("127.0.0.1", https), timeout=1) as s:
                            s.settimeout(2)
                            with ctx.wrap_socket(s, server_hostname="maple.local") as tls:
                                der = tls.getpeercert(binary_form=True)
                    except (OSError, ssl.SSLError):
                        time.sleep(0.1)
                if der is None:
                    log.flush()
                    self.fail("Caddy never served https: " +
                              (pathlib.Path(d) / "caddy.log").read_text(errors="replace")[-1500:])
                self.assertEqual(check.problems(der), [])
                info = check.parse(der)
                # what made it pass (the shape the iOS stand-in trusted): Caddy leaves the subject empty and marks
                # the SAN critical
                self.assertTrue(info["subject_empty"] and info["ext"][check.SAN][0])
            finally:
                caddy.terminate()
                try:
                    caddy.wait(10)
                except subprocess.TimeoutExpired:
                    caddy.kill()
                    caddy.wait()
                log.close()


# Every place in the tree that makes a certificate, and how it is covered. A new one made the usual ways (openssl
# req -x509 / x509 -req / ca, as a shell line or an argument list; PowerShell, Windows, keytool, rcgen, Go, Python
# cryptography, mkcert, step) fails test_every_generator_is_listed until it is added here: checked by a test (through
# build/cert-apple-check.py), or not seen by any phone (why). Caddy's `tls internal` is covered by CaddyInternal.
INVENTORY = {
    "appliance/rootfs/opt/tinhat/manager/tinhat/setuptls.py": (1, "checked: test_setup_https "
                                                               "Certificate.test_passes_apple_rules"),
    "lab/internet/setup.sh": (2, "checked: LabCA (the lab CA + its leaf function)"),
    "lab/internet/github-setup.sh": (1, "checked: LabCA"),
    "lab/internet/owndomain-setup.sh": (1, "checked: LabCA"),
    "lab/internet/updates-setup.sh": (1, "checked: LabCA"),
    "appliance/rootfs/opt/tinhat/manager/tinhat/pyenv.py": (1, "not a phone's: a one-day 127.0.0.1 certificate for "
                                                            "the build's own HTTPS smoke request, deleted with it"),
    "names/tinhat_names/pyenv.py": (1, "not a phone's: the same smoke certificate (a copy of pyenv.py)"),
    "relay/tinhat_relay/pyenv.py": (1, "not a phone's: the same smoke certificate (a copy of pyenv.py)"),
    "lab/room-v11-oldpeer.sh": (1, "not a phone's: the room-version-11 gate's v10-only federation partner (lab VM only): "
                                   "a 30-day self-signed server certificate for Synapse-to-Synapse with no outbound checks"),
    "relay/tinhat-relay": (1, "not a phone's: the relay's control API certificate, pinned by fingerprint by the "
                              "names service only (a CA:TRUE self-signed pin, 10 years by design)"),
}
GENERATOR = re.compile(
    r"openssl\b[^\n]*?\b(?:req\b[^\n]*\s-x509\b|x509\b[^\n]*\s-req\b|ca\s+-)"  # openssl req -x509 / x509 -req / ca -…
    # the same as an argument list, the flag anywhere before the list closes
    r"|[\"']req[\"']\s*,[^\]]{0,400}?[\"']-x509[\"']|[\"']x509[\"']\s*,[^\]]{0,400}?[\"']-req[\"']"
    r"|[\"']openssl[\"']\s*,\s*[\"']ca[\"']"
    r"|New-SelfSignedCertificate|CertCreateSelfSignCertificate|\bkeytool\b[^\n]*-genkey|\brcgen::"
    r"|x509\.CreateCertificate|\bmkcert\b\s+-?\w|\bstep\s+certificate\s+create|CertificateBuilder\(")
SKIP_DIRS = {".git", "node_modules", "docs", "tests", "vectors", "__pycache__"}


def generators(root: pathlib.Path) -> dict:
    """-> {relative path: number of certificate-making lines} for the tree's code (docs, tests and the web app's
    copy skipped)."""
    found = {}
    for dirpath, dirnames, files in os.walk(root):
        top = pathlib.Path(dirpath) == root
        dirnames[:] = [n for n in dirnames if n not in SKIP_DIRS and not (top and n == "web")]
        for f in files:
            p = pathlib.Path(dirpath) / f
            if p.suffix in (".md", ".log", ".txt", ".json", ".lock", ".png", ".svg"):
                continue
            try:
                if not p.is_file() or p.stat().st_size > 2_000_000:
                    continue
                text = p.read_text().replace("\\\n", " ")  # shell line continuations
            except (UnicodeDecodeError, OSError):
                continue
            n = len(GENERATOR.findall(text))
            if n:
                found[str(p.relative_to(root))] = n
    return found


class Inventory(unittest.TestCase):
    def test_every_generator_is_listed(self):
        found = generators(ROOT)
        self.assertEqual(found, {k: v[0] for k, v in INVENTORY.items() if LAB or not k.startswith("lab/")},
                         "a certificate generator was added, moved or removed: list it in INVENTORY with how it is "
                         "checked against build/cert-apple-check.py")

    def test_the_scan_sees_a_new_generator(self):
        planted = {
            "a.sh": "openssl req -x509 -newkey ec -subj / -out c.pem\n",
            "b.py": 'subprocess.run(["openssl", "req", "-x509", "-subj", "/"])\n',
            "c.sh": "openssl x509 -req -in c.csr -CA ca.crt -out c.crt\n",
            "d.ps1": "New-SelfSignedCertificate -DnsName maple.local\n",
            "e.rs": "let c = rcgen::generate_simple_self_signed(names)?;\n",
            "f.sh": "openssl req -new -key k.pem -out c.csr\n",  # a request only: not a generator
            "g.sh": "openssl req \\\n    -x509 -newkey rsa:2048 -out c.pem\n",
            "h.py": 'run(["openssl", "req", "-new",\n     "-x509", "-out", "c.pem"])\n',
            "i.py": 'run(["openssl", "ca", "-in", "leaf.csr"])\n',
            "l.py": 'run(["openssl", "req", "-keyout", str(key), "-x509", "-out", str(cert)])\n',
            "j.sh": "keytool -genkeypair -alias tls -keystore k.jks\n",
            "k.go": "der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, pub, key)\n",
        }
        with tempfile.TemporaryDirectory() as t:
            for name, text in planted.items():
                (pathlib.Path(t) / name).write_text(text)
            want = {n: 1 for n in planted if n != "f.sh"}
            self.assertEqual(generators(pathlib.Path(t)), want)


if __name__ == "__main__":
    unittest.main()

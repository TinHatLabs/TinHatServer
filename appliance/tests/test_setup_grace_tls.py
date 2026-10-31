"""Review S3 (assembly-039): in the 30 minutes after setup a public mode's Caddyfile still has the setup page's catch-all
https site (setuptls.py). Every named site then needs a TLS policy of its own (templates.NAMED_TLS_POLICY), or its
handshakes get the setup certificate. 0.3.9 gave it to the server's own name only; a move inside that half hour adds a
preflight site for the new name and former-name sites, which lacked it (the move's certificate wait failed and the
move rolled back). Templates only; with TINHAT_TEST_CADDY=/path/to/caddy the files are adapted by Caddy itself.
    python3 -m unittest discover -s appliance/tests
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

_saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _saved:
    del sys.modules[_k]
import tinhat  # noqa: E402,F401
from tinhat import setuptls, state, templates  # noqa: E402
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)
REAL = dict(_real)

CADDY = os.environ.get("TINHAT_TEST_CADDY")
ACME = {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123", "password": "s3cr3t-Url_Safe",
        "subdomain": "maplehouse"}
DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"
DNS = "\t\tdns cloudflare tok3n_Abc\n"
POLICY = templates.NAMED_TLS_POLICY.strip()


def site(caddyfile: str, name: str) -> str:
    """The text of the site block for https://name (up to its closing brace at column 0)."""
    m = re.search(rf"^https://{re.escape(name)} {{\n(.*?)^}}\n", caddyfile, re.S | re.M)
    assert m, f"no site for {name}"
    return m.group(1)


def tls_block(block: str) -> str:
    m = re.search(r"^\ttls(?: internal)? \{\n(.*?)^\t\}\n", block, re.S | re.M)
    return m.group(1) if m else ""


class Grace(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, REAL)
        p.start()
        self.addCleanup(p.stop)

    def public(self, in_grace: bool) -> str:
        """caddy_anywhere for maple.tinhat.me, with or without the setup page's site."""
        with mock.patch.object(setuptls, "available", lambda: in_grace), \
                mock.patch.object(state, "load_state", lambda: {"phase": "unconfigured" if in_grace else "ready"}):
            return templates.caddy_anywhere("maple.tinhat.me", ACME, DIRECTORY, False)

    def test_has_setup_site(self):
        self.assertTrue(templates.has_setup_site(self.public(True)))
        self.assertFalse(templates.has_setup_site(self.public(False)))
        self.assertFalse(templates.has_setup_site(""))

    def test_preflight_gets_its_own_policy_inside_the_grace(self):
        pre = templates.caddy_preflight("chat.example.org", DNS, DIRECTORY, False, setup=True)
        tls = tls_block(site(pre, "chat.example.org"))
        # at the tls level (after the issuer block), not inside `issuer acme { }`
        self.assertRegex(tls, r"\t\t\}\n\t\tprotocols tls1\.2 tls1\.3\n$")
        plain = templates.caddy_preflight("chat.example.org", DNS, DIRECTORY, False)
        self.assertNotIn(POLICY, plain, "outside the grace the file is exactly as before")

    def test_former_names_get_it_inside_the_grace(self):
        former = [("maple.tinhat.me", templates.acmedns_tls(ACME)), ("maple.local", "internal")]
        with mock.patch.object(setuptls, "available", lambda: True), \
                mock.patch.object(state, "load_state", lambda: {"phase": "unconfigured"}):
            new = templates.caddy_domain("chat.example.org", DNS, DIRECTORY, False)
        out = templates.with_former_names(new, "chat.example.org", former)
        self.assertIn(POLICY, tls_block(site(out, "chat.example.org")))
        for name, _ in former:
            self.assertIn(POLICY, tls_block(site(out, name)), name)
        self.assertRegex(site(out, "maple.local"), r"\ttls internal \{\n\t\tprotocols tls1\.2 tls1\.3\n\t\}\n")

    def test_outside_the_grace_former_names_are_unchanged(self):
        former = [("maple.tinhat.me", templates.acmedns_tls(ACME)), ("maple.local", "internal")]
        with mock.patch.object(state, "load_state", lambda: {"phase": "ready"}):
            new = templates.caddy_domain("chat.example.org", DNS, DIRECTORY, False)
        out = templates.with_former_names(new, "chat.example.org", former)
        self.assertNotIn(POLICY, out)
        self.assertIn("\ttls internal\n", site(out, "maple.local"))

    def test_a_ready_server_inside_and_after_the_half_hour(self):
        """The real condition (setuptls.in_grace: ready_at within GRACE), as refresh_configs renders it after a move."""
        import time
        former = [("maple.tinhat.me", templates.acmedns_tls(ACME)), ("maple.local", "internal")]
        for ago, want in ((60, True), (setuptls.GRACE - 30, True), (setuptls.GRACE + 60, False)):
            st = {"phase": "ready", "ready_at": time.time() - ago}
            with self.subTest(ago=ago), mock.patch.object(setuptls, "available", lambda: True), \
                    mock.patch.object(state, "load_state", lambda st=st: st):
                out = templates.with_former_names(templates.caddy_domain("chat.example.org", DNS, DIRECTORY, False),
                                                  "chat.example.org", former)
                self.assertEqual(templates.has_setup_site(out), want)
                for name in ("chat.example.org", "maple.tinhat.me", "maple.local"):
                    self.assertEqual(POLICY in site(out, name), want, name)
                pre = templates.caddy_preflight("next.example.org", DNS, DIRECTORY, False,
                                                setup=templates.has_setup_site(out))
                self.assertEqual(POLICY in pre, want)

    def test_the_move_passes_the_grace_on(self):
        src = (_OPT / "manager" / "tinhat" / "move.py").read_text()
        self.assertIn("setup=templates.has_setup_site(current)", src)

    @unittest.skipUnless(CADDY and os.access(CADDY or "", os.X_OK), "TINHAT_TEST_CADDY isn't set")
    def test_caddy_matches_every_named_site_before_the_catch_all(self):
        former = [("maple.tinhat.me", templates.acmedns_tls(ACME)), ("maple.local", "internal")]
        with mock.patch.object(setuptls, "available", lambda: True), \
                mock.patch.object(state, "load_state", lambda: {"phase": "unconfigured"}):
            base = templates.with_former_names(templates.caddy_domain("chat.example.org", DNS, DIRECTORY, False),
                                               "chat.example.org", former)
        cf = base + templates.caddy_preflight("next.example.org", DNS, DIRECTORY, False,
                                              setup=templates.has_setup_site(base))
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / "Caddyfile").write_text(cf)
            env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
            r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                               capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        conf = json.loads(r.stdout)
        want = {"chat.example.org", "next.example.org", "maple.tinhat.me", "maple.local"}
        seen = set()
        for srv in conf["apps"]["http"]["servers"].values():
            pols = srv.get("tls_connection_policies") or []
            tagged = [i for i, p in enumerate(pols) if (p.get("certificate_selection") or {}).get("any_tag")]
            if not tagged:
                continue
            for i, p in enumerate(pols):
                for name in set((p.get("match") or {}).get("sni") or []) & want:
                    self.assertLess(i, min(tagged), name)
                    seen.add(name)
        self.assertEqual(seen, want)


if __name__ == "__main__":
    unittest.main()

"""Setup over plain http from outside the home (assembly-038, launch-gate's P2 of 2026-10-28): a VPS owner drives the
wizard from http://<address>/; once the server holds its certificate, port 80 answers an outside address only
GET /admin/setup/status, and that answer is a fixed allow-list (no owner, code, error text, addresses or version).
Also: the names limits say when they clear.

Needs the real aiohttp (the manager's web module); skipped where it isn't installed.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import web  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

FULL = {"phase": "installing", "serverName": "crew.tinhat.me", "mode": "anywhere", "zone": "tinhat.me", "moved": False,
        "unlocked": True, "setupSession": True, "edition": "appliance", "platform": None, "version": "0.3.8",
        "proxyOnly": False, "addresses": ["192.168.1.30"], "restoring": False, "error": "boom with a secret",
        "errorDetails": "TN-ABCD-EFGH owner hunter2",
        "progress": {"steps": [{"id": "secure", "label": "Getting a certificate (HTTPS)", "status": "done",
                                "detail": "the owner @owner:crew.tinhat.me"}],
                     "error": "x", "details": "secret details", "running": True, "elapsed": 12,
                     "question": {"title": "Use the relay?"}}}


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class OutsideStatus(unittest.TestCase):
    def test_exact_keys(self):
        doc = web.status_for_outside(FULL)
        self.assertEqual(set(doc), {"phase", "serverName", "progress"})
        self.assertEqual(set(doc["progress"]), {"steps", "running"})
        self.assertEqual([set(x) for x in doc["progress"]["steps"]], [{"id", "label", "status"}])
        flat = repr(doc)
        for secret in ("secret", "hunter2", "TN-ABCD", "@owner", "192.168", "0.3.8", "boom", "relay"):
            self.assertNotIn(secret, flat)
        self.assertEqual(web.OUTSIDE_STATUS_KEYS, ("phase", "serverName", "progress"))
        self.assertEqual(web.OUTSIDE_STEP_KEYS, ("id", "label", "status"))

    def test_ready_without_progress(self):
        self.assertEqual(web.status_for_outside({"phase": "ready", "serverName": "crew.tinhat.me", "mode": "anywhere",
                                                 "version": "0.3.8", "reach": {"ok": True}}),
                         {"phase": "ready", "serverName": "crew.tinhat.me", "progress": {"steps": [], "running": False}})
        # always the same key set, whatever the full answer had (Astra on baf2224)
        for full in ({}, {"phase": "failed", "error": "boom"}, FULL, {**FULL, "progress": "not a dict"}):
            doc = web.status_for_outside(full)
            self.assertEqual(set(doc), {"phase", "serverName", "progress"})
            self.assertEqual(set(doc["progress"]), {"steps", "running"})

    def test_when_the_allow_list_applies(self):
        def req(proto, ip):
            return SimpleNamespace(headers={"X-Forwarded-Proto": proto, "X-Forwarded-For": ip}, remote="127.0.0.1")
        orig = (web._https, web._home, web.state.public_mode)
        try:
            web.state.public_mode = lambda st: st.get("mode") in ("anywhere", "domain")
            web._https = lambda r: r.headers["X-Forwarded-Proto"] == "https"
            web._home = lambda r: r.headers["X-Forwarded-For"].startswith("192.168.")
            secured = {"steps": [{"id": "secure", "status": "done"}]}
            before = {"steps": [{"id": "secure", "status": "pending"}]}
            anywhere = {"mode": "anywhere", "phase": "installing"}
            self.assertTrue(web._plain_outside(req("http", "203.0.113.9"), anywhere, secured))
            self.assertTrue(web._plain_outside(req("http", "203.0.113.9"), {**anywhere, "phase": "ready"}, {}))
            self.assertTrue(web._plain_outside(req("http", "203.0.113.9"), {"mode": "domain", "phase": "ready"}, {}))
            self.assertFalse(web._plain_outside(req("http", "203.0.113.9"), anywhere, before), "before secure: as before")
            self.assertFalse(web._plain_outside(req("https", "203.0.113.9"), anywhere, secured), "https: the full answer")
            self.assertFalse(web._plain_outside(req("http", "192.168.1.20"), anywhere, secured), "home: the full answer")
            self.assertFalse(web._plain_outside(req("http", "203.0.113.9"), {"mode": "lan", "phase": "ready"}, {}), "LAN mode: unchanged")
            # port 80's outside route marks the request: cut down whatever the state says (a manager restart resets
            # the steps to pending; an interrupted install is "failed") — Astra on baf2224
            marked = req("http", "203.0.113.9")
            marked.headers[web.PLAIN_OUTSIDE_HEADER] = "1"
            self.assertTrue(web._plain_outside(marked, anywhere, before), "marked: steps reset by a restart")
            self.assertTrue(web._plain_outside(marked, {"mode": "anywhere", "phase": "failed"}, {}), "marked: failed")
            self.assertTrue(web._plain_outside(marked, {"phase": "installing"}, None), "marked: no mode in the state")
            # a home address Caddy's private_ranges doesn't know (the home network's global IPv6) is still home
            home6 = req("http", "192.168.1.20")
            home6.headers[web.PLAIN_OUTSIDE_HEADER] = "1"
            self.assertFalse(web._plain_outside(home6, {**anywhere, "phase": "ready"}, {}), "marked but home: the full answer")
        finally:
            web._https, web._home, web.state.public_mode = orig


def _fresh_names():
    """names.py itself (another test may have left a stand-in under tinhat.names)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("tinhat.names_fresh", _OPT / "manager" / "tinhat" / "names.py")
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "tinhat"
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class LimitHints(unittest.TestCase):
    def test_limits_say_when_they_clear(self):
        names = _fresh_names()
        e = names.NamesError("This internet connection already registered a server today. Try tomorrow.", "limit-ip", 429)
        self.assertIn("clears within a day", names.explain(e))
        e = names.NamesError("This server's address changed too often today.", "limit-ip-change", 429)
        self.assertIn("6 times in 24 hours", names.explain(e))
        e = names.NamesError("That name was just taken.", "taken", 409)
        self.assertEqual(names.explain(e), "That name was just taken.")


if __name__ == "__main__":
    unittest.main()

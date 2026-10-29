"""Dashboard sign-ins (security review, server manager lows; sec-night-2 2026-10-27): an absolute lifetime however busy
the sign-in is, and the sign-ins of an account that isn't an admin any more (demoted elsewhere, deactivated, gone) end
at the next re-check — but the chat server being down never signs anyone out.

Runs anywhere: sessions.py's config/state imports are stubbed (an in-memory file).
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest import mock

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
FILES = {}


def load():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        cfg = types.ModuleType("tinhat.config")
        cfg.STATE_DIR = pathlib.Path("/nonexistent-state")
        sys.modules["tinhat.config"] = cfg
        st = types.ModuleType("tinhat.state")
        st.read_json = lambda p, default=None: FILES.get(str(p), default)
        st.write_json = lambda p, data, mode=0o600: FILES.__setitem__(str(p), __import__("copy").deepcopy(data))
        sys.modules["tinhat.state"] = st
        spec = importlib.util.spec_from_file_location("tinhat.sessions", PKG / "sessions.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.sessions"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


sessions = load()
H = 3600


class Lifetime(unittest.TestCase):
    def setUp(self):
        FILES.clear()
        self.t = 1_000_000.0
        self.p = mock.patch.object(sessions.time, "time", lambda: self.t)
        self.p.start()

    def tearDown(self):
        self.p.stop()

    def test_a_busy_sign_in_still_ends_at_its_absolute_lifetime(self):
        s = sessions.Sessions(12, "f", max_hours=7 * 24)
        tok = s.new("@owner:a.test")
        for _ in range(7 * 24 // 6):  # used every 6 hours: the sliding 12 h never runs out
            self.t += 6 * H
            if self.t - 1_000_000.0 > 7 * 24 * H:
                break
            self.assertIsNotNone(s.get(tok))
        self.t = 1_000_000.0 + 7 * 24 * H + 1
        self.assertIsNone(s.get(tok))
        self.assertEqual(s.mxids(), [])
        s.prune()
        self.assertEqual(s.items, {})

    def test_an_expired_sign_in_is_gone_once_seen(self):
        s = sessions.Sessions(12, "f", max_hours=24)
        tok = s.new("@owner:a.test")
        self.t += 25 * H
        self.assertIsNone(s.get(tok))
        self.t -= 25 * H  # the clock set back: it stays gone
        self.assertIsNone(s.get(tok))
        self.assertEqual(s.items, {})

    def test_the_sliding_expiry_still_applies(self):
        s = sessions.Sessions(12, "f", max_hours=7 * 24)
        tok = s.new("@owner:a.test")
        self.t += 12 * H + 1
        self.assertIsNone(s.get(tok))

    def test_a_sign_in_from_before_the_update_starts_counting_at_load(self):
        FILES["f"] = {"k1": {"mxid": "@old:a.test", "until": self.t + 30 * H}}
        s = sessions.Sessions(12, "f", max_hours=24)
        self.assertEqual(s.items["k1"]["born"], self.t)
        self.t += 23 * H
        self.assertEqual(s.mxids(), ["@old:a.test"])
        self.t += 2 * H
        self.assertEqual(s.mxids(), [])

    def test_the_lifetime_survives_a_restart(self):
        s = sessions.Sessions(12, "f", max_hours=24)
        tok = s.new("@owner:a.test")
        self.t += 20 * H
        s.get(tok)
        s._save()
        s2 = sessions.Sessions(12, "f", max_hours=24)  # the manager restarted (an update)
        self.t += 5 * H
        self.assertIsNone(s2.get(tok), "born is kept in the file: a restart doesn't renew it")


class Recheck(unittest.TestCase):
    def setUp(self):
        FILES.clear()

    def _run(self, s, answers):
        async def lookup(mxid):
            a = answers[mxid]
            if isinstance(a, Exception):
                raise a
            return a
        return asyncio.run(sessions.recheck(s, lookup))

    def test_demoted_deactivated_and_gone_accounts_are_signed_out(self):
        s = sessions.Sessions(12, "f", max_hours=24)
        toks = {m: s.new(m) for m in ("@owner:a", "@demoted:a", "@gone:a", "@deact:a", "@down:a", "@err:a")}
        s.new("@demoted:a")  # two sign-ins of one account: both end
        ended = self._run(s, {
            "@owner:a": (200, {"admin": True}),
            "@demoted:a": (200, {"admin": False}),
            "@gone:a": (404, {}),
            "@deact:a": (200, {"admin": True, "deactivated": True}),
            "@down:a": (0, {}),  # the chat server not answering
            "@err:a": ConnectionError("refused"),
        })
        self.assertEqual(sorted(ended), ["@deact:a", "@demoted:a", "@gone:a"])
        self.assertIsNotNone(s.get(toks["@owner:a"]))
        self.assertIsNotNone(s.get(toks["@down:a"]), "an outage never signs anyone out")
        self.assertIsNotNone(s.get(toks["@err:a"]))
        for m in ("@demoted:a", "@gone:a", "@deact:a"):
            self.assertIsNone(s.get(toks[m]), m)
        self.assertEqual(s.mxids(), ["@down:a", "@err:a", "@owner:a"])


class Wiring(unittest.TestCase):
    def test_the_manager_uses_both(self):
        web = (PKG / "web.py").read_text()
        self.assertIn("sessions.Sessions(SESSION_HOURS, max_hours=SESSION_MAX_HOURS)", web)
        self.assertIn('max_hours=24)', web)
        self.assertIn("sessions.recheck(m.sessions", web)
        self.assertIn("_recheck_admins(m)", web)
        self.assertIn("m.operators[mxid] = (False, time.time())", web)
        self.assertIn("time.monotonic() >= m._admin_recheck_at", web)


if __name__ == "__main__":
    unittest.main()

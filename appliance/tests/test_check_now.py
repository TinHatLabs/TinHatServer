"""The owner's Check again (web.Manager._check_now, 0.3.10): it pauses the call server to check UDP 7882, except while a
call is going on; then it runs without the pause, as the manager's own checks do (reach.py). Needs the real aiohttp.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import os
import pathlib
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
try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class CheckAgain(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)

    def run_check(self, in_call):
        calls = []

        async def open_ports(c):
            calls.append(("ports", c))

        async def outside(c, unattended=False):
            calls.append(("outside", c, unattended))

        async def in_progress():
            return in_call
        m = mock.Mock()
        m.network_busy = False
        m.checker.open_ports, m.checker.outside = open_ports, outside
        with mock.patch.object(web.lkadmin, "call_in_progress", in_progress):
            ok = asyncio.run(web.Manager._check_now(m, {"calls": True}))
        self.assertTrue(ok)
        self.assertFalse(m.network_busy)
        return calls

    def test_no_pause_during_a_call(self):
        self.assertEqual(self.run_check(True), [("ports", True), ("outside", True, True)])

    def test_the_full_check_when_nobody_is_in_a_call(self):
        self.assertEqual(self.run_check(False), [("ports", True), ("outside", True, False)])

    def test_no_pause_when_livekit_cant_say_whether_a_call_is_going_on(self):
        # 0.3.10 release review: the room list timing out or failing counts as a call (fail safe): never pause blind
        self.assertEqual(self.run_check(None), [("ports", True), ("outside", True, True)])


if __name__ == "__main__":
    unittest.main()

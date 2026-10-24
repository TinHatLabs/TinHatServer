"""The forgotten-password code on the server's screen: a stranger pressing "Forgot" can't swap the owner's code for a
new one while it lasts, and one code takes only so many wrong tries (then it ends), so guessing 10^8 codes is hopeless
however many addresses someone has.

Runs anywhere: the console module recovery.py redraws is stubbed, the code file goes to a temporary folder.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        console = types.ModuleType("tinhat.console")
        console.refresh = lambda force=False: None
        sys.modules["tinhat.console"] = console
        spec = importlib.util.spec_from_file_location("tinhat.recovery", PKG / "recovery.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.recovery"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


recovery = load()


class RecoveryCode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = mock.patch.object(recovery, "CODE_FILE", pathlib.Path(self.tmp.name) / "recovery-code")
        self.p.start()
        self.r = mock.patch.object(recovery, "_redraw", lambda: None)  # the console imports lazily: not here
        self.r.start()
        recovery.clear()

    def tearDown(self):
        recovery.clear()
        self.r.stop()
        self.p.stop()
        self.tmp.cleanup()

    def test_pressing_forgot_again_keeps_the_code_on_the_screen(self):
        recovery.start()
        first = recovery.active()
        self.assertRegex(first, r"^\d{4}-\d{4}$")
        for _ in range(5):
            recovery.start()
        self.assertEqual(recovery.active(), first)
        self.assertTrue(recovery.check(first))

    def test_a_code_ends_after_its_wrong_tries(self):
        recovery.start()
        code = recovery.active()
        wrong = "0000-0000" if code != "0000-0000" else "1111-1111"
        for _ in range(recovery.TRIES - 1):
            self.assertFalse(recovery.check(wrong))
        self.assertEqual(recovery.active(), code)  # still there one short of the limit
        self.assertFalse(recovery.check(wrong))
        self.assertIsNone(recovery.active())  # ended: the right code doesn't work any more
        self.assertFalse(recovery.check(code))
        recovery.start()
        self.assertIsNotNone(recovery.active())  # a new one on the next "Forgot"

    def test_an_expired_code_makes_room_for_a_new_one(self):
        recovery.start()
        with mock.patch.object(recovery.time, "time", return_value=recovery._until + 1):
            self.assertIsNone(recovery.active())
            recovery.start()
            self.assertIsNotNone(recovery.active())


if __name__ == "__main__":
    unittest.main()

"""Invite codes: the dashboard (web._mint) and the Tin Hat API (api/tinhat-api/invites.mjs) mint the same shape,
TH-XXXX-XXXX from the same alphabet, which is what both apps' sign-up screens parse. Minting needs the real aiohttp
(the manager's web module); the agreement with the API's source runs anywhere."""
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_OPT = _ROOT / "appliance" / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import config  # noqa: E402

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import web  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

SHAPE = re.compile(r"^TH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$")


class Invites(unittest.TestCase):
    def test_the_api_mints_the_same_shape(self):
        src = (_ROOT / "api" / "tinhat-api" / "invites.mjs").read_text()
        self.assertIn(f'export const INVITE_PREFIX = "{config.INVITE_PREFIX}";', src)
        self.assertIn(f'const ALPHABET = "{config.INVITE_ALPHABET}";', src)
        self.assertEqual(config.INVITE_PREFIX, "TH-")

    @unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
    def test_the_dashboard_mints_th_codes(self):
        codes = {web._mint() for _ in range(300)}
        for c in codes:
            self.assertRegex(c, SHAPE)
        self.assertGreater(len(codes), 295)


if __name__ == "__main__":
    unittest.main()

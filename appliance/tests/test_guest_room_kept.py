"""The Guests room's own file (the API's guests.json: which room, on or off, its link) goes into every backup and comes
along when a server adopts an existing chat server. Without it a restored server knows no Guests room: Synapse's
rules then let no guest in, and turning the room on makes a second room while the first keeps the #guests alias."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import backup  # noqa: E402

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import adopt  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False


class GuestRoomKept(unittest.TestCase):
    def test_backups_keep_it(self):
        self.assertIn("api/guests.json", backup.STATE_ITEMS)
        self.assertIn("api/guest-accounts.json", backup.STATE_ITEMS)

    @unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
    def test_adoption_brings_it(self):
        self.assertIn("guests.json", adopt.API_ITEMS)
        self.assertIn("guest-accounts.json", adopt.API_ITEMS)


if __name__ == "__main__":
    unittest.main()

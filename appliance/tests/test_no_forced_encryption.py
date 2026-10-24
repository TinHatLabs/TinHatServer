"""New rooms are encrypted by the apps, never by the chat server (decided 2026-10-23: rooms encrypted by default, except
public rooms inside a space, #general and the Guests room). Synapse's `encryption_enabled_by_default_for_room_type` adds
m.room.encryption to EVERY new room, whatever the request asks (only server notices are spared), so with it set the Tin
Hat API couldn't make the Guests room unencrypted. Tin Hat Server never sets it: not in the homeserver.yaml it writes
(every mode, every feature switch), and nowhere else in what ships (the manager, the editions' files, the API)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_OPT = _ROOT / "appliance" / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import templates  # noqa: E402

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import install  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

KEY = "encryption_enabled_by_default"
SECRETS = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
           "postgres_password": "pg"}


class NoForcedEncryption(unittest.TestCase):
    def test_homeserver_yaml_never_forces_encryption(self):
        for federation in (None, [], ["friends.example.org"]):  # home network, from anywhere, connected servers
            for features in ({}, {"previews": True, "directory": False, "uploadMb": 500}):
                for gw in ("", "198.18.16.1"):
                    y = templates.homeserver_yaml("crew.example.org", SECRETS, features, federation, None, push_gateway=gw)
                    self.assertIn('server_name: "crew.example.org"', y)
                    self.assertNotIn(KEY, y, (federation, features, gw))

    def test_nothing_that_ships_sets_it(self):
        roots = [_ROOT / "appliance" / "rootfs", _ROOT / "compose", _ROOT / "windows", _ROOT / "api", _ROOT / "build"]
        hits = []
        for root in roots:
            for f in root.rglob("*"):
                if not f.is_file() or {"node_modules", "__pycache__", "test", "tests"} & set(f.parts):
                    continue
                try:
                    text = f.read_text(errors="ignore")
                except OSError:
                    continue
                if KEY in text:
                    hits.append(str(f.relative_to(_ROOT)))
        self.assertEqual(hits, [], "only the apps encrypt new rooms; the Guests room must stay unencrypted")


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class General(unittest.TestCase):
    """#general isn't end-to-end encrypted either (decided 2026-10-23): newcomers are joined to it without an invite, so
    they'd see everything said before they came in locked."""

    def test_general_is_made_without_encryption(self):
        req = install.general_room_request("crew.example.org")
        self.assertEqual(req["room_alias_name"], "general")
        self.assertNotIn("m.room.encryption", [e["type"] for e in req["initial_state"]])
        self.assertNotIn("megolm", repr(req))
        self.assertEqual(req["power_level_content_override"]["events"]["m.room.encryption"], 100, "only an admin could")
        self.assertEqual(req["creation_content"], {"m.federate": False})
        self.assertIn({"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "shared"}},
                      req["initial_state"])

    def test_setup_makes_general_from_it(self):
        src = (_OPT / "manager" / "tinhat" / "install.py").read_text()
        self.assertEqual(src.count("/_matrix/client/v3/createRoom"), 1)
        self.assertIn("json=general_room_request(sn)", src)


if __name__ == "__main__":
    unittest.main()

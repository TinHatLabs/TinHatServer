"""The apps' view of this server's federation (open network slice 1): apiconf.network() / publish_network() write
network.json for GET /api/network, the well-known offer carries the mode, and a connection change republishes it."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
_TMP = tempfile.mkdtemp()
os.environ["TINHAT_STATE"] = _TMP

from tinhat import apiconf, config, state  # noqa: E402

CONNS = [{"server": "squad.example", "since": 1, "by": "code"}, {"server": "Crew.Example", "since": 2, "by": "code"},
         {"server": "squad.example", "since": 3, "by": "code"}, {"server": ""}, "junk", {"server": 7}]
ALLOWED = [{"server": "plain.example", "since": 1, "by": "owner"}]
PATH = apiconf.DIR / "network.json"


def on_disk(**st):
    """state.json exactly as given (publish_network reads only the state on disk)."""
    Path(config.STATE_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(config.STATE_FILE).write_text(json.dumps(st))


def published() -> dict:
    """The document as the apps get it (without the age stamp)."""
    d = json.loads(PATH.read_text())
    d.pop("issued", None)
    return d


class Network(unittest.TestCase):
    def setUp(self):
        if PATH.exists():
            PATH.unlink()

    def test_home_mode_lists_nobody(self):
        for st in ({}, {"mode": "lan", "connections": CONNS}):
            self.assertEqual(apiconf.network(st), {"v": 1, "mode": "home", "connected": [], "blocked": [], "invites": {"default": "known"}})
            self.assertEqual(apiconf.network_mode(st), "home")

    def test_connected_lists_only_tin_hat_connections(self):
        st = {"mode": "anywhere", "connections": CONNS, "allowed_servers": ALLOWED, "federation": ["squad.example", "plain.example"]}
        doc = apiconf.network(st)
        self.assertEqual(doc, {"v": 1, "mode": "connected", "connected": ["crew.example", "squad.example"], "blocked": [], "invites": {"default": "known"}})
        self.assertNotIn("plain.example", doc["connected"])  # allowed by name = a plain Matrix server = "other"

    def test_publish_writes_once_and_only_on_change(self):
        on_disk(mode="anywhere", connections=CONNS[:1])
        self.assertTrue(apiconf.publish_network())
        self.assertEqual(published(), {"v": 1, "mode": "connected", "connected": ["squad.example"], "blocked": [], "invites": {"default": "known"}})
        self.assertEqual(PATH.stat().st_mode & 0o777, 0o600)
        self.assertFalse(apiconf.publish_network())
        on_disk(mode="anywhere", connections=[])
        self.assertTrue(apiconf.publish_network())
        self.assertEqual(published()["connected"], [])

    def test_an_older_snapshot_never_puts_a_connection_back(self):
        """astra r1 P2: a caller holding state from before a disconnect publishes after it."""
        stale = {"mode": "anywhere", "connections": CONNS[:1]}
        on_disk(mode="anywhere", connections=[])  # the disconnect is committed
        apiconf.publish_network(stale)
        self.assertEqual(published()["connected"], [])
        on_disk(mode="lan", connections=CONNS[:1])  # and a move to home mode
        apiconf.publish_network(stale)
        self.assertEqual(published(), {"v": 1, "mode": "home", "connected": [], "blocked": [], "invites": {"default": "known"}})

    def test_a_failed_write_removes_the_old_file(self):
        """astra r1 P1: never leave the old list (with a server that was disconnected) behind."""
        on_disk(mode="anywhere", connections=CONNS[:1])
        apiconf.publish_network()
        self.assertTrue(PATH.exists())
        on_disk(mode="anywhere", connections=[])
        with mock.patch.object(state, "write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                apiconf.publish_network()
        self.assertFalse(PATH.exists())
        apiconf.publish_network()
        self.assertEqual(published()["connected"], [])

    def test_age_stamp_and_hourly_renewal(self):
        """astra r2 P1: a list that can't be replaced expires in the API; a healthy one is renewed before that."""
        on_disk(mode="anywhere", connections=CONNS[:1])
        self.assertTrue(apiconf.publish_network(now=1_800_000_000))
        self.assertEqual(json.loads(PATH.read_text())["issued"], 1_800_000_000)
        self.assertFalse(apiconf.publish_network(now=1_800_000_000 + apiconf.NETWORK_RENEW_S - 1))
        self.assertTrue(apiconf.publish_network(now=1_800_000_000 + apiconf.NETWORK_RENEW_S))
        self.assertEqual(json.loads(PATH.read_text())["issued"], 1_800_000_000 + apiconf.NETWORK_RENEW_S)
        self.assertTrue(apiconf.publish_network(now=1_700_000_000))  # a clock that went back: written again
        self.assertLess(apiconf.NETWORK_RENEW_S, apiconf.NETWORK_MAX_AGE_S)
        self.assertEqual(apiconf.NETWORK_MAX_AGE_S, 6 * 3600)  # = network.mjs NETWORK.MAX_AGE_S

    def test_any_failure_under_the_lock_removes_the_old_file(self):
        """astra r2 P1: not only a failed write: reading the state fails too (e.g. a damaged state.json)."""
        on_disk(mode="anywhere", connections=CONNS[:1])
        apiconf.publish_network()
        with mock.patch.object(state, "load_state", side_effect=ValueError("damaged")):
            with self.assertRaises(ValueError):
                apiconf.publish_network()
        self.assertFalse(PATH.exists())

    def test_write_survives_a_failed_publish(self):
        on_disk(mode="anywhere", server_name="home.example", connections=CONNS[:1])
        secrets = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
                   "postgres_password": "pg", "livekit_key": "lk", "livekit_secret": "lksec", "system_token": "syt_x"}
        with mock.patch.object(apiconf, "publish_network", side_effect=OSError("disk full")), \
                mock.patch.object(apiconf, "docker_gateway", return_value="198.18.16.1"):
            with self.assertLogs("tinhat.apiconf", level="ERROR"):
                apiconf.write(state.load_state(), secrets)
        self.assertTrue((apiconf.DIR / "env").exists())  # the rest of write() still ran

    def test_offer_carries_the_mode_as_a_word(self):
        f = apiconf.features({"mode": "anywhere", "calls": True}, {})
        self.assertEqual(f["network"], "connected")
        self.assertEqual(apiconf.features({"calls": True}, {})["network"], "home")
        # the apps read only booleans as switches: the mode must never be a boolean
        self.assertIsInstance(f["network"], str)
        # one source for both: the offer's word and the API's document never disagree
        for st in ({"mode": "lan"}, {"mode": "anywhere"}, {"mode": "domain"}, {}):
            self.assertEqual(apiconf.features(st, {})["network"], apiconf.network(st)["mode"])


if __name__ == "__main__":
    unittest.main()

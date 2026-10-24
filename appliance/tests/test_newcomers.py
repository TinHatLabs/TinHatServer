"""New people land in #general, guests never (newcomers.py replaces Synapse's auto_join_rooms, which joined the guest
room's temporary accounts to General too)."""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ["TINHAT_STATE"] = tempfile.mkdtemp()
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import config, newcomers, state, templates  # noqa: E402

SN = "crew.example.org"


class FakeSynapse:
    def __init__(self, users):
        self.users, self.joined = users, []

    async def req(self, method, path, token=None, json=None):
        assert token == "syt"
        if path.startswith("/_synapse/admin/v2/users?"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(path).query)
            frm, lim = int(q.get("from", ["0"])[0]), int(q.get("limit", ["100"])[0])
            allu = sorted(self.users, key=lambda u: -(u["creation_ts"] if u["creation_ts"] > 10**11 else u["creation_ts"] * 1000))
            page = allu[frm:frm + lim]
            return 200, {"users": page, **({"next_token": str(frm + lim)} if frm + lim < len(allu) else {})}
        if path.startswith("/_matrix/client/v3/directory/room/"):
            return 200, {"room_id": "!general:crew.example.org"}
        if path.startswith("/_synapse/admin/v1/join/"):
            if json["user_id"] in getattr(self, "fail", set()):
                return 500, {"errcode": "M_UNKNOWN"}
            self.joined.append(json["user_id"])
            return 200, {"room_id": "!general:crew.example.org"}
        raise AssertionError(path)


class Newcomers(unittest.TestCase):
    def setUp(self):
        state.write_json(config.STATE_FILE, {"phase": "ready", "server_name": SN}, 0o644)
        state.write_json(config.SECRETS_FILE, {"system_token": "syt"})

    def run_tick(self, syn):
        return asyncio.run(newcomers.tick(syn))

    def test_first_look_only_remembers_now(self):
        syn = FakeSynapse([{"name": f"@old:{SN}", "creation_ts": 1}])
        self.assertEqual(self.run_tick(syn), 0)
        self.assertEqual(syn.joined, [])
        self.assertIsInstance(state.load_state()["newcomers_since"], int)

    def test_real_people_join_guests_and_the_system_never(self):
        t0 = int(time.time() * 1000) - 60_000
        state.save_state(newcomers_since=t0)
        syn = FakeSynapse([
            {"name": f"@amy:{SN}", "creation_ts": t0 + 1000},
            {"name": f"@guest-ab12cd:{SN}", "creation_ts": t0 + 2000},
            {"name": f"@{config.SYSTEM_LOCALPART}:{SN}", "creation_ts": t0 + 3000},
            {"name": f"@bot:{SN}", "creation_ts": t0 + 4000, "user_type": "bot"},
            {"name": f"@gone:{SN}", "creation_ts": t0 + 5000, "deactivated": 1},
            {"name": f"@bob:{SN}", "creation_ts": (t0 + 6000) // 1000},  # an older Synapse: seconds
            {"name": f"@before:{SN}", "creation_ts": t0 - 10 * 60_000},  # older than the overlap
        ])
        self.assertEqual(self.run_tick(syn), 2)
        self.assertEqual(sorted(syn.joined), [f"@amy:{SN}", f"@bob:{SN}"])  # bob's timestamp in seconds still counts
        for n in ("@guest-ab12cd", f"@{config.SYSTEM_LOCALPART}", "@bot", "@gone", "@before"):
            self.assertNotIn(f"{n}:{SN}", syn.joined)
        self.assertEqual(self.run_tick(syn), 0, "nobody twice")

    def test_more_than_a_page_same_instant_and_a_failed_join_is_retried(self):
        t0 = int(time.time() * 1000) - 60_000
        state.save_state(newcomers_since=t0, newcomers_done=[], newcomers_tries={})
        users = [{"name": f"@p{i}:{SN}", "creation_ts": t0 + 1000 + i} for i in range(250)]  # three pages
        users.append({"name": f"@same:{SN}", "creation_ts": t0})  # made in the watermark's own millisecond
        syn = FakeSynapse(users)
        syn.fail = {f"@p7:{SN}"}
        self.assertEqual(self.run_tick(syn), 250)  # all but p7, and `same` (inside the overlap) too
        self.assertIn(f"@same:{SN}", syn.joined)
        self.assertNotIn(f"@p7:{SN}", syn.joined)
        syn.fail = set()
        self.assertEqual(self.run_tick(syn), 1, "the failed one is retried, nobody else twice")
        self.assertEqual(syn.joined.count(f"@p7:{SN}"), 1)
        self.assertEqual(len(syn.joined), len(set(syn.joined)))

    def test_synapse_no_longer_auto_joins(self):
        y = templates.homeserver_yaml(SN, {"registration_shared_secret": "a", "macaroon_secret_key": "b", "form_secret": "c",
                                           "postgres_password": "d"}, {}, None, None)
        self.assertNotIn("auto_join_rooms:", y)


if __name__ == "__main__":
    unittest.main()

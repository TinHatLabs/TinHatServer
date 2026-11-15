"""The admins hear about backup and update trouble in Tin Hat (notices.py, D04.1, QOL sweep 2026-11-13): one direct
message from the server's own account per watch item when it appears, again daily while a serious one stays, once when
backups work again; m.text so phones notify; the DM made once and reused while the admin is in it.
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
    from tinhat import notices, web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)

SN = "crew.test"
DAY = 86400
FAILED = {"key": "backup-failed", "level": "bad", "text": "The last backup didn't work."}
SETUP = {"key": "backup-setup", "level": "warn", "text": "Backups aren't set up yet."}
ROLLED = {"key": "update-rolled-back", "level": "warn", "text": "The last update didn't start properly."}


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class Plan(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.plan = notices.plan

    def run_days(self, items_by_step, step=3600):
        sent, said = {}, []
        for i, items in enumerate(items_by_step):
            out, sent = self.plan(items, sent, 1_000_000 + i * step)
            said.append([k for k, _ in out])
        return said

    def test_a_failed_backup_is_said_at_once_then_daily_then_its_fix(self):
        hours = [[FAILED]] * 25 + [[]] + [[]]
        said = self.run_days(hours)
        self.assertEqual(said[0], ["backup-failed"])
        self.assertEqual(sum(1 for s in said[1:24] if s), 0)    # not every tick
        self.assertEqual(said[24], ["backup-failed"])            # a day later, still failing
        self.assertEqual(said[25], ["backup-ok"])                # works again: said once
        self.assertEqual(said[26], [])

    def test_failed_then_unconfigured_is_not_working_again(self):
        """Astra review r1 (Medium): backups switched off after a failure turn backup-failed into backup-setup; that
        isn't "Backups work again"."""
        said = self.run_days([[FAILED], [SETUP], [SETUP]])
        self.assertEqual(said, [["backup-failed"], [], []])

    def test_a_rolled_back_update_is_said_once(self):
        said = self.run_days([[ROLLED]] * 60)
        self.assertEqual([s for s in said if s], [["update-rolled-back"]])

    def test_not_set_up_waits_two_days(self):
        said = self.run_days([[SETUP]] * 60)
        self.assertEqual(said[47], [])
        self.assertEqual(said[48], ["backup-setup"])
        self.assertEqual([s for s in said if s], [["backup-setup"]])
        self.assertEqual(self.run_days([[SETUP]] * 10 + [[]] * 50), [[]] * 60)  # set up meanwhile: nothing

    def test_info_and_keyless_items_never_go_out(self):
        items = [{"key": "update-waiting", "level": "info", "text": "x installs as soon as the calls end."},
                 {"level": "bad", "text": "no key"}]
        self.assertEqual(self.run_days([items] * 3), [[], [], []])

    def test_a_new_version_waiting_is_news(self):
        a = {"key": "update-waiting", "level": "warn", "text": "Tin Hat Server 1.0.1 is out."}
        b = {**a, "text": "Tin Hat Server 1.0.2 is out."}
        self.assertEqual(self.run_days([[a], [a], [b], [b]]), [["update-waiting"], [], ["update-waiting"], []])

    def test_message_is_text_not_a_notice(self):
        m = notices.message("The last backup didn't work.", f"https://{SN}/admin/")
        self.assertEqual(m, {"msgtype": "m.text", "body": f"The last backup didn't work. Open the dashboard: https://{SN}/admin/"})


class FakeSynapse:
    def __init__(self, users, member="join"):
        self.users_list, self.member, self.calls, self.rooms = users, member, [], 0
        self.fail_rooms = set()  # sends into these rooms fail

    async def users(self, tok):
        return self.users_list

    async def req(self, method, path, token=None, json=None, client=None):
        self.calls.append((method, path, json))
        if path.endswith("/createRoom"):
            self.rooms += 1
            return 200, {"room_id": f"!r{self.rooms}:{SN}"}
        if "/state/m.room.member/" in path:
            return 200, {"membership": self.member}
        if "/send/" in path and any(r.replace("!", "%21").replace(":", "%3A") in path for r in self.fail_rooms):
            return 502, {}
        return 200, {}


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class Send(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.dir = tempfile.mkdtemp()
        self.file = pathlib.Path(self.dir) / "notices.json"

    def tick(self, syn, items, now):
        with mock.patch.object(notices, "FILE", self.file), \
                mock.patch.object(notices.state, "load_secrets", return_value={"system_token": "syt"}), \
                mock.patch.object(notices.state, "load_state", return_value={"server_name": SN}):
            return asyncio.run(notices.tick(syn, items, f"https://{SN}/admin/", now))

    USERS = [{"name": f"@owner:{SN}", "admin": True}, {"name": f"@ana:{SN}", "admin": True},
             {"name": f"@sam:{SN}", "admin": False}, {"name": f"@old:{SN}", "admin": True, "deactivated": True},
             {"name": f"@tinhat-system:{SN}", "admin": True}, {"name": "@far:other.example", "admin": True}]

    def test_each_admin_gets_one_dm_reused_next_time(self):
        syn = FakeSynapse(self.USERS)
        self.assertEqual(self.tick(syn, [FAILED], 1_000_000), 2)
        made = [c for c in syn.calls if c[1].endswith("/createRoom")]
        self.assertEqual(sorted(c[2]["invite"][0] for c in made), [f"@ana:{SN}", f"@owner:{SN}"])
        self.assertTrue(all(c[2]["is_direct"] and c[2]["preset"] == "trusted_private_chat" for c in made))
        self.assertNotIn("initial_state", made[0][2])  # nothing that would turn on encryption
        sends = [c for c in syn.calls if "/send/m.room.message/" in c[1]]
        self.assertEqual({c[2]["msgtype"] for c in sends}, {"m.text"})
        self.assertTrue(any(c[1].endswith("/displayname") and c[2] == {"displayname": "Tin Hat Server"} for c in syn.calls))
        syn.calls.clear()
        self.assertEqual(self.tick(syn, [FAILED], 1_000_000 + DAY), 2)
        self.assertEqual([c for c in syn.calls if c[1].endswith("/createRoom")], [])  # the same rooms
        self.assertFalse(any(c[1].endswith("/displayname") for c in syn.calls))

    def test_an_admin_who_left_gets_a_new_dm(self):
        syn = FakeSynapse(self.USERS)
        self.tick(syn, [FAILED], 1_000_000)
        syn.member, syn.calls = "leave", []
        self.tick(syn, [FAILED], 1_000_000 + DAY)
        self.assertEqual(len([c for c in syn.calls if c[1].endswith("/createRoom")]), 2)

    def test_one_admins_failed_delivery_is_retried_for_them_only(self):
        """Astra review r1 (Medium): a failed send to one admin used to count as told for everyone."""
        syn = FakeSynapse(self.USERS)
        syn.fail_rooms = {f"!r2:{SN}"}  # the second admin's DM (rooms are made in admin order)
        self.assertEqual(self.tick(syn, [ROLLED], 1_000_000), 1)
        syn.fail_rooms, syn.calls = set(), []
        self.assertEqual(self.tick(syn, [ROLLED], 1_000_060), 1)  # only the one who missed it
        sends = [c for c in syn.calls if "/send/" in c[1]]
        self.assertEqual(len(sends), 1)
        self.assertIn("%21r2%3A", sends[0][1])
        syn.calls = []
        self.assertEqual(self.tick(syn, [ROLLED], 1_000_120), 0)

    def test_quiet_when_nothing_to_say(self):
        syn = FakeSynapse(self.USERS)
        self.assertEqual(self.tick(syn, [], 1_000_000), 0)
        self.assertEqual(syn.calls, [])


if __name__ == "__main__":
    unittest.main()

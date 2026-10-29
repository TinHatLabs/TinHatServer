"""Synapse's tinhat_rules (manager/synapse/tinhat_rules.py): guests stay in the room they were let into. Runs without
Synapse: its few imports are stood in for."""
import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

for name in ("synapse", "synapse.api", "synapse.api.errors", "synapse.module_api", "synapse.spam_checker_api"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["synapse.api.errors"].Codes = types.SimpleNamespace(FORBIDDEN="M_FORBIDDEN")
sys.modules["synapse.module_api"].NOT_SPAM = "NOT_SPAM"
sys.modules["synapse.module_api"].ModuleApi = object
sys.modules["synapse.spam_checker_api"].RegistrationBehaviour = types.SimpleNamespace(ALLOW="allow", DENY="deny")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat" / "manager" / "synapse"))
import tinhat_rules  # noqa: E402

G, ELSEWHERE, OTHER = "!guests:example.org", "!lounge:example.org", "!general:example.org"
NEW, OLD = "@guest-aaaaaaaaaaaa:example.org", "@guest-bbbbbbbbbbbb:example.org"


class FakeApi:
    def register_spam_checker_callbacks(self, **kw):
        self.cb = kw

    def register_third_party_rules_callbacks(self, **kw):
        self.tpr = kw

    def is_mine(self, user_id):
        return str(user_id).endswith(":example.org")

    async def get_room_state(self, room_id, types_):
        raise AssertionError("the rules never read a room's state: only the Guests room takes guests")


def rules(accounts, owner=None):
    d = tempfile.mkdtemp()
    if owner is not None:
        Path(d, "protected-accounts.json").write_text(json.dumps({"owner": owner}))
    if accounts is not None:
        Path(d, "guest-accounts.json").write_text(json.dumps(accounts))
    Path(d, "guests-room.json").write_text(json.dumps({"room": G}))
    return tinhat_rules.GuestRules({"dir": d, "protected": str(Path(d, "protected-accounts.json"))}, FakeApi())


def ok(coro):
    return asyncio.run(coro) == "NOT_SPAM"


class Rules(unittest.TestCase):
    def test_each_guest_only_its_own_room(self):
        r = rules([{"user": NEW, "room": G}, {"user": OLD, "room": ELSEWHERE}])
        self.assertTrue(ok(r.user_may_join_room(NEW, G, False)))
        self.assertFalse(ok(r.user_may_join_room(NEW, OTHER, False)))
        self.assertFalse(ok(r.user_may_join_room(NEW, ELSEWHERE, False)))

    def test_only_the_guests_room_takes_guests(self):
        r = rules([{"user": NEW, "room": G}, {"user": OLD, "room": ELSEWHERE}])
        self.assertFalse(ok(r.user_may_join_room(OLD, ELSEWHERE, False)), "listed for a room that isn't the Guests room")
        self.assertFalse(ok(r.user_may_join_room(OLD, G, False)), "and not the Guests room either: it isn't its room")
        self.assertFalse(ok(r.user_may_invite("@alice:example.org", OLD, ELSEWHERE)))
        d = tempfile.mkdtemp()  # no guests-room.json (the room was never made): no room takes guests
        Path(d, "guest-accounts.json").write_text(json.dumps([{"user": NEW, "room": G}]))
        self.assertFalse(ok(tinhat_rules.GuestRules({"dir": d}, FakeApi()).user_may_join_room(NEW, G, False)))

    def test_fail_closed(self):
        for accounts in (None, "not a list", [NEW]):  # missing, broken, the old plain-id format
            r = rules(accounts)
            self.assertFalse(ok(r.user_may_join_room(NEW, G, False)), accounts)
            self.assertFalse(ok(r.user_may_create_room(NEW, {})), accounts)
        r = rules([])
        self.assertFalse(ok(r.user_may_join_room("@guest-unlisted:example.org", G, False)))
        self.assertTrue(ok(r.user_may_join_room("@alice:example.org", OTHER, False)), "everyone else as before")
        self.assertTrue(ok(r.user_may_create_room("@alice:example.org", {})))

    def test_invites(self):
        r = rules([{"user": NEW, "room": G}])
        self.assertFalse(ok(r.user_may_invite(NEW, "@alice:example.org", G)), "guests invite nobody")
        self.assertTrue(ok(r.user_may_invite("@alice:example.org", NEW, G)))
        self.assertFalse(ok(r.user_may_invite("@alice:example.org", NEW, OTHER)))
        self.assertTrue(ok(r.user_may_invite("@alice:example.org", "@bob:example.org", OTHER)))


class OwnerGuard(unittest.TestCase):
    def test_a_vanished_or_broken_file_keeps_the_last_owner(self):
        import os, time
        r = rules([], owner=self.OWNER)
        self.assertFalse(self.can(r, self.OWNER))
        p = r.protected.path
        Path(p).write_bytes(b"\xff not json")
        os.utime(p, ns=(time.time_ns() + 10_000_000,) * 2)
        self.assertFalse(self.can(r, self.OWNER), "broken file: the last owner stays protected")
        os.unlink(p)
        self.assertFalse(self.can(r, self.OWNER), "missing file: the last owner stays protected")
        Path(p).write_text(json.dumps({"owner": ""}))
        self.assertTrue(self.can(r, self.OWNER), "the manager saying 'no owner' is a real answer")

    def test_an_error_refuses(self):
        r = rules([], owner=self.OWNER)

        def boom(_):
            raise RuntimeError("x")
        r.is_protected = boom
        self.assertFalse(self.can(r, "@alice:example.org"), "Synapse would allow on an exception: we refuse instead")

    OWNER = "@owner:example.org"

    def can(self, r, user, by_admin=False):
        return asyncio.run(r.check_can_deactivate_user(user, by_admin))

    def test_the_owner_and_the_system_account_are_never_deactivated(self):
        r = rules([], owner=self.OWNER)
        self.assertIn("check_can_deactivate_user", r.api.tpr, "registered as a third-party rule")
        for by_admin in (False, True):
            self.assertFalse(self.can(r, self.OWNER, by_admin), f"owner, by_admin={by_admin}")
            self.assertFalse(self.can(r, "@tinhat-system:example.org", by_admin))
        self.assertTrue(self.can(r, "@alice:example.org"), "everyone else may delete their account")
        self.assertTrue(self.can(r, "@owner:other.org"), "the same name elsewhere isn't ours")
        self.assertTrue(self.can(r, "@tinhat-system:other.org"), "another server's system account isn't ours")
        self.assertTrue(self.can(r, "@TinHat-System:example.org"), "exactly the system account's id, nothing like it")
        self.assertTrue(self.can(r, NEW), "guests are deactivated by the API")

    def test_no_file_protects_only_the_system_account(self):
        r = rules([])
        self.assertTrue(self.can(r, self.OWNER))
        self.assertFalse(self.can(r, "@tinhat-system:example.org"))
        r = rules([], owner="")
        self.assertTrue(self.can(r, self.OWNER), "an unknown owner protects nobody by mistake")
        self.assertTrue(self.can(r, ""))

    def test_the_file_is_reread_when_it_changes(self):
        r = rules([], owner=self.OWNER)
        self.assertFalse(self.can(r, self.OWNER))
        import os, time
        p = r.protected.path
        Path(p).write_text(json.dumps({"owner": "@new:example.org"}))
        os.utime(p, ns=(time.time_ns() + 10_000_000, time.time_ns() + 10_000_000))
        self.assertTrue(self.can(r, self.OWNER))
        self.assertFalse(self.can(r, "@new:example.org"))


if __name__ == "__main__":
    unittest.main()

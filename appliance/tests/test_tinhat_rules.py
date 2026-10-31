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



# ---- other servers' rooms (0.3.10: MATRIX-FRONTEND-DESIGN B0 "Old clients") -----------------------------------------
class Ev:
    def __init__(self, type_, sender, content, state_key="", room="!r:elsewhere.org"):
        self.type, self.sender, self.content, self.state_key, self.room_id = type_, sender, content, state_key, room

    def is_state(self):
        return self.state_key is not None


ME, THEM = "@ann:example.org", "@bob:elsewhere.org"
PL = {"users": {ME: 100, THEM: 100}, "events": {"m.room.name": 50, "dev.tinhat.brb": 50}, "state_default": 50}


def guard(connected=(), former=()):
    d = tempfile.mkdtemp()
    return tinhat_rules.GuestRules({"dir": d, "connected": list(connected), "former": list(former)}, FakeApi())


def state(creator, pl=PL, extra=None):
    c = {"room_version": "12" if extra is not None else "10"}
    if extra is not None:
        c["additional_creators"] = extra
    return {("m.room.create", ""): Ev("m.room.create", creator, c),
            ("m.room.power_levels", ""): Ev("m.room.power_levels", creator, pl)}


def allowed(g, ev, st):
    ok_, _ = asyncio.run(g.check_event_allowed(ev, st))
    return ok_


def lowered(**events):
    return {**PL, "events": {**PL["events"], **events}}


class ForeignRooms(unittest.TestCase):
    def test_registered(self):
        g = guard()
        self.assertIs(g.api.tpr["check_event_allowed"].__func__, tinhat_rules.GuestRules.check_event_allowed)

    def test_old_app_provisioning_in_a_foreign_room_is_refused(self):
        g = guard()
        st = state(THEM)
        self.assertFalse(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"dev.tinhat.brb": 0, "dev.tinhat.reel": 0})), st))
        self.assertFalse(allowed(g, Ev("dev.tinhat.brb", ME, {"on": True}, state_key=ME), st))

    def test_a_persons_own_power_level_edit_passes(self):
        g = guard()
        st = state(THEM)
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"m.room.name": 0})), st))
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, {**PL, "users": {**PL["users"], "@cy:example.org": 50}}), st))
        # a mixed change (a person's edit that also touches a Tin Hat key) is theirs: it passes
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"m.room.name": 0, "dev.tinhat.brb": 0})), st))
        # an unchanged re-send changes nothing: passes
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, dict(PL)), st))

    def test_our_rooms_are_untouched(self):
        for g, creator in ((guard(), ME), (guard(connected=["friend.org"]), "@x:friend.org"),
                           (guard(former=["old.tinhat.me"]), "@ann:old.tinhat.me")):
            st = state(creator)
            self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"dev.tinhat.brb": 0})), st), creator)
            self.assertTrue(allowed(g, Ev("dev.tinhat.brb", ME, {"on": True}, state_key=ME), st), creator)

    def test_v12_additional_creators_count(self):
        g = guard()
        self.assertFalse(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"dev.tinhat.brb": 0})),
                                 state(ME, extra=[THEM])))
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, lowered(**{"dev.tinhat.brb": 0})),
                                state(ME, extra=["@cy:example.org"])))
        self.assertFalse(allowed(g, Ev("dev.tinhat.brb", ME, {}, state_key=ME), state(ME, extra="not-a-list")))

    def test_other_servers_events_and_other_types_pass(self):
        g = guard()
        st = state(THEM)
        self.assertTrue(allowed(g, Ev("m.room.power_levels", THEM, lowered(**{"dev.tinhat.brb": 0})), st))
        self.assertTrue(allowed(g, Ev("dev.tinhat.brb", THEM, {}, state_key=THEM), st))
        self.assertTrue(allowed(g, Ev("m.room.message", ME, {"body": "hi"}, state_key=None), st))
        self.assertTrue(allowed(g, Ev("m.room.name", ME, {"name": "x"}), st))
        self.assertTrue(allowed(g, Ev("org.matrix.msc3401.call.member", ME, {}, state_key="_" + ME), st))

    def test_a_failure_lets_the_event_through(self):
        g = guard()

        class Broken(dict):
            def get(self, *a):
                raise RuntimeError("boom")
        self.assertTrue(allowed(g, Ev("dev.tinhat.brb", ME, {}, state_key=ME), Broken()))

    def test_frozen_content_compares(self):
        class Frozen:
            def __init__(self, d):
                self._d = d

            def keys(self):
                return self._d.keys()

            def items(self):
                return [(k, Frozen(v) if isinstance(v, dict) else tuple(v) if isinstance(v, list) else v)
                        for k, v in self._d.items()]

            def get(self, k, default=None):
                return self._d.get(k, default)
        self.assertTrue(tinhat_rules.only_tinhat_keys_differ(Frozen(PL), Frozen(lowered(**{"dev.tinhat.x": 0}))))
        self.assertFalse(tinhat_rules.only_tinhat_keys_differ(Frozen(PL), Frozen(dict(PL))))


class OnlyLoweringIsRefused(unittest.TestCase):
    """0.3.10 release review: the guard stops old apps LOWERING Tin Hat's levels in a foreign room; a person tightening
    them (a raise, or removing an override that leaves the key higher) is not refused."""

    def pl(self, events, **extra):
        return {"users": {ME: 100, THEM: 100}, "events": {"m.room.name": 50, **events}, **extra}

    def check(self, old_events, new_events, want, **extra):
        g = guard()
        st = state(THEM, pl=self.pl(old_events, **extra))
        self.assertEqual(allowed(g, Ev("m.room.power_levels", ME, self.pl(new_events, **extra)), st), want,
                         (old_events, new_events, extra))

    def test_a_raise_passes(self):
        self.check({"dev.tinhat.brb": 0}, {"dev.tinhat.brb": 50}, True, state_default=50)

    def test_a_lowering_is_refused(self):
        self.check({"dev.tinhat.brb": 50}, {"dev.tinhat.brb": 0}, False, state_default=50)

    def test_removing_an_override_that_raises_passes(self):
        # 0 -> the room's default (state_default 50; as a message type events_default 0: not lower either)
        self.check({"dev.tinhat.brb": 0}, {}, True, state_default=50)

    def test_removing_an_override_that_lowers_is_refused(self):
        self.check({"dev.tinhat.brb": 100}, {}, False, state_default=50)

    def test_adding_a_higher_override_passes_and_a_lower_one_is_refused(self):
        self.check({}, {"dev.tinhat.brb": 100}, True, state_default=50)
        self.check({}, {"dev.tinhat.brb": 0}, False, state_default=50)

    def test_lowering_under_either_default_counts(self):
        # 10 removed: as a state type it rises to 50, as a message type it falls to events_default 0 -> refused
        self.check({"dev.tinhat.brb": 10}, {}, False, state_default=50, events_default=0)

    def test_string_levels_read_as_synapse_does(self):
        self.check({"dev.tinhat.brb": "50"}, {"dev.tinhat.brb": 0}, False, state_default=50)
        self.check({"dev.tinhat.brb": "0"}, {"dev.tinhat.brb": 50}, True, state_default=50)

    def test_legacy_boolean_levels_read_as_synapse_does(self):
        # an old room's federated `true` is level 1 (Synapse: int()); 1 -> 2 is a raise, true -> 0 a lowering
        self.check({"dev.tinhat.brb": True}, {"dev.tinhat.brb": 2}, True, state_default=50)
        self.check({"dev.tinhat.brb": True}, {"dev.tinhat.brb": 0}, False, state_default=50)

    def test_the_helper(self):
        self.assertTrue(tinhat_rules.tinhat_level_lowered({"events": {"dev.tinhat.x": 50}}, {"events": {"dev.tinhat.x": 0}}))
        self.assertFalse(tinhat_rules.tinhat_level_lowered({"events": {"dev.tinhat.x": 0}}, {"events": {"dev.tinhat.x": 50}}))
        self.assertFalse(tinhat_rules.tinhat_level_lowered({"events": {"m.room.name": 50}}, {"events": {"m.room.name": 0}}))


class MoreForeignRooms(unittest.TestCase):
    def test_a_missing_events_map_is_an_empty_one(self):
        g = guard()
        st = state(THEM, pl={"users": {ME: 100}})
        self.assertFalse(allowed(g, Ev("m.room.power_levels", ME, {"users": {ME: 100}, "events": {"dev.tinhat.x": 0}}), st))
        # an empty events map added and nothing else: no Tin Hat key changed, it passes
        self.assertTrue(allowed(g, Ev("m.room.power_levels", ME, {"users": {ME: 100}, "events": {}}), st))
        self.assertFalse(tinhat_rules.only_tinhat_keys_differ({"users": {}}, {"users": {}, "events": {}}))

    def test_additional_creators_only_count_from_version_12(self):
        g = guard()
        st = state(ME)
        st[("m.room.create", "")].content = {"room_version": "11", "additional_creators": [THEM]}
        self.assertTrue(allowed(g, Ev("dev.tinhat.brb", ME, {}, state_key=ME), st))
        st[("m.room.create", "")].content = {"room_version": "10", "additional_creators": "junk"}
        self.assertTrue(allowed(g, Ev("dev.tinhat.brb", ME, {}, state_key=ME), st))
        st[("m.room.create", "")].content = {"room_version": "12", "additional_creators": [THEM]}
        self.assertFalse(allowed(g, Ev("dev.tinhat.brb", ME, {}, state_key=ME), st))


class HomeserverYaml(unittest.TestCase):
    def test_the_module_gets_connected_and_former_names(self):
        tpl = Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/templates.py"
        src = tpl.read_text()
        block = src[src.index("  - module: tinhat_rules.GuestRules"):src.index("  - module: tinhat_calls.CallHook")]
        self.assertIn("connected: {federation_whitelist}", block)
        self.assertIn("former: {former_names}", block)
        try:  # rendered and parsed, where the manager's modules load (they need nothing but the standard library)
            import yaml
        except ImportError:
            self.skipTest("no PyYAML here")
        sys.path.insert(0, str(tpl.parents[1]))
        saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
        try:
            for k in list(saved):
                del sys.modules[k]
            from tinhat import templates  # noqa: E402
            secrets_ = {"postgres_password": "x", "registration_shared_secret": "y", "macaroon_secret_key": "z",
                        "form_secret": "w"}
            doc = yaml.safe_load(templates.homeserver_yaml("chat.example.org", secrets_, {}, ["friend.org", "b.org"],
                                                           former=["old.tinhat.me", "bad name"]))
        finally:
            for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
                del sys.modules[k]
            sys.modules.update(saved)
            sys.path.remove(str(tpl.parents[1]))
        mod = next(m for m in doc["modules"] if m["module"] == "tinhat_rules.GuestRules")["config"]
        self.assertEqual(mod["connected"], ["b.org", "friend.org"])
        self.assertEqual(mod["former"], ["old.tinhat.me"])
        self.assertEqual(sorted(doc["federation_domain_whitelist"]), ["b.org", "friend.org"])

if __name__ == "__main__":
    unittest.main()

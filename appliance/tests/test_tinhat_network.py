"""Synapse's tinhat_network (manager/synapse/tinhat_network.py): the owner's deny-list and each person's rule for invites
from other servers, with quotas that survive a restart (docs/NETWORK-RULES.md). Runs without Synapse: its few imports
are stood in for, and the store / account data are small fakes."""
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

for name in ("synapse", "synapse.api", "synapse.api.errors", "synapse.module_api", "synapse.spam_checker_api",
             "synapse.types", "synapse.handlers", "synapse.handlers.worker_lock"):
    sys.modules.setdefault(name, types.ModuleType(name))
if not hasattr(sys.modules["synapse.types"], "UserID"):
    sys.modules["synapse.types"].UserID = types.SimpleNamespace(from_string=lambda s: s)
    sys.modules["synapse.types"].create_requester = lambda s, authenticated_entity=None: ("requester", s, authenticated_entity)
    sys.modules["synapse.handlers.worker_lock"].NEW_EVENT_DURING_PURGE_LOCK_NAME = "purge"
if not hasattr(sys.modules["synapse.api.errors"], "Codes"):
    sys.modules["synapse.api.errors"].Codes = types.SimpleNamespace(FORBIDDEN="M_FORBIDDEN")
if not hasattr(sys.modules["synapse.module_api"], "NOT_SPAM"):
    sys.modules["synapse.module_api"].NOT_SPAM = "NOT_SPAM"
    sys.modules["synapse.module_api"].ModuleApi = object
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat" / "manager" / "synapse"))
import tinhat_network  # noqa: E402

VECTORS = Path(__file__).resolve().parent / "vectors" / "network" / "invite_rules_v.json"

HOME = "home.example"
ME, YOU = f"@me:{HOME}", f"@you:{HOME}"
EVIL, FRIEND, PEER = "@spam:evil.example", "@sam:friend.example", "@pat:peer.example"


class Ev:
    def __init__(self, sender, state_key, room="!r:evil.example", type_="m.room.member", content=None):
        self.sender, self.state_key, self.room_id, self.type = sender, state_key, room, type_
        self.event_id = ""
        self.content = content if content is not None else {"membership": "invite"}

    def is_state(self):
        return True


class Store:
    def __init__(self):
        self.rooms: dict[str, set] = {}

    async def get_rooms_for_user(self, user_id):
        return frozenset(self.rooms.get(user_id, set()))


class AccountData:
    def __init__(self):
        self.data: dict[tuple, object] = {}
        self.fail = False

    async def get_global(self, user_id, data_type):
        if self.fail:
            raise RuntimeError("database down")
        return self.data.get((user_id, data_type))


class FakeApi:
    def __init__(self):
        self._store = Store()
        self.account_data_manager = AccountData()
        self.join_rules: dict[str, str | None] = {}
        self.members: dict[tuple, object] = {}  # (room, user) -> the current m.room.member event
        self.background: list = []  # run_as_background_process jobs, run by the test (drain)
        self.memberships: list[tuple] = []  # update_room_membership calls

    def register_spam_checker_callbacks(self, **kw):
        self.cb = kw

    def register_third_party_rules_callbacks(self, **kw):
        self.tpr = kw

    def is_mine(self, user_id):
        return str(user_id).endswith(":" + HOME)

    async def get_room_state(self, room_id, filt):
        if filt and filt[0][0] == "m.room.member":
            ev = self.members.get((room_id, filt[0][1]))
            return {} if ev is None else {("m.room.member", filt[0][1]): ev}
        rule = self.join_rules.get(room_id)
        if rule is None:
            return {}
        return {("m.room.join_rules", ""): types.SimpleNamespace(content={"join_rule": rule})}

    def run_as_background_process(self, desc, func, *args):
        self.background.append((desc, func, args))

    async def update_room_membership(self, sender, target, room_id, new_membership, content=None):
        self.memberships.append((sender, target, room_id, new_membership))
        self.members[(room_id, target)] = types.SimpleNamespace(event_id="$leave", content={"membership": new_membership})

    async def sleep(self, seconds):
        self.slept = getattr(self, "slept", []) + [seconds]

    def drain(self):
        jobs, self.background = self.background, []
        for _desc, func, args in jobs:
            run(func(*args))


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def run(coro):
    return asyncio.run(coro)


def reason(res):
    return None if res == "NOT_SPAM" else res[1].get("dev.tinhat.reason")


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.clock = Clock()
        self.api = FakeApi()
        self.rules_path = os.path.join(self.dir, "network-rules.json")
        self.db_path = os.path.join(self.dir, "network.db")

    def make(self, **cfg):
        c = {"rules": self.rules_path, "db": self.db_path, "connected": ["peer.example"], **cfg}
        return tinhat_network.NetworkRules(c, self.api, now=self.clock)

    def invite(self, r, sender, to=ME, room="!r:evil.example"):
        return reason(run(r.federated_user_may_invite(Ev(sender, to, room))))

    def rule(self, user, remote):
        self.api.account_data_manager.data[(user, "dev.tinhat.invite_rules")] = {"v": 1, "remote": remote}


class Registration(Base):
    def test_callbacks(self):
        r = self.make()
        self.assertIs(self.api.cb["federated_user_may_invite"].__self__, r)
        self.assertIs(self.api.cb["check_event_for_spam"].__self__, r)
        self.assertIn("on_new_event", self.api.tpr)


class Blocked(Base):
    def test_blocked_server_refused_whatever_the_rule(self):
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["evil.example"]}))
        r = self.make()
        self.rule(ME, "anyone")
        self.assertEqual(self.invite(r, EVIL), "server-blocked")
        self.assertIsNone(self.invite(r, FRIEND), "another server, rule anyone: arrives")

    def test_spellings_of_a_blocked_server(self):
        r = self.make(blocked=["evil.example"])
        self.rule(ME, "anyone")
        for s in ("@a:EVIL.example", "@a:evil.example.", "@a:evil.example:8448", "@a:Evil.Example.:443"):
            self.assertEqual(self.invite(r, s), "server-blocked", s)
        self.assertIsNone(self.invite(r, "@a:notevil.example"))
        self.assertIsNone(self.invite(r, "@a:evil.example.org"))

    def test_config_list_counts_when_the_file_is_missing_or_broken(self):
        r = self.make(blocked=["evil.example"])
        self.rule(ME, "anyone")
        self.assertEqual(self.invite(r, EVIL), "server-blocked", "no file: the list from homeserver.yaml")
        Path(self.rules_path).write_text("{broken")
        self.assertEqual(self.invite(r, EVIL), "server-blocked", "a broken file never unblocks")
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": []}))
        self.assertEqual(self.invite(r, EVIL), "server-blocked", "an emptier file never unblocks what the config has")

    def test_the_file_is_read_live(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, EVIL))
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["evil.example"]}))
        self.assertEqual(self.invite(r, EVIL), "server-blocked")
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": []}))
        self.assertIsNone(self.invite(r, EVIL), "unblocked (not in the config either)")

    def test_a_sender_without_a_server_is_refused(self):
        r = self.make()
        self.assertEqual(self.invite(r, "nobody"), "server-blocked")


class Rules(Base):
    def test_default_is_known(self):
        r = self.make()
        self.assertEqual(self.invite(r, FRIEND), "invite-rules", "a stranger, no rule set")
        for bad in ({"v": 2, "remote": "anyone"}, {"remote": "anyone"}, {"v": 1, "remote": "Anyone"}, "anyone", [], {"v": "x"}):
            self.api.account_data_manager.data[(ME, "dev.tinhat.invite_rules")] = bad
            self.assertEqual(self.invite(r, FRIEND), "invite-rules", repr(bad))

    def test_nobody(self):
        r = self.make()
        self.rule(ME, "nobody")
        self.api.account_data_manager.data[(ME, "m.direct")] = {FRIEND: ["!dm:x"]}
        self.assertEqual(self.invite(r, FRIEND), "invite-rules", "even someone I have a DM with")
        self.assertEqual(self.invite(r, PEER), "invite-rules", "even a connected server's person")

    def test_anyone(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND))

    def test_known_by_dm(self):
        r = self.make()
        self.api.account_data_manager.data[(ME, "m.direct")] = {FRIEND: ["!dm:x"]}
        self.assertIsNone(self.invite(r, FRIEND))
        self.assertEqual(self.invite(r, "@other:friend.example"), "invite-rules", "a DM with one person there only")

    def test_known_by_connected_server(self):
        r = self.make()
        self.assertIsNone(self.invite(r, PEER), "a Tin Hat server connected by code: both owners agreed")

    def test_known_by_shared_private_room_not_public(self):
        r = self.make()
        st = self.api._store
        st.rooms[ME] = {"!pub:x", "!priv:x", "!res:x"}
        st.rooms[FRIEND] = {"!pub:x"}
        self.api.join_rules = {"!pub:x": "public", "!priv:x": "invite", "!res:x": "restricted"}
        self.assertEqual(self.invite(r, FRIEND), "invite-rules", "sharing a public room doesn't count")
        st.rooms[FRIEND] = {"!pub:x", "!priv:x"}
        self.assertIsNone(self.invite(r, FRIEND), "an invite-only room does")
        st.rooms[FRIEND] = {"!res:x"}
        self.assertIsNone(self.invite(r, FRIEND), "a restricted one too")
        self.api.join_rules["!res:x"] = None  # no join rules event: the spec's default, invite
        self.assertIsNone(self.invite(r, FRIEND))

    def test_known_by_an_accepted_invite_survives_a_restart(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND, room="!party:friend.example"))
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "join"}), {}))
        self.rule(ME, "known")
        r2 = self.make()  # Synapse restarted: the same database
        self.assertIsNone(self.invite(r2, FRIEND), "accepted once: known from then on")
        self.assertEqual(self.invite(r2, "@other:friend.example"), "invite-rules")

    def test_joining_another_room_doesnt_accept(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.invite(r, FRIEND, room="!party:friend.example")
        run(r.on_new_event(Ev(ME, ME, "!elsewhere:x", content={"membership": "join"}), {}))
        run(r.on_new_event(Ev(YOU, YOU, "!party:friend.example", content={"membership": "join"}), {}))
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "leave"}), {}))
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND), "invite-rules")

    def test_a_broken_check_refuses(self):
        r = self.make()
        self.api.account_data_manager.fail = True
        self.assertEqual(self.invite(r, FRIEND), "invite-rules")
        self.assertEqual(self.invite(r, PEER), "invite-rules", "fail closed, whoever it is")

    def test_invites_to_remote_people_are_not_ours(self):
        r = self.make()
        self.assertIsNone(self.invite(r, FRIEND, to="@x:elsewhere.example"))


class Quotas(Base):
    def test_per_server_counts_refused_ones_too(self):
        r = self.make(quotas={"per_server": 3})
        for _ in range(3):
            self.assertEqual(self.invite(r, FRIEND, to=YOU), "invite-rules")
        self.rule(ME, "anyone")
        self.assertEqual(self.invite(r, "@x:friend.example"), "too-many-invites", "4th from friend.example this hour")
        self.assertIsNone(self.invite(r, "@x:other.example"), "another server isn't affected")
        self.clock.t += 3601
        self.assertIsNone(self.invite(r, "@x:friend.example"), "an hour later")

    def test_default_quotas(self):
        r = self.make()
        self.assertEqual(r.quotas, {"per_server": 20, "per_recipient": 5, "overall": 100, "window_s": 3600})
        for i in range(25):
            self.rule(f"@u{i}:{HOME}", "anyone")
        got = [self.invite(r, f"@s{i}:spam.example", to=f"@u{i}:{HOME}") for i in range(25)]
        self.assertEqual(got.count(None), 20)
        self.assertEqual(got[20:], ["too-many-invites"] * 5)

    def test_per_recipient_from_strangers(self):
        r = self.make(quotas={"per_recipient": 2})
        self.rule(ME, "anyone")
        self.api.account_data_manager.data[(ME, "m.direct")] = {"@known:k.example": []}
        self.assertIsNone(self.invite(r, "@a:s1.example"))
        self.assertIsNone(self.invite(r, "@a:s2.example"))
        self.assertEqual(self.invite(r, "@a:s3.example"), "too-many-invites")
        self.assertIsNone(self.invite(r, "@known:k.example"), "someone known isn't a stranger")
        self.rule(YOU, "anyone")
        self.assertIsNone(self.invite(r, "@a:s4.example", to=YOU), "another person has their own count")

    def test_overall(self):
        r = self.make(quotas={"overall": 3})
        for i in range(5):
            self.rule(f"@u{i}:{HOME}", "anyone")
        got = [self.invite(r, f"@a:s{i}.example", to=f"@u{i}:{HOME}") for i in range(5)]
        self.assertEqual(got, [None, None, None, "too-many-invites", "too-many-invites"])

    def test_quotas_survive_a_restart(self):
        r = self.make(quotas={"per_server": 2})
        self.rule(ME, "anyone")
        self.invite(r, FRIEND)
        self.invite(r, FRIEND)
        r2 = self.make(quotas={"per_server": 2})
        self.assertEqual(self.invite(r2, FRIEND), "too-many-invites")

    def test_a_broken_database_skips_quotas_not_rules(self):
        r = self.make(quotas={"per_server": 1}, db=os.path.join(self.dir, "missing", "dir", "x.db"))
        self.assertIsNone(r.db)
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND))
        self.assertIsNone(self.invite(r, FRIEND), "no quotas without the database")
        self.rule(ME, "nobody")
        self.assertEqual(self.invite(r, FRIEND), "invite-rules", "the rules still apply")

    def test_bad_quota_config_keeps_defaults(self):
        r = self.make(quotas={"per_server": 0, "overall": True, "per_recipient": "9", "window_s": -1, "other": 5})
        self.assertEqual(r.quotas, tinhat_network.DEFAULT_QUOTAS)

    def test_refusals_are_recorded_without_recipients_leaking_into_the_reasons(self):
        r = self.make(blocked=["evil.example"])
        self.invite(r, EVIL)
        self.invite(r, FRIEND)
        rows = r.db.db.execute("SELECT server, outcome FROM invites ORDER BY ts").fetchall()
        self.assertEqual(sorted(rows), [("evil.example", "server-blocked"), ("friend.example", "invite-rules")])


class ReviewR1(Base):
    """Astra r1 (high): retried deliveries, declined invites, the live list, the thread pool, the day of history."""
    def test_a_retried_invite_counts_once(self):
        r = self.make(quotas={"per_server": 2})
        self.rule(ME, "anyone")
        ev = Ev(FRIEND, ME, "!r:friend.example")
        ev.event_id = "$same"
        for _ in range(5):
            self.assertEqual(reason(run(r.federated_user_may_invite(ev))), None, "the same signed invite, delivered again")
        self.assertIsNone(self.invite(r, "@b:friend.example"), "the second real invite still fits the quota")
        self.assertEqual(self.invite(r, "@c:friend.example"), "too-many-invites")

    def test_a_declined_invite_never_makes_the_inviter_known(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.invite(r, FRIEND, room="!party:friend.example")
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "leave"}), {}))  # declined
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "join"}), {}))   # joined later another way
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND), "invite-rules")

    def test_only_the_latest_inviter_in_a_room_is_accepted(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.invite(r, FRIEND, room="!party:friend.example")
        self.invite(r, "@other:friend.example", room="!party:friend.example")
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "join"}), {}))
        self.rule(ME, "known")
        self.assertIsNone(self.invite(r, "@other:friend.example"))
        self.assertEqual(self.invite(r, FRIEND), "invite-rules")

    def test_a_server_blocked_live_stays_blocked_when_the_file_goes(self):
        r = self.make()
        self.rule(ME, "anyone")
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["evil.example"]}))
        self.assertEqual(self.invite(r, EVIL), "server-blocked")
        os.unlink(self.rules_path)
        self.assertEqual(self.invite(r, EVIL), "server-blocked", "missing file: the last good list")
        Path(self.rules_path).write_text("[1, 2")
        self.assertEqual(self.invite(r, EVIL), "server-blocked", "broken file: the last good list")
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": []}))
        self.assertIsNone(self.invite(r, EVIL), "the manager's new list unblocks it")

    def test_the_database_runs_on_the_thread_pool(self):
        used = []

        async def defer_to_thread(f, *a):
            used.append(f.__name__)
            return f(*a)
        self.api.defer_to_thread = defer_to_thread
        r = self.make()
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND))
        run(r.on_new_event(Ev(ME, ME, "!r:evil.example", content={"membership": "join"}), {}))
        self.assertEqual(used, ["is_accepted", "check", "answered"], "pending is written inside check's transaction")

    def test_a_day_of_refusals_is_kept(self):
        r = self.make()
        self.invite(r, FRIEND)
        self.clock.t += 23 * 3600
        self.rule(ME, "anyone")
        self.invite(r, "@x:other.example")
        self.assertEqual(r.db.db.execute("SELECT COUNT(*) FROM invites WHERE outcome = 'invite-rules'").fetchone()[0], 1)


class ReviewMaxR1(Base):
    """Astra max r1: invites inside a room this server is in (/send), rule versions, pruning."""
    def spam(self, r, ev):
        return reason(run(r.check_event_for_spam(ev)))

    def test_an_invite_arriving_inside_a_room_gets_the_same_rules(self):
        r = self.make(blocked=["evil.example"])
        self.assertEqual(self.spam(r, Ev(EVIL, ME, "!shared:x")), "server-blocked")
        self.assertEqual(self.spam(r, Ev(FRIEND, ME, "!shared:x")), "invite-rules", "a stranger, default known")
        self.rule(ME, "nobody")
        self.assertEqual(self.spam(r, Ev(PEER, ME, "!shared:x")), "invite-rules")
        self.rule(ME, "anyone")
        self.assertIsNone(self.spam(r, Ev(FRIEND, ME, "!shared:x")))

    def test_everything_else_passes_untouched(self):
        r = self.make(blocked=["evil.example"])
        self.rule(ME, "nobody")
        for ev in (Ev(ME, YOU, "!x:home.example"),                                     # a local invite
                   Ev(EVIL, "@x:other.example", "!x:evil.example"),                     # for someone elsewhere
                   Ev(EVIL, ME, content={"membership": "join"}),                        # not an invite
                   Ev(EVIL, "", type_="m.room.message", content={"body": "hi"})):       # not a membership
            self.assertIsNone(self.spam(r, ev), (ev.sender, ev.state_key, ev.type))
        self.assertEqual(r.db.db.execute("SELECT COUNT(*) FROM invites").fetchone()[0], 0)

    def test_the_two_paths_are_one_decision(self):
        r = self.make(quotas={"per_server": 1})
        self.rule(ME, "anyone")
        ev = Ev(FRIEND, ME, "!r:friend.example")
        ev.event_id = "$one"
        self.assertIsNone(self.spam(r, ev))
        self.assertIsNone(reason(run(r.federated_user_may_invite(ev))), "the /invite path after the spam check")
        self.assertEqual(r.db.db.execute("SELECT COUNT(*) FROM invites").fetchone()[0], 1)
        bad = Ev(FRIEND, ME, "!r2:friend.example")
        bad.event_id = "$two"
        self.api.account_data_manager.fail = True
        self.assertEqual(self.spam(r, bad), "invite-rules")
        self.api.account_data_manager.fail = False
        self.assertEqual(reason(run(r.federated_user_may_invite(bad))), "invite-rules", "a refusal stays a refusal")

    def test_rule_versions_follow_the_shared_vectors(self):
        """INV-V: appliance/tests/vectors/network/invite_rules_v.json is the one definition every side reads (the apps copy it
        byte for byte): accepted v = a number equal to 1 or "1" / "1.0"; any other v = "nobody"."""
        doc = json.loads(VECTORS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(doc["cases"]), 40)
        for case in doc["cases"]:
            with self.subTest(case["name"]):
                text = case["content_json"]
                try:
                    content = None if text is None else json.loads(text)
                except ValueError:  # read.unreadable: not JSON = nobody (Synapse never stores such a document)
                    self.assertEqual(case["rule"], "nobody")
                    continue
                self.assertEqual(tinhat_network.parse_rule(content), case["rule"])

    def test_the_vectors_cover_what_the_apps_and_server_disagreed_on(self):
        names = {c["name"]: c["rule"] for c in json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]}
        self.assertEqual(names['v string "1.0"'], "anyone")
        self.assertEqual(names["v true"], "nobody")
        self.assertEqual(names["v missing"], "nobody")
        self.assertEqual(names["no document"], "known")

    def test_an_unreadable_version_refuses_remote_invites(self):
        r = self.make()
        self.api.account_data_manager.data[(ME, "dev.tinhat.invite_rules")] = {"v": 2, "remote": "anyone"}
        self.assertEqual(self.invite(r, FRIEND), "invite-rules")
        self.api.account_data_manager.data[(ME, "dev.tinhat.invite_rules")] = {"v": "1.0", "remote": "anyone"}
        self.assertIsNone(self.invite(r, "@x:other.example"))

    def test_refusals_alone_are_pruned(self):
        r = self.make(blocked=["evil.example"])
        self.invite(r, EVIL)
        self.clock.t += 26 * 3600
        self.invite(r, EVIL)
        self.assertEqual(r.db.db.execute("SELECT COUNT(*) FROM invites").fetchone()[0], 1)


class ReviewHighR2(Base):
    """Astra r2: history, retries after a decline, refusals that stick, an older database."""
    def test_old_invites_are_judged_never_counted(self):
        r = self.make(quotas={"per_server": 1})
        self.rule(ME, "anyone")
        for i in range(3):
            ev = Ev(FRIEND, ME, f"!old{i}:friend.example")
            ev.event_id, ev.origin_server_ts = f"$old{i}", (self.clock.t - 2 * 3600) * 1000
            self.assertIsNone(reason(run(r.check_event_for_spam(ev))), "history: allowed by the rule, not counted")
        self.assertIsNone(self.invite(r, "@new:friend.example"), "the quota is untouched")
        self.rule(ME, "nobody")
        ev = Ev(FRIEND, ME, "!old9:friend.example")
        ev.event_id, ev.origin_server_ts = "$old9", (self.clock.t - 2 * 3600) * 1000
        self.assertEqual(reason(run(r.check_event_for_spam(ev))), "invite-rules", "backdating skips quotas, not rules")
        self.clock.t += 3601  # a new quota hour: what follows is about trust only
        self.rule(ME, "anyone")
        run(r.on_new_event(Ev(ME, ME, "!old0:friend.example", content={"membership": "join"}), {}))
        self.rule(ME, "known")
        self.assertEqual(reason(run(r.federated_user_may_invite(Ev(FRIEND, ME, "!q:friend.example")))), "invite-rules",
                         "an old invite joined never made its inviter known")

    def test_a_retried_invite_never_brings_back_a_declined_one(self):
        r = self.make()
        self.rule(ME, "anyone")
        ev = Ev(FRIEND, ME, "!party:friend.example")
        ev.event_id = "$a"
        run(r.federated_user_may_invite(ev))
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "leave"}), {}))
        run(r.check_event_for_spam(ev))  # the same invite again, through /send
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "join"}), {}))
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND, room="!other:friend.example"), "invite-rules")

    def test_a_refusal_after_an_accept_sticks(self):
        r = self.make()
        self.rule(ME, "anyone")
        ev = Ev(FRIEND, ME, "!r:friend.example")
        ev.event_id = "$x"
        self.assertIsNone(reason(run(r.check_event_for_spam(ev))))
        self.rule(ME, "nobody")
        self.assertEqual(reason(run(r.federated_user_may_invite(ev))), "invite-rules")
        self.rule(ME, "anyone")
        self.assertEqual(reason(run(r.federated_user_may_invite(ev))), "invite-rules", "ok -> refused -> stays refused")

    def test_an_older_database_layout_is_replaced(self):
        import sqlite3
        c = sqlite3.connect(self.db_path)
        c.executescript("CREATE TABLE invites (ts REAL, server TEXT, recipient TEXT, outcome TEXT, stranger INTEGER);"
                        "CREATE TABLE pending (room TEXT, recipient TEXT, inviter TEXT, ts REAL, PRIMARY KEY (room, recipient, inviter));"
                        "INSERT INTO invites VALUES (1, 'a', 'b', 'ok', 0);")
        c.commit()
        c.close()
        r = self.make()
        self.assertIsNotNone(r.db, "quotas stay on")
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND))
        cols = [x[1] for x in r.db.db.execute("PRAGMA table_info(invites)")]
        self.assertIn("event_id", cols)
        self.assertEqual(r.db.db.execute("PRAGMA user_version").fetchone()[0], tinhat_network.SCHEMA)
        r2 = self.make()  # and a restart keeps the new layout's rows
        self.assertEqual(r2.db.db.execute("SELECT COUNT(*) FROM invites").fetchone()[0], 1)


class ReviewHighR3(Base):
    """Astra r3: early refusals stick, history never counts on any path, a refused invite leaves no pending."""
    def ev(self, eid, sender=FRIEND, room="!r:friend.example", age_s=0):
        e = Ev(sender, ME, room)
        e.event_id, e.origin_server_ts = eid, (self.clock.t - age_s) * 1000
        return e

    def test_an_early_refusal_sticks(self):
        r = self.make()
        self.rule(ME, "anyone")
        e = self.ev("$e")
        self.assertIsNone(reason(run(r.check_event_for_spam(e))))
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["friend.example"]}))
        self.assertEqual(reason(run(r.federated_user_may_invite(e))), "server-blocked")
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": []}))
        self.assertEqual(reason(run(r.federated_user_may_invite(e))), "server-blocked", "unblocked later: still refused")

    def test_history_never_counts_on_the_early_paths(self):
        r = self.make(blocked=["evil.example"], quotas={"per_server": 1})
        for i in range(5):
            run(r.check_event_for_spam(self.ev(f"$h{i}", sender=EVIL, age_s=7200)))
        self.api.account_data_manager.fail = True
        for i in range(5):
            run(r.check_event_for_spam(self.ev(f"$f{i}", age_s=7200)))
        self.api.account_data_manager.fail = False
        self.assertEqual(r.db.db.execute("SELECT COUNT(*) FROM invites").fetchone()[0], 0)
        self.rule(ME, "anyone")
        self.assertIsNone(self.invite(r, FRIEND), "the live invite fits its quota")

    def test_a_refused_invite_leaves_no_pending(self):
        r = self.make()
        self.rule(ME, "anyone")
        e = self.ev("$p", room="!party:friend.example")
        self.assertIsNone(reason(run(r.check_event_for_spam(e))))
        self.rule(ME, "nobody")
        self.assertEqual(reason(run(r.federated_user_may_invite(e))), "invite-rules")
        run(r.on_new_event(Ev(ME, ME, "!party:friend.example", content={"membership": "join"}), {}))
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND, room="!other:friend.example"), "invite-rules")


class ReviewHighR4(Base):
    """Astra r4: a join trusts only the invite it answered; pruning keeps the configured window; refusals after
    pruning still clear the pending invite."""
    def ev(self, eid, sender=FRIEND, room="!party:friend.example"):
        e = Ev(sender, ME, room)
        e.event_id, e.origin_server_ts = eid, self.clock.t * 1000
        return e

    def join(self, r, room, replaces):
        e = Ev(ME, ME, room, content={"membership": "join"})
        e.unsigned = {"replaces_state": replaces}
        run(r.on_new_event(e, {}))

    def test_only_the_answered_invite_is_trusted(self):
        r = self.make()
        self.rule(ME, "anyone")
        run(r.federated_user_may_invite(self.ev("$inv")))
        self.join(r, "!party:friend.example", "$something-else")  # a join that didn't follow this invite
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND, room="!o:friend.example"), "invite-rules")
        self.rule(ME, "anyone")
        run(r.federated_user_may_invite(self.ev("$inv2", room="!p2:friend.example")))
        self.join(r, "!p2:friend.example", "$inv2")
        self.rule(ME, "known")
        self.assertIsNone(self.invite(r, FRIEND, room="!o2:friend.example"))

    def test_pruning_keeps_the_configured_window(self):
        r = self.make(quotas={"per_server": 2, "window_s": 48 * 3600})
        self.rule(ME, "anyone")
        self.invite(r, FRIEND)
        self.invite(r, FRIEND)
        self.clock.t += 30 * 3600
        self.invite(r, EVIL)  # another server's invite (prunes)
        r.db.refused("x.example", ME, "server-blocked")  # and a refusal (prunes too)
        self.assertEqual(self.invite(r, FRIEND), "too-many-invites", "30 h later, still inside the 48 h window")

    def test_a_refusal_after_pruning_clears_the_pending(self):
        r = self.make()
        self.rule(ME, "anyone")
        run(r.federated_user_may_invite(self.ev("$old")))
        self.clock.t += 26 * 3600
        self.invite(r, "@x:other.example")  # prunes the 26 h old record
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["friend.example"]}))
        e = self.ev("$old")
        e.origin_server_ts = (self.clock.t - 26 * 3600) * 1000
        run(r.check_event_for_spam(e))
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": []}))
        self.join(r, "!party:friend.example", "$old")
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND, room="!o:friend.example"), "invite-rules")


class ReviewHighR5(Base):
    def test_a_quota_refused_replay_clears_the_pending(self):
        r = self.make(quotas={"per_server": 1})
        self.rule(ME, "anyone")
        e = Ev(FRIEND, ME, "!party:friend.example")
        e.event_id, e.origin_server_ts = "$fut", (self.clock.t + 30 * 3600) * 1000  # dated in the future
        self.assertIsNone(reason(run(r.federated_user_may_invite(e))))
        self.clock.t += 26 * 3600
        self.assertIsNone(self.invite(r, "@b:friend.example"))  # prunes $fut's record, fills the quota
        self.assertEqual(reason(run(r.check_event_for_spam(e))), "too-many-invites")
        j = Ev(ME, ME, "!party:friend.example", content={"membership": "join"})
        j.unsigned = {"replaces_state": "$fut"}
        run(r.on_new_event(j, {}))
        self.clock.t += 3601
        self.rule(ME, "known")
        self.assertEqual(self.invite(r, FRIEND, room="!o:friend.example"), "invite-rules")


class _Lock:
    def __init__(self, on_enter=None):
        self.on_enter, self.entered = on_enter, []

    def queue(self, key):
        lock = self

        class Ctx:
            async def __aenter__(self):
                lock.entered.append(key)
                if lock.on_enter:
                    lock.on_enter()

            async def __aexit__(self, *a):
                return False
        return Ctx()


class FakeMemberHandler:
    """Synapse's RoomMemberHandler as _leave_locked uses it: the per-room lock, then update_membership_locked."""
    def __init__(self, api, on_enter=None, fail=0):
        self.api, self.member_linearizer, self.fail, self.calls = api, _Lock(on_enter), fail, []

    async def update_membership_locked(self, requester, target, room, action, ratelimit=True, require_consent=True):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("M_LIMIT_EXCEEDED")
        self.calls.append((target, room, action, ratelimit))
        self.api.members[(room, target)] = types.SimpleNamespace(event_id="$leave", content={"membership": action})


class ReviewRound4ON1(Base):
    """Review round 4, ON-1: an invite inside a shared room sent with a wrong content hash is stored by Synapse as its
    own redacted copy (still membership=invite) WITHOUT check_event_for_spam. on_new_event is then the only hook that
    sees it: it gets the same decision, and a refused one that is the person's current membership is declined."""
    ROOM = "!shared:evil.example"

    def redacted(self, eid, sender=EVIL, to=ME, room=ROOM, current=True):
        """The redacted invite as Synapse stored it (no check ran); current: it is the person's membership now."""
        e = Ev(sender, to, room)
        e.event_id, e.origin_server_ts = eid, self.clock.t * 1000
        if current:
            self.api.members[(room, to)] = e
        return e

    def arrive(self, r, e):
        state = {("m.room.member", k[1]): v for k, v in self.api.members.items() if k[0] == e.room_id}
        run(r.on_new_event(e, state))  # the current state, as Synapse passes it
        self.api.drain()

    def setUp(self):
        super().setUp()
        self.rm = FakeMemberHandler(self.api)
        self.api._hs = types.SimpleNamespace(get_room_member_handler=lambda: self.rm)

        async def local_membership(user, room):
            ev = self.api.members.get((room, user))
            return (None, None) if ev is None else ((ev.content or {}).get("membership"), ev.event_id)
        self.api._store.get_local_current_membership_for_user_in_room = local_membership

    def declined(self, room=ROOM, who=ME):
        return (who, room, "leave", False) in self.rm.calls


    def test_rule_nobody_declines_a_redacted_invite(self):
        r = self.make()
        self.rule(ME, "nobody")
        self.arrive(r, self.redacted("$red"))
        self.assertTrue(self.declined(), "the redacted invite must not stay the person's invite")

    def test_rule_known_declines_a_stranger(self):
        r = self.make()
        self.arrive(r, self.redacted("$red"))  # default rule "known", no DM / shared private room / accepted
        self.assertTrue(self.declined())

    def test_a_blocked_server_is_declined_and_shows_on_the_dashboard(self):
        Path(self.rules_path).write_text(json.dumps({"v": 1, "blocked": ["evil.example"]}))
        r = self.make()
        self.rule(ME, "anyone")
        self.arrive(r, self.redacted("$red"))
        self.assertTrue(self.declined())
        self.assertEqual(r.db.outcome("$red"), "server-blocked")

    def test_quotas_count_redacted_invites(self):
        r = self.make(quotas={"per_server": 2})
        self.rule(ME, "anyone")
        self.rule(YOU, "anyone")
        for i, who in enumerate((ME, YOU)):
            self.arrive(r, self.redacted(f"$ok{i}", to=who, room=f"!s{i}:evil.example"))
        self.assertEqual(self.rm.calls, [], "within the quota: accepted")
        self.arrive(r, self.redacted("$over", room="!s9:evil.example"))
        self.assertTrue(self.declined("!s9:evil.example"))
        self.assertEqual(r.db.outcome("$over"), "too-many-invites")
        # and the /invite path sees the same counter
        self.assertEqual(self.invite(r, EVIL, room="!s10:evil.example"), "too-many-invites")

    def test_an_accepted_redacted_invite_stays_and_answers_normally(self):
        r = self.make()
        self.rule(ME, "anyone")
        self.arrive(r, self.redacted("$red", sender=FRIEND, room="!p:friend.example"))
        self.assertEqual(self.rm.calls, [])
        self.assertEqual(r.db.outcome("$red"), "ok")
        j = Ev(ME, ME, "!p:friend.example", content={"membership": "join"})
        j.unsigned = {"replaces_state": "$red"}
        run(r.on_new_event(j, {}))
        self.rule(ME, "known")
        self.assertIsNone(self.invite(r, FRIEND, room="!o:friend.example"), "accepting it made the inviter known")

    def test_works_without_the_quota_database(self):
        r = self.make()
        r.db = None
        self.rule(ME, "nobody")
        self.arrive(r, self.redacted("$red"))
        self.assertTrue(self.declined())

    def test_a_broken_check_declines(self):
        r = self.make()
        self.api.account_data_manager.fail = True
        self.arrive(r, self.redacted("$red"))
        self.assertTrue(self.declined(), "fail closed, like the other two paths")

    # --- negative controls: what must NOT be declined -------------------------------------------------------------
    def test_an_invite_decided_before_keeps_its_decision(self):
        """Accepted by check_event_for_spam on arrival: a hiccup or a rule change by the time Synapse notifies never
        declines it (only an undecided invite gets judged here)."""
        r = self.make()
        self.rule(ME, "anyone")
        e = self.redacted("$fine", sender=FRIEND, room="!p:friend.example")
        self.assertIsNone(reason(run(r.check_event_for_spam(e))))
        self.rule(ME, "nobody")
        self.api.account_data_manager.fail = True
        self.arrive(r, e)
        self.assertEqual(self.rm.calls, [])

    def test_a_soft_failed_invite_is_left_alone(self):
        """Refused on arrival (soft-failed): not the person's membership, so nothing to decline (a leave would be
        rejected, or worse, end a newer membership)."""
        r = self.make()
        self.rule(ME, "nobody")
        e = self.redacted("$soft", current=False)
        self.assertEqual(reason(run(r.check_event_for_spam(e))), "invite-rules")
        self.api.members[(self.ROOM, ME)] = types.SimpleNamespace(event_id="$my-join", content={"membership": "join"})
        self.arrive(r, e)
        self.assertEqual(self.rm.calls, [])

    def test_an_invite_answered_before_the_decline_runs_is_left_alone(self):
        r = self.make()
        self.rule(ME, "nobody")
        e = self.redacted("$red")
        run(r.on_new_event(e, {("m.room.member", ME): e}))
        self.api.members[(self.ROOM, ME)] = types.SimpleNamespace(event_id="$join", content={"membership": "join"})
        self.api.drain()
        self.assertEqual(self.rm.calls, [], "a newer membership is never touched")

    def test_local_invites_and_other_events_pass(self):
        r = self.make()
        self.rule(ME, "nobody")
        self.arrive(r, self.redacted("$local", sender=YOU))
        msg = Ev(EVIL, "", self.ROOM, type_="m.room.message", content={"body": "hi"})
        msg.is_state = lambda: False
        run(r.on_new_event(msg, {}))
        self.arrive(r, self.redacted("$remote", sender=EVIL, to="@x:other.example"))
        self.api.drain()
        self.assertEqual(self.rm.calls, [])

    # --- review r4-1/r4-2: the decline re-checks and leaves inside Synapse's membership lock (H1), isn't rate-limited
    # and is retried (M3); a failed outcome lookup never decides again (M2); no unlocked fallback ------------------
    def test_a_join_while_waiting_for_the_lock_is_never_left(self):
        r = self.make()
        self.rule(ME, "nobody")
        e = self.redacted("$red")
        self.rm.member_linearizer.on_enter = lambda: self.api.members.__setitem__(
            (self.ROOM, ME), types.SimpleNamespace(event_id="$join", content={"membership": "join"}))
        self.arrive(r, e)
        self.assertEqual(self.rm.calls, [], "the join the lock let in first stays a join")
        self.assertEqual(self.rm.member_linearizer.entered, [(self.ROOM,)])

    def test_a_failed_decline_is_retried(self):
        r = self.make()
        self.rule(ME, "nobody")
        self.rm.fail = 2
        self.arrive(r, self.redacted("$red"))
        self.assertTrue(self.declined())
        self.assertEqual(self.api.slept, [5, 30])

    def test_a_decline_that_keeps_failing_gives_up(self):
        r = self.make()
        self.rule(ME, "nobody")
        self.rm.fail = 99
        self.arrive(r, self.redacted("$red"))
        self.assertEqual(self.rm.calls, [])
        self.assertEqual(self.api.slept, list(tinhat_network.DECLINE_RETRY_S))

    def test_without_the_lock_nothing_is_declined(self):
        """A Synapse without the internals: never the unlocked leave (it could race a join)."""
        r = self.make()
        self.rule(ME, "nobody")
        self.api._hs = types.SimpleNamespace(get_room_member_handler=lambda: types.SimpleNamespace())
        self.arrive(r, self.redacted("$red"))
        self.assertEqual(self.rm.calls + self.api.memberships, [])

    def test_a_failed_outcome_lookup_never_decides_again(self):
        r = self.make()
        self.rule(ME, "anyone")
        e = self.redacted("$fine", sender=FRIEND, room="!p:friend.example")
        self.assertIsNone(reason(run(r.check_event_for_spam(e))))  # accepted on arrival
        self.rule(ME, "nobody")

        def broken(_eid):
            raise tinhat_network.sqlite3.OperationalError("disk I/O error")
        r.db.outcome = broken
        self.arrive(r, e)
        self.assertEqual(self.rm.calls, [], "the accepted invite stays")


class HostOf(unittest.TestCase):
    def test_host_of(self):
        h = tinhat_network.host_of
        self.assertEqual(h("Evil.Example:8448."), "evil.example")
        self.assertEqual(h("evil.example."), "evil.example")
        self.assertEqual(h("[2001:db8::1]:8448"), "[2001:db8::1]")
        self.assertEqual(tinhat_network.server_of("@a:EVIL.example:1"), "evil.example")
        self.assertEqual(tinhat_network.server_of("nope"), "")


if __name__ == "__main__":
    unittest.main()

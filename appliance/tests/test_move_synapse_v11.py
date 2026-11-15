"""Move to your own domain with room version 11 rooms, and a server holding v10 AND v11 rooms (new rooms are v11 since
0.3.17; rooms made before stay v10). What differs in v11 for a move: the create event names no creator (its sender is
the creator), a redaction names its event in content.redacts only, and the redaction algorithm keeps more, so v10 and v11
events hash and sign differently: each event must be rebuilt by its own room's version.

The first class runs anywhere (move_synapse's rules import nothing of Synapse). The second rebuilds real signed v10 + v11
rooms with Synapse's own hashing, signing and auth rules; it runs where Synapse is importable (in the server's Synapse
image, or a Python with Synapse installed) and is skipped elsewhere:
    python3 -m unittest discover -s appliance/tests
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/move_synapse.py"
spec = importlib.util.spec_from_file_location("move_synapse_v11", PATH)
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

OLD, NEW = "crew.tinhat.me", "chat.example.com"
rename = ms.renamer(OLD, NEW)
OWNER, FRIEND = f"@owner:{OLD}", f"@friend:{OLD}"
E1, E2, N1, N2 = "$" + "a" * 43, "$" + "b" * 43, "$" + "x" * 43, "$" + "y" * 43


def have_synapse() -> bool:
    """Synapse itself (its room versions), not just any module called synapse (the manager's own folder is one). Only
    "not there" counts as absent: an installed Synapse that fails to import is an error, never a skip."""
    before = set(sys.modules)
    try:
        from synapse.api.room_versions import KNOWN_ROOM_VERSIONS  # noqa: F401
        return True
    except ModuleNotFoundError as e:
        if e.name not in ("synapse", "synapse.api"):  # absent, or the manager's folder; anything else is a broken install
            raise
        for k in set(sys.modules) - before:  # leave no half-imported "synapse" behind for other tests
            del sys.modules[k]
        return False


HAVE_SYNAPSE = have_synapse()
# Set where the Synapse checks must run (the lab's run in the server's Synapse image): a skip is then a failure.
REQUIRE_SYNAPSE = os.environ.get("TINHAT_REQUIRE_SYNAPSE") == "1"


class Rules(unittest.TestCase):
    def test_synapse_present_where_required(self):
        if REQUIRE_SYNAPSE:
            self.assertTrue(HAVE_SYNAPSE, "TINHAT_REQUIRE_SYNAPSE=1 but Synapse can't be imported")

    def test_a_mixed_server_may_move_and_v12_still_may_not(self):
        self.assertEqual(ms.refused_versions({"10", "11"}), set())
        self.assertEqual(ms.refused_versions(["11"]), set())
        self.assertEqual(ms.refused_versions({"10", "11", "12"}), {"12"})
        self.assertEqual(ms.refused_versions({"9", "10"}), {"9"})
        self.assertEqual(ms.refused_versions({"org.matrix.hydra.11", "11"}), {"org.matrix.hydra.11"})

    def test_v11_create_names_no_creator_and_gets_none(self):
        d, _ = ms.rewrite_event({"type": "m.room.create", "sender": OWNER, "state_key": "",
                                 "content": {"room_version": "11", "m.federate": False}}, rename, {}, OLD, NEW)
        self.assertEqual(d["sender"], f"@owner:{NEW}")
        self.assertEqual(d["content"], {"room_version": "11", "m.federate": False})
        v10, _ = ms.rewrite_event({"type": "m.room.create", "sender": OWNER, "state_key": "",
                                   "content": {"room_version": "10", "creator": OWNER}}, rename, {}, OLD, NEW)
        self.assertEqual(v10["content"]["creator"], f"@owner:{NEW}")

    def test_an_upgrade_pair_v10_to_v11(self):
        tomb, _ = ms.rewrite_event({"type": "m.room.tombstone", "sender": OWNER, "state_key": "",
                                    "content": {"body": "moved", "replacement_room": f"!new:{OLD}"}}, rename, {}, OLD, NEW)
        self.assertEqual(tomb["content"]["replacement_room"], f"!new:{OLD}")  # room ids stay
        create, _ = ms.rewrite_event({"type": "m.room.create", "sender": OWNER, "state_key": "",
                                      "content": {"room_version": "11", "predecessor": {"room_id": f"!old:{OLD}", "event_id": E1}}},
                                     rename, {E1: N1}, OLD, NEW)
        self.assertEqual(create["content"]["predecessor"], {"room_id": f"!old:{OLD}", "event_id": N1})
        # the new room's create event (stored first) after the old room's tombstone it names
        self.assertEqual(ms.graph_order([E2, E1], {E2: 1, E1: 2}, {E2: {E1}}), ([E1, E2], 0))

    def test_v11_redaction_in_content_only(self):
        d, _ = ms.rewrite_event({"type": "m.room.redaction", "sender": OWNER, "content": {"redacts": E1, "reason": "x"}},
                                rename, {E1: N1}, OLD, NEW)
        self.assertEqual(d["content"]["redacts"], N1)
        self.assertNotIn("redacts", d)  # nothing added at the top level


@unittest.skipUnless(HAVE_SYNAPSE, "needs Synapse (the server's Synapse image, or a Python with Synapse installed)")
class RealRooms(unittest.TestCase):
    """Two rooms of one server, signed by Synapse under the old name: A on v10, upgraded to B on v11 (B's create names
    A's tombstone). Rebuilt in main()'s order with main()'s per-event step (rebuild_event), each event by its own
    room's version; then Synapse itself checks every rebuilt event: id, content hash, signature, auth rules."""

    @classmethod
    def setUpClass(cls):
        from signedjson.key import generate_signing_key, get_verify_key
        from synapse import event_auth
        from synapse.api.room_versions import KNOWN_ROOM_VERSIONS
        from synapse.crypto.event_signing import add_hashes_and_signatures, check_event_content_hash
        from synapse.events import make_event_from_dict
        try:
            from synapse.events.utils import prune_event_dict as redact
        except ImportError:  # later Synapse: in Rust
            from synapse.synapse_rust.events import redact_event_dict as redact
        cls.K, cls.auth = KNOWN_ROOM_VERSIONS, event_auth
        # plain functions on the class, never bound to a test instance
        cls.sign, cls.make = staticmethod(add_hashes_and_signatures), staticmethod(make_event_from_dict)
        cls.redact, cls.content_hash_ok = staticmethod(redact), staticmethod(check_event_content_hash)
        cls.old_key, cls.new_key = generate_signing_key("a"), generate_signing_key("b")
        cls.new_verify = get_verify_key(cls.new_key)
        cls.stored, cls.version_of, cls.stream = {}, {}, {}
        A, B = f"!aaaaaaaaaaaa:{OLD}", f"!bbbbbbbbbbbb:{OLD}"
        cls.A, cls.B = A, B
        a = cls.Chain(cls, A, "10")
        a.add("m.room.create", OWNER, {"room_version": "10", "creator": OWNER}, "")
        a.add("m.room.member", OWNER, {"membership": "join"}, OWNER)
        a.add("m.room.power_levels", OWNER, {"users": {OWNER: 100}, "state_default": 50, "events_default": 0}, "")
        a.add("m.room.join_rules", OWNER, {"join_rule": "public"}, "")
        a.add("m.room.member", FRIEND, {"membership": "join"}, FRIEND)
        a.add("m.room.message", FRIEND, {"msgtype": "m.text", "body": f"hi {OWNER}"})
        cls.tomb = a.add("m.room.tombstone", OWNER, {"body": "upgraded", "replacement_room": B}, "")
        b = cls.Chain(cls, B, "11")
        cls.create_b = b.add("m.room.create", OWNER, {"room_version": "11", "predecessor": {"room_id": A, "event_id": cls.tomb}}, "")
        b.add("m.room.member", OWNER, {"membership": "join"}, OWNER)
        b.add("m.room.power_levels", OWNER, {"users": {OWNER: 100, FRIEND: 50}, "state_default": 50, "events_default": 0,
                                             "redact": 50, "invite": 0}, "")
        b.add("m.room.join_rules", OWNER, {"join_rule": "public"}, "")
        b.add("m.room.member", FRIEND, {"membership": "join"}, FRIEND)
        cls.msg = b.add("m.room.message", FRIEND, {"msgtype": "m.text", "body": "to be redacted"})
        cls.msg2 = b.add("m.room.message", OWNER, {"msgtype": "m.text", "body": "stays"})
        cls.reaction = b.add("m.reaction", FRIEND, {"m.relates_to": {"rel_type": "m.annotation", "event_id": cls.msg2, "key": "+"}})
        cls.redaction = b.add("m.room.redaction", OWNER, {"redacts": cls.msg, "reason": "test"})
        cls.games = b.add("dev.tinhat.games", OWNER, {"games": [{"name": "A game", "by": FRIEND}]}, "")
        cls.call = b.add("org.matrix.msc3401.call.member", FRIEND, {}, f"_{FRIEND}_DEVICE_m.call")
        # the server's note about the redacted message names the later redaction (unsigned: not hashed)
        d = json.loads(cls.stored[cls.msg])
        d["unsigned"] = {"redacted_because": cls.redaction}
        cls.stored[cls.msg] = json.dumps(d)
        cls.rebuild()

    class Chain:
        def __init__(self, t, room_id, version):
            self.t, self.room_id, self.version, self.state, self.last, self.depth = t, room_id, version, {}, [], 0

        def add(self, typ, sender, content, state_key=None):
            t, rv = self.t, self.t.K[self.version]
            auth = [self.state[k] for k in (("m.room.create", ""), ("m.room.power_levels", ""), ("m.room.member", sender))
                    if k in self.state and not (typ == "m.room.member" and k == ("m.room.member", sender))]
            if typ == "m.room.member" and ("m.room.join_rules", "") in self.state:
                auth.append(self.state[("m.room.join_rules", "")])
            self.depth += 1
            d = {"room_id": self.room_id, "type": typ, "sender": sender, "content": content, "depth": self.depth,
                 "prev_events": list(self.last), "auth_events": auth, "origin_server_ts": 1_700_000_000_000 + len(t.stored)}
            if state_key is not None:
                d["state_key"] = state_key
            t.sign(rv, d, OLD, t.old_key)
            eid = t.make(dict(d), rv).event_id
            t.stored[eid], t.version_of[eid], t.stream[eid] = json.dumps(d), self.version, len(t.stream) + 1
            if state_key is not None:
                self.state[(typ, state_key)] = eid
            self.last = [eid]
            return eid

    @classmethod
    def rebuild(cls):
        refs = {e: n for e in cls.stored if (n := ms.named_ids(cls.stored[e], cls.version_of, e))}
        cls.order, stuck = ms.graph_order(cls.version_of.keys(), cls.stream, refs)
        assert stuck == 0
        cls.new_id, cls.out, cls.late = {}, {}, set()
        for eid in cls.order:
            d, late = ms.rebuild_event(cls.stored[eid], cls.K[cls.version_of[eid]], eid, rename, cls.new_id, OLD, NEW,
                                       cls.new_key, cls.sign, cls.make, cls.version_of)
            cls.out[eid] = d
            if late:
                cls.late.add(eid)

    def ev(self, eid):
        d = dict(self.out[eid])
        d.pop("unsigned", None)
        return self.make(d, self.K[self.version_of[eid]])

    def test_both_versions_are_there(self):
        self.assertEqual(set(self.version_of.values()), {"10", "11"})
        self.assertEqual(ms.refused_versions(set(self.version_of.values())), set())

    def test_every_id_is_its_hash_by_its_own_rooms_version(self):
        for eid, d in self.out.items():
            rv = self.K[self.version_of[eid]]
            self.assertTrue(ms.id_matches(json.dumps(d), rv, self.new_id[eid], self.make), self.version_of[eid])
            self.assertNotEqual(self.new_id[eid], eid)
            self.assertTrue(self.content_hash_ok(self.ev(eid), hashlib.sha256))

    def test_every_event_is_signed_by_the_new_name(self):
        from signedjson.sign import verify_signed_json
        for eid, d in self.out.items():
            body = dict(d)
            body.pop("unsigned", None)
            pruned = self.redact(self.K[self.version_of[eid]], body)
            verify_signed_json(pruned, NEW, self.new_verify)  # raises if not
            self.assertEqual(list(d["signatures"]), [NEW])

    def test_synapse_auth_rules_pass_for_every_rebuilt_event(self):
        import asyncio

        class NoStore:  # every auth event is in the batch; asking the store for one is a failure
            async def get_events(self, ids, **kw):
                if ids:
                    raise AssertionError(f"auth events not in the rebuilt batch: {ids}")
                return {}

        by_new = {self.new_id[e]: e for e in self.out}
        batch = {self.new_id[e]: self.ev(e) for e in self.out}
        for eid in self.order:
            ev = self.ev(eid)
            self.auth.validate_event_for_room_version(ev)
            self.assertEqual(len(set(ev.auth_event_ids())), len(ev.auth_event_ids()), "no auth event twice")
            if ev.type != "m.room.create":  # same room, expected types, no rejected ones
                asyncio.run(self.auth.check_state_independent_auth_rules(NoStore(), ev, batched_auth_events=batch))
            if ev.type == "m.room.create":
                # The known Move limit, the same in v10 and v11 (docs/MOVE.md): the room keeps !id:OLD while its creator
                # is now on NEW, which create-event auth refuses (other servers would: such a room can't federate).
                with self.assertRaisesRegex(Exception, "room_id domain does not match"):
                    self.auth._check_create(ev)
                # Every other create rule passes: a v11 create without creator (its sender is the creator), v10's with.
                d = dict(self.out[eid])
                d.pop("unsigned", None)
                d["room_id"] = d["room_id"].split(":")[0] + ":" + NEW
                self.auth._check_create(self.make(d, self.K[self.version_of[eid]]))
                continue
            self.auth.check_state_dependent_auth_rules(ev, [self.ev(by_new[a]) for a in ev.auth_event_ids()])

    def test_nobody_left_on_the_old_name_and_rooms_kept(self):
        pat = ms.person_pattern(OLD)
        for eid, d in self.out.items():
            body = dict(d)
            body.pop("unsigned", None)
            self.assertIsNone(pat.search(json.dumps(body)), d["type"])
            self.assertIn(d["room_id"], (self.A, self.B))

    def test_references_follow_their_new_ids(self):
        news = set(self.new_id.values())
        for d in self.out.values():
            self.assertTrue(set(d["prev_events"]) | set(d["auth_events"]) <= news)
        create = self.out[self.create_b]
        self.assertNotIn("creator", create["content"])
        self.assertEqual(create["content"]["predecessor"], {"room_id": self.A, "event_id": self.new_id[self.tomb]})
        self.assertEqual(self.out[self.tomb]["content"]["replacement_room"], self.B)
        red = self.out[self.redaction]
        self.assertEqual(red["content"]["redacts"], self.new_id[self.msg])
        self.assertNotIn("redacts", red)
        self.assertEqual(self.out[self.reaction]["content"]["m.relates_to"]["event_id"], self.new_id[self.msg2])
        self.assertEqual(self.out[self.call]["state_key"], f"_@friend:{NEW}_DEVICE_m.call")
        self.assertEqual(self.out[self.games]["content"]["games"][0]["by"], f"@friend:{NEW}")

    def test_the_two_versions_really_differ_where_it_matters(self):
        # why each event needs its own room's rules: v11 keeps a redaction's target and a create's whole content
        red, create = dict(self.out[self.redaction]), dict(self.out[self.create_b])
        self.assertEqual(self.redact(self.K["11"], red)["content"].get("redacts"), self.new_id[self.msg])
        self.assertNotIn("redacts", self.redact(self.K["10"], red)["content"])
        self.assertIn("predecessor", self.redact(self.K["11"], create)["content"])
        self.assertNotIn("predecessor", self.redact(self.K["10"], create)["content"])

    def test_unsigned_naming_a_later_event_is_left_for_the_end(self):
        self.assertEqual(self.late, {self.msg})
        self.assertEqual(self.out[self.msg]["unsigned"]["redacted_because"], self.redaction)  # not known yet
        d = ms.fix_late_unsigned(json.loads(json.dumps(self.out[self.msg])), self.new_id)
        self.assertEqual(d["unsigned"]["redacted_because"], self.new_id[self.redaction])
        self.assertEqual(d["unsigned"][ms.MOVED]["former_ids"], [self.msg])  # its own old id, kept old
        self.assertTrue(ms.id_matches(json.dumps(d), self.K["11"], self.new_id[self.msg], self.make))


if __name__ == "__main__":
    unittest.main()

"""Move to your own domain: the database rebuild's rules (move_synapse.py), without Synapse. Every person and alias on
the old name gets the new one, rooms and longer names never do; old event ids map to new ones; events come in
dependency order; an event's references to earlier events follow their new ids, outside the encryption only.

Runs anywhere (the rules import nothing of Synapse; main() does).
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/move_synapse.py"
spec = importlib.util.spec_from_file_location("move_synapse", PATH)
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

OLD, NEW = "crew.tinhat.me", "chat.example.com"
rename = ms.renamer(OLD, NEW)
E1, E2, E3 = "$" + "a" * 43, "$" + "b" * 43, "$" + "c" * 43
N1, N2 = "$" + "x" * 43, "$" + "y" * 43


class People(unittest.TestCase):
    def test_people_and_aliases_move(self):
        self.assertEqual(rename("@alex:crew.tinhat.me"), "@alex:chat.example.com")
        self.assertEqual(rename('{"sender":"@sam.k_1=x/y+z-q:crew.tinhat.me"}'), '{"sender":"@sam.k_1=x/y+z-q:chat.example.com"}')
        self.assertEqual(rename("#general:crew.tinhat.me"), "#general:chat.example.com")
        # a LiveKit identity: the person moves, the device part stays
        self.assertEqual(rename("@alex:crew.tinhat.me:ABCDEF"), "@alex:chat.example.com:ABCDEF")
        self.assertEqual(rename('{"users":{"@a:crew.tinhat.me":100,"@b:crew.tinhat.me":50}}'),
                         '{"users":{"@a:chat.example.com":100,"@b:chat.example.com":50}}')

    def test_rooms_media_and_other_names_stay(self):
        for s in ("!abcdef:crew.tinhat.me", "mxc://crew.tinhat.me/AbCd", "https://crew.tinhat.me/livekit/jwt",
                  "@alex:crew.tinhat.me.evil.example", "@alex:other.tinhat.me", "crew.tinhat.me",
                  "Welcome to crew.tinhat.me!", "bob@alex:crew.tinhat.me",
                  # a link to a room: its fragment is no alias, the room id stays
                  "https://matrix.to/#/!abc:crew.tinhat.me/$ev?via=crew.tinhat.me",
                  "https://crew.tinhat.me/#/room/!abc:crew.tinhat.me"):
            self.assertEqual(rename(s), s, s)

    def test_links_to_people_and_aliases_move_and_state_keys(self):
        self.assertEqual(rename("https://matrix.to/#/@alex:crew.tinhat.me"), "https://matrix.to/#/@alex:chat.example.com")
        self.assertEqual(rename("https://matrix.to/#/#general:crew.tinhat.me"), "https://matrix.to/#/#general:chat.example.com")
        # a call membership's state key names its person
        self.assertEqual(rename("_@alex:crew.tinhat.me_DEVICE_m.call"), "_@alex:chat.example.com_DEVICE_m.call")
        self.assertEqual(rename("#café:crew.tinhat.me"), "#café:chat.example.com")  # a non-ASCII alias, as stored

    def test_non_ascii_aliases_inside_events(self):
        d, _ = ms.rewrite_event({"type": "m.room.canonical_alias", "content": {"alias": "#café:crew.tinhat.me"}},
                                rename, {}, OLD, NEW)
        self.assertEqual(d["content"]["alias"], "#café:chat.example.com")


class EventIds(unittest.TestCase):
    def test_old_ids_map_and_others_stay(self):
        new_id = {E1: N1, E2: N2}
        self.assertEqual(ms.map_ids(f'["{E1}","{E2}","{E3}"]', new_id), f'["{N1}","{N2}","{E3}"]')
        self.assertEqual(ms.map_ids("$2b$12$abcdefghijklmnopqrstuv", new_id), "$2b$12$abcdefghijklmnopqrstuv")

    def test_graph_order(self):
        stream = {E1: 1, E2: 2, E3: 3}
        self.assertEqual(ms.graph_order([E3, E1, E2], stream, {E2: {E1}, E3: {E2, "$" + "z" * 43}}), ([E1, E2, E3], 0))
        # a room upgrade: the new room's create event (stored first) names the old room's tombstone (stored after it)
        self.assertEqual(ms.graph_order([E1, E2], {E1: 1, E2: 2}, {E1: {E2}}), ([E2, E1], 0))
        # nothing named: the order they were stored in
        self.assertEqual(ms.graph_order([E3, E2, E1], stream, {})[0], [E1, E2, E3])
        # a loop (a damaged database): reported, never silently ordered
        self.assertEqual(ms.graph_order([E1, E2, E3], stream, {E1: {E2}, E2: {E1}})[1], 2)

    def test_what_an_event_names(self):
        js = json.dumps({"prev_events": [E1], "content": {"m.relates_to": {"event_id": E2}},
                         "unsigned": {"replaces_state": E3}})
        self.assertEqual(ms.named_ids(js, {E1, E2, E3}, E1), {E2})  # not itself, not what unsigned says

    def test_each_row_once(self):
        fixes = ms.changed_columns(["@a:crew.tinhat.me", None, "plain", f"[\"{E1}\"]"], rename, {E1: N1})
        self.assertEqual(fixes, [(0, "@a:chat.example.com"), (3, f"[\"{N1}\"]")])

    def test_references_follow_their_new_ids(self):
        ev = {"type": "m.room.encrypted", "sender": "@alex:crew.tinhat.me", "room_id": "!r:crew.tinhat.me",
              "prev_events": [E1], "auth_events": [E1, E2], "depth": 3, "origin_server_ts": 1,
              "hashes": {"sha256": "x"}, "signatures": {OLD: {"ed25519:a": "y"}}, "unsigned": {"age_ts": 1},
              "content": {"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "AAAA",
                          "m.relates_to": {"rel_type": "m.thread", "event_id": E2, "m.in_reply_to": {"event_id": E1}}}}
        d, unsigned = ms.rewrite_event(json.loads(json.dumps(ev)), rename, {E1: N1, E2: N2}, OLD, NEW)
        self.assertEqual(d["sender"], "@alex:chat.example.com")
        self.assertEqual(d["room_id"], "!r:crew.tinhat.me")  # rooms keep their ids
        self.assertEqual((d["prev_events"], d["auth_events"]), ([N1], [N1, N2]))
        self.assertEqual(d["content"]["m.relates_to"]["event_id"], N2)
        self.assertEqual(d["content"]["m.relates_to"]["m.in_reply_to"]["event_id"], N1)
        self.assertEqual(d["content"]["ciphertext"], "AAAA")  # the encryption is never touched
        self.assertNotIn("hashes", d)
        self.assertNotIn("signatures", d)
        self.assertEqual(unsigned, {"age_ts": 1})

    def test_ids_anywhere_in_the_clear_part(self):
        pins, _ = ms.rewrite_event({"type": "m.room.pinned_events", "content": {"pinned": [E1, E3]}}, rename, {E1: N1}, OLD, NEW)
        self.assertEqual(pins["content"]["pinned"], [N1, E3])  # E3: not an event of this server (or not yet known)
        tinhat, _ = ms.rewrite_event({"type": "dev.tinhat.game_reel", "content": {"spins": [{"msg": E2}]}}, rename, {E2: N2}, OLD, NEW)
        self.assertEqual(tinhat["content"]["spins"][0]["msg"], N2)

    def test_the_note_in_unsigned(self):
        enc = {"type": "m.room.encrypted", "content": {"ciphertext": "AAAA", "m.relates_to": {"rel_type": "m.annotation", "event_id": N1, "key": "👍"}}}
        note = ms.moved_note(E2, enc, None)
        self.assertEqual(note, {"former_ids": [E2], "relates_to": {"rel_type": "m.annotation", "event_id": N1, "key": "👍"}})
        # a second move keeps the ids of the first one too; an unencrypted event's own content already is current
        plain = {"type": "m.room.message", "content": {"body": "hi", "m.relates_to": {"m.in_reply_to": {"event_id": N1}}}}
        self.assertEqual(ms.moved_note(N2, plain, {"former_ids": [E2]}), {"former_ids": [E2, N2]})
        self.assertEqual(ms.moved_note(N2, plain, "junk"), {"former_ids": [N2]})

    def test_redactions(self):
        top, _ = ms.rewrite_event({"type": "m.room.redaction", "redacts": E1, "content": {}}, rename, {E1: N1}, OLD, NEW)
        self.assertEqual(top["redacts"], N1)
        inner, _ = ms.rewrite_event({"type": "m.room.redaction", "content": {"redacts": E1}}, rename, {E1: N1}, OLD, NEW)
        self.assertEqual(inner["content"]["redacts"], N1)


if __name__ == "__main__":
    unittest.main()

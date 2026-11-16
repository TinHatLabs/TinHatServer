"""Tin Hat: a power levels change on this server, failing-first inside Synapse's own harness (SQLite, test accounts).

With a check_event_allowed module registered (every Tin Hat Server has two) Synapse freezes every event it creates
before the module sees it, and after persisting it puts that same frozen event in its event cache. Once a room's
m.room.power_levels has a `notifications` block (Tin Hat's roles editor writes `notifications.room`), the push rule
evaluator of every later event in that room hands the cached immutabledict to the Rust PushRuleEvaluator, which takes
only a dict: TypeError, 500 for every message, state event and call membership, until a restart reloads the event
from the database as a plain dict. Room versions before 10 fail the same way (their extra in-place fix-up of string
levels would also fail on a frozen dict). The fix (0010, ours) copies the levels into a plain dict first."""
import os
from unittest.mock import patch

import synapse

from synapse.rest import admin
from synapse.rest.client import login, room

from tests import unittest

CALL_MEMBER = "org.matrix.msc3401.call.member"


class _Base(unittest.HomeserverTestCase):
    servlets = [admin.register_servlets, login.register_servlets, room.register_servlets]
    module = False

    def default_config(self):  # type: ignore[no-untyped-def]
        # Synapse's test config keeps ONE event in its event cache, so the frozen event is evicted at once and read
        # back from the database as a plain dict (what a restart does). A real server keeps thousands: so do we.
        config = super().default_config()
        config["event_cache_size"] = "10K"
        return config

    def prepare(self, reactor, clock, hs) -> None:  # type: ignore[no-untyped-def]
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        if self.module:
            async def allow(event, state):  # type: ignore[no-untyped-def]
                return True, None

            hs.get_module_api().register_third_party_rules_callbacks(check_event_allowed=allow)
        self.store = hs.get_datastores().main
        self.owner = self.register_user("pl-owner", "not-a-secret")
        self.tok = self.login("pl-owner", "not-a-secret")
        self.member = self.register_user("pl-member", "not-a-secret")
        self.mtok = self.login("pl-member", "not-a-secret")
        self.txn = 0

    def room(self, version: str) -> str:
        r = self.helper.create_room_as(self.owner, room_version=version, tok=self.tok)
        self.helper.join(r, self.member, tok=self.mtok)
        return r

    def change_pl(self, r: str, notifications: object = None) -> str:
        """What Tin Hat 12.1.16 did in the field: the current levels plus one event type (and the roles editor's
        `notifications` block)."""
        pl = dict(self.helper.get_state(r, "m.room.power_levels", tok=self.tok))
        pl["events"] = {**pl.get("events", {}), "dev.tinhat.memories": 0}
        if notifications is not None:
            pl["notifications"] = notifications
        channel = self.put_channel(f"/_matrix/client/v3/rooms/{r}/state/m.room.power_levels/", pl)
        self.assertEqual(channel.code, 200, channel.json_body)
        return channel.json_body["event_id"]

    def put(self, path: str, body: dict) -> int:
        return self.put_channel(path, body).code

    def put_channel(self, path: str, body: dict):  # type: ignore[no-untyped-def]
        self.txn += 1
        return self.make_request("PUT", path.replace("{txn}", f"t{self.txn}"), body, access_token=self.tok)

    def message(self, r: str, body: dict | None = None) -> int:
        return self.put(f"/_matrix/client/v3/rooms/{r}/send/m.room.message/{{txn}}",
                        body or {"msgtype": "m.text", "body": "hello"})

    def state(self, r: str) -> int:
        return self.put(f"/_matrix/client/v3/rooms/{r}/state/dev.tinhat.chat.background/", {"kind": "none"})

    def call_member(self, r: str) -> int:
        return self.put(f"/_matrix/client/v3/rooms/{r}/state/{CALL_MEMBER}/_{self.owner}_DEVICE",
                        {"application": "m.call", "call_id": "", "scope": "m.room", "device_id": "DEVICE",
                         "focus_active": {"type": "livekit", "focus_selection": "oldest_membership"},
                         "foci_preferred": []})

    def cached_notifications(self, event_id: str) -> object:
        entry = self.store._get_event_cache.get_local((event_id,))
        self.assertIsNotNone(entry, "the power levels event is in the event cache")
        return entry.event.content["notifications"]

    def legacy_levels(self, r: str, room_level: object) -> str:
        """Room version 9: an old-style `notifications.room` (a string, a null) as seen in the wild, owner at 60. Like
        upstream's own test (tests/push/test_bulk_push_rule_evaluator.py), validation is bypassed to create it."""
        with (
            patch("synapse.events.validator.validate_canonicaljson"),
            patch("synapse.events.validator.jsonschema.validate"),
            patch("synapse.handlers.event_auth.check_state_dependent_auth_rules"),
        ):
            return self.helper.send_state(r, "m.room.power_levels",
                                          {"users": {self.owner: 60}, "notifications": {"room": room_level}},
                                          tok=self.tok)["event_id"]

    def owner_room_mention_highlights_member(self, r: str) -> bool:
        channel = self.put_channel(f"/_matrix/client/v3/rooms/{r}/send/m.room.message/{{txn}}",
                                   {"msgtype": "m.text", "body": "@room hi", "m.mentions": {"room": True}})
        self.assertEqual(channel.code, 200, channel.json_body)
        rows = self.get_success(self.store.db_pool.simple_select_list(
            "event_push_actions", {"event_id": channel.json_body["event_id"], "user_id": self.member}, ("highlight",)))
        return bool(rows and rows[0][0])

    def highlight_for_owner(self, r: str) -> bool:
        """An @room from the member (level 0): is it a highlight for the owner? Read from what Synapse stored."""
        self.txn += 1
        channel = self.make_request("PUT", f"/_matrix/client/v3/rooms/{r}/send/m.room.message/m{self.txn}",
                                    {"msgtype": "m.text", "body": "@room hi", "m.mentions": {"room": True}},
                                    access_token=self.mtok)
        self.assertEqual(channel.code, 200, channel.json_body)
        rows = self.get_success(self.store.db_pool.simple_select_list(
            "event_push_actions", {"event_id": channel.json_body["event_id"], "user_id": self.owner}, ("highlight",)))
        self.assertEqual(len(rows), 1, rows)
        return bool(rows[0][0])


class FrozenPowerLevels(_Base):
    """What a Tin Hat Server does: a module is registered, so the new power levels event is frozen and cached frozen."""
    module = True

    def test_message_after_a_change_v10(self) -> None:
        r = self.room("10")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.message(r), 200)

    def test_message_after_a_change_v11(self) -> None:
        r = self.room("11")
        pl = self.change_pl(r, {"room": 50})
        # the cause, attributed: the cached event's levels are frozen (patched or not: 0010 doesn't change that)
        self.assertNotIsInstance(self.cached_notifications(pl), dict)
        self.assertEqual(self.message(r), 200)

    def test_state_event_after_a_change_v10(self) -> None:
        r = self.room("10")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.state(r), 200)

    def test_state_event_after_a_change_v11(self) -> None:
        r = self.room("11")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.state(r), 200)

    def test_call_member_after_a_change_v10(self) -> None:
        r = self.room("10")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.call_member(r), 200)

    def test_call_member_after_a_change_v11(self) -> None:
        r = self.room("11")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.call_member(r), 200)

    def test_a_second_change_and_more_events(self) -> None:
        r = self.room("11")
        self.change_pl(r, {"room": 50})
        self.change_pl(r, {"room": 60})
        for _ in range(3):
            self.assertEqual(self.message(r), 200)

    def test_message_after_a_change_v9(self) -> None:
        """Before room version 10: the same evaluator call (old rooms only add an in-place fix-up of string levels)."""
        r = self.room("9")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.message(r), 200)

    def test_the_room_level_still_decides_room_mentions(self) -> None:
        """The levels still mean what they say: room 0 lets the member (level 0) @room the owner; room 50 doesn't."""
        r = self.room("11")
        self.change_pl(r, {"room": 0})
        self.assertTrue(self.highlight_for_owner(r))
        self.change_pl(r, {"room": 50})
        self.assertFalse(self.highlight_for_owner(r))

    def test_a_change_without_notifications_never_failed(self) -> None:
        """Why some power levels changes never broke a room: without a `notifications` block Synapse uses its own {}."""
        r = self.room("11")
        self.change_pl(r)
        self.assertEqual(self.message(r), 200)
        self.assertEqual(self.state(r), 200)

    def test_reloaded_from_the_database_works(self) -> None:
        """What a restart did: the event read back from the database is a plain dict."""
        r = self.room("11")
        pl = self.change_pl(r, {"room": 50})
        self.store._invalidate_local_get_event_cache(pl)
        self.assertEqual(self.message(r), 200)
        self.assertIsInstance(self.cached_notifications(pl), dict)

    def test_old_room_string_level_above_the_sender(self) -> None:
        """v9, frozen `"room": "100"`: converted in place before (a frozen dict can't be written: 500); now on a copy."""
        r = self.room("9")
        pl = self.legacy_levels(r, "100")
        self.assertFalse(self.owner_room_mention_highlights_member(r))
        self.assertEqual(self.cached_notifications(pl)["room"], "100", "the cached event itself is never rewritten")

    def test_old_room_string_level_below_the_sender(self) -> None:
        r = self.room("9")
        self.legacy_levels(r, "0")
        self.assertTrue(self.owner_room_mention_highlights_member(r))

    def test_old_room_null_level_is_dropped(self) -> None:
        """v9, frozen `"room": null`: deleted from the levels before (on a frozen dict: 500); the default 50 applies."""
        r = self.room("9")
        pl = self.legacy_levels(r, None)
        self.assertTrue(self.owner_room_mention_highlights_member(r))
        self.assertIsNone(self.cached_notifications(pl)["room"])


class WithoutAModule(_Base):
    """The control: no module, nothing is frozen, stock works (the bug needs the freeze)."""

    def test_old_room_string_level_above_the_sender(self) -> None:
        r = self.room("9")
        self.legacy_levels(r, "100")
        self.assertFalse(self.owner_room_mention_highlights_member(r))

    def test_message_after_a_change_v11(self) -> None:
        r = self.room("11")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.message(r), 200)

    def test_message_after_a_change_v9(self) -> None:
        r = self.room("9")
        self.change_pl(r, {"room": 50})
        self.assertEqual(self.message(r), 200)

    def test_the_room_level_still_decides_room_mentions(self) -> None:
        r = self.room("11")
        self.change_pl(r, {"room": 0})
        self.assertTrue(self.highlight_for_owner(r))
        self.change_pl(r, {"room": 50})
        self.assertFalse(self.highlight_for_owner(r))

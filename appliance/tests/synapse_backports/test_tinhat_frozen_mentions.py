"""Tin Hat: frozen m.mentions, failing-first inside Synapse's own harness (one homeserver, SQLite, test accounts).

With a check_event_allowed module registered (every Tin Hat Server has two) Synapse freezes the event before it
validates it. Stock 1.145 with pydantic 2.12 then refuses every event with m.mentions in the clear with 400 M_BAD_JSON
("Input should be a valid dictionary or instance of Mentions"). The fix is upstream's d8b4ffdf2 (1.154.0)."""
import os

import synapse

from synapse.rest import admin
from synapse.rest.client import login, room

from tests import unittest


class _Base(unittest.HomeserverTestCase):
    servlets = [admin.register_servlets, login.register_servlets, room.register_servlets]
    module = False

    def prepare(self, reactor, clock, hs) -> None:  # type: ignore[no-untyped-def]
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        if self.module:
            async def allow(event, state):  # type: ignore[no-untyped-def]
                return True, None

            hs.get_module_api().register_third_party_rules_callbacks(check_event_allowed=allow)
        self.user = self.register_user("mentions-user", "not-a-secret")
        self.tok = self.login("mentions-user", "not-a-secret")
        self.room = self.helper.create_room_as(self.user, tok=self.tok)
        self.txn = 0

    def send(self, mentions: object) -> int:
        self.txn += 1
        channel = self.make_request(
            "PUT", f"/_matrix/client/v3/rooms/{self.room}/send/m.room.message/t{self.txn}",
            {"msgtype": "m.text", "body": "hello", "m.mentions": mentions}, access_token=self.tok)
        return channel.code


class FrozenMentions(_Base):
    """What a Tin Hat Server does: a module is registered, so the event is frozen when it is validated."""
    module = True

    def test_empty_mentions(self) -> None:
        self.assertEqual(self.send({}), 200)

    def test_user_ids(self) -> None:
        self.assertEqual(self.send({"user_ids": ["@someone:test"]}), 200)

    def test_room_mention(self) -> None:
        self.assertEqual(self.send({"room": True}), 200)

    def test_malformed_mentions_stay_refused(self) -> None:
        for bad in ("nope", 1, {"user_ids": 1}, {"room": "yes"}, {"room": 1}):
            self.assertEqual(self.send(bad), 400, bad)

    def test_a_non_string_user_id_stays_refused(self) -> None:
        self.assertEqual(self.send({"user_ids": [1]}), 400)

    def test_user_ids_as_a_string_stays_refused(self) -> None:
        self.assertEqual(self.send({"user_ids": "@someone:test"}), 400)


class WithoutAModule(_Base):
    """The control: no module, the event isn't frozen, stock accepts it (the bug needs the freeze)."""

    def test_empty_mentions(self) -> None:
        self.assertEqual(self.send({}), 200)

    def test_user_ids(self) -> None:
        self.assertEqual(self.send({"user_ids": ["@someone:test"]}), 200)

    def test_malformed_mentions_stay_refused(self) -> None:
        for bad in ("nope", 1, {"user_ids": 1}, {"room": "yes"}, {"room": 1}):
            self.assertEqual(self.send(bad), 400, bad)

    def test_a_non_string_user_id_stays_refused(self) -> None:
        self.assertEqual(self.send({"user_ids": [1]}), 400)

    def test_user_ids_as_a_string_stays_refused(self) -> None:
        self.assertEqual(self.send({"user_ids": "@someone:test"}), 400)

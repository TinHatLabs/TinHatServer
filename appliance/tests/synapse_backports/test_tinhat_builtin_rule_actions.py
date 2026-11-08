"""Tin Hat: a size limit on the actions of BUILT-IN push rules, inside Synapse's own harness.

GHSA-fp53's upstream fix limits custom rules; `set_push_rule_actions` skips the check for server-default rules, so any
local account could store actions of any size on them, once per rule and again in `push_rules_stream` on every change.
Our patch 0006 applies the same limit (backports/). The refusals must fail without it; what a normal client does to a
built-in rule (enable or disable it, change its sound, highlight, silence it) must work with and without it."""
import json
import os

import synapse
import synapse.rest.admin
from synapse.handlers.push_rules import BASE_RULE_IDS
from synapse.rest.client import login, push_rule, room

from tests.unittest import HomeserverTestCase

LIMIT = 1024  # upstream's default push_rules.limits.rule_size
MASTER = "global/override/.m.rule.master"


def action_of_size(n: int) -> list:
    """Actions whose JSON, plus the `[]` conditions a built-in rule's row holds, is n bytes."""
    a = [{"set_tweak": "sound", "value": ""}]
    filler = n - 2 - len(json.dumps(a, separators=(",", ":")))
    a[0]["value"] = "a" * filler
    return a


class BuiltInRuleActions(HomeserverTestCase):
    servlets = [synapse.rest.admin.register_servlets_for_client_rest_resource, room.register_servlets,
                login.register_servlets, push_rule.register_servlets]
    hijack_auth = False

    def prepare(self, reactor, clock, hs) -> None:
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        self.user = self.register_user("guest12h", "pass")  # an ordinary local account, which is what a let-in guest is
        self.tok = self.login("guest12h", "pass")
        self.store = hs.get_datastores().main

    def put_actions(self, rule: str, actions: list):
        return self.make_request("PUT", f"/_matrix/client/v3/pushrules/{rule}/actions", {"actions": actions},
                                 access_token=self.tok)

    def get_actions(self, rule: str) -> list:
        ch = self.make_request("GET", f"/_matrix/client/v3/pushrules/{rule}/actions", access_token=self.tok)
        self.assertEqual(ch.code, 200, ch.result)
        return ch.json_body["actions"]

    def stored(self) -> tuple[list, list]:
        rules = self.get_success(self.store.db_pool.simple_select_list(
            "push_rules", {"user_name": self.user}, ("rule_id", "actions")))
        stream = self.get_success(self.store.db_pool.simple_select_list(
            "push_rules_stream", {"user_id": self.user}, ("stream_id", "op", "rule_id", "actions")))
        return list(rules), list(stream)

    def assert_refused(self, rule: str, actions: list) -> None:
        before, rows = self.get_actions(rule), self.stored()
        ch = self.put_actions(rule, actions)
        self.assertEqual(ch.code, 413, ch.result)
        self.assertEqual(ch.json_body["errcode"], "M_UNKNOWN", ch.result)
        self.assertEqual(self.get_actions(rule), before, "the rule's actions didn't change")
        self.assertEqual(self.stored(), rows, "a refused change stores nothing, in either table")
        after = ["notify", {"set_tweak": "sound", "value": "after-refusal"}]  # no rule has this by default
        self.assertEqual(self.put_actions(rule, after).code, 200, "the next change goes through (nothing left held)")
        self.assertEqual(self.get_actions(rule), after)

    # -- must fail without the guard
    def test_oversized_action_on_a_built_in_rule_is_refused(self) -> None:
        self.assert_refused(MASTER, action_of_size(9001))

    def test_one_byte_over_the_limit_is_refused(self) -> None:
        self.assert_refused("global/underride/.m.rule.message", action_of_size(LIMIT + 1))

    def test_a_refusal_keeps_the_existing_override(self) -> None:
        rule = "global/underride/.m.rule.message"
        mine = ["notify", {"set_tweak": "sound", "value": "ring"}]
        self.assertEqual(self.put_actions(rule, mine).code, 200)
        self.assertEqual(self.get_actions(rule), mine, "the override is really there before the refusal")
        self.assert_refused(rule, action_of_size(9001))

    # -- must pass with and without it: what clients really do
    def test_at_the_limit_is_accepted(self) -> None:
        actions = action_of_size(LIMIT)
        self.assertEqual(self.put_actions(MASTER, actions).code, 200)
        self.assertEqual(self.get_actions(MASTER), actions)

    def test_enable_and_disable(self) -> None:
        for rule in (MASTER, "global/underride/.m.rule.message", "global/override/.m.rule.suppress_notices"):
            for value in (True, False, True):
                ch = self.make_request("PUT", f"/_matrix/client/v3/pushrules/{rule}/enabled", {"enabled": value},
                                       access_token=self.tok)
                self.assertEqual(ch.code, 200, ch.result)
                ch = self.make_request("GET", f"/_matrix/client/v3/pushrules/{rule}/enabled", access_token=self.tok)
                self.assertEqual(ch.json_body["enabled"], value, rule)

    def test_sound_highlight_and_silence(self) -> None:
        rule = "global/underride/.m.rule.message"
        for actions in (["notify", {"set_tweak": "sound", "value": "default"}],
                        ["notify", {"set_tweak": "sound", "value": "ring"}, {"set_tweak": "highlight", "value": True}],
                        ["notify", {"set_tweak": "highlight", "value": False}],
                        ["notify"], ["dont_notify"], []):
            ch = self.put_actions(rule, actions)
            self.assertEqual(ch.code, 200, ch.result)
            self.assertEqual(self.get_actions(rule), actions)

    def test_every_built_in_rule_takes_a_full_normal_set(self) -> None:
        actions = ["notify", {"set_tweak": "sound", "value": "default"}, {"set_tweak": "highlight", "value": True}]
        for rule in sorted(BASE_RULE_IDS):
            ch = self.put_actions(rule, actions)
            self.assertEqual(ch.code, 200, (rule, ch.result))
        # read back what the server lists (a built-in rule behind an experimental flag that's off takes a change but isn't listed)
        ch = self.make_request("GET", "/_matrix/client/v3/pushrules/global/", access_token=self.tok)
        listed = [r for kind in ch.json_body.values() for r in kind if r["rule_id"].startswith(".")]
        self.assertGreater(len(listed), 10, "the check saw the built-in rules")
        for r in listed:
            self.assertEqual(r["actions"], actions, r["rule_id"])

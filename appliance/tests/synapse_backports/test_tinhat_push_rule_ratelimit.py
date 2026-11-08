"""Tin Hat: a per-user rate limit on push rule writes (backports/0007), inside Synapse's own harness.

Every accepted change through `/pushrules` appends a row to `push_rules_stream` (no routine pruning for active accounts),
and upstream has no rate limit on these requests. 0007 allows a burst of 100 writes per user, then one every 5 seconds.
The refusals must fail without it; the normal workloads at the end must work with and without it."""
import os

import synapse
import synapse.rest.admin
from synapse.handlers.push_rules import BASE_RULE_IDS
from synapse.rest.client import login, push_rule, room

from tests.unittest import HomeserverTestCase

BURST = 100
RULE = "global/underride/.m.rule.message"
ACTIONS = ["notify", {"set_tweak": "sound", "value": "default"}]


class PushRuleWriteRate(HomeserverTestCase):
    servlets = [synapse.rest.admin.register_servlets_for_client_rest_resource, room.register_servlets,
                login.register_servlets, push_rule.register_servlets]
    hijack_auth = False

    def prepare(self, reactor, clock, hs) -> None:
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        self.user = self.register_user("writer", "pass")
        self.tok = self.login("writer", "pass")
        self.store = hs.get_datastores().main

    def put(self, path: str, body: dict, tok: str | None = None):
        return self.make_request("PUT", f"/_matrix/client/v3/pushrules/{path}", body, access_token=tok or self.tok)

    def stream_rows(self, user: str | None = None) -> int:
        return len(self.get_success(self.store.db_pool.simple_select_list(
            "push_rules_stream", {"user_id": user or self.user}, ("stream_id",))))

    def exhaust(self) -> tuple[int, object]:
        """Writes as fast as a client can until refused (or 150 times). -> (accepted, the last response)."""
        ok, ch = 0, None
        for _ in range(150):
            ch = self.put(f"{RULE}/actions", {"actions": ACTIONS})
            if ch.code != 200:
                break
            ok += 1
        return ok, ch

    def assert_exhausted(self) -> int:
        start = self.reactor.seconds()
        ok, ch = self.exhaust()
        self.assertEqual(ch.code, 429, ch.result)
        self.assertEqual(ch.json_body["errcode"], "M_LIMIT_EXCEEDED", ch.result)
        self.assertGreater(ch.json_body["retry_after_ms"], 0, ch.result)
        self.assertGreaterEqual(ok, BURST)
        leaked = int(0.2 * (self.reactor.seconds() - start)) + 1  # the harness's clock moves while requests run
        self.assertLessEqual(ok, BURST + leaked, "the burst, plus what leaked during the run")
        return ok

    # -- must fail without 0007
    def test_rapid_writes_are_refused_and_store_nothing(self) -> None:
        ok = self.assert_exhausted()
        self.assertEqual(self.stream_rows(), ok, "one row per accepted write, none for a refused one")

    def test_custom_rules_and_deletes_count_too(self) -> None:
        body = {"actions": ["notify"], "conditions": [{"kind": "event_match", "key": "type", "pattern": "x"}]}
        ok, last = 0, None
        for n in range(150):
            last = self.put(f"global/override/r{n}", body)
            if last.code != 200:
                break
            ok += 1
        self.assertEqual(last.code, 429, last.result)
        ch = self.make_request("DELETE", "/_matrix/client/v3/pushrules/global/override/r0", access_token=self.tok)
        self.assertEqual(ch.code, 429, ch.result)
        ch = self.make_request("GET", "/_matrix/client/v3/pushrules/global/override/r0", access_token=self.tok)
        self.assertEqual(ch.code, 200, "the refused delete changed nothing")

    def test_one_user_is_not_slowed_by_another(self) -> None:
        self.assert_exhausted()
        other = self.register_user("other", "pass")
        tok = self.login("other", "pass")
        self.assertEqual(self.put(f"{RULE}/actions", {"actions": ACTIONS}, tok).code, 200)
        self.assertEqual(self.stream_rows(other), 1)

    def test_writes_work_again_after_the_wait(self) -> None:
        self.assert_exhausted()
        ch = self.put(f"{RULE}/actions", {"actions": ACTIONS})
        self.assertEqual(ch.code, 429, ch.result)
        self.reactor.advance(ch.json_body["retry_after_ms"] / 1000 + 1)
        self.assertEqual(self.put(f"{RULE}/actions", {"actions": ACTIONS}).code, 200)

    def test_the_sustained_rate_is_one_write_every_five_seconds(self) -> None:
        self.assert_exhausted()
        self.reactor.advance(10)
        for n in range(20):  # slower than the rate: all accepted
            self.assertEqual(self.put(f"{RULE}/actions", {"actions": ACTIONS}).code, 200, n)
            self.reactor.advance(6)
        codes = []
        for _ in range(60):  # much faster than the rate: refused before long
            codes.append(self.put(f"{RULE}/actions", {"actions": ACTIONS}).code)
            self.reactor.advance(1)
        self.assertIn(429, codes)

    def test_deletes_use_the_same_allowance(self) -> None:
        start, ch, misses = self.reactor.seconds(), None, 0
        for _ in range(150):
            ch = self.make_request("DELETE", "/_matrix/client/v3/pushrules/global/override/none", access_token=self.tok)
            if ch.code != 404:
                break
            misses += 1
        self.assertEqual(ch.code, 429, ch.result)
        self.assertGreaterEqual(misses, BURST)
        self.assertLessEqual(misses, BURST + int(0.2 * (self.reactor.seconds() - start)) + 1)
        self.assertEqual(self.put(f"{RULE}/actions", {"actions": ACTIONS}).code, 429)

    def test_successful_deletes_use_the_allowance_too(self) -> None:
        body = {"actions": ["notify"], "conditions": [{"kind": "event_match", "key": "type", "pattern": "x"}]}
        start, accepted, last = self.reactor.seconds(), 0, None
        for _ in range(150):
            last = self.put("global/override/toggled", body)
            if last.code != 200:
                break
            accepted += 1
            last = self.make_request("DELETE", "/_matrix/client/v3/pushrules/global/override/toggled", access_token=self.tok)
            if last.code != 200:
                break
            accepted += 1
        self.assertEqual(last.code, 429, last.result)
        self.assertLessEqual(accepted, BURST + int(0.2 * (self.reactor.seconds() - start)) + 1, "a delete costs what a put costs")

    def test_a_second_device_shares_the_allowance(self) -> None:
        tok2 = self.login("writer", "pass", "second-device")
        self.assert_exhausted()
        self.assertEqual(self.put(f"{RULE}/actions", {"actions": ACTIONS}, tok2).code, 429)

    # -- must pass with and without it: normal workloads
    def test_a_client_rewriting_every_built_in_rule_at_sign_in_is_not_refused(self) -> None:
        """A synthetic worst case (no client we know of does this): enabled + actions on every built-in rule, twice, 7 minutes apart."""
        self.assertEqual(len(BASE_RULE_IDS), 40)
        for _ in range(2):
            for rule in sorted(BASE_RULE_IDS):
                self.assertEqual(self.put(f"{rule}/enabled", {"enabled": True}).code, 200, rule)
                self.assertEqual(self.put(f"{rule}/actions", {"actions": ACTIONS}).code, 200, rule)
            self.reactor.advance(420)

    def test_a_person_changing_settings_is_never_refused(self) -> None:
        """A write every 6 seconds for 30 minutes (a workload check; the rate itself is tested above)."""
        kinds = (["notify"], ["dont_notify"], [], ACTIONS, ["notify", {"set_tweak": "highlight", "value": True}])
        for n in range(300):
            self.assertEqual(self.put(f"{RULE}/actions", {"actions": kinds[n % len(kinds)]}).code, 200, n)
            self.reactor.advance(6)

    def test_reads_are_never_limited(self) -> None:
        for _ in range(150):
            ch = self.make_request("GET", "/_matrix/client/v3/pushrules/", access_token=self.tok)
            self.assertEqual(ch.code, 200, ch.result)

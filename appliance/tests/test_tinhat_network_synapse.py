"""tinhat_network inside a real Synapse 1.145 (review round 4, ON-1): an invite sent over federation /send with a
signature that is good but a content hash that isn't. Synapse stores its own redacted copy (still membership=invite)
without running check_event_for_spam; the module must still decline it on the person's behalf.

Needs TINHAT_TEST_SYNAPSE_PY (a python with matrix-synapse 1.145.0, twisted and parameterized) and
TINHAT_TEST_SYNAPSE_SRC (a checkout of element-hq/synapse at v1.145.0, for its tests/ harness); skipped without.
TINHAT_TEST_NETWORK_MODULE may name another tinhat_network.py to load (the negative control: the module before the
fix must FAIL test_a_redacted_invite_is_declined)."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
MODULE = Path(os.environ.get("TINHAT_TEST_NETWORK_MODULE")
              or HERE / "rootfs" / "opt" / "tinhat" / "manager" / "synapse" / "tinhat_network.py")
SYN_PY = os.environ.get("TINHAT_TEST_SYNAPSE_PY", "")
SYN_SRC = os.environ.get("TINHAT_TEST_SYNAPSE_SRC", "")

# Runs inside Synapse's own harness (FederatingHomeserverTestCase: this server is "test", the other one
# "other.example.com" with a signing key the keyring trusts).
CASE = r'''
import os

import synapse
from synapse.api.constants import EventTypes, Membership
from synapse.api.room_versions import RoomVersions
from synapse.events import make_event_from_dict
from synapse.rest import admin
from synapse.rest.client import login, room

from tests import unittest


class RedactedInvite(unittest.FederatingHomeserverTestCase):
    servlets = [admin.register_servlets, login.register_servlets, room.register_servlets]

    def default_config(self):
        c = super().default_config()
        c["modules"] = [{"module": "tinhat_network.NetworkRules",
                         "config": {"db": os.environ["TH_DIR"] + "/" + self.id() + ".db",
                                    "rules": os.environ["TH_DIR"] + "/network-rules.json"}}]
        return c

    def prepare(self, reactor, clock, hs):
        super().prepare(reactor, clock, hs)
        assert synapse.__file__.startswith(os.environ["TH_DIR"] + "/"), synapse.__file__
        self.store = hs.get_datastores().main
        self.state = hs.get_storage_controllers().state
        owner = self.register_user("owner", "pass")
        # a public room where any member may invite (Synapse's default needs power 50; the remote member has 0)
        self.room_id = self.helper.create_room_as(owner, tok=self.login("owner", "pass"), is_public=True,
                                                  room_version=RoomVersions.V10.identifier,
                                                  extra_content={"power_level_content_override": {"invite": 0}})
        self.remote = "@spam:" + self.OTHER_SERVER_NAME
        from synapse.events import make_event_from_dict
        self.join = make_event_from_dict(self.signed(self.remote, self.remote, Membership.JOIN),
                                         room_version=RoomVersions.V10)
        self.get_success(hs.get_federation_event_handler().on_receive_pdu(self.OTHER_SERVER_NAME, self.join))
        self.assertEqual(self.member(self.remote), "join")

    def current(self):
        return self.get_success(self.state.get_current_state(self.room_id))

    def member(self, user):
        ev = self.current().get((EventTypes.Member, user))
        return None if ev is None else ev.membership

    def signed(self, sender, target, membership, tamper=False, auth_member=None):
        s = self.current()
        auth = [s[(EventTypes.Create, "")].event_id, s[(EventTypes.PowerLevels, "")].event_id,
                s[(EventTypes.JoinRules, "")].event_id]
        if auth_member:
            auth.append(auth_member)
        d = {"room_id": self.room_id, "sender": sender, "state_key": target, "type": EventTypes.Member,
             "depth": 1000, "origin_server_ts": self.clock.time_msec(), "content": {"membership": membership},
             "auth_events": auth,
             "prev_events": list(self.get_success(self.store.get_latest_event_ids_in_room(self.room_id)))}
        d = self.add_hashes_and_signatures_from_other_server(d, RoomVersions.V10)
        if tamper:
            # the signature covers only the redacted event (membership); this changes the content hash's input
            d["content"]["reason"] = "x"
        return d

    def send(self, pdu, txn):
        ch = self.make_signed_federation_request("PUT", f"/_matrix/federation/v1/send/{txn}",
                                                 content={"pdus": [pdu], "edus": []})
        self.assertEqual(ch.code, 200, ch.json_body)
        self.pump(1)
        self.pump(1)
        return ch.json_body

    def note(self, what, membership):
        with open(os.environ["TH_DIR"] + "/notes.txt", "a") as f:
            f.write(f"{what}: membership after = {membership}\n")

    def local(self, name, rule):
        uid = self.register_user(name, "pass")
        self.get_success(self.hs.get_account_data_handler().add_account_data_for_user(
            uid, "dev.tinhat.invite_rules", {"v": 1, "remote": rule}))
        return uid

    def test_a_redacted_invite_is_declined(self):
        """The bug: the tampered invite becomes the person's invite (stock module); the fix declines it."""
        me = self.local("me", "nobody")
        self.send(self.signed(self.remote, me, Membership.INVITE, tamper=True,
                              auth_member=self.join.event_id), "t1")
        self.note("redacted", self.member(me))
        self.assertEqual(self.member(me), "leave", "a refused invite must not stay the person's invite")

    def test_control_a_whole_invite_is_soft_failed(self):
        """The path that worked before: check_event_for_spam soft-fails it, it never becomes the membership."""
        me = self.local("me", "nobody")
        pdu = self.signed(self.remote, me, Membership.INVITE, auth_member=self.join.event_id)
        res = self.send(pdu, "t2")
        self.note("whole", self.member(me))
        self.assertIsNone(self.member(me))
        eid = make_event_from_dict(pdu, room_version=RoomVersions.V10).event_id
        self.assertEqual(res.get("pdus", {}).get(eid), {}, "accepted by /send (not an error)")
        stored = self.get_success(self.store.get_event(eid, allow_rejected=True))
        self.assertTrue(stored.internal_metadata.is_soft_failed(), "soft-failed by check_event_for_spam")

    def test_a_frozen_nested_extra_keeps_the_rule(self):
        import collections.abc
        import tinhat_network
        api = self.hs.get_module_api()
        user = self.register_user("frozen", "pass")
        self.get_success(self.store.add_account_data_for_user(user, tinhat_network.RULE_TYPE,
                                                              {"v": 1, "remote": "anyone", "extra": {"a": {"b": [1]}}}))
        got = self.get_success(api.account_data_manager.get_global(user, tinhat_network.RULE_TYPE))
        self.assertIsInstance(got["extra"], collections.abc.Mapping)
        self.assertNotIsInstance(got["extra"], dict)  # the point of this test: Synapse froze it
        self.assertEqual(tinhat_network.parse_rule(got), "anyone")

    def test_control_an_allowed_redacted_invite_stays(self):
        """Not over-blocking: rule "anyone" keeps the (redacted) invite."""
        me = self.local("me", "anyone")
        pdu = self.signed(self.remote, me, Membership.INVITE, tamper=True, auth_member=self.join.event_id)
        self.send(pdu, "t3")
        self.note("allowed", self.member(me))
        self.assertEqual(self.member(me), "invite")
        # what Synapse stored is its own redacted copy: the hash didn't match, the extra content is gone
        stored = self.current()[(EventTypes.Member, me)]
        self.assertEqual(dict(stored.content), {"membership": "invite"})
        self.assertIn("reason", pdu["content"])
'''


@unittest.skipUnless(SYN_PY and SYN_SRC, "set TINHAT_TEST_SYNAPSE_PY and TINHAT_TEST_SYNAPSE_SRC (see the docstring)")
class InRealSynapse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = Path(tempfile.mkdtemp(prefix="ths-netsyn-"))
        cls.dir = d
        pkg = subprocess.check_output([SYN_PY, "-c", "import importlib.util, synapse; print(synapse.__version__); "
                                       "print(importlib.util.find_spec('synapse').submodule_search_locations[0])"],
                                      text=True, cwd="/").split()
        assert pkg[0] == "1.145.0", pkg
        shutil.copytree(pkg[1], d / "synapse", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(Path(SYN_SRC) / "tests", d / "tests", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(MODULE, d / "tinhat_network.py")
        (d / "tests" / "test_tinhat_network_redacted.py").write_text(CASE)
        env = {**os.environ, "PYTHONPATH": str(d), "PYTHONDONTWRITEBYTECODE": "1", "TH_DIR": str(d)}
        cls.run_ = subprocess.run([SYN_PY, "-m", "twisted.trial", "tests.test_tinhat_network_redacted"],
                                  cwd=d, env=env, capture_output=True, text=True, timeout=900)
        cls.out = cls.run_.stdout + cls.run_.stderr
        notes = d / "notes.txt"
        cls.notes = notes.read_text() if notes.exists() else ""
        print(cls.notes + cls.out[-1500:])

    @classmethod
    def tearDownClass(cls):
        if not os.environ.get("TINHAT_TEST_KEEP"):
            shutil.rmtree(cls.dir, True)

    def result(self, name):
        m = re.search(re.escape(name) + r" \.\.\.[\s\S]*?\[(OK|FAIL|ERROR|SKIPPED)\]", self.out)
        if m:
            return m.group(1)
        self.fail(f"{name} didn't run:\n{self.out[-3000:]}")

    def test_the_trial_run_is_clean_when_every_case_passes(self):
        names = ("test_a_redacted_invite_is_declined", "test_control_a_whole_invite_is_soft_failed",
                 "test_control_an_allowed_redacted_invite_stays", "test_a_frozen_nested_extra_keeps_the_rule")
        if all(self.result(n) == "OK" for n in names):
            self.assertEqual(self.run_.returncode, 0, self.out[-3000:])
            self.assertIn("PASSED (successes=4)", self.out)

    def test_redacted_invite_declined(self):
        self.assertEqual(self.result("test_a_redacted_invite_is_declined"), "OK")

    def test_control_whole_invite_soft_failed(self):
        self.assertEqual(self.result("test_control_a_whole_invite_is_soft_failed"), "OK")

    def test_frozen_nested_extra_keeps_the_rule(self):
        self.assertEqual(self.result("test_a_frozen_nested_extra_keeps_the_rule"), "OK")

    def test_control_allowed_redacted_invite_stays(self):
        self.assertEqual(self.result("test_control_an_allowed_redacted_invite_stays"), "OK")


if __name__ == "__main__":
    unittest.main()

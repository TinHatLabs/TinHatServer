"""Account safety (docs/ACCOUNT-SAFETY.md). The well-known names the server's owner (dev.tinhat.server.account.owner) so
the apps refuse "Delete my account" for it: set at setup (write_wellknowns once the owner's account exists), kept on
every update (refresh_configs writes it again), the adopted owner after `tinhat adopt-synapse`, the same account
under the new name after "Move to your own domain". Abuse reports ("Report…") show in the dashboard's Reports card."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import apiconf, templates  # noqa: E402

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import web  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

SN = "crew.test"


def owner_of(doc: str):
    return json.loads(doc)["dev.tinhat.server"]["account"].get("owner")


class WellKnownOwner(unittest.TestCase):
    def test_present_with_the_full_id_when_known(self):
        doc = templates.wellknown_client(SN, True, "0.3.5", owner=f"@owner:{SN}")
        self.assertEqual(json.loads(doc)["dev.tinhat.server"]["account"],
                         {"password_reset": "owner", "owner": f"@owner:{SN}"})

    def test_left_out_when_unknown(self):
        self.assertIsNone(owner_of(templates.wellknown_client(SN, True, "0.3.5")))
        self.assertIsNone(owner_of(templates.wellknown_client(SN, True, "0.3.5", owner="")))

    def test_the_former_names_well_known_names_the_owner_too(self):
        doc = templates.wellknown_former_client(SN, True, "0.3.5", owner=f"@owner:{SN}")
        self.assertEqual(owner_of(doc), f"@owner:{SN}")


class Owner(unittest.TestCase):
    def test_setup_owner(self):
        self.assertEqual(apiconf.owner({"server_name": SN, "admin": f"@owner:{SN}"}), f"@owner:{SN}")

    def test_none_before_setup_made_the_account(self):
        self.assertEqual(apiconf.owner({"server_name": SN}), "")
        self.assertEqual(apiconf.owner({}), "")

    def test_the_adopted_owner_wins(self):
        st = {"server_name": SN, "admin": f"@setup:{SN}", "adopted": {"owner": f"@adopter:{SN}"}}
        self.assertEqual(apiconf.owner(st), f"@adopter:{SN}")

    def test_after_a_move_the_same_account_under_the_new_name(self):
        st = {"server_name": "example.com", "admin": "@owner:example.com", "adopted": {"owner": f"@boss:{SN}"},
              "former_names": [{"name": SN, "mode": "anywhere", "at": 1}]}
        self.assertEqual(apiconf.owner(st), "@boss:example.com")

    def test_never_another_servers_account_or_junk(self):
        for bad in ("@x:elsewhere.org", "owner", "@:" + SN, "@a b:" + SN, "@a\n:" + SN, 42, None):
            self.assertEqual(apiconf.owner({"server_name": SN, "admin": bad}), "", repr(bad))
        self.assertEqual(apiconf.owner({"server_name": SN, "admin": f"@ok:{SN}", "adopted": {"owner": "@x:other"}}),
                         f"@ok:{SN}", "a bad adopted owner falls back to setup's")


class WrittenOnSetupAndUpdate(unittest.TestCase):
    """write_wellknowns is what setup's last step and refresh_configs (after every update) call."""
    def test_write_wellknowns_announces_the_owner(self):
        from tinhat import config, install
        with tempfile.TemporaryDirectory() as d, mock.patch.object(config, "WELLKNOWN_DIR", Path(d)), \
                mock.patch.object(install.apiconf, "MODULES_DIR", Path(d) / "modules"), \
                mock.patch.object(install, "write_app_links", lambda: None):
            st = {"server_name": SN, "admin": f"@owner:{SN}", "phase": "ready"}
            install.write_wellknowns(st, SN, True)
            doc = (Path(d) / ".well-known" / "matrix" / "client").read_text()
            self.assertEqual(owner_of(doc), f"@owner:{SN}")
            # the same owner goes to Synapse's tinhat_rules, which refuses to deactivate it
            self.assertEqual(json.loads((Path(d) / "modules" / "protected-accounts.json").read_text()), {"owner": f"@owner:{SN}"})


class ProtectedAccountsFile(unittest.TestCase):
    def test_written_only_when_it_changes_and_empty_when_unknown(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(apiconf, "MODULES_DIR", Path(d) / "m"):
            self.assertTrue(apiconf.publish_protected(f"@owner:{SN}"))
            self.assertFalse(apiconf.publish_protected(f"@owner:{SN}"), "same owner: untouched")
            f = Path(d) / "m" / "protected-accounts.json"
            self.assertEqual(f.stat().st_mode & 0o777, 0o644, "Synapse's container reads it")
            f.write_bytes(b"\xff")  # broken: repaired, never an error
            self.assertTrue(apiconf.publish_protected(f"@owner:{SN}"))
            self.assertTrue(apiconf.publish_protected(""))
            self.assertEqual(json.loads(f.read_text()), {"owner": ""})


class ReportsCard(unittest.TestCase):
    def test_abuse_reports_carry_their_fields_bug_reports_dont(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(apiconf, "DIR", Path(d)):
            (Path(d) / "reports").mkdir()
            (Path(d) / "reports" / "a.json").write_text(json.dumps({"at": 1, "user": f"@me:{SN}", "report": {
                "kind": "abuse", "type": "abuse", "title": "[report] spam: @bad", "category": "spam",
                "reported_user": f"@bad:{SN}", "room_id": f"!r:{SN}", "event_id": "$e", "details": "d" * 1200}}))
            (Path(d) / "reports" / "b.json").write_text(json.dumps({"at": 2, "user": f"@me:{SN}",
                                                                    "report": {"type": "bug", "title": "crash"}}))
            items = {i["name"]: i for i in apiconf.reports()}
            a = items["a.json"]["abuse"]
            self.assertEqual((a["category"], a["reported_user"], a["room_id"], a["event_id"]),
                             ("spam", f"@bad:{SN}", f"!r:{SN}", "$e"))
            self.assertEqual(len(a["details"]), 1000)
            self.assertNotIn("abuse", items["b.json"])
            self.assertEqual(items["b.json"]["title"], "crash")

    def test_a_pile_of_one_kind_never_pushes_the_other_off(self):
        """Round 3 security review, ACCWEB-3: abuse reports and problem reports / logs are cut separately, with totals."""
        with tempfile.TemporaryDirectory() as d, mock.patch.object(apiconf, "DIR", Path(d)):
            (Path(d) / "reports").mkdir()
            (Path(d) / "logs").mkdir()
            abuse = {"kind": "abuse", "type": "abuse", "category": "spam", "reported_user": f"@bad:{SN}"}
            for i in range(3):
                f = Path(d) / "reports" / f"old-{i}-abuse.json"
                f.write_text(json.dumps({"at": 1, "user": f"@me:{SN}", "report": abuse}))
                os.utime(f, (1000 + i, 1000 + i))
            for i in range(80):  # one member's flood of newer problem reports and logs
                f = Path(d) / ("reports" if i % 2 else "logs") / f"new-{i}-x-y.json"
                f.write_text(json.dumps({"at": 2, "user": f"@me:{SN}", "report": {"type": "bug", "title": str(i)}}))
                os.utime(f, (5000 + i, 5000 + i))
            doc = apiconf.reports_doc()
            self.assertEqual(sum(1 for i in doc["items"] if "abuse" in i), 3, "the older abuse reports are still listed")
            self.assertEqual((doc["abuseTotal"], doc["abuseShown"], doc["otherTotal"], doc["otherShown"]), (3, 3, 80, 50))
            self.assertEqual(len(apiconf.reports_doc(None, None)["items"]), 83, "Show all")
            self.assertEqual([i["at"] for i in doc["items"]], sorted((i["at"] for i in doc["items"]), reverse=True))
            self.assertEqual(apiconf.reports(), doc["items"], "the older call answers the same")

    def test_a_report_about_the_owner_doesnt_name_its_sender(self):
        """Round 3 security review, ACCWEB-4: the owner reads the dashboard; a report about them doesn't say who sent it."""
        own = f"@owner:{SN}"
        with tempfile.TemporaryDirectory() as d, mock.patch.object(apiconf, "DIR", Path(d)), \
                mock.patch.object(apiconf, "owner_ids", lambda st=None: {own}):
            (Path(d) / "reports").mkdir()
            for name, who in (("x-abuse.json", own), ("y-abuse.json", f"@bad:{SN}")):
                (Path(d) / "reports" / name).write_text(json.dumps({"at": 1, "user": f"@me:{SN}", "report": {
                    "kind": "abuse", "type": "abuse", "category": "harassment", "reported_user": who, "reporter": f"@me:{SN}"}}))
            items = {i["name"]: i for i in apiconf.reports()}
            self.assertEqual((items["x-abuse.json"]["user"], items["x-abuse.json"].get("reporterHidden")), ("", True))
            self.assertEqual(items["y-abuse.json"]["user"], f"@me:{SN}", "about someone else: shown as before")
            red = json.loads(apiconf.redacted_report((Path(d) / "reports" / "x-abuse.json").read_text()))
            self.assertEqual((red["user"], red["report"]["reporter"], red["report"]["reported_user"]), ("", "", own))
            self.assertEqual(items["x-abuse.json"]["size"], len(apiconf.redacted_report((Path(d) / "reports" / "x-abuse.json").read_text()).encode()),
                             "the size shown is the redacted copy's (no hint of the sender's id length)")
        self.assertFalse(apiconf.about_owner(own, ""), "no owner known: nothing hidden")
        self.assertFalse(apiconf.about_owner(f"{own}:8448", own))
        st = {"server_name": "new.example", "admin": "@owner:new.example", "former_names": [{"name": SN}]}
        self.assertEqual(apiconf.owner_ids(st), {"@owner:new.example", f"@owner:{SN}"}, "after a move: both names")
        self.assertTrue(apiconf.about_owner(f"@owner:{SN}", apiconf.owner_ids(st)))
        self.assertFalse(apiconf.about_owner(f"@owner:other.example", apiconf.owner_ids(st)))



@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class SynapseEventReports(unittest.TestCase):
    """Reports sent through Matrix itself (guests, other apps) are listed from Synapse's admin API, read-only."""
    def run_with(self, code, body, token="syt"):
        import asyncio
        from types import SimpleNamespace
        seen = []

        async def req(method, path, tok=None, **_):
            seen.append((method, path, tok))
            return code, body
        me = SimpleNamespace(_system_token=lambda: token, synapse=SimpleNamespace(req=req))
        return asyncio.run(web.Manager._event_reports(me)), seen

    def test_listed_newest_first_from_the_admin_api(self):
        out, seen = self.run_with(200, {"event_reports": [{"id": 7, "received_ts": 1_700_000_000_123,
            "user_id": f"@guest-1:{SN}", "sender": f"@bad:{SN}", "room_id": f"!r:{SN}", "event_id": "$e",
            "name": "General", "reason": "spam"}], "total": 120})
        self.assertEqual(seen, [("GET", "/_synapse/admin/v1/event_reports?limit=50&dir=b", "syt")])
        self.assertEqual(out[1], 120, "how many Synapse holds")
        self.assertEqual(out[0], [{"id": 7, "at": 1_700_000_000, "user": f"@guest-1:{SN}", "reported_user": f"@bad:{SN}",
                                "room_id": f"!r:{SN}", "event_id": "$e", "room": "General", "reason": "spam"}])

    def test_nothing_when_synapse_refuses_or_there_is_no_token(self):
        self.assertEqual(self.run_with(500, {"error": "x"})[0], (None, 0), "unreadable, not an empty queue")
        self.assertEqual(self.run_with(200, {"data": "junk"})[0], (None, 0))
        out, seen = self.run_with(200, {"event_reports": []}, token=None)
        self.assertEqual((out, seen), ((None, 0), []))

    def test_a_matrix_report_about_the_owner_doesnt_name_its_sender(self):
        """Round 3 security review, ACCWEB-4 (the Matrix list too)."""
        own = f"@owner:{SN}"
        body = {"event_reports": [{"id": 1, "user_id": f"@me:{SN}", "sender": own, "room_id": f"!r:{SN}", "event_id": "$e"},
                                  {"id": 2, "user_id": f"@me:{SN}", "sender": f"@bad:{SN}", "room_id": f"!r:{SN}", "event_id": "$f"}]}
        with mock.patch.object(apiconf, "owner_ids", lambda st=None: {own}):
            out, _ = self.run_with(200, body)
        self.assertEqual((out[0][0]["user"], out[0][0].get("reporterHidden")), ("", True))
        self.assertEqual((out[0][1]["user"], out[0][1].get("reporterHidden")), (f"@me:{SN}", None))

    def test_a_long_reason_is_kept(self):
        out, _ = self.run_with(200, {"event_reports": [{"id": 1, "reason": "x" * 999 + "!" + "y" * 50}]})
        self.assertEqual(len(out[0][0]["reason"]), 1000)
        self.assertTrue(out[0][0]["reason"].endswith("!"))


if __name__ == "__main__":
    unittest.main()

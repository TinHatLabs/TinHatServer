"""People → Set a new password (web.Manager.people_password): the owner's way back in for someone who forgot their
password, since a Tin Hat server sends no email. The server makes the password (shown once, never logged); only this
server's real, active accounts other than the owner's own and the system account; devices stay signed in unless asked.
And the well-known tells the apps so (`dev.tinhat.server.account.password_reset = "owner"`).

Needs the real aiohttp (the manager's web module); skipped where it isn't installed."""
import asyncio
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import config, templates  # noqa: E402

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import web  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

SN = "crew.test"
OWNER = f"@owner:{SN}"


class FakeSynapse:
    def __init__(self, users):
        self.users, self.calls = users, []

    async def user(self, mxid, tok):
        u = self.users.get(mxid)
        return (200, u) if u is not None else (404, {"errcode": "M_NOT_FOUND"})

    async def req(self, method, path, tok, json=None):
        self.calls.append((method, path, json))
        return 200, {}


class FakeSessions:
    def __init__(self):
        self.dropped = []

    def drop_for(self, mxid):
        self.dropped.append(mxid)
        return 1


class Req:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class PeoplePassword(unittest.TestCase):
    def call(self, body, signed_in=True, csrf=True, users=None, keep=None):
        m = web.Manager.__new__(web.Manager)
        m.sessions = FakeSessions()
        m._admin = lambda req: {"mxid": OWNER} if signed_in else None
        m._csrf_ok = lambda req: csrf
        m._limited = lambda *a, **k: False
        m._failed = lambda *a, **k: None
        m._system_token = lambda: "syt_test"
        m.synapse = FakeSynapse(users if users is not None else {
            f"@sam:{SN}": {"name": f"@sam:{SN}", "deactivated": False},
            f"@gone:{SN}": {"name": f"@gone:{SN}", "deactivated": True},
            OWNER: {"name": OWNER, "admin": True}})
        with mock.patch.object(web.state, "load_state", return_value={"server_name": SN}), \
                self.assertLogs("tinhat", level="INFO") as logs:
            web.log.info("start")  # assertLogs needs one line even when the call logs nothing
            resp = asyncio.run(m.people_password(Req(body)))
        if keep is not None:
            keep["dropped"] = m.sessions.dropped
        return resp.status, json.loads(resp.text), m.synapse.calls, "\n".join(logs.output)

    def test_sets_a_generated_password_and_keeps_devices(self):
        st, out, calls, logs = self.call({"mxid": f"@sam:{SN}"})
        self.assertEqual(st, 200)
        self.assertRegex(out["password"], r"^[a-z2-9]{4}(-[a-z2-9]{4}){3}$")
        self.assertFalse(re.search(r"[01ilo]", out["password"]))
        self.assertEqual(calls, [("POST", "/_synapse/admin/v1/reset_password/%40sam%3Acrew.test",
                                  {"new_password": out["password"], "logout_devices": False})])
        self.assertFalse(out["signedOut"])
        self.assertNotIn(out["password"], logs)  # never logged
        self.assertIn(f"{OWNER} set a new password for @sam:{SN}", logs)

    def test_two_passwords_differ(self):
        a = self.call({"mxid": f"@sam:{SN}"})[1]["password"]
        b = self.call({"mxid": f"@sam:{SN}"})[1]["password"]
        self.assertNotEqual(a, b)

    def test_sign_out_everywhere_only_when_asked_exactly(self):
        self.assertTrue(self.call({"mxid": f"@sam:{SN}", "signOutEverywhere": True})[2][0][2]["logout_devices"])
        self.assertFalse(self.call({"mxid": f"@sam:{SN}", "signOutEverywhere": "yes"})[2][0][2]["logout_devices"])

    def test_refusals_never_reach_the_chat_server(self):
        for body, code in [({"mxid": OWNER}, 400),                                   # your own: in the app
                           ({"mxid": f"@{config.SYSTEM_LOCALPART}:{SN}"}, 400),      # the server's own account
                           ({"mxid": "@sam:other.example"}, 400),                    # another server's
                           ({"mxid": f"@sam:{SN}.evil"}, 400),
                           ({"mxid": f"@Sam:{SN}"}, 400),                            # not a valid localpart
                           ({"mxid": f"@gone:{SN}"}, 400),                           # removed
                           ({"mxid": f"@nobody:{SN}"}, 404),
                           ({}, 400)]:
            st, out, calls, _ = self.call(body)
            self.assertEqual((st, calls), (code, []), body)
            self.assertNotIn("password", out)

    def test_the_targets_dashboard_sign_ins_end(self):
        seen = {}
        self.assertEqual(self.call({"mxid": f"@sam:{SN}"}, keep=seen)[0], 200)
        self.assertEqual(seen["dropped"], [f"@sam:{SN}"])

    def test_a_caller_who_is_no_longer_an_admin_is_refused_and_signed_out(self):
        for me in ({"name": OWNER, "admin": False}, {"name": OWNER, "admin": True, "deactivated": True}, None):
            users = {f"@sam:{SN}": {"name": f"@sam:{SN}"}}
            if me is not None:
                users[OWNER] = me
            seen = {}
            st, out, calls, _ = self.call({"mxid": f"@sam:{SN}"}, users=users, keep=seen)
            self.assertEqual((st, calls, seen["dropped"]), (401, [], [OWNER]), me)
            self.assertNotIn("password", out)

    def test_needs_a_signed_in_owner_and_the_page_header(self):
        self.assertEqual(self.call({"mxid": f"@sam:{SN}"}, signed_in=False)[:3:2], (401, []))
        self.assertEqual(self.call({"mxid": f"@sam:{SN}"}, csrf=False)[:3:2], (401, []))


class DashboardSignInsEnd(unittest.TestCase):
    def test_drop_for_ends_only_that_accounts_sign_ins(self):
        from tinhat import sessions
        S = sessions.Sessions(1, Path(tempfile.mkdtemp()) / "s.json")
        a, b, c = S.new("@a:x"), S.new("@a:x"), S.new("@b:x")
        self.assertEqual(S.drop_for("@a:x"), 2)
        self.assertEqual((S.get(a), S.get(b)), (None, None))
        self.assertIsNotNone(S.get(c))
        self.assertEqual(S.drop_for("@nobody:x"), 0)


class EveryLimitIsDeclared(unittest.TestCase):
    """A rate-limit kind that web.py uses but never declares in limits.Fails(...) is a KeyError, an HTTP 500, on the
    first try (found in the lab with people-password, 2026-10-22: the endpoint's unit test had stubbed the limiter)."""
    def test_used_kinds_are_declared(self):
        src = (_OPT / "manager" / "tinhat" / "web.py").read_text()
        declared = set(re.findall(r'"([a-z-]+)"', re.search(r"limits\.Fails\(([^)]*)\)", src).group(1)))
        used = set(re.findall(r'self\._(?:limited|failed|forgive)\("([a-z-]+)"', src))
        self.assertTrue(used)
        self.assertEqual(used - declared, set())


class WellKnownSaysSo(unittest.TestCase):
    def test_the_apps_are_told_to_ask_the_owner(self):
        doc = json.loads(templates.wellknown_client(SN, True, "0.3.0"))
        self.assertEqual(doc["dev.tinhat.server"]["account"], {"password_reset": "owner"})


if __name__ == "__main__":
    unittest.main()

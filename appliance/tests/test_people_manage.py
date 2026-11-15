"""People → Remove from this server and Make admin / Remove admin (web.Manager.people_remove / people_admin, D04.2, QOL
sweep 2026-11-13): the People tab could only reset passwords. Only this server's real, active accounts other than the
caller, the server's own account and the owner; the caller must still be an active admin; removing or demoting ends the
target's dashboard sign-ins.

Needs the real aiohttp (the manager's web module); skipped where it isn't installed."""
import asyncio
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
_saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _saved:
    del sys.modules[_k]
try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)

SN = "crew.test"
OWNER = f"@owner:{SN}"
ANA = f"@ana:{SN}"  # a second admin: the caller


class FakeSynapse:
    def __init__(self, users):
        self.users, self.calls = users, []

    async def user(self, mxid, tok):
        u = self.users.get(mxid)
        return (200, u) if u is not None else (404, {"errcode": "M_NOT_FOUND"})

    async def req(self, method, path, tok, json=None):
        self.calls.append((method, path, json))
        return 200, {}

    async def set_user(self, mxid, tok, **fields):
        self.calls.append(("PUT", f"/_synapse/admin/v2/users/{mxid}", fields))
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


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class PeopleManage(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)

    def call(self, what, body, me=ANA, users=None):
        m = web.Manager.__new__(web.Manager)
        m.sessions = FakeSessions()
        m.operators = {}
        m._admin = lambda req: {"mxid": me}
        m._csrf_ok = lambda req: True
        m._limited = lambda *a, **k: False
        m._failed = lambda *a, **k: None
        m._system_token = lambda: "syt_test"
        m.synapse = FakeSynapse(users if users is not None else {
            f"@sam:{SN}": {"name": f"@sam:{SN}", "admin": False},
            f"@kim:{SN}": {"name": f"@kim:{SN}", "admin": True},
            f"@gone:{SN}": {"name": f"@gone:{SN}", "deactivated": True},
            OWNER: {"name": OWNER, "admin": True},
            ANA: {"name": ANA, "admin": True}})
        with mock.patch.object(web.state, "load_state", return_value={"server_name": SN, "admin": OWNER}):
            resp = asyncio.run(getattr(m, f"people_{what}")(Req(body)))
        return resp.status, json.loads(resp.text), m.synapse.calls, m.sessions.dropped, m.operators

    def test_remove_deactivates_and_ends_their_dashboard_sign_ins(self):
        st, out, calls, dropped, ops = self.call("remove", {"mxid": f"@sam:{SN}"})
        self.assertEqual(st, 200)
        self.assertEqual(calls, [("POST", "/_synapse/admin/v1/deactivate/%40sam%3Acrew.test", {"erase": False})])
        self.assertEqual(dropped, [f"@sam:{SN}"])
        self.assertEqual(ops[f"@sam:{SN}"][0], False)

    def test_erase_only_when_asked_exactly(self):
        self.assertEqual(self.call("remove", {"mxid": f"@sam:{SN}", "erase": True})[2][0][2], {"erase": True})
        self.assertEqual(self.call("remove", {"mxid": f"@sam:{SN}", "erase": "yes"})[2][0][2], {"erase": False})

    def test_make_and_remove_admin(self):
        st, _, calls, dropped, ops = self.call("admin", {"mxid": f"@sam:{SN}", "admin": True})
        self.assertEqual((st, calls, dropped), (200, [("PUT", f"/_synapse/admin/v2/users/@sam:{SN}", {"admin": True})], []))
        st, _, calls, dropped, ops = self.call("admin", {"mxid": f"@kim:{SN}", "admin": False})
        self.assertEqual((st, calls, dropped), (200, [("PUT", f"/_synapse/admin/v2/users/@kim:{SN}", {"admin": False})], [f"@kim:{SN}"]))
        self.assertEqual(ops[f"@kim:{SN}"][0], False)  # the operator cache can't keep them in
        self.assertEqual(self.call("admin", {"mxid": f"@sam:{SN}", "admin": "yes"})[0:3:2], (400, []))

    def test_refusals_never_reach_the_chat_server(self):
        for what in ("remove", "admin"):
            for body, code in [({"mxid": OWNER, "admin": False}, 400),                  # the owner
                               ({"mxid": ANA, "admin": False}, 400),                    # yourself
                               ({"mxid": f"@tinhat-system:{SN}", "admin": False}, 400),
                               ({"mxid": f"@sam:other.example", "admin": True}, 400),
                               ({"mxid": f"@sam:{SN}.evil", "admin": True}, 400),
                               ({"mxid": f"@gone:{SN}", "admin": True}, 400),           # removed already
                               ({"mxid": f"@nobody:{SN}", "admin": True}, 404),
                               ({}, 400), (["x"], 400)]:
                st, out, calls, dropped, _ = self.call(what, body)
                self.assertEqual((st, calls, dropped), (code, [], []), (what, body))

    def test_a_caller_who_is_no_longer_an_admin_is_refused_and_signed_out(self):
        users = {f"@sam:{SN}": {"name": f"@sam:{SN}"}, ANA: {"name": ANA, "admin": False}}
        for what in ("remove", "admin"):
            st, out, calls, dropped, _ = self.call(what, {"mxid": f"@sam:{SN}", "admin": True}, users=users)
            self.assertEqual((st, calls, dropped), (401, [], [ANA]))



@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class GuestsOnPeople(unittest.TestCase):
    """People → Guests (D04.8): the Guests room's state and how many guests it has, never its link key."""
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.dir = Path(tempfile.mkdtemp())
        p2 = mock.patch.object(web.apiconf, "DIR", self.dir)
        p2.start()
        self.addCleanup(p2.stop)

    def test_summary(self):
        self.assertIsNone(web._guests_summary())  # no room yet
        (self.dir / "guests.json").write_text(json.dumps({"v": 1, "room": "!g:crew.test", "on": True, "since": 1700000000000,
                                                          "key": "SECRETKEY123"}))
        (self.dir / "guest-accounts.json").write_text(json.dumps([
            {"user": "@guest-a:crew.test", "room": "!g:crew.test"}, {"user": "@guest-b:crew.test", "room": "!g:crew.test"},
            {"user": "@guest-c:crew.test", "room": "!old:crew.test"}, "junk"]))
        g = web._guests_summary()
        self.assertEqual(g, {"on": True, "since": 1700000000000, "room": "!g:crew.test", "count": 2})
        self.assertNotIn("SECRETKEY123", json.dumps(g))
        (self.dir / "guest-accounts.json").write_text("not json")
        self.assertEqual(web._guests_summary()["count"], 0)



if __name__ == "__main__":
    unittest.main()

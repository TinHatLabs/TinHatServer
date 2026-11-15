"""Reports → Done (web.Manager.reports_done, D04.5, QOL sweep 2026-11-13): a report the owner dealt with folds under
Handled and stops counting; the mark is the manager's own (the report file stays). Keys are the card's own:
"report/<name>", "log/<name>", "matrix/<id>"; anything else is refused. Needs the real aiohttp."""
import asyncio
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

_OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))
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

OWNER = "@owner:crew.test"
ABUSE = "2026-11-13T10-00-00-000Z-abc123-abuse.json"


class Req:
    def __init__(self, body=None, query=None):
        self.body, self.query = body, query or {}

    async def json(self):
        return self.body


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class ReportsDone(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.file = pathlib.Path(tempfile.mkdtemp()) / "reports-handled.json"
        p2 = mock.patch.object(web, "REPORTS_HANDLED", self.file)
        p2.start()
        self.addCleanup(p2.stop)

    def manager(self, signed_in=True):
        m = web.Manager.__new__(web.Manager)
        m._admin = lambda req: {"mxid": OWNER} if signed_in else None
        m._csrf_ok = lambda req: True

        async def event_reports():
            return [{"id": 7, "at": 1, "reported_user": "@x:crew.test"}, {"id": 8, "at": 2}], 2
        m._event_reports = event_reports
        return m

    def done(self, body, signed_in=True):
        resp = asyncio.run(self.manager(signed_in).reports_done(Req(body)))
        return resp.status, json.loads(resp.text)

    def listed(self):
        doc = {"items": [{"kind": "report", "name": ABUSE, "at": 3}, {"kind": "log", "name": "x-y-z.log", "at": 4}],
               "abuseTotal": 1, "abuseShown": 1, "otherTotal": 1, "otherShown": 1}
        with mock.patch.object(web.apiconf, "reports_doc", lambda *a: json.loads(json.dumps(doc))):
            resp = asyncio.run(self.manager().reports_list(Req()))
        out = json.loads(resp.text)
        return {f"{i['kind']}/{i['name']}": i["handled"] for i in out["reports"]} | \
            {f"matrix/{i['id']}": i["handled"] for i in out["matrix"]}

    def test_done_and_not_done(self):
        self.assertEqual(set(self.listed().values()), {False})
        self.assertEqual(self.done({"key": f"report/{ABUSE}", "done": True})[0], 200)
        self.assertEqual(self.done({"key": "matrix/7", "done": True})[0], 200)
        self.assertEqual(self.listed(), {f"report/{ABUSE}": True, "log/x-y-z.log": False, "matrix/7": True, "matrix/8": False})
        self.assertEqual(json.loads(self.file.read_text())["matrix/7"]["by"], OWNER)
        self.assertEqual(self.done({"key": "matrix/7", "done": False})[0], 200)
        self.assertFalse(self.listed()["matrix/7"])

    def test_bad_keys_and_callers_are_refused(self):
        for body in ({"key": "report/../secrets.json", "done": True}, {"key": "report/.hidden", "done": True},
                     {"key": "secrets/x", "done": True}, {"key": "matrix/abc", "done": True},
                     {"key": f"report/{ABUSE}", "done": "yes"}, {"key": 5, "done": True}, ["x"], {}):
            self.assertEqual(self.done(body)[0], 400, body)
        self.assertEqual(self.done({"key": "matrix/7", "done": True}, signed_in=False)[0], 401)
        self.assertFalse(self.file.exists())


if __name__ == "__main__":
    unittest.main()

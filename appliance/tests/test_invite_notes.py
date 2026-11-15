"""Invite codes carry the owner's note (D04.4, QOL sweep 2026-11-13): "who it's for", kept by the manager next to the
Synapse registration token (which has no field for it), listed with the code, dropped with it. Plain text, one line, up
to 80 letters. Needs the real aiohttp."""
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


class FakeSynapse:
    def __init__(self):
        self.made = {}

    async def token_new(self, tok, payload):
        self.made[payload["token"]] = {**payload, "pending": 0, "completed": 0}
        return 200, self.made[payload["token"]]

    async def tokens(self, tok):
        return 200, {"registration_tokens": list(self.made.values())}

    async def token_delete(self, tok, code):
        return (200, {}) if self.made.pop(code, None) else (404, {})


class Req:
    def __init__(self, body=None, code=None):
        self.body, self.match_info = body, {"code": code}

    async def json(self):
        return self.body


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class InviteNotes(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.file = pathlib.Path(tempfile.mkdtemp()) / "invite-notes.json"
        for patch in (mock.patch.object(web, "INVITE_NOTES", self.file),
                      mock.patch.object(web.state, "load_state", return_value={"server_name": "crew.test"}),
                      mock.patch.object(web.apiconf, "settings", return_value={"web": ""})):
            patch.start()
            self.addCleanup(patch.stop)
        self.m = web.Manager.__new__(web.Manager)
        self.m._admin = lambda req: None  # the apps' path (who=…): no dashboard sign-in, no device check
        self.m._system_token = lambda: "syt"
        self.m.synapse = FakeSynapse()

    def run_(self, coro):
        resp = asyncio.run(coro)
        return resp.status, json.loads(resp.text)

    def create(self, body):
        return self.run_(self.m.invites_create(Req(body), who="@owner:crew.test"))

    def listed(self):
        return {a["code"]: a.get("note") for a in self.run_(self.m.invites_list(Req(), admin_ok=True))[1]["invites"]}

    def test_the_note_is_kept_listed_and_dropped_with_its_code(self):
        st, out = self.create({"uses": 1, "days": 7, "note": "  Robin\t from   work "})
        self.assertEqual(st, 200)
        code = out["invite"]["code"]
        self.assertEqual(out["invite"]["note"], "Robin from work")
        st, plain = self.create({"uses": 1, "days": 7})
        self.assertNotIn("note", plain["invite"])
        self.assertEqual(self.listed(), {code: "Robin from work", plain["invite"]["code"]: None})
        self.assertEqual(self.run_(self.m.invites_delete(Req(code=code), who="@owner:crew.test"))[0], 200)
        self.assertEqual(json.loads(self.file.read_text()), {})

    def test_bad_notes_mint_nothing(self):
        for note in ("x" * 81, "line\u0000", "bidi\u202e", 5, ["Robin"]):
            self.assertEqual(self.create({"uses": 1, "days": 7, "note": note})[0], 400, note)
        self.assertEqual(self.m.synapse.made, {})
        self.assertEqual(self.create(["x"])[0], 400)


if __name__ == "__main__":
    unittest.main()

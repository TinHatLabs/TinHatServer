"""Dashboard → Extras and keys → Save (web.Manager.set_api_features): a change that rewrites the API's env file must
reach the RUNNING API. `docker compose restart` keeps a container's old environment, so the extras are recreated
(`up -d --force-recreate api games`): found in the 0.3.3 lab, where switching phone notifications off left PUSH_RELAY in
the running API (it kept sending through the relay while the dashboard and the well-known said Off).

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

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
    from tinhat import install, web  # noqa: E402
except ImportError:
    HAVE_AIOHTTP = False

SN = "crew.test"


class Req:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class ExtrasApply(unittest.TestCase):
    def save(self, body, api=None, wrote=True):
        m = web.Manager.__new__(web.Manager)
        m._admin = lambda req: {"mxid": f"@owner:{SN}"}
        m._csrf_ok = lambda req: True
        m._moving = lambda: None
        m._apply_lock = asyncio.Lock()
        st = {"phase": "ready", "server_name": SN, "mode": "domain", "api": dict(api or {})}
        saved = {}

        def save_state(**kw):
            st.update(kw)
            saved.update(kw)
            return dict(st)

        calls = []

        async def run(*args, timeout=600):
            calls.append(args)
            return 0, ""

        with mock.patch.object(web.state, "load_state", return_value=dict(st)), \
                mock.patch.object(web.state, "load_secrets", return_value={}), \
                mock.patch.object(web.state, "save_state", side_effect=save_state), \
                mock.patch.object(web.apiconf, "write", return_value=wrote), \
                mock.patch.object(web.apiconf, "doc", return_value={}), \
                mock.patch.object(web.compose, "run", side_effect=run), \
                mock.patch.object(install, "write_wellknowns"):
            resp = asyncio.run(m.set_api_features(Req(body)))
        return resp.status, json.loads(resp.text), saved, calls

    def test_switching_phone_notifications_recreates_the_extras(self):
        for body, before, want in [({"phonePush": False}, {}, False), ({"phonePush": True}, {"phone_push": False}, True)]:
            st, out, saved, calls = self.save(body, before)
            self.assertEqual((st, out["changed"]), (200, ["phonePush"]))
            self.assertIs(saved["api"]["phone_push"], want)
            self.assertEqual(calls, [("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api", "games")])
            self.assertFalse(any(c and c[0] == "restart" for c in calls))  # a restart keeps the old environment

    def test_no_change_touches_nothing(self):
        st, out, saved, calls = self.save({"phonePush": True}, {})  # on already (unset = on)
        self.assertEqual((st, out["changed"], saved, calls), (200, [], {}, []))

    def test_files_unchanged_no_recreate(self):
        st, out, saved, calls = self.save({"phonePush": False}, {}, wrote=False)  # apiconf.write: nothing changed
        self.assertEqual((st, out["changed"], calls), (200, ["phonePush"], []))


if __name__ == "__main__":
    unittest.main()

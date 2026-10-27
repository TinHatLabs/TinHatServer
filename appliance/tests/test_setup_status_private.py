"""/admin/setup/status once the server is set up (web.Manager.setup_status): a stranger (no setup or dashboard session,
not on the home network or this machine) learns only what the welcome and sign-in pages need. Security review
2026-10-26 (detail/01 "/admin/setup/status answers unauthenticated after setup").

Needs the real aiohttp (the manager's web module); skipped where it isn't installed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
except ImportError:
    HAVE_AIOHTTP = False
if HAVE_AIOHTTP:
    _OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
    os.environ.setdefault("TINHAT_OPT", str(_OPT))
    sys.path.insert(0, str(_OPT / "manager"))
    os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
    from tinhat import web  # noqa: E402


class Req(dict):
    def __init__(self, headers=None, remote="127.0.0.1"):
        super().__init__()
        self.headers, self.remote, self.cookies = headers or {}, remote, {}


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (runs where the manager runs)")
class SetupStatus(unittest.TestCase):
    ST = {"phase": "ready", "server_name": "crew.tinhat.me", "mode": "anywhere", "reach": {"ok": True, "at": 1},
          "restored_from": {"at": 10 ** 10, "old_addresses": ["192.168.1.9"]}}

    def call(self, client, session=False, admin=False, st=None):
        m = web.Manager.__new__(web.Manager)
        m._setup_ok = lambda req: session
        m._admin = lambda req: {"mxid": "@o:crew.tinhat.me"} if admin else None

        async def offer(doc):
            return None
        m._relay_offer = offer
        m._network_doc = lambda: {}
        req = Req({"X-Forwarded-For": client})
        with mock.patch.object(web.state, "load_state", return_value=st or self.ST), \
                mock.patch.object(web.environment, "env", return_value={"zone": "tinhat.me"}), \
                mock.patch.object(web, "_proxies", return_value=None), \
                mock.patch.object(web, "_home_nets", return_value=[]), \
                mock.patch.object(web.relay, "on", return_value=False), \
                mock.patch.object(web.time, "time", return_value=10 ** 10 + 5):
            r = asyncio.run(m.setup_status(req))
        return json.loads(r.body)

    def test_a_stranger_learns_only_what_the_welcome_and_sign_in_pages_need(self):
        out = self.call("203.0.113.9")
        self.assertEqual(out["phase"], "ready")
        self.assertEqual(out["serverName"], "crew.tinhat.me")
        for k in ("version", "proxyOnly", "restoredFrom", "reach", "relay", "network"):
            self.assertNotIn(k, out)
        # the recovery card's instructions depend on these, also away from home (review of 116d103, #6)
        self.assertIn("edition", out)
        self.assertIn("platform", out)

    def test_home_network_this_machine_and_sessions_get_the_rest(self):
        for kw in ({"client": "192.168.1.20"}, {"client": "127.0.0.1"}, {"client": "203.0.113.9", "admin": True}):
            with self.subTest(**kw):
                out = self.call(**kw)
                self.assertIn("version", out)
                self.assertIn("reach", out)
                self.assertNotIn("restoredFrom", out)  # only the browser that did the setup (restore) is told
        out = self.call("203.0.113.9", session=True)
        self.assertEqual(out["restoredFrom"]["oldAddresses"], ["192.168.1.9"])

    def test_before_setup_nothing_changes(self):
        out = self.call("203.0.113.9", st={"phase": "unconfigured"})
        self.assertIn("version", out)
        self.assertIn("proxyOnly", out)


if __name__ == "__main__":
    unittest.main()

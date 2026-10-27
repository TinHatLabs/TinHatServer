"""tinhat.me/.well-known/apple-app-site-association and /assetlinks.json: the phone apps' link files at the zone apex
(a wildcard App Link, *.tinhat.me, is verified there), plain JSON with no sign-in; the same documents every Tin Hat
Server serves (appliance/tests/test_deeplinks.py compares them). docs/DEEPLINKS.md.
Needs aiohttp (skipped without it):  python3 -m unittest discover -s names/tests
"""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    from aiohttp.test_utils import TestClient, TestServer
    from tinhat_names import app as app_mod
    from tinhat_names import config as config_mod
    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False


class FakeDNS:
    def __init__(self, *a, **k):
        pass

    async def start(self):
        pass

    async def close(self):
        pass

    async def baseline(self, apex_ip, mail=None):
        pass


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class AppLinks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / "cf.token").write_text("x")
        (d / "admin.token").write_text("admintoken")
        cfg = config_mod.load(None)
        cfg.update(db=str(d / "n.db"), secret_key_file=str(d / "pow.key"), admin_token_file=str(d / "admin.token"))
        cfg["dns"]["token_file"] = str(d / "cf.token")
        self.orig = app_mod.Cloudflare
        app_mod.Cloudflare = FakeDNS
        self.client = TestClient(TestServer(app_mod.make_app(cfg)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        app_mod.Cloudflare = self.orig
        self.tmp.cleanup()

    async def fetch(self, path):
        r = await self.client.get(path, allow_redirects=False)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.content_type, "application/json")
        return json.loads(await r.text())

    async def test_apple(self):
        d = await self.fetch("/.well-known/apple-app-site-association")
        self.assertEqual(d["applinks"]["details"][0]["appIDs"], ["3XKTU7LCGT.dev.tinhat.TinHat"])

    async def test_android(self):
        d = await self.fetch("/.well-known/assetlinks.json")
        self.assertEqual(d[0]["target"]["package_name"], "dev.tinhat.android")


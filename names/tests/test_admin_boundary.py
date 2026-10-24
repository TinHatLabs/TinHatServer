"""The admin API lives only on its own loopback listener. The public app (what the tunnel / proxy forwards) has no
admin routes at all, even with the right token, and the admin app refuses anything a proxy would have touched.
Needs aiohttp (skipped without it):  python3 -m unittest discover -s names/tests
"""
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
class AdminBoundary(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / "cf.token").write_text("x")
        (d / "admin.token").write_text("admintoken")
        cfg = config_mod.load(None)
        cfg.update(db=str(d / "n.db"), secret_key_file=str(d / "pow.key"), admin_token_file=str(d / "admin.token"),
                   trust_proxy=True)
        cfg["dns"]["token_file"] = str(d / "cf.token")
        self.orig = app_mod.Cloudflare
        app_mod.Cloudflare = FakeDNS
        app = app_mod.make_app(cfg)
        self.public = TestClient(TestServer(app))
        await self.public.start_server()
        self.admin = TestClient(TestServer(app["admin"]))
        await self.admin.start_server()

    async def asyncTearDown(self):
        await self.admin.close()
        await self.public.close()
        app_mod.Cloudflare = self.orig
        self.tmp.cleanup()

    async def get(self, client, headers):
        r = await client.get("/v1/admin/codes", headers=headers)
        return r.status

    async def test_the_public_port_has_no_admin_api(self):
        # A tunnel (cloudflared) or proxy connects to the public port from 127.0.0.1: the token alone must not do.
        self.assertEqual(await self.get(self.public, {"Authorization": "Bearer admintoken"}), 404)
        r = await self.public.post("/v1/admin/codes", json={"uses": 1}, headers={"Authorization": "Bearer admintoken"})
        self.assertEqual(r.status, 404)

    async def test_the_admin_port_takes_the_token_from_loopback(self):
        self.assertEqual(await self.get(self.admin, {"Authorization": "Bearer admintoken"}), 200)

    async def test_wrong_or_missing_token_is_not_found(self):
        self.assertEqual(await self.get(self.admin, {"Authorization": "Bearer nope"}), 404)
        self.assertEqual(await self.get(self.admin, {}), 404)

    async def test_anything_a_proxy_touched_is_refused(self):
        for h in ("X-Forwarded-For", "X-Real-IP", "Forwarded", "Cf-Connecting-Ip", "Cf-Ray", "True-Client-Ip"):
            with self.subTest(header=h):
                self.assertEqual(await self.get(self.admin, {"Authorization": "Bearer admintoken", h: "203.0.113.9"}),
                                 404)

    def test_admin_listen_must_be_loopback(self):
        self.assertEqual(app_mod._loopback("127.0.0.1:8096"), ("127.0.0.1", 8096))
        self.assertEqual(app_mod._loopback("[::1]:8096"), ("::1", 8096))
        for bad in ("0.0.0.0:8096", ":8096", "10.8.0.2:8096"):
            with self.subTest(listen=bad), self.assertRaises(SystemExit):
                app_mod._loopback(bad)


if __name__ == "__main__":
    unittest.main()

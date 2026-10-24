"""allow-move: a name that moved to a computer which then died before it was backed up. An earlier copy's key is
refused ("moved") until the Tin Hat team opens the name for one more move; then it takes it over once. Needs aiohttp
(skipped without it):  python3 -m unittest discover -s names/tests
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
    from tinhat_names import pow as pow_mod
    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False


class FakeDNS:
    def __init__(self, *a, **k):
        self.records = {}

    async def start(self):
        pass

    async def close(self):
        pass

    async def baseline(self, apex_ip, mail=None):
        pass

    async def set_rrset(self, name, rtype, values, **extra):
        self.records[(name, rtype)] = list(values)

    async def delete_all(self, name):
        for k in [k for k in self.records if k[0] == name]:
            del self.records[k]


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class AllowMove(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / "cf.token").write_text("x")
        (d / "admin.token").write_text("admintoken")
        cfg = config_mod.load(None)
        cfg.update(db=str(d / "n.db"), secret_key_file=str(d / "pow.key"), admin_token_file=str(d / "admin.token"),
                   invite_only=False, pow_bits=4)
        cfg["dns"]["token_file"] = str(d / "cf.token")
        cfg["limits"].update(register_per_ip_per_day=50, live_per_ip=50, new_per_day=50)
        self.orig = app_mod.Cloudflare
        app_mod.Cloudflare = FakeDNS
        app = app_mod.make_app(cfg)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.admin = TestClient(TestServer(app["admin"]))  # the admin API's own loopback listener
        await self.admin.start_server()

    async def asyncTearDown(self):
        await self.admin.close()
        await self.client.close()
        app_mod.Cloudflare = self.orig
        self.tmp.cleanup()

    async def j(self, method, path, body=None, box=None, secret=None, admin=False):
        h = {"Authorization": "Bearer admintoken"} if admin else {}
        if box:
            h.update({"X-Api-User": box, "X-Api-Key": secret})
        r = await (self.admin if admin else self.client).request(method, path, json=body, headers=h)
        return r.status, await r.json()

    async def test_one_more_move_from_an_earlier_copy(self):
        _, ch = await self.j("POST", "/v1/challenge", {})
        st, reg = await self.j("POST", "/v1/register", {"name": "cedarhouse", "nonce": ch["nonce"],
                                                         "solution": pow_mod.solve(ch["nonce"], "cedarhouse", ch["bits"])})
        self.assertEqual(st, 200, reg)
        box, key_a = reg["box_id"], reg["secret"]
        st, out = await self.j("POST", "/v1/rotate", {}, box=box, secret=key_a)  # moved to computer B
        self.assertEqual(st, 200, out)
        key_b = out["secret"]
        st, out = await self.j("POST", "/v1/rotate", {}, box=box, secret=key_a)  # the older copy: refused
        self.assertEqual((st, out["error"]), (401, "moved"))
        st, out = await self.j("POST", "/v1/admin/allow-move/cedarhouse", {"hours": 24, "reason": "B died"}, admin=True)
        self.assertEqual(st, 200, out)
        st, out = await self.j("POST", "/v1/rotate", {}, box=box, secret=key_a)  # now it may, once
        self.assertEqual(st, 200, out)
        key_c = out["secret"]
        self.assertNotIn(key_c, (key_a, key_b))
        for old in (key_a, key_b):  # and the window is closed again; B's key is an earlier key now too
            st, out = await self.j("POST", "/v1/rotate", {}, box=box, secret=old)
            self.assertEqual((st, out["error"]), (401, "moved"))
        st, out = await self.j("POST", "/v1/update", {"version": "t"}, box=box, secret=key_c)
        self.assertEqual(st, 200, out)


if __name__ == "__main__":
    unittest.main()

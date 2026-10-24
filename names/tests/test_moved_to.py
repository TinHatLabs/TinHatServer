"""The server moved to its own domain (move.py): the names service keeps the name the server's, and the name's page
sends visitors to the new address. Only the server itself can say so; the new address is a domain of its own.
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
class MovedTo(unittest.IsolatedAsyncioTestCase):
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

    def fake_check(self, why):
        async def moved_here(host, fqdn, ctx, timeout):
            self.asked.append((host, fqdn))
            return why
        self.asked = []
        self.orig_check = app_mod.probe.moved_here
        app_mod.probe.moved_here = moved_here
        self.addCleanup(setattr, app_mod.probe, "moved_here", self.orig_check)

    async def register(self, name):
        _, ch = await self.j("POST", "/v1/challenge", {})
        st, reg = await self.j("POST", "/v1/register", {"name": name, "nonce": ch["nonce"],
                                                         "solution": pow_mod.solve(ch["nonce"], name, ch["bits"])})
        self.assertEqual(st, 200, reg)
        return reg

    async def test_the_name_says_where_the_server_went(self):
        self.fake_check(None)
        reg = await self.register("cedarhouse")
        st, out = await self.j("POST", "/v1/moved", {"to": "Chat.Example.com."}, box=reg["box_id"], secret=reg["secret"])
        self.assertEqual((st, out.get("moved_to")), (200, "chat.example.com"), out)
        self.assertEqual(self.asked, [("chat.example.com", "cedarhouse.tinhat.me")])  # it asked the new address
        r = await self.client.get("/cedarhouse", allow_redirects=False)
        self.assertEqual(r.status, 200)  # a page with the link, not a redirect on our domain
        self.assertIn('href="https://chat.example.com/"', await r.text())
        # still the server's: its key keeps working (the old address keeps answering while it lasts)
        st, _ = await self.j("POST", "/v1/update", {}, box=reg["box_id"], secret=reg["secret"])
        self.assertEqual(st, 200)
        # once an hour; clearing it is always allowed
        st, out = await self.j("POST", "/v1/moved", {"to": "chat.example.org"}, box=reg["box_id"], secret=reg["secret"])
        self.assertEqual(st, 429, out)
        st, out = await self.j("POST", "/v1/moved", {"to": ""}, box=reg["box_id"], secret=reg["secret"])
        self.assertEqual((st, out.get("moved_to")), (200, None))
        r = await self.client.get("/cedarhouse", allow_redirects=False)
        self.assertEqual((r.status, r.headers.get("Location")), (302, "https://cedarhouse.tinhat.me/"))

    async def test_only_the_server_only_its_own_domain_only_if_that_server_says_so(self):
        self.fake_check("That server doesn't say it was maplehouse.tinhat.me.")
        reg = await self.register("maplehouse")
        st, _ = await self.j("POST", "/v1/moved", {"to": "chat.example.com"}, box=reg["box_id"], secret="wrong")
        self.assertEqual(st, 401)
        for bad in ("other.tinhat.me", "tinhat.me", "not a domain", "x", "chat.example.com\n"):
            st, _ = await self.j("POST", "/v1/moved", {"to": bad}, box=reg["box_id"], secret=reg["secret"])
            self.assertEqual(st, 400, bad)
        st, out = await self.j("POST", "/v1/moved", {"to": "phish.example.com"}, box=reg["box_id"], secret=reg["secret"])
        self.assertEqual((st, out.get("error")), (400, "not-moved"), out)


if __name__ == "__main__":
    unittest.main()

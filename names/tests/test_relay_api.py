"""The relay endpoints end to end inside one process: a box registers, asks for a relay place, keeps it through
/v1/update, gets checked at the relay, and gives it back; the admin commands; traffic → allowance → what the relay is
told. DNS and the relay are fakes. Needs aiohttp (skipped without it): run where the service runs, e.g.
    python3 -m unittest discover -s names/tests
"""
import asyncio
import base64
import json
import os
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
    from tinhat_names import relay_api
    HAVE_AIOHTTP = True
except ImportError:  # a machine without aiohttp: these tests skip
    HAVE_AIOHTTP = False

GB = 1000 ** 3


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


class FakeRelay:
    """The relay's control API: remembers the last list; reports whatever traffic the test sets."""
    def __init__(self):
        self.places, self.usage, self.calls, self.down = [], {}, 0, False

    async def call(self, relay, method, path, body=None, timeout=20):
        if self.down:
            raise relay_api.RelayError("down")
        self.calls += 1
        if path == "/v1/status":
            return {"ok": True, "public_ip": "11.91.0.50", "capacity": 50, "ports": [20000, 20999],
                    "tunnel_net": "100.96.0.0/16", "tunnel_ip": "100.96.0.1",
                    "wg": {"endpoint": "11.91.0.50:51820", "public_key": base64.b64encode(b"r" * 32).decode()}}
        if path == "/v1/places":
            self.places = body["places"]
            return {"ok": True, "usage": {p["name"]: {"bytes": self.usage.get(p["name"], 0)} for p in self.places}}
        raise AssertionError(path)


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class RelayEndpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / "cf.token").write_text("x")
        (d / "admin.token").write_text("admintoken")
        cfg = config_mod.load(None)
        cfg.update(db=str(d / "n.db"), secret_key_file=str(d / "pow.key"), admin_token_file=str(d / "admin.token"),
                   invite_only=False, pow_bits=4, relay={"quota_gb": 1, "sync_seconds": 3600})
        cfg["dns"]["token_file"] = str(d / "cf.token")
        cfg["limits"].update(register_per_ip_per_day=50, live_per_ip=50, new_per_day=50)
        self.orig_cf = app_mod.Cloudflare
        app_mod.Cloudflare = FakeDNS
        self.app = app_mod.make_app(cfg)
        self.svc = self.app["svc"]
        self.relay = FakeRelay()
        self.svc.relays.call = self.relay.call
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.admin = TestClient(TestServer(self.app["admin"]))  # the admin API's own loopback listener
        await self.admin.start_server()

    async def asyncTearDown(self):
        await self.admin.close()
        await self.client.close()
        app_mod.Cloudflare = self.orig_cf
        self.tmp.cleanup()

    async def j(self, method, path, body=None, box=None, admin=False):
        h = {}
        if box:
            h = {"X-Api-User": box["box_id"], "X-Api-Key": box["secret"]}
        if admin:
            h = {"Authorization": "Bearer admintoken"}
        r = await (self.admin if admin else self.client).request(method, path, json=body, headers=h)
        return r.status, await r.json()

    async def register(self, name="crew"):
        _, ch = await self.j("POST", "/v1/challenge", {})
        sol = pow_mod.solve(ch["nonce"], name, ch["bits"])
        st, res = await self.j("POST", "/v1/register", {"name": name, "nonce": ch["nonce"], "solution": sol})
        self.assertEqual(st, 200, res)
        return res

    async def test_whole_life_of_a_relay_place(self):
        box = await self.register()
        dns = self.svc.dns
        home = dns.records[("crew.tinhat.me", "A")]
        st, out = await self.j("POST", "/v1/relay", {"public_key": "nope"}, box=box)
        self.assertEqual(st, 400)
        st, out = await self.j("POST", "/v1/relay", {"public_key": "x"}, box=None)
        self.assertEqual(st, 401)

        # no relay yet: the service says so, and /v1/info tells boxes not to offer it
        st, out = await self.j("POST", "/v1/relay", {"public_key": base64.b64encode(os.urandom(32)).decode()}, box=box)
        self.assertEqual((st, out["error"]), (503, "relay-none"))
        self.assertFalse((await self.j("GET", "/v1/info"))[1]["relay_available"])

        st, out = await self.j("POST", "/v1/admin/relay-add", {"id": "relay1", "url": "https://relay1.tinhat.dev:8443",
                                                                "token_file": "/t", "cert_file": "/c"}, admin=True)
        self.assertEqual(st, 200, out)
        self.assertTrue((await self.j("GET", "/v1/info"))[1]["relay_available"])
        key = base64.b64encode(os.urandom(32)).decode()
        st, out = await self.j("POST", "/v1/relay", {"public_key": key}, box=box)
        self.assertEqual(st, 200, out)
        self.assertEqual(out["relay"]["endpoint"], "11.91.0.50:51820")
        self.assertEqual((out["tunnel_ip"], out["ports"]), ("100.96.0.2", {"tcp": 20000, "udp": 20000}))
        self.assertEqual(dns.records[("crew.tinhat.me", "A")], ["11.91.0.50"])  # the name now points at the relay
        self.assertEqual(self.relay.places[0]["fqdn"], "crew.tinhat.me")
        self.assertEqual(self.relay.places[0]["public_key"], key)

        # /v1/update from the home doesn't take the name back; it hears about its place
        st, out = await self.j("POST", "/v1/update", {"version": "0.2.4"}, box=box)
        self.assertEqual(st, 200)
        self.assertEqual(out["ip4"], "11.91.0.50")
        self.assertEqual(out["relay"]["status"], "active")
        self.assertEqual(dns.records[("crew.tinhat.me", "A")], ["11.91.0.50"])

        # asking again is harmless; a new key replaces the old one on the relay
        key2 = base64.b64encode(os.urandom(32)).decode()
        st, out = await self.j("POST", "/v1/relay", {"public_key": key2}, box=box)
        self.assertEqual((st, out["tunnel_ip"]), (200, "100.96.0.2"))
        self.assertEqual(self.relay.places[0]["public_key"], key2)

        # the outside check goes to the relay, on the server's own port
        self.assertEqual(self.svc.relays.target("crew"), ("11.91.0.50", 20000))

        # traffic: over the allowance → calls paused (the relay is told at once), the owner hears it
        self.relay.usage["crew"] = int(1.2 * GB)
        await self.svc.relays.sync("relay1")
        self.assertEqual((self.relay.places[0]["web"], self.relay.places[0]["calls"]), (True, False))
        st, out = await self.j("POST", "/v1/update", {}, box=box)
        self.assertEqual(out["relay"]["status"], "calls-paused")
        self.assertTrue(any("allowance" in n["text"] for n in out["notices"]))
        # the admin raises it
        st, out = await self.j("POST", "/v1/admin/relay-quota/crew", {"gb": 5}, admin=True)
        self.assertEqual(out["place"]["status"], "active")
        self.assertTrue(self.relay.places[0]["calls"])
        st, out = await self.j("POST", "/v1/admin/relay-suspend/crew", {"reason": "abuse report"}, admin=True)
        self.assertEqual((self.relay.places[0]["web"], self.relay.places[0]["calls"]), (False, False))
        st, out = await self.j("POST", "/v1/admin/relay-unsuspend/crew", {}, admin=True)
        self.assertTrue(self.relay.places[0]["web"])

        # give it back: the relay forgets it and the name points home again
        st, out = await self.j("DELETE", "/v1/relay", box=box)
        self.assertEqual(st, 200)
        self.assertEqual(self.relay.places, [])
        self.assertEqual(dns.records[("crew.tinhat.me", "A")], home)
        st, out = await self.j("GET", "/v1/relay", box=box)
        self.assertIsNone(out["relay"])

    async def test_a_relay_that_doesnt_answer_leaves_nothing_behind(self):
        box = await self.register()
        await self.j("POST", "/v1/admin/relay-add", {"id": "relay1", "url": "https://r", "token_file": "/t",
                                                      "cert_file": "/c"}, admin=True)
        self.relay.down = True
        st, out = await self.j("POST", "/v1/relay", {"public_key": base64.b64encode(os.urandom(32)).decode()}, box=box)
        self.assertEqual((st, out["error"]), (502, "relay-down"))
        self.assertIsNone(self.svc.relays.store.place("crew"))
        self.assertNotEqual(self.svc.dns.records[("crew.tinhat.me", "A")], ["11.91.0.50"])

    async def test_a_released_name_frees_its_place(self):
        box = await self.register()
        await self.j("POST", "/v1/admin/relay-add", {"id": "relay1", "url": "https://r", "token_file": "/t",
                                                      "cert_file": "/c"}, admin=True)
        await self.j("POST", "/v1/relay", {"public_key": base64.b64encode(os.urandom(32)).decode()}, box=box)
        st, _ = await self.j("POST", "/v1/release", {}, box=box)
        self.assertEqual(st, 200)
        self.assertIsNone(self.svc.relays.store.place("crew"))
        self.assertEqual(self.relay.places, [])

    async def test_a_moved_name_leaves_the_old_computers_tunnel_at_once(self):
        """Restored on another computer (rotate): the relay stops carrying the name to the old tunnel right away, and
        the new computer's /v1/update points the name at its home until it asks for a place of its own."""
        box = await self.register()
        await self.j("POST", "/v1/admin/relay-add", {"id": "relay1", "url": "https://r", "token_file": "/t",
                                                      "cert_file": "/c"}, admin=True)
        old_key = base64.b64encode(os.urandom(32)).decode()
        await self.j("POST", "/v1/relay", {"public_key": old_key}, box=box)
        self.assertEqual([p["public_key"] for p in self.relay.places], [old_key])
        st, out = await self.j("POST", "/v1/rotate", {"why": "restored from a backup"}, box=box)
        self.assertEqual(st, 200, out)
        self.assertIsNone(self.svc.relays.store.place("crew"))
        self.assertEqual(self.relay.places, [])  # the relay was told at once
        new = {**box, "secret": out["secret"]}
        st, out = await self.j("POST", "/v1/update", {"version": "0.2.19"}, box=new)
        self.assertEqual(st, 200, out)
        self.assertNotEqual(self.svc.dns.records[("crew.tinhat.me", "A")], ["11.91.0.50"])  # home, not the relay


if __name__ == "__main__":
    unittest.main()

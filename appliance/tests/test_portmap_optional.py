"""The optional router port (80: someone typing just the server's name over http://) is never taken from another device:
portmap.open_ports(careful=...) looks first and leaves it alone unless the router says it's free, ours, or an earlier
Tin Hat Server's that nobody answers on any more. Some routers overwrite a mapping instead of refusing it.

portmap imports aiohttp; where it isn't installed (the build container) a stand-in is used and the one test that
needs a real HTTP server is skipped (it runs where the manager runs: on a server).
"""
import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest

try:
    import aiohttp  # noqa: F401
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None  # not another test's stand-in
except ImportError:
    HAVE_AIOHTTP = False
    _aio = types.ModuleType("aiohttp")
    _aio.ClientError = type("ClientError", (Exception,), {})
    sys.modules.setdefault("aiohttp", _aio)

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
spec = importlib.util.spec_from_file_location("tinhat_portmap_under_test", PKG / "portmap.py")
portmap = importlib.util.module_from_spec(spec)
sys.modules["tinhat_portmap_under_test"] = portmap
spec.loader.exec_module(portmap)

ME = "192.168.1.30"


class Router:
    """A router where port 80 is held as the test says; every AddPortMapping succeeds (the overwriting kind)."""
    def __init__(self, seen, holder=None, alive=True, seen443=None):
        self.seen, self.holder, self.alive, self.added, self.removed = seen, holder, alive, [], []
        self.seen443 = seen443

    def install(self):
        r = self

        class IGD:
            def describe(self):
                return "test router"

        async def discover(timeout=2.5, local=None, gw=None):
            return IGD()

        async def none(*a, **k):
            return None

        async def tidy(*a, **k):
            return []

        async def lookup(igd, proto, port):
            if port == 443 and r.seen443:
                return r.seen443
            return (r.seen, r.holder) if port == 80 else ("free", None)

        async def add(igd, proto, port, client):
            r.added.append(port)
            return {"ok": True, "why": ""}

        async def unmap(igd, proto, port):
            r.removed.append(port)
            return True

        async def alive(ip, timeout=1.5):
            return r.alive

        portmap.gateway, portmap.lan_ip = (lambda: "192.168.1.1"), (lambda gw: ME)
        portmap.discover, portmap.upnp_external_ip, portmap.natpmp_external_ip = discover, none, none
        portmap._upnp_tidy, portmap.upnp_lookup, portmap.upnp_map = tidy, lookup, add
        portmap.upnp_unmap, portmap._alive = unmap, alive

    def run(self):
        self.install()
        rep = asyncio.run(portmap.open_ports([("TCP", 443), ("TCP", 80)], careful=frozenset({("TCP", 80)})))
        return {m["port"]: m for m in rep["mapped"]}


class OptionalPort(unittest.TestCase):
    def test_free_ours_and_a_gone_tin_hat_are_asked_for(self):
        r = Router("free")
        self.assertTrue(r.run()[80]["ok"])
        self.assertEqual(r.added, [443, 80])
        r = Router("held", {"client": ME, "port": 80, "desc": "Tin Hat Server TCP 80", "lease": 600})
        self.assertTrue(r.run()[80]["ok"])
        r = Router("held", {"client": "192.168.1.40", "port": 80, "desc": "Tin Hat Server TCP 80", "lease": 0}, alive=False)
        self.assertTrue(r.run()[80]["ok"])
        self.assertEqual(r.removed, [80])  # the earlier Tin Hat's, given back first

    def test_another_devices_port_80_is_left_alone(self):
        for holder, alive in (({"client": "192.168.1.50", "port": 80, "desc": "NAS web", "lease": 0}, True),
                              ({"client": "192.168.1.40", "port": 80, "desc": "Tin Hat Server TCP 80", "lease": 0}, True)):
            r = Router("held", holder, alive=alive)
            got = r.run()[80]
            self.assertFalse(got["ok"])
            self.assertTrue(got["taken"])
            self.assertEqual(got["holder"], holder["client"])
            self.assertEqual(r.added, [443])  # never asked: an overwriting router would have handed it over
            self.assertEqual(r.removed, [])

    def test_this_machines_other_mapping_is_left_alone(self):
        # 80 → this same machine, but its port 8080: another app's (a web server next to Tin Hat), never taken over
        r = Router("held", {"client": ME, "port": 8080, "desc": "my web app", "lease": 0})
        got = r.run()[80]
        self.assertFalse(got["ok"])
        self.assertTrue(got["taken"])
        self.assertEqual((r.added, r.removed), ([443], []))

    def test_a_router_that_doesnt_say_means_leave_it(self):
        r = Router("unknown")
        got = r.run()[80]
        self.assertFalse(got["ok"])
        self.assertTrue(got.get("left"))
        self.assertEqual(r.added, [443])


class NeededPorts(unittest.TestCase):
    def test_a_needed_port_another_device_has_is_never_taken(self):
        r = Router("free", seen443=("held", {"client": "192.168.1.50", "port": 443, "desc": "NAS", "lease": 0}))
        got = r.run()
        self.assertTrue(got[443]["taken"])
        self.assertEqual(r.added, [80])
        r = Router("free", seen443=("held", {"client": ME, "port": 8443, "desc": "my web app", "lease": 0}))
        self.assertTrue(r.run()[443]["taken"])  # this machine, another app

    def test_a_needed_port_is_asked_for_when_the_router_doesnt_say(self):
        r = Router("free", seen443=("unknown", None))
        self.assertTrue(r.run()[443]["ok"])  # as always: the router refuses a conflict itself
        self.assertEqual(r.added, [443, 80])


class SilentRouter(unittest.TestCase):
    def test_the_gateways_usual_addresses_when_nobody_answers_the_search(self):
        asked = []

        async def describe(location, timeout=5):
            asked.append(location)
            return "IGD" if location == "http://10.0.0.1:5000/rootDesc.xml" else None  # a Netgear Orbi
        saved = portmap._describe
        portmap._describe = describe
        try:
            self.assertEqual(asyncio.run(portmap._from_gateway("10.0.0.1")), "IGD")
            self.assertEqual(asked, ["http://10.0.0.1:5000/rootDesc.xml"])
            asked.clear()
            self.assertIsNone(asyncio.run(portmap._from_gateway("192.168.1.1")))  # none of them: NAT-PMP next
            self.assertEqual(len(asked), len(portmap.GATEWAY_DESCRIPTIONS))
            self.assertTrue(all(a.startswith("http://192.168.1.1:") for a in asked))  # the gateway only
            asked.clear()
            self.assertIsNone(asyncio.run(portmap._from_gateway("evil.example/x?")))  # never anything but an address
            self.assertEqual(asked, [])
        finally:
            portmap._describe = saved


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp (runs on a server: python3 -m unittest test_portmap_optional)")
class Description(unittest.TestCase):
    """The router's description: never followed through a redirect, never more than DESCRIPTION_MAX bytes."""
    def test_redirects_and_huge_answers_are_refused(self):
        # other tests in the suite put a stand-in aiohttp in sys.modules: this one needs the real one, then puts it back
        stashed = {k: sys.modules.pop(k) for k in list(sys.modules) if k == "aiohttp" or k.startswith("aiohttp.")}
        saved_pm = portmap.aiohttp
        try:
            import aiohttp as real_aiohttp
            from aiohttp import web
            portmap.aiohttp = real_aiohttp
            self._run(web)
        finally:
            portmap.aiohttp = saved_pm
            for k in [k for k in sys.modules if k == "aiohttp" or k.startswith("aiohttp.")]:
                del sys.modules[k]
            sys.modules.update(stashed)

    def _run(self, web):
        xml = ('<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><friendlyName>R</friendlyName>'
               '<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>'
               '<controlURL>/ctl</controlURL></service></serviceList></device></root>')

        async def main():
            app = web.Application()
            app.router.add_get("/desc", lambda r: web.Response(text=xml, content_type="text/xml"))
            app.router.add_get("/redirect", lambda r: web.HTTPFound("/desc"))
            app.router.add_get("/big", lambda r: web.Response(body=b"<" + b"x" * (portmap.DESCRIPTION_MAX + 10)))
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                base = f"http://127.0.0.1:{port}"
                return (await portmap._describe(base + "/desc"), await portmap._describe(base + "/redirect"),
                        await portmap._describe(base + "/big"))
            finally:
                await runner.cleanup()
        ok, redirected, big = asyncio.run(main())
        self.assertIsNotNone(ok)
        self.assertIsNone(redirected)
        self.assertIsNone(big)


class GivingBack(unittest.TestCase):
    def test_only_this_servers_own_mappings_go(self):
        held = {80: {"client": ME, "port": 8080, "desc": "my web app", "lease": 0},       # another app on this machine
                443: {"client": ME, "port": 443, "desc": "Tin Hat Server TCP 443", "lease": 600}}
        removed = []

        class IGD:
            pass

        async def discover(timeout=2.5, local=None, gw=None):
            return IGD()

        async def holder(igd, proto, port):
            return held.get(port)

        async def unmap(igd, proto, port):
            removed.append(port)
            return True

        async def none(*a, **k):
            return None
        portmap.gateway, portmap.lan_ip = (lambda: "192.168.1.1"), (lambda gw: ME)
        portmap.discover, portmap.upnp_holder, portmap.upnp_unmap, portmap.natpmp_external_ip = discover, holder, unmap, none
        done = asyncio.run(portmap.close_ports([("TCP", 443), ("TCP", 80)]))
        self.assertEqual(removed, [443])
        self.assertEqual(done, ["TCP 443"])


if __name__ == "__main__":
    unittest.main()

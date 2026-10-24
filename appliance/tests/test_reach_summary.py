"""reach.summary: the words match what the router and the outside check really did (round-4 findings, 2026-10-18).

Runs anywhere (no aiohttp needed): the network modules reach imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load_reach():
    pkg = types.ModuleType("tinhat")
    pkg.__path__ = [str(PKG)]
    sys.modules["tinhat"] = pkg
    for name in ("compose", "hw", "names", "portmap", "state"):
        sys.modules[f"tinhat.{name}"] = types.ModuleType(f"tinhat.{name}")
    spec = importlib.util.spec_from_file_location("tinhat.reach", PKG / "reach.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


reach = load_reach()
FAIL = {"tls443": {"ok": False, "why": "unreachable"}, "tcp7881": {"ok": False, "why": "unreachable"},
        "udp7882": {"ok": False, "why": "no-answer"}}


def ports(mapped, kind="public", method="upnp"):
    return {"kind": kind, "method": method, "lan_ip": "10.90.0.187", "gateway": "10.90.0.1",
            "router": {"maker": "TinHatLab", "model": "HomeRouter"}, "mapped": mapped}


def m(proto, port, **kw):
    return {"proto": proto, "port": port, **kw}


class Summary(unittest.TestCase):
    PROXY = {"serverName": "home.crew.test", "lanIp": "10.90.0.105", "port": 8080}

    def test_behind_the_owners_proxy_https_is_the_proxys_job(self):
        # The router opened the call ports for us; 443 is the owner's proxy's (never a forward of ours).
        p = ports([m("TCP", 7881, ok=True), m("UDP", 7882, ok=True)])
        res = {"tls443": {"ok": False, "why": "unreachable"}, "tcp7881": {"ok": True}, "udp7882": {"ok": True}}
        s = reach.summary(p, {"ok": False, "results": res}, self.PROXY)
        text = " ".join(s["lines"])
        self.assertEqual(s["level"], "bad")
        self.assertIn("reverse proxy doesn't pass https://home.crew.test", text)
        self.assertIn("http://10.90.0.105:8080", text)
        self.assertNotIn("from outside yet: TCP 443", text)  # never listed as one of our ports
        self.assertFalse(any("443" in f for f in s["fix"]))

    def test_behind_the_owners_proxy_calls_still_need_the_router(self):
        p = ports([m("TCP", 7881, ok=False, why="refused"), m("UDP", 7882, ok=False, why="refused")])
        res = {"tls443": {"ok": True}, "tcp7881": {"ok": False, "why": "unreachable"},
               "udp7882": {"ok": False, "why": "no-answer"}}
        s = reach.summary(p, {"ok": False, "results": res}, self.PROXY)
        self.assertEqual(s["level"], "warn")
        self.assertTrue(any("Forward TCP port 7881 to 10.90.0.187" in f for f in s["fix"]))
        self.assertFalse(any("443" in f for f in s["fix"]))

    def test_ports_behind_a_proxy(self):
        self.assertEqual(reach.ports(True, proxy=True), [("TCP", 7881), ("UDP", 7882)])
        self.assertEqual(reach.ports(False, proxy=True), [])
        self.assertEqual(reach.ports(True), [("TCP", 443), ("TCP", 7881), ("UDP", 7882)])

    def test_port_80_is_asked_for_but_never_needed(self):
        # someone typing just the name into a browser that starts with http:// gets sent on to https
        self.assertEqual(reach.wanted(True), [("TCP", 443), ("TCP", 7881), ("UDP", 7882), ("TCP", 80)])
        self.assertEqual(reach.wanted(True, proxy=True), [("TCP", 7881), ("UDP", 7882)])  # the proxy's, like 443
        self.assertNotIn(("TCP", 80), reach.ports(True))  # never part of what "friends can reach it" needs
        self.assertNotIn(("TCP", 80), reach.CHECK_KEY)
        # a router that refuses it changes nothing in what the owner is told
        p = ports([m("TCP", 443), m("TCP", 7881), m("UDP", 7882), m("TCP", 80, ok=False, taken=True, holder="10.0.0.9")])
        s = reach.summary(p, {"ok": True, "results": {"tls443": {"ok": True}, "tcp7881": {"ok": True}, "udp7882": {"ok": True}}})
        self.assertEqual(s["level"], "good")
        self.assertFalse(any("80" in line for line in s["lines"] + s.get("fix", [])))

    def test_round4_all_taken_by_old_server(self):
        p = ports([m("TCP", 443, ok=False, taken=True, holder="10.90.0.169", holder_tinhat=True, holder_lease=420),
                   m("TCP", 7881, ok=False, taken=True, holder="10.90.0.169", holder_tinhat=True, holder_lease=430),
                   m("UDP", 7882, ok=False, taken=True, holder="10.90.0.169", holder_tinhat=True, holder_lease=440)])
        s = reach.summary(p, {"ok": False, "results": FAIL})
        text = " ".join(s["lines"])
        self.assertEqual(s["level"], "bad")
        self.assertIn("TCP 443, TCP 7881, UDP 7882", text)          # 443 is listed (it wasn't in 0.2.1)
        self.assertIn("10.90.0.169", text)
        self.assertIn("earlier Tin Hat Server", text)
        self.assertIn("in about 7 minutes", text)                      # the longest remaining lease, 440 s
        self.assertNotIn("accepted", text)                            # 0.2.1 said the router accepted
        self.assertTrue(any("Remove the forward of TCP port 443 to 10.90.0.169" in f for f in s["fix"]))
        self.assertIn("http://10.90.0.1", text)

    def test_countdown_runs_from_the_last_renewal(self):
        import time
        p = ports([m("TCP", 443, ok=False, taken=True, holder="10.90.0.169", holder_tinhat=True, holder_lease=440)])
        p["at"] = int(time.time()) - 400
        s = reach.summary(p, {"ok": False, "results": {"tls443": {"ok": False, "why": "unreachable"}}})
        self.assertIn("any moment now", " ".join(s["lines"]))
        p["at"] = int(time.time()) - 200
        self.assertIn("in about 4 minutes", " ".join(reach.summary(p, {"ok": False, "results": {"tls443": {"ok": False}}})["lines"]))

    def test_permanent_holder_needs_removing(self):
        p = ports([m("TCP", 443, ok=False, taken=True, holder="10.90.0.169", holder_tinhat=True, holder_lease=0)])
        s = reach.summary(p, {"ok": False, "results": {"tls443": {"ok": False, "why": "unreachable"}}})
        self.assertIn("keeps those ports until they're removed", " ".join(s["lines"]))

    def test_other_device_gets_no_promise(self):
        p = ports([m("TCP", 443, ok=False, taken=True, holder="10.90.0.50", holder_tinhat=False, holder_lease=0)])
        s = reach.summary(p, {"ok": False, "results": {"tls443": {"ok": False, "why": "unreachable"}}})
        text = " ".join(s["lines"])
        self.assertIn("10.90.0.50", text)
        self.assertNotIn("Tin Hat Server", text)
        self.assertTrue(any("Remove the forward of TCP port 443 to 10.90.0.50" in f for f in s["fix"]))

    def test_opened_but_blocked_public(self):
        p = ports([m("TCP", 443, ok=True), m("TCP", 7881, ok=True), m("UDP", 7882, ok=True)])
        s = reach.summary(p, {"ok": False, "results": FAIL})
        text = " ".join(s["lines"])
        self.assertIn("opened TCP 443, TCP 7881, UDP 7882", text)
        self.assertIn("internet provider", text)
        self.assertEqual(s["fix"], [])                                # forwarding by hand wouldn't change anything

    def test_refused_gives_forwards(self):
        p = ports([m("TCP", 443, ok=False, why="the router refused (not allowed)"), m("TCP", 7881, ok=True),
                   m("UDP", 7882, ok=True)])
        res = dict(FAIL, tcp7881={"ok": True}, udp7882={"ok": True})
        s = reach.summary(p, {"ok": False, "results": res})
        self.assertIn("Forward TCP port 443 to 10.90.0.187, port 443", s["fix"])
        self.assertEqual(len([f for f in s["fix"] if f.startswith("Forward")]), 1)
        self.assertIn("didn't open TCP 443 automatically (the router refused (not allowed))", " ".join(s["lines"]))

    def test_no_upnp(self):
        s = reach.summary(ports([], method=None), {"ok": False, "results": FAIL})
        self.assertIn("didn't answer the automatic request", " ".join(s["lines"]))
        self.assertEqual(len([f for f in s["fix"] if f.startswith("Forward")]), 3)

    def test_chat_ok_calls_blocked_is_warn(self):
        p = ports([m("TCP", 443, ok=True), m("TCP", 7881, ok=True), m("UDP", 7882, ok=True)])
        res = dict(FAIL, tls443={"ok": True})
        s = reach.summary(p, {"ok": False, "results": res})
        self.assertEqual(s["level"], "warn")
        self.assertIn("TCP 7881, UDP 7882", " ".join(s["lines"]))

    def test_double_nat_opened_needs_forwards_on_both(self):
        p = ports([m("TCP", 443, ok=True)], kind="double-nat")
        s = reach.summary(p, {"ok": False, "results": {"tls443": {"ok": False, "why": "unreachable"}}})
        self.assertIn("provider's box", " ".join(s["lines"]))
        self.assertIn("Forward TCP port 443 to 10.90.0.187, port 443", s["fix"])

    def test_good_and_cgnat(self):
        self.assertEqual(reach.summary(ports([]), {"ok": True})["level"], "good")
        self.assertIn("carrier NAT", " ".join(reach.summary(ports([], kind="cgnat"), {"ok": False})["lines"]))

    def test_direct_has_no_router_advice(self):
        p = {"kind": "direct", "method": None, "lan_ip": "11.91.0.121", "mapped": []}
        s = reach.summary(p, {"ok": False, "results": dict(FAIL, tls443={"ok": True})})
        text = " ".join(s["lines"])
        self.assertEqual(s["level"], "warn")
        self.assertIn("no router to open", text)
        self.assertNotIn("didn't answer", text)
        self.assertEqual(s["fix"], [])

    def test_certificate_not_counted_as_blocked(self):
        res = {"tls443": {"ok": False, "why": "certificate"}}
        s = reach.summary(ports([m("TCP", 443, ok=True)]), {"ok": False, "results": res})
        self.assertIn("certificate isn't valid yet", " ".join(s["lines"]))
        self.assertNotIn("don't reach your server", " ".join(s["lines"]))


if __name__ == "__main__":
    unittest.main()

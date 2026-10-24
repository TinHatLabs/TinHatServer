"""The relay's pure logic: checking places, the nftables ruleset, HAProxy's map, and traffic accounting.
    python3 -m unittest discover -s relay/tests
"""
import base64
import os
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_relay import config as config_mod  # noqa: E402
from tinhat_relay import render  # noqa: E402

CFG = config_mod.finish({**config_mod.DEFAULTS, "public_ip": "11.91.0.50", "control_allow": ["11.91.0.10/32"],
                         "capacity": 3})


def key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def place(name="crew", ip="100.96.0.2", port=20001, **kw):
    return {"name": name, "fqdn": f"{name}.tinhat.me", "public_key": kw.pop("public_key", key()), "tunnel_ip": ip,
            "port": port, **kw}


class Places(unittest.TestCase):
    def test_config_fills_in_the_relay_side(self):
        self.assertEqual(CFG["tunnel_ip"], "100.96.0.1")
        self.assertEqual(CFG["control_listen"], "11.91.0.50:8443")
        with self.assertRaises(ValueError):
            config_mod.finish({**config_mod.DEFAULTS, "public_ip": "11.91.0.50", "ports": [40000, 40999]})

    def test_good_place_is_cleaned(self):
        p = render.check_place(place(name="Crew", web=1), CFG)
        self.assertEqual(p["name"], "crew")
        self.assertIs(p["web"], True)
        self.assertIs(p["calls"], True)

    def test_bad_places_are_refused(self):
        bad = [place(public_key="not-a-key"), place(ip="100.96.0.1"), place(ip="10.0.0.2"), place(port=30000),
               place(ip="100.96.255.255"), {**place(), "fqdn": "evil.example.com"}, place(name="-x-")]
        for p in bad:
            with self.assertRaises(render.PlaceError, msg=str(p)):
                render.check_place(p, CFG)

    def test_no_two_places_share_anything(self):
        a = place("crew", "100.96.0.2", 20001)
        for clash in (place("crew", "100.96.0.3", 20002), place("squad", "100.96.0.2", 20002),
                      place("squad", "100.96.0.3", 20001), place("squad", "100.96.0.3", 20002, public_key=a["public_key"])):
            with self.assertRaises(render.PlaceError):
                render.check_places([a, clash], CFG)
        self.assertEqual(len(render.check_places([a, place("squad", "100.96.0.3", 20002)], CFG)), 2)

    def test_capacity(self):
        ps = [place(f"srv{i}x", f"100.96.0.{i + 2}", 20001 + i) for i in range(4)]
        with self.assertRaises(render.PlaceError):
            render.check_places(ps, CFG)


class Ruleset(unittest.TestCase):
    def setUp(self):
        self.places = render.check_places([place("crew", "100.96.0.2", 20001),
                                           place("squad", "100.96.0.3", 20002, calls=False),
                                           place("gone-quiet", "100.96.0.4", 20003, web=False, calls=False)], CFG)

    def test_call_ports_go_into_the_tunnel_only_for_places_with_calls(self):
        nft = render.nft_ruleset(CFG, self.places)
        self.assertIn('iifname "eth0" ip daddr 11.91.0.50 udp dport 20001 dnat ip to 100.96.0.2', nft)
        self.assertIn('iifname "eth0" ip daddr 11.91.0.50 tcp dport 20001 dnat ip to 100.96.0.2', nft)
        self.assertNotIn("dport 20002", nft)
        self.assertNotIn("dport 20003", nft)
        self.assertIn('oifname "wg0" ct status dnat snat ip to 100.96.0.1', nft)
        self.assertIn("counter name p_crew_udp_in", nft)

    def test_firewall_shape(self):
        nft = render.nft_ruleset(CFG, self.places)
        self.assertTrue(nft.splitlines()[1:3] == ["table inet tinhat_relay", "delete table inet tinhat_relay"])
        fwd = nft.split("chain forward {")[1].split("}")[0]
        # forwarding: only replies, and new flows from outside into the tunnel that the call-port DNAT made
        self.assertIn("policy drop", fwd)
        self.assertNotIn('iifname "wg0" accept', fwd)
        self.assertIn('ip saddr { 11.91.0.10/32 } tcp dport 8443 accept', nft)

    def test_sni_map_lists_only_web_places(self):
        m = render.sni_map(self.places)
        self.assertIn("crew.tinhat.me 100.96.0.2", m)
        self.assertIn("squad.tinhat.me 100.96.0.3", m)
        self.assertNotIn("gone-quiet", m)

    def test_counter_names_are_nft_identifiers(self):
        self.assertEqual(render.counter_name("2-crew", "udp_in"), "p_2_crew_udp_in")


class Accounting(unittest.TestCase):
    def test_counts_survive_peer_and_ruleset_restarts(self):
        p = render.check_places([place("crew", "100.96.0.2", 20001)], CFG)
        k = p[0]["public_key"]
        usage = {}
        render.accumulate(usage, p, {k: {"rx": 100, "tx": 50, "handshake": 7}}, {"p_crew_udp_in": 10})
        render.accumulate(usage, p, {k: {"rx": 300, "tx": 80, "handshake": 9}}, {"p_crew_udp_in": 25})
        self.assertEqual((usage["crew"]["rx"], usage["crew"]["tx"]), (300, 80))
        # the peer was re-added (its counters start at 0 again) and the ruleset was replaced
        render.counters_restart(usage)
        render.accumulate(usage, p, {k: {"rx": 40, "tx": 5, "handshake": 11}}, {"p_crew_udp_in": 4})
        self.assertEqual((usage["crew"]["rx"], usage["crew"]["tx"]), (340, 85))
        self.assertEqual(usage["crew"]["calls"]["udp_in"], 29)
        pub = render.public_usage(usage, ["crew"])
        self.assertEqual(pub["crew"]["bytes"], 425)
        self.assertNotIn("key", pub["crew"])

    def test_a_new_key_starts_from_zero(self):
        p1 = render.check_places([place("crew", "100.96.0.2", 20001)], CFG)
        usage = {}
        render.accumulate(usage, p1, {p1[0]["public_key"]: {"rx": 1000, "tx": 1000}}, {})
        p2 = [dict(p1[0], public_key=key())]
        render.accumulate(usage, p2, {p2[0]["public_key"]: {"rx": 10, "tx": 20}}, {})
        self.assertEqual(usage["crew"]["rx"] + usage["crew"]["tx"], 2030)


if __name__ == "__main__":
    unittest.main()

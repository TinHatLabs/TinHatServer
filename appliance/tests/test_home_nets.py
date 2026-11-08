"""What counts as the box's own home network over IPv6 (hw.ipv6_nets, round 3 security review RN-4): never more than a
/64, and an address of its own (/128) counts its /64 only when the kernel reaches that /64 directly on the interface.
    python3 -m unittest discover -s appliance/tests
"""
import ipaddress
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import hw, limits  # noqa: E402


def fake_ip(addrs: str, routes: dict):
    def run(cmd, **_kw):
        if cmd[:3] == ["ip", "-6", "-o"] and cmd[3] == "addr":
            return subprocess.CompletedProcess(cmd, 0, addrs, "")
        if cmd[:5] == ["ip", "-6", "-o", "route", "show"]:
            return subprocess.CompletedProcess(cmd, 0, routes.get(cmd[-1], ""), "")
        raise AssertionError(cmd)
    return run


def nets(addrs, routes=None):
    with mock.patch.object(hw.subprocess, "run", fake_ip(addrs, routes or {})):
        return hw.ipv6_nets()


N = ipaddress.ip_network


class HomeNets(unittest.TestCase):
    def test_a_slash_48_counts_only_its_own_slash_64(self):
        got = nets("2: eth0    inet6 2001:db8:aa::10/48 scope global \\       valid_lft forever\n",
                   {"eth0": "2001:db8:aa::/48 proto kernel metric 256 pref medium\n"})
        self.assertEqual(got, [N("2001:db8:aa::/64")])
        self.assertFalse(limits.home("2001:db8:aa:1::5", got), "a neighbour elsewhere in the /48 isn't home")
        self.assertTrue(limits.home("2001:db8:aa::99", got))

    def test_a_slash_128_with_an_onlink_slash_64_is_home_dhcpv6(self):
        got = nets("2: eth0    inet6 2001:db8:1::abcd/128 scope global dynamic\n",
                   {"eth0": "2001:db8:1::abcd proto kernel metric 256\n2001:db8:1::/64 proto ra metric 100 pref medium\n"
                            "default via fe80::1 proto ra metric 100\n"})
        self.assertEqual(got, [N("2001:db8:1::/64")])
        self.assertTrue(limits.home("2001:db8:1::77", got), "the phone on the same home network")

    def test_a_slash_128_without_one_is_just_itself_vps(self):
        got = nets("2: eth0    inet6 2001:db8:5::7/128 scope global\n",
                   {"eth0": "2001:db8:5::7 proto kernel metric 256\ndefault via 2001:db8:5::1 metric 1024 onlink\n"})
        self.assertEqual(got, [N("2001:db8:5::7/128")])
        self.assertFalse(limits.home("2001:db8:5::8", got), "a neighbour on the provider's network isn't home")

    def test_a_route_through_a_gateway_doesnt_count_as_onlink(self):
        got = nets("2: eth0    inet6 2001:db8:6::7/128 scope global\n", {"eth0": "2001:db8:6::/64 via 2001:db8:6::1 metric 1\n"})
        self.assertEqual(got, [N("2001:db8:6::7/128")])

    def test_routes_that_dont_prove_a_direct_network(self):
        addr = "2: eth0    inet6 2001:db8:6::7/128 scope global\n"
        for route in ("2001:db8:6::/64 nhid 10 proto static metric 100 pref medium\n",
                      "2001:db8:6::/64 proto static metric 100 \\\tnexthop via fe80::1 dev eth0 weight 1 \\\tnexthop dev eth0 weight 1\n",  # ip -o: one line
                      "local 2001:db8:6::/64 proto kernel metric 0\n",
                      "2001:db8:6::/64 encap seg6 mode encap segs 1 [ 2001:db8:42::1 ] metric 1024 pref medium\n",
                      "2001:db8:6::/64 nexthop dev eth0 weight 1 nexthop dev eth1 weight 1\n",
                      "2001:db8:6::/64 proto static metric 100 something-new 1\n",
                      "unreachable 2001:db8:6::/64 metric 1024\n"):
            self.assertEqual(nets(addr, {"eth0": route}), [N("2001:db8:6::7/128")], route)

    def test_a_route_on_another_interface_or_another_prefix_doesnt_count(self):
        addr = "2: eth0    inet6 2001:db8:7::7/128 scope global\n"
        self.assertEqual(nets(addr, {"eth1": "2001:db8:7::/64 proto ra\n"}), [N("2001:db8:7::7/128")])
        self.assertEqual(nets(addr, {"eth0": "2001:db8:8::/64 proto ra\n"}), [N("2001:db8:7::7/128")])

    def test_slaac_slash_64_and_slash_127(self):
        self.assertEqual(nets("2: eth0    inet6 2001:db8:3::5/64 scope global dynamic mngtmpaddr\n",
                              {"eth0": "2001:db8:3::/64 proto ra metric 100\n"}), [N("2001:db8:3::/64")])
        self.assertEqual(nets("2: eth0    inet6 2001:db8:4::1/127 scope global\n", {"eth0": "2001:db8:4::/127 proto kernel\n"}),
                         [N("2001:db8:4::/127")], "a point-to-point /127 with no /64 on-link stays itself")
        self.assertEqual(nets("2: eth0    inet6 2001:db8:4::1/127 scope global\n", {"eth0": "2001:db8:4::/48 proto kernel\n"}),
                         [N("2001:db8:4::/64")], "an on-link /48: still only its /64")

    def test_slash_65_and_slash_128_with_a_direct_slash_48(self):
        self.assertEqual(nets("2: eth0    inet6 2001:db8:a::5/65 scope global\n", {"eth0": "2001:db8:a::/64 proto ra metric 100 expires 86000sec pref medium\n"}),
                         [N("2001:db8:a::/64")], "a /65 inside an advertised /64")
        self.assertEqual(nets("2: eth0    inet6 2001:db8:b::5/128 scope global\n", {"eth0": "2001:db8:b::/48 dev eth0 proto kernel metric 256 pref medium\n"}),
                         [N("2001:db8:b::/64")], "a direct /48: only its /64")

    def test_the_ip_tool_failing_means_nothing_is_home(self):
        def boom(cmd, **_kw):
            raise subprocess.TimeoutExpired(cmd, 3)
        with mock.patch.object(hw.subprocess, "run", boom):
            self.assertEqual(hw.ipv6_nets(), [])

    def test_container_interfaces_still_skipped(self):
        self.assertEqual(nets("5: docker0    inet6 2001:db8:9::1/64 scope global\n"), [])

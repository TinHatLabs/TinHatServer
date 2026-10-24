"""Wrong tries are counted per caller (an IPv4 address, an IPv6 /64): a stranger guessing locks out only themselves,
never the owner; many callers together hit a higher ceiling, which never applies to the home network (Caddy's private
ranges and the box's own IPv6 networks, nothing else); a try counts the moment it starts and is taken back when right;
checks stay cheap and memory bounded however many callers there are. And the caller's address is read from
X-Forwarded-For the way Caddy builds it, so nothing a caller writes into the header counts.

Runs anywhere (limits.py imports nothing of the manager).
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import ipaddress
import pathlib
import time
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/limits.py"
spec = importlib.util.spec_from_file_location("tinhat_limits", PATH)
limits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(limits)

# Public addresses (the lab's fake internet): Python counts the documentation ranges (203.0.113.0/24 …) as private.
OWNER, STRANGER, HOME = "11.90.1.7", "11.90.2.9", "192.168.1.20"


class PerCaller(unittest.TestCase):
    def test_a_stranger_guessing_locks_out_only_themselves(self):
        f = limits.Fails("login")
        for _ in range(8):
            self.assertFalse(f.limited("login", STRANGER, 300, 8))
            f.failed("login", STRANGER)
        self.assertTrue(f.limited("login", STRANGER, 300, 8))
        self.assertFalse(f.limited("login", OWNER, 300, 8))
        self.assertFalse(f.limited("login", HOME, 300, 8))

    def test_many_callers_together_hit_the_overall_ceiling_but_never_at_home(self):
        f = limits.Fails("login")
        for i in range(limits.OVERALL * 8):
            f.failed("login", f"11.90.3.{i}")
        self.assertTrue(f.limited("login", OWNER, 300, 8))
        self.assertFalse(f.limited("login", HOME, 300, 8))
        self.assertFalse(f.limited("login", "127.0.0.1", 300, 8))
        # behind the owner's own proxy "home" is only what a header says: no exemption there
        self.assertTrue(f.limited("login", HOME, 300, 8, trust_home=False))

    def test_where_guessing_is_hopeless_the_ceiling_is_far_higher_but_still_there(self):
        # "Continue as …" (a session token): many strangers can't block it, nor make unbounded work
        f = limits.Fails("login")
        for i in range(limits.OVERALL * 8):
            f.failed("login", f"11.90.3.{i}")
        self.assertFalse(f.limited("login", OWNER, 300, 8, overall=False))
        for i in range((limits.HARD - limits.OVERALL) * 8):
            f.failed("login", f"11.91.{i // 250}.{i % 250}")
        self.assertTrue(f.limited("login", OWNER, 300, 8, overall=False))
        self.assertFalse(f.limited("login", HOME, 300, 8, overall=False))

    def test_an_ipv6_caller_is_its_64(self):
        f = limits.Fails("unlock")
        for i in range(10):
            f.failed("unlock", f"2a01:4f8:1:2::{i + 1:x}")  # rotating inside one /64 buys nothing
        self.assertTrue(f.limited("unlock", "2a01:4f8:1:2:dead:beef::1", 600, 10))
        self.assertFalse(f.limited("unlock", "2a01:4f8:1:3::1", 600, 10))
        self.assertEqual(limits.key("::ffff:11.90.1.7"), OWNER)  # IPv4-mapped is the IPv4 address

    def test_tries_age_out(self):
        f = limits.Fails("unlock")
        with mock.patch.object(limits.time, "monotonic", return_value=1000.0):
            for _ in range(10):
                f.failed("unlock", STRANGER)
            self.assertTrue(f.limited("unlock", STRANGER, 600, 10))
        with mock.patch.object(limits.time, "monotonic", return_value=1601.0):
            self.assertFalse(f.limited("unlock", STRANGER, 600, 10))
            self.assertEqual(f.count("unlock"), 0)
            self.assertEqual(len(f.by_caller["unlock"]), 0)

    def test_a_right_try_is_taken_back(self):
        f = limits.Fails("login")
        for _ in range(7):
            f.failed("login", STRANGER)
        f.failed("login", STRANGER)  # counted when it started…
        f.forgive("login", STRANGER)  # …and it was right
        self.assertFalse(f.limited("login", STRANGER, 300, 8))
        self.assertEqual(f.count("login"), 7)
        f.forgive("login", OWNER)  # nothing to take back: harmless
        self.assertEqual(f.count("login"), 7)

    def test_memory_is_bounded(self):
        f = limits.Fails("login")
        with mock.patch.object(limits, "MAX_CALLERS", 100):
            for i in range(1000):
                f.failed("login", f"11.92.{i // 250}.{i % 250}")
            self.assertEqual(len(f.by_caller["login"]), 100)

    def test_checks_stay_cheap_under_a_flood(self):
        f = limits.Fails("login")
        for i in range(4000):
            f.failed("login", f"2a01:4f8:{i:x}::1")
        t = time.perf_counter()
        for _ in range(1000):
            f.limited("login", OWNER, 300, 8, overall=False)
        self.assertLess((time.perf_counter() - t) / 1000, 0.0005)  # well under a millisecond each


class Home(unittest.TestCase):
    def test_caddys_private_ranges_and_nothing_else(self):
        for ip in (HOME, "10.1.2.3", "172.16.0.9", "127.0.0.1", "::1", "fd00::5", "::ffff:192.168.1.5"):
            self.assertTrue(limits.home(ip), ip)
        for ip in (OWNER, STRANGER, "100.64.0.1", "2606:4700::1111", "", "junk", "169.254.169.254", "fe80::1",
                   "2002:b5a:101::1",   # 6to4: reachable from the internet (Python's is_private says yes)
                   "2001:0:4136:e378:8000:63bf:3fff:fdd2"):  # Teredo, likewise
            self.assertFalse(limits.home(ip), ip)

    def test_the_boxs_own_ipv6_network(self):
        own = [ipaddress.ip_network("2601:600:a:b::/64")]
        self.assertTrue(limits.home("2601:600:a:b:1c2d:3e4f:5a6b:7c8d", own))
        self.assertFalse(limits.home("2601:600:a:c::1", own))
        self.assertFalse(limits.home("2601:600:a:b::1"))


class CallerAddress(unittest.TestCase):
    def test_caddy_alone(self):
        # Caddy replaces the header with its caller's address: one entry.
        self.assertEqual(limits.client(STRANGER, "127.0.0.1", lambda: None), STRANGER)
        self.assertEqual(limits.client("", "127.0.0.1", lambda: None), "127.0.0.1")  # the box itself
        # More than one entry can't come from Caddy here; the rightmost is the one Caddy wrote.
        self.assertEqual(limits.client(f"{HOME}, {STRANGER}", "127.0.0.1", lambda: None), STRANGER)

    def test_behind_the_owners_proxy(self):
        # Caddy extends the owner's proxy's header with the proxy's own (home) address.
        self.assertEqual(limits.client(f"{STRANGER}, 192.168.1.5", "127.0.0.1", lambda: set()), STRANGER)
        # A stranger writing a home address into the header gets nothing for it.
        self.assertEqual(limits.client(f"192.168.1.9, {STRANGER}, 192.168.1.5", "127.0.0.1", lambda: set()), STRANGER)
        self.assertFalse(limits.home(limits.client(f"10.0.0.1, {STRANGER}, 192.168.1.5", "127.0.0.1", lambda: set())))
        # Someone at home, through the proxy: the address the proxy saw.
        self.assertEqual(limits.client(f"10.9.9.9, {HOME}, 192.168.1.5", "127.0.0.1", lambda: set()), HOME)
        # A proxy on this same machine connects from the machine's own public address, which Caddy trusts too.
        self.assertEqual(limits.client(f"10.0.0.1, {STRANGER}, 11.90.4.4", "127.0.0.1", lambda: {"11.90.4.4"}),
                         STRANGER)

    def test_what_isnt_an_address_is_skipped(self):
        # ports a proxy may keep, brackets, junk a caller wrote
        self.assertEqual(limits.client(f"{STRANGER}:51234", "127.0.0.1", lambda: None), STRANGER)
        self.assertEqual(limits.client("[2a01:4f8::1]:443", "127.0.0.1", lambda: None), "2a01:4f8::1")
        self.assertEqual(limits.client(f"junk-1, {STRANGER}, 192.168.1.5", "127.0.0.1", lambda: set()), STRANGER)
        self.assertEqual(limits.client("junk-1", "127.0.0.1", lambda: None), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()

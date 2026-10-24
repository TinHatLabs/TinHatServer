"""Who is calling: X-Forwarded-For is read from the right, past the proxies we trust, so a caller can't name someone
else's address (probe-open connects to it). Runs anywhere:  python3 -m unittest discover -s names/tests
"""
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    from tinhat_names.app import Service
except ImportError:  # no aiohttp here
    Service = None


def call(cfg, remote, xff=None, real=None):
    req = types.SimpleNamespace(remote=remote, headers={k: v for k, v in (("X-Forwarded-For", xff), ("X-Real-IP", real)) if v})
    svc = object.__new__(Service)
    svc.cfg = cfg
    return Service.client_ip(svc, req)


@unittest.skipUnless(Service, "needs aiohttp")
class ClientIP(unittest.TestCase):
    CFG = {"trust_proxy": True, "trusted_proxies": ["127.0.0.1", "10.0.0.2"]}

    def test_two_proxies(self):  # caller → the front proxy (10.0.0.2) → local nginx → us
        self.assertEqual(call(self.CFG, "127.0.0.1", "203.0.113.7, 10.0.0.2"), "203.0.113.7")

    def test_a_caller_cant_name_someone_else(self):
        self.assertEqual(call(self.CFG, "127.0.0.1", "198.51.100.9, 203.0.113.7, 10.0.0.2"), "203.0.113.7")

    def test_untrusted_peer_is_the_caller(self):
        self.assertEqual(call(self.CFG, "203.0.113.7", "198.51.100.9"), "203.0.113.7")

    def test_off(self):
        self.assertEqual(call({"trust_proxy": False}, "127.0.0.1", "198.51.100.9"), "127.0.0.1")

    def test_one_local_proxy_default(self):
        self.assertEqual(call({"trust_proxy": True}, "127.0.0.1", "203.0.113.7"), "203.0.113.7")
        self.assertEqual(call({"trust_proxy": True}, "127.0.0.1", None, "203.0.113.8"), "203.0.113.8")


@unittest.skipUnless(Service, "needs aiohttp")
class Hairpin(unittest.TestCase):
    """A server on this service's own network comes in through the router's NAT loopback."""
    CFG = {"trust_proxy": True, "trusted_proxies": ["127.0.0.1"], "hairpin_from": ["192.168.1.1"]}

    def svc(self, cfg):
        s = object.__new__(Service)
        s.cfg = cfg
        return s

    def test_off_by_default(self):
        self.assertEqual(call({"trust_proxy": True}, "127.0.0.1", "192.168.1.1"), "192.168.1.1")

    def test_router_address_becomes_the_public_one(self):
        cfg = {**self.CFG, "hairpin_public": "11.91.0.3"}
        self.assertEqual(call(cfg, "127.0.0.1", "192.168.1.1"), "11.91.0.3")
        self.assertEqual(call(cfg, "127.0.0.1", "11.91.0.9"), "11.91.0.9")  # everyone else: as before
        self.assertEqual(call(cfg, "127.0.0.1", "192.168.1.7"), "192.168.1.7")  # only the router's own address
        self.assertFalse(self.svc(cfg).hairpin_unknown("192.168.1.1"))

    def test_never_a_private_multicast_or_v6_mapping(self):
        for bad in ("10.0.0.5", "224.0.0.1", "2001:4860::8888", "100.64.0.2"):
            s = self.svc({**self.CFG, "hairpin_public": bad})
            self.assertEqual(s.hairpin("192.168.1.1"), "192.168.1.1", bad)
            self.assertTrue(s.hairpin_unknown("192.168.1.1"), bad)  # the handlers refuse it (503) instead

    def test_a_name_resolved_in_the_background_keeps_the_last_good_answer(self):
        import asyncio
        from unittest import mock
        import socket
        s = self.svc({**self.CFG, "hairpin_public": "public.example"})
        self.assertTrue(s.hairpin_unknown("192.168.1.1"))  # nothing resolved yet: refused, never the router itself
        with mock.patch.object(socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("224.0.0.9", 0)), (2, 1, 6, "", ("11.91.0.3", 0))]):
            self.assertEqual(asyncio.run(s.resolve_hairpin()), "11.91.0.3")
        s._hairpin_public = "11.91.0.3"
        self.assertEqual(s.hairpin("192.168.1.1"), "11.91.0.3")
        with mock.patch.object(socket, "getaddrinfo", side_effect=OSError("no DNS")):
            self.assertIsNone(asyncio.run(s.resolve_hairpin()))
        self.assertEqual(s.hairpin("192.168.1.1"), "11.91.0.3")  # a failed lookup doesn't undo the last good one


if __name__ == "__main__":
    unittest.main()

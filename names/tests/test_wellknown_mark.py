"""What marks a Tin Hat server for the names service: its /.well-known/matrix/client carries the offer under
`dev.tinhat.server` (the weekly still-a-Tin-Hat-server check and "Move to your own domain" both look for it), and a
moved server lists its former names in `dev.tinhat.moved_from`. The network is faked; runs without aiohttp."""
import asyncio
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names import probe  # noqa: E402

OFFER = {"server": "0.3.1", "api": "https://crew.example.org/api", "features": {"calls": True}}


def answer(doc, status=200):
    async def get(ip, host, path, ctx, timeout):
        assert path == "/.well-known/matrix/client"
        return status, json.dumps(doc).encode()
    return get


class Mark(unittest.TestCase):
    def test_only_the_offer_under_its_key_marks_a_server(self):
        self.assertTrue(probe._is_tinhat({"m.homeserver": {"base_url": "https://x"}, "dev.tinhat.server": OFFER}))
        self.assertTrue(probe._is_tinhat({"dev.tinhat.server": {}}))
        for doc in ({}, {"m.homeserver": {"base_url": "https://x"}}, {"dev.tinhat.server": "yes"},
                    {"dev.tinhat.server": None}, {"tinhat": OFFER}, [], "dev.tinhat.server", None):
            self.assertFalse(probe._is_tinhat(doc), doc)

    def test_still_tinhat(self):
        with mock.patch.object(probe, "_https_get", answer({"dev.tinhat.server": OFFER})):
            self.assertEqual(asyncio.run(probe.still_tinhat("192.0.2.1", "crew.tinhat.me", None, 1)), "yes")
        with mock.patch.object(probe, "_https_get", answer({"m.homeserver": {"base_url": "https://x"}})):
            self.assertEqual(asyncio.run(probe.still_tinhat("192.0.2.1", "crew.tinhat.me", None, 1)), "no")
        with mock.patch.object(probe, "_https_get", answer({"dev.tinhat.server": OFFER}, 404)):
            self.assertEqual(asyncio.run(probe.still_tinhat("192.0.2.1", "crew.tinhat.me", None, 1)), "no")

    def test_moved_here_needs_the_former_name_listed(self):
        loop_addr = [(2, 1, 6, "", ("1.2.3.4", 443))]  # a public address (the stand-in the other tests use)

        async def resolve(*a, **k):
            return loop_addr

        def run(doc):
            async def go():
                with mock.patch.object(asyncio.get_running_loop(), "getaddrinfo", resolve), \
                        mock.patch.object(probe, "_https_get", answer(doc)):
                    return await probe.moved_here("chat.example.com", "crew.tinhat.me", None, 1)
            return asyncio.run(go())

        self.assertIsNone(run({"dev.tinhat.server": OFFER, "dev.tinhat.moved_from": ["crew.tinhat.me"]}))
        self.assertIn("doesn't say it was", run({"dev.tinhat.server": OFFER, "dev.tinhat.moved_from": ["other.tinhat.me"]}))
        self.assertIn("doesn't say it was", run({"dev.tinhat.server": OFFER}))
        self.assertIn("doesn't answer as a Tin Hat server", run({"dev.tinhat.moved_from": ["crew.tinhat.me"]}))


if __name__ == "__main__":
    unittest.main()

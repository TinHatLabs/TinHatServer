"""The game-servers card (gameservers.py): what it writes must be what the API's parseConfig accepts (the API's test
parses test/fixtures/gameservers-dashboard.json, which this test checks build() still produces), it keeps what a
hand-written file had, and it refuses what the API would refuse."""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

os.environ.setdefault("TINHAT_OPT", tempfile.mkdtemp())
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat" / "manager"))
try:
    import aiohttp  # noqa: F401
except ImportError:
    _aio = types.ModuleType("aiohttp")
    _aio.ClientSession = _aio.ClientTimeout = object
    _aio.ClientError = Exception
    sys.modules["aiohttp"] = _aio
from tinhat import gameservers as gs  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "api" / "tinhat-api" / "test" / "fixtures" / "gameservers-dashboard.json"
U1, U2 = "11111111-2222-3333-4444-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
HAND = {"v": 1, "_about": "written by hand", "space": "!old:example.org", "joinHost": "old.example.org", "cap": 3,
        "memoryBudgetMB": 20480, "hostCores": 8, "panel": {"url": "http://10.0.0.5", "wings": "ws://10.0.0.5:8080",
        "origin": "https://panel.example.org"},
        "servers": [{"uuid": U1, "kind": "valheim", "game": "Valheim", "steamAppId": 892970, "emoji": "x", "calendar": False}]}
BODY = {"url": "https://panel.example.org/", "wings": "wss://node.example.org:8080/api/servers/x/ws", "origin": "",
        "joinHost": "Games.Example.org", "space": "!space:example.org",
        "servers": [{"uuid": U1, "kind": "valheim", "game": "Valheim", "info": "Be nice", "outside": True},
                    {"uuid": U2, "kind": "nope", "game": "Terraria", "joinPasswordText": "sample-join-pw"}]}


class Build(unittest.TestCase):
    def test_matches_the_fixture_the_api_parses(self):
        got = gs.build(BODY, HAND)
        self.assertEqual(got, json.loads(FIXTURE.read_text()))

    def test_keeps_what_the_card_doesnt_show(self):
        got = gs.build(BODY, HAND)
        self.assertEqual((got["cap"], got["memoryBudgetMB"], got["hostCores"], got["_about"]), (3, 20480, 8, "written by hand"))
        v = got["servers"][0]
        self.assertEqual((v["steamAppId"], v["emoji"], v["calendar"]), (892970, "x", False))
        self.assertEqual(got["panel"], {"url": "https://panel.example.org", "wings": "wss://node.example.org:8080",
                                        "origin": "https://panel.example.org"})
        self.assertEqual(got["servers"][1]["kind"], "other")  # an unknown kind is "another game"

    def test_refusals(self):
        bad = [({"joinHost": "games.example.org:2456"}, "address players type"), ({"space": "general"}, "space"),
               ({"url": "ftp://x"}, "panel's address"), ({"wings": ""}, "Wings"), ({"servers": []}, "between 1 and 32"),
               ({"servers": [{"uuid": "x", "game": "a"}]}, "valid id"),
               ({"servers": [{"uuid": U1, "kind": "valheim", "game": "V", "joinPasswordText": "pw"}]}, "join password"),
               ({"servers": [{"uuid": U1, "game": "a\nb"}]}, "game's name"),
               ({"servers": [{"uuid": U1, "game": "ok", "info": "x‮y"}]}, "plain text")]
        for change, words in bad:
            with self.assertRaises(gs.GameServersError, msg=change) as e:
                gs.build({**BODY, **change}, {})
            self.assertIn(words, str(e.exception))

    def test_kind_guess(self):
        for words, kind in ((("Valheim Vanilla",), "valheim"), (("x", "Project Zomboid"), "pz"), (("Skies", "Forge"), "minecraft"),
                            (("PaperMC",), "minecraft"), (("Terraria",), "other"), ((None, "", "ghcr.io/parkervcp/games:palworld"), "palworld")):
            self.assertEqual(gs.guess_kind(*words), kind, words)

    def test_origins(self):
        self.assertEqual(gs.origin_of("https://panel.example.org/path?q"), "https://panel.example.org")
        self.assertEqual(gs.origin_of("ws://10.0.0.5:8080/x"), "ws://10.0.0.5:8080")
        self.assertEqual(gs.origin_of("https://user:pw@panel.example.org/"), "https://panel.example.org")  # never credentials
        for bad in ("", "panel.example.org", "javascript:alert(1)", "https://pa nel.example.org"):
            self.assertIsNone(gs.origin_of(bad), bad)


class ReviewG2(unittest.TestCase):
    """Astra's review of the card (out/astra/review-G2.txt)."""

    def test_saved_key_only_for_its_own_panel(self):
        import asyncio
        gs.apiconf.ensure_dirs = lambda: None
        gs.CONFIG.parent.mkdir(parents=True, exist_ok=True)
        gs.CONFIG.write_text(json.dumps({"panel": {"url": "https://panel.example.org"}}))
        gs.KEY.write_text("pacc_" + "s" * 20 + "\n")
        asked = []

        async def fake(base, key, path):
            asked.append((base, key))
            return {"data": []}
        orig = gs._panel_get
        gs._panel_get = fake
        try:
            with self.assertRaises(gs.GameServersError) as e:
                asyncio.run(gs.discover("https://attacker.example", None))
            self.assertIn("only ever used with the panel it was saved for", str(e.exception))
            self.assertEqual(asked, [])  # nothing was sent anywhere
            with self.assertRaises(gs.GameServersError):  # the same panel: the key is used (and it sees no servers)
                asyncio.run(gs.discover("https://panel.example.org/", None))
            self.assertEqual(asked[0], ("https://panel.example.org", "pacc_" + "s" * 20))
            with self.assertRaises(gs.GameServersError) as e:  # saving for another panel without a new key: refused
                gs.save({**BODY, "url": "https://other.example.org"})
            self.assertIn("saved for", str(e.exception))
        finally:
            gs._panel_get = orig
            gs.CONFIG.unlink(missing_ok=True)
            gs.KEY.unlink(missing_ok=True)

    def test_test_overrides_only_while_the_space_stays(self):
        hand = {**HAND, "test": [{"users": ["@a:example.org"], "space": "!t:example.org"}]}
        self.assertIn("test", gs.build({**BODY, "space": "!old:example.org"}, hand))
        self.assertNotIn("test", gs.build(BODY, hand))  # a new space: nobody keeps access through an override

    def test_lengths_as_javascript_counts_them(self):
        emoji = "\U0001F3AE" * 33  # 33 characters in Python, 66 UTF-16 units in JavaScript
        with self.assertRaises(gs.GameServersError):
            gs.build({**BODY, "servers": [{"uuid": U1, "kind": "valheim", "game": emoji}]}, {})
        long_label = {**HAND, "servers": [{**HAND["servers"][0], "label": "x" * 65}]}
        with self.assertRaises(gs.GameServersError) as e:
            gs.build(BODY, long_label)
        self.assertIn("display name", str(e.exception))
        self.assertIsNone(gs.origin_of("https://" + "a" * 195 + ".example.org"))  # > 200: the API's limit

    def test_password_kept_exactly(self):
        got = gs.build({**BODY, "servers": [{"uuid": U2, "kind": "other", "game": "Terraria", "joinPasswordText": " pass "}]}, {})
        self.assertEqual(got["servers"][0]["joinPasswordText"], " pass ")

    def test_addresses(self):
        self.assertIsNone(gs.origin_of("https://panel.example.org:99999"))  # no exception
        with self.assertRaises(gs.GameServersError) as e:
            gs.build({**BODY, "origin": "not a url"}, {})
        self.assertIn("public address", str(e.exception))


class Discover(unittest.TestCase):
    """The panel's answer (Pelican's client API shape) → what the card offers; the Wings origin from a websocket ticket."""

    def test_parses_the_panels_list(self):
        import asyncio
        calls = []

        async def fake(base, key, path):
            calls.append((base, path))
            if path.startswith("/api/client?"):
                return {"data": [
                    {"attributes": {"uuid": U1, "identifier": "11111111", "name": "Valheim Vanilla", "docker_image": "ghcr.io/x/games:valheim",
                                    "relationships": {"egg": {"attributes": {"name": "Valheim"}},
                                                      "allocations": {"data": [{"attributes": {"ip": "10.0.0.9", "ip_alias": "games.example.org", "port": 2456, "is_default": True}}]}}}},
                    {"attributes": {"uuid": "not-a-uuid", "name": "broken"}},
                    {"attributes": {"uuid": U2, "identifier": "aaaaaaaa", "name": "Terraria", "relationships": {}}}]}
            return {"data": {"token": "t", "socket": "wss://node.example.org:8080/api/servers/" + U1 + "/ws"}}

        orig = gs._panel_get
        gs._panel_get = fake
        try:
            got = asyncio.run(gs.discover("https://panel.example.org/x", "pacc_" + "a" * 20))
        finally:
            gs._panel_get = orig
        self.assertEqual(got["url"], "https://panel.example.org")
        self.assertEqual(got["wings"], "wss://node.example.org:8080")
        self.assertEqual([(s["uuid"], s["kind"], s["address"], s["port"]) for s in got["servers"]],
                         [(U1, "valheim", "games.example.org", 2456), (U2, "other", "", None)])
        self.assertEqual(calls[0], ("https://panel.example.org", "/api/client?per_page=100&include=egg"))

    def test_refuses_bad_input_before_asking(self):
        import asyncio
        for url, key, words in (("panel.example.org", "pacc_" + "a" * 20, "panel's address"), ("ws://x:8080", "pacc_" + "a" * 20, "panel's address"),
                                ("https://p.example.org", "has space in it", "API key")):
            with self.assertRaises(gs.GameServersError) as e:
                asyncio.run(gs.discover(url, key))
            self.assertIn(words, str(e.exception))


if __name__ == "__main__":
    unittest.main()

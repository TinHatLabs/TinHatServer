"""The Tin Hat API's configuration (apiconf.py): the environment the services get, the files for their keys, what
the well-known offers, and the templates that carry it (Caddy routes, Synapse's push whitelist, LiveKit's TURN)."""
import json
import re
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
_TMP = tempfile.mkdtemp()
os.environ["TINHAT_STATE"] = _TMP

from tinhat import apiconf, config, hw, templates  # noqa: E402

# Other test modules stub the package's modules in sys.modules; the templates reach hw and apiconf through the package.
REAL = {"tinhat.hw": hw, "tinhat.apiconf": apiconf, "tinhat.config": config, "tinhat.templates": templates}

SECRETS = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
           "postgres_password": "pg", "livekit_key": "lk", "livekit_secret": "lksec", "system_token": "syt_x",
           "giphy_key": "", "youtube_key": "yt123"}


class Env(unittest.TestCase):
    def test_phone_relay_only_when_given(self):
        env = dict(l.split("=", 1) for l in apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1", "", "https://push.example").splitlines())
        self.assertEqual(env["PUSH_RELAY"], "https://push.example")
        env = dict(l.split("=", 1) for l in apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1").splitlines())
        self.assertNotIn("PUSH_RELAY", env)

    def test_relay_origin_is_strict_and_canonical(self):
        for good, want in [("https://push.tinhat.dev", "https://push.tinhat.dev"), (" https://Push.Example/ ", "https://push.example"),
                           ("https://push.example:443", "https://push.example"), ("https://push.example:8443", "https://push.example:8443"),
                           ("http://127.0.0.1:8098", "http://127.0.0.1:8098"), ("https://[2001:DB8:0::1]", "https://[2001:db8::1]"),
                           ("https://198.51.100.7:8443", "https://198.51.100.7:8443"), ("http://[::1]:8098", "http://[::1]:8098")]:
            self.assertEqual(apiconf.relay_origin(good), want, good)
        for bad in ["https://x\nPUSH_GATEWAY_HOST=0.0.0.0", "https://x\rY=1", "https://push .example", "http://push.example",
                    "https://push.example/path", "https://push.example/?", "https://push.example/#", "https://u:p@push.example",
                    "ftp://push.example", "https://", "https://-bad.example", "", None, 42, "https://push.example:99999",
                    "https://push.example:0", "https://999.999.999.999", "https://127.1", "https://123", "https://0x7f.1",
                    "https://push.example.0x1", "https://a.1"]:
            self.assertEqual(apiconf.relay_origin(bad), "", repr(bad))

    def test_an_invalid_configured_relay_is_off_everywhere(self):
        st = {"server_name": "crew.tinhat.me", "api": {}}
        with mock.patch.object(apiconf.environment, "env", return_value={"push_relay": "https://x\nPUSH_GATEWAY_HOST=0.0.0.0"}):
            self.assertEqual(apiconf.push_relay(st), "")
            self.assertFalse(apiconf.features(st, SECRETS)["phone_push"])
        with mock.patch.object(apiconf.environment, "env", return_value={"push_relay": "https://push.example/"}):
            self.assertEqual(apiconf.push_relay(st), "https://push.example")
            self.assertTrue(apiconf.features(st, SECRETS)["phone_push"])

    def test_phone_push_on_by_default_and_owner_can_switch_it_off(self):
        on = {"server_name": "crew.tinhat.me", "api": {}}
        off = {"server_name": "crew.tinhat.me", "api": {"phone_push": False}}
        self.assertEqual(apiconf.push_relay(on), "https://push.tinhat.dev")
        self.assertEqual(apiconf.push_relay(off), "")
        self.assertTrue(apiconf.settings(on)["phone_push"])
        self.assertFalse(apiconf.settings(off)["phone_push"])

    def test_env_names_this_server_only(self):
        env = dict(l.split("=", 1) for l in apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1").splitlines())
        self.assertEqual(env["SYNAPSE_PUBLIC"], "https://crew.tinhat.me")
        self.assertEqual(env["WEB_BASE"], "https://crew.tinhat.me")
        self.assertEqual(env["SOUNDBOARD_PUBLIC_BASE"], "https://crew.tinhat.me/api/soundboard")
        self.assertEqual(env["VODS_PUBLIC_BASE"], "https://crew.tinhat.me/api/vods")
        self.assertNotIn("LK_WS_URL", env)  # no call-only guest links: the API hands out no call tokens
        self.assertEqual(env["LK_API_URL"], "http://127.0.0.1:7880")
        self.assertEqual(env["SYNAPSE_INTERNAL"], "http://127.0.0.1:8008")
        self.assertEqual(env["PUSH_GATEWAY_HOST"], "198.18.16.1")
        self.assertEqual(env["PUSH_GATEWAY_URL"], "http://198.18.16.1:3091/_matrix/push/v1/notify")
        self.assertEqual(env["PUSH_SUBJECT"], "https://crew.tinhat.me")
        self.assertEqual(env["TRUST_PROXY"], "loopback")
        self.assertEqual(env["API_CONF_DIR"], "/conf")
        # every address in it is the server's own name, this machine or its gateway: nothing points anywhere else
        text = apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1")
        self.assertLessEqual(set(re.findall(r"\b[a-z]+://([^/:\s]+)", text)), {"crew.tinhat.me", "127.0.0.1", "198.18.16.1"})
        self.assertLessEqual(set(re.findall(r"(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])", text)), {"127.0.0.1", "198.18.16.1"})

    def test_web_app_address_only_for_an_own_domain(self):
        env = dict(l.split("=", 1) for l in apiconf.env_text("example.org", SECRETS, "198.18.16.1", "web.example.org").splitlines())
        self.assertEqual(env["WEB_BASE"], "https://web.example.org")
        self.assertEqual(env["SYNAPSE_PUBLIC"], "https://example.org")  # chat stays at the server's own name
        self.assertEqual(env["VODS_PUBLIC_BASE"], "https://example.org/api/vods")
        own = {"mode": "domain", "api": {"web": "web.example.org"}}
        self.assertEqual(apiconf.settings(own)["web"], "web.example.org")
        self.assertEqual(apiconf.settings({**own, "mode": "anywhere"})["web"], "")  # a tinhat.me name: never

    def test_no_gateway_yet_falls_back_to_loopback(self):
        env = dict(l.split("=", 1) for l in apiconf.env_text("a.local", SECRETS, "").splitlines())
        self.assertEqual(env["PUSH_GATEWAY_HOST"], "127.0.0.1")

    def test_write_makes_key_files_and_removes_cleared_ones(self):
        st = {"server_name": "a.local", "calls": True}
        with mock.patch.object(apiconf, "docker_gateway", return_value="198.18.16.1"):
            self.assertTrue(apiconf.write(st, SECRETS))
            self.assertEqual((apiconf.DIR / "youtube.key").read_text(), "yt123")
            self.assertFalse((apiconf.DIR / "giphy.key").exists())
            self.assertEqual((apiconf.DIR / "synapse-admin.token").read_text(), "syt_x")
            self.assertEqual((apiconf.DIR / "livekit.secret").read_text(), "lksec")
            self.assertEqual(oct((apiconf.DIR / "env").stat().st_mode & 0o777), "0o600")
            for d in apiconf.SUBDIRS:
                self.assertTrue((apiconf.DIR / d).is_dir())
            self.assertFalse(apiconf.write(st, SECRETS))  # nothing changed: nothing to restart
            self.assertTrue(apiconf.write(st, {**SECRETS, "youtube_key": ""}))
            self.assertFalse((apiconf.DIR / "youtube.key").exists())


class Features(unittest.TestCase):
    def test_features_follow_keys_and_choices(self):
        st = {"server_name": "a.local", "calls": True, "api": {"memories": True, "recorder": "@rec:a.local"}}
        f = apiconf.features(st, SECRETS)
        self.assertEqual(f["gifs"], False)
        self.assertEqual(f["watch"], True)
        self.assertEqual(f["steam"], False)
        self.assertTrue(f["soundboard"] and f["games"] and f["presence"] and f["push"] and f["reports"] and f["guests"])
        self.assertEqual(f["memories"], True)
        self.assertEqual(apiconf.recorder(st), "@rec:a.local")
        self.assertEqual(apiconf.recorder({"api": {"memories": False, "recorder": "@rec:a.local"}}), "")
        self.assertEqual(f["gameservers"], apiconf.gameservers_configured())

    def test_wellknown_carries_the_offer_under_its_key(self):
        doc = json.loads(templates.wellknown_client("a.local", True, "0.2.21", features={"gifs": False, "memories": True},
                                                    recorder="@rec:a.local"))
        self.assertEqual([k for k in doc if "tinhat" in k], ["dev.tinhat.server"], "the offer under its one key")
        offer = doc["dev.tinhat.server"]
        self.assertEqual(offer["api"], "https://a.local/api")
        self.assertEqual(offer["features"]["gifs"], False)
        self.assertEqual(offer["features"]["calls"], True)
        self.assertEqual(offer["recorder"], "@rec:a.local")
        off = json.loads(templates.wellknown_client("a.local", True, "0.2.21", features={"memories": False}, recorder="@rec:a.local"))
        self.assertNotIn("recorder", off["dev.tinhat.server"])
        former = json.loads(templates.wellknown_former_client("b.local", True, "0.2.21", {"gifs": True}, ""))
        self.assertEqual(former["dev.tinhat.moved_to"], "b.local")
        self.assertEqual(former["dev.tinhat.server"]["features"]["gifs"], True)

    def test_turn_validation(self):
        t, err = apiconf.valid_turn({"host": "turn.example.com", "port": "5349", "protocol": "tls", "username": "u"})
        self.assertIsNone(err)
        self.assertEqual(t, {"host": "turn.example.com", "port": 5349, "protocol": "tls", "username": "u"})
        self.assertIsNotNone(apiconf.valid_turn({"host": "not a host", "username": "u"})[1])
        self.assertIsNotNone(apiconf.valid_turn({"host": "turn.example.com", "protocol": "quic", "username": "u"})[1])
        self.assertIsNotNone(apiconf.valid_turn({"host": "turn.example.com", "username": ""})[1])
        self.assertEqual(apiconf.valid_turn(None), (None, None))


class Templates(unittest.TestCase):
    def setUp(self):
        self._mods = mock.patch.dict(sys.modules, REAL)
        self._mods.start()
        self._addr = mock.patch.object(hw, "addresses", return_value=["10.0.0.2"])
        self._addr.start()

    def tearDown(self):
        self._addr.stop()
        self._mods.stop()

    def test_every_caddy_mode_routes_the_api(self):
        for caddy in (templates.caddy_lan("a.local"),
                      templates.caddy_proxy("chat.example.com", 8080, False),
                      templates.caddy_anywhere("crew.tinhat.me", {"server_url": "https://names.tinhat.dev", "username": "b0x-Id_123",
                                                                  "password": "s3cr3t-Url_Safe", "subdomain": "abc123"},
                                               "https://acme.example/dir", False)):
            self.assertIn("handle_path /api/games/* {", caddy)
            self.assertIn("reverse_proxy 127.0.0.1:3003", caddy)
            self.assertIn("handle_path /api/soundboard/* {", caddy)
            self.assertIn("rewrite * /gif{uri}", caddy)
            self.assertIn("rewrite * /youtube{uri}", caddy)
            self.assertIn("rewrite * /guest{uri}", caddy)
            self.assertIn("handle_path /api/* {", caddy)
            self.assertIn("handle /livekit/jwt {\n\t\trewrite * /sfu/get\n\t\treverse_proxy 127.0.0.1:8070", caddy)
            self.assertIn("handle_path /api/admin/* {\n\t\trewrite * /tinhat-api/admin{uri}\n\t\treverse_proxy 127.0.0.1:8090", caddy)
            self.assertEqual(caddy.count("/api/admin/*"), 1)  # once, and the manager gets /tinhat-api/admin/… (not /api/…)
            self.assertEqual(caddy.count("header_up X-Forwarded-For {client_ip}") >= 10, True)
            self.assertNotIn("Not on this server yet", caddy)
            self.assertNotIn("{api_routes}", caddy)

    def test_synapse_whitelists_only_the_push_gateway(self):
        y = templates.homeserver_yaml("a.local", SECRETS, {}, None, None, push_gateway="198.18.16.1")
        self.assertIn('ip_range_whitelist:\n  - "198.18.16.1/32"', y)
        self.assertNotIn("ip_range_whitelist", templates.homeserver_yaml("a.local", SECRETS, {}, None, None))

    def test_livekit_turn_from_the_owners_choice(self):
        with mock.patch.object(apiconf, "settings", return_value={"memories": False, "recorder": "",
                                                                   "turn": {"host": "turn.example.com", "port": 5349, "protocol": "tls", "username": "u"}}):
            y = templates.livekit_yaml({**SECRETS, "turn_credential": "p\"q"})
            self.assertIn("turn_servers:", y)
            self.assertIn("host: turn.example.com", y)
            self.assertIn('credential: "p\\"q"', y)
        self.assertNotIn("turn_servers", templates.livekit_yaml(SECRETS))


if __name__ == "__main__":
    unittest.main()

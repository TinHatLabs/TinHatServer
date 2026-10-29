"""The owner's own numbers for the Tin Hat API's limits (review of 116d103, #3): kept in state api.limits, written into
the API's environment by env_text (the env file is regenerated on every refresh, update and settings save, so an
edit of it never lasted), only the documented names and only valid values; `tinhat api-limits` sets them.
    python3 -m unittest discover -s appliance/tests
"""
import os
import re  # noqa: F401
import sys
import tempfile
import unittest
from pathlib import Path

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())

from tinhat import apiconf  # noqa: E402

SECRETS = {"livekit_key": "lk"}
ACCESS_MJS = Path(__file__).resolve().parents[2] / "api" / "tinhat-api"


def env_of(text: str) -> dict:
    return dict(line.split("=", 1) for line in text.splitlines())


class OwnerLimits(unittest.TestCase):
    def test_they_reach_the_api_environment(self):
        st = {"api": {"limits": {"API_LEGACY_ANON": "off", "WATCH_USER_UNITS_PER_DAY": "9500", "SOUNDBOARD_CACHE_MAX_MB": 2048}}}
        lim = apiconf.limits(st)
        self.assertEqual(lim, {"API_LEGACY_ANON": "off", "WATCH_USER_UNITS_PER_DAY": "9500", "SOUNDBOARD_CACHE_MAX_MB": "2048"})
        env = env_of(apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1", owner_limits=lim))
        self.assertEqual(env["API_LEGACY_ANON"], "off")
        self.assertEqual(env["WATCH_USER_UNITS_PER_DAY"], "9500")
        self.assertEqual(env["SOUNDBOARD_CACHE_MAX_MB"], "2048")
        self.assertEqual(env["TINHAT_BOX"], "1")
        # regenerated from state every time: the same text again, nothing lost
        self.assertEqual(apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1", owner_limits=apiconf.limits(st)),
                         apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1", owner_limits=lim))

    def test_call_token_room_check_is_the_owners_switch(self):
        # calls round M1b (0.3.7): on unless the owner says off; only on|off reach the API
        self.assertEqual(apiconf.limit_value("CALL_TOKEN_ROOM_CHECK", "off"), "off")
        self.assertEqual(apiconf.limit_value("CALL_TOKEN_ROOM_CHECK", " ON "), "on")
        for bad in ("no", "0", "false", "", True, False, None):
            self.assertIsNone(apiconf.limit_value("CALL_TOKEN_ROOM_CHECK", bad))
        self.assertNotIn("CALL_TOKEN_ROOM_CHECK", env_of(apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1")))  # default: the API's (on)
        env = env_of(apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1",
                                      owner_limits=apiconf.limits({"api": {"limits": {"CALL_TOKEN_ROOM_CHECK": "off"}}})))
        self.assertEqual(env["CALL_TOKEN_ROOM_CHECK"], "off")

    def test_only_known_names_and_good_values(self):
        st = {"api": {"limits": {"API_LEGACY_ANON": "maybe", "WATCH_USER_UNITS_PER_DAY": "-5", "GIF_FETCH_MAX_MB": "1e9",
                                 "SYNAPSE_INTERNAL": "http://evil", "API_ANON_GIF_PER_HOUR": "12\nSYNAPSE_INTERNAL=x",
                                 "API_USER_GIF_PER_HOUR": "0", "SOUNDBOARD_CLIP_MAX_MB": " 7 "}}}
        self.assertEqual(apiconf.limits(st), {"API_USER_GIF_PER_HOUR": "0", "SOUNDBOARD_CLIP_MAX_MB": "7"})
        env = apiconf.env_text("crew.tinhat.me", SECRETS, "198.18.16.1",
                               owner_limits={"SYNAPSE_INTERNAL": "http://evil", "TINHAT_BOX": "0", "API_LEGACY_ANON": "on"})
        self.assertNotIn("http://evil", env)
        self.assertEqual(env_of(env)["TINHAT_BOX"], "1", "never one of the API's own variables")
        self.assertEqual(env_of(env)["API_LEGACY_ANON"], "on")
        self.assertEqual(apiconf.limits({"api": {"limits": "not a dict"}}), {})
        self.assertEqual(apiconf.limits({}), {})

    def test_bounded_whole_numbers_with_a_stated_zero(self):
        # second review, #6: digits only, inside each limit's range, so the API only sees a bounded safe integer
        v = apiconf.limit_value
        for bad in ("-1", "+5", "1.5", "5.0", "1e3", "0x10", "inf", "Infinity", "nan", "NaN", "", " ", "1 000", "١٢",
                    "1000000000", "99999999999", True, False, None, 1.5, float("inf"), float("nan"), [], {}):
            with self.subTest(value=bad):
                self.assertIsNone(v("API_USER_GIF_PER_HOUR", bad))
        self.assertEqual(v("API_USER_GIF_PER_HOUR", "0"), "0")  # 0 = none (docs/API.md)
        self.assertEqual(v("API_USER_GIF_PER_HOUR", "999999999"), "999999999")
        self.assertEqual(v("API_USER_GIF_PER_HOUR", 7), "7")
        self.assertEqual(v("API_USER_GIF_PER_HOUR", "007"), "7")
        self.assertEqual(v("WATCH_ANON_ALL_UNITS_PER_DAY", "0"), "0")
        self.assertEqual(v("SOUNDBOARD_USER_UPLOADS_MB", "0"), "0")  # no uploads
        for name, low, high in (("SOUNDBOARD_CLIP_MAX_MB", 1, 100), ("GIF_FETCH_MAX_MB", 1, 100),
                                ("SOUNDBOARD_CACHE_MAX_MB", 1, 1_048_576), ("SOUNDBOARD_CLIP_LINK_MIN", 1, 10_080),
                                ("SOUNDBOARD_UPLOADS_TOTAL_MB", 0, 1_048_576)):
            with self.subTest(name=name):
                self.assertEqual(v(name, str(low)), str(low))
                self.assertEqual(v(name, str(high)), str(high))
                self.assertIsNone(v(name, str(high + 1)))
                if low:
                    self.assertIsNone(v(name, str(low - 1)), "0 isn't a size for one file, the cache or a link")
        for name, kind in apiconf.LIMITS.items():
            with self.subTest(name=name):
                self.assertTrue(kind == "onoff" or (isinstance(kind, tuple) and 0 <= kind[0] <= kind[1] <= 999_999_999))
        self.assertEqual(apiconf.limit_help("API_USER_GIF_PER_HOUR"), "a whole number from 0 to 999,999,999 (0 = none)")
        self.assertEqual(apiconf.limit_help("SOUNDBOARD_CLIP_MAX_MB"), "a whole number from 1 to 100")
        self.assertEqual(apiconf.limit_help("API_LEGACY_ANON"), "on or off")

    def test_the_api_takes_the_same_ranges(self):
        # server.mjs's envNum and access.mjs's accessConfig: whole numbers only, the same bounds, else the default
        src = (ACCESS_MJS / "server.mjs").read_text()
        for name, kind in apiconf.LIMITS.items():
            if kind == "onoff" or name.startswith(("API_", "WATCH_")):
                continue
            low, high = kind
            with self.subTest(name=name):
                if (low, high) == apiconf.COUNT:
                    self.assertRegex(src, rf'envNum\("{name}", \d+\)')
                else:
                    self.assertIn(f'envNum("{name}", ', src)
                    self.assertRegex(src, rf'envNum\("{name}", \d+, {low}, {high:_}\)')
        self.assertIn("/^[0-9]{1,10}$/", src)
        self.assertIn('/^\\d{1,9}$/', (ACCESS_MJS / "access.mjs").read_text())

    def test_every_name_is_one_the_api_reads(self):
        # each LIMITS name appears in the API's own source (access.mjs / server.mjs), so none is dead
        src = "".join((ACCESS_MJS / f).read_text() for f in ("access.mjs", "server.mjs"))
        for name in apiconf.LIMITS:
            with self.subTest(name=name):
                self.assertRegex(src, rf"(\"{name}\"|env\.{name}\b)")


try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
except ImportError:
    HAVE_AIOHTTP = False


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp (the console's module imports it)")
class Console(unittest.TestCase):
    def run_cli(self, args, current=None):
        from tinhat import __main__ as cli
        from unittest import mock
        st = {"api": {"limits": dict(current or {})}}
        applied = []

        def apply(limits):
            applied.append(limits)
            return True
        with mock.patch("builtins.print") as said:
            rc = cli.api_limits(args, st=st, apply=apply)
        return rc, applied, " ".join(str(c.args[0]) for c in said.call_args_list)

    def test_set_reset_and_show(self):
        rc, applied, _ = self.run_cli(["API_LEGACY_ANON=off", "WATCH_USER_UNITS_PER_DAY=9500"], {"GIF_FETCH_MAX_MB": "4"})
        self.assertEqual((rc, applied), (0, [{"GIF_FETCH_MAX_MB": "4", "API_LEGACY_ANON": "off", "WATCH_USER_UNITS_PER_DAY": "9500"}]))
        rc, applied, said = self.run_cli(["--reset", "GIF_FETCH_MAX_MB"], {"GIF_FETCH_MAX_MB": "4", "API_LEGACY_ANON": "off"})
        self.assertEqual((rc, applied), (0, [{"API_LEGACY_ANON": "off"}]))
        self.assertIn("GIF_FETCH_MAX_MB is back to its default.", said)
        self.assertIn("Still set: API_LEGACY_ANON=off", said)
        rc, applied, said = self.run_cli(["--reset", "API_LEGACY_ANON"], {"API_LEGACY_ANON": "off"})
        self.assertEqual((rc, applied), (0, [{}]))
        self.assertIn("API_LEGACY_ANON is back to its default.", said)
        self.assertIn("No other limit is set", said)
        rc, applied, _ = self.run_cli(["--reset-all"], {"API_LEGACY_ANON": "off"})
        self.assertEqual((rc, applied), (0, [{}]))
        rc, applied, said = self.run_cli([], {"API_LEGACY_ANON": "off"})
        self.assertEqual((rc, applied), (0, []))
        self.assertIn("API_LEGACY_ANON=off", said)
        self.assertIn("WATCH_USER_UNITS_PER_DAY", said)

    def test_refused(self):
        for args in (["SYNAPSE_INTERNAL=http://x"], ["API_LEGACY_ANON=maybe"], ["WATCH_USER_UNITS_PER_DAY=-1"], ["oops"],
                     ["--reset", "SYNAPSE_INTERNAL"], ["--reset"], ["SOUNDBOARD_CLIP_MAX_MB=0"], ["GIF_FETCH_MAX_MB=101"],
                     ["API_USER_GIF_PER_HOUR=1e3"], ["API_USER_GIF_PER_HOUR=inf"]):
            with self.subTest(args=args):
                rc, applied, _ = self.run_cli(args)
                self.assertEqual(rc, 2)
                self.assertEqual(applied, [])
        _, _, said = self.run_cli(["SOUNDBOARD_CLIP_MAX_MB=0"])
        self.assertIn("from 1 to 100", said)
        _, _, said = self.run_cli(["API_USER_GIF_PER_HOUR=-1"])
        self.assertIn("(0 = none)", said)


if __name__ == "__main__":
    unittest.main()

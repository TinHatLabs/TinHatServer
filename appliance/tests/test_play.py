"""The mini games in the manager (play.py; docs/PLAY.md): defaults in one place, the §2.7 bounds refused, the API's PLAY_*
environment, the well-known flags, the games role's password kept, the database reachable on the box's loopback only,
Caddy's /api/play route, and the role SQL never pasting the password."""
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))
os.environ["TINHAT_STATE"] = tempfile.mkdtemp()

from tinhat import apiconf, play, templates  # noqa: E402
import importlib  # noqa: E402


def cur(name: str):
    """A manager module as the code under test sees it (`from . import name`: the package's current attribute). Other
    test files reload or stub tinhat.* modules, so a module bound at this file's import may be stale in a full run."""
    pkg = sys.modules["tinhat"]
    return getattr(pkg, name, None) or importlib.import_module(f"tinhat.{name}")


def stub_compose(run):
    """`compose.run` replaced on both paths `from . import compose` may take (a stub module from another test, or the real one)."""
    fake = type(sys)("tinhat.compose")
    fake.run = run
    return mock.patch.dict(sys.modules, {"tinhat.compose": fake}), mock.patch.object(sys.modules["tinhat"], "compose", fake, create=True)

SECRETS = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
           "postgres_password": "pg", "livekit_key": "lk", "livekit_secret": "lksec", "system_token": "syt_x",
           "giphy_key": "", "youtube_key": ""}


class Settings(unittest.TestCase):
    def test_defaults_are_the_decided_ones(self):
        # games OFF until the owner turns them on (spec §79; the 0.3.20 release, launch-gate 13:57)
        # v1.1 (Server 0.3.21, addendum §5.2 / §6.3): every economy key; 1 chip / 15 min, 16 a day
        self.assertEqual(play.PLAY_DEFAULTS, {"enabled": False, "rig_phone_apps": False, "chip_minutes": 15, "day_max": 16, "start": 10, "topup_to": 5,
                                              "cap_base": 100, "cap_per_rank": 50, "side_day_max": 10, "side_on": True})
        self.assertEqual(play.settings({}), play.PLAY_DEFAULTS)

    def test_bounds_refused_and_ignored(self):
        for name, value in (("day_max", "0"), ("day_max", "201"), ("day_max", "2.5"), ("start", "501"), ("start", "-1"),
                            ("start", "ten"), ("rig_phone_apps", "maybe"), ("colour", "1"), ("chip_minutes", "1"), ("chip_minutes", "61"),
                            ("cap_base", "19"), ("side_on", "maybe")):
            v, why = play.check(name, value)
            self.assertIsNone(v, f"{name}={value}")
            self.assertTrue(why)
        self.assertEqual(play.check("day_max", "24"), (24, ""))
        self.assertEqual(play.check("day_max", "200"), (200, ""))
        self.assertEqual(play.check("chip_minutes", "5"), (5, ""))
        self.assertEqual(play.check("side_on", "off"), (False, ""))
        self.assertEqual(play.check("start", "0"), (0, ""))
        self.assertEqual(play.check("rig_phone_apps", "on"), (True, ""))
        # a stored out-of-bounds value (a hand-edited state) keeps the default
        self.assertEqual(play.settings({"play": {"day_max": 999, "start": True, "enabled": "yes"}}), play.PLAY_DEFAULTS)
        self.assertEqual(play.settings({"play": {"day_max": 3, "rig_phone_apps": True}})["day_max"], 3)

    def test_features_only_explicit(self):
        off = {"play_admin": False, "play_side": False, "play_v": 2}
        self.assertEqual(play.features({}), {"play": False, "play_rig_phone_apps": False, **off})
        self.assertEqual(play.features({"play": {"enabled": False, "rig_phone_apps": True}}), {"play": False, "play_rig_phone_apps": True, **off})
        on = play.features({"play": {"enabled": True}, "play_g9_ok": 1})
        self.assertEqual((on["play_admin"], on["play_side"]), (True, True))
        self.assertIs(play.features({"play": {"enabled": True, "side_on": False}, "play_g9_ok": 1})["play_side"], True, "the capability; a space may turn it on")
        f = apiconf.features({"server_name": "a.local", "calls": True}, SECRETS)
        self.assertIs(f["play"], False)
        self.assertIs(f["play_rig_phone_apps"], False)
        self.assertIs(play.features({"play": {"enabled": True}, "play_g9_ok": 1})["play"], True)
        self.assertIs(play.features({"play": {"enabled": True}})["play"], False, "no clean G9 pass recorded here yet: off")


class Env(unittest.TestCase):
    def test_env_lines_and_env_text(self):
        st = {"server_name": "a.local", "updates": {"tz": "America/Los_Angeles"}, "play": {"day_max": 6}, "play_db_port": 5433}
        lines = play.env_lines(st, {**SECRETS, "play_db_password": "p" * 32})
        self.assertEqual(lines["PLAY_DAY_MAX"], "6")
        # v1.1: only keys the owner set reach the env (an unset one = the API's own default, the new 16 for day_max)
        self.assertNotIn("PLAY_START", lines)
        self.assertNotIn("PLAY_CHIP_MINUTES", lines)
        self.assertNotIn("PLAY_DAY_MAX", play.env_lines({**st, "play": {}}, {**SECRETS, "play_db_password": "p" * 32}))
        self.assertEqual(play.env_lines({**st, "play": {"side_on": False, "chip_minutes": 20}}, {**SECRETS, "play_db_password": "p" * 32})["PLAY_SIDE_ON"], "0")
        self.assertEqual(lines["PLAY_RIG_PHONE_APPS"], "0")
        self.assertEqual(lines["PLAY_TZ"], "America/Los_Angeles")
        self.assertEqual((lines["PLAY_DB_HOST"], lines["PLAY_DB_PORT"]), ("127.0.0.1", "5433"))
        self.assertNotIn("p" * 32, "".join(lines.values()), "the password goes in its own file, never the env")
        env = dict(l.split("=", 1) for l in apiconf.env_text("a.local", SECRETS, "198.18.16.1", play_env=lines).splitlines())
        self.assertEqual(env["PLAY_DAY_MAX"], "6")
        # nothing but PLAY_* (and the recorder's id) can come in this way, and never with whitespace
        env2 = apiconf.env_text("a.local", SECRETS, "198.18.16.1", play_env={"LK_API_KEY": "x", "PLAY_X": "a b", "PLAY_Y": "ok"})
        self.assertNotIn("LK_API_KEY=x", env2)
        self.assertNotIn("PLAY_X", env2)
        self.assertIn("PLAY_Y=ok", env2)

    def test_password_generated_once_and_kept(self):
        with mock.patch.object(apiconf, "docker_gateway", return_value="198.18.16.1"):
            st = {"server_name": "a.local", "calls": True}
            self.assertTrue(apiconf.write(st, SECRETS))
            pw = (apiconf.DIR / "play-db.secret").read_text()
            self.assertRegex(pw, r"^[A-Za-z0-9_-]{32}$")
            self.assertEqual(oct((apiconf.DIR / "play-db.secret").stat().st_mode & 0o777), "0o600")
            self.assertFalse(apiconf.write(st, SECRETS))
            self.assertEqual((apiconf.DIR / "play-db.secret").read_text(), pw)


class Wiring(unittest.TestCase):
    def test_database_port_is_loopback_only(self):
        compose = (_OPT / "compose.yaml").read_text()
        ports = re.findall(r'^\s*-\s*"([^"]*:5432)"', compose, re.M)
        self.assertEqual(ports, ["127.0.0.1:${TINHAT_PLAY_DB_PORT:-5433}:5432"], "the games database: the box's loopback only")
        self.assertEqual(play.PLAY_DB_PORT, 5433)

    def _state(self, initial=None):
        """load_state / save_state over one dict (the stored state), as play.db_port sees them."""
        P = cur("play")
        box = dict(initial or {})
        return box, mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
            mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box))

    def test_the_port_is_5433_unless_taken_then_a_spare_chosen_once_and_kept(self):
        P, T = cur("play"), cur("templates")
        box, a, b = self._state()
        with a, b, mock.patch.object(P, "_published_by_us", return_value=None):
            with mock.patch.object(P, "_bindable", return_value=True):
                self.assertEqual(P.db_port(), 5433)
            self.assertEqual(box["play_db_port"], 5433)
            box.clear()
            with mock.patch.object(P, "_bindable", side_effect=lambda p: p not in (5433, 54330)):
                self.assertEqual(P.db_port(), 54331, "5433 taken by the owner's own Postgres: a free spare")
            with mock.patch.object(P, "_published_by_us", return_value=54331), mock.patch.object(P, "_bindable", return_value=False):
                self.assertEqual(P.db_port(), 54331, "the stored choice is kept while our own container publishes it")
            with mock.patch.object(P, "_bindable", side_effect=lambda p: p != 54331):
                self.assertEqual(P.db_port(), 5433, "something else took the stored port since: chosen again")
            self.assertEqual(box["play_db_port"], 5433)
        # one value for both: compose.env and the API's env
        box, a, b = self._state({"play_db_port": 54331})
        with a, b:
            self.assertIn("TINHAT_PLAY_DB_PORT=54331\n", T.compose_env("a.local", SECRETS, lan=False))
            self.assertEqual(P.env_lines({"server_name": "a.local"}, {**SECRETS, "play_db_password": "p" * 32})["PLAY_DB_PORT"], "54331")

    def test_a_stale_snapshot_never_changes_the_choice(self):
        """astra 14:3x #9: two renders from one old snapshot, availability changing between them: the same port."""
        P = cur("play")
        box, a, b = self._state()
        free, ours = {5433: True}, [None]
        with a, b, mock.patch.object(P, "_published_by_us", side_effect=lambda: ours[0]), \
             mock.patch.object(P, "_bindable", side_effect=lambda p: free.get(p, True)):
            snap = {}
            first = P.db_port(snap)
            free[5433], ours[0] = False, first  # our own container publishes it now (between the two renders)
            self.assertEqual(P.db_port(snap), first)

    def test_our_own_published_port_counts_as_free_and_a_bound_socket_as_taken(self):
        import socket
        P = cur("play")
        sock = socket.socket(); sock.bind(("127.0.0.1", 0))  # bound, NOT listening: a connect would be refused
        try:
            port = sock.getsockname()[1]
            self.assertFalse(P._bindable(port), "bound but not listening is still taken")
        finally:
            sock.close()
        box, a, b = self._state()
        with a, b, mock.patch.object(P, "_published_by_us", return_value=5433), mock.patch.object(P, "_bindable", return_value=False):
            self.assertEqual(P.db_port(), 5433, "the port our own database container already publishes")

    def test_nothing_free_means_no_games_database_never_a_taken_port(self):
        P = cur("play")
        box, a, b = self._state()
        with a, b, mock.patch.object(P, "_published_by_us", return_value=None), mock.patch.object(P, "_bindable", return_value=False):
            self.assertEqual(P.db_port(), 0)
            self.assertNotIn("play_db_port", box, "nothing stored: the next run tries again")
            lines = P.env_lines({"server_name": "a.local", "play": {"enabled": True}}, {**SECRETS, "play_db_password": "p" * 32})
            self.assertNotIn("PLAY_DB_HOST", lines)
            self.assertNotIn("PLAY_DB_PORT", lines)

    def test_caddy_routes_play_to_the_api(self):
        self.assertIn("handle_path /api/play/* {", templates.CADDY_API)
        block = templates.CADDY_API.split("handle_path /api/play/* {", 1)[1].split("\n\t}\n", 1)[0]
        self.assertIn("reverse_proxy 127.0.0.1:3001", block)

    def test_role_sql_takes_the_password_as_a_variable(self):
        self.assertIn("%L', :'role', :'pw')", play.ENSURE_SQL)
        self.assertNotIn("{", play.ENSURE_SQL)  # no Python formatting into SQL
        self.assertIn("NOSUPERUSER NOCREATEDB NOCREATEROLE", play.ENSURE_SQL)
        # launch-gate 14:06: NO REVOKE on Synapse's database in this release (G9 proves the role reads nothing there)
        self.assertNotIn("synapse", play.ENSURE_SQL.lower())

    def test_the_password_goes_in_on_stdin_never_on_a_command_line(self):
        calls = []

        async def run(*args, **kw):
            calls.append((args, kw.get("stdin", b"")))
            return 0, ""
        P = cur("play")
        a, b = stub_compose(run)
        box = {}
        with a, b, mock.patch.object(P, "password", return_value="p" * 32), mock.patch.object(P, "scan", new=lambda: _done([])), \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
             mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box)):
            import asyncio
            ok, _ = asyncio.run(P.ensure_db(force=True, apply=False))
        self.assertTrue(ok)
        args, stdin = calls[0]
        self.assertNotIn("p" * 32, " ".join(map(str, args)), "never in the docker exec / psql arguments")
        self.assertTrue(stdin.startswith(b"\\set pw '" + b"p" * 32 + b"'\n"))

    def test_a_g9_finding_fails_the_preparation(self):
        async def run(*args, **kw):
            return 0, ""
        P = cur("play")
        a, b = stub_compose(run)
        box = {}
        with a, b, mock.patch.object(P, "password", return_value="p" * 32), \
             mock.patch.object(P, "scan", new=lambda: _done(["table|public.users|SELECT"])), \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
             mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box)):
            import asyncio
            ok, msg = asyncio.run(P.ensure_db(force=True, apply=False))
        self.assertFalse(ok)
        self.assertIn("G9 FAILED", msg)
        self.assertIn("public.users", msg)


async def _done(v):
    return v


class Calls(unittest.TestCase):
    """The games switch restarts the API (it hands out call tokens): never while a call is live (or LiveKit can't say)."""

    def test_the_console_refuses_and_saves_nothing_during_a_call(self):
        with mock.patch.object(play, "call_live", new=lambda: _done(True)), mock.patch.object(play, "save") as save:
            self.assertEqual(play.cli(["config", "enabled=on"]), 3)
            save.assert_not_called()

    def test_the_dashboard_refuses_during_a_call(self):
        web = (_OPT / "manager" / "tinhat" / "web.py").read_text()
        i = web.index("if play_changes:")
        self.assertIn("if await play.call_live():", web[i:i + 300])
        self.assertIn("409", web[i:i + 300])

    def test_unknown_counts_as_a_call(self):
        import asyncio
        try:
            from tinhat import lkadmin
        except ImportError:  # no aiohttp here (the builder): a stand-in with the same function
            lkadmin = type(sys)("tinhat.lkadmin")
            lkadmin.call_in_progress = None
        for answer, live in ((None, True), (True, True), (False, False)):
            with mock.patch.dict(sys.modules, {"tinhat.lkadmin": lkadmin}), \
                 mock.patch.object(lkadmin, "call_in_progress", new=lambda a=answer: _done(a)):
                self.assertIs(asyncio.run(play.call_live()), live, f"LiveKit says {answer}")


class AfterUpdate(unittest.TestCase):
    def test_after_update_prepares_the_games_database_and_a_failure_is_never_fatal(self):
        from tinhat import __main__ as m
        src = (_OPT / "manager" / "tinhat" / "__main__.py").read_text()
        body = src[src.index("def after_update"):src.index("def proxy_addresses")]
        self.assertIn("play.ensure_db(force=True, apply=False)", body)
        self.assertLess(body.index("play.ensure_db"), body.index("refresh_configs"), "before the configs: they carry a G9 block")
        self.assertIn("except Exception", body)
        self.assertTrue(body.rstrip().endswith("return 0"), "after-update never fails because of the games")


if __name__ == "__main__":
    unittest.main()


class Dashboard(unittest.TestCase):
    def test_features_card_doc_carries_the_play_settings_and_bounds(self):
        d = apiconf.doc({"server_name": "a.local", "calls": True, "play": {"day_max": 5}}, SECRETS)
        self.assertEqual(d["play"]["day_max"], 5)
        self.assertEqual(d["play"]["bounds"]["day_max"], [1, 200])
        self.assertEqual(d["play"]["bounds"]["start"], [0, 500])
        self.assertEqual(d["play"]["bounds"]["chip_minutes"], [2, 60])

    def test_the_card_sends_play_and_the_handler_refuses_out_of_bounds(self):
        ui = (_OPT / "manager" / "ui" / "admin.js").read_text()
        self.assertIn('play: { enabled: playOn, rigPhoneApps: rigPhones, dayMax: dayIn.value.trim(), start: startIn.value.trim(), chipMinutes: chipIn.value.trim(), sideOn, sideDayMax: sideIn.value.trim(), topupTo: topIn.value.trim(), capBase: capIn.value.trim(), capPerRank: perIn.value.trim() }', ui)
        web = (_OPT / "manager" / "tinhat" / "web.py").read_text()
        self.assertIn('v, why = play.check(name, body["play"][field])', web)
        self.assertIn('return _err(f"Mini games: {why}.", 400)', web)


class G9Block(unittest.TestCase):
    """astra 14:3x #7: a G9 finding takes the games OFF (the well-known and the API's env) until a later check is clean."""

    def run_ensure(self, box, found, calls_live=False):
        import asyncio
        P = cur("play")

        async def run(*args, **kw):
            return 0, ""
        a, b = stub_compose(run)
        with a, b, mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
             mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box)), \
             mock.patch.object(P, "password", return_value="p" * 32), mock.patch.object(P, "scan", new=lambda: _done(found)), \
             mock.patch.object(P, "call_live", new=lambda: _done(calls_live)):
            return asyncio.run(P.ensure_db(force=True, apply=False))

    def test_a_finding_blocks_and_a_clean_check_unblocks(self):
        P = cur("play")
        box = {"play": {"enabled": True}}
        ok, msg = self.run_ensure(box, ["table|public.users|SELECT"])
        self.assertFalse(ok)
        self.assertIn("public.users", box["play_g9_block"])
        self.assertTrue(box["play_api_restart"])
        self.assertIs(P.features(box)["play"], False, "the well-known says off")
        lines = P.env_lines(box | {"server_name": "a.local", "play_db_port": 5433}, {**SECRETS, "play_db_password": "p" * 32})
        self.assertEqual(lines["PLAY_ENABLED"], "0", "the API's env says off")
        self.assertTrue(P.settings(box)["enabled"], "the owner's own switch is kept")
        ok, _ = self.run_ensure(box, [])
        self.assertTrue(ok)
        self.assertFalse(box.get("play_g9_block"))
        self.assertIs(P.features(box)["play"], True)

    def test_the_pending_restart_waits_for_the_call(self):
        import asyncio
        P = cur("play")
        box = {"play_api_restart": True}
        ran = []

        async def run(*args, **kw):
            ran.append(args)
            return 0, ""
        a, b = stub_compose(run)
        fake_api = type(sys)("tinhat.apiconf"); fake_api.write = lambda *x, **k: True
        fake_inst = type(sys)("tinhat.install"); fake_inst.refresh_configs_locked = lambda *x, **k: _done([])
        pkg = sys.modules["tinhat"]
        with a, b, mock.patch.dict(sys.modules, {"tinhat.apiconf": fake_api, "tinhat.install": fake_inst}), \
             mock.patch.object(pkg, "apiconf", fake_api, create=True), mock.patch.object(pkg, "install", fake_inst, create=True), \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
             mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box)):
            with mock.patch.object(P, "call_live", new=lambda: _done(True)):
                self.assertFalse(asyncio.run(P.apply_pending()))
            self.assertEqual(ran, [], "no restart during a call")
            with mock.patch.object(P, "call_live", new=lambda: _done(False)):
                self.assertTrue(asyncio.run(P.apply_pending()))
        self.assertIn("--force-recreate", ran[0])
        self.assertFalse(box.get("play_api_restart"))

    def test_the_console_doesnt_restart_when_a_call_starts_meanwhile(self):
        P = cur("play")
        answers = iter([False, True])
        ran = []

        async def run(*args, **kw):
            ran.append(args)
            return 0, ""
        a, b = stub_compose(run)
        fake_api = type(sys)("tinhat.apiconf"); fake_api.write = lambda *x, **k: True
        fake_inst = type(sys)("tinhat.install"); fake_inst.refresh_configs_locked = lambda *x, **k: _done([])
        pkg = sys.modules["tinhat"]
        with a, b, mock.patch.dict(sys.modules, {"tinhat.apiconf": fake_api, "tinhat.install": fake_inst}), \
             mock.patch.object(pkg, "apiconf", fake_api, create=True), mock.patch.object(pkg, "install", fake_inst, create=True), \
             mock.patch.object(P, "call_live", new=lambda: _done(next(answers))), \
             mock.patch.object(P, "save", return_value={"enabled": True}), mock.patch.object(P, "mark_restart_pending") as pend:
            self.assertEqual(P.cli(["config", "enabled=on"]), 0)
        self.assertEqual(ran, [], "no restart: the call started after the first check")
        pend.assert_called_once()


class FailSafe(unittest.TestCase):
    """astra round 2 on 82cbd6c."""

    def test_a_scan_that_cannot_run_blocks_the_games(self):
        box = {"play": {"enabled": True}}
        ok, msg = G9Block.run_ensure(self, box, None)
        self.assertFalse(ok)
        self.assertIn("couldn't be checked", box["play_g9_block"])
        self.assertIs(cur("play").features(box)["play"], False)

    def test_a_failing_restart_never_stops_the_check_that_lifts_the_block(self):
        import asyncio
        P = cur("play")
        box = {"play": {"enabled": True}, "play_g9_block": "G9: table|public.users|SELECT", "play_api_restart": True}

        async def run(*args, **kw):
            return 0, ""

        async def boom():
            raise RuntimeError("configs could not be written")
        a, b = stub_compose(run)
        with a, b, mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), \
             mock.patch.object(P.state, "save_state", side_effect=lambda **kw: box.update(kw) or dict(box)), \
             mock.patch.object(P, "password", return_value="p" * 32), mock.patch.object(P, "scan", new=lambda: _done([])), \
             mock.patch.object(P, "apply_pending", new=boom):
            ok, _ = asyncio.run(P.ensure_db(force=True))
        self.assertTrue(ok)
        self.assertFalse(box.get("play_g9_block"), "the clean check lifted the block despite the failing restart")

    def test_a_held_port_lock_never_stalls_and_a_port_error_never_fails_a_config(self):
        import fcntl
        P, T = cur("play"), cur("templates")
        from tinhat import config
        box = {"play_db_port": 54331}
        with open(config.STATE_DIR / ".play-port.lock", "a+") as holder, \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), mock.patch.object(P.time if hasattr(P, "time") else __import__("time"), "sleep", lambda s: None):
            fcntl.flock(holder, fcntl.LOCK_EX)  # another holder (flock locks are per open file: this one blocks the next)
            import time as _t
            t0 = _t.monotonic()
            self.assertEqual(P.db_port(), 54331, "the stored choice while the lock is held elsewhere")
            self.assertLess(_t.monotonic() - t0, 15)
        with mock.patch.object(P, "db_port", side_effect=OSError("disk full")):
            self.assertIn("TINHAT_PLAY_DB_PORT=0\n", T.compose_env("a.local", SECRETS, lan=False))
            lines = P.env_lines({"server_name": "a.local"}, {**SECRETS, "play_db_password": "p" * 32})
            self.assertNotIn("PLAY_DB_PORT", lines)


class ScanVerdict(unittest.TestCase):
    """PM 15:26: the scan's verdict is its exit code (a finding or a scan that can't run = non-zero)."""

    def test_tinhat_play_scan_exit_codes(self):
        P = cur("play")
        for found, rc in (([], 0), (["table|public.users|SELECT"], 1), (None, 1)):
            with self.subTest(found=found), mock.patch.object(P, "scan", new=lambda f=found: _done(f)):
                self.assertEqual(P.cli(["scan"]), rc)


class StillBlocked(unittest.TestCase):
    """games-gates 15:48: after a G9 finding is fixed, a clean read-only scan doesn't lift the block, and switching
    the games on while blocked must never print a silent "on": both say the games are still off, why, and what lifts it;
    the dashboard shows the block."""

    def test_the_console_says_still_blocked(self):
        import contextlib
        import io
        P = cur("play")
        box = {"play": {"enabled": True}, "play_g9_block": "G9: table|public.users|SELECT", "play_g9_block_at": 1_795_000_000}
        with mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), mock.patch.object(P, "scan", new=lambda: _done([])):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = P.cli(["scan"])
        self.assertEqual(rc, 0, "the scan itself is clean")
        self.assertIn("Clean now, but: The games are OFF: blocked by G9 since", out.getvalue())
        self.assertIn("tinhat play db", out.getvalue())

        async def run(*args, **kw):
            return 0, ""
        a, b = stub_compose(run)
        fake_api = type(sys)("tinhat.apiconf"); fake_api.write = lambda *x, **k: True
        fake_inst = type(sys)("tinhat.install"); fake_inst.refresh_configs_locked = lambda *x, **k: _done([])
        pkg = sys.modules["tinhat"]
        with a, b, mock.patch.dict(sys.modules, {"tinhat.apiconf": fake_api, "tinhat.install": fake_inst}), \
             mock.patch.object(pkg, "apiconf", fake_api, create=True), mock.patch.object(pkg, "install", fake_inst, create=True), \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), mock.patch.object(P, "call_live", new=lambda: _done(False)), \
             mock.patch.object(P, "save", return_value={"enabled": True, "rig_phone_apps": False, "day_max": 8, "start": 10}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = P.cli(["config", "enabled=on"])
        self.assertEqual(rc, 4, "saved, but not in effect: never a silent success")
        self.assertIn("Saved, but the games are OFF: blocked by G9", out.getvalue())

    def test_the_dashboard_shows_the_block(self):
        P = cur("play")
        st = {"server_name": "a.local", "calls": True, "play": {"enabled": True}, "play_g9_block": "G9: x", "play_g9_block_at": 5}
        d = apiconf.doc(st, SECRETS)
        self.assertEqual((d["play"]["blocked"], d["play"]["blocked_at"]), ("G9: x", 5))
        self.assertIsNone(apiconf.doc({"server_name": "a.local", "calls": True, "play_g9_ok": 1}, SECRETS)["play"]["blocked"])
        ui = (_OPT / "manager" / "ui" / "admin.js").read_text()
        self.assertIn('"Off: blocked by a safety check (see Mini games below)"', ui)
        self.assertIn("...(pl.blocked ? [h(\"div.s.warn-text\"", ui)


class FreshBox(unittest.TestCase):
    """games-lab 22:13 (a FRESH 0.3.20, before the manager's first G9 pass): switching the games ON turned the well-known
    to play: true. Fail closed: until a clean G9 pass is recorded on THIS server the well-known and the API's env say
    off, and the console and the dashboard say why; the first clean pass turns the switch's choice on."""

    def test_switch_on_before_the_first_g9_pass_stays_off_then_the_pass_turns_it_on(self):
        import contextlib
        import io
        P = cur("play")
        box = {"server_name": "a.local", "calls": True, "play": {"enabled": True}}  # fresh: no role yet, no G9 record
        self.assertIs(P.features(box)["play"], False, "the well-known says off")
        env = P.env_lines(box | {"play_db_port": 5433}, {**SECRETS, "play_db_password": "p" * 32})
        self.assertEqual(env["PLAY_ENABLED"], "0", "the API's env says off")
        self.assertEqual(apiconf.doc(box, SECRETS)["play"]["blocked"], P.NOT_YET, "the dashboard says blocked, and why")
        # the console: switching on in this window says so (exit 4), never a silent "on"

        async def run(*args, **kw):
            return 0, ""
        a, b = stub_compose(run)
        fake_api = type(sys)("tinhat.apiconf"); fake_api.write = lambda *x, **k: True
        fake_inst = type(sys)("tinhat.install"); fake_inst.refresh_configs_locked = lambda *x, **k: _done([])
        pkg = sys.modules["tinhat"]
        with a, b, mock.patch.dict(sys.modules, {"tinhat.apiconf": fake_api, "tinhat.install": fake_inst}), \
             mock.patch.object(pkg, "apiconf", fake_api, create=True), mock.patch.object(pkg, "install", fake_inst, create=True), \
             mock.patch.object(P.state, "load_state", side_effect=lambda: dict(box)), mock.patch.object(P, "call_live", new=lambda: _done(False)), \
             mock.patch.object(P, "save", return_value={"enabled": True, "rig_phone_apps": False, "day_max": 8, "start": 10}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = P.cli(["config", "enabled=on"])
        self.assertEqual(rc, 4)
        self.assertIn("Saved, but the games are OFF until the safety check (G9) has passed", out.getvalue())
        # ENSURE makes the role, G9 is clean: the pass is recorded, the API restart is queued, the switch takes effect
        ok, _ = G9Block.run_ensure(self, box, [])
        self.assertTrue(ok)
        self.assertIsInstance(box.get("play_g9_ok"), int)
        self.assertTrue(box.get("play_api_restart"), "the API is recreated (once no call is live) with the games on")
        self.assertIs(P.features(box)["play"], True)
        self.assertEqual(P.env_lines(box | {"play_db_port": 5433}, {**SECRETS, "play_db_password": "p" * 32})["PLAY_ENABLED"], "1")
        self.assertEqual(P.block_note(box), "")
        # and a later finding clears the record: off again
        G9Block.run_ensure(self, box, ["table|public.users|SELECT"])
        self.assertIsNone(box.get("play_g9_ok"))
        self.assertIs(P.features(box)["play"], False)

    def test_a_restored_box_checks_its_own_g9_before_the_games_may_be_on(self):
        src = (_OPT / "manager" / "tinhat" / "install.py").read_text()
        seg = src[src.index("drop = {"):src.index("}", src.index("drop = {"))]
        for k in ("play_g9_ok", "play_g9_block", "play_g9_block_at", "play_api_restart"):
            self.assertIn(f'"{k}"', seg, f"the old box's {k} is never carried into a restore")


class UpdateKeepsGamesOn(unittest.TestCase):
    """PM 15:59 / 16:30: a 0.3.20 → 0.3.21 update must never turn a running box's games off. On 0.3.20 the default is
    OFF, so the only ways games are on are the dashboard and the CLI, and both store `enabled: True` (play.save keeps
    every changed key); 0.3.21 reads that key. lab7 flipped only because it ran round 1's pre-release manager (60af8c7),
    whose default was ON and never stored."""

    def test_switched_on_the_0320_way_stays_on(self):
        # the 0.3.20 write paths: web.py keeps a field only if it differs from the default (off), then play.save()
        web = (_OPT / "manager" / "tinhat" / "web.py").read_text()
        self.assertIn("if v != cur[name]:", web)
        self.assertIn('play.save(play_changes, s_["mxid"])', web)
        st = {"server_name": "a.local", "play_g9_ok": 1}
        with mock.patch.object(play.state, "load_state", return_value=st), \
             mock.patch.object(play.state, "save_state", side_effect=lambda **kw: {**st, **kw}) as saved:
            play.save({"enabled": True}, who="@owner:a.local")
        stored = saved.call_args.kwargs["play"]
        self.assertIs(stored.get("enabled"), True, "switching on stores the key")
        after = {**st, "play": stored}
        self.assertIs(play.settings(after)["enabled"], True)
        self.assertIs(play.effective(after), True, "0.3.21 keeps the games on")
        self.assertEqual(play.env_lines(after, {**SECRETS, "play_db_password": "p" * 32})["PLAY_ENABLED"], "1")

    def test_the_lab7_shape_is_the_only_one_that_flips(self):
        # games on with NO stored key = round 1's pre-release default; on 0.3.20 that state means OFF already
        self.assertIs(play.PLAY_DEFAULTS["enabled"], False)
        self.assertIs(play.effective({"play": {}, "play_g9_ok": 1}), False)

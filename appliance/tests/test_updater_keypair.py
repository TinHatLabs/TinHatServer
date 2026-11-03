"""The update snapshot keeps the call server's key pair (0.3.12, for 0.3.13's one-time LiveKit key rotation): the pair
lives in secrets.json (the source), compose.env (lk-jwt), livekit/livekit.yaml (LiveKit), api/env (the API's
LK_API_KEY) and api/livekit.secret (the API's secret). The services start on the restored files before the old manager
rewrites anything, so a rollback has to bring back every copy, or LiveKit, lk-jwt and the API come up on different
pairs (calls fail until the next config refresh). The files are made with the real templates; Docker is stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import apiconf, config, hw, templates  # noqa: E402

# Other test modules stub the package's modules in sys.modules; the templates reach them through the package.
REAL = {"tinhat.hw": hw, "tinhat.apiconf": apiconf, "tinhat.config": config, "tinhat.templates": templates}

UPDATER = _OPT / "manager" / "tinhat" / "updater.py"
spec = importlib.util.spec_from_file_location("tinhat_updater_keypair_under_test", UPDATER)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

SN = "crew.tinhat.test"
BASE = {"registration_shared_secret": "reg", "macaroon_secret_key": "mac", "form_secret": "form",
        "postgres_password": "pg", "system_token": "syt_x"}
# test-only values, never a real server's
OLD = {"livekit_key": "tinhatold0", "livekit_secret": "old-" + "a" * 40}
NEW = {"livekit_key": "tinhatnew1", "livekit_secret": "new-" + "b" * 40}
PAIR_FILES = ("secrets.json", "compose.env", "livekit/livekit.yaml", "api/env", "api/livekit.secret")


class R:
    def __init__(self, rc=0):
        self.returncode, self.stdout, self.stderr = rc, b"", b""


def fake_sh(*cmd, timeout=600, stdin=None, stdout=None, cwd=None):
    if "pg_dump" in cmd and stdout is not None:
        stdout.write(b"PGDMP" + b"\0" * 4096)
    return R(0)


def generated(s: dict) -> dict[str, str]:
    """What the manager writes for these secrets (install.refresh_configs / apiconf.write), file by file."""
    with mock.patch.dict(sys.modules, REAL), \
            mock.patch.object(templates, "_turn_servers", return_value=""), \
            mock.patch.object(templates, "_docker_subnets", return_value=[]), \
            mock.patch.object(templates, "_self_ip", return_value="127.0.1.1"):
        return {
            "secrets.json": json.dumps(s, indent=1) + "\n",
            "compose.env": templates.compose_env(SN, s, lan=False),
            "livekit/livekit.yaml": templates.livekit_yaml(s),
            "api/env": apiconf.env_text(SN, s, "198.18.16.1"),
            "api/livekit.secret": s["livekit_secret"],
        }


def write_box(state: Path, s: dict) -> None:
    for name, text in generated(s).items():
        p = state / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        p.chmod(0o600)
    (state / "state.json").write_text(json.dumps({"phase": "ready", "server_name": SN}))


def pairs(state: Path) -> dict[str, tuple]:
    """The key and/or secret each place holds (None where that place holds only one half)."""
    sec = json.loads((state / "secrets.json").read_text())
    env = dict(l.split("=", 1) for l in (state / "compose.env").read_text().splitlines() if "=" in l)
    m = re.search(r"^keys:\n  (\S+): (\S+)$", (state / "livekit/livekit.yaml").read_text(), re.M)
    api = dict(l.split("=", 1) for l in (state / "api/env").read_text().splitlines() if "=" in l)
    return {"secrets.json": (sec["livekit_key"], sec["livekit_secret"]),
            "compose.env (lk-jwt)": (env["LIVEKIT_KEY"], env["LIVEKIT_SECRET"]),
            "livekit.yaml (LiveKit)": (m.group(1), m.group(2)) if m else None,
            "api/env (API key)": (api["LK_API_KEY"], None),  # KeyError, not a pass, if the API lost its key
            "api/livekit.secret (API secret)": (None, (state / "api/livekit.secret").read_text())}


def no_date(text: str) -> str:
    return re.sub(r"\d{4}-\d\d-\d\d \d\d:\d\d UTC", "<date>", text)


class Box(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state, self.opt, self.snap = self.tmp / "state", self.tmp / "opt", self.tmp / "snap"
        (self.opt / "web").mkdir(parents=True)
        (self.opt / "VERSION").write_text("0.3.12\n")
        self.saved = {k: getattr(updater, k) for k in ("sh", "say", "STATE", "OPT")}
        updater.sh, updater.say, updater.STATE, updater.OPT = fake_sh, (lambda *_: None), self.state, self.opt
        write_box(self.state, BASE | OLD)
        self.before = {n: (self.state / n).read_bytes() for n in PAIR_FILES}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(updater, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def update_rotates_the_pair(self):
        """What 0.3.13's update does once: a new pair in every place."""
        updater.snapshot(self.snap)
        write_box(self.state, BASE | NEW)
        self.assertNotEqual((self.state / "api/env").read_bytes(), self.before["api/env"])  # the rotation took


class Snapshot(Box):
    def test_items_named(self):
        self.assertIn("api/env", updater.STATE_ITEMS)
        self.assertIn("api/livekit.secret", updater.STATE_ITEMS)

    def test_snapshot_holds_every_copy_of_the_pair(self):
        updater.snapshot(self.snap)
        for name in PAIR_FILES:
            p = self.snap / "state" / name
            self.assertTrue(p.is_file(), f"{name} isn't in the update snapshot")
            self.assertEqual(p.read_bytes(), self.before[name], name)
            self.assertEqual(p.stat().st_mode & 0o077, 0, f"{name}: the copy is readable by others")


class Rollback(Box):
    def test_rollback_restores_the_pair_byte_identical(self):
        self.update_rotates_the_pair()
        updater.restore_files(self.snap)
        for name in PAIR_FILES:
            self.assertEqual((self.state / name).read_bytes(), self.before[name], f"{name} wasn't rolled back")
            self.assertEqual((self.state / name).stat().st_mode & 0o777, 0o600, name)

    def test_after_rollback_livekit_lkjwt_and_api_share_one_pair(self):
        self.update_rotates_the_pair()
        updater.restore_files(self.snap)
        got = pairs(self.state)
        want = (OLD["livekit_key"], OLD["livekit_secret"])
        for place, pair in got.items():
            self.assertIsNotNone(pair, place)
            for half, w in zip(pair, want):
                if half is not None:
                    self.assertEqual(half, w, f"{place} is on another pair after the rollback")
        # and each file is exactly what the old manager makes from the restored secrets.json (nothing to rewrite)
        regen = generated(json.loads((self.state / "secrets.json").read_text()))
        for name in PAIR_FILES:
            self.assertEqual(no_date((self.state / name).read_text()), no_date(regen[name]), name)


class Manager:
    def __init__(self):
        self.calls = []

    def stop(self):
        self.calls.append("stop")

    def start(self):
        self.calls.append("start")


class FullRollback(Box):
    """updater.rollback() itself: the pair the services START on (compose up) is the old one, in all five places."""

    def setUp(self):
        super().setUp()
        names = ("MANAGER", "restore_db", "healthy", "status", "add_history", "retag")
        self.saved |= {k: getattr(updater, k) for k in names}
        self.at_up = []

        def sh(*cmd, **kw):
            if "up" in cmd:
                self.at_up.append(pairs(self.state))
            return fake_sh(*cmd, **kw)
        updater.sh, updater.MANAGER = sh, Manager()
        updater.restore_db = lambda snap: True
        updater.healthy = lambda frm, wait: (True, [])
        updater.status = lambda **kw: None
        updater.add_history = lambda h: None
        updater.retag = lambda lock: None

    def test_services_start_on_the_old_pair(self):
        self.update_rotates_the_pair()
        self.assertEqual(updater.rollback(self.snap, "0.3.13", "0.3.12", "test"), 1)
        self.assertTrue(self.at_up, "the rollback never started the services")
        want = (OLD["livekit_key"], OLD["livekit_secret"])
        for place, pair in self.at_up[0].items():
            for half, w in zip(pair, want):
                if half is not None:
                    self.assertEqual(half, w, f"{place}: the services started on another pair")
        self.assertEqual(updater.MANAGER.calls[-1], "start")

    def test_rollback_survives_a_release_that_dropped_the_api_folder(self):
        self.update_rotates_the_pair()
        shutil.rmtree(self.state / "api")
        updater.rollback(self.snap, "0.3.13", "0.3.12", "test")
        for name in ("api/env", "api/livekit.secret"):
            self.assertEqual((self.state / name).read_bytes(), self.before[name], name)


if __name__ == "__main__":
    unittest.main()

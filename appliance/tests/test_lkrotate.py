"""0.3.13 lkrotate (PAD-PHONE Step A): the call-server key pair is replaced once, and only when this update's safety copy
keeps the API's copy of the key (so a failed update's rollback can't leave the key pairs mixed); new servers count as
replaced.    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "appliance/rootfs/opt/tinhat/manager/tinhat"


class LkRotate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        cfg = types.ModuleType("tinhat_lkr.config")
        cfg.SECRETS_FILE = d / "secrets.json"
        cfg.STATE_DIR = d
        st = types.ModuleType("tinhat_lkr.state")
        st.load_secrets = lambda: json.loads(cfg.SECRETS_FILE.read_text())
        def save(**ch):
            s = st.load_secrets(); s.update(ch); cfg.SECRETS_FILE.write_text(json.dumps(s)); return s
        st.save_secrets = save
        pkg = types.ModuleType("tinhat_lkr"); pkg.__path__ = []; pkg.config = cfg; pkg.state = st
        sys.modules.update({"tinhat_lkr": pkg, "tinhat_lkr.config": cfg, "tinhat_lkr.state": st})
        spec = importlib.util.spec_from_file_location("tinhat_lkr.lkrotate", PKG / "lkrotate.py")
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)
        self.d, self.cfg = d, cfg

    def tearDown(self):
        for k in ("tinhat_lkr", "tinhat_lkr.config", "tinhat_lkr.state", "tinhat_lkr.lkrotate"):
            sys.modules.pop(k, None)
        self.tmp.cleanup()

    def secrets(self, **x):
        self.cfg.SECRETS_FILE.write_text(json.dumps({"livekit_key": "tinhatold1", "livekit_secret": "s" * 43, "postgres_password": "p", **x}))

    def snapshot(self, name, api=True):
        s = self.d / "updates" / "snapshots" / name / "state"
        (s / "livekit").mkdir(parents=True)
        if api:
            (s / "api").mkdir()
            (s / "api" / "env").write_text("LK_API_KEY=tinhatold1\n")
            (s / "api" / "livekit.secret").write_text("s" * 43)
        t = time.time() + len(list((self.d / "updates" / "snapshots").iterdir()))
        os.utime(s.parent, (t, t))

    def test_replaced_once_when_the_safety_copy_keeps_the_apis_key(self):
        self.secrets(); self.snapshot("0.3.12-to-0.3.13")
        self.assertIn("replaced", self.m.maybe_rotate())
        s = json.loads(self.cfg.SECRETS_FILE.read_text())
        self.assertNotEqual(s["livekit_key"], "tinhatold1"); self.assertNotEqual(s["livekit_secret"], "s" * 43)
        self.assertEqual(s["livekit_rotated"], "0.3.13"); self.assertEqual(s["postgres_password"], "p")
        key = s["livekit_key"]
        self.assertIn("already", self.m.maybe_rotate())
        self.assertEqual(json.loads(self.cfg.SECRETS_FILE.read_text())["livekit_key"], key, "only once")

    def test_not_replaced_when_an_older_updaters_copy_lacks_the_apis_key(self):
        self.secrets(); self.snapshot("0.3.11-to-0.3.13", api=False)
        self.assertIn("NOT replaced", self.m.maybe_rotate())
        s = json.loads(self.cfg.SECRETS_FILE.read_text())
        self.assertEqual((s["livekit_key"], s.get("livekit_rotated")), ("tinhatold1", None))
        self.snapshot("0.3.13-to-0.3.14", api=True)  # the next update (this release's updater keeps the copy)
        self.assertIn("replaced", self.m.maybe_rotate())

    def test_a_new_server_and_a_server_not_set_up(self):
        self.assertIn("not set up", self.m.maybe_rotate())
        self.secrets(livekit_rotated="new")
        self.assertIn("already", self.m.maybe_rotate())


if __name__ == "__main__":
    unittest.main()

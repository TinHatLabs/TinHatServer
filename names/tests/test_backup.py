"""tinhat-names backup: what a copy holds (an online copy of the database, the settings and keys, the zone or why it
couldn't be read), and that it refuses to run without a repository. restic itself is exercised in the lab
(PLAN.md 2026-10-18). Runs anywhere:
    python3 -m unittest discover -s names/tests
"""
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names import backup, config as config_mod  # noqa: E402
from tinhat_names.db import DB  # noqa: E402


class Stage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        for f, v in (("admin.token", "a"), ("cf.token", "c"), ("pow.key", "k")):
            (d / f).write_text(v)
        self.cfg = config_mod.load(None)
        self.cfg.update(db=str(d / "names.db"), admin_token_file=str(d / "admin.token"), secret_key_file=str(d / "pow.key"))
        self.cfg["dns"].update(token_file=str(d / "cf.token"), api_base="http://127.0.0.1:9")  # nothing answers there
        self.cfg["backup"].update(staging=str(d / "staging"), password_file=str(d / "pass"))
        db = DB(self.cfg["db"])
        db.create("crew", "11.91.0.2", None)
        db.create("lanparty", "11.91.0.3", None)
        db.set("lanparty", status="retired")

    def tearDown(self):
        self.tmp.cleanup()

    def test_what_a_copy_holds(self):
        meta = backup.stage(self.cfg, None)
        st = pathlib.Path(meta["dir"])
        self.assertEqual(meta["names"], {"active": 1, "retired": 1})
        n = sqlite3.connect(st / "names.db").execute("SELECT COUNT(*) FROM names").fetchone()[0]
        self.assertEqual(n, 2)
        self.assertEqual(sorted(p.name for p in (st / "etc").iterdir()), ["admin.token", "cf.token", "pow.key"])
        self.assertIsNone(meta["zone_records"])  # the DNS API didn't answer: noted, and the database still copied
        self.assertTrue((st / "zone-error.txt").exists())
        self.assertEqual(json.loads((st / "backup.json").read_text())["names"], {"active": 1, "retired": 1})

    def test_needs_a_repository(self):
        with self.assertRaises(backup.BackupError):
            backup.backup(self.cfg, None)


if __name__ == "__main__":
    unittest.main()

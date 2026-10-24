"""rotate (a restored server takes its name over) and notices to every server. Database level; no network."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names.db import DB  # noqa: E402


class Rotate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(str(pathlib.Path(self.tmp.name) / "names.db"))
        self.box, self.secret = self.db.create("crew", "11.91.0.2", None)

    def tearDown(self):
        self.tmp.cleanup()

    def test_new_key_works_old_one_says_moved(self):
        new = self.db.rotate("crew")
        self.assertIsNotNone(self.db.auth(self.box, new))
        self.assertIsNone(self.db.auth(self.box, self.secret))
        self.assertTrue(self.db.moved(self.box, self.secret))
        self.assertFalse(self.db.moved(self.box, "a guess"))
        self.assertFalse(self.db.moved("nobody", self.secret))

    def test_rotating_twice_keeps_both_old_keys_moved(self):
        second = self.db.rotate("crew")
        third = self.db.rotate("crew")
        self.assertTrue(self.db.moved(self.box, self.secret))
        self.assertTrue(self.db.moved(self.box, second))
        self.assertIsNotNone(self.db.auth(self.box, third))

    def test_notice_all_reaches_active_servers_only(self):
        self.db.create("squad", "11.91.0.9", None)
        self.db.create("gone", "11.91.0.10", None)
        self.db.set("gone", status="retired")
        self.assertEqual(self.db.notice_all("Planned maintenance tonight."), 2)
        self.assertEqual([n["text"] for n in self.db.take_notices("crew")], ["Planned maintenance tonight."])
        self.assertEqual(self.db.take_notices("gone"), [])

    def test_old_database_gets_the_new_column(self):
        path = pathlib.Path(self.tmp.name) / "old.db"
        import sqlite3
        c = sqlite3.connect(path)
        c.execute("CREATE TABLE names (name TEXT PRIMARY KEY, status TEXT NOT NULL, box_id TEXT UNIQUE NOT NULL, "
                  "secret_hash TEXT NOT NULL, created REAL NOT NULL, created_ip TEXT, ip4 TEXT, ip6 TEXT, last_seen REAL, "
                  "last_change REAL, code TEXT, reason TEXT, version TEXT, strikes INTEGER NOT NULL DEFAULT 0)")
        c.commit()
        c.close()
        db = DB(str(path))
        self.assertIn("old_hashes", {r[1] for r in db.c.execute("PRAGMA table_info(names)")})


if __name__ == "__main__":
    unittest.main()

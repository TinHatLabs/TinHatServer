"""Server codes are stored hashed (security review, names lows; sec-night-2 2026-10-27): a copy of the database holds
no working code (an HMAC keyed from the service's secret key file, not a plain hash: a code has ~40 bits), an older
database is migrated in place (uses, limits, notes, revocations kept; names.code becomes the hint; the plain codes are
gone from the file), admins see a hint + id, and a single-use code can't be spent twice.

    python3 -m unittest discover -s names/tests
"""
import hashlib
import os
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tinhat_names.db import DB, code_hint, code_key  # noqa: E402

KEY = code_key(b"k" * 32)


def file_bytes(path):
    out = b""
    for p in (path, path + "-wal", path + "-shm"):
        if os.path.exists(p):
            with open(p, "rb") as f:
                out += f.read()
    return out


class Fresh(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.d.name, "names.db")
        self.db = DB(self.path, code_key=KEY)

    def tearDown(self):
        self.db.c.close()
        self.d.cleanup()

    def test_the_code_itself_is_never_stored(self):
        c = self.db.new_code(max_uses=2, days=1, note="Sam")
        self.db.c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        raw = file_bytes(self.path)
        self.assertNotIn(c.encode(), raw)
        self.assertNotIn(hashlib.sha256(c.encode()).hexdigest().encode(), raw, "keyed, not a plain hash")
        rows = self.db.codes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["code"], code_hint(c))
        self.assertNotIn("code_hash", rows[0])
        self.assertTrue(self.db.code_ok(c.lower()))

    def test_another_key_opens_no_code(self):
        c = self.db.new_code()
        other = DB(self.path, code_key=code_key(b"x" * 32))
        self.assertFalse(other.code_ok(c))
        other.c.close()

    def test_a_single_use_code_is_spent_once(self):
        c = self.db.new_code(max_uses=1)
        self.assertTrue(self.db.use_code(c))
        self.assertFalse(self.db.use_code(c), "the second registration can't spend it again")
        self.assertFalse(self.db.code_ok(c))
        self.db.unuse_code(c)  # a registration that didn't happen gives it back
        self.assertTrue(self.db.code_ok(c))

    def test_expired_and_revoked_codes_spend_nothing(self):
        c = self.db.new_code(days=1)
        self.db.c.execute("UPDATE codes SET expires=?", (time.time() - 1,))  # its day is over
        self.assertFalse(self.db.use_code(c))
        c2 = self.db.new_code()
        cid = self.db.codes()[0]["id"]
        self.assertTrue(self.db.revoke_code(str(cid)), "revoke by the list's id")
        self.assertFalse(self.db.use_code(c2))
        c3 = self.db.new_code()
        self.assertTrue(self.db.revoke_code(c3.lower()), "revoke by the code itself")
        self.assertFalse(self.db.code_ok(c3))
        self.assertFalse(self.db.revoke_code("TN-AB…"), "a hint revokes nothing")
        self.assertFalse(self.db.revoke_code("not a code"))
        self.assertIsNone(self.db.code("../../etc"))


class Register(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.db = DB(os.path.join(self.d.name, "names.db"), code_key=KEY)

    def tearDown(self):
        self.db.c.close()
        self.d.cleanup()

    def test_the_name_and_the_code_go_together(self):
        c = self.db.new_code(max_uses=1)
        box, secret = self.db.register("crew", "203.0.113.5", c, need_code=True)
        row = self.db.name("crew")
        self.assertEqual((row["code"], row["code_id"]), (code_hint(c), self.db.codes()[0]["id"]))
        self.assertFalse(self.db.code_ok(c))
        self.assertEqual(self.db.register("other", "203.0.113.6", c, need_code=True), "code", "spent once")
        self.assertIsNone(self.db.name("other"))

    def test_a_taken_name_spends_nothing(self):
        c = self.db.new_code(max_uses=1)
        self.db.register("crew", "203.0.113.5", None, need_code=False)
        self.assertEqual(self.db.register("crew", "203.0.113.5", c, need_code=True), "taken")
        self.assertTrue(self.db.code_ok(c), "the use came back with the rollback")
        self.assertFalse(self.db.c.in_transaction)

    def test_without_invites_a_code_is_optional(self):
        self.assertIsInstance(self.db.register("free", "203.0.113.7", None, need_code=False), tuple)
        self.assertEqual(self.db.register("nocode", "203.0.113.7", "TN-AAAA-AAAA", need_code=True), "code")


class Migration(unittest.TestCase):
    OLD = """
    CREATE TABLE names (name TEXT PRIMARY KEY, status TEXT NOT NULL, box_id TEXT UNIQUE NOT NULL, secret_hash TEXT NOT NULL,
        created REAL NOT NULL, created_ip TEXT, ip4 TEXT, ip6 TEXT, last_seen REAL, last_change REAL, code TEXT,
        reason TEXT, version TEXT, strikes INTEGER NOT NULL DEFAULT 0, old_hashes TEXT);
    CREATE TABLE codes (code TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL, uses INTEGER NOT NULL DEFAULT 0,
        max_uses INTEGER NOT NULL DEFAULT 1, note TEXT, revoked INTEGER NOT NULL DEFAULT 0);
    """

    def test_an_older_database_is_migrated_in_place(self):
        d = tempfile.TemporaryDirectory()
        path = os.path.join(d.name, "names.db")
        old = sqlite3.connect(path)
        old.executescript(self.OLD)
        now = time.time()
        codes = {"open": "TN-ABCD-EFGH", "used": "TN-JKLM-NPQR", "revoked": "TN-STUV-WXYZ", "multi": "TN-2345-6789"}
        old.executemany("INSERT INTO codes(code,created,expires,uses,max_uses,note,revoked) VALUES(?,?,?,?,?,?,?)", [
            (codes["open"], now - 30, now + 86400, 0, 1, "Sam", 0),
            (codes["used"], now - 20, now + 86400, 1, 1, "Ana", 0),
            (codes["revoked"], now - 10, None, 0, 1, "", 1),
            (codes["multi"], now, None, 1, 5, "friends", 0)])
        old.execute("INSERT INTO names(name,status,box_id,secret_hash,created,code) VALUES('crew','active','b1','h',?,?)",
                    (now, codes["used"]))
        old.commit()
        old.close()
        db = DB(path, code_key=KEY)
        self.assertTrue(db.code_ok(codes["open"]))
        self.assertFalse(db.code_ok(codes["used"]))
        self.assertFalse(db.code_ok(codes["revoked"]))
        self.assertTrue(db.code_ok(codes["multi"]))
        rows = {r["code"]: r for r in db.codes()}
        self.assertEqual(rows[code_hint(codes["multi"])]["uses"], 1)
        self.assertEqual(rows[code_hint(codes["multi"])]["max_uses"], 5)
        self.assertEqual(rows[code_hint(codes["open"])]["note"], "Sam")
        self.assertEqual(db.name("crew")["code"], code_hint(codes["used"]))
        used_id = [r["id"] for r in db.codes() if r["note"] == "Ana"][0]
        self.assertEqual(db.name("crew")["code_id"], used_id, "which code set it up, unambiguously")
        self.assertEqual(db.c.execute("SELECT COUNT(*) FROM events WHERE kind='codes-vacuumed'").fetchone()[0], 1)
        self.assertEqual(db.c.execute("SELECT COUNT(*) FROM events WHERE kind='codes-hashed'").fetchone()[0], 1)
        db.c.close()
        raw = file_bytes(path)
        for c in codes.values():
            self.assertNotIn(c.encode(), raw, f"{c} left in the file")
        db2 = DB(path, code_key=KEY)  # the next start: nothing to do
        self.assertEqual(db2.c.execute("SELECT COUNT(*) FROM events WHERE kind='codes-hashed'").fetchone()[0], 1)
        self.assertTrue(db2.code_ok(codes["open"]))
        db2.c.close()
        d.cleanup()


class Concurrent(unittest.TestCase):
    def test_two_starts_migrating_at_once_both_come_up(self):
        d = tempfile.TemporaryDirectory()
        path = os.path.join(d.name, "names.db")
        old = sqlite3.connect(path)
        old.executescript(Migration.OLD)
        old.execute("INSERT INTO codes(code,created) VALUES('TN-ABCD-EFGH', 1)")
        old.commit()
        old.close()
        b = DB(path, code_key=KEY)  # the other start migrated...

        class Stale:  # ...after this one had read the old schema (its first look says "code")
            def __init__(self, real):
                self.real, self.first = real, True

            def execute(self, sql, *args):
                if self.first and sql.startswith("PRAGMA table_info(codes)"):
                    self.first = False
                    return iter([(0, "code"), (1, "created")])
                return self.real.execute(sql, *args)

            def __getattr__(self, k):
                return getattr(self.real, k)

        a = DB.__new__(DB)
        a.code_key = KEY
        real = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        real.row_factory = sqlite3.Row
        a.c = Stale(real)
        a._migrate_codes()  # finds it done under the lock: no error, nothing touched
        self.assertFalse(real.in_transaction)
        self.assertTrue(b.code_ok("TN-ABCD-EFGH"))
        self.assertEqual(b.c.execute("SELECT COUNT(*) FROM events WHERE kind='codes-hashed'").fetchone()[0], 1)
        real.close()
        b.c.close()
        d.cleanup()


class Wiring(unittest.TestCase):
    def test_the_service_keys_the_database_and_spends_before_creating(self):
        src = open(os.path.join(os.path.dirname(__file__), "..", "tinhat_names", "app.py")).read()
        self.assertIn('self.db = DB(cfg["db"], code_key=code_key(self.key))', src)
        self.assertIn("self.db.register(name, ip, code or None, need_code=", src)
        self.assertNotIn("self.db.create(name, ip, code", src)


if __name__ == "__main__":
    unittest.main()

"""Security review 2026-10-26 (detail/02 + 07): the database is the service's alone even in a folder that already
existed (StateDirectoryMode= doesn't change one), server codes never reach the audit log whole, and every per-address
limit counts an IPv6 caller by its /64. Runs anywhere:
    python3 -m unittest discover -s names/tests
"""
import os
import pathlib
import re
import stat
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names.db import DB, caller_net, canon_ip, code_hint  # noqa: E402

APP = pathlib.Path(__file__).resolve().parents[1] / "tinhat_names" / "app.py"
UNIT = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "tinhat-names.service"
mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)  # noqa: E731


class PrivateFiles(unittest.TestCase):
    def test_a_folder_and_database_that_already_existed_are_tightened(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = os.path.join(tmp, "tinhat-names")
            os.mkdir(d)
            path = os.path.join(d, "names.db")
            DB(path).create("crew", "203.0.113.5", None)
            os.chmod(d, 0o755)  # as the live one was: 755 folder, 644 database
            os.chmod(path, 0o644)
            for side in ("-wal", "-shm"):
                if os.path.exists(path + side):
                    os.chmod(path + side, 0o644)
            DB(path)  # the next start
            self.assertEqual(mode(d), 0o700)
            self.assertEqual(mode(path), 0o600)
            for side in ("-wal", "-shm"):
                if os.path.exists(path + side):
                    self.assertEqual(mode(path + side), 0o600, side)

    def test_a_shared_folder_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o1777)  # like /tmp
            DB(os.path.join(tmp, "names.db"))
            self.assertEqual(mode(tmp), 0o1777)
            self.assertEqual(mode(os.path.join(tmp, "names.db")), 0o600)

    def test_the_unit_keeps_new_files_private(self):
        self.assertIn("\nUMask=0077\n", UNIT.read_text())


class Codes(unittest.TestCase):
    def test_only_a_hint(self):
        self.assertEqual(code_hint("TN-ABCD-EFGH"), "TN-AB…")
        self.assertEqual(code_hint(" tn-abcd-efgh "), "TN-AB…")
        self.assertEqual(code_hint(""), "")
        self.assertEqual(code_hint(None), "")

    def test_no_event_carries_a_whole_code(self):
        src = APP.read_text()
        events = re.findall(r"self\.db\.event\([^\n]*", src)
        self.assertTrue(events)
        for line in events:
            self.assertNotRegex(line, r"\{code\}", line)
        self.assertIn('f"code={code_hint(code)}"', src)
        self.assertIn("code_hint(code)} {body.get('note', '')}", src)


class PerCaller(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(os.path.join(self.tmp.name, "names.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_caller_net(self):
        self.assertEqual(str(caller_net("203.0.113.5")), "203.0.113.5/32")
        self.assertEqual(str(caller_net("2001:db8:1:2:aaaa::1")), "2001:db8:1:2::/64")
        self.assertEqual(str(caller_net("::ffff:203.0.113.5")), "203.0.113.5/32")
        self.assertIsNone(caller_net("nope"))
        self.assertIsNone(caller_net(""))

    def test_burst_limits_count_a_64_registrations_count_addresses(self):
        # review of 116d103, #7: a hosting provider's customers each get one address out of a shared /64, so a /64
        # must not share one registration a day; burst limits (probe-open) keep the /64
        now = time.time()
        for i in range(3):
            self.db.event("register", f"n{i}", f"2001:db8:1:2::{i + 1}")
            self.db.event("probe-open", f"h{i}", f"2001:db8:1:2::{i + 1}")
        self.db.event("register", "other", "2001:db8:1:3::1")  # the next /64: someone else
        self.db.event("register", "v4", "203.0.113.5")
        self.assertEqual(self.db.count("register", now - 60, ip="2001:db8:1:2:ffff::9"), 0, "a neighbour in the /64")
        self.assertEqual(self.db.count("register", now - 60, ip="2001:db8:1:2::2"), 1)
        self.assertEqual(self.db.count("register", now - 60, ip="2001:db8:1:2:0:0:0:2"), 1, "any spelling")
        self.assertEqual(self.db.count("probe-open", now - 60, ip="2001:db8:1:2:ffff::9", per="net"), 3, "burst: the /64")
        self.assertEqual(self.db.count("probe-open", now - 60, ip="2001:db8:1:3::7", per="net"), 0)
        self.assertEqual(self.db.count("register", now - 60, ip="203.0.113.5"), 1)
        self.assertEqual(self.db.count("register", now - 60, ip="203.0.113.6"), 0)
        self.assertEqual(self.db.count("register", now - 60), 5)
        self.assertEqual(self.db.count("register", now - 60, name="n1", ip="2001:db8:1:2::2"), 1)
        self.assertEqual(self.db.count("register", now + 60, ip="2001:db8:1:2::1"), 0)  # the time window still holds

    def test_live_names_per_address(self):
        self.db.create("a", "2001:db8:1:2::1", None)
        self.db.create("b", "2001:db8:1:2:9::1", None)
        self.db.create("c", "2001:db8:1:2::1", None)
        self.db.create("d", "203.0.113.5", None)
        self.db.set("c", status="retired")
        self.assertEqual(self.db.live_for_ip("2001:db8:1:2::1"), 1)  # c is retired, b is a neighbour
        self.db.set("c", status="active")
        self.assertEqual(self.db.live_for_ip("2001:DB8:1:2:0::1"), 2)
        self.assertEqual(self.db.live_for_ip("2001:db8:1:2::abcd"), 0, "the rest of the /64 is somebody else")
        self.assertEqual(self.db.live_for_ip("203.0.113.5"), 1)
        self.assertEqual(self.db.live_for_ip("203.0.113.9"), 0)

    def test_ipv4_mapped_is_the_same_caller_both_ways(self):
        # second review: the IPv4 path compared the raw string, so the two spellings of one caller had two quotas
        now = time.time()
        self.db.create("m1", "::ffff:203.0.113.5", None)
        self.db.create("m2", "203.0.113.5", None)
        self.db.event("register", "m1", "::ffff:203.0.113.5")
        self.db.event("register", "m2", "203.0.113.5")
        for spelling in ("203.0.113.5", "::ffff:203.0.113.5", "::FFFF:cb00:7105"):
            with self.subTest(spelling=spelling):
                self.assertEqual(self.db.live_for_ip(spelling), 2)
                self.assertEqual(self.db.count("register", now - 60, ip=spelling), 2)
        self.assertEqual(self.db.c.execute("SELECT created_ip FROM names WHERE name='m1'").fetchone()[0], "203.0.113.5",
                         "stored in one spelling")
        self.assertEqual(self.db.c.execute("SELECT ip FROM events WHERE name='m1'").fetchone()[0], "203.0.113.5")

    def test_rows_written_before_canon_still_count(self):
        now = time.time()
        # as an older version wrote them: the raw mapped spelling
        self.db.c.execute("INSERT INTO names(name,status,box_id,secret_hash,created,created_ip,last_seen) "
                          "VALUES('old','active','b','h',?,'::ffff:198.51.100.7',?)", (now, now))
        self.db.c.execute("INSERT INTO events(ts,name,kind,ip,detail) VALUES(?,'old','register','::ffff:198.51.100.7','')", (now,))
        self.assertEqual(self.db.live_for_ip("198.51.100.7"), 1)
        self.assertEqual(self.db.count("register", now - 60, ip="198.51.100.7"), 1)
        self.assertEqual(self.db.count("register", now - 60, ip="198.51.100.8"), 0)

    def test_canon_ip(self):
        self.assertEqual(canon_ip("::ffff:203.0.113.5"), "203.0.113.5")
        self.assertEqual(canon_ip("2001:DB8:0:0::1"), "2001:db8::1")
        self.assertEqual(canon_ip(" 203.0.113.5 "), "203.0.113.5")
        self.assertEqual(canon_ip("not an ip"), "not an ip")
        self.assertIsNone(canon_ip(None))
        self.assertEqual(self.db.count("register", time.time() - 60, ip="not an ip"), 0)


if __name__ == "__main__":
    unittest.main()

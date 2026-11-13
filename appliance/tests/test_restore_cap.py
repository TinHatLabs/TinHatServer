"""restorecap (0.3.16): a restic restore writes no more than the backup claims, and the claim must fit the disk first.

The repository's own numbers can lie (deduplication: a tiny repository restores into a huge file or millions of small
ones), so the claim is only the preflight; the watchdog is the cap. Here restic is a stand-in script that writes what
the test tells it to; the real restic runs in the lab (share claude/tinhat-server/server-0315/).
    python3 -m unittest discover -s appliance/tests
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import restorecap  # noqa: E402
from tinhat.restoresafe import UnsafeBackup  # noqa: E402

GB = 1024**3


def roomy(target: Path):
    """The disk's floors never in the way (the restored tree itself is measured for real)."""
    return restorecap.Disk(100 * GB, 10**7, True)


class ClaimFromListing(unittest.TestCase):
    def test_sums_files_and_counts_entries(self):
        lines = [json.dumps({"time": "x", "struct_type": "snapshot", "paths": ["/a"]}),
                 json.dumps({"name": "a", "type": "dir", "path": "/a", "struct_type": "node"}),
                 json.dumps({"name": "db.dump", "type": "file", "path": "/a/db.dump", "size": 1000, "struct_type": "node"}),
                 json.dumps({"name": "x", "type": "file", "path": "/a/x", "size": 24}),  # older restic: no struct_type
                 json.dumps({"name": "l", "type": "symlink", "path": "/a/l"}),
                 "not json", json.dumps([1]),
                 json.dumps({"name": "b", "type": "file", "path": "/a/b", "size": True}),   # not a size
                 json.dumps({"name": "n", "type": "file", "path": "/a/n", "size": -5})]
        c = restorecap.claim(iter(lines))
        self.assertEqual((c.bytes, c.entries), (1024, 6))

    def test_stops_reading_past_the_limit(self):
        def endless():
            i = 0
            while True:
                i += 1
                yield json.dumps({"type": "file", "path": f"/f{i}", "size": 1})
        gen = endless()
        with mock.patch.object(restorecap, "MAX_ENTRIES", 1000), self.assertRaises(UnsafeBackup):
            restorecap.claim(gen)
        self.assertLess(int(json.loads(next(gen))["path"][2:]), 1100)  # it stopped right there

    def test_read_claim_kills_an_endless_listing(self):
        script = "import json,sys\ni=0\nwhile True:\n    i+=1\n    print(json.dumps({'type':'file','path':f'/f{i}','size':1}),flush=True)\n"
        t0 = time.monotonic()
        with mock.patch.object(restorecap, "MAX_ENTRIES", 5000), self.assertRaises(UnsafeBackup):
            restorecap.read_claim([sys.executable, "-c", script], None)
        self.assertLess(time.monotonic() - t0, 20)

    def test_read_claim_survives_a_flood_on_stderr(self):
        script = ("import json,sys\nfor i in range(20000): sys.stderr.write('warning ' + 'x' * 200 + '\\n')\n"
                  "print(json.dumps({'type':'file','path':'/a','size':5}))")
        t0 = time.monotonic()
        c = restorecap.read_claim([sys.executable, "-c", script], None, timeout=60)
        self.assertEqual((c.bytes, c.entries), (5, 1))
        self.assertLess(time.monotonic() - t0, 30)

    def test_a_listing_line_past_the_limit(self):
        script = "import json\nprint(json.dumps({'type':'file','path':'/' + 'a' * (2 * 1024 * 1024),'size':1}))"
        with self.assertRaisesRegex(UnsafeBackup, "list of files"):
            restorecap.read_claim([sys.executable, "-c", script], None, timeout=60)

    def test_read_claim_reports_a_failed_listing(self):
        with self.assertRaisesRegex(UnsafeBackup, "wrong password"):
            restorecap.read_claim([sys.executable, "-c", "import sys; sys.stderr.write('Fatal: wrong password\\n'); sys.exit(1)"],
                                  dict(os.environ))


class Preflight(unittest.TestCase):
    def disk(self, free=50 * GB, inodes=10**6):
        return restorecap.Disk(free, inodes, True)

    def test_fits(self):
        restorecap.preflight(restorecap.Claim(10 * GB, 30_000), self.disk())

    def test_too_big_for_the_free_space(self):
        with self.assertRaisesRegex(UnsafeBackup, "free space"):
            restorecap.preflight(restorecap.Claim(46 * GB, 10), self.disk())  # 46 × 1.1 + 2 > 50

    def test_too_many_entries(self):
        with self.assertRaisesRegex(UnsafeBackup, "files"):
            restorecap.preflight(restorecap.Claim(1, restorecap.MAX_ENTRIES + 1), self.disk())

    def test_not_enough_inodes(self):
        with self.assertRaisesRegex(UnsafeBackup, "room"):
            restorecap.preflight(restorecap.Claim(1, 100_000), self.disk(inodes=100_000))

    def test_a_filesystem_without_inode_counts(self):
        restorecap.preflight(restorecap.Claim(1, 100_000), restorecap.Disk(50 * GB, 0, False))


class Over(unittest.TestCase):
    def test_each_reason(self):
        c = restorecap.Claim(10 * GB, 1000)
        mb, me = restorecap.limits(c)
        roomy = restorecap.Disk(100 * GB, 10**6, True)
        self.assertIsNone(restorecap.over(c, restorecap.Tree(mb, me), roomy))
        self.assertIsNone(restorecap.over(c, None, roomy))
        self.assertEqual(restorecap.over(c, restorecap.Tree(mb + 1, 0), roomy), "bytes")
        self.assertEqual(restorecap.over(c, restorecap.Tree(0, me + 1), None), "files")
        self.assertEqual(restorecap.over(c, None, restorecap.Disk(restorecap.FLOOR_BYTES - 1, 10**6, True)), "free space")
        self.assertEqual(restorecap.over(c, None, restorecap.Disk(100 * GB, 10, True)), "free inodes")
        self.assertIsNone(restorecap.over(c, None, restorecap.Disk(100 * GB, 0, False)))

    def test_tree_counts_what_is_under_the_target_only(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "t"
            (root / "a").mkdir(parents=True)
            (root / "a" / "f").write_bytes(b"x" * 1000)
            outside = Path(d) / "big"
            outside.write_bytes(b"y" * 100_000)
            (root / "link").symlink_to(outside)  # never followed, never counted as bytes
            t = restorecap.tree(root)
            self.assertEqual((t.bytes, t.entries), (1000, 3))


FAKE_RESTIC = textwrap.dedent("""
    import os, sys, time, subprocess
    target, nbytes, nfiles = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    # a child in the same process group: the cap must stop it too
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    open(os.path.join(target, "child.pid"), "w").write(str(child.pid))
    os.makedirs(os.path.join(target, "d"), exist_ok=True)
    chunk = b"\\0" * 65536
    with open(os.path.join(target, "d", "big"), "wb") as f:
        left = nbytes
        while left > 0:
            f.write(chunk[:min(left, 65536)]); f.flush(); left -= 65536
            time.sleep(0.002)
    for i in range(nfiles):
        open(os.path.join(target, "d", f"s{i}"), "wb").close()
        if i % 50 == 0:
            time.sleep(0.002)
    child.kill()
""")


class RunCapped(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.target = self.tmp / "target"
        self.target.mkdir()
        (self.tmp / "fake.py").write_text(FAKE_RESTIC)
        for name, v in (("CLAIM_SLACK", 0.0), ("SLACK_BYTES", 256 * 1024), ("SLACK_ENTRIES", 20), ("POLL", 0.02),
                        ("TREE_EVERY", 0.02)):
            p = mock.patch.object(restorecap, name, v)
            p.start()
            self.addCleanup(p.stop)

    def run_fake(self, claim, nbytes, nfiles, **kw):
        cmd = [sys.executable, str(self.tmp / "fake.py"), str(self.target), str(nbytes), str(nfiles)]
        return restorecap.run_capped(cmd, None, self.target, claim, timeout=60, measure_disk=roomy, **kw)

    def test_honest_restore_passes_and_keeps_its_files(self):
        r = self.run_fake(restorecap.Claim(2 * 1024 * 1024, 100), 2 * 1024 * 1024, 50)
        self.assertEqual(r.returncode, 0)
        self.assertEqual((self.target / "d" / "big").stat().st_size, 2 * 1024 * 1024)

    def test_a_backup_that_writes_more_bytes_than_it_claims_is_stopped(self):
        t0 = time.monotonic()
        with self.assertRaisesRegex(UnsafeBackup, r"bigger than it says \(bytes\)"):
            self.run_fake(restorecap.Claim(1024 * 1024, 100), 200 * 1024 * 1024, 0)  # a 1 MB claim, 200 MB written
        self.assertLess(time.monotonic() - t0, 30)
        self.assertEqual(list(self.target.iterdir()), [])  # nothing it wrote was kept

    def test_a_backup_with_more_files_than_it_claims_is_stopped(self):
        with self.assertRaisesRegex(UnsafeBackup, r"bigger than it says \(files\)"):
            self.run_fake(restorecap.Claim(1024 * 1024, 10), 0, 5000)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_the_disk_floor_stops_it_whatever_it_claimed(self):
        calls = {"n": 0}

        def filling(target):
            calls["n"] += 1
            return restorecap.Disk(100 * GB if calls["n"] < 5 else restorecap.FLOOR_BYTES - 1, 10**6, True)
        with self.assertRaisesRegex(UnsafeBackup, r"\(free space\)"):
            cmd = [sys.executable, str(self.tmp / "fake.py"), str(self.target), str(50 * 1024 * 1024), "0"]
            restorecap.run_capped(cmd, None, self.target, restorecap.Claim(10 * GB, 10**6), 60, measure_disk=filling)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_the_final_check_counts_even_when_restic_fails(self):
        """restic wrote past the claim between two looks, then failed (ENOSPC): still caught, still cleared."""
        script = (f"import sys; open({str(self.target / 'x')!r}, 'wb').write(b'0' * 4 * 1024 * 1024); "
                  "sys.stderr.write('Fatal: no space left on device\\n'); sys.exit(1)")
        with mock.patch.object(restorecap, "TREE_EVERY", 3600):  # no walk while it runs: only the final check sees it
            with self.assertRaisesRegex(UnsafeBackup, r"\(bytes\)"):
                restorecap.run_capped([sys.executable, "-c", script], None, self.target, restorecap.Claim(1024, 1), 60,
                                      measure_disk=roomy)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_a_watchdog_error_stops_restic_and_clears(self):
        pidfile = self.tmp / "pid"
        script = (f"import os, time; open({str(pidfile)!r}, 'w').write(str(os.getpid())); "
                  f"open({str(self.target / 'x')!r}, 'wb').write(b'0'); time.sleep(60)")
        n = {"i": 0}

        def broken(target):
            n["i"] += 1
            if n["i"] > 3:
                raise OSError("statvfs failed")
            return roomy(target)
        with self.assertRaises(OSError):
            restorecap.run_capped([sys.executable, "-c", script], None, self.target, restorecap.Claim(GB, 10), 60,
                                  measure_disk=broken)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertTrue(self._gone(int(pidfile.read_text())), "restic kept running after the watchdog failed")

    def _gone(self, pid: int) -> bool:
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            try:
                if Path(f"/proc/{pid}/stat").read_text().split(")")[1].split()[0] == "Z":
                    return True
            except OSError:
                return True
            time.sleep(0.05)
        return False

    def test_the_whole_process_group_is_stopped(self):
        with self.assertRaises(UnsafeBackup):
            cmd = [sys.executable, "-c", textwrap.dedent(f"""
                import os, subprocess, sys, time
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
                open({str(self.tmp / 'pid')!r}, 'w').write(str(child.pid))
                open({str(self.target / 'x')!r}, 'wb').write(b'0' * 1024 * 1024)
                time.sleep(60)
            """)]
            restorecap.run_capped(cmd, None, self.target, restorecap.Claim(1, 1), timeout=60, measure_disk=roomy)
        self.assertTrue(self._gone(int((self.tmp / "pid").read_text())), "restic's child kept running")

    def test_a_leader_that_exits_leaves_no_child_behind(self):
        script = textwrap.dedent(f"""
            import subprocess, sys
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            open({str(self.tmp / 'pid')!r}, 'w').write(str(child.pid))
        """)
        r = restorecap.run_capped([sys.executable, "-c", script], None, self.target, restorecap.Claim(GB, 100), 60,
                                  measure_disk=roomy)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(self._gone(int((self.tmp / "pid").read_text())))

    def test_restic_failing_on_its_own_comes_back_as_its_result(self):
        r = restorecap.run_capped([sys.executable, "-c", "import sys; sys.stderr.write('Fatal: bad\\n'); sys.exit(1)"],
                                  None, self.target, restorecap.Claim(10, 10), timeout=60, measure_disk=roomy)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Fatal: bad", r.stderr)

    def test_a_flood_of_output_is_kept_as_a_tail(self):
        script = "import sys\nfor i in range(200000): sys.stderr.write(f'line {i} ' + 'x' * 50 + '\\n')\nsys.exit(2)"
        r = restorecap.run_capped([sys.executable, "-c", script], None, self.target, restorecap.Claim(10, 10), 60,
                                  measure_disk=roomy)
        self.assertEqual(r.returncode, 2)
        self.assertLessEqual(len(r.stderr), restorecap.TAIL)
        self.assertIn("line 199999", r.stderr)

    def test_a_slow_walk_never_delays_the_disk_check(self):
        n = {"i": 0}

        def slow(target):
            time.sleep(5)
            return restorecap.Tree()

        def floor(target):
            n["i"] += 1
            return restorecap.Disk(100 * GB if n["i"] < 3 else 0, 10**6, True)
        t0 = time.monotonic()
        with self.assertRaisesRegex(UnsafeBackup, r"\(free space\)"):
            restorecap.run_capped([sys.executable, "-c", "import time; time.sleep(30)"], None, self.target,
                                  restorecap.Claim(GB, 10), 60, measure=slow, measure_disk=floor)
        self.assertLess(time.monotonic() - t0, 4)  # stopped at the disk check, not after a 5 s walk

    def test_a_folder_that_cant_be_read_cant_be_counted(self):
        if os.geteuid() == 0:
            self.skipTest("root reads every folder")
        (self.target / "closed" / "inside").mkdir(parents=True)
        (self.target / "closed" / "inside" / "f").write_bytes(b"x" * 1000)
        os.chmod(self.target / "closed", 0o000)
        try:
            with self.assertRaises(PermissionError):
                restorecap.tree(self.target)
        finally:
            os.chmod(self.target / "closed", 0o700)

    def test_a_mode_000_folder_is_still_removed(self):
        (self.target / "z" / "deeper").mkdir(parents=True)
        (self.target / "z" / "deeper" / "f").write_text("x")
        os.chmod(self.target / "z" / "deeper", 0o000)
        os.chmod(self.target / "z", 0o000)
        restorecap.clear(self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_read_only_restored_folders_are_still_removed(self):
        (self.target / "ro" / "deep").mkdir(parents=True)
        (self.target / "ro" / "deep" / "f").write_text("x")
        os.chmod(self.target / "ro" / "deep", 0o500)
        os.chmod(self.target / "ro", 0o500)
        restorecap.clear(self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_poll_is_read_at_call_time(self):
        with mock.patch.object(restorecap, "POLL", 0.5), mock.patch.object(restorecap.time, "sleep") as sl:
            restorecap.run_capped([sys.executable, "-c", "import time; time.sleep(0.3)"], None, self.target,
                                  restorecap.Claim(GB, 10), 60, measure_disk=roomy)
        self.assertTrue(sl.call_args_list and all(c.args == (0.5,) for c in sl.call_args_list))


class ReadCapped(unittest.TestCase):
    def test_small_file(self):
        self.assertEqual(restorecap.read_capped([sys.executable, "-c", "print('{}')"], dict(os.environ), 1024), b"{}\n")

    def test_too_big_is_none_and_stops_early(self):
        t0 = time.monotonic()
        out = restorecap.read_capped([sys.executable, "-c", "import sys\nwhile True: sys.stdout.write('x' * 65536)"],
                                     dict(os.environ), 1024 * 1024)
        self.assertIsNone(out)
        self.assertLess(time.monotonic() - t0, 20)

    def test_the_limit_itself(self):
        exact = [sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x' * 1048576)"]
        over_ = [sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x' * 1048577)"]
        self.assertEqual(len(restorecap.read_capped(exact, None, 1048576)), 1048576)
        self.assertIsNone(restorecap.read_capped(over_, None, 1048576))

    def test_failure_is_none(self):
        self.assertIsNone(restorecap.read_capped([sys.executable, "-c", "import sys; sys.exit(3)"], dict(os.environ), 10))


class Callers(unittest.TestCase):
    """Every restore goes through the cap (source checks: install.py / web.py need aiohttp to import)."""

    def test_sources(self):
        pkg = _OPT / "manager" / "tinhat"
        backup = (pkg / "backup.py").read_text()
        install = (pkg / "install.py").read_text()
        self.assertIn("restorecap.run_capped(cmd, env, target, c, timeout)", backup)
        self.assertIn("restorecap.preflight(c, restorecap.disk(target))", backup)
        self.assertIn("restore_capped, repo, pw, snaps[0][\"id\"], work, str(STAGING), 3600)", backup)
        self.assertIn("backup.restore_capped, r[\"repo\"], r[\"password\"], r[\"snapshot\"], files)", install)
        self.assertIn("restorecap.read_capped(", backup)
        self.assertEqual(backup.count('"restic", "--no-cache", '), 3)  # ls, restore, dump: restic's cache stays off
        for name, text in (("backup.py", backup), ("install.py", install)):  # restic(…, "restore", …): uncapped
            hit = re.search(r'\brestic\b,[^\n]*"restore"', text)
            self.assertIsNone(hit, f"{name}: a restic restore outside the cap: {hit and hit.group(0)}")


if __name__ == "__main__":
    unittest.main()

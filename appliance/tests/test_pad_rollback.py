"""The Pad state across an update rollback (0.3.16; RELEASING.md: Pad state).

api/pad/state.json is read FAIL CLOSED by the API (padstate.mjs). It is not an update STATE_ITEM (a restore of the
pre-update copy would undo mutes made during the update: assembly-047 review). The snapshot keeps one copy + a guard;
a rollback stops the failed release's API, then:
  K  the live file is one this release reads → kept as it is;
  R  it isn't (a newer format, damage) → moved aside (kept), the snapshot's copy goes back.
The load rules are shared with the API: vectors in api/tinhat-api/test/vectors/padstate-load.json.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[2]
UPDATER = _ROOT / "appliance" / "rootfs" / "opt" / "tinhat" / "manager" / "tinhat" / "updater.py"
VECTORS = _ROOT / "api" / "tinhat-api" / "test" / "vectors" / "padstate-load.json"
spec = importlib.util.spec_from_file_location("tinhat_updater_pad_under_test", UPDATER)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

V2 = {"v": 2, "last": 5, "gens": {}, "watch": {}, "muted": {"!r:test\n@b:test": {"by": "@a:test", "at": 1}},
      "unmuted": {}, "issued": {}}


def dump(o) -> bytes:
    return json.dumps(o).encode()


class Vectors(unittest.TestCase):
    def test_same_answer_as_the_api_on_every_vector(self):
        cases = json.loads(VECTORS.read_text())["cases"]
        self.assertGreaterEqual(len(cases), 30)
        for c in cases:
            with self.subTest(c["name"]):
                self.assertEqual(updater.pad_problem(c["raw"].encode("utf-8")) is None, c["ok"], c["name"])

    def test_reader_is_format_2(self):  # padstate.mjs: `j.v !== 2` fails closed
        self.assertEqual(updater.PAD_READER, 2)
        self.assertNotIn("api/pad", updater.STATE_ITEMS)  # never a plain restore (a047 review)
        self.assertFalse(any(i.startswith("api/pad") for i in updater.STATE_ITEMS))


class Box(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / "state"
        self.snap = self.tmp / "snap"
        self.snap.mkdir()
        self.pad = self.state / "api" / "pad" / "state.json"
        self.pad.parent.mkdir(parents=True)
        p = mock.patch.object(updater, "STATE", self.state)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def asides(self):
        return sorted(p.name for p in self.pad.parent.glob("state.json.from-*"))


class Snapshot(Box):
    def test_copy_and_guard(self):
        self.pad.write_bytes(dump(V2))
        (self.pad.parent / "state.json.tmp-1234").write_text("half a write")  # the API's own temp file: not copied
        updater.pad_snapshot(self.snap)
        self.assertEqual((self.snap / "pad" / "state.json").read_bytes(), dump(V2))
        self.assertEqual(sorted(p.name for p in (self.snap / "pad").iterdir()), ["guard.json", "state.json"])
        self.assertEqual(json.loads((self.snap / "pad" / "guard.json").read_text()), {"reader": 2, "had_file": True})
        self.assertEqual(os.stat(self.snap / "pad" / "state.json").st_mode & 0o777, 0o600)

    def test_no_file_yet(self):
        updater.pad_snapshot(self.snap)
        self.assertFalse((self.snap / "pad" / "state.json").exists())
        self.assertEqual(json.loads((self.snap / "pad" / "guard.json").read_text())["had_file"], False)

    def test_full_snapshot_calls_it_outside_the_state_items(self):
        self.pad.write_bytes(dump(V2))
        with mock.patch.object(updater, "sh", side_effect=lambda *c, **k: (k.get("stdout") and k["stdout"].write(b"P" * 2048),
                                                                          mock.Mock(returncode=0))[1]), \
                mock.patch.object(updater, "OPT", self.tmp / "opt"):
            (self.tmp / "opt" / "web").mkdir(parents=True)
            updater.snapshot(self.snap)
        self.assertTrue((self.snap / "pad" / "state.json").exists())
        self.assertFalse((self.snap / "state" / "api" / "pad").exists())


class ShapeK(Box):
    """The live file is one this release reads: it stays, with whatever happened during the update."""

    def test_mute_made_during_the_update_survives(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        during = {**V2, "muted": {**V2["muted"], "!r:test\n@c:test": {"by": "@a:test", "at": 2}}}
        self.pad.write_bytes(dump(during))  # the failed release's API (same format) muted @c during the window
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("kept", msg)
        self.assertEqual(self.pad.read_bytes(), dump(during))
        self.assertEqual(self.asides(), [])

    def test_additive_change_is_kept(self):  # a later release added a key: still format 2, this release loads it
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        newer = {**V2, "future": {"x": 1}}
        self.pad.write_bytes(dump(newer))
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(self.pad.read_bytes(), dump(newer))


class ShapeR(Box):
    """The live file is one this release can't read (fail closed): aside + the copy from before the update."""

    def test_newer_format_goes_aside_and_the_copy_comes_back(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        v3 = {"v": 3, "people": {"@b:test": {"muted_in": ["!r:test"]}}}
        self.pad.write_bytes(dump(v3))
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("replaced", msg)
        self.assertEqual(self.pad.read_bytes(), dump(V2))
        self.assertIsNone(updater.pad_problem(self.pad.read_bytes()))
        aside = self.asides()
        self.assertEqual(len(aside), 1)
        self.assertTrue(aside[0].startswith("state.json.from-0.3.16-"))
        self.assertEqual((self.pad.parent / aside[0]).read_bytes(), dump(v3))  # kept, byte for byte
        self.assertEqual(os.stat(self.pad).st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in self.pad.parent.glob(".state.json.rollback-*")], [])

    def test_damaged_file(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(b'{"v": 2, "last": ')
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(self.pad.read_bytes(), dump(V2))
        self.assertEqual(len(self.asides()), 1)

    def test_no_file_before_the_update(self):
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(dump({"v": 3}))
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertFalse(self.pad.exists())  # as before the update: the API starts with an empty state
        self.assertEqual(len(self.asides()), 1)
        self.assertIn("none is left", msg)

    def test_file_deleted_by_the_failed_release(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.unlink()
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(self.pad.read_bytes(), dump(V2))

    def test_version_text_cannot_leave_the_folder(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(b"x")
        updater.pad_rollback(self.snap, "../../etc/x y")
        self.assertEqual(len(self.asides()), 1)
        self.assertNotIn("/", self.asides()[0][len("state.json.from-"):])


class OlderSnapshot(Box):
    def test_a_snapshot_without_the_guard_leaves_the_file_alone(self):
        self.pad.write_bytes(dump({"v": 3}))
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("left as it is", msg)
        self.assertEqual(self.pad.read_bytes(), dump({"v": 3}))
        self.assertEqual(self.asides(), [])


class Guarded(Box):
    def test_guard_of_the_newest_snapshot(self):
        snaps = self.tmp / "snapshots"
        old, new = snaps / "a", snaps / "b"
        old.mkdir(parents=True)
        updater.pad_snapshot(old)
        new.mkdir()
        os.utime(old, (1, 1))
        self.assertFalse(updater.pad_guarded(snaps))  # the newest one (an older runner's) has no guard
        updater.pad_snapshot(new)
        os.utime(new, (2, 2))
        self.assertTrue(updater.pad_guarded(snaps))
        self.assertFalse(updater.pad_guarded(snaps, reader=3))
        self.assertFalse(updater.pad_guarded(self.tmp / "nothing"))


class RollbackOrder(Box):
    """The failed release's API is stopped BEFORE the file is judged (else it could write after the decision), and a
    Pad problem never stops the rollback itself."""

    def run_rollback(self, pad_side_effect=None, say_mock=None):
        events = []

        def sh(*cmd, **k):
            if "stop" in cmd and "api" in cmd:
                events.append("stop api")
            if "ps" in cmd:
                return mock.Mock(returncode=0 if self.api_ps is not None else 1, stdout=self.api_ps or b"")
            return mock.Mock(returncode=0, stdout=b"")
        real = updater.pad_rollback

        def pad(snap, ver):
            events.append("pad")
            if pad_side_effect:
                raise pad_side_effect
            return real(snap, ver)
        with mock.patch.object(updater, "sh", side_effect=sh), \
                mock.patch.object(updater, "pad_rollback", side_effect=pad), \
                mock.patch.object(updater, "MANAGER", mock.Mock()), \
                mock.patch.object(updater, "restore_files", side_effect=lambda s: events.append("files")), \
                mock.patch.object(updater, "retag"), mock.patch.object(updater, "restore_db", return_value=True), \
                mock.patch.object(updater, "services_up", side_effect=lambda: events.append("up") or True), \
                mock.patch.object(updater, "healthy", return_value=(True, [])), \
                mock.patch.object(updater, "status"), mock.patch.object(updater, "add_history"), \
                mock.patch.object(updater, "say", say_mock or mock.Mock()):
            rc = updater.rollback(self.snap, "0.3.16", "0.3.15", "test")
        return rc, events

    api_ps = b'{"Name":"tinhat-api-1","State":"exited"}\n'

    def test_an_api_that_does_not_stop_leaves_the_file_alone(self):
        for ps in (b'{"Name":"tinhat-api-1","State":"running"}\n', b'{"Name":"tinhat-api-1","State":"restarting"}\n',
                   b'[{"Name":"tinhat-api-1","State":"paused"}]', b"not json", None):
            with self.subTest(ps):
                self.api_ps = ps
                self._api_does_not_stop()

    def test_compose_lists_no_container_or_a_stopped_one(self):
        for ps in (b"", b'[{"Name":"tinhat-api-1","State":"exited"}]', b'{"State":"created"}\n'):
            with self.subTest(ps):
                self.api_ps = ps
                rc, events = self.run_rollback()
                self.assertIn("pad", events)

    def _api_does_not_stop(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(dump({"v": 3}))
        with mock.patch.object(updater, "say") as say:
            rc, events = self.run_rollback(say_mock=say)
        self.assertNotIn("pad", events)
        self.assertEqual(self.pad.read_bytes(), dump({"v": 3}))
        self.assertIn("files", events)

    def test_api_stops_before_the_pad_decision(self):
        rc, events = self.run_rollback()
        self.assertEqual(rc, 1)
        self.assertLess(events.index("stop api"), events.index("pad"))
        self.assertLess(events.index("pad"), events.index("files"))
        self.assertLess(events.index("pad"), events.index("up"))

    def test_an_error_never_stops_the_rollback(self):
        rc, events = self.run_rollback(PermissionError("read-only"))
        self.assertIn("files", events)
        self.assertIn("up", events)


class Hardening(Box):
    """Review findings: the replacement is ready before anything moves; no link is followed or written through; the
    aside never overwrites an earlier one; a missing copy isn't taken for "none before"."""

    def test_replacement_failure_changes_nothing(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(dump({"v": 3}))
        real = os.fdopen

        def failing(fd, *a, **k):
            f = real(fd, *a, **k)
            if "w" in (a[0] if a else k.get("mode", "r")):
                f.write = mock.Mock(side_effect=OSError(28, "No space left on device"))
            return f
        with mock.patch.object(updater.os, "fdopen", side_effect=failing), self.assertRaises(OSError):
            updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(self.pad.read_bytes(), dump({"v": 3}))  # still there: the API keeps failing closed, not "empty"
        self.assertEqual(self.asides(), [])
        self.assertEqual([p.name for p in self.pad.parent.iterdir()], ["state.json"])  # no temp file left

    def test_a_link_as_the_live_file_is_moved_aside_never_followed(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        outside = self.tmp / "host-file"
        outside.write_text("host data")
        self.pad.unlink()
        self.pad.symlink_to(outside)
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(outside.read_text(), "host data")
        self.assertFalse(self.pad.is_symlink())
        self.assertEqual(self.pad.read_bytes(), dump(V2))
        self.assertTrue((self.pad.parent / self.asides()[0]).is_symlink())

    def test_the_snapshot_never_copies_through_a_link(self):
        outside = self.tmp / "host-secret"
        outside.write_text("not for the API")
        self.pad.symlink_to(outside)
        updater.pad_snapshot(self.snap)
        self.assertFalse((self.snap / "pad" / "state.json").exists())
        self.assertEqual(json.loads((self.snap / "pad" / "guard.json").read_text())["had_file"], False)
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertFalse(self.pad.exists() or self.pad.is_symlink())  # the link went aside; nothing copied into /conf
        self.assertEqual(outside.read_text(), "not for the API")

    def test_a_linked_pad_folder_is_left_alone(self):
        shutil.rmtree(self.pad.parent)
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "state.json").write_bytes(dump({"v": 3}))
        self.pad.parent.symlink_to(elsewhere)
        (self.snap / "pad").mkdir()
        (self.snap / "pad" / "state.json").write_bytes(dump(V2))
        (self.snap / "pad" / "guard.json").write_text(json.dumps({"reader": 2, "had_file": True}))
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("isn't a plain folder", msg)
        self.assertEqual(sorted(p.name for p in elsewhere.iterdir()), ["state.json"])
        self.assertEqual((elsewhere / "state.json").read_bytes(), dump({"v": 3}))

    def test_a_planted_temp_name_is_never_written_through(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(dump({"v": 3}))
        victim = self.tmp / "victim"
        victim.write_text("keep me")
        for guess in (f".state.json.rollback-{os.getpid()}", ".state.json.rollback"):
            (self.pad.parent / guess).symlink_to(victim)
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(victim.read_text(), "keep me")
        self.assertEqual(self.pad.read_bytes(), dump(V2))

    def test_an_earlier_aside_is_never_overwritten(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        with mock.patch.object(updater.time, "time", return_value=1_700_000_000):
            self.pad.write_bytes(b"first")
            updater.pad_rollback(self.snap, "0.3.16")
            self.pad.write_bytes(b"second")
            updater.pad_rollback(self.snap, "0.3.16")
        a = self.asides()
        self.assertEqual(len(a), 2)
        self.assertEqual(sorted((self.pad.parent / n).read_bytes() for n in a), [b"first", b"second"])

    def test_a_missing_copy_is_not_none_before(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        (self.snap / "pad" / "state.json").unlink()
        self.pad.write_bytes(dump({"v": 3}))
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("missing", msg)
        self.assertEqual(self.pad.read_bytes(), dump({"v": 3}))

    def test_the_last_rename_failing_leaves_the_old_file(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.write_bytes(dump({"v": 3}))
        real = os.rename

        def rename(src, dst, **k):
            if dst == "state.json":
                raise OSError(5, "Input/output error")
            return real(src, dst, **k)
        with mock.patch.object(updater.os, "rename", side_effect=rename), self.assertRaises(OSError):
            updater.pad_rollback(self.snap, "0.3.16")
        self.assertEqual(self.pad.read_bytes(), dump({"v": 3}))  # never absent (the API keeps failing closed)
        self.assertEqual([p.name for p in self.pad.parent.glob(".state.json.rollback-*")], [])

    def test_a_failed_read_stops_the_snapshot(self):
        self.pad.write_bytes(dump(V2))
        with mock.patch.object(updater, "_read_nofollow", side_effect=OSError(5, "Input/output error")):
            with self.assertRaises(OSError):
                updater.pad_snapshot(self.snap)
        self.assertFalse((self.snap / "pad" / "guard.json").exists())  # no guard: never "no file before"

    def test_guard_is_written_after_the_copy(self):
        self.pad.write_bytes(dump(V2))
        order = []
        real = updater._write_durable

        def spy(path, data):
            order.append(path.name)
            return real(path, data)
        with mock.patch.object(updater, "_write_durable", side_effect=spy):
            updater.pad_snapshot(self.snap)
        self.assertEqual(order, ["state.json", "guard.json.tmp"])


class OwnerBackups(unittest.TestCase):
    """Owner backups carry the Pad state (one file, never its folder); a restore takes it only when it loads."""

    def setUp(self):
        import sys
        opt = _ROOT / "appliance" / "rootfs" / "opt" / "tinhat"
        os.environ.setdefault("TINHAT_OPT", str(opt))
        os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
        sys.path.insert(0, str(opt / "manager"))
        from tinhat import backup, config
        self.backup, self.config = backup, config
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.live = self.tmp / "live"
        p = mock.patch.object(config, "STATE_DIR", self.live)
        p.start()
        self.addCleanup(p.stop)

    def test_not_a_state_item_but_staged_as_one_file(self):
        self.assertFalse(any(i.startswith("api/pad") for i in self.backup.STATE_ITEMS))
        self.assertFalse(self.backup.stage_pad(self.tmp / "staging" / "state"))  # none yet: nothing staged
        pad = self.live / "api" / "pad" / "state.json"
        pad.parent.mkdir(parents=True)
        pad.write_bytes(dump(V2))
        (pad.parent / "state.json.tmp-77").write_text("half")
        self.assertTrue(self.backup.stage_pad(self.tmp / "staging" / "state"))
        staged = self.tmp / "staging" / "state" / "api" / "pad"
        self.assertEqual(sorted(p.name for p in staged.iterdir()), ["state.json"])
        self.assertEqual((staged / "state.json").read_bytes(), dump(V2))
        self.assertEqual(os.stat(staged / "state.json").st_mode & 0o777, 0o600)

    def restore(self, raw: bytes | None):
        try:
            import aiohttp
            if getattr(aiohttp, "__file__", None) is None:
                raise ImportError
        except ImportError:
            self.skipTest("needs the real aiohttp (runs where the manager runs)")
        from tinhat import install
        src = self.tmp / "restored" / "state" / "api" / "pad" / "state.json"
        src.parent.mkdir(parents=True, exist_ok=True)
        if raw is not None:
            src.write_bytes(raw)
        return install._restore_pad(src), self.live / "api" / "pad" / "state.json"

    def test_a_retry_without_a_good_file_removes_the_earlier_one(self):
        dst = self.live / "api" / "pad" / "state.json"
        dst.parent.mkdir(parents=True)
        dst.write_bytes(dump({"v": 3}))  # left by an earlier try (or damaged)
        msg, dst = self.restore(None)
        self.assertEqual(msg, "none in the backup")
        self.assertFalse(dst.exists())

    def test_staging_never_reads_through_a_link(self):
        pad = self.live / "api" / "pad" / "state.json"
        pad.parent.mkdir(parents=True)
        outside = self.tmp / "host-secret"
        outside.write_text("not for a backup")
        pad.symlink_to(outside)
        self.assertFalse(self.backup.stage_pad(self.tmp / "staging" / "state"))
        self.assertFalse((self.tmp / "staging" / "state" / "api" / "pad" / "state.json").exists())

    def test_restore_checks_and_writes_the_same_bytes(self):
        try:
            import aiohttp  # noqa: F401
        except ImportError:
            self.skipTest("needs the real aiohttp")
        seen = []
        real = self.backup.pad_problem
        with mock.patch.object(self.backup, "pad_problem", side_effect=lambda b: seen.append(b) or real(b)):
            msg, dst = self.restore(dump(V2))
        self.assertEqual(msg, "restored")
        self.assertEqual(seen, [dst.read_bytes()])

    def test_restore_never_follows_a_linked_api_folder(self):
        try:
            import aiohttp  # noqa: F401
        except ImportError:
            self.skipTest("needs the real aiohttp")
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        self.live.mkdir(parents=True, exist_ok=True)
        (self.live / "api").symlink_to(elsewhere)
        with self.assertRaises(OSError):
            self.restore(dump(V2))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_a_backup_file_that_cant_be_read_stops_the_restore(self):
        try:
            import aiohttp  # noqa: F401
        except ImportError:
            self.skipTest("needs the real aiohttp")
        from tinhat import install
        dst = self.live / "api" / "pad" / "state.json"
        dst.parent.mkdir(parents=True)
        dst.write_bytes(dump(V2))
        real = os.open

        def eacces(path, *a, **k):
            if str(path).endswith("restored/state/api/pad/state.json"):
                raise PermissionError(13, "Permission denied")
            return real(path, *a, **k)
        with mock.patch.object(install.os, "open", side_effect=eacces), self.assertRaises(install.InstallError):
            self.restore(dump(V2))
        self.assertEqual(dst.read_bytes(), dump(V2))  # nothing removed on a guess

    def test_a_big_file_that_loads_is_restored(self):
        big = {**V2, "muted": {f"!r{i}:test\n@u{i}:test": {"by": "@a:test", "at": i} for i in range(200_000)}}
        msg, dst = self.restore(dump(big))
        self.assertEqual(msg, "restored")
        self.assertGreater(dst.stat().st_size, 10 * 1024 * 1024)

    def test_restore_takes_a_file_that_loads(self):
        msg, dst = self.restore(dump(V2))
        self.assertEqual(msg, "restored")
        self.assertEqual(dst.read_bytes(), dump(V2))
        self.assertEqual(os.stat(dst).st_mode & 0o777, 0o600)

    def test_restore_leaves_out_one_that_would_fail_closed(self):
        for raw in (dump({"v": 3}), b"garbage", dump({**V2, "muted": []})):
            with self.subTest(raw[:20]):
                msg, dst = self.restore(raw)
                self.assertTrue(msg.startswith("left out"), msg)
                self.assertFalse(dst.exists())

    def test_restore_without_one(self):
        msg, dst = self.restore(None)
        self.assertEqual(msg, "none in the backup")
        self.assertFalse(dst.exists())

    def test_restore_never_writes_through_a_link(self):
        outside = self.tmp / "outside"
        outside.write_text("untouched")
        dst = self.live / "api" / "pad" / "state.json"
        dst.parent.mkdir(parents=True)
        dst.symlink_to(outside)
        msg, dst = self.restore(dump(V2))
        self.assertEqual(outside.read_text(), "untouched")
        self.assertFalse(dst.is_symlink())
        self.assertEqual(dst.read_bytes(), dump(V2))


if __name__ == "__main__":
    unittest.main()


class FolderAtTheName(Box):
    """Review 0.3.16 (area 2): the failed release left a FOLDER at state.json; the copy from before the update comes back."""

    def test_a_folder_goes_aside_and_the_copy_comes_back(self):
        self.pad.write_bytes(dump(V2))
        updater.pad_snapshot(self.snap)
        self.pad.unlink()
        self.pad.mkdir()
        (self.pad / "inside").write_text("left by the failed release")
        msg = updater.pad_rollback(self.snap, "0.3.16")
        self.assertIn("replaced", msg)
        self.assertTrue(self.pad.is_file() and not self.pad.is_symlink())
        self.assertEqual(self.pad.read_bytes(), dump(V2))
        aside = self.asides()
        self.assertEqual(len(aside), 1)
        self.assertEqual((self.pad.parent / aside[0] / "inside").read_text(), "left by the failed release")
        self.assertEqual([p.name for p in self.pad.parent.glob(".state.json.rollback-*")], [])

    def test_a_folder_with_no_copy_goes_aside(self):
        updater.pad_snapshot(self.snap)  # no file before the update
        self.pad.mkdir()
        updater.pad_rollback(self.snap, "0.3.16")
        self.assertFalse(self.pad.exists())
        self.assertEqual(len(self.asides()), 1)

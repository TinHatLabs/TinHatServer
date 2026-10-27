"""The rollback after a bad release (gates, 2026-10-26): a `compose up --force-recreate` that dies mid-recreate leaves
this project's old containers renamed `<12 hex>_tinhat-…`, and the next `up` fails with a name conflict. services_up()
clears exactly those (this project's label, that name shape) and tries once more; rollback() counts its result, so a
rollback whose services never came back up is "broken", never "rolled back". Docker and the box are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import unittest

UPDATER = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/updater.py"
spec = importlib.util.spec_from_file_location("tinhat_updater_rollback_under_test", UPDATER)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

PS = ("d6eff1e75a04 d6eff1e75a04_tinhat-postgres-1\n"   # stranded: removed
      "1111aaaa2222 tinhat-postgres-1\n"                 # a real one: kept
      "3333bbbb4444 7719859e593e_tinhat-synapse-1\n"     # stranded: removed
      "5555cccc6666 abcdefXYZ123_tinhat-api-1\n"         # not hex: kept
      "7777dddd8888 0123456789ab_someoneelse-1\n"        # not ours by name: kept
      "9999eeee0000 0123456789abc_tinhat-api-1\n")      # 13 hex: kept


class R:
    def __init__(self, rc=0, out=b""):
        self.returncode, self.stdout, self.stderr = rc, out, b""


class Docker:
    def __init__(self, up_results, ps=PS):
        self.up_results, self.ps, self.calls = list(up_results), ps, []

    def sh(self, *cmd, timeout=600, stdin=None, stdout=None, cwd=None):
        self.calls.append(cmd)
        if cmd[:3] == ("docker", "ps", "-a"):
            return R(0, self.ps.encode())
        if cmd[:3] == ("docker", "rm", "-f"):
            return R(0)
        if "up" in cmd:
            return R(0 if self.up_results.pop(0) else 1)
        return R(0)


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = {k: getattr(updater, k) for k in ("sh", "say")}
        updater.say = lambda *_: None

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(updater, k, v)


class Stranded(Base):
    def test_only_this_projects_renamed_leftovers_go(self):
        d = Docker([])
        updater.sh = d.sh
        self.assertEqual(updater.clear_stranded(), ["d6eff1e75a04_tinhat-postgres-1", "7719859e593e_tinhat-synapse-1"])
        ps = [c for c in d.calls if c[:3] == ("docker", "ps", "-a")]
        self.assertEqual(len(ps), 1)
        self.assertIn("label=com.docker.compose.project=tinhat", ps[0])
        self.assertEqual([c[3] for c in d.calls if c[:3] == ("docker", "rm", "-f")], ["d6eff1e75a04", "3333bbbb4444"])

    def test_services_up_clears_before_every_try(self):
        d = Docker([False, False, True])
        updater.sh = d.sh
        self.assertTrue(updater.services_up())
        self.assertEqual(sum(1 for c in d.calls if "up" in c), 3)
        self.assertEqual(sum(1 for c in d.calls if c[:3] == ("docker", "ps", "-a")), 3)  # one clear before each try
        ups = [i for i, c in enumerate(d.calls) if "up" in c]
        self.assertTrue(all(d.calls[i - 1][:2] in (("docker", "ps"), ("docker", "rm")) for i in ups))

    def test_services_up_with_nothing_stranded_removes_nothing(self):
        d = Docker([True], ps="1111aaaa2222 tinhat-postgres-1\n")
        updater.sh = d.sh
        self.assertTrue(updater.services_up())
        self.assertFalse([c for c in d.calls if c[:2] == ("docker", "rm")])

    def test_services_up_gives_up_after_its_tries(self):
        d = Docker([False] * updater.UP_ATTEMPTS)
        updater.sh = d.sh
        self.assertFalse(updater.services_up())
        self.assertEqual(sum(1 for c in d.calls if "up" in c), updater.UP_ATTEMPTS)


class Rollback(Base):
    def run_rollback(self, up_results, healthy=(True, [])):
        d = Docker(up_results)
        rec = {}
        names = ("sh", "restore_files", "retag", "restore_db", "healthy", "status", "add_history", "MANAGER")
        saved = {k: getattr(updater, k) for k in names}
        try:
            updater.sh = d.sh
            updater.restore_files = lambda snap: None
            updater.retag = lambda lock: None
            updater.restore_db = lambda snap: True
            updater.healthy = lambda ver, wait=0: healthy
            updater.status = lambda **kw: rec.update(kw)
            updater.add_history = lambda h: rec.update(history=h)
            updater.MANAGER = type("M", (), {"stop": staticmethod(lambda: None), "start": staticmethod(lambda: None)})
            self.assertEqual(updater.rollback(pathlib.Path("/nonexistent"), "0.3.6", "0.3.5", "test"), 1)
        finally:
            for k, v in saved.items():
                setattr(updater, k, v)
        return rec

    def test_services_back_after_the_retry_is_rolled_back(self):
        rec = self.run_rollback([False, True])
        self.assertEqual(rec["phase"], "rolled-back")
        self.assertEqual(rec["history"]["result"], "rolled back")

    def test_services_never_up_is_broken_even_if_a_check_passes(self):
        rec = self.run_rollback([False] * updater.UP_ATTEMPTS, healthy=(True, []))
        self.assertEqual(rec["phase"], "broken")
        self.assertEqual(rec["history"]["result"], "broken")
        self.assertIn("the services didn't start", rec["message"])


if __name__ == "__main__":
    unittest.main()

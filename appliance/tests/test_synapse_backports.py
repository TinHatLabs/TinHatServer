"""The Synapse image's backported upstream fixes (rootfs/opt/tinhat/build/synapse/: backports/ applied by
apply_backports.py, checked in the image by check_backports.py; Pillow / msgpack pinned by requirements-pins.txt).

Always: the series and its pins agree with each other and with the image's own check, the Dockerfile and
requirements pin what they should, and the applier refuses (changing nothing) every tree it wasn't written for.

With TINHAT_TEST_SYNAPSE_PY (a python with matrix-synapse 1.145.0, twisted and parameterized; deps as v1.145.0's
poetry.lock, then requirements-pins.txt installed over them) and TINHAT_TEST_SYNAPSE_SRC (an element-hq/synapse checkout at v1.145.0): Synapse's own trial harness, on a
stock copy and on a patched copy of the installed package (to-device fix + this series, exactly as the Dockerfile does),
with v1.145.0's tests plus upstream's own regression tests for each fix (tests/synapse_backports/) and one of ours for
the WorkerLock cap. Every regression test must FAIL on stock (the failing-first proof, one or more per advisory) and
pass patched. TINHAT_TEST_SYNAPSE_FULL=1 also runs the suites of every touched module on the patched copy.
Offline: test rooms and servers exist only inside Synapse's harness."""
import ast
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
BUILD = HERE / "rootfs" / "opt" / "tinhat" / "build" / "synapse"
SRC_SERIES = BUILD / "backports"
TEST_SERIES = Path(__file__).resolve().parent / "synapse_backports"
sys.path.insert(0, str(BUILD))
import apply_backports as ab  # noqa: E402
import patch_todevice_spoof as todevice  # noqa: E402

SYN_PY = os.environ.get("TINHAT_TEST_SYNAPSE_PY", "")
SYN_SRC = os.environ.get("TINHAT_TEST_SYNAPSE_SRC", "")
FULL = os.environ.get("TINHAT_TEST_SYNAPSE_FULL") == "1"

GUARD_MODULE = "tests.rest.client.test_tinhat_builtin_rule_actions"
GUARD = [f"{GUARD_MODULE}.BuiltInRuleActions.test_one_byte_over_the_limit_is_refused",
         f"{GUARD_MODULE}.BuiltInRuleActions.test_oversized_action_on_a_built_in_rule_is_refused",
         f"{GUARD_MODULE}.BuiltInRuleActions.test_a_refusal_keeps_the_existing_override"]
RATE_MODULE = "tests.rest.client.test_tinhat_push_rule_ratelimit"
RATE = [f"{RATE_MODULE}.PushRuleWriteRate.{t}" for t in (
    "test_rapid_writes_are_refused_and_store_nothing", "test_custom_rules_and_deletes_count_too",
    "test_one_user_is_not_slowed_by_another", "test_writes_work_again_after_the_wait",
    "test_the_sustained_rate_is_one_write_every_five_seconds", "test_deletes_use_the_same_allowance",
    "test_a_second_device_shares_the_allowance", "test_successful_deletes_use_the_allowance_too")]
# advisory -> the regression tests that must fail on stock 1.145 and pass patched
REGRESSION = {
    "GHSA-6wjm-9p2x-gvpm": ["tests.http.test_site.SynapseRequestTestCase.test_content_type_multipart_2"],
    "GHSA-27p5-4f45-gx76": [
        "tests.federation.test_federation_server.GetMissingEventsRoomCheckTests.test_get_missing_events_ignores_events_from_other_room",
        "tests.federation.test_federation_server.GetMissingEventsRoomCheckTests.test_get_missing_events_skips_latest_events_from_other_room"],
    "GHSA-qcjr-46gf-7f4r": ["tests.federation.test_federation_server.EventAuthFederationTests.test_event_auth_wrong_room_returns_404"],
    "GHSA-r66v-qhwx-8rg4": ["tests.federation.test_federation_server.TimestampToEventTests.test_requires_server_in_room"],
    "GHSA-95fh-hv8c-chvq": ["tests.rest.client.test_rooms.CreateRoomRemoteInviteTestCase.test_remote_invite_bubbles_errors_1"],
    "GHSA-fp53-rw9v-hcf9": [
        "tests.rest.client.test_push_rule_attrs.PushRuleLimitTestCase.test_limit_on_push_rule_count",
        "tests.rest.client.test_push_rule_attrs.PushRuleLimitTestCase.test_limit_on_push_rule_size_2",
        "tests.rest.client.test_push_rule_attrs.PushRuleLimitTestCase.test_limit_on_rule_id_length_2"],
    "GHSA-8q93-326v-3m7g": ["tests.handlers.test_tinhat_workerlock_cap.WorkerLockRetryCap.test_waiter_notices_a_silent_release_within_the_cap"],
    "GHSA-rgv2-84w7-5j9p": ["tests.rest.client.test_sendtodevice.SendToDeviceTestCase.test_remote_spoofed_sender"],
    "built-in rule actions (0006, ours)": GUARD,
    "push rule write rate (0007, ours)": RATE,
}
# the classes those live in (their other tests must pass on both: only the regression tests may differ)
CLASSES = ["tests.http.test_site.SynapseRequestTestCase",
           "tests.federation.test_federation_server.GetMissingEventsRoomCheckTests",
           "tests.federation.test_federation_server.EventAuthFederationTests",
           "tests.federation.test_federation_server.TimestampToEventTests",
           "tests.rest.client.test_rooms.CreateRoomRemoteInviteTestCase",
           "tests.rest.client.test_push_rule_attrs", "tests.handlers.test_worker_lock",
           "tests.handlers.test_tinhat_workerlock_cap", "tests.rest.client.test_sendtodevice", GUARD_MODULE, RATE_MODULE]
# every module the series touches, and the media code Pillow 13 runs under (TINHAT_TEST_SYNAPSE_FULL=1)
SUITES = ["tests.http.test_site", "tests.federation", "tests.handlers.test_federation", "tests.handlers.test_room_policy",
          "tests.handlers.test_worker_lock", "tests.handlers.test_tinhat_workerlock_cap",
          "tests.storage.test_event_federation", "tests.rest.client.test_rooms", "tests.rest.client.test_push_rule_attrs",
          "tests.rest.client.test_sendtodevice", "tests.push", "tests.config", "tests.replication", "tests.api",
          "tests.media", "tests.rest.media", "tests.rest.client.test_media", GUARD_MODULE, RATE_MODULE]


# push_rule.py after upstream's 0004, without our 0006
UPSTREAM_PUSH_RULE = "f4779493cb9025168d6fde8f6ed0d97fa59b3d0b4a59ef681543a63affe40942"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def manifest(d: Path, name: str) -> list[list[str]]:
    return [ln.split() for ln in (d / name).read_text().splitlines() if ln.strip() and not ln.startswith("#")]


def literal(path: Path, name: str):
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not in {path}")


class Pins(unittest.TestCase):
    def test_the_series_hash_to_their_lines(self):
        for d in (SRC_SERIES, TEST_SERIES):
            for want, name in manifest(d, "SERIES"):
                self.assertEqual(sha((d / name).read_bytes()), want, f"{d.name}/{name}")
            self.assertEqual(sorted(n for _, n in manifest(d, "SERIES")), sorted(p.name for p in d.glob("*.patch")))

    def test_every_touched_file_is_pinned_and_nothing_else(self):
        for d in (SRC_SERIES, TEST_SERIES):
            touched = {m for _, n in manifest(d, "SERIES")
                       for m in re.findall(r"^\+\+\+ b/(\S+)$", (d / n).read_text(), re.M)}
            self.assertEqual(touched, {p for _, _, p in manifest(d, "FILES")})

    def test_the_image_check_knows_every_patched_file(self):
        files = {p: after for _, after, p in manifest(SRC_SERIES, "FILES")}
        self.assertEqual(literal(BUILD / "check_backports.py", "PATCHED"), files)
        self.assertEqual(sorted(literal(BUILD / "hash_patched.py", "FILES")), sorted(["handlers/devicemessage.py", *files]))
        self.assertNotIn("handlers/devicemessage.py", files, "the to-device fix stays patch_todevice_spoof.py's")

    def test_upstreams_push_rule_patch_is_untouched_and_ours_is_on_top(self):
        names = [n for _, n in manifest(SRC_SERIES, "SERIES")]
        self.assertEqual(sha((SRC_SERIES / "0004-ghsa-fp53-push-rule-limits.patch").read_bytes()),
                         "583a68220d543b3d98fdaf0ce19036cdc8a169daec544a33a89157ce7f948b95")
        self.assertEqual(names[-2:], ["0006-tinhat-builtin-push-rule-action-size.patch", "0007-tinhat-push-rule-write-rate.patch"])

    def test_the_series_never_touches_tests_or_docs_in_the_image(self):
        for _, _, p in manifest(SRC_SERIES, "FILES"):
            self.assertFalse(p.startswith(("tests/", "docs/", "../")), p)

    def test_dockerfile_and_requirements(self):
        df = (BUILD / "Dockerfile").read_text()
        self.assertIn("FROM matrixdotorg/synapse:v1.145.0@sha256:9e33e40f6e69ac7dbac331a5fa29f39b7a4f8b7765476c76fe22055014dcccb1\n", df)
        for step in ("patch_todevice_spoof.py \"$d/handlers/devicemessage.py\"", "apply_backports.py \"$d\" /tmp/th-synapse/backports",
                     "--require-hashes", "--no-deps", "--only-binary :all:", "--no-compile", "--invalidation-mode checked-hash"):
            self.assertIn(step, df)
        self.assertLess(df.index("patch_todevice_spoof.py \"$d"), df.index("apply_backports.py \"$d"))
        req = "\n".join(ln for ln in (BUILD / "requirements-pins.txt").read_text().splitlines() if not ln.startswith("#"))
        pins = {}
        for block in re.split(r"\n(?=[a-z])", req.strip()):
            name, rest = block.split("==", 1)
            pins[name] = (rest.split()[0], re.findall(r"--hash=sha256:([0-9a-f]{64})", block))
        self.assertEqual({k: v[0] for k, v in pins.items()}, {"pillow": "13.0.0", "msgpack": "1.2.4"})
        for name, (_, hashes) in pins.items():
            self.assertEqual(len(set(hashes)), 2, f"{name}: one wheel per processor (x86_64, aarch64)")

    def test_compose_and_provision_name_th2(self):
        compose = (HERE / "rootfs" / "opt" / "tinhat" / "compose.yaml").read_text()
        self.assertIn("image: tinhat/synapse:v1.145.0-th2\n", compose)
        prov = (HERE / "provision.sh").read_text()
        self.assertNotIn("v1.145.0-th1", prov + compose)
        self.assertIn("check_backports.py", prov)
        self.assertIn("check_todevice_fix.py", prov)


def tree(files: dict[str, str]) -> Path:
    d = Path(tempfile.mkdtemp(prefix="ths-backports-"))
    for p, t in files.items():
        (d / p).parent.mkdir(parents=True, exist_ok=True)
        (d / p).write_text(t)
    return d


class Applier(unittest.TestCase):
    """A synthetic tree and series: the applier's own rules, each shown both ways."""
    BEFORE = {"pkg/a.py": "one\ntwo\nthree\nfour\n"}
    PATCH = ("diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n four\n"
             "diff --git a/pkg/b.py b/pkg/b.py\nnew file mode 100644\n--- /dev/null\n+++ b/pkg/b.py\n@@ -0,0 +1,2 @@\n+new\n+file\n")
    AFTER = {"pkg/a.py": "one\nTWO\nthree\nfour\n", "pkg/b.py": "new\nfile\n"}

    def setup_series(self, patch=None, after=None, before=None):
        root = tree(before if before is not None else self.BEFORE)
        pdir = tree({"0001.patch": patch or self.PATCH})
        self.addCleanup(shutil.rmtree, root)
        self.addCleanup(shutil.rmtree, pdir)
        after = after or self.AFTER
        (pdir / "SERIES").write_text(f"# c\n{sha((pdir / '0001.patch').read_bytes())} 0001.patch\n")
        (pdir / "FILES").write_text(
            f"{sha(self.BEFORE['pkg/a.py'].encode())} {sha(after['pkg/a.py'].encode())} pkg/a.py\n"
            f"- {sha(after['pkg/b.py'].encode())} pkg/b.py\n")
        return root, pdir

    def snapshot(self, root):
        return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}

    def refused(self, root, pdir, words):
        before = self.snapshot(root)
        with self.assertRaises(SystemExit) as e:
            ab.main(["x", str(root), str(pdir)])
        self.assertIn(words, str(e.exception))
        self.assertIn("refusing (nothing changed)", str(e.exception))
        self.assertEqual(self.snapshot(root), before)

    def test_applies_exactly(self):
        root, pdir = self.setup_series()
        self.assertEqual(ab.main(["x", str(root), str(pdir)]), 0)
        self.assertEqual({k: v.decode() for k, v in self.snapshot(root).items()}, self.AFTER)

    def test_a_second_run_is_refused(self):
        root, pdir = self.setup_series()
        ab.main(["x", str(root), str(pdir)])
        self.refused(root, pdir, "has the fixes already")
        (root / "pkg/b.py").unlink()
        self.refused(root, pdir, "isn't the Synapse 1.145.0 file")

    def test_a_file_the_series_adds_must_not_exist(self):
        root, pdir = self.setup_series(before={**self.BEFORE, "pkg/b.py": "someone else's\n"})
        self.refused(root, pdir, "exists already")

    def test_a_missing_file_is_refused(self):
        root, pdir = self.setup_series(before={"pkg/other.py": "x\n"})
        self.refused(root, pdir, "is missing")

    def test_other_code_is_refused(self):
        root, pdir = self.setup_series(before={"pkg/a.py": "one\ntwo \nthree\nfour\n"})
        self.refused(root, pdir, "isn't the Synapse 1.145.0 file")

    def test_a_tree_that_has_the_fix_is_refused(self):
        root, pdir = self.setup_series(before=self.AFTER)
        self.refused(root, pdir, "has the fixes already")

    def test_a_changed_patch_is_refused(self):
        root, pdir = self.setup_series()
        (pdir / "0001.patch").write_text(self.PATCH.replace("+TWO", "+TW0"))
        self.refused(root, pdir, "doesn't hash to its SERIES line")

    def test_a_hunk_that_doesnt_fit_is_refused(self):
        root, pdir = self.setup_series(patch=self.PATCH.replace(" three\n four\n", " three\n five\n", 1))
        self.refused(root, pdir, "doesn't match")

    def test_a_hunk_is_only_tried_where_it_says(self):
        """Lines 1-2 named as lines 2-3: inside the file, so only the exact-position rule refuses it (no search)."""
        moved = ("--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -2,2 +2,2 @@\n one\n-two\n+TWO\n"
                 + self.PATCH[self.PATCH.index("diff --git a/pkg/b.py"):])
        root, pdir = self.setup_series(patch=moved)
        self.refused(root, pdir, "doesn't match")

    def test_a_result_other_than_the_pinned_one_is_refused(self):
        root, pdir = self.setup_series(after={"pkg/a.py": "one\nTWO\nthree\nfour\n", "pkg/b.py": "other\n"})
        self.refused(root, pdir, "isn't the pinned patched file")

    def test_an_insertion_past_the_end_is_refused(self):
        root, pdir = self.setup_series(patch=self.PATCH.replace("@@ -0,0 +1,2 @@", "@@ -9,0 +10,2 @@"))
        self.refused(root, pdir, "outside the file")

    def test_a_wrong_new_line_is_refused(self):
        root, pdir = self.setup_series(patch=self.PATCH.replace("@@ -1,4 +1,4 @@", "@@ -1,4 +999,4 @@"))
        self.refused(root, pdir, "names the wrong new line")

    def test_hunks_out_of_order_are_refused(self):
        two = ("--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -3,2 +3,2 @@\n-three\n+THREE\n four\n"
               "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n")
        root, pdir = self.setup_series(patch=two + self.PATCH[self.PATCH.index("diff --git a/pkg/b.py"):])
        self.refused(root, pdir, "out of order")

    def test_a_directory_where_a_new_file_goes_is_refused(self):
        root, pdir = self.setup_series()
        (root / "pkg/b.py").mkdir()
        self.refused(root, pdir, "exists already (not as a file)")

    def test_a_symlink_is_refused(self):
        root, pdir = self.setup_series()
        real = root / "real.py"
        real.write_text(self.BEFORE["pkg/a.py"])
        (root / "pkg/a.py").unlink()
        (root / "pkg/a.py").symlink_to(real)
        self.refused(root, pdir, "isn't a regular file")

    def test_a_file_outside_files_is_refused(self):
        patch = self.PATCH + "--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1 +1 @@\n-x\n+y\n"
        root, pdir = self.setup_series(patch=patch)
        self.refused(root, pdir, "which FILES doesn't pin")


@unittest.skipUnless(SYN_PY and SYN_SRC, "set TINHAT_TEST_SYNAPSE_PY and TINHAT_TEST_SYNAPSE_SRC (see the docstring)")
class RealSynapse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.check_output([SYN_PY, "-c", "import importlib.util, synapse; print(synapse.__version__); "
                                       "print(importlib.util.find_spec('synapse').submodule_search_locations[0])"],
                                      text=True, cwd="/").split()
        assert out[0] == "1.145.0", out
        cls.installed = Path(out[1])
        cls.base = Path(tempfile.mkdtemp(prefix="ths-backports-"))
        cls.trees = {}
        def without(name: str, patch: str) -> Path:
            """The series less one patch of ours; FILES as it would be without it."""
            d = cls.base / name
            shutil.copytree(SRC_SERIES, d)
            (d / patch).unlink()
            (d / "SERIES").write_text("".join(ln + "\n" for ln in (d / "SERIES").read_text().splitlines() if not ln.endswith(patch)))
            return d
        cls.series = {"patched": SRC_SERIES}
        # th2 without 0006: storage/.../push_rule.py pinned at upstream's result
        cls.series["noguard"] = without("series-noguard", "0006-tinhat-builtin-push-rule-action-size.patch")
        files = cls.series["noguard"] / "FILES"
        ours = next(a for _, a, p in manifest(SRC_SERIES, "FILES") if p == "storage/databases/main/push_rule.py")
        files.write_text(files.read_text().replace(ours, UPSTREAM_PUSH_RULE))
        # th2 without 0007: rest/client/push_rule.py isn't touched at all
        cls.series["norate"] = without("series-norate", "0007-tinhat-push-rule-write-rate.patch")
        files = cls.series["norate"] / "FILES"
        files.write_text("".join(ln + "\n" for ln in files.read_text().splitlines() if not ln.endswith(" rest/client/push_rule.py")))
        for kind in ("stock", "noguard", "norate", "patched"):
            d = cls.base / kind
            d.mkdir()
            shutil.copytree(cls.installed, d / "synapse", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(Path(SYN_SRC) / "tests", d / "tests", ignore=shutil.ignore_patterns("__pycache__"))
            assert ab.main(["x", str(d), str(TEST_SERIES)]) == 0
            shutil.copy(TEST_SERIES / "test_tinhat_workerlock_cap.py", d / "tests" / "handlers" / "test_tinhat_workerlock_cap.py")
            shutil.copy(TEST_SERIES / "test_tinhat_builtin_rule_actions.py", d / "tests" / "rest" / "client" / "test_tinhat_builtin_rule_actions.py")
            shutil.copy(TEST_SERIES / "test_tinhat_push_rule_ratelimit.py", d / "tests" / "rest" / "client" / "test_tinhat_push_rule_ratelimit.py")
            if kind != "stock":  # exactly the Dockerfile's two steps
                assert todevice.main(["x", str(d / "synapse" / "handlers" / "devicemessage.py")]) == 0
                assert ab.main(["x", str(d / "synapse"), str(cls.series[kind])]) == 0
            cls.trees[kind] = d

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, True)

    def trial(self, kind: str, targets: list[str], jobs: int = 4) -> tuple[subprocess.CompletedProcess, set, set]:
        d = self.trees[kind]
        env = {**os.environ, "PYTHONPATH": str(d), "PYTHONDONTWRITEBYTECODE": "1", "TINHAT_SYNPATCH_DIR": str(d),
               "SYNAPSE_TEST_LOG_LEVEL": "ERROR"}
        where = subprocess.check_output([SYN_PY, "-c", "import synapse; print(synapse.__file__)"], cwd=d, env=env, text=True)
        self.assertTrue(where.startswith(str(d) + "/"), "the copy under test, never the installed Synapse")
        r = subprocess.run([SYN_PY, "-m", "twisted.trial", "--reporter=bwverbose", "-j", str(jobs),
                            f"--temp-directory={self.base}/_trial_{kind}", *targets],
                           cwd=d, env=env, capture_output=True, text=True, timeout=3600)
        failed = set(re.findall(r"^(tests\.\S+) \.\.\. \[(?:FAIL|FAILURE)\]", r.stdout, re.M))
        errors = set(re.findall(r"^(tests\.\S+) \.\.\. \[ERROR\]", r.stdout, re.M))
        passed = set(re.findall(r"^(tests\.\S+) \.\.\. \[OK\]", r.stdout, re.M))
        self.assertTrue(failed or errors or passed, "trial's verbose lines were read")
        return r, failed, errors, passed

    def test_installed_files_are_the_tagged_and_pinned_ones(self):
        for before, _, p in manifest(SRC_SERIES, "FILES"):
            f = self.installed / p
            if before == "-":
                self.assertFalse(f.exists(), p)
            else:
                self.assertEqual(sha(f.read_bytes()), before, p)
                self.assertEqual(f.read_bytes(), (Path(SYN_SRC) / "synapse" / p).read_bytes(), p)

    def test_stock_fails_every_regression_test(self):
        """The failing-first proof: stock 1.145 fails each advisory's regression tests and nothing else in their classes."""
        want = {t for ts in REGRESSION.values() for t in ts}
        r, failed, errors, passed = self.trial("stock", CLASSES)
        print("STOCK FAILED", sorted(failed))
        # assertion failures only: a test that errors out (a missing helper, a broken setup) proves nothing
        self.assertEqual(errors, set(), r.stdout[-4000:])
        self.assertEqual(failed, want, r.stdout[-4000:])
        self.assertTrue(passed, "the rest of those classes ran and passed")

    def test_without_our_guard_only_its_refusals_fail(self):
        """th2 without 0006: an oversized action on a built-in rule is stored; normal client changes work."""
        r, failed, errors, passed = self.trial("noguard", [GUARD_MODULE])
        self.assertEqual((failed, errors), (set(GUARD), set()), r.stdout[-4000:])
        self.assertEqual(len(passed), 4, r.stdout[-2000:])

    def test_without_our_rate_limit_only_its_refusals_fail(self):
        """th2 without 0007: rapid writes all land; a sign-in rewrite, a person at a normal pace and reads work."""
        r, failed, errors, passed = self.trial("norate", [RATE_MODULE])
        self.assertEqual((failed, errors), (set(RATE), set()), r.stdout[-4000:])
        self.assertEqual(len(passed), 3, r.stdout[-2000:])

    def test_patched_passes_them(self):
        want = {t for ts in REGRESSION.values() for t in ts}
        r, failed, errors, passed = self.trial("patched", CLASSES)
        self.assertEqual(failed | errors, set(), r.stdout[-4000:])
        self.assertTrue(want <= passed, sorted(want - passed))
        self.assertEqual(r.returncode, 0)

    @unittest.skipUnless(FULL, "TINHAT_TEST_SYNAPSE_FULL=1 runs every touched module's suite")
    def test_patched_passes_every_touched_suite(self):
        # the media suites must run under the image's Pillow / msgpack, not v1.145.0's
        want = {"pillow": "13.0.0", "msgpack": "1.2.4"}
        got = subprocess.check_output([SYN_PY, "-c", "import importlib.metadata as m; "
                                       "print(m.version('pillow'), m.version('msgpack'))"], text=True, cwd="/").split()
        self.assertEqual(dict(zip(want, got)), want, "TINHAT_TEST_SYNAPSE_PY needs requirements-pins.txt installed")
        r, failed, errors, passed = self.trial("patched", SUITES, jobs=8)
        print("PATCHED SUITES", len(passed), "passed,", len(failed | errors), "failed")
        self.assertEqual(failed | errors, set(), r.stdout[-4000:])
        self.assertEqual(r.returncode, 0, r.stdout[-2000:])


if __name__ == "__main__":
    unittest.main()

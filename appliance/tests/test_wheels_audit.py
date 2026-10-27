"""M15: release.sh refuses to sign while a pinned wheel has a known advisory (OSV) that build/wheels-advisories.allow
doesn't name with a one-line reason; an entry without a reason, or no answer from OSV, refuses too.

Runs anywhere: OSV is faked.
    python3 -m unittest discover -s appliance/tests
"""
import contextlib
import importlib.util
import io
import json
import pathlib
import re
import shutil
import tempfile
import unittest
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]


def load():
    spec = importlib.util.spec_from_file_location("tinhat_wheels_tool", REPO / "build/wheels.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


wheels = load()
PKGS = sorted({(e["name"], e["version"]) for e in wheels.entries()})


class FakeOSV:
    def __init__(self, vulns: dict | None = None, fail: Exception | None = None, short: bool = False):
        self.vulns, self.fail, self.short, self.asked = vulns or {}, fail, short, None

    def __call__(self, req, timeout=None):
        if self.fail:
            raise self.fail
        self.asked = json.loads(req.data)
        res = [{"vulns": [{"id": i} for i in self.vulns.get(q["package"]["name"], [])]} if
               self.vulns.get(q["package"]["name"]) else {} for q in self.asked["queries"]]
        return io.BytesIO(json.dumps({"results": res[:-1] if self.short else res}).encode())


class Audit(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)
        self.allow = self.d / "wheels-advisories.allow"

    def run_audit(self, osv, allow_text=None):
        if allow_text is not None:
            self.allow.write_text(allow_text)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(wheels.urllib.request, "urlopen", osv), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            try:
                rc = wheels.audit(self.allow)
            except SystemExit as e:
                rc = e.code
        return rc, out.getvalue(), err.getvalue()

    def test_every_pinned_version_is_asked_about(self):
        osv = FakeOSV()
        rc, out, _ = self.run_audit(osv)
        self.assertEqual(rc, 0)
        asked = {(q["package"]["name"], q["version"]) for q in osv.asked["queries"]}
        self.assertEqual(asked, set(PKGS))
        self.assertIn(("aiohttp", "3.14.5"), asked)
        self.assertEqual(out.count("no known advisories"), len(PKGS))

    def test_an_advisory_refuses(self):
        rc, out, err = self.run_audit(FakeOSV({"aiohttp": ["GHSA-aaaa-bbbb-cccc"]}))
        self.assertEqual(rc, 1)
        self.assertIn("GHSA-aaaa-bbbb-cccc NOT allowed", out)
        self.assertIn("move the lock on", err)

    def test_an_allowed_one_with_its_reason_passes_and_says_so(self):
        rc, out, _ = self.run_audit(FakeOSV({"aiohttp": ["GHSA-aaaa-bbbb-cccc"]}),
                                    "# reviewed 2026-10-26\nGHSA-aaaa-bbbb-cccc  client-side proxy auth only; we never use a proxy\n")
        self.assertEqual(rc, 0)
        self.assertIn("allowed (client-side proxy auth only; we never use a proxy)", out)

    def test_only_what_is_named_is_allowed(self):
        rc, out, _ = self.run_audit(FakeOSV({"aiohttp": ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]}),
                                    "GHSA-aaaa-bbbb-cccc  not reachable from our code\n")
        self.assertEqual(rc, 1)
        self.assertIn("GHSA-dddd-eeee-ffff NOT allowed", out)

    def test_an_exception_without_a_reason_is_refused(self):
        rc, _, err = self.run_audit(FakeOSV({"aiohttp": ["GHSA-aaaa-bbbb-cccc"]}), "GHSA-aaaa-bbbb-cccc\n")
        self.assertEqual(rc, 1)
        self.assertIn("has no reason", err)

    def test_a_stale_exception_is_reported(self):
        rc, _, err = self.run_audit(FakeOSV(), "GHSA-old0-old0-old0  fixed by the last move\n")
        self.assertEqual(rc, 0)
        self.assertIn("GHSA-old0-old0-old0, which no pinned package has any more", err)

    def test_no_answer_is_not_a_pass(self):
        for osv in (FakeOSV(fail=OSError("network down")), FakeOSV(fail=ValueError("not json")), FakeOSV(short=True)):
            with self.subTest(osv=osv.fail or "short"):
                rc, _, err = self.run_audit(osv)
                self.assertEqual(rc, 1)
                self.assertIn("not checked, so refused", err)

    def test_the_shipped_allowlist_parses(self):
        self.assertIsInstance(wheels.read_allow(REPO / "build/wheels-advisories.allow"), dict)


class ReleaseRefuses(unittest.TestCase):
    def test_release_sh_audits_before_anything_is_signed(self):
        rel = (REPO / "build/release.sh").read_text()
        audit = rel.index('python3 "$HERE/build/wheels.py" audit ||')
        self.assertIn("exit 1", rel[audit: audit + 200])
        for later in ("read -rsp", "\nsign() {", 'tar -C "$B/b"'):
            self.assertLess(audit, rel.index(later), later)
        self.assertFalse(re.search(r"wheels\.py audit[^\n]*\|\|\s*true", rel))  # never waved through


if __name__ == "__main__":
    unittest.main()

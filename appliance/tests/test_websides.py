"""The web app's pre-compressed copies made on the box after an update (websides.py + sidefiles.mjs), and the
updater's web lock (updater.replace_web):
 - a copy is put in only if it decodes (Node, after reading it back from disk) to exactly the file next to it, and
   only if the file and the copy still have the sha256s Node reported, under the web lock
 - no stale copy is ever served: an update's web swap leaves none (bundles carry none), a rollback brings back the
   copies that belong to the old web, and a copy that isn't on the record is moved out of Caddy's sight at once
 - never in an update's way: skipped while an update holds its lock, stopped when one starts, nothing on low disk,
   a run cut short installs only what was finished
Runs Node's part with plain Node when `node` is installed (the box runs it in the tinhat/api image); with
TINHAT_TEST_CADDY the gates are also checked over HTTP, as a browser would get the files.
    python3 -m unittest discover -s appliance/tests
"""
import contextlib
import fcntl
import gzip
import http.client
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from test_manager_limits import templates, CADDY

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "appliance/rootfs/opt/tinhat/manager/tinhat"
NODE = shutil.which("node")
BROTLI = shutil.which("brotli")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


websides = load("websides_under_test", PKG / "websides.py")
updater = load("updater_under_test", PKG / "updater.py")
precompress = load("precompress_for_websides", ROOT / "build/precompress.py")


def node_runner(jobs, web, out, budget, should_stop):
    """sidefiles.mjs with plain Node on the test's folders, watched like the container (the box: docker_runner)."""
    env = {**os.environ, "SIDEFILES_WEB": str(web), "SIDEFILES_OUT": str(out)}
    (out.parent / "jobs.json").write_text(json.dumps(jobs))
    return websides._watch([NODE, str(PKG / "sidefiles.mjs")], out.parent / "jobs.json", out.parent / "results.jsonl",
                           budget, should_stop, lambda p: p.kill(), env=env)


def after_node(change):
    """node_runner, then `change(out)` on what Node left in its folder (a writer in the container's folder)."""
    def runner(jobs, web, out, budget, should_stop):
        text = node_runner(jobs, web, out, budget, should_stop)
        change(out)
        return text
    return runner


def brotli_decode(b: bytes) -> bytes:
    r = subprocess.run([BROTLI, "-d", "-c"], input=b, capture_output=True)
    if r.returncode:
        raise ValueError("not brotli")
    return r.stdout


def build(web: pathlib.Path, tag: str) -> dict:
    """A small web build: its files' bytes by name (`tag` makes each build's content its own)."""
    files = {
        "index.html": f"<!doctype html><title>{tag}</title>" + f"<p>{tag} app</p>" * 400,
        "sw.js": f"self.v='{tag}';\n" * 300,
        "push-sw.js": f"self.push='{tag}';\n" * 200,
        "version.json": json.dumps({"version": tag, "pad": "x" * 1200}),
        f"assets/index-{tag}.js": f"export const build = '{tag}';\n" * 3000,
        f"assets/index-{tag}.css": f".{tag}{{color:#111}}\n" * 800,
        "assets/sync.worker-same.js": "self.onmessage = () => 1;\n" * 900,  # in both builds, unchanged
        "iconpack/a.svg": "<svg>" + "<g/>" * 600 + "</svg>",
        "assets/tiny-1.js": "export{}\n",
    }
    for rel, text in files.items():
        p = web / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return {k: v.encode() for k, v in files.items()}


class Box(unittest.TestCase):
    """websides and the updater pointed at a temporary /opt/tinhat + /var/lib/tinhat."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        opt, state = self.root / "opt", self.root / "state"
        self.web = opt / "web"
        self.web.mkdir(parents=True)
        for mod, names in ((websides, {"OPT": opt, "STATE": state, "WEB": self.web, "UPDATES": state / "updates",
                                       "WEB_LOCK": state / "updates/.web.lock", "UPDATE_LOCK": state / "updates/.update.lock",
                                       "MANIFEST": state / "web-sidefiles.json", "TMP": opt / ".web-sidefiles"}),
                           (updater, {"OPT": opt, "STATE": state, "DIR": state / "updates",
                                      "LOCK": state / "updates/.update.lock"})):
            for k, v in names.items():
                p = mock.patch.object(mod, k, v)
                p.start()
                self.addCleanup(p.stop)
        (state / "updates").mkdir(parents=True)
        self.free = lambda: 1 << 40

    def run_sides(self, **kw):
        kw.setdefault("runner", node_runner)
        kw.setdefault("free", self.free)
        return websides.run(self.web, **kw)

    def copies(self) -> dict:
        return {str(p.relative_to(self.web)): p.read_bytes() for p in self.web.rglob("*.br")}

    def assert_every_copy_is_its_file(self):
        for rel, data in self.copies().items():
            self.assertEqual(brotli_decode(data), (self.web / rel[:-3]).read_bytes(), rel)

    @contextlib.contextmanager
    def held(self, path):
        """Another process's lock (flock conflicts between two opens, even in one process)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


class TheChoice(unittest.TestCase):
    def test_same_files_as_the_build_tool_and_caddy(self):
        self.assertEqual(websides.EXTENSIONS, precompress.EXTENSIONS)
        self.assertEqual(websides.MIN_SIZE, precompress.MIN_SIZE)
        self.assertEqual(websides.SKIP_DIRS, precompress.SKIP_DIRS)
        self.assertEqual(tuple(f".{e}" for e, _ in templates.WEB_TYPES), websides.EXTENSIONS)

    def test_the_container(self):
        calls = []

        def fake(cmd, **kw):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, b"", b"")
        with mock.patch.object(websides, "api_image", return_value="tinhat/api:9.9.9"), \
                mock.patch.object(websides.subprocess, "run", side_effect=fake):
            d = pathlib.Path(tempfile.mkdtemp())
            self.addCleanup(shutil.rmtree, d)
            (d / "out").mkdir()
            with mock.patch.object(websides, "_watch", side_effect=lambda cmd, *a, **k: calls.append(cmd) or ""):
                websides.docker_runner({"jobs": []}, pathlib.Path("/opt/tinhat/web"), d / "out", 5, lambda: False)
        run = next(c for c in calls if c[:2] == ["docker", "run"])
        joined = " ".join(run)
        for want in ("--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--cpus 1",
                     "--memory 512m", "--pids-limit 32", "-v /opt/tinhat/web:/web:ro", "--user 65534:65534",
                     "--entrypoint timeout tinhat/api:9.9.9 -s KILL 65 node /sidefiles.mjs"):
            self.assertIn(want, joined)
        self.assertIn("--cpu-shares", run)
        self.assertEqual(calls[0][:3], ["docker", "rm", "-f"], "a container left from before goes first")
        self.assertEqual(calls[-2][:3], ["docker", "rm", "-f"], "and it is gone before anything it wrote is used")
        self.assertIn(f"{d / 'out'}:/out", joined, "its own folder for this run only")

    def test_the_image_is_the_one_compose_runs(self):
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        (d / "compose.yaml").write_text("services:\n  api:\n    image: tinhat/api:0.3.15\n  x:\n    image: postgres:17\n")
        with mock.patch.object(websides.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"sha256:x", b"")) as r:
            self.assertEqual(websides.api_image(d), "tinhat/api:0.3.15")
            self.assertEqual(r.call_args[0][0][-1], "tinhat/api:0.3.15")
        with mock.patch.object(websides.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"")):
            self.assertIsNone(websides.api_image(d), "not on this box: no copies, plain files")


@unittest.skipUnless(NODE and BROTLI, "needs node and brotli")
class Making(Box):
    def test_makes_checked_copies_once(self):
        files = build(self.web, "v1")
        r = self.run_sides()
        self.assertTrue(r["done"], r)
        want = {f"{k}.br" for k, v in files.items() if len(v) >= 1024 and not k.startswith("iconpack/")}
        self.assertEqual(set(self.copies()), want)
        self.assert_every_copy_is_its_file()
        for rel in want:
            src = self.web / rel[:-3]
            self.assertEqual((self.web / rel).stat().st_mtime_ns, (src.stat().st_mtime_ns // 10**9 + 1) * 10**9)
        self.assertFalse(websides.TMP.exists(), "nothing left beside the web folder")
        m = json.loads(websides.MANIFEST.read_text())
        self.assertEqual(set(m["files"]), want)
        self.assertEqual(m["web"], websides.web_signature(self.web))
        r = self.run_sides()
        self.assertEqual(r["jobs"], 0, "nothing to do the second time")

    def test_a_copy_corrupted_after_its_check_is_never_put_in(self):
        files = build(self.web, "v1")
        outside = self.root / "outside.txt"
        outside.write_text("keep me")

        def tamper(out):
            rows = {json.loads(l)["rel"]: json.loads(l)["out"] for l in (out.parent / "results.jsonl").read_text().splitlines()}
            (out / rows["index.html"]).write_bytes(gzip.compress(files["index.html"]))  # wrong data, brotli's name
            (out / rows["sw.js"]).unlink()
            (out / rows["sw.js"]).symlink_to(outside)  # a link planted where a copy was
        r = self.run_sides(runner=after_node(tamper))
        self.assertEqual(r["results"].get("copy changed after its check"), 1, r)
        self.assertEqual(r["results"].get("copy gone"), 1, r)
        self.assertNotIn("index.html.br", self.copies())
        self.assertNotIn("sw.js.br", self.copies())
        self.assertEqual(outside.read_text(), "keep me")
        self.assert_every_copy_is_its_file()
        self.assertFalse(r["done"])

    def test_the_checked_bytes_go_in_not_the_folders_file(self):
        build(self.web, "v1")

        def swap(src, where):  # after the manager read and checked the copy: the output folder's file replaced
            where.write_bytes(b"not brotli at all")
        r = self.run_sides(before_replace=swap)
        self.assertTrue(r["done"], r)
        self.assert_every_copy_is_its_file()
        for p in self.web.rglob("*.br"):
            self.assertEqual(os.stat(p).st_nlink, 1, "a file of the manager's own, not a link to the container's")

    def test_a_file_that_changed_after_the_check_gets_no_copy(self):
        build(self.web, "v1")

        def change(src, where):
            if src.name == "sw.js":
                src.write_text("self.v='changed';\n" * 300)
        r = self.run_sides(before_replace=change)
        self.assertEqual(r["results"].get("file changed"), 1, r)
        self.assertNotIn("sw.js.br", self.copies())
        self.assertFalse(r["done"])
        r = self.run_sides()
        self.assertIn("sw.js.br", self.copies(), "made from the new file the next time")
        self.assert_every_copy_is_its_file()

    def test_a_file_that_changed_after_node_read_it_gets_no_copy(self):
        build(self.web, "v1")

        def change(out):  # between Node's read and the manager's: the file is another one now
            (self.web / "push-sw.js").write_text("self.push='changed';\n" * 200)
        r = self.run_sides(runner=after_node(change))
        self.assertEqual(r["results"].get("file changed"), 1, r)
        self.assertNotIn("push-sw.js.br", self.copies())
        self.assert_every_copy_is_its_file()

    def test_a_fifo_in_the_output_folder(self):
        build(self.web, "v1")

        def fifo(out):
            rows = {json.loads(l)["rel"]: json.loads(l)["out"] for l in (out.parent / "results.jsonl").read_text().splitlines()}
            (out / rows["sw.js"]).unlink()
            os.mkfifo(out / rows["sw.js"])  # would block a plain open() for ever
        t0 = time.monotonic()
        r = self.run_sides(runner=after_node(fifo))
        self.assertLess(time.monotonic() - t0, 30)
        self.assertEqual(r["results"].get("copy gone"), 1, r)
        self.assertNotIn("sw.js.br", self.copies())

    def test_a_scratch_folder_that_isnt_ours_is_made_again(self):
        build(self.web, "v1")
        websides.TMP.mkdir(mode=0o777)
        os.chmod(websides.TMP, 0o777)  # left open by someone: anyone could swap what's staged in it
        (websides.TMP / "held").mkdir()
        (websides.TMP / "held" / "h1.br").write_bytes(b"planted")
        (websides.TMP / "held" / "held.json").write_text('{"h1.br": "index.html"}')
        r = self.run_sides()
        self.assertTrue(r["done"], r)
        self.assert_every_copy_is_its_file()
        self.assertFalse(websides.TMP.exists() and (websides.TMP / "held" / "h1.br").exists())

    def test_a_build_swapped_during_the_run_is_not_marked_done(self):
        build(self.web, "v1")
        staged = self.root / "staged-web"
        build(staged, "v2")

        def swap(out):
            updater.replace_web(staged)
        r = self.run_sides(runner=after_node(swap))
        self.assertFalse(r["done"], r)
        m = json.loads(websides.MANIFEST.read_text())
        self.assertNotIn("web", m, "v2 isn't done: its copies were never made")
        self.assert_every_copy_is_its_file()
        # only a copy that is right for v2 too (a file the two builds share byte for byte) may be there
        self.assertLessEqual(set(self.copies()), {"assets/sync.worker-same.js.br"}, "nothing of v1's own put into v2")

    def test_an_update_right_after_the_check_doesnt_mark_the_new_build_done(self):
        build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        staged = self.root / "staged-web"
        shutil.copytree(self.web, staged, ignore=shutil.ignore_patterns("*.br"))
        for p in staged.rglob("*"):  # v2: the same names with new content, and one file more
            if p.is_file():
                p.write_bytes(p.read_bytes().replace(b"v1", b"v2"))
        (staged / "assets/extra-v2.js").write_text("export const extra = 2;\n" * 900)
        real = websides.reconcile

        def check_then_update(web=None, wait=10.0):  # the update finishes just after this run's check
            r = real(web, wait)
            updater.replace_web(staged)
            return r
        with mock.patch.object(websides, "reconcile", side_effect=check_then_update):
            r = self.run_sides()
        self.assertFalse(r["done"], r)
        self.assertNotEqual(json.loads(websides.MANIFEST.read_text()).get("web"), websides.web_signature(self.web))
        self.assertNotIn("assets/extra-v2.js.br", self.copies(), "a file this run never saw")
        self.assert_every_copy_is_its_file()
        r = self.run_sides()  # the next run makes v2's copies
        self.assertTrue(r["done"], r)
        self.assertIn("index.html.br", self.copies())
        self.assert_every_copy_is_its_file()

    def test_start_up_clears_a_crashed_run_and_retries_a_skipped_check(self):
        build(self.web, "v1")
        old = websides.TMP / "run-old" / "out"
        old.mkdir(parents=True, mode=0o700)
        os.chmod(websides.TMP, 0o700)
        os.chmod(websides.TMP / "run-old", 0o700)
        (old / "w1.br").write_bytes(b"x" * 1000)
        with mock.patch.object(websides, "remove_container"):
            with self.held(websides.UPDATE_LOCK):
                websides.startup()
            self.assertFalse((websides.TMP / "run-old").exists(), "a crashed run's folder is gone")
            with mock.patch.object(websides, "_started", time.monotonic() - 10_000):
                websides.mark_tried()
                self.assertTrue(websides.due(), "the start-up check was skipped (an update): asked for again")
                websides.startup()
                self.run_sides()
                self.assertFalse(websides.due())

    def test_a_refused_held_copy_is_made_again_on_the_next_run(self):
        build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        (self.web / "sw.js.br").write_bytes(subprocess.run([BROTLI, "-c"], input=b"other" * 400, capture_output=True).stdout)
        with mock.patch.object(websides, "_started", time.monotonic() - 10_000):
            websides.mark_tried()
            r = self.run_sides()
            self.assertEqual(r.get("refused_held"), 1, r)
            self.assertTrue(websides.due(), "not an hour later: the next minute")
            self.run_sides()
            self.assertIn("sw.js.br", self.copies())
            self.assert_every_copy_is_its_file()

    def test_node_refuses_a_held_copy_that_isnt_the_file(self):
        build(self.web, "v1")
        websides.TMP.mkdir()
        (websides.TMP / "h1.br").write_bytes(subprocess.run([BROTLI, "-c"], input=b"something else" * 100,
                                                            capture_output=True).stdout)
        out = node_runner({"jobs": [{"rel": "index.html", "mode": "check", "out": "h1.br"},
                                    {"rel": "../etc/passwd", "mode": "make", "out": "w1.br"},
                                    {"rel": "index.html", "mode": "make", "out": "../x.br"}]}, self.web, websides.TMP,
                          30, lambda: False)
        rows = [json.loads(l) for l in out.splitlines()]
        self.assertEqual([r["ok"] for r in rows], [False, False, False])
        self.assertEqual(rows[0]["why"], "decodes to something else")
        self.assertEqual({r["why"] for r in rows[1:]}, {"bad job"})


@unittest.skipUnless(NODE and BROTLI, "needs node and brotli")
class NeverInTheWay(Box):
    def test_skipped_while_an_update_runs(self):
        build(self.web, "v1")
        with self.held(websides.UPDATE_LOCK):
            r = self.run_sides()
        self.assertIn("an update", r.get("skipped", ""))
        self.assertEqual(self.copies(), {})

    def test_stops_when_an_update_starts(self):
        build(self.web, "v1")
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        started = []

        def update_starts(src, where):
            if not started:
                started.append(1)
                fh = stack.enter_context(open(websides.UPDATE_LOCK, "a"))
                fcntl.flock(fh, fcntl.LOCK_EX)
        r = self.run_sides(before_replace=update_starts)
        self.assertIn("update", r.get("stopped", ""), r)
        self.assertEqual(self.copies(), {}, "checked again under the web lock: nothing goes in once an update holds its lock")
        self.assertFalse(r["done"])

    def test_waits_for_the_web_lock_and_gives_up(self):
        build(self.web, "v1")
        with self.held(websides.WEB_LOCK):
            t0 = time.monotonic()
            r = self.run_sides()
        self.assertLess(time.monotonic() - t0, 20)
        self.assertEqual(self.copies(), {})
        self.assertFalse(r["done"])

    def test_low_disk(self):
        build(self.web, "v1")
        r = self.run_sides(free=lambda: 1 << 20)
        self.assertEqual(r.get("skipped"), "not enough free disk")
        self.assertEqual(self.copies(), {})

    def test_a_run_cut_short_installs_only_finished_copies(self):
        build(self.web, "v1")

        def cut(jobs, web, out_dir, budget, should_stop):
            out = node_runner(jobs, web, out_dir, budget, should_stop).splitlines()
            (out_dir / "w99.br").write_bytes(b"half")  # a file still being written when the budget ran out
            return "\n".join(out[:2]) + "\n" + out[2][: len(out[2]) // 2]  # a line cut in the middle
        r = self.run_sides(runner=cut)
        self.assertEqual(r["results"].get("installed"), 2)
        self.assertEqual(len(self.copies()), 2)
        self.assert_every_copy_is_its_file()
        self.assertFalse(r["done"])
        self.assertEqual([p.name for p in websides.TMP.iterdir()] if websides.TMP.exists() else [], [],
                         "this run's folder is gone")

    def test_stops_a_running_node_when_a_call_starts(self):
        build(self.web, "v1")
        t0 = time.monotonic()
        calls = iter([False, False] + [True] * 100)

        def slow(jobs, web, out, budget, should_stop):  # a long compression: the watch kills it
            (out.parent / "jobs.json").write_text("{}")
            return websides._watch(["sleep", "60"], out.parent / "jobs.json", out.parent / "r.txt", budget, should_stop,
                                   lambda p: p.kill())
        r = self.run_sides(runner=slow, should_stop=lambda: next(calls))
        self.assertLess(time.monotonic() - t0, 15, "stopped within seconds")
        self.assertEqual(self.copies(), {})
        self.assertFalse(r["done"])

    def test_the_budget(self):
        build(self.web, "v1")

        def slow(jobs, web, out, budget, should_stop):
            (out.parent / "jobs.json").write_text("{}")
            return websides._watch(["sleep", "60"], out.parent / "jobs.json", out.parent / "r.txt", budget, should_stop,
                                   lambda p: p.kill())
        t0 = time.monotonic()
        r = self.run_sides(runner=slow, budget=2)
        self.assertLess(time.monotonic() - t0, 15)
        self.assertFalse(r["done"])

    def test_the_call_flag(self):
        build(self.web, "v1")
        websides.STOP.set()
        self.addCleanup(websides.STOP.clear)
        r = websides.run(self.web, runner=node_runner, free=self.free)
        self.assertIn("skipped", r)
        self.assertEqual(self.copies(), {})

    def test_a_record_that_doesnt_read_right(self):
        build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        for bad in ('{"files": {"index.html.br": 1}}', "[]", "not json", '{"files": []}',
                    '{"files": {"index.html.br": {"src": "x", "side": "y"}}}'):
            with self.subTest(bad):
                websides.MANIFEST.write_text(bad)
                (websides.TMP / "held").mkdir(parents=True, exist_ok=True)
                (websides.TMP / "held" / "held.json").write_text("[]")
                r = websides.reconcile(self.web)
                self.assertEqual(r["kept"], 0, "nothing on a record that doesn't read right is trusted")
                self.assertEqual(self.copies(), {}, "every copy out of sight")
                r = self.run_sides()
                self.assertTrue(r["done"], r)
                self.assert_every_copy_is_its_file()

    def test_a_copy_gone_bad_after_a_finished_run_is_redone(self):
        build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        with mock.patch.object(websides, "_started", time.monotonic() - 10_000):
            websides.mark_tried()
            self.assertFalse(websides.due())
            (self.web / "sw.js.br").write_bytes(b"\x0b\x00\x80")  # disk trouble, or a hand
            websides.reconcile(self.web)
            self.assertNotIn("sw.js.br", self.copies())
            self.assertTrue(websides.due(time.time() + websides.RETRY + 1), "the build isn't done any more")
            self.run_sides()
            self.run_sides()
            self.assertIn("sw.js.br", self.copies())
            self.assert_every_copy_is_its_file()

    def test_a_runner_that_fails(self):
        build(self.web, "v1")

        def boom(*a):
            raise RuntimeError("no tinhat/api image to make the copies with")
        r = self.run_sides(runner=boom)
        self.assertIn("no tinhat/api image", r.get("error", ""))
        self.assertEqual(self.copies(), {})

    def test_due(self):
        build(self.web, "v1")
        with mock.patch.object(websides, "_started", time.monotonic()):
            self.assertFalse(websides.due(), "not right after the manager started")
        with mock.patch.object(websides, "_started", time.monotonic() - 10_000):
            self.assertTrue(websides.due())
            websides.mark_tried()
            self.assertFalse(websides.due(), "tried for this web: not again within the hour")
            self.assertTrue(websides.due(time.time() + 4000))
            self.run_sides()
            self.assertFalse(websides.due(time.time() + 10**6), "done for this web build")
            (self.web / "version.json").write_text('{"version": "v2"}')
            self.assertTrue(websides.due(), "a new web build")
            with self.held(websides.UPDATE_LOCK):
                self.assertFalse(websides.due())


class TheRelease(unittest.TestCase):
    def test_the_bundle_has_no_copies(self):
        text = (ROOT / "build/release.sh").read_text()
        cp = text.index('cp -a "$R/web" "$B/b/web"\n')
        strip = text.index('python3 "$HERE/build/precompress.py" strip "$B/b/web"', cp)
        tar = text.index('tar -C "$B/b"', cp)
        self.assertLess(strip, tar, "stripped before the bundle is packed")
        self.assertIn("24 * 1024 * 1024", text, "the mirror's cap stays as it was")


class TheUpdaterLock(Box):
    def test_one_lock_for_both(self):
        self.assertEqual(updater.STATE / updater.WEB_LOCK, websides.WEB_LOCK)
        self.assertEqual(updater.LOCK, websides.UPDATE_LOCK)

    def test_replace_web_waits_for_the_web_lock(self):
        build(self.web, "v1")
        new = self.root / "new"
        build(new, "v2")
        done = threading.Event()
        with self.held(websides.WEB_LOCK):
            t = threading.Thread(target=lambda: (updater.replace_web(new), done.set()))
            t.start()
            time.sleep(0.5)
            self.assertFalse(done.is_set(), "the swap waits while a copy is being put in")
        t.join(10)
        self.assertTrue(done.is_set())
        self.assertEqual((self.web / "index.html").read_bytes(), (new / "index.html").read_bytes())

    def test_the_snapshot_copy_waits_for_the_web_lock(self):
        build(self.web, "v1")
        done = threading.Event()
        dst = self.root / "snap-web"
        with self.held(websides.WEB_LOCK):
            t = threading.Thread(target=lambda: (updater.copy_web(dst), done.set()))
            t.start()
            time.sleep(0.5)
            self.assertFalse(done.is_set(), "no copy moves while the snapshot is taken")
        t.join(10)
        self.assertTrue(done.is_set())
        self.assertTrue((dst / "index.html").is_file())

    def test_reconcile_never_touches_the_folder_during_an_update(self):
        build(self.web, "v1")
        (self.web / "index.html.br").write_bytes(b"\x0b\x00\x80")
        with self.held(websides.UPDATE_LOCK):
            r = websides.reconcile(self.web)
        self.assertEqual(r.get("skipped"), "an update is running")
        self.assertTrue((self.web / "index.html.br").exists(), "left alone until the update is over")

    def test_every_web_swap_is_under_the_lock(self):
        for name in ("updater.py", "compose_entry.py"):
            text = (PKG / name).read_text()
            calls = [l for l in text.splitlines() if "replace_contents(" in l and "def replace_contents" not in l]
            self.assertEqual([l.strip() for l in calls], ["replace_contents(src, dst or OPT / \"web\")"] if name == "updater.py" else [],
                             f"{name}: the web folder changes only through replace_web")
            copies = [l.strip() for l in text.splitlines() if "copytree(OPT / \"web\"" in l]
            self.assertEqual(copies, ["shutil.copytree(OPT / \"web\", dst)"] if name == "updater.py" else [],
                             f"{name}: snapshots copy the web folder only through copy_web")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(NODE and BROTLI, "needs node and brotli")
class NoStaleCopy(Box):
    """Launch-gate's first gate: after an update, after the copies are made, and after a rollback, every encoding a
    browser can get is the bytes of the web build that is in the folder. Over HTTP with TINHAT_TEST_CADDY."""

    def setUp(self):
        super().setUp()
        self.caddy = None
        if CADDY and os.access(CADDY, os.X_OK):
            self.port = _free_port()
            cf = self.root / "Caddyfile"
            cf.write_text("{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}\n"
                          f"http://127.0.0.1:{self.port} {{\n\tencode zstd gzip\n"
                          + templates.web_app_block("").replace("/srv/web", str(self.web)) + "}\n")
            env = {"HOME": str(self.root), "XDG_DATA_HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root), "PATH": "/usr/bin:/bin"}
            self.caddy = subprocess.Popen([CADDY, "run", "--config", str(cf)], stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, env=env, start_new_session=True)
            self.addCleanup(self._stop)
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)

    def _stop(self):
        self.caddy.terminate()
        self.caddy.wait(10)

    def served(self, build_files: dict, label: str):
        """Every file of the build, as br / gzip / identity browsers get it, is exactly that build's bytes."""
        paths = {"/": "index.html", "/room/x": "index.html", "/sw.js": "sw.js", "/push-sw.js": "push-sw.js",
                 "/version.json": "version.json"}
        paths.update({f"/{k}": k for k in build_files if k.startswith("assets/")})
        if not self.caddy:  # no Caddy: what Caddy would pick (the copy when there is one), read from the folder
            for rel, want in build_files.items():
                side = self.web / (rel + ".br")
                if side.exists():
                    self.assertEqual(brotli_decode(side.read_bytes()), want, f"{label}: {rel}.br")
            return
        for path, rel in paths.items():
            for ae in ("gzip, deflate, br, zstd", "gzip", "identity"):
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
                c.request("GET", path, headers={"Accept-Encoding": ae})
                r = c.getresponse()
                body = r.read()
                enc = r.getheader("Content-Encoding") or ""
                c.close()
                self.assertEqual(r.status, 200, f"{label}: {path} [{ae}]")
                got = {"br": brotli_decode, "gzip": gzip.decompress, "": lambda b: b,
                       "zstd": lambda b: subprocess.run(["zstd", "-d", "-c"], input=b, capture_output=True).stdout}[enc](body)
                self.assertEqual(got, build_files[rel], f"{label}: {path} [{ae}] as {enc or 'identity'}")

    def test_update_copies_rollback(self):
        v1 = build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        self.served(v1, "v1 with its copies")
        self.assertTrue(self.copies())
        # the update: a snapshot (updater.snapshot copies the web folder as it is) and the new build in, which has no
        # copies (release.sh strips them from the bundle)
        snap = self.root / "snap-web"
        shutil.copytree(self.web, snap)
        staged = self.root / "staged-web"
        v2 = build(staged, "v2")
        # the release's web as build.sh staged it (with copies), then as release.sh puts it in the bundle
        subprocess.run([sys.executable, ROOT / "build/precompress.py", "make", staged], check=True, capture_output=True)
        self.assertTrue(list(staged.rglob("*.br")))
        precompress.strip(staged)
        self.assertEqual(list(staged.rglob("*.br")), [], "the bundle carries no copies")
        updater.replace_web(staged)
        self.assertEqual(self.copies(), {}, "right after the swap: no copy at all")
        self.served(v2, "v2 before its copies")
        websides.reconcile(self.web)
        self.assertTrue(self.run_sides()["done"])
        self.assertTrue(self.copies())
        self.assert_every_copy_is_its_file()
        self.served(v2, "v2 with its copies")
        # a rollback: the snapshot back, with the copies that belong to it, and none of v2's
        updater.replace_web(snap)
        self.assertEqual({k: brotli_decode(v) for k, v in self.copies().items()},
                         {f"{k}.br": v for k, v in v1.items() if f"{k}.br" in self.copies()})
        self.assertFalse(any("v2" in k for k in self.copies()))
        self.served(v1, "v1 after the rollback")
        websides.reconcile(self.web)  # the manager starting again: v1's copies aren't on the record any more → held
        self.served(v1, "v1 while its copies are held")
        r = self.run_sides()
        self.assertTrue(r["done"], r)
        self.served(v1, "v1 with its copies checked again")
        self.assert_every_copy_is_its_file()

    def test_a_planted_stale_copy_is_caught_and_moved_out(self):
        v1 = build(self.web, "v1")
        self.assertTrue(self.run_sides()["done"])
        stale = (self.web / "index.html.br").read_bytes()
        staged = self.root / "staged-web"
        v2 = build(staged, "v2")
        precompress.strip(staged)
        updater.replace_web(staged)
        (self.web / "index.html.br").write_bytes(stale)  # left over from v1 (by hand: no updater path leaves one)
        # negative control: the check sees the old app being served
        with self.assertRaises(AssertionError):
            self.served(v2, "planted")
        r = websides.reconcile(self.web)
        self.assertEqual(r["held"], 1)
        self.assertNotIn("index.html.br", self.copies(), "out of Caddy's sight at once")
        self.served(v2, "v2 after the check moved it out")
        r = self.run_sides()
        self.assertEqual(r["results"].get("decodes to something else"), 1, r)
        self.assertNotIn("index.html.br", self.copies(), "never put back")
        self.run_sides()  # the next run makes a real one
        self.assertIn("index.html.br", self.copies())
        self.assert_every_copy_is_its_file()
        self.served(v2, "v2 with a real copy")

    def test_a_copy_from_the_image_is_checked_then_kept(self):
        v1 = build(self.web, "v1")
        subprocess.run([sys.executable, ROOT / "build/precompress.py", "make", self.web], check=True, capture_output=True)
        made = self.copies()
        r = websides.reconcile(self.web)
        self.assertEqual(r["held"], len(made), "not on this box's record yet: held until Node checks them")
        r = self.run_sides()
        self.assertTrue(r["done"], r)
        self.assertEqual(set(self.copies()), set(made))
        self.assert_every_copy_is_its_file()
        self.served(v1, "v1 with the image's copies")

    def test_links_and_zstd_and_strangers(self):
        build(self.web, "v1")
        outside = self.root / "outside.txt"
        outside.write_text("x")
        (self.web / "sw.js.br").symlink_to(outside)
        (self.web / "push-sw.js.zst").write_bytes(b"\x28\xb5\x2f\xfd")
        (self.web / "assets/backup-1.tar.zst").write_bytes(b"\x28\xb5\x2f\xfd" + b"x" * 10)
        (self.web / "iconpack/a.svg.br").write_bytes(b"\x0b\x00\x80")
        websides.reconcile(self.web)
        self.assertFalse((self.web / "sw.js.br").exists() or (self.web / "sw.js.br").is_symlink())
        self.assertEqual(outside.read_text(), "x")
        self.assertFalse((self.web / "push-sw.js.zst").exists(), "the box makes brotli only")
        self.assertTrue((self.web / "assets/backup-1.tar.zst").exists(), "not one of ours")
        self.assertTrue((self.web / "iconpack/a.svg.br").exists(), "not one of ours")


if __name__ == "__main__":
    unittest.main()

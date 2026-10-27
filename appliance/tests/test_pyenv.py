"""M15: the pinned aiohttp (tinhat/pyenv.py, build/wheels.lock, build/wheels.py).

Runs anywhere (standard library only). Two parts need more and are skipped without it:
  - TINHAT_TEST_WHEELS=DIR (build/wheels.py fetch DIR) and a Python the lock has wheels for: a real venv is built from
    the wheels offline, checked, broken, refused and rebuilt;
  - running inside a venv that has aiohttp: SMOKE (the check every start runs) against it, for real.
    python3 -m unittest discover -s appliance/tests
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import signal
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
PKG = REPO / "appliance/rootfs/opt/tinhat/manager/tinhat"
LOCK = REPO / "build/wheels.lock"


def load(path=PKG / "pyenv.py", name="tinhat_pyenv_under_test"):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pyenv = load()
SHA = "a" * 64


def lock_line(name, version, file, sha=SHA):
    return f"{name} {version} {sha} https://files.pythonhosted.org/packages/ab/cd/{'e' * 60}/{file}\n"


GOOD = (lock_line("aiohttp", "3.14.5", "aiohttp-3.14.5-cp313-cp313-manylinux2014_x86_64.whl")
        + lock_line("aiohttp", "3.14.5", "aiohttp-3.14.5-py3-none-any.whl", "b" * 64)
        + lock_line("typing-extensions", "4.16.0", "typing_extensions-4.16.0-py3-none-any.whl")
        + lock_line("pip", "26.2.1", "pip-26.2.1-py3-none-any.whl"))


class TheLock(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)

    def parse(self, text):
        (self.d / "wheels.lock").write_text(text)
        return pyenv.read_lock(self.d / "wheels.lock")

    def test_the_shipped_lock(self):
        es = pyenv.read_lock(LOCK)
        names = {e["name"] for e in es}
        self.assertEqual(pyenv.aiohttp_version(es), "3.14.5")
        self.assertGreaterEqual(tuple(map(int, pyenv.aiohttp_version(es).split("."))), (3, 14, 4))  # the 1117xx fixes
        self.assertEqual(names, {"aiohttp", "multidict", "yarl", "propcache", "frozenlist", "aiosignal", "attrs",
                                 "aiohappyeyeballs", "idna", "typing-extensions", "pip"})
        compiled = {"aiohttp", "multidict", "yarl", "propcache", "frozenlist"}
        for machine in ("x86_64", "aarch64"):  # Debian 13's Python on both processors: every compiled part
            got = {e["name"] for e in es if "-cp313-cp313-" in e["file"] and e["file"].endswith(f"_{machine}.whl")
                   and "manylinux" in e["file"]}
            self.assertEqual(got, compiled, machine)
        pure = {e["name"] for e in es if e["file"].endswith("-py3-none-any.whl")}
        self.assertEqual(pure, names)  # any other Python 3.10+ (Ubuntu 24.04's 3.12) gets the whole set, pure Python
        for e in es:
            self.assertTrue(e["url"].startswith("https://files.pythonhosted.org/packages/"), e["file"])
            self.assertTrue(e["url"].endswith("/" + e["file"]))
        self.assertEqual(len({e["file"] for e in es}), len(es))

    def test_a_good_lock(self):
        es = self.parse("# comment\n\n" + GOOD)
        self.assertEqual([e["name"] for e in es], ["aiohttp", "aiohttp", "typing-extensions", "pip"])
        req = pyenv.requirements(es)
        self.assertEqual(req.splitlines(), [f"aiohttp==3.14.5 --hash=sha256:{SHA} --hash=sha256:{'b' * 64}",
                                            f"typing-extensions==4.16.0 --hash=sha256:{SHA}"])
        self.assertNotIn("pip", req)  # the installer, never installed

    def test_bad_locks_are_refused(self):
        bad = {
            "three fields": "aiohttp 3.14.5 " + SHA + "\n",
            "short sha": GOOD.replace(SHA, "abc", 1),
            "not https": GOOD.replace("https://", "http://", 1),
            "a path in the name": GOOD.replace("aiohttp-3.14.5-py3-none-any.whl", "..%2Fx-3.14.5-py3-none-any.whl"),
            "file of another package": GOOD.replace("aiohttp-3.14.5-py3-none-any.whl", "attrs-3.14.5-py3-none-any.whl"),
            "file of another version": GOOD.replace("aiohttp-3.14.5-py3-none-any.whl", "aiohttp-3.11.16-py3-none-any.whl"),
            "two versions": GOOD + lock_line("aiohttp", "3.11.16", "aiohttp-3.11.16-py3-none-any.whl"),
            "the same file twice": GOOD + lock_line("pip", "26.2.1", "pip-26.2.1-py3-none-any.whl"),
            "no pip": "".join(l for l in GOOD.splitlines(keepends=True) if not l.startswith("pip ")),
            "no aiohttp": "".join(l for l in GOOD.splitlines(keepends=True) if not l.startswith("aiohttp ")),
        }
        for what, text in bad.items():
            with self.subTest(what):
                with self.assertRaises(pyenv.Problem):
                    self.parse(text)
        with self.assertRaises(pyenv.Problem):
            pyenv.read_lock(self.d / "missing.lock")

    def test_verify_wants_every_file_with_its_hash(self):
        body = b"wheel bytes"
        sha = hashlib.sha256(body).hexdigest()
        es = self.parse(lock_line("aiohttp", "3.14.5", "aiohttp-3.14.5-py3-none-any.whl", sha)
                        + lock_line("pip", "26.2.1", "pip-26.2.1-py3-none-any.whl", sha))
        with self.assertRaisesRegex(pyenv.Problem, "missing"):
            pyenv.verify(self.d, es)
        (self.d / "aiohttp-3.14.5-py3-none-any.whl").write_bytes(body)
        (self.d / "pip-26.2.1-py3-none-any.whl").write_bytes(body + b"!")
        with self.assertRaisesRegex(pyenv.Problem, "sha256"):
            pyenv.verify(self.d, es)
        (self.d / "pip-26.2.1-py3-none-any.whl").unlink()
        (self.d / "pip-26.2.1-py3-none-any.whl").symlink_to(self.d / "aiohttp-3.14.5-py3-none-any.whl")
        with self.assertRaisesRegex(pyenv.Problem, "missing"):  # a link is never followed, even to a good file
            pyenv.verify(self.d, es)
        (self.d / "pip-26.2.1-py3-none-any.whl").unlink()
        (self.d / "pip-26.2.1-py3-none-any.whl").write_bytes(body)
        pyenv.verify(self.d, es)


class SameFileEverywhere(unittest.TestCase):
    def test_the_names_service_and_the_relay_carry_the_same_pyenv(self):
        main = (PKG / "pyenv.py").read_bytes()
        for copy in (REPO / "names/tinhat_names/pyenv.py", REPO / "relay/tinhat_relay/pyenv.py"):
            self.assertEqual(copy.read_bytes(), main, f"{copy} differs from tinhat/pyenv.py: copy it over")

    def test_it_needs_nothing_but_the_standard_library(self):
        import ast
        tree = ast.parse((PKG / "pyenv.py").read_text())
        mods = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        mods |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        self.assertLessEqual(mods, set(sys.stdlib_module_names))


class Choosing(unittest.TestCase):
    """choose(): onto the venv (exec) only when ensure() passes; anything else: the system's, said loudly, never raised."""

    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)
        self.wheels, self.venv, self.state = self.d / "wheels", self.d / "venv", self.d / "state"
        for p in (self.wheels, self.state):
            p.mkdir()
        (self.wheels / "wheels.lock").write_text(GOOD)
        self.lid = pyenv.lock_id(self.wheels)
        os.environ.pop(pyenv.INSIDE, None)
        self.addCleanup(os.environ.pop, pyenv.INSIDE, None)
        self.execs = []
        patches = [mock.patch.object(pyenv.os, "execve", side_effect=self._exec),
                   mock.patch.object(pyenv, "_inside", return_value=False),
                   mock.patch.object(pyenv, "aiohttp_here", return_value="3.11.16")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _exec(self, py, argv, env):
        self.execs.append((py, argv, env))
        raise SystemExit("exec")  # the real one never returns

    def choose(self, **kw):
        return pyenv.choose(venv=self.venv, wheels=self.wheels, state_dir=self.state, argv=["-m", "tinhat"],
                            name="the manager", **kw)

    def saved(self):
        return json.loads((self.state / pyenv.STATUS_FILE).read_text())

    def test_a_venv_that_passes_is_started(self):
        with mock.patch.object(pyenv, "ensure", return_value={"aiohttp": "3.14.5", "speedups": True}) as ens:
            with self.assertRaises(SystemExit):
                self.choose()
        ens.assert_called_once()
        py, argv, env = self.execs[0]
        self.assertEqual(py, str(self.venv / "bin/python3"))
        self.assertEqual(argv, [py, "-s", "-m", "tinhat"])  # no user site-packages either
        self.assertEqual(env[pyenv.INSIDE], str(self.venv))
        s = self.saved()
        self.assertEqual((s["runtime"], s["venv_id"], s["tries"], s["good"]), ("starting", self.lid, 1, False))

    def test_a_venv_that_fails_leaves_the_program_on_the_systems(self):
        with mock.patch.object(pyenv, "ensure", side_effect=pyenv.Problem("aiohttp 3.11.16 instead of 3.14.5")):
            st = self.choose()
        self.assertEqual(self.execs, [])
        self.assertEqual((st["runtime"], st["aiohttp"]), ("system", "3.11.16"))
        self.assertIn("instead of 3.14.5", st["reason"])
        self.assertEqual(pyenv.CURRENT, st)
        self.assertEqual(self.saved()["runtime"], "system")

    def test_nothing_unexpected_stops_the_program(self):
        for boom in (RuntimeError("disk on fire"), OSError(28, "No space left on device"), KeyError("x")):
            with self.subTest(boom=boom), mock.patch.object(pyenv, "ensure", side_effect=boom):
                st = self.choose()
                self.assertEqual(st["runtime"], "system")
                self.assertIn("unexpected", st["reason"])

    def test_no_wheels_shipped(self):
        (self.wheels / "wheels.lock").unlink()
        st = self.choose()  # the real ensure(): no lock
        self.assertEqual(st["runtime"], "system")
        self.assertIn("no wheels", st["reason"])

    def test_a_venv_it_keeps_stopping_on_is_left_alone_for_a_day(self):
        with mock.patch.object(pyenv, "ensure", return_value={}):
            for _ in range(pyenv.MAX_TRIES):  # started, never got going (no good start recorded)
                with self.assertRaises(SystemExit):
                    self.choose()
        self.assertEqual(len(self.execs), pyenv.MAX_TRIES)
        with mock.patch.object(pyenv, "ensure", return_value={}) as ens:
            st = self.choose()
        ens.assert_not_called()
        self.assertEqual(st["runtime"], "system")
        self.assertIn("stopped 2 times in a row", st["reason"])
        later = time.time() + pyenv.RETRY_AFTER + 60
        with mock.patch.object(pyenv, "ensure", return_value={}), mock.patch.object(pyenv.time, "time", return_value=later):
            with self.assertRaises(SystemExit):  # a day later: once more
                self.choose()
        self.assertEqual(self.saved()["tries"], 1)

    def test_a_good_start_clears_the_count(self):
        with mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):
                self.choose()
        pyenv._good_start(self.state, self.lid)
        s = self.saved()
        self.assertEqual((s["good"], s["tries"]), (True, 0))
        with mock.patch.object(pyenv, "ensure", return_value={}):
            for _ in range(pyenv.MAX_TRIES + 1):  # a good venv may be restarted any number of times
                with self.assertRaises(SystemExit):
                    self.choose()
                pyenv._good_start(self.state, self.lid)

    def test_a_new_release_starts_counting_again(self):
        (self.state / pyenv.STATUS_FILE).write_text(json.dumps(
            {"venv_id": "old", "tries": 9, "good": False, "last_try": int(time.time())}))
        with mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):
                self.choose()
        self.assertEqual(self.saved()["tries"], 1)

    def test_started_for_the_venv_but_not_in_it(self):
        os.environ[pyenv.INSIDE] = str(self.venv)
        with mock.patch.object(pyenv, "ensure") as ens:
            st = self.choose()
        ens.assert_not_called()
        self.assertEqual(st["runtime"], "system")
        self.assertIn("didn't start as the venv", st["reason"])
        self.assertNotIn(pyenv.INSIDE, os.environ)  # never handed on

    def spec(self, origin):
        return mock.patch.object(pyenv.importlib.util, "find_spec", return_value=types.SimpleNamespace(origin=origin))

    def test_inside_the_venv(self):
        os.environ[pyenv.INSIDE] = str(self.venv)
        here = os.path.join(sys.prefix, "lib", "site-packages", "aiohttp", "__init__.py")
        with mock.patch.object(pyenv, "_inside", return_value=True), mock.patch.object(pyenv, "ensure") as ens, \
                mock.patch.object(pyenv.threading, "Timer") as timer, self.spec(here), \
                mock.patch.object(pyenv, "aiohttp_here", return_value="3.14.5"):
            st = self.choose()
        ens.assert_not_called()
        self.assertEqual((st["runtime"], st["aiohttp"], st["reason"]), ("pinned", "3.14.5", None))
        self.assertNotIn(pyenv.INSIDE, os.environ)
        timer.assert_called_once()
        self.assertEqual(timer.call_args[0][0], pyenv.GRACE)
        self.assertEqual(self.saved()["runtime"], "pinned")

    def test_a_good_start_is_said_not_guessed(self):
        """grace=None (the manager): neither time nor an exit makes a start good; only started() does (a sys.exit(1)
        or a hang counts as a start that never got going)."""
        with mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):
                self.choose(grace=None)
        os.environ[pyenv.INSIDE] = str(self.venv)
        here = os.path.join(sys.prefix, "lib", "site-packages", "aiohttp", "__init__.py")
        with mock.patch.object(pyenv, "_inside", return_value=True), self.spec(here), \
                mock.patch.object(pyenv.threading, "Timer") as timer:
            self.choose(grace=None)
        timer.assert_not_called()
        self.assertFalse(self.saved()["good"])
        pyenv.started()
        self.assertEqual((self.saved()["good"], self.saved()["tries"]), (True, 0))

    def test_aiohttp_from_elsewhere_on_the_venv_isnt_called_pinned(self):
        os.environ[pyenv.INSIDE] = str(self.venv)
        elsewhere = "/srv/not-the-venv/dist-packages/aiohttp/__init__.py"  # (sys.prefix here is the test's Python's)
        with mock.patch.object(pyenv, "_inside", return_value=True), self.spec(elsewhere):
            st = self.choose()
        self.assertEqual(st["runtime"], "system")
        self.assertIn("not-the-venv", st["reason"])

    def test_started_straight_on_the_venv_goes_through_the_checks(self):
        with mock.patch.object(pyenv, "_inside", return_value=True), \
                mock.patch.object(pyenv, "base_python", return_value="/usr/bin/python3"):
            with self.assertRaises(SystemExit):
                self.choose()
        py, argv, env = self.execs[0]
        self.assertEqual((py, argv), ("/usr/bin/python3", ["/usr/bin/python3", "-m", "tinhat"]))
        self.assertNotIn(pyenv.INSIDE, env)

    def test_the_start_gets_only_the_import_environment_the_check_saw(self):
        with mock.patch.dict(os.environ, {"PYTHONPATH": "/usr/lib/python3/dist-packages", "PYTHONHOME": "/x",
                                          "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1", "KEEP_ME": "yes"}), \
                mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):
                self.choose()
        env = self.execs[0][2]
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("PYTHONHOME", env)
        self.assertEqual((env["PYTHONUNBUFFERED"], env["PYTHONDONTWRITEBYTECODE"], env["KEEP_ME"]), ("1", "1", "yes"))

    def test_a_start_that_cant_be_recorded_doesnt_happen(self):
        with mock.patch.object(pyenv, "ensure", return_value={}), mock.patch.object(pyenv, "_save", return_value=False):
            st = self.choose()
        self.assertEqual(self.execs, [])
        self.assertEqual(st["runtime"], "system")
        self.assertIn("can't be recorded", st["reason"])

    def test_a_failed_check_is_remembered_not_counted_as_a_crash(self):
        with mock.patch.object(pyenv, "ensure", side_effect=pyenv.Problem("its check failed")) as ens:
            self.assertEqual(self.choose()["runtime"], "system")
        ens.assert_called_once()
        for _ in range(pyenv.MAX_TRIES + 1):  # not built and checked again at every start (up to the budget each)
            with mock.patch.object(pyenv, "ensure") as ens:
                st = self.choose()
            ens.assert_not_called()
            self.assertEqual(st["runtime"], "system")
            self.assertIn("its check failed (found", st["reason"])
        self.assertEqual(self.saved().get("tries", 0), 0)  # never counted as a crash
        later = time.time() + pyenv.RETRY_AFTER + 60
        with mock.patch.object(pyenv, "ensure", return_value={}) as ens, mock.patch.object(pyenv.time, "time", return_value=later):
            with self.assertRaises(SystemExit):  # a day later: tried again
                self.choose()
        ens.assert_called_once()
        self.assertIsNone(self.saved()["failed"])

    def test_an_update_tries_a_remembered_failure_again(self):
        with mock.patch.object(pyenv, "ensure", side_effect=pyenv.Problem("its check failed")):
            self.choose()
        self.assertTrue(self.saved()["failed"])
        with mock.patch.object(pyenv, "ensure", return_value={"aiohttp": "3.14.5", "speedups": True, "missing": []}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pyenv.cli(["ensure"], venv=self.venv, wheels=self.wheels, state_dir=self.state,
                                       prog="tinhat pyenv"), 0)  # what after-update runs
        self.assertIsNone(self.saved()["failed"])
        with mock.patch.object(pyenv, "ensure", side_effect=pyenv.Problem("still broken")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pyenv.cli(["ensure"], venv=self.venv, wheels=self.wheels, state_dir=self.state,
                                       prog="tinhat pyenv"), 1)
        self.assertIn("still broken", self.saved()["failed"]["reason"])

    def test_the_owners_off_switch(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pyenv.cli(["off"], venv=self.venv, wheels=self.wheels, state_dir=self.state,
                                       prog="tinhat pyenv", name="the manager"), 0)
        self.assertTrue((self.state / pyenv.OFF_FILE).exists())
        with mock.patch.object(pyenv, "ensure") as ens:
            st = self.choose()
        ens.assert_not_called()
        self.assertEqual(st["runtime"], "system")
        self.assertIn("turned off on this machine", st["reason"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pyenv.cli(["on"], venv=self.venv, wheels=self.wheels, state_dir=self.state,
                                       prog="tinhat pyenv"), 0)
        self.assertFalse((self.state / pyenv.OFF_FILE).exists())
        with mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):
                self.choose()

    def test_an_update_starts_the_crash_guard_afresh(self):
        with mock.patch.object(pyenv, "ensure", return_value={}):
            for _ in range(pyenv.MAX_TRIES):
                with self.assertRaises(SystemExit):
                    self.choose(release="0.3.5")
            st = self.choose(release="0.3.5")
        self.assertEqual(st["runtime"], "system")  # tripped
        with mock.patch.object(pyenv, "ensure", return_value={}):
            with self.assertRaises(SystemExit):  # the same wheels, a new version: tried again
                self.choose(release="0.3.6")
        self.assertEqual((self.saved()["tries"], self.saved()["release"]), (1, "0.3.6"))

    def test_a_start_fits_an_old_updater_s_wait(self):
        # 0.3.3's apply_fresh waits ~120 s for the new manager; a start never spends more than this before it falls back
        self.assertLessEqual(pyenv.START_BUDGET, 60)

    def test_a_stuck_build_ends_in_the_fallback(self):
        lock = pyenv._Locked(self.d, None)
        with lock:  # another build holds the folder
            with mock.patch.object(pyenv, "LOCK_WAIT", 1):
                with self.assertRaisesRegex(pyenv.Problem, "another build"):
                    with pyenv._Locked(self.d, None):
                        pass
        with self.assertRaisesRegex(pyenv.Problem, "ran out of time"):
            pyenv._left(time.monotonic() - 1, 60)

    def test_what_status_commands_say(self):
        self.assertIn("unknown", pyenv.describe({}))
        self.assertIn("pinned copy", pyenv.describe({"runtime": "pinned", "aiohttp": "3.14.5", "venv": "/v"}))
        d = pyenv.describe({"runtime": "system", "aiohttp": "3.11.16", "reason": "it isn't built yet"})
        self.assertIn("NOT Tin Hat's pinned copy", d)
        self.assertIn("it isn't built yet", d)


class Housekeeping(unittest.TestCase):
    def test_a_plain_folder_put_aside_is_never_pruned(self):
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        for n in (".venv-abc123-x", ".venv-plain-1793000000", ".venv.link-1", "other"):
            (d / n).mkdir()
        self.assertEqual([p.name for p in pyenv._builds(d / "venv")], [".venv-abc123-x"])

    def test_children_die_with_the_process_that_started_them(self):
        """ensure_pyenv kills its child's session on the deadline; the venv/pip/check processes that child started are in
        sessions of their own, and must not live on (PR_SET_PDEATHSIG)."""
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        parent = subprocess.Popen([sys.executable, "-c", f"""
import importlib.util, sys
spec = importlib.util.spec_from_file_location("pyenv", {str(PKG / "pyenv.py")!r})
pyenv = importlib.util.module_from_spec(spec); spec.loader.exec_module(pyenv)
pyenv._spawn(["sleep", "60"], 120)
"""])
        child = None
        for _ in range(100):
            kids = subprocess.run(["pgrep", "-P", str(parent.pid)], capture_output=True, text=True).stdout.split()
            if kids:
                child = int(kids[0])
                break
            time.sleep(0.05)
        self.assertIsNotNone(child)
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait()
        for _ in range(100):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            os.kill(child, signal.SIGKILL)
            self.fail("the child outlived the process that started it")


class Ensuring(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)
        self.wheels, self.venv = self.d / "wheels", self.d / "venv"
        self.wheels.mkdir()
        (self.wheels / "wheels.lock").write_text(GOOD)

    def mark(self, **over):
        self.venv.mkdir(exist_ok=True)
        m = {"lock": pyenv.lock_id(self.wheels), "python": "%d.%d" % sys.version_info[:2],
             "machine": pyenv.platform.machine(), **over}
        (self.venv / pyenv.MARKER).write_text(json.dumps(m))

    def test_not_built_and_not_allowed_to_build(self):
        with self.assertRaisesRegex(pyenv.Problem, "isn't built yet"):
            pyenv.ensure(self.wheels, self.venv, can_build=False)
        for stale in ({"lock": "another release"}, {"python": "3.12"}, {"machine": "riscv64"}):
            with self.subTest(stale=stale):
                self.mark(**stale)
                with self.assertRaisesRegex(pyenv.Problem, "isn't built for this version"):
                    pyenv.ensure(self.wheels, self.venv, can_build=False)

    def test_built_for_this_release_only_checks(self):
        self.mark()
        with mock.patch.object(pyenv, "check", return_value={"aiohttp": "3.14.5"}) as chk, \
                mock.patch.object(pyenv, "build") as bld:
            pyenv.ensure(self.wheels, self.venv, can_build=True)
        chk.assert_called_once()
        bld.assert_not_called()

    def test_a_stale_or_damaged_venv_is_built_again(self):
        self.mark(lock="another release")
        with mock.patch.object(pyenv, "check") as chk, mock.patch.object(pyenv, "build", return_value={}) as bld:
            pyenv.ensure(self.wheels, self.venv)
        bld.assert_called_once()
        chk.assert_not_called()  # build() checked the new one itself
        self.mark()
        with mock.patch.object(pyenv, "check", side_effect=pyenv.Problem("aiohttp doesn't import")), \
                mock.patch.object(pyenv, "build", return_value={}) as bld:
            pyenv.ensure(self.wheels, self.venv)
        bld.assert_called_once()

    def test_a_venv_whose_python_fails_is_refused(self):
        self.mark()
        (self.venv / "bin").mkdir()
        (self.venv / "bin/python3").symlink_to(shutil.which("false") or "/bin/false")
        with self.assertRaisesRegex(pyenv.Problem, "its check failed"):
            pyenv.ensure(self.wheels, self.venv, can_build=False)
        (self.venv / "bin/python3").unlink()
        with self.assertRaisesRegex(pyenv.Problem, "isn't there"):
            pyenv.ensure(self.wheels, self.venv, can_build=False)


@unittest.skipUnless(sys.prefix != sys.base_prefix and importlib.util.find_spec("aiohttp"),
                     "not running inside a venv with aiohttp")
class SmokeForReal(unittest.TestCase):
    """The check every start runs, against the venv these tests run in."""

    def test_the_check_passes_here(self):
        import aiohttp
        r = pyenv.check(pathlib.Path(sys.prefix), aiohttp.__version__, imports=("json",))
        self.assertEqual(r["aiohttp"], aiohttp.__version__)
        self.assertEqual(r["problems"], [])
        # the update client's needs over HTTPS (a redirect, GitHub's ~9.3 KB header) were tried too, where openssl is
        self.assertEqual(r["tls"], bool(shutil.which("openssl")))

    def test_the_check_wants_the_right_version_and_modules(self):
        with self.assertRaisesRegex(pyenv.Problem, "instead of 0.0.1"):
            pyenv.check(pathlib.Path(sys.prefix), "0.0.1")
        with self.assertRaisesRegex(pyenv.Problem, "no_such_module_xyz doesn't import"):
            import aiohttp
            pyenv.check(pathlib.Path(sys.prefix), aiohttp.__version__, imports=("no_such_module_xyz",))


WHEELS = os.environ.get("TINHAT_TEST_WHEELS")


def lock_fits_this_python() -> bool:
    try:
        es = pyenv.read_lock(pathlib.Path(WHEELS) / "wheels.lock")
    except (pyenv.Problem, TypeError):
        return False
    return sys.version_info >= (3, 10) and any(e["name"] == "aiohttp" for e in es)


@unittest.skipUnless(WHEELS and lock_fits_this_python(), "TINHAT_TEST_WHEELS isn't set (build/wheels.py fetch DIR)")
class BuildForReal(unittest.TestCase):
    """A real venv from the shipped wheels, offline: built, checked, broken, refused, rebuilt."""

    @classmethod
    def setUpClass(cls):
        cls.d = pathlib.Path(tempfile.mkdtemp())
        cls.wheels = cls.d / "wheels"
        shutil.copytree(WHEELS, cls.wheels)
        cls.venv = cls.d / "venv"
        cls.state = cls.d / "state"
        cls.state.mkdir()
        cls.manager = REPO / "appliance/rootfs/opt/tinhat/manager"
        cls.built = pyenv.build(cls.wheels, cls.venv, imports=("tinhat.web",), path=cls.manager)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d)

    def test_1_built_and_checked(self):
        es = pyenv.read_lock(self.wheels / "wheels.lock")
        self.assertEqual(self.built["aiohttp"], pyenv.aiohttp_version(es))
        self.assertEqual(pyenv.marker(self.venv)["lock"], pyenv.lock_id(self.wheels))
        site = list((self.venv / "lib").glob("python3*/site-packages"))[0]
        installed = sorted(p.name.split("-")[0].lower().replace("_", "-") for p in site.glob("*.dist-info"))
        self.assertNotIn("pip", installed)  # pip installed them; it isn't in the venv
        self.assertIn("aiohttp", installed)
        self.assertTrue(list(self.venv.glob("lib/python3*/site-packages/aiohttp/__pycache__/*.pyc")))  # compiled once
        self.assertTrue(self.venv.is_symlink())  # a build of its own, behind a relative link (an image mounted
        self.assertFalse(os.readlink(self.venv).startswith("/"))  # elsewhere still leads to its own build)
        self.assertEqual(pyenv._builds(self.venv), [self.venv.resolve()])
        if sys.version_info[:2] == (3, 13) and pyenv.platform.machine() in ("x86_64", "aarch64"):
            self.assertTrue(self.built["speedups"], self.built.get("missing"))  # Debian 13's Python: compiled parts
        r = pyenv.ensure(self.wheels, self.venv, imports=("tinhat.web",), path=self.manager, can_build=False)
        self.assertEqual(r["problems"], [])

    def test_2_a_wheel_that_isnt_the_locks_is_refused_and_the_old_venv_stays(self):
        bad = self.d / "bad-wheels"
        shutil.copytree(self.wheels, bad)
        victim = next(p for p in bad.glob("aiohttp-*.whl"))
        victim.write_bytes(victim.read_bytes() + b"\0")
        before = pyenv.marker(self.venv)
        with self.assertRaisesRegex(pyenv.Problem, "sha256"):
            pyenv.build(bad, self.venv)
        self.assertEqual(pyenv.marker(self.venv), before)
        self.assertEqual(len(pyenv._builds(self.venv)), 1)  # nothing half-built left behind

    def test_3_a_damaged_venv_fails_its_check_and_is_rebuilt(self):
        site = list((self.venv / "lib").glob("python3*/site-packages"))[0]
        (site / "aiohttp" / "web.py").write_text("raise ImportError('damaged')\n")
        damaged = self.venv.resolve()
        with self.assertRaises(pyenv.Problem):
            pyenv.ensure(self.wheels, self.venv, can_build=False)
        r = pyenv.ensure(self.wheels, self.venv, imports=("tinhat.web",), path=self.manager)
        self.assertEqual(r["problems"], [])
        self.assertNotEqual(self.venv.resolve(), damaged)  # a new build; the one before it stays (a program may be
        self.assertEqual(set(pyenv._builds(self.venv)), {self.venv.resolve(), damaged})  # running on it)

    def test_4_the_manager_falls_back_on_a_broken_venv(self):
        """The forced-broken-venv case: the manager's choose() with can_build off, on a venv whose aiohttp is gone."""
        site = list((self.venv / "lib").glob("python3*/site-packages"))[0]
        shutil.rmtree(site / "aiohttp")
        with mock.patch.object(pyenv.os, "execve") as ex:
            st = pyenv.choose(venv=self.venv, wheels=self.wheels, state_dir=self.state, argv=["-m", "tinhat"],
                              imports=("tinhat.web",), path=self.manager, can_build=False, name="the manager")
        ex.assert_not_called()
        self.assertEqual(st["runtime"], "system")
        self.assertIn("ModuleNotFoundError", st["reason"])
        self.assertTrue(json.loads((self.state / pyenv.STATUS_FILE).read_text())["failed"])  # remembered for a day
        # an update's after-update (`pyenv ensure`) tries anyway: the venv comes back from the wheels, the memory goes,
        # and the program is started on it
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pyenv.cli(["ensure"], venv=self.venv, wheels=self.wheels, state_dir=self.state,
                                       imports=("tinhat.web",), path=self.manager, prog="tinhat pyenv"), 0)
        with mock.patch.object(pyenv.os, "execve", side_effect=SystemExit("exec")) as ex:
            with self.assertRaises(SystemExit):
                pyenv.choose(venv=self.venv, wheels=self.wheels, state_dir=self.state, argv=["-m", "tinhat"],
                             imports=("tinhat.web",), path=self.manager, name="the manager")
        ex.assert_called_once()

    def test_6_started_for_real_and_the_crash_guard(self):
        """The real os.execve onto the venv's Python; then a program that crashes on the venv twice is kept off it."""
        state = self.d / "state6"
        state.mkdir()
        prog = self.d / "prog.py"
        prog.write_text(f"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pyenv", {str(PKG / "pyenv.py")!r})
pyenv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pyenv)
st = pyenv.choose(venv={str(self.venv)!r}, wheels={str(self.wheels)!r}, state_dir={str(state)!r},
                  argv=[__file__, *sys.argv[1:]], can_build=False, name="the test program")
if sys.argv[1] == "crash" and st["runtime"] == "pinned":
    raise RuntimeError("crashed on the venv")
if sys.argv[1] == "exit1" and st["runtime"] == "pinned":
    sys.exit(1)  # gave up without an exception: not a good start either
if st["runtime"] == "pinned":
    pyenv.started()
print(json.dumps({{"runtime": st["runtime"], "aiohttp": st["aiohttp"], "prefix": sys.prefix}}))
""")
        env = {k: v for k, v in os.environ.items() if k != pyenv.INSIDE}

        def run(mode):
            return subprocess.run([sys.executable, "-B", str(prog), mode], capture_output=True, text=True, env=env,
                                  timeout=180)
        want = pyenv.aiohttp_version(pyenv.read_lock(self.wheels / "wheels.lock"))
        out = json.loads(run("ok").stdout)
        self.assertEqual((out["runtime"], out["aiohttp"]), ("pinned", want))
        self.assertEqual(pathlib.Path(out["prefix"]).resolve(), self.venv.resolve())
        self.assertTrue(json.loads((state / pyenv.STATUS_FILE).read_text())["good"])  # ended cleanly: a good start
        r = run("exit1")
        self.assertEqual(r.returncode, 1)
        r = run("crash")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("crashed on the venv", r.stderr)
        out = json.loads(run("ok").stdout)
        self.assertEqual(out["runtime"], "system")  # left alone for a day
        self.assertNotEqual(pathlib.Path(out["prefix"]).resolve(), self.venv.resolve())
        self.assertIn("stopped 2 times in a row", json.loads((state / pyenv.STATUS_FILE).read_text())["reason"])

    def test_5_the_build_tool_checks_a_folder(self):
        tool = [sys.executable, str(REPO / "build/wheels.py"), "verify"]
        self.assertEqual(subprocess.run(tool + [str(self.wheels)], capture_output=True).returncode, 0)
        extra = self.d / "extra"
        shutil.copytree(self.wheels, extra)
        (extra / "evil-1.0-py3-none-any.whl").write_bytes(b"x")
        r = subprocess.run(tool + [str(extra)], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not in the lock", r.stderr)


if __name__ == "__main__":
    unittest.main()

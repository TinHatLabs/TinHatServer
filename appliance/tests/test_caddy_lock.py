"""The web server's settings lock (caddylock.py, assembly-039 review S2): every Caddyfile writer (the dashboard, the
background loop, the console, setup, a move, the relay, a restore, an update) takes the same flock and stages its file
under a name of its own, so two writers at once never leave a file made of both or swap in each other's file.

    python3 -m unittest discover -s appliance/tests
The writers' own tests (install/relay/move/web) need aiohttp (the manager's pinned venv); the lock itself runs anywhere.
"""
import ast
import asyncio
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

_OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
PKG = _OPT / "manager" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

_saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _saved:
    del sys.modules[_k]
import tinhat  # noqa: E402,F401
from tinhat import caddylock, config, state  # noqa: E402
try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import install, move, relay, web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)
REAL = dict(_real)


class Real(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, REAL)
        p.start()
        self.addCleanup(p.stop)
        config.CADDYFILE.parent.mkdir(parents=True, exist_ok=True)
        config.CADDYFILE.write_text("old\n")
        self.addCleanup(lambda: [f.unlink() for f in config.CADDYFILE.parent.glob("Caddyfile.new*")])


class Checker:
    """A stand-in for `caddy validate`: it reads the staged file, waits (another writer gets every chance to run),
    reads it again, and notes how many validations ran at once."""
    def __init__(self, pause=0.15):
        self.pause, self.running, self.most, self.seen = pause, 0, 0, []

    async def __call__(self, path):
        f = config.CADDYFILE.parent / pathlib.Path(path).name
        self.running += 1
        self.most = max(self.most, self.running)
        try:
            first = f.read_text()
            await asyncio.sleep(self.pause)
            again = f.read_text()
            self.seen.append(first)
            return (0, "") if first == again else (1, "the staged file changed under the validation")
        finally:
            self.running -= 1


async def _ok(*a, **kw):
    return 0, ""


class Lock(Real):
    def test_same_task_takes_it_again_another_task_waits(self):
        order = []

        async def other():
            async with caddylock.CaddyLock(seconds=5):
                order.append("other")

        async def go():
            async with caddylock.CaddyLock(seconds=1):
                async with caddylock.CaddyLock(seconds=1):  # no self-deadlock
                    t = asyncio.ensure_future(other())
                    await asyncio.sleep(0.3)
                    order.append("inner done")
                order.append("outer still held")
                await asyncio.sleep(0.3)
                self.assertEqual(order, ["inner done", "outer still held"])  # the inner exit didn't let go
            await t
        asyncio.run(go())
        self.assertEqual(order[-1], "other")

    def test_a_child_task_does_not_inherit_it(self):
        async def go():
            async with caddylock.CaddyLock(seconds=1):
                with self.assertRaises(TimeoutError):
                    await asyncio.ensure_future(caddylock.CaddyLock(seconds=0.3).__aenter__())
        asyncio.run(go())

    def test_held_sync_gives_up_and_says_so(self):
        async def go():
            async with caddylock.CaddyLock(seconds=1):
                with caddylock.held_sync(0.3) as got:
                    self.assertFalse(got)
            with caddylock.held_sync(0.3) as got:
                self.assertTrue(got)
        asyncio.run(go())

    def test_put_checked_stages_under_its_own_name(self):
        chk = Checker(pause=0.05)
        with mock.patch.object(caddylock.compose, "caddy_validate", chk):
            rc, _ = asyncio.run(caddylock.put_checked("A\n", 0o600))
            self.assertEqual(rc, 0)
            self.assertEqual(config.CADDYFILE.read_text(), "A\n")
            self.assertEqual(config.CADDYFILE.stat().st_mode & 0o777, 0o600)

            async def refuse(path):
                self.assertRegex(pathlib.Path(path).name, r"^Caddyfile\.new-[0-9a-f]{8}$")
                return 1, "bad"
            with mock.patch.object(caddylock.compose, "caddy_validate", refuse):
                rc, out = asyncio.run(caddylock.put_checked("B\n", 0o644))
        self.assertEqual((rc, out), (1, "bad"))
        self.assertEqual(config.CADDYFILE.read_text(), "A\n", "a refused file changes nothing")
        self.assertEqual(list(config.CADDYFILE.parent.glob("Caddyfile.new*")), [])


class AcrossProcesses(unittest.TestCase):
    """Two processes writing at once (the console and the manager): each write is whole, none overlaps another."""
    def test_two_processes_never_interleave(self):
        root = pathlib.Path(tempfile.mkdtemp())
        log = root / "log"
        code = textwrap.dedent(f"""
            import asyncio, os, sys, time
            sys.path.insert(0, {str(_OPT / 'manager')!r})
            from tinhat import caddylock, config
            me = sys.argv[1]
            async def validate(path):
                f = config.CADDYFILE.parent / os.path.basename(path)
                a = f.read_text(); await asyncio.sleep(0.02); b = f.read_text()
                return (0, "") if a == b else (1, "changed")
            caddylock.compose.caddy_validate = validate
            async def main():
                for i in range(15):
                    async with caddylock.CaddyLock(seconds=30):
                        with open({str(log)!r}, "a") as f: f.write(f"in {{me}}\\n")
                        rc, _ = await caddylock.put_checked((me + "\\n") * 200, 0o644)
                        assert rc == 0, "validation saw a changing file"
                        text = config.CADDYFILE.read_text()
                        assert text == (me + "\\n") * 200, "another writer's lines in mine"
                        with open({str(log)!r}, "a") as f: f.write(f"out {{me}}\\n")
            asyncio.run(main())
        """)
        env = dict(os.environ, TINHAT_STATE=str(root), TINHAT_OPT=str(_OPT))
        procs = [subprocess.Popen([sys.executable, "-c", code, w], env=env, stderr=subprocess.PIPE, text=True)
                 for w in ("A", "B")]
        for p in procs:
            _, err = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0, err)
        lines = log.read_text().split("\n")[:-1]
        self.assertEqual(len(lines), 60)
        for i in range(0, 60, 2):  # strictly in/out pairs from the same writer: no two held it at once
            (a, who), (b, who2) = lines[i].split(), lines[i + 1].split()
            self.assertEqual((a, b, who), ("in", "out", who2))
        live = [p for p in root.rglob("Caddyfile")][0].read_text()
        self.assertIn(live, ("A\n" * 200, "B\n" * 200))
        self.assertEqual([p.name for p in root.rglob("Caddyfile.new*")], [])


class NoUnlockedWriters(unittest.TestCase):
    """The source itself: no shared staged name any more, and every write or swap of the live Caddyfile (a
    refresh_configs() without caddyfile_to, state.write_text / os.replace onto config.CADDYFILE, put_checked,
    _load_caddyfile) runs under the lock: inside `async with CaddyLock()/_caddy_lock()`, or inside
    `with held_sync(...) as got:` AND an `if got` / after an `if not got: return` (a lock that timed out is no lock)."""
    ASYNC_LOCKS = {"CaddyLock", "_caddy_lock", "_CaddyLock"}
    CALLERS_HOLD = {"refresh_configs_locked", "refresh_configs_checked", "_apply_locked", "_load_caddyfile", "put_checked"}

    def test_no_shared_staged_name(self):
        for f in PKG.glob("*.py"):
            src = f.read_text()
            self.assertNotIn('with_name("Caddyfile.new")', src, f.name)
            self.assertNotIn('"/etc/caddy/Caddyfile.new"', src, f.name)

    @staticmethod
    def _name(fn):
        return fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")

    def _is_live_write(self, call: ast.Call) -> bool:
        name = self._name(call.func)
        kw = {k.arg for k in call.keywords}
        if name == "refresh_configs":
            return "caddyfile_to" not in kw
        if name in ("put_checked", "_load_caddyfile", "_apply_locked"):
            return True  # helpers whose callers must hold the lock
        if name in ("write_text", "replace") and call.args:
            target = call.args[0] if name == "write_text" else (call.args[1] if len(call.args) > 1 else None)
            return target is not None and ast.unparse(target) == "config.CADDYFILE"
        return False

    def _locked(self, stack) -> bool:
        """stack: the ancestors of the call, outermost first (the call itself last)."""
        for i, n in enumerate(stack):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in self.CALLERS_HOLD:
                return True  # their own call sites are checked (they are live writes in _is_live_write)
            if isinstance(n, ast.AsyncWith) and any(
                    self._name(it.context_expr.func if isinstance(it.context_expr, ast.Call) else it.context_expr)
                    in self.ASYNC_LOCKS for it in n.items):
                return True
            if isinstance(n, ast.With):
                for it in n.items:
                    c = it.context_expr
                    if not (isinstance(c, ast.Call) and self._name(c.func) == "held_sync" and it.optional_vars is not None):
                        continue
                    got = it.optional_vars.id
                    inner = stack[i + 1:]
                    # inside `if got:`'s body (never its else)
                    for j, x in enumerate(inner[:-1]):
                        if isinstance(x, ast.If) and ast.unparse(x.test) == got and any(inner[j + 1] is b for b in x.body):
                            return True
                    # after `if not got: return …` (the with-body's first statement), not inside it
                    first = n.body[0]
                    if isinstance(first, ast.If) and ast.unparse(first.test) == f"not {got}" and \
                            isinstance(first.body[-1], ast.Return) and inner and inner[0] is not first and \
                            any(inner[0] is b for b in n.body[1:]):
                        return True
        return False

    def unlocked(self, path: pathlib.Path) -> list:
        out = []

        def walk(node, stack):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.Call) and self._is_live_write(child) and not self._locked(stack + [child]):
                    out.append(f"{path.name}:{child.lineno} {self._name(child.func)}")
                walk(child, stack + [child])
        walk(ast.parse(path.read_text()), [])
        return out

    def test_every_live_write_is_locked(self):
        bad = []
        for f in sorted(PKG.glob("*.py")):
            if f.name in ("caddylock.py",):
                continue
            bad += self.unlocked(f)
        # refresh_configs itself writes config.CADDYFILE (its callers hold the lock: checked above)
        bad = [b for b in bad if not b.startswith("install.py:") or "write_text" not in b
               or "refresh_configs" not in self._func_of(PKG / "install.py", int(b.split(":")[1].split()[0]))]
        self.assertEqual(bad, [])

    def test_the_guard_catches_its_own_false_negatives(self):
        bad = textwrap.dedent("""
            def a():
                with caddylock.held_sync(1) as got:
                    if got:
                        pass
                    else:
                        install.refresh_configs()
            def b():
                with caddylock.held_sync(1) as got:
                    if not got:
                        state.write_text(config.CADDYFILE, "x")
                        return False
            async def c():
                await web._apply_locked(None, None)
            def ok1():
                with caddylock.held_sync(1) as got:
                    if got:
                        install.refresh_configs()
            def ok2():
                with caddylock.held_sync(1) as got:
                    if not got:
                        return False
                    state.write_text(config.CADDYFILE, "x")
        """)
        f = pathlib.Path(tempfile.mkdtemp()) / "sample.py"
        f.write_text(bad)
        found = [x.split()[0] for x in self.unlocked(f)]
        self.assertEqual(found, ["sample.py:7", "sample.py:11", "sample.py:14"])

    @staticmethod
    def _func_of(path, line):
        for n in ast.walk(ast.parse(path.read_text())):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno <= line <= n.end_lineno:
                best = n.name
        return best


class AfterUpdate(Real):
    """`tinhat after-update` while a console change holds the lock: everything else written, the Caddyfile untouched
    and marked pending (the manager writes it under the lock)."""
    def test_held_lock_skips_only_the_caddyfile(self):
        import importlib
        cli = importlib.import_module("tinhat.__main__")
        written = []

        def refresh(force=False, caddyfile_to=None):
            written.append(caddyfile_to)
            if caddyfile_to is not None:
                caddyfile_to.write_text("new\n")
            else:
                config.CADDYFILE.write_text("new\n")
            return []
        install_stub = type(sys)("tinhat.install")
        install_stub.refresh_configs = refresh
        mig = type(sys)("tinhat.migrations")
        mig.run_pending = lambda: []
        held = pathlib.Path(tempfile.mkdtemp()) / "holder.py"
        held.write_text(textwrap.dedent(f"""
            import fcntl, os, sys, time
            fd = os.open({str(caddylock.lock_path())!r}, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX); print("held", flush=True); time.sleep(3)
        """))
        holder = subprocess.Popen([sys.executable, str(held)], stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.stdout.close)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held")
            pkg = sys.modules["tinhat"]  # `from . import install` takes the package attribute when there is one
            with mock.patch.dict(sys.modules, {"tinhat.install": install_stub, "tinhat.migrations": mig}), \
                    mock.patch.object(pkg, "install", install_stub, create=True), \
                    mock.patch.object(pkg, "migrations", mig, create=True), \
                    mock.patch.object(caddylock, "held_sync", lambda s, real=caddylock.held_sync: real(0.3)), \
                    mock.patch.object(cli, "ensure_pyenv", lambda: "ok", create=True):
                cli.after_update()
        finally:
            holder.wait()
        self.assertEqual(config.CADDYFILE.read_text(), "old\n", "the live Caddyfile was written without the lock")
        self.assertIsNotNone(written[0])
        self.assertFalse(written[0].exists(), "the scratch file stayed behind")
        self.assertEqual(state.load_state().get(caddylock.PENDING, {}).get("why"), "after-update")
        state.save_state(**{caddylock.PENDING: None})


class Release(Real):
    """The lock is let go of on every way out, and the owner record with it."""
    def test_exception_and_cancel_free_it(self):
        async def boom():
            async with caddylock.CaddyLock(seconds=1):
                async with caddylock.CaddyLock(seconds=1):
                    raise RuntimeError("x")

        async def sleeper():
            async with caddylock.CaddyLock(seconds=1):
                await asyncio.sleep(10)

        async def go():
            with self.assertRaises(RuntimeError):
                await boom()
            self.assertIsNone(caddylock._owner)
            t = asyncio.ensure_future(sleeper())
            await asyncio.sleep(0.2)
            t.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await t
            self.assertIsNone(caddylock._owner)
            async with caddylock.CaddyLock(seconds=0.5):  # free again, for another task too
                pass
        asyncio.run(go())


@unittest.skipUnless(HAVE_AIOHTTP, "the writers import aiohttp (run in the manager's venv)")
class Writers(Real):
    """A dashboard change (web._apply_with_caddy), setup (install._put_caddyfile) and the relay (relay._apply_caddy)
    at the same moment: one at a time, each file whole, the last one wins whole."""
    def test_dashboard_setup_and_relay_at_once(self):
        chk = Checker()

        def dash_write(caddyfile_to=None, **kw):
            caddyfile_to.write_text("dashboard\n" * 50)

        st = {"phase": "ready", "mode": "anywhere", "server_name": "maple.tinhat.me"}
        state.write_json(config.STATE_FILE, st, 0o644)

        async def go():
            return await asyncio.gather(
                web._apply_with_caddy(lambda cur: ({"dashboard_access": {"mode": "home"}}, {"dashboard_access": None})),
                install._put_caddyfile(lambda: "setup\n" * 50, 0o600),
                relay._apply_caddy(),
            )
        with mock.patch.object(install, "refresh_configs", dash_write), \
                mock.patch.object(caddylock.compose, "caddy_validate", chk), \
                mock.patch.object(web.compose, "caddy_validate", chk), \
                mock.patch.object(caddylock.compose, "caddy_reload", _ok), \
                mock.patch.object(caddylock.compose, "up", _ok), \
                mock.patch.object(relay.names, "creds", lambda: {"acme": {"x": 1}}), \
                mock.patch.object(relay.templates, "caddy_anywhere", lambda *a, **kw: "relay\n" * 50), \
                mock.patch.object(relay.environment, "env", lambda: {"acme_directory": "d"}), \
                mock.patch.object(relay.environment, "has_extra_roots", lambda: False):
            res = asyncio.run(go())
        self.assertEqual(res[0], (True, ""))
        self.assertEqual(chk.most, 1, "two validations ran at once")
        self.assertEqual(sorted(s.split("\n")[0] for s in chk.seen), ["dashboard", "relay", "setup"])
        self.assertIn(config.CADDYFILE.read_text(), ("dashboard\n" * 50, "setup\n" * 50, "relay\n" * 50))
        self.assertEqual(list(config.CADDYFILE.parent.glob("Caddyfile.new*")), [])

    def test_a_held_lock_is_a_plain_error_for_each_writer(self):
        async def go():
            async with caddylock.CaddyLock():
                t = asyncio.ensure_future(install._put_caddyfile(lambda: "x\n", 0o644))
                with mock.patch.object(caddylock.CaddyLock, "__init__",
                                       lambda self, seconds=120: setattr(self, "seconds", 0.2) or
                                       setattr(self, "fd", None) or setattr(self, "token", None)):
                    for coro, err in ((install._put_caddyfile(lambda: "x\n", 0o644), install.InstallError),
                                      (relay._apply_caddy(), relay.RelayError)):
                        with self.assertRaises(err) as cm:
                            await asyncio.ensure_future(coro)
                        self.assertIn("still running", str(cm.exception))

                    async def enter_move():  # its own task (the one holding the lock would just take it again)
                        async with move._caddy_lock():
                            pass
                    with self.assertRaises(move.MoveError):
                        await asyncio.ensure_future(enter_move())
                t.cancel()
        state.write_json(config.STATE_FILE, {"server_name": "maple.tinhat.me"}, 0o644)
        with mock.patch.object(relay.names, "creds", lambda: {"acme": {"x": 1}}):
            asyncio.run(go())

    def test_pending_caddyfile_is_written_by_the_loop(self):
        import types
        caddylock.mark_pending("after-update")
        calls = []

        async def apply(change=None):
            calls.append(change)
            return True, ""
        m = types.SimpleNamespace(mover=types.SimpleNamespace(running=False))
        with mock.patch.object(web, "_apply_with_caddy", apply):
            asyncio.run(web._write_pending_caddyfile(m))
            self.assertEqual(calls, [None])
            self.assertIsNone(state.load_state().get(caddylock.PENDING))
            asyncio.run(web._write_pending_caddyfile(m))  # nothing pending: nothing written
        self.assertEqual(calls, [None])

    def test_startup_leaves_the_file_while_the_lock_is_held(self):
        config.CADDYFILE.write_text("# Tin Hat Server — not set up yet (an older one)\n")

        async def go():
            async with caddylock.CaddyLock():
                with mock.patch.object(caddylock, "held_sync", lambda s, real=caddylock.held_sync: real(0.2)), \
                        mock.patch.object(web.setuptls, "ensure", lambda: None), \
                        mock.patch.object(web.config, "proxy_only", lambda: False):
                    return web.setup_caddyfile()
        self.assertFalse(asyncio.run(go()))
        self.assertEqual(config.CADDYFILE.read_text(), "# Tin Hat Server — not set up yet (an older one)\n")


if __name__ == "__main__":
    unittest.main()

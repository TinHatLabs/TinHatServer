"""pyenv: run on Tin Hat's own pinned aiohttp, with the operating system's as the fallback.

Debian 13's python3-aiohttp (3.11.16) carries 2026 advisories Debian won't fix, and the manager, the names service and
the relay answer the network with it. So every release ships aiohttp and what it needs as wheels (the files
build/wheels.lock names, checked by sha256 when the release is built), and each machine installs them offline into a
virtual environment (venv) of its own: `pip install --no-index --require-hashes`, with pip run from its own wheel
(checked here first, never installed). Nothing here ever asks the internet for anything.

A program moves onto the venv only once a check in a separate process passes: the expected aiohttp imports from the
venv, a request goes through a small aiohttp server and client (an oversized one is refused), and the program's own
modules import. Otherwise it stays on the system's aiohttp and says so (its log, STATUS_FILE in its state folder, the
manager's dashboard): the dashboard is how a server updates, so a broken venv must never take it down. Every step has
a deadline (a stuck build or check ends in the fallback, not a server that never starts), every start on the venv is
recorded before it happens (no record, no start on it), and a venv the program stopped on twice in a row without
saying it got going (started(), or GRACE seconds alive) is left alone for a day.

An owner can turn it off for a machine (OFF_FILE in the state folder: `… pyenv off`, `… pyenv on`), e.g. when a
pinned aiohttp that started fine misbehaves later; the program then runs on the system's, with the same warning. A
build or check that failed at a start is remembered for a day (per lock, Python and processor) instead of being tried
at every start; an update (after-update) and `… pyenv on` try again.

Each build is a new folder next to the venv's name (".venv-<lock>-<random>"), published by swapping a relative link
(`venv` → that folder) once it passed its check; the folder before it stays until the next build, so a program still
running on it keeps working, and a start checks and runs one and the same folder. pip never reads a config file
(PIP_CONFIG_FILE=/dev/null) and installs exactly the hashed list (--no-index --no-deps --require-hashes).

One file, three copies kept identical by a test: tinhat/pyenv.py (the manager), names/tinhat_names/pyenv.py and
relay/tinhat_relay/pyenv.py. Standard library only: it runs before aiohttp is imported, and in a Docker build.
"""
import fcntl
import hashlib
import importlib.util
import json
import logging
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

log = logging.getLogger("tinhat.pyenv")

LOCK_FILE = "wheels.lock"      # in the wheels folder, next to the files it names
MARKER = "tinhat-venv.json"    # in a venv this module built: which lock, Python and processor it was built for
STATUS_FILE = "pyenv.json"     # in the program's state folder: what it runs on, and why
INSIDE = "TINHAT_PYENV"        # set for the program started on the venv (the venv's path); gone once it's read
MAX_TRIES = 2                  # starts on one venv that never got going…
RETRY_AFTER = 24 * 3600        # …before it's left alone for this long
GRACE = 20                     # seconds alive on the venv that count as a good start (programs that don't call started())
VENV_TIMEOUT = 60              # each step's own deadline; the caller's budget can cut them shorter
PIP_TIMEOUT = 240
CHECK_TIMEOUT = 90
COMPILE_TIMEOUT = 120
LOCK_WAIT = 60                 # another build of the same venv: wait this long, then give up
START_BUDGET = 60              # a program's start: everything choose() may do before it falls back (a build that needs
                               # longer is left to an update's after-update, which has minutes)
OFF_FILE = "pyenv-off"         # in the program's state folder: the owner turned the pinned aiohttp off here
_KEEP_ENV = ("PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "PYTHONUTF8")

_NAME = re.compile(r"[a-z0-9]+(?:[-_.][a-z0-9]+)*")
_VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_URL = re.compile(r"https://[A-Za-z0-9.-]+/[A-Za-z0-9._/%-]*/([A-Za-z0-9_.+!-]+\.whl)")

CURRENT: dict = {}  # what this process runs on, once choose() has decided
_STARTED: dict = {}  # where started() records a good start (set by choose() on the venv)


class Problem(Exception):
    """Why the pinned aiohttp can't be used, in words an owner can read."""


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# ---- the lock and the wheels -----------------------------------------------------------------------------------------

def read_lock(path: Path) -> list[dict]:
    """wheels.lock: `NAME VERSION SHA256 URL` per wheel file (# starts a comment). One version per name, exactly one
    pip (the installer) and an aiohttp."""
    try:
        text = Path(path).read_bytes().decode()
    except (OSError, UnicodeDecodeError) as e:
        raise Problem(f"this release has no wheels for it ({Path(path).name}: {getattr(e, 'strerror', e)})") from None
    return parse_lock(text)


def load_lock(wheels: Path) -> tuple[list[dict], str]:
    """The lock's entries and its id (sha256), from one and the same read."""
    try:
        data = (Path(wheels) / LOCK_FILE).read_bytes()
        text = data.decode()
    except (OSError, UnicodeDecodeError) as e:
        raise Problem(f"this release has no wheels for it ({LOCK_FILE}: {getattr(e, 'strerror', e)})") from None
    return parse_lock(text), hashlib.sha256(data).hexdigest()


def parse_lock(text: str) -> list[dict]:
    out, files = [], set()
    for n, line in enumerate(text.splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        f = line.split()
        m = _URL.fullmatch(f[3]) if len(f) == 4 else None
        if not (m and _NAME.fullmatch(f[0]) and _VERSION.fullmatch(f[1]) and _SHA256.fullmatch(f[2])):
            raise Problem(f"{LOCK_FILE} line {n} isn't NAME VERSION SHA256 URL")
        name, version, sha, url = f
        file = m.group(1)
        parts = file[:-len(".whl")].split("-")
        if len(parts) not in (5, 6) or _norm(parts[0]) != _norm(name) or parts[1] != version:
            raise Problem(f"{LOCK_FILE} line {n}: {file} isn't {name} {version}")
        if file in files:
            raise Problem(f"{LOCK_FILE} names {file} twice")
        files.add(file)
        out.append({"name": _norm(name), "version": version, "sha256": sha, "url": url, "file": file})
    versions: dict[str, str] = {}
    for e in out:
        if versions.setdefault(e["name"], e["version"]) != e["version"]:
            raise Problem(f"{LOCK_FILE} has two versions of {e['name']}")
    if sum(e["name"] == "pip" for e in out) != 1:
        raise Problem(f"{LOCK_FILE} needs exactly one pip wheel")
    if "aiohttp" not in versions:
        raise Problem(f"{LOCK_FILE} has no aiohttp")
    return out


def lock_id(wheels: Path) -> str:
    """Which set of wheels: the lock's own sha256 (its lines carry every file's)."""
    try:
        return hashlib.sha256((Path(wheels) / LOCK_FILE).read_bytes()).hexdigest()
    except OSError:
        return ""


def aiohttp_version(entries: list[dict]) -> str:
    return next(e["version"] for e in entries if e["name"] == "aiohttp")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(wheels: Path, entries: list[dict]) -> None:
    """Every file the lock names is in the folder (a plain file) with exactly its sha256."""
    for e in entries:
        p = Path(wheels) / e["file"]
        if p.is_symlink() or not p.is_file():
            raise Problem(f"{e['file']} is missing")
        if sha256_file(p) != e["sha256"]:
            raise Problem(f"{e['file']} isn't the file its list names (sha256)")


def requirements(entries: list[dict]) -> str:
    """pip's hash-checking requirements: every package at its one version, with the sha256 of each of its files (pip
    takes the one that fits this Python and processor and refuses it unless its hash is listed). pip itself is the
    installer, not a requirement."""
    by: dict[str, list[dict]] = {}
    for e in entries:
        if e["name"] != "pip":
            by.setdefault(e["name"], []).append(e)
    return "".join(f"{n}=={es[0]['version']} " + " ".join(f"--hash=sha256:{e['sha256']}" for e in es) + "\n"
                   for n, es in sorted(by.items()))


# ---- building and checking a venv ------------------------------------------------------------------------------------

def base_python() -> str:
    """The system's Python, also when this runs inside a venv."""
    return getattr(sys, "_base_executable", None) or sys.executable


def _python(venv: Path) -> Path:
    return Path(venv) / "bin" / "python3"


def _env() -> dict:
    """For the builds and checks: a short, fixed environment; pip reads no config file at all."""
    keep = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR") if k in os.environ}
    keep.setdefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    keep["PIP_CONFIG_FILE"] = os.devnull  # not even /etc/pip.conf or the venv's (--isolated skips only the user's)
    return keep


def _exec_env(extra: dict | None = None) -> dict:
    """The program's own environment for its start on the venv, without what would change where Python imports from
    (PYTHONPATH, PYTHONHOME, …): the program must run on what the check saw."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON") or k in _KEEP_ENV}
    env.pop(INSIDE, None)
    return {**env, **(extra or {})}


def _tail(text: str, n: int = 300) -> str:
    text = " ".join((text or "").split())
    return text[-n:] if text else "no output"


def _left(deadline: float | None, cap: float) -> float:
    if deadline is None:
        return cap
    left = deadline - time.monotonic()
    if left <= 1:
        raise Problem("ran out of time")
    return min(cap, left)


def die_with_parent() -> None:
    """In a child, before it runs (preexec_fn): the kernel kills it when the process that started it dies, so a build
    whose caller was killed on a deadline leaves nothing behind (Linux: PR_SET_PDEATHSIG)."""
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG = 1
    except Exception:  # noqa: BLE001 — not Linux, or no libc: the session kill on the deadline still applies
        pass


def _spawn(cmd: list[str], timeout: float) -> tuple[int, str, str]:
    """cmd in a session of its own; on its deadline the whole session is killed (nothing it started lives on), and it
    dies with this process (die_with_parent)."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd="/", env=_env(),
                         start_new_session=True, preexec_fn=die_with_parent)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.communicate()
        raise
    return p.returncode, out, err


# Run by the venv's own Python (-I: no environment variables, no user or current folder on its path), with one JSON
# argument. Prints one JSON line; "problems" empty = good.
SMOKE = r'''
import asyncio, importlib, json, os, sys
a = json.loads(sys.argv[1])
problems, missing = [], []
import aiohttp
from aiohttp import web
if aiohttp.__version__ != a["aiohttp"]:
    problems.append("aiohttp %s instead of %s" % (aiohttp.__version__, a["aiohttp"]))
if sys.prefix == sys.base_prefix:
    problems.append("its Python doesn't run as the venv")
elif not os.path.realpath(aiohttp.__file__).startswith(os.path.realpath(sys.prefix) + os.sep):
    problems.append("aiohttp comes from %s, not the venv" % aiohttp.__file__)
for m in ("aiohttp._http_parser", "multidict._multidict", "yarl._quoting_c", "propcache._helpers_c",
          "frozenlist._frozenlist"):
    try:
        importlib.import_module(m)
    except ImportError:
        missing.append(m)
async def smoke():
    async def echo(req):
        body = await req.read()
        return web.json_response({"n": len(body), "h": req.headers.get("X-Tinhat-Check")})
    app = web.Application(client_max_size=4096)
    app.router.add_post("/check", echo)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        url = "http://127.0.0.1:%d/check" % runner.addresses[0][1]
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as s:
            async with s.post(url, data=b"t" * 1000, headers={"X-Tinhat-Check": "ok"}) as r:
                got = (r.status, await r.json())
            if got != (200, {"n": 1000, "h": "ok"}):
                problems.append("the test request came back as %r" % (got,))
            async with s.post(url, data=b"t" * 8192) as r:
                if r.status != 413:
                    problems.append("a too-big test request came back %d, not 413" % r.status)
    finally:
        await runner.cleanup()
async def tls():
    # what the update check and download need: HTTPS, a redirect, a header of ~9.3 KB (GitHub's), 64 KiB limits
    import ssl
    async def hop(req):
        raise web.HTTPFound("/final", headers={"Content-Security-Policy": "x" * 9300})
    async def final(req):
        return web.json_response({"tls": True}, headers={"Content-Security-Policy": "y" * 9300})
    app = web.Application()
    app.router.add_get("/hop", hop)
    app.router.add_get("/final", final)
    sctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    sctx.load_cert_chain(a["tls"]["cert"], a["tls"]["key"])
    cctx = ssl.create_default_context(cafile=a["tls"]["cert"])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=sctx)
        await site.start()
        url = "https://127.0.0.1:%d/hop" % runner.addresses[0][1]
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20), max_line_size=1 << 16,
                                         max_field_size=1 << 16) as s:
            async with s.get(url, ssl=cctx) as r:
                got = (r.status, await r.json(), len(r.history))
        if got != (200, {"tls": True}, 1):
            problems.append("the HTTPS test request came back as %r" % (got,))
    finally:
        await runner.cleanup()
if a.get("tls"):
    try:
        asyncio.run(asyncio.wait_for(tls(), 30))
    except Exception as e:
        problems.append("the HTTPS test request failed: %r" % (e,))
try:
    asyncio.run(asyncio.wait_for(smoke(), 30))
except Exception as e:
    problems.append("the test request failed: %r" % (e,))
if a.get("path"):
    sys.path.insert(0, a["path"])
for m in a.get("imports") or []:
    try:
        importlib.import_module(m)
    except Exception as e:
        problems.append("%s doesn't import: %r" % (m, e))
print(json.dumps({"aiohttp": aiohttp.__version__, "python": sys.version.split()[0], "speedups": not missing,
                  "missing": missing, "tls": bool(a.get("tls")), "problems": problems}))
'''


def check(venv: Path, want: str, *, imports=(), path=None, strict: bool = False, deadline: float | None = None) -> dict:
    """The venv's Python runs SMOKE. strict: aiohttp's compiled parts must load too (an image build, where this
    processor's wheels are always in the lock); otherwise their pure-Python fallbacks are accepted (and reported)."""
    py = _python(venv)
    if not py.exists():
        raise Problem("it isn't there")
    timeout = _left(deadline, CHECK_TIMEOUT)
    with tempfile.TemporaryDirectory(prefix="tinhat-pyenv-") as tmp:
        arg = json.dumps({"aiohttp": want, "imports": list(imports), "path": str(path) if path else "",
                          "tls": _test_cert(Path(tmp))})
        try:
            rc, out, err = _spawn([str(py), "-I", "-B", "-c", SMOKE, arg], timeout)
        except subprocess.TimeoutExpired:
            raise Problem(f"its check didn't finish in {int(timeout)} s") from None
        except OSError as e:
            raise Problem(f"its Python doesn't start ({e.strerror})") from None
    try:
        res = json.loads((out or "").strip().splitlines()[-1])
        problems, speedups = list(res["problems"]), bool(res["speedups"])
    except (IndexError, ValueError, KeyError, TypeError):
        raise Problem(f"its check failed: {_tail(err)}") from None
    if rc != 0 and not problems:
        problems.append(f"its check exited {rc}: {_tail(err)}")
    if problems:
        raise Problem("; ".join(problems))
    if strict and not speedups:
        raise Problem("aiohttp's compiled parts don't load: " + ", ".join(res.get("missing") or []))
    return res


def _test_cert(folder: Path) -> dict | None:
    """A throwaway certificate for 127.0.0.1 (openssl, a day, made for this one check and deleted with it), for
    SMOKE's HTTPS request; None when openssl isn't there (the check then skips that request and says so)."""
    openssl = shutil.which("openssl")
    if not openssl:
        return None
    cert, key = folder / "cert.pem", folder / "key.pem"
    try:
        r = subprocess.run([openssl, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                            "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
                            "-keyout", str(key), "-out", str(cert)], capture_output=True, timeout=30, env=_env())
    except (OSError, subprocess.SubprocessError):
        return None
    return {"cert": str(cert), "key": str(key)} if r.returncode == 0 and cert.exists() else None


class _Locked:
    """One build at a time per folder (a lock on the venv's parent folder itself: nothing is left behind), waited for
    until the deadline at most."""

    def __init__(self, folder: Path, deadline: float | None):
        self.folder, self.deadline = folder, deadline

    def __enter__(self):
        self.fd = os.open(self.folder, os.O_RDONLY | os.O_DIRECTORY)
        until = time.monotonic() + _left(self.deadline, LOCK_WAIT)
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= until:
                    os.close(self.fd)
                    raise Problem("another build of it is still running") from None
                time.sleep(0.5)

    def __exit__(self, *exc):
        os.close(self.fd)


def _run(cmd: list[str], what: str, cap: float, deadline: float | None) -> None:
    timeout = _left(deadline, cap)
    try:
        rc, out, err = _spawn(cmd, timeout)
    except subprocess.TimeoutExpired:
        raise Problem(f"{what} didn't finish in {int(timeout)} s") from None
    except OSError as e:
        raise Problem(f"{what} didn't start ({e.strerror})") from None
    if rc != 0:
        raise Problem(f"{what} failed: {_tail(err or out)}")


def marker(venv: Path) -> dict:
    try:
        m = json.loads((Path(venv) / MARKER).read_text())
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def _built_for_here(m: dict, lid: str) -> bool:
    return (m.get("lock") == lid and m.get("python") == "%d.%d" % sys.version_info[:2]
            and m.get("machine") == platform.machine())


def current(venv: Path) -> Path | None:
    """The build `venv` leads to now (resolved: check it and run that same folder), or None."""
    try:
        return Path(venv).resolve(strict=True)
    except (OSError, RuntimeError):
        return None


def _builds(venv: Path) -> list[Path]:
    """This module's builds of `venv` (never a plain folder it put aside: `.venv-plain-*` stays for the owner)."""
    v = Path(venv)
    return [p for p in v.parent.glob(f".{v.name}-*")
            if p.is_dir() and not p.is_symlink() and not p.name.startswith(f".{v.name}-plain-")]


def build(wheels: Path, venv: Path, *, strict: bool = False, imports=(), path=None, deadline: float | None = None) -> dict:
    """A new build from the wheels, in a fresh folder of its own; `venv` leads to it only once it passed check()."""
    wheels, venv = Path(wheels), Path(venv)
    entries, lid = load_lock(wheels)
    verify(wheels, entries)
    want = aiohttp_version(entries)
    pip = wheels / next(e["file"] for e in entries if e["name"] == "pip")
    venv.parent.mkdir(parents=True, exist_ok=True)
    with _Locked(venv.parent, deadline):
        before = current(venv)
        umask = os.umask(0o022)  # readable by the programs that run on it (the names service isn't root)
        new = Path(tempfile.mkdtemp(prefix=f".{venv.name}-{lid[:12]}-", dir=venv.parent))
        try:
            os.chmod(new, 0o755)
            _run([base_python(), "-I", "-m", "venv", "--without-pip", str(new)], "making the venv", VENV_TIMEOUT,
                 deadline)
            req = new / "tinhat-requirements.txt"
            req.write_text(requirements(entries))
            _run([str(_python(new)), "-I", "-B", f"{pip}/pip", "install", "--isolated", "--no-index", "--no-deps",
                  "--find-links", str(wheels), "--require-hashes", "--only-binary", ":all:", "--no-cache-dir",
                  "--disable-pip-version-check", "--no-input", "--no-compile", "--root-user-action", "ignore",
                  "--progress-bar", "off", "--quiet", "-r", str(req)], "installing the wheels", PIP_TIMEOUT, deadline)
            # compiled once here (every start's check runs with -B and the programs with PYTHONDONTWRITEBYTECODE)
            for site in sorted(new.glob("lib/python3*/site-packages")):
                _run([str(_python(new)), "-I", "-m", "compileall", "-q", "-j", "0", str(site)], "compiling it",
                     COMPILE_TIMEOUT, deadline)
            res = check(new, want, imports=imports, path=path, strict=strict, deadline=deadline)
            m = {"lock": lid, "aiohttp": res["aiohttp"], "python": "%d.%d" % sys.version_info[:2],
                 "python_full": res["python"], "machine": platform.machine(), "speedups": res["speedups"],
                 "built": int(time.time())}
            (new / MARKER).write_text(json.dumps(m, indent=1, sort_keys=True) + "\n")
            # publish: `venv` becomes a relative link to the new build, swapped in one rename
            link = venv.with_name(f".{venv.name}.link-{os.getpid()}")
            link.unlink(missing_ok=True)
            os.symlink(new.name, link)
            os.sync()  # every file of the build on disk before anything leads to it (a power cut right after)
            if venv.is_dir() and not venv.is_symlink():  # a plain folder in its place (an older layout): kept aside
                os.rename(venv, venv.with_name(f".{venv.name}-plain-{int(time.time())}"))
            os.replace(link, venv)
        except BaseException:
            shutil.rmtree(new, ignore_errors=True)
            raise
        finally:
            os.umask(umask)
        for old in _builds(venv):  # this build and the one before it (a running program may still be on it) stay
            if old.resolve() not in (new.resolve(), before):
                shutil.rmtree(old, ignore_errors=True)
    return {**m, "missing": res.get("missing") or [], "problems": [], "venv": str(new)}


def ensure(wheels: Path, venv: Path, *, imports=(), path=None, can_build: bool = True, strict: bool = False,
           deadline: float | None = None) -> dict:
    """The venv, built for this release's wheels and passing check(): check()'s answer with "venv", the build it
    checked (run that one), or Problem. Builds (or rebuilds once, when the built one fails its check) only when
    can_build."""
    wheels, venv = Path(wheels), Path(venv)
    entries, lid = load_lock(wheels)
    want = aiohttp_version(entries)
    gen = current(venv)
    if gen is None or not _built_for_here(marker(gen), lid):
        if not can_build:
            raise Problem("it isn't built for this version yet" if gen and marker(gen) else "it isn't built yet")
        return build(wheels, venv, strict=strict, imports=imports, path=path, deadline=deadline)
    try:
        return {**check(gen, want, imports=imports, path=path, strict=strict, deadline=deadline), "venv": str(gen)}
    except Problem:
        if not can_build:
            raise
        return build(wheels, venv, strict=strict, imports=imports, path=path, deadline=deadline)  # damaged: again


# ---- choosing what to run on -----------------------------------------------------------------------------------------

def _load(state_dir: Path) -> dict:
    try:
        s = json.loads((Path(state_dir) / STATUS_FILE).read_text())
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(state_dir: Path, s: dict) -> bool:
    try:
        p = Path(state_dir) / STATUS_FILE
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(s, indent=1, sort_keys=True) + "\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, p)
        return True
    except OSError as e:
        _say(logging.WARNING, f"couldn't write {STATUS_FILE}: {e}")
        return False


def _say(level: int, msg: str) -> None:
    if logging.getLogger().handlers:
        log.log(level, msg)
    else:  # before the program set up its logging: straight to the journal
        print(f"tinhat pyenv: {msg}", file=sys.stderr, flush=True)


def aiohttp_here() -> str | None:
    """The version of the aiohttp this Python would import (without importing it)."""
    try:
        from importlib import metadata
        return metadata.version("aiohttp")
    except Exception:  # noqa: BLE001 — none, or unreadable metadata
        return None


def _inside(venv: Path) -> bool:
    """This Python runs as a build of `venv` (the current one, or an older one still in place)."""
    if sys.prefix == sys.base_prefix:
        return False
    try:
        here, v = Path(sys.prefix).resolve(), Path(venv)
        return here == current(v) or (here.parent == v.parent.resolve() and here.name.startswith(f".{v.name}-"))
    except OSError:
        return False


def _good_start(state_dir: Path, lid: str) -> None:
    s = _load(state_dir)
    if s.get("venv_id") == lid and not s.get("good"):
        _save(state_dir, {**s, "good": True, "tries": 0})


def started() -> None:
    """The program on the venv says it got going (the manager: once it answers on its port). Until it does, or GRACE
    seconds alive for a program that never says (grace=…), its start counts toward the crash guard."""
    if _STARTED:
        _good_start(_STARTED["state_dir"], _STARTED["lid"])


def _on_venv(venv: Path, state_dir: Path, wheels: Path, grace: float | None) -> dict:
    global CURRENT
    try:
        lid = load_lock(wheels)[1]
    except Problem:
        lid = ""
    spec = importlib.util.find_spec("aiohttp")
    origin = os.path.realpath(spec.origin) if spec and spec.origin else ""
    if not origin.startswith(os.path.realpath(sys.prefix) + os.sep):
        CURRENT = {"runtime": "system", "aiohttp": aiohttp_here(), "python": platform.python_version(),
                   "venv": str(venv), "reason": f"on the venv's Python, aiohttp still comes from {origin or 'nowhere'}"}
        _say(logging.ERROR, f"NOT on the pinned aiohttp: {CURRENT['reason']}")
    else:
        CURRENT = {"runtime": "pinned", "aiohttp": aiohttp_here(), "python": platform.python_version(),
                   "venv": str(venv), "reason": None}
    _save(state_dir, {**_load(state_dir), **CURRENT, "at": int(time.time())})
    _STARTED.update(state_dir=state_dir, lid=lid)
    if grace:
        t = threading.Timer(grace, started)
        t.daemon = True
        t.start()
    return CURRENT


def is_off(state_dir: Path) -> bool:
    return (Path(state_dir) / OFF_FILE).exists()


def _failure_key(lid: str) -> str:
    return f"{lid}:{sys.version_info[0]}.{sys.version_info[1]}:{platform.machine()}"


def _remember(state_dir: Path, failed: dict | None) -> None:
    """A failed build/check for this lock, Python and processor (or None: it worked), for choose(); only where the
    program keeps its state (not in a Docker build)."""
    if Path(state_dir).is_dir():
        _save(state_dir, {**_load(state_dir), "failed": failed})


def choose(*, venv: Path, wheels: Path, state_dir: Path, argv: list[str], imports=(), path=None,
           can_build: bool = True, name: str = "the program", grace: float | None = GRACE,
           budget: float = START_BUDGET, release: str = "") -> dict:
    """Start this program on the pinned venv when it's ready and passes its check: the process is replaced (os.execve:
    the venv's Python, then argv) and this returns only in that new process, or when the program stays on the
    system's aiohttp. Never raises; never takes longer than budget (plus the exec). Sets and returns CURRENT:
    {"runtime": "pinned"|"system", "aiohttp", "python", "venv", "reason"}. grace: seconds alive on the venv that count
    as a good start; None: only started() does (the manager calls it once it answers on its port). release: the
    program's version; the crash guard counts starts per lock AND release, so an update starts it afresh."""
    global CURRENT
    venv, wheels, state_dir = Path(venv), Path(wheels), Path(state_dir)
    started_as = os.environ.pop(INSIDE, None)  # never handed on to anything this program starts
    if _inside(venv):
        if started_as:
            return _on_venv(venv, state_dir, wheels, grace)
        try:  # started straight on the venv's Python (not by choose()): through the checks and the guard first
            base = base_python()
            os.execve(base, [base, *argv], _exec_env())
        except OSError as e:
            _say(logging.ERROR, f"couldn't start again on the system's Python for the checks ({e})")
            return _on_venv(venv, state_dir, wheels, grace)
    s = _load(state_dir)
    try:
        if started_as:
            raise Problem("its Python didn't start as the venv")
        if is_off(state_dir):
            raise Problem(f"it is turned off on this machine ({state_dir / OFF_FILE}; `pyenv on` turns it back on)")
        deadline = time.monotonic() + budget
        lid = load_lock(wheels)[1]
        same = s.get("venv_id") == lid and s.get("release", "") == release
        tries = s.get("tries", 0) if same and not s.get("good") else 0
        if tries >= MAX_TRIES and time.time() - s.get("last_try", 0) < RETRY_AFTER:
            raise Problem(f"{name} stopped {tries} times in a row on it without getting going; it tries again "
                          f"{time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(s.get('last_try', 0) + RETRY_AFTER))} "
                          "or with the next update")
        if tries >= MAX_TRIES:
            tries = 0  # a day later: once more
        f = s.get("failed") or {}
        if f.get("key") == _failure_key(lid) and time.time() - f.get("at", 0) < RETRY_AFTER:
            raise Problem(f"{f.get('reason')} (found {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(f['at']))}; the "
                          "next update, `pyenv on` or a day later tries again)")
        try:
            res = ensure(wheels, venv, imports=imports, path=path, can_build=can_build, deadline=deadline)
        except Problem as e:  # remembered: not built and checked again at every start
            s = {**s, "failed": {"key": _failure_key(lid), "at": int(time.time()), "reason": str(e)}}
            raise
        gen = Path(res.get("venv") or venv)
        # the start is on record before it happens, or it doesn't happen (the crash guard counts on it)
        state_dir.mkdir(parents=True, exist_ok=True)
        if not _save(state_dir, {**s, "runtime": "starting", "venv": str(venv), "venv_id": lid, "release": release,
                                 "tries": tries + 1, "good": False, "failed": None, "last_try": int(time.time()),
                                 "at": int(time.time())}):
            raise Problem(f"its starts can't be recorded in {state_dir} (the crash guard needs them)")
        py = str(_python(gen))
        os.execve(py, [py, "-s", *argv], _exec_env({INSIDE: str(gen)}))
    except Problem as e:
        reason = str(e)
    except Exception as e:  # noqa: BLE001 — whatever happens, the program still starts
        reason = f"unexpected: {e!r}"
    CURRENT = {"runtime": "system", "aiohttp": aiohttp_here(), "python": platform.python_version(),
               "venv": str(venv), "reason": reason}
    _say(logging.ERROR, f"{name} runs on the system's aiohttp {CURRENT['aiohttp'] or '(none)'}, NOT the pinned one "
                        f"in {venv}: {reason}")
    _save(state_dir, {**s, **CURRENT, "at": int(time.time())})
    return CURRENT


def status(state_dir: Path) -> dict:
    """What the program said it runs on (STATUS_FILE), for status commands."""
    return _load(state_dir)


def describe(st: dict) -> str:
    """One line for a status command or a support report."""
    if not st:
        return "unknown (not started since this was added)"
    ver = st.get("aiohttp") or "?"
    if st.get("runtime") == "pinned":
        return f"aiohttp {ver}, Tin Hat's pinned copy ({st.get('venv')})"
    if st.get("runtime") == "starting":
        return f"starting on Tin Hat's pinned aiohttp ({st.get('venv')})"
    return f"aiohttp {ver} from the operating system, NOT Tin Hat's pinned copy: {st.get('reason') or 'unknown'}"


def cli(argv: list[str], *, venv: Path, wheels: Path, state_dir: Path, imports=(), path=None, prog: str,
        release: str = "", name: str = "the program") -> int:
    """`PROG build [--strict] [--venv DIR] [--wheels DIR]` (a new build, whatever is there), `PROG ensure [--budget S]`
    (build only when the release's wheels changed or the build fails its check; within S seconds), `PROG check`
    (never builds), `PROG status` (what the running program said it's on), `PROG off` / `PROG on` (the owner's switch
    for this machine; restart the program after). build and ensure always try, and forget a remembered failure when
    they work (an update's after-update runs ensure)."""
    usage = (f"usage: {prog} build [--strict] [--venv DIR] [--wheels DIR] | ensure [--budget SECONDS] | check | status"
             " | off | on")
    args = list(argv)
    cmd = args.pop(0) if args else "status"
    strict, budget = False, None
    while args:
        a = args.pop(0)
        if a == "--strict":
            strict = True
        elif a in ("--venv", "--wheels") and args:
            v = Path(args.pop(0))
            venv, wheels = (v, wheels) if a == "--venv" else (venv, v)
        elif a == "--budget" and args and args[0].isdigit():
            budget = int(args.pop(0))
        else:
            print(usage, file=sys.stderr)
            return 2
    deadline = time.monotonic() + budget if budget else None
    try:
        if cmd == "off":
            Path(state_dir).mkdir(parents=True, exist_ok=True)
            (Path(state_dir) / OFF_FILE).write_text(f"turned off {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}\n")
            print(f"off: from its next start, {name} runs on the system's aiohttp ({aiohttp_here() or 'none'}), not "
                  f"Tin Hat's pinned copy. Restart it now to switch. `{prog} on` undoes it.")
        elif cmd == "on":
            (Path(state_dir) / OFF_FILE).unlink(missing_ok=True)
            _remember(state_dir, None)
            print(f"on: from its next start, {name} uses Tin Hat's pinned aiohttp again when it passes its check. "
                  "Restart it now to switch.")
        elif cmd in ("build", "ensure"):
            lid = lock_id(wheels)
            try:
                m = (build if cmd == "build" else ensure)(wheels, venv, strict=strict, imports=imports, path=path,
                                                          deadline=deadline)
            except Problem as e:
                if lid:
                    _remember(state_dir, {"key": _failure_key(lid), "at": int(time.time()), "reason": str(e)})
                raise
            _remember(state_dir, None)
            print(f"pinned aiohttp {m['aiohttp']} ready in {venv}" + ("" if m["speedups"] else
                  f", in pure Python: this release has no compiled build for Python {sys.version_info[0]}."
                  f"{sys.version_info[1]} on {platform.machine()} (the same fixed version and the same checks, a little "
                  "slower)"))
        elif cmd == "check":
            r = ensure(wheels, venv, imports=imports, path=path, can_build=False, strict=strict)
            print(f"{venv}: aiohttp {r['aiohttp']} passes its check" + ("" if r["speedups"] else
                  " (without its compiled parts: " + ", ".join(r["missing"]) + ")"))
        elif cmd == "status":
            print(describe(status(state_dir)))
        else:
            print(usage, file=sys.stderr)
            return 2
    except Problem as e:
        print(f"{prog} {cmd}: {e}", file=sys.stderr)
        return 1
    return 0

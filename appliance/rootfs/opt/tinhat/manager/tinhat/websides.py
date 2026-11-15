"""The web app's pre-compressed copies (FILE.br next to FILE in /opt/tinhat/web), made on the box after an update.

Caddy hands FILE.br to a browser that takes brotli (templates.WEB_FILES), which makes a phone's first start after an
update seconds faster. Update bundles don't carry these copies (they'd push the bundle over the mirror's 24 MiB), and
the updater empties the web folder whenever it puts a web build in, so after an update there are none; this module
makes them again, in the background, once the new version is up. The server's own images (VM disks) come with them
(build/precompress.py); this module adopts those after checking them.

What can never happen: a copy that doesn't decode to exactly the file next to it being served.
 - Node (zlib's brotli, quality 11) from the box's own tinhat/api image makes each copy (sidefiles.mjs) in a container
   with no network, the web folder read-only and one output folder of its own (OUT, per run); it writes the copy,
   reads it back, decodes it, compares it with the file and reports the sha256 of both.
 - The manager never trusts that folder's files themselves: it reads a reported copy once (no links followed),
   checks the bytes against the reported sha256, and writes those bytes into a new file of its own (root-only
   staging). That file goes into the web folder (os.replace) under WEB_LOCK, only while the file next to it is still
   the one that was hashed (same inode, size and times) and has the reported sha256.
 - The updater swaps web builds, puts a snapshot back and copies the folder for its snapshot under the same lock
   (updater.replace_web / copy_web), so a copy checked against one build can't land in another, and a swap leaves
   none (bundles carry none).
 - Every run (and every manager start) checks each copy in the folder against the record (MANIFEST: the sha256 of
   copy and file); one that doesn't match, or a record that doesn't read right, is moved out of Caddy's sight at once
   (to HELD, root-only) and only comes back after Node checks it against the file as it is then.
What it never does: slow or fail an update or a call. It waits until the manager has been up a while, never touches
the folder while an update holds its lock, stops (container killed and gone) as soon as an update or a call starts,
runs at a low CPU weight on one CPU with a memory cap, gives up after BUDGET seconds (the container kills itself a
minute later even if the manager is gone), skips on low disk; any failure means the plain file, as before.
"""
import contextlib
import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

# The same choice as build/precompress.py (test_web_precompress / test_websides check they agree)
EXTENSIONS = (".js", ".mjs", ".css", ".html", ".wasm", ".svg", ".json")
MIN_SIZE = 1024
SKIP_DIRS = ("iconpack",)
SIDES = (".br", ".zst")

OPT = Path(os.environ.get("TINHAT_OPT", "/opt/tinhat"))
STATE = Path(os.environ.get("TINHAT_STATE", "/var/lib/tinhat"))
WEB = OPT / "web"
UPDATES = STATE / "updates"
#: held while the web folder's contents change: updater.replace_web / copy_web, and a copy being put in here
WEB_LOCK = UPDATES / ".web.lock"
#: the updater's own lock (updater.LOCK): held for a whole update
UPDATE_LOCK = UPDATES / ".update.lock"
MANIFEST = STATE / "web-sidefiles.json"
#: root-only, next to the web folder (same file system: os.replace), never inside it (Caddy would serve it)
TMP = OPT / ".web-sidefiles"
SCRIPT = Path(__file__).with_name("sidefiles.mjs")
CONTAINER = "tinhat-web-sidefiles"
BUDGET = 900          # seconds for one run's container (a Pi 5 needs ~1-2 min for the whole app)
SETTLE = 600          # seconds the manager has been up before the first run (an update's health check is over)
RETRY = 3600          # seconds before an unfinished or failed run is tried again for the same build
MIN_FREE = 256 << 20  # bytes free on /opt besides 3x what the copies are made from
MAX_COPY = 64 << 20   # no copy of ours is bigger
NOBODY = 65534        # the container's user: it may write its OUT folder and nothing else
_HEX = re.compile(r"^[0-9a-f]{64}$")
_OUT = re.compile(r"^[hw]\d+\.br$")
_started = time.monotonic()
#: set by the manager (web.py) when a call starts during a run: the run stops
STOP = threading.Event()
#: one of reconcile / run / the record's bookkeeping at a time in this manager (the start-up check and a run are
#: both executor threads)
OPS = threading.RLock()
#: the start-up check didn't happen (an update held its lock, or it failed): due() asks for a run, which checks first
_need_check = False


def _open(p: Path):
    """A plain file opened for reading, never through a link and never blocking (a FIFO planted in its place)."""
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    st = os.fstat(fd)
    if (st.st_mode & 0o170000) != 0o100000:
        os.close(fd)
        raise OSError(f"{p.name}: not a plain file")
    return os.fdopen(fd, "rb"), st


def _read(p: Path, limit: int = 1 << 31) -> tuple[bytes, os.stat_result]:
    """A plain file's bytes (at most `limit`) and stat, read once."""
    fh, st = _open(p)
    with fh:
        if st.st_size > limit:
            raise OSError(f"{p.name}: too big")
        data = fh.read(limit + 1)
    if len(data) > limit:
        raise OSError(f"{p.name}: too big")
    return data, st


def _sha_file(p: Path) -> tuple[str, os.stat_result]:
    """sha256 of a plain file, read in pieces (sources can be big)."""
    fh, st = _open(p)
    h = hashlib.sha256()
    with fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest(), st


def _same(st: os.stat_result, p: Path) -> bool:
    """p is still the very file that was hashed (an update swap makes new inodes; nothing else writes in place)."""
    try:
        now = os.lstat(p)
    except OSError:
        return False
    return (now.st_mode & 0o170000) == 0o100000 and (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns, now.st_ctime_ns) \
        == (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


@contextlib.contextmanager
def web_lock(wait: float = 10.0):
    """WEB_LOCK, waiting up to `wait` seconds; raises TimeoutError when someone (an update) keeps it."""
    WEB_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(WEB_LOCK, "a") as fh:
        end = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= end:
                    raise TimeoutError("the web folder is busy (an update)")
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def updating() -> bool:
    """An update holds its lock right now."""
    if not UPDATE_LOCK.exists():
        return False
    with open(UPDATE_LOCK, "a") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(fh, fcntl.LOCK_UN)
    return False


def wanted(p: Path, web: Path) -> bool:
    rel = p.relative_to(web)
    return (rel.parts[0] not in SKIP_DIRS and not p.is_symlink() and p.is_file() and p.suffix in EXTENSIONS
            and p.stat().st_size >= MIN_SIZE)


def ours(side: Path, web: Path) -> bool:
    """A copy this module (or build/precompress.py) makes: of an EXTENSIONS file outside SKIP_DIRS."""
    orig = side.with_name(side.name[: -len(side.suffix)])
    return side.relative_to(web).parts[0] not in SKIP_DIRS and orig.suffix in EXTENSIONS


# ---- the record --------------------------------------------------------------------------------------------------

def _entry_ok(e) -> bool:
    return isinstance(e, dict) and isinstance(e.get("src"), str) and isinstance(e.get("side"), str) \
        and bool(_HEX.match(e["src"])) and bool(_HEX.match(e["side"]))


def _load() -> dict:
    """The record, every part checked: anything that doesn't read right is simply not there (untrusted)."""
    try:
        m = json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        m = None
    if not isinstance(m, dict):
        m = {}
    files = m.get("files")
    m["files"] = {k: v for k, v in files.items() if isinstance(k, str) and _entry_ok(v)} if isinstance(files, dict) else {}
    for k in ("web", "web_tried"):
        if not isinstance(m.get(k), str):
            m.pop(k, None)
    for k in ("tried_at", "last_run"):
        if not isinstance(m.get(k), int):
            m.pop(k, None)
    return m


def _save(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST.with_name(MANIFEST.name + ".part")
    tmp.write_text(json.dumps(m, indent=1, sort_keys=True))
    os.replace(tmp, MANIFEST)


def web_signature(web: Path = None) -> str:
    """Which web build is in the folder (its version.json), cheap enough for every minute."""
    web = web or WEB
    try:
        data, st = _read(web / "version.json", 1 << 20)
        return f"{st.st_mtime_ns}:{st.st_size}:{hashlib.sha256(data).hexdigest()[:16]}"
    except OSError:
        return ""


# ---- held copies (moved out of the web folder until Node has checked them) -----------------------------------------

def _ours_dir(p: Path) -> bool:
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return (st.st_mode & 0o170000) == 0o040000 and st.st_uid == os.geteuid() and (st.st_mode & 0o077) == 0


def _tmp() -> Path:
    """TMP as a folder of this manager's alone (owner, 0700, no link); anything else there is wiped and made again
    (it only ever holds scratch work: a copy lost here is made again)."""
    if TMP.exists() or TMP.is_symlink():
        if not _ours_dir(TMP) or ((TMP / "held").exists() and not _ours_dir(TMP / "held")):
            if TMP.is_symlink() or not TMP.is_dir():
                TMP.unlink()
            else:
                shutil.rmtree(TMP)
            log.warning("web copies: %s wasn't the manager's own: made again", TMP)
    TMP.mkdir(mode=0o700, exist_ok=True)
    os.chmod(TMP, 0o700)
    return TMP


def _held_dir() -> Path:
    d = _tmp() / "held"
    d.mkdir(mode=0o700, exist_ok=True)
    if not _ours_dir(d):
        raise OSError(f"{d}: not a folder of ours")
    return d


def _held() -> dict:
    """held/<name> -> the file (relative to the web folder) it is a copy of; only entries whose file is there."""
    d = TMP / "held"
    if not (_ours_dir(TMP) and _ours_dir(d)):
        return {}
    try:
        h, _st = _read(d / "held.json", 1 << 20)
        h = json.loads(h)
    except (OSError, ValueError):
        h = {}
    if not isinstance(h, dict):
        h = {}
    return {k: v for k, v in h.items() if isinstance(k, str) and _OUT.match(k) and k.startswith("h")
            and isinstance(v, str) and (d / k).is_file() and not (d / k).is_symlink()}


def _save_held(h: dict) -> None:
    d = _held_dir()
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".held.")
    with os.fdopen(fd, "w") as fh:
        json.dump(h, fh)
    os.replace(tmp, d / "held.json")


def _sweep_held() -> None:
    """Held copies no longer on the list (checked, refused): gone. Outside the web lock (nothing serves them)."""
    d = TMP / "held"
    if not (_ours_dir(TMP) and _ours_dir(d)):
        return
    keep = set(_held()) | {"held.json"}
    for p in d.iterdir():
        if p.name not in keep:
            p.unlink()


# ---- checking what's in the folder ---------------------------------------------------------------------------------

def reconcile(web: Path = None, wait: float = 10.0) -> dict:
    """Every copy in the web folder matches the record, or is moved out to HELD (Node checks it on the next run) or
    removed. Hashing happens before the lock; under it only each file's identity is checked again (quick)."""
    with OPS:
        return _reconcile(web or WEB, wait)


def _reconcile(web: Path, wait: float) -> dict:
    out = {"kept": 0, "held": 0, "removed": 0}
    if updating():
        return {**out, "skipped": "an update is running"}
    _tmp()  # repaired (if it must be) before the web lock: under it, it's only used
    m = _load()
    files = m["files"]
    plan = []
    for side in sorted(p for p in web.rglob("*") if p.suffix in SIDES and (p.is_file() or p.is_symlink())):
        if not ours(side, web):
            continue
        rel = str(side.relative_to(web))
        orig = side.with_name(side.name[: -len(side.suffix)])
        try:
            s_sha, s_st = _sha_file(side)
            o_sha, o_st = _sha_file(orig)
        except OSError:
            plan.append(("remove", rel, side, orig, None, None))
            continue
        e = files.get(rel)
        if side.suffix == ".br" and e and e["side"] == s_sha and e["src"] == o_sha:
            plan.append(("keep", rel, side, orig, s_st, o_st))
        elif side.suffix == ".br":
            plan.append(("hold", rel, side, orig, s_st, o_st))
        else:
            plan.append(("remove", rel, side, orig, None, None))  # a .zst: the box makes brotli only
    with web_lock(wait):
        if updating():
            return {**out, "skipped": "an update is running"}
        held = _held()
        n = max([int(k[1:-3]) for k in held] + [0])
        changed = False
        keep = set()
        for verdict, rel, side, orig, s_st, o_st in plan:
            if verdict == "keep" and _same(s_st, side) and _same(o_st, orig):
                keep.add(rel)
                out["kept"] += 1
                continue
            changed = True
            files.pop(rel, None)
            try:
                if verdict != "remove" and _same(s_st, side) and _same(o_st, orig):
                    d = _held_dir()
                    n += 1
                    os.replace(side, d / f"h{n}.br")  # out of Caddy's sight at once
                    held[f"h{n}.br"] = str(orig.relative_to(web))
                    out["held"] += 1
                else:
                    side.unlink()  # a link, a .zst, a copy whose file is gone or changed while it was hashed
                    out["removed"] += 1
            except FileNotFoundError:
                pass
        for rel in [r for r in files if r not in keep]:
            del files[rel]
            changed = True
        if changed:
            m.pop("web", None)  # this build isn't done any more: the next run makes what's missing
        _save(m)
        if held or (TMP / "held").exists():
            _save_held(held)
    _sweep_held()
    if out["held"] or out["removed"]:
        log.info("web copies: %(kept)s kept, %(held)s held for a check, %(removed)s removed", out)
    return out


# ---- running Node --------------------------------------------------------------------------------------------------

def api_image(opt: Path = None) -> str | None:
    """The tinhat/api image this box runs (compose.yaml), if Docker has it."""
    try:
        m = re.search(r"(?m)^\s*image:\s*(tinhat/api:[A-Za-z0-9._-]+)\s*$", ((opt or OPT) / "compose.yaml").read_text())
    except OSError:
        return None
    if not m:
        return None
    r = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", m.group(1)], capture_output=True, timeout=30)
    return m.group(1) if r.returncode == 0 else None


def _watch(cmd: list, stdin: Path, stdout: Path, budget: float, should_stop, kill, env=None) -> str:
    """cmd with stdin/stdout files, polled: killed (kill(), then waited for) on the budget or should_stop()."""
    with open(stdin, "rb") as i, open(stdout, "wb") as o:
        proc = subprocess.Popen(cmd, stdin=i, stdout=o, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    end = time.monotonic() + budget
    try:
        while proc.poll() is None:
            why = (f"stopped after {int(budget)} s (the rest next time)" if time.monotonic() > end
                   else "stopped: an update or a call started" if should_stop() else None)
            if why:
                log.info("web copies: %s", why)
                break
            time.sleep(1)
    finally:  # whatever happened (also an exception here): the process is ended and waited for
        if proc.poll() is None:
            with contextlib.suppress(Exception):
                kill(proc)
            try:
                proc.wait(60)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(10)
    with open(stdout, "rb") as fh:
        return fh.read(1 << 22).decode(errors="replace")


def _container_gone() -> bool:
    r = subprocess.run(["docker", "ps", "-aq", "--filter", f"name=^/{CONTAINER}$"], capture_output=True, timeout=30)
    return r.returncode == 0 and not r.stdout.strip()


def remove_container() -> None:
    """A container left by a manager that stopped mid-run: gone before anything reads its folder."""
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, timeout=60)
    if not _container_gone():
        raise RuntimeError(f"the {CONTAINER} container is still there")


def docker_runner(jobs: dict, web: Path, out: Path, budget: float, should_stop) -> str:
    """Node in the box's own API image: no network, read-only web, its own output folder, one CPU at a low weight;
    the container ends itself a minute after the budget even if nobody is left to stop it."""
    image = api_image()
    if not image:
        raise RuntimeError("no tinhat/api image to make the copies with")
    remove_container()
    io = out.parent
    (io / "jobs.json").write_text(json.dumps(jobs))
    cmd = ["docker", "run", "--rm", "-i", "--name", CONTAINER, "--network", "none", "--read-only",
           "--user", f"{NOBODY}:{NOBODY}", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
           "--cpus", "1", "--cpu-shares", "64", "--memory", "512m", "--pids-limit", "32",
           "-v", f"{web}:/web:ro", "-v", f"{out}:/out", "-v", f"{SCRIPT}:/sidefiles.mjs:ro",
           "--entrypoint", "timeout", image, "-s", "KILL", str(int(budget) + 60), "node", "/sidefiles.mjs"]

    def kill(proc):
        subprocess.run(["docker", "kill", CONTAINER], capture_output=True, timeout=60)
        proc.kill()  # the docker client itself
    try:
        text = _watch(cmd, io / "jobs.json", io / "results.jsonl", budget, should_stop, kill)
    finally:
        remove_container()  # raises if it can't be confirmed gone: then nothing it wrote is used
    return text


# ---- putting copies in ---------------------------------------------------------------------------------------------

def _install(r: dict, web: Path, files: dict, run_dir: Path, held: dict, before_replace=None) -> str:
    """One copy Node checked into the web folder (see the module's doc). Returns what happened."""
    rel, out = r.get("rel"), r.get("out")
    if not isinstance(rel, str) or not isinstance(out, str) or not _OUT.match(out) \
            or not _HEX.match(str(r.get("src", ""))) or not _HEX.match(str(r.get("side", ""))):
        return "bad answer"
    src = web / rel
    try:
        src.resolve().relative_to(web.resolve())
    except ValueError:
        return "bad answer"
    if not wanted(src, web):
        return "file gone"
    if out.startswith("h"):  # a held copy: the bytes are our own (root-only), Node checked a copy of them
        if held.get(out) != rel:
            return "bad answer"
        where = TMP / "held" / out
    else:
        where = run_dir / "out" / out
    try:
        data, _st = _read(where, MAX_COPY)
    except OSError:
        return "copy gone"
    if hashlib.sha256(data).hexdigest() != r["side"]:
        return "copy changed after its check"
    try:
        s_sha, s_st = _sha_file(src)
    except OSError:
        return "file gone"
    if s_sha != r["src"]:
        return "file changed"
    # the checked bytes in a new file of our own (the output folder's file itself is never used)
    stage = run_dir / "stage"
    stage.mkdir(mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=stage, suffix=".br")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        t = s_st.st_mtime_ns // 1_000_000_000 + 1  # never the file's own ETag (build/precompress.py)
        os.utime(tmp, (t, t))
        if before_replace:
            before_replace(src, where)  # tests: what may change between the checks and the rename
        side = src.with_name(src.name + ".br")
        with web_lock(2.0):
            if updating():
                raise TimeoutError("an update started")
            if not _same(s_st, src):
                return "file changed"
            if side.is_dir() and not side.is_symlink():
                return "a folder in the way"
            os.replace(tmp, side)
            files[str(side.relative_to(web))] = {"src": r["src"], "side": r["side"]}
        return "installed"
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


def run(web: Path = None, runner=None, budget: float = BUDGET, free=None, should_stop=None, before_replace=None) -> dict:
    """One pass: check what's there, make what's missing, put in what checks out. Never raises for an ordinary
    failure (logged, returned)."""
    global _need_check
    with OPS:
        res = _run(web or WEB, runner, budget, free, should_stop, before_replace)
    if "reconcile" in res and not res["reconcile"].get("skipped"):
        _need_check = False
    return res


def _run(web, runner, budget, free, should_stop, before_replace) -> dict:
    runner = runner or docker_runner
    stop = should_stop or (lambda: STOP.is_set() or updating())
    res = {"done": False}
    run_dir = None
    start_sig = web_signature(web)  # first: "done" is written only for this build, if it is still there at the end
    try:
        if stop():
            return {**res, "skipped": "an update or a call is running"}
        sources = [p for p in web.rglob("*") if wanted(p, web)]
        need = 3 * sum(p.stat().st_size for p in sources)
        if (free or (lambda: shutil.disk_usage(OPT).free))() < MIN_FREE + need:
            return {**res, "skipped": "not enough free disk"}
        res["reconcile"] = rc = reconcile(web)
        if rc.get("skipped"):
            return {**res, "skipped": rc["skipped"]}
        held = _held()
        m = _load()
        files = m["files"]
        run_dir = Path(tempfile.mkdtemp(dir=_tmp(), prefix="run-"))  # this run's only (root, 0700)
        out = run_dir / "out"
        out.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(out, NOBODY, NOBODY)
        jobs = []
        for name, rel in held.items():  # Node checks a copy of the held bytes; what goes in are the held bytes
            shutil.copyfile(TMP / "held" / name, out / name)
            if os.geteuid() == 0:
                os.chown(out / name, NOBODY, NOBODY)
            jobs.append({"rel": rel, "mode": "check", "out": name})
        n = 0
        for p in sorted(sources):
            rel = str(p.relative_to(web))
            if (rel + ".br" in files and (web / (rel + ".br")).is_file()) or rel in held.values():
                continue
            n += 1
            jobs.append({"rel": rel, "mode": "make", "out": f"w{n}.br"})
        res["jobs"] = len(jobs)
        got = {}
        if jobs:
            text = runner({"jobs": jobs}, web, out, budget, stop)
            answered = set()
            for line in text.splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(r, dict) or r.get("out") in answered:
                    continue
                answered.add(r.get("out"))
                if not r.get("ok"):
                    what = str(r.get("why", "?"))[:40]
                else:
                    if stop():
                        res["stopped"] = "an update or a call started"
                        break
                    try:
                        what = _install(r, web, files, run_dir, held, before_replace)
                    except TimeoutError as e:
                        res["stopped"] = str(e)
                        break
                if isinstance(r.get("out"), str) and r["out"] in held:
                    del held[r["out"]]  # checked one way or the other: put in, or refused (never back)
                    if what != "installed":
                        res["refused_held"] = res.get("refused_held", 0) + 1
                got[what] = got.get(what, 0) + 1
            res["results"] = got
        res["done"] = "stopped" not in res and got.get("installed", 0) + got.get("no smaller", 0) == len(jobs)
        m["last_run"] = int(time.time())
        if res.get("refused_held"):
            m.pop("tried_at", None)  # their files get a copy made on the next run, not an hour later
        with web_lock(10.0):
            # done only for the build this run started on, still in the folder now (an update may have swapped it)
            if res["done"] and web_signature(web) == start_sig and not updating():
                m["web"] = start_sig
            else:
                res["done"] = False
                m.pop("web", None)
            _save(m)
            if (TMP / "held").exists():
                _save_held(held)
        _sweep_held()
    except Exception as e:  # noqa: BLE001 — best effort: the plain files are served as before
        log.warning("web copies: %r", e)
        res["error"] = repr(e)[:200]
    finally:
        if run_dir is not None:
            shutil.rmtree(run_dir, ignore_errors=True)
        with contextlib.suppress(OSError):
            TMP.rmdir()  # only when empty (no copy held for a check)
    if res.get("results"):
        log.info("web copies: %s", res)
    return res


def startup() -> None:
    """At the manager's start: a container a stopped manager left is removed, its run folders too, then the folder
    is checked. A check that couldn't happen is asked for again (due())."""
    global _need_check
    _need_check = True
    with contextlib.suppress(Exception):
        remove_container()
    with OPS:
        if _ours_dir(TMP):
            for p in TMP.iterdir():
                if p.name.startswith("run-"):
                    shutil.rmtree(p, ignore_errors=True)
        r = reconcile()
    if not r.get("skipped"):
        _need_check = False


def due(now: float = None) -> bool:
    """Worth a run: the manager has settled, no update, and this web build isn't done (or a check is waiting); for
    a build whose run didn't finish, once an hour."""
    now = time.time() if now is None else now
    if time.monotonic() - _started < SETTLE or updating():
        return False
    if _need_check:
        return True
    m = _load()
    if m.get("web") == web_signature() and not _held():
        return False
    return m.get("web_tried") != web_signature() or now - m.get("tried_at", 0) >= RETRY


def mark_tried(now: float = None) -> None:
    """A run starts for this web build (due() waits RETRY before the next one for the same build)."""
    with OPS:
        m = _load()
        m["web_tried"] = web_signature()
        m["tried_at"] = int(time.time() if now is None else now)
        _save(m)

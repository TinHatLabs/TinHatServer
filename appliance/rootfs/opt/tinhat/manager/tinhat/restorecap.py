"""How much a restic restore may write (0.3.16; the 0.3.10 design note "restic's restored size: a quota").

restoresafe bounds an uploaded .tar. The `restic restore` that follows reads a repository someone else may have made:
deduplication lets a tiny repository restore one chunk into a huge file, or into millions of small files, and fill
the disk (or its inodes) before anything looks at the result. On a server being set up that breaks the setup half
way; a Test restore on a live server would fill the live server's disk. So every restore:
  1. PREFLIGHT: the snapshot's own listing (`restic ls --json`, tree metadata only, restic's cache off so the listing
     itself writes nothing) gives what it CLAIMS to restore: the bytes of its files and the number of entries. More
     than this disk can take (its free space minus a reserve, its free inodes minus a reserve) or more than MAX_ENTRIES
     entries → refused before anything is written. The listing is read as a stream, line by line with a length limit,
     and stops at MAX_ENTRIES (a listing of millions is itself the attack).
  2. CAP: the claim comes from the repository, so it can lie (a tree node's size is just a number in it). While restic
     runs, a watchdog measures what it has restored so far under the target (the files' sizes and the number of entries,
     walked without following links: other writers on the disk, deletions elsewhere and compression don't change it)
     and the disk's free space and inodes. Past the claim (+ CLAIM_SLACK + SLACK_*) or under the floors → restic's whole
     process group is stopped, everything under the target is removed, and the restore fails with "bigger than it says".
     The same check runs once more after restic exits, whatever its exit code (a restic that hit ENOSPC between two
     looks fails with its files kept otherwise).
Residual (said plainly): this is a watchdog, not an allocation limit; between two looks (POLL) restic can write a
burst. The reserve (2 GB before, 1 GB floor during) is many seconds of a fast disk at POLL = 0.1 s; the restored tree is
walked in a thread of its own, so a slow walk never delays the disk and time checks. restic's output is drained into
a bounded tail in memory (never a file that could grow). Works the same on
every edition (no loop devices: the Compose edition's manager has no privileges for them, and a restore that has to
land on the live disk anyway would need twice its size if it went through an image first).
"""
from __future__ import annotations

import collections
import json
import os
import shutil
import signal
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .restoresafe import UnsafeBackup

#: kept free while a restore runs (bytes; the same reserve as an upload's)
RESERVE_BYTES = 2 * 1024**3
#: kept free while a restore runs (inodes)
RESERVE_INODES = 20_000
#: a real Tin Hat backup is a handful of files plus media (a 30-person server with years of history: ~30k)
MAX_ENTRIES = 200_000
#: one line of `restic ls --json` (a node: name, path, times, ids) is far below this
MAX_LINE = 1024 * 1024
#: what may be restored beyond the claim, as a part of it, and on top
CLAIM_SLACK = 0.10
SLACK_BYTES = 256 * 1024**2
SLACK_ENTRIES = 1_000
#: below this much free space / free inodes the restore stops whatever it claimed
FLOOR_BYTES = 1024**3
FLOOR_INODES = 5_000
#: how often the disk is looked at; the restored tree is walked at most every TREE_EVERY s (more when a walk is slow)
POLL = 0.1
TREE_EVERY = 1.0
#: kept of restic's own output (its last lines say why it failed)
TAIL = 64 * 1024


@dataclass
class Claim:
    bytes: int = 0
    entries: int = 0


@dataclass
class Disk:
    free_bytes: int    # for unprivileged writers (f_bavail)
    free_inodes: int   # f_favail
    has_inodes: bool   # (a filesystem without inode accounting reports 0 inodes: then not used)


@dataclass
class Tree:
    bytes: int = 0     # the regular files' sizes
    entries: int = 0   # every entry (files, directories, links, …)


def disk(path: Path) -> Disk:
    s = os.statvfs(path)
    return Disk(s.f_bavail * s.f_frsize, s.f_favail, s.f_files > 0)


def _walk_error(e: OSError) -> None:
    if not isinstance(e, FileNotFoundError):  # (a folder restic is still creating or moving: transient)
        raise e


def tree(root: Path) -> Tree:
    """What has been restored under root so far (never following a link). A folder that can't be read raises: what
    it holds can't be counted, so it can't be allowed."""
    t = Tree()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False, onerror=_walk_error):
        t.entries += len(dirnames) + len(filenames)
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except FileNotFoundError:
                continue
            if stat.S_ISREG(st.st_mode):
                t.bytes += st.st_size
    return t


def _too_many() -> UnsafeBackup:
    return UnsafeBackup(f"This backup holds more than {MAX_ENTRIES:,} files; that isn't a Tin Hat backup, so it wasn't "
                        "restored.")


def claim(lines) -> Claim:
    """The snapshot's claim from `restic ls --json` output lines (an iterator; stops reading past MAX_ENTRIES)."""
    c = Claim()
    for line in lines:
        if len(line) > MAX_LINE:
            raise UnsafeBackup("This backup's list of files isn't one restic writes for a Tin Hat backup; it wasn't "
                               "restored.")
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if not isinstance(j, dict) or "path" not in j or j.get("struct_type", "node") != "node":
            continue  # the snapshot's own line, or anything else that isn't an entry
        c.entries += 1
        if j.get("type") == "file":
            size = j.get("size")
            c.bytes += size if isinstance(size, int) and not isinstance(size, bool) and size > 0 else 0
        if c.entries > MAX_ENTRIES:
            raise _too_many()
    return c


class _Tail:
    """Drains a pipe in a thread and keeps only its last TAIL bytes (restic's output can't fill memory or a disk)."""

    def __init__(self, stream):
        self.buf: collections.deque[bytes] = collections.deque()
        self.size = 0
        self.thread = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self.thread.start()

    def _run(self, stream) -> None:
        try:
            while chunk := stream.read(65536):
                self.buf.append(chunk)
                self.size += len(chunk)
                while self.size - len(self.buf[0]) >= TAIL:
                    self.size -= len(self.buf.popleft())
        except (OSError, ValueError):
            pass

    def text(self, wait: float = 5) -> str:
        self.thread.join(wait)
        return b"".join(self.buf)[-TAIL:].decode(errors="replace")


def _lines(f, limit: int):
    """Lines of a binary stream, each read with a length limit (a longer one comes back longer than limit)."""
    while True:
        line = f.readline(limit + 1)
        if not line:
            return
        yield line


def read_claim(cmd: list[str], env: dict | None, timeout: float = 900) -> Claim:
    """Run `restic ls --json …` and read its claim as a stream (stopped early when it's too long or too slow)."""
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    err = _Tail(proc.stderr)
    timer = threading.Timer(timeout, _kill, (proc,))
    timer.start()
    try:
        c = claim(_lines(proc.stdout, MAX_LINE))
        proc.wait()  # (the timer still runs: a restic that never exits is stopped)
    finally:
        timer.cancel()
        _kill(proc)  # the whole group, whatever happened (an early stop, a leftover child)
        proc.stdout.close()
    if proc.returncode != 0:
        lines = err.text().strip().splitlines()
        raise UnsafeBackup(f"Couldn't read the backup's list of files: {lines[-1] if lines else proc.returncode}")
    return c


def preflight(c: Claim, d: Disk) -> None:
    """Refuse a restore this disk can't take, by the backup's own claim (before anything is written)."""
    if c.entries > MAX_ENTRIES:
        raise _too_many()
    need = int(c.bytes * (1 + CLAIM_SLACK)) + RESERVE_BYTES
    if need > d.free_bytes:
        raise UnsafeBackup(f"This backup needs about {_gb(need)} of free space here and there's {_gb(d.free_bytes)}: "
                           "make room (or use a bigger disk), then try again.")
    if d.has_inodes and int(c.entries * (1 + CLAIM_SLACK)) + RESERVE_INODES > d.free_inodes:
        raise UnsafeBackup("This backup holds more files than this disk has room for; it wasn't restored.")


def limits(c: Claim) -> tuple[int, int]:
    """(bytes, entries) the restore may put under its target."""
    return (int(c.bytes * (1 + CLAIM_SLACK)) + SLACK_BYTES, int(c.entries * (1 + CLAIM_SLACK)) + SLACK_ENTRIES)


def over(c: Claim, t: Tree | None, d: Disk | None) -> str | None:
    """Why the restore must stop now, or None (t / d: None = not measured this time)."""
    max_bytes, max_entries = limits(c)
    if t is not None and t.bytes > max_bytes:
        return "bytes"
    if t is not None and t.entries > max_entries:
        return "files"
    if d is not None and d.free_bytes < FLOOR_BYTES:
        return "free space"
    if d is not None and d.has_inodes and d.free_inodes < FLOOR_INODES:
        return "free inodes"
    return None


class _Walker:
    """The restored tree, measured in a thread of its own (a slow walk never holds up the disk and time checks)."""

    def __init__(self, measure, target: Path):
        self.measure, self.target = measure, target
        self.latest: Tree | None = None
        self.error: BaseException | None = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        while not self.stop.is_set():
            try:
                self.latest = self.measure(self.target)
            except BaseException as e:  # noqa: BLE001 — handed to the watchdog, which stops restic
                self.error = e
                return
            self.stop.wait(TREE_EVERY)

    def take(self) -> Tree | None:
        if self.error is not None:
            raise self.error
        t, self.latest = self.latest, None
        return t

    def close(self) -> None:
        """Stop walking; a walk under way finishes on its own (a daemon thread that only reads), never waited for."""
        self.stop.set()
        self.thread.join(0.2)


def run_capped(cmd: list[str], env: dict | None, target: Path, c: Claim, timeout: float, poll: float | None = None,
               measure=tree, measure_disk=disk) -> subprocess.CompletedProcess:
    """Run restic (cmd) writing under `target` with the watchdog; returns its CompletedProcess (the tails of its
    output). Past the claim the process group is killed, everything under target is removed and UnsafeBackup is
    raised; any other way out (an error of the watchdog itself) also stops restic and clears the target."""
    poll = POLL if poll is None else poll
    target.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    out, err = _Tail(proc.stdout), _Tail(proc.stderr)
    walker = _Walker(measure, target)
    why = None
    done = False
    try:
        deadline = time.monotonic() + timeout
        while proc.poll() is None:
            why = over(c, walker.take(), measure_disk(target))
            if why is not None:
                break
            if time.monotonic() > deadline:
                why = "time"
                break
            time.sleep(poll)
        _kill(proc)  # the group: a stop, or descendants left behind by a leader that exited
        walker.close()
        if why is None:  # what it wrote in the last moment counts too, whatever restic's exit code
            why = over(c, measure(target), measure_disk(target))
        done = True
    finally:
        if not done:  # the watchdog itself failed: never leave restic running or its files behind
            _kill(proc)
            walker.close()
            clear(target)
    if why is not None:
        clear(target)
        if why == "time":
            raise UnsafeBackup("Reading the backup took too long; it wasn't restored, and nothing it wrote was kept.")
        raise UnsafeBackup(f"This backup is bigger than it says ({why}); it wasn't restored, and nothing it wrote "
                           "was kept.")
    return subprocess.CompletedProcess(cmd, proc.returncode, out.text(), err.text())


def clear(target: Path) -> None:
    """Everything under target goes (never following a link out of it); raises when something can't be removed. A
    restored folder without write or search rights for its owner is opened up first (only folders under target, never
    through a link)."""
    if not target.is_dir():
        return
    for attempt in range(2):
        for child in list(target.iterdir()):
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink()
                except FileNotFoundError:
                    pass
        if not any(target.iterdir()) or attempt:
            break
        for dirpath, dirnames, _ in os.walk(target, followlinks=False, onerror=lambda e: None):
            for name in dirnames:
                p = os.path.join(dirpath, name)
                if not os.path.islink(p):
                    try:
                        os.chmod(p, 0o700)
                    except OSError:
                        pass
        for p in target.iterdir():  # a folder its walk couldn't enter (mode 000 at the top)
            if p.is_dir() and not p.is_symlink():
                try:
                    os.chmod(p, 0o700)
                except OSError:
                    pass
    left = list(target.iterdir())
    if left:
        raise UnsafeBackup(f"The restore was stopped, but part of what it wrote couldn't be removed ({left[0]}).")


def read_capped(cmd: list[str], env: dict | None, max_bytes: int, timeout: float = 600) -> bytes | None:
    """stdout of cmd (e.g. `restic dump` of one small file), or None when it fails or is longer than max_bytes."""
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    timer = threading.Timer(timeout, _kill, (proc,))
    timer.start()
    try:
        data = proc.stdout.read(max_bytes + 1)
        if len(data) > max_bytes:
            return None
        proc.wait()
    finally:
        timer.cancel()
        _kill(proc)
        proc.stdout.close()
    return data if proc.returncode == 0 else None


def _kill(proc: subprocess.Popen) -> None:
    """SIGKILL to the process group (restic and anything it started), then reap the leader."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(30)
    except subprocess.TimeoutExpired:
        pass


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f} GB"

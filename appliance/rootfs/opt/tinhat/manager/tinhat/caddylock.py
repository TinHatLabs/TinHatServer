"""One change to the web server's settings (the Caddyfile) at a time, across processes: the dashboard, the background
loop, setup, a move, the relay, a restore and the console all write the Caddyfile under the same flock
(config.STATE_DIR/caddy-apply.lock), and each stages its new file under a name of its own before it is validated and
swapped in. Two writers at once can never leave a file made of both, nor validate or swap in each other's file
(assembly-039 review S2: relay.py, install.py and move.py used a shared `Caddyfile.new` outside the lock)."""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import os
import secrets
import time
from pathlib import Path

from . import compose, config, state


def lock_path() -> Path:
    """config.STATE_DIR/caddy-apply.lock (looked up when used: tests load this module under a stubbed config)."""
    return config.STATE_DIR / "caddy-apply.lock"


def __getattr__(name):  # caddylock.APPLY_LOCK, as web.APPLY_LOCK was
    if name == "APPLY_LOCK":
        return lock_path()
    raise AttributeError(name)

#: the task in this process that holds the flock through CaddyLock, and how deep (a writer that holds it can call
#: another that takes it). One per process is enough: any other task of this process waits on the flock itself.
_owner = None
_depth = 0

BUSY = "another change to the web server's settings is still running"


def _me():
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


class CaddyLock:
    """async with CaddyLock(): an exclusive flock on lock_path(), waited for without blocking the event loop (2 minutes
    at most, then TimeoutError). Taken again by the task that holds it, it is a no-op (no self-deadlock); any other
    task, in this process or another, waits. The descriptor is closed on every way out: a cancelled wait, an
    exception inside."""
    def __init__(self, seconds: float = 120):
        self.seconds, self.fd, self.nested = seconds, None, False

    async def __aenter__(self):
        global _owner, _depth
        me = _me()
        if me is not None and _owner is me:
            _depth += 1
            self.nested = True
            return self
        fd = os.open(lock_path(), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            for _ in range(max(1, int(self.seconds * 10))):
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.fd = fd
                    _owner, _depth = me, 1
                    return self
                except BlockingIOError:
                    await asyncio.sleep(0.1)
            raise TimeoutError(BUSY)
        except BaseException:
            if self.fd is None:
                os.close(fd)
            raise

    async def __aexit__(self, *exc):
        global _owner, _depth
        if self.nested:
            _depth -= 1
            self.nested = False
            return False
        if self.fd is None:
            return False
        _owner, _depth = None, 0
        os.close(self.fd)  # the flock goes with the descriptor
        self.fd = None
        return False


@contextlib.contextmanager
def held_sync(seconds: float = 120):
    """The same lock for code without an event loop (`tinhat after-update`, the manager's start-up). Yields True when
    it was had; after `seconds` it yields False, and then the caller must NOT write the Caddyfile (it skips or defers
    that write: mark_pending)."""
    fd = os.open(lock_path(), os.O_RDWR | os.O_CREAT, 0o600)
    got = False
    try:
        end = time.monotonic() + seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                got = True
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    break
                time.sleep(0.1)
        yield got
    finally:
        os.close(fd)


PENDING = "caddyfile_pending"


def mark_pending(why: str) -> None:
    """A Caddyfile write that couldn't have the lock was skipped: the manager writes it again from the state, under
    the lock, within a minute (web._write_pending_caddyfile)."""
    state.save_state(**{PENDING: {"at": int(time.time()), "why": why, "id": secrets.token_hex(8)}})


def staged_path() -> Path:
    """A name of this write's own beside the live Caddyfile (the web server's container sees the same folder)."""
    live = config.CADDYFILE
    return live.with_name(f"{live.name}.new-{secrets.token_hex(4)}")


async def put_checked(text: str, mode: int) -> tuple[int, str]:
    """The caller holds CaddyLock. Write `text` under a staged name, have Caddy validate it, and only then swap it in
    for the live Caddyfile. -> (rc, output) of the validation; rc != 0: the live file is untouched. The staged file
    never outlives the call."""
    nxt = staged_path()
    try:
        state.write_text(nxt, text, mode)
        rc, out = await compose.caddy_validate(f"/etc/caddy/{nxt.name}")
        if rc == 0:
            os.replace(nxt, config.CADDYFILE)
        return rc, out
    finally:
        try:
            nxt.unlink(missing_ok=True)
        except OSError:
            pass

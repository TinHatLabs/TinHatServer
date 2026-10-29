"""Restoring from a backup someone else made (security review 2026-10-26, server manager lows; sec-night-2 2026-10-27).

A backup is a restic repository: authenticated with its password, but whoever made it chose every byte, so a restore
treats it as untrusted input:
  - the uploaded .tar (restore_upload) is bounded while it arrives (this computer's free space minus a reserve) and
    before anything is extracted (the members' total size, the same bound; a compressed archive may inflate at most
    MAX_RATIO times); only directories and regular files are extracted (a restic repository has nothing else);
  - the restored files (restic restore) are walked before anything is used: symbolic links, hard-link tricks, devices,
    FIFOs and sockets are removed (a Tin Hat backup has none), so no later copy or move follows one;
  - the restored secrets are checked against the shapes Tin Hat generates them in before any of them reaches a config
    file (homeserver.yaml, compose.env, livekit.yaml are written from them by f-string) or a SQL statement; a value
    that doesn't fit refuses the restore;
  - the database password is handed to psql as a quoted variable, never pasted into SQL text.
Pure: no aiohttp, no state; the tests run it anywhere.
"""
from __future__ import annotations

import contextlib
import os
import re
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path

#: kept free on the disk while an upload arrives / is extracted
RESERVE_BYTES = 2 * 1024**3
#: a compressed upload may inflate to at most this many times its size (Tin Hat's own download is an uncompressed .tar
#: of an already compressed restic repository: about 1x)
MAX_RATIO = 20

#: the secrets written into config files, and the shapes state.load_secrets generates them in (token_urlsafe; the
#: LiveKit key "tinhat" + 8 hex)
CONFIG_SECRETS = {
    "postgres_password": re.compile(r"[A-Za-z0-9_-]{16,256}"),
    "registration_shared_secret": re.compile(r"[A-Za-z0-9_-]{16,256}"),
    "macaroon_secret_key": re.compile(r"[A-Za-z0-9_-]{16,256}"),
    "form_secret": re.compile(r"[A-Za-z0-9_-]{16,256}"),
    "livekit_key": re.compile(r"[A-Za-z0-9_-]{4,64}"),
    "livekit_secret": re.compile(r"[A-Za-z0-9_-]{16,256}"),
}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class UnsafeBackup(Exception):
    """The backup can't be restored as it is; the message is for the owner."""


def upload_limit(free_bytes: int) -> int:
    """How many bytes an upload may have on a disk with this much free."""
    return max(0, free_bytes - RESERVE_BYTES)


def check_tar(path: Path, free_bytes: int) -> None:
    """Before extracting an uploaded archive: only directories and regular files with safe names, their total size
    within this disk's free space, and (compressed) at most MAX_RATIO times the archive's size."""
    size = path.stat().st_size
    total = 0
    compressed = _is_compressed(path)
    with tarfile.open(path) as t:  # (any compression tarfile knows; the ratio bound below)
        for m in t:
            if not (m.isdir() or m.isreg()):
                raise UnsafeBackup("That file isn't a Tin Hat backup: it holds links or special files.")
            name = m.name
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name or _CONTROL.search(name):
                raise UnsafeBackup("That file isn't a Tin Hat backup: it holds a file outside its own folder.")
            total += max(0, m.size)
            if total > upload_limit(free_bytes):
                raise UnsafeBackup("That backup is bigger than the free space on this computer.")
            if compressed and total > MAX_RATIO * max(size, 1):
                raise UnsafeBackup("That file unpacks to far more than its own size; upload the .tar Tin Hat downloaded, as it is.")


def _is_compressed(path: Path) -> bool:
    with open(path, "rb") as f:
        head = f.read(6)
    return head.startswith(b"\x1f\x8b") or head.startswith(b"BZh") or head.startswith(b"\xfd7zXZ\x00")


def extract_tar(path: Path, dest: Path, free_bytes: int) -> None:
    """check_tar, then extract (the data filter on top: no absolute names, nothing outside dest, no special files)."""
    check_tar(path, free_bytes)
    with tarfile.open(path) as t:
        t.extractall(dest, filter="data")


def strip_specials(root: Path) -> list[str]:
    """Remove every symbolic link and every entry that is neither a directory nor a regular file under root, without
    following any link; a regular file with more than one link is copied to a file of its own first (a hard link
    shared with something outside the tree must not be written through). Returns the removed names (relative).

    Two passes (assembly-038 review): every link and special file goes first, so the hard-link split never meets a
    name the backup chose; the split's copy is a fresh mkstemp file (O_EXCL, a random name) written through its own
    descriptor, never a path the backup could have planted a link at."""
    removed: list[str] = []

    def fail(e: OSError) -> None:  # a directory that can't be listed can't be cleaned: the restore stops
        raise UnsafeBackup(f"Part of the backup couldn't be checked ({e.strerror or e}); it wasn't restored.")
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False, onerror=fail):
        for name in list(dirnames) + filenames:
            p = Path(dirpath) / name
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode):
                continue
            p.unlink()
            removed.append(str(p.relative_to(root)))
            if name in dirnames:
                dirnames.remove(name)
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False, onerror=fail):
        for name in filenames:
            p = Path(dirpath) / name
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:  # streamed into a fresh inode (media files can be large)
                _split(p, st)
    return removed


def _split(p: Path, st: os.stat_result) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".tinhat-split-", dir=p.parent)
    src = -1
    try:
        src = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        fsrc = os.fdopen(src, "rb")
        src = -1  # the file object owns it now
        with fsrc, os.fdopen(fd, "wb") as fdst:
            fd = -1
            shutil.copyfileobj(fsrc, fdst, 1024 * 1024)
            os.fchmod(fdst.fileno(), stat.S_IMODE(st.st_mode))
        os.replace(tmp, p)
    except BaseException:
        if src >= 0:
            os.close(src)
        if fd >= 0:
            os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def check_secrets(s: object) -> dict:
    """The restored secrets.json: a JSON object; the config secrets (when present) in their generated shapes; no control character in
    any other string (they end up in env files and configs too). Returns it; raises UnsafeBackup otherwise."""
    if not isinstance(s, dict):
        raise UnsafeBackup("The backup's settings are damaged (the secrets aren't readable).")
    for k, rx in CONFIG_SECRETS.items():
        if k not in s:  # (an older backup without one: the loader's own handling, as before)
            continue
        v = s.get(k)
        if not isinstance(v, str) or not rx.fullmatch(v):
            raise UnsafeBackup(f"The backup's settings don't look like Tin Hat's own ({k}); it wasn't restored.")

    def walk(v: object, where: str) -> None:
        if isinstance(v, str):
            if _CONTROL.search(v):
                raise UnsafeBackup(f"The backup's settings don't look like Tin Hat's own ({where}); it wasn't restored.")
        elif isinstance(v, dict):
            for k2, v2 in v.items():
                walk(k2, where)
                walk(v2, f"{where}.{k2}" if where else str(k2))
        elif isinstance(v, list):
            for v2 in v:
                walk(v2, where)
    walk(s, "")
    return s


def alter_role_sql() -> str:
    """psql input (stdin, so psql interpolates): the password comes in as the variable pw (psql -v pw=…), quoted by
    psql as a literal — never pasted into the SQL text."""
    return "ALTER ROLE synapse WITH PASSWORD :'pw';\n"

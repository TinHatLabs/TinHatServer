"""Backups with restic: encrypted with the owner's backup password, deduplicated, verifiable.

What a backup holds (enough to bring the same server back on another computer):
  db.dump        the whole database (pg_dump), so messages, rooms, people, keys
  state/         the manager's state and secrets, the name's credentials, the chat server's config and signing key
                 (its identity), call and web server config, the home-network certificate authority's public root,
                 the API's data and (0.3.16) its Pad state (the person mutes: api/pad/state.json)
  media_store    files and pictures people uploaded (backed up straight from where they live)
  backup.json    what this is: server, version, when, how many people/rooms/messages
Not in it: certificates (re-issued), Docker images (the version's own), logs.

Where: a USB drive plugged into the server, or a shared folder on another computer or NAS (SMB). Nightly at 2:30 AM
(the owner's time, before the update window), keeping 7 daily and 4 weekly copies. "Download a backup" makes a
one-file copy (a restic repository with one snapshot, as a .tar) for the browser.
"""
import asyncio
import errno
import json
import logging
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import compose, config, dbcheck, restorecap, restoresafe, state, hw
from .updater import PAD_FILE, NotPlain, _pad_dir_fd, _read_nofollow, pad_problem  # noqa: F401 (install.py)

log = logging.getLogger("tinhat.backup")

DIR = config.STATE_DIR / "backups"
STATUS = DIR / "status.json"
STAGING = DIR / "staging"
MNT = Path("/mnt/tinhat-backup")
REPO_DIR = "TinHatBackups"
NIGHT_AT = (2, 30)  # owner's time
KEEP = ["--keep-daily", "7", "--keep-weekly", "4"]
# The manager's own state: small files; the signing key is the server's identity.
STATE_ITEMS = ["state.json", "secrets.json", "compose.env", "environment.json", "caddy/etc",
               "synapse/homeserver.yaml", "synapse/log.config", "synapse/signing.key", "livekit", "wellknown",
               # "ca": the public root only (+ the lab's bundles). NOT the home-network certificate authority's private key
               # (caddy/data/caddy/pki) since 0.3.8 (security review, server manager lows): whoever holds a backup could
               # issue certificates every device of the owner's trusts. A restored home-network server makes a new CA; each
               # device installs its certificate once (the restore says so; docs/LAUNCH-READINESS.md §2).
               "ca",
               # the Tin Hat API's own data: people's uploaded sounds, the games catalogue, push registrations, the Guests
               # room (guests.json: which room, on/off, its link) and its guest accounts, the game-servers config (its keys
               # come back from secrets.json; the clip cache is just a cache)
               "api/uploads", "api/games", "api/watch", "api/reports", "api/logs", "api/vapid.json", "api/push-owners.json",
               "api/guests.json", "api/guest-accounts.json", "api/gameservers.json", "api/pelican.key", "api/vods.secret"]
MEDIA = config.SYNAPSE_DIR / "media_store"
# People (not the box's own system account), rooms, messages. Synapse keeps `deactivated` as 0/1.
COUNT_SQL = ("SELECT (SELECT count(*) FROM users WHERE deactivated = 0 AND name NOT LIKE '@tinhat-system:%'), "
             "(SELECT count(*) FROM rooms), "
             "(SELECT count(*) FROM events WHERE type IN ('m.room.encrypted', 'm.room.message'))")


class BackupError(Exception):
    pass


# ---- status, settings -----------------------------------------------------------------------------------------------

def status() -> dict:
    return state.read_json(STATUS, {})


def set_status(**changes) -> dict:
    st = {**status(), **changes, "at": int(time.time())}
    state.write_json(STATUS, st, 0o600)
    return st


def settings() -> dict:
    """{dest: usb|smb|None, usb: {uuid, label}, smb: {share, user}} — the password lives in secrets.json."""
    return state.load_state().get("backups") or {}


def password() -> str | None:
    return state.load_secrets().get("backup_password")


# ---- running restic -------------------------------------------------------------------------------------------------

def restic_env(repo: str, pw: str) -> dict:
    return {**os.environ, "RESTIC_REPOSITORY": repo, "RESTIC_PASSWORD": pw, "RESTIC_CACHE_DIR": str(DIR / "cache"),
            "RESTIC_PROGRESS_FPS": "0.1"}


def restic(repo: str, pw: str, *args: str, timeout: float = 7200, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["restic", *args], env=restic_env(repo, pw), capture_output=True, text=True, timeout=timeout,
                          cwd=cwd)


def restore_capped(repo: str, pw: str, snap: str, target: Path, include: str | None = None,
                   timeout: float = 6 * 3600) -> subprocess.CompletedProcess:
    """`restic restore` of a snapshot (or only `include` in it) into target, bounded (restorecap, 0.3.16): the
    snapshot's own claim must fit this disk first, and restic is stopped once it writes more than it claimed.
    Raises restoresafe.UnsafeBackup (nothing it wrote is kept); restic's own failures come back as its result."""
    env = restic_env(repo, pw)
    # --no-cache: restic's cache (on this disk) would fill with whatever the repository's index holds before any of
    # this looks at it (review of the first draft); include: our own staging path, no pattern characters in it
    ls = ["restic", "--no-cache", "ls", "--json"] + (["--recursive", snap, include] if include else [snap])
    c = restorecap.read_claim(ls, env)
    target.mkdir(parents=True, exist_ok=True)
    restorecap.preflight(c, restorecap.disk(target))
    cmd = ["restic", "--no-cache", "restore", snap, "--target", str(target)] + (["--include", include] if include else [])
    return restorecap.run_capped(cmd, env, target, c, timeout)


def repo_exists(repo: str, pw: str) -> bool | None:
    """True: a repository we can open with this password; False: none there; None: one there, wrong password."""
    r = restic(repo, pw, "cat", "config", timeout=120)
    if r.returncode == 0:
        return True
    err = (r.stderr or "").lower()
    if "wrong password" in err or "no key found" in err:
        return None
    return False


def snapshots(repo: str, pw: str) -> list[dict]:
    r = restic(repo, pw, "snapshots", "--json", "--tag", "tinhat", timeout=300)
    if r.returncode != 0:
        raise BackupError(_why(r))
    out = []
    for s in json.loads(r.stdout or "[]"):
        out.append({"id": s["short_id"], "time": s["time"], "host": s.get("hostname"),
                    "summary": s.get("summary") or {}})
    return sorted(out, key=lambda s: s["time"], reverse=True)


def _why(r: subprocess.CompletedProcess) -> str:
    err = (r.stderr or r.stdout or "").strip().splitlines()
    return err[-1] if err else f"restic exited {r.returncode}"


# ---- destinations: USB drives, shared folders -----------------------------------------------------------------------

def drives() -> list[dict]:
    """Plugged-in USB drives with a filesystem we can write: [{dev, uuid, label, size, fstype, model}]."""
    r = subprocess.run(["lsblk", "-J", "-b", "-o", "NAME,PATH,TYPE,TRAN,HOTPLUG,SIZE,FSTYPE,LABEL,UUID,MODEL"],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return []
    out = []

    def walk(dev, usb: bool, model: str):
        usb = usb or dev.get("tran") == "usb" or bool(dev.get("hotplug"))
        model = dev.get("model") or model
        if usb and dev.get("fstype") in ("exfat", "vfat", "ntfs", "ext4", "btrfs", "xfs") and dev.get("uuid"):
            out.append({"dev": dev["path"], "uuid": dev["uuid"], "label": dev.get("label") or "", "size": dev["size"],
                        "fstype": dev["fstype"], "model": (model or "").strip()})
        for ch in dev.get("children") or []:
            walk(ch, usb, model)
    for d in json.loads(r.stdout).get("blockdevices", []):
        walk(d, False, "")
    return out


def mount_usb(uuid: str) -> Path:
    d = next((x for x in drives() if x["uuid"] == uuid), None)
    if d is None:
        raise BackupError("The backup drive isn't plugged in.")
    mp = MNT / f"usb-{uuid}"
    if os.path.ismount(mp):
        return mp
    mp.mkdir(parents=True, exist_ok=True)
    fstype = {"ntfs": "ntfs3"}.get(d["fstype"], d["fstype"])
    r = subprocess.run(["mount", "-t", fstype, "-o", "noatime", d["dev"], str(mp)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise BackupError(f"Couldn't open the drive ({r.stderr.strip() or r.returncode}).")
    return mp


def control_chars(*values: str) -> bool:
    return any(ord(c) < 32 or ord(c) == 127 for v in values for c in v)


def mount_smb(share: str, user: str, pw: str) -> Path:
    if control_chars(share, user, pw):  # the credentials file is "key=value" lines: a line break would add options
        raise BackupError("The shared folder, user name or password has a line break or control character in it.")
    mp = MNT / "smb"
    if os.path.ismount(mp):
        return mp
    mp.mkdir(parents=True, exist_ok=True)
    share = share.strip().replace("\\", "/")
    if not share.startswith("//"):
        share = "//" + share.lstrip("/")
    creds = DIR / "smb.credentials"
    state.write_text(creds, f"username={user}\npassword={pw}\n", 0o600)
    r = subprocess.run(["mount", "-t", "cifs", share, str(mp), "-o", f"credentials={creds},iocharset=utf8,noperm,vers=3.0"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise BackupError(f"Couldn't open the shared folder ({r.stderr.strip() or r.returncode}).")
    return mp


def unmount_all() -> None:
    if MNT.exists():
        for mp in MNT.iterdir():
            if os.path.ismount(mp):
                subprocess.run(["umount", str(mp)], capture_output=True, timeout=60)


def repo_for(server_name: str) -> str:
    """Mount the configured destination and return the restic repository path on it."""
    st, secrets_ = settings(), state.load_secrets()
    if st.get("dest") == "usb":
        root = mount_usb(st["usb"]["uuid"])
    elif st.get("dest") == "smb":
        root = mount_smb(st["smb"]["share"], st["smb"]["user"], secrets_.get("backup_smb_password", ""))
    else:
        raise BackupError("Choose where backups go first.")
    repo = root / REPO_DIR / server_name
    repo.parent.mkdir(parents=True, exist_ok=True)
    return str(repo)


# ---- making a backup ------------------------------------------------------------------------------------------------

async def counts() -> dict:
    """People, rooms and messages in the live database (shown with each backup; checked by Test restore)."""
    rc, out = await compose.run("exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "synapse", "-tAc", COUNT_SQL,
                                timeout=120)
    try:
        people, rooms, messages = (int(x) for x in out.strip().splitlines()[-1].split("|"))
        return {"people": people, "rooms": rooms, "messages": messages}
    except (ValueError, IndexError):
        return {}


async def prepare_staging() -> dict:
    shutil.rmtree(STAGING, ignore_errors=True)
    (STAGING / "state").mkdir(parents=True)
    os.chmod(STAGING, 0o700)
    with open(STAGING / "db.dump", "wb") as f:
        proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_dump", "-U", "synapse",
                                                    "-Fc", "synapse", stdout=f, stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), 3600)
    if proc.returncode != 0 or (STAGING / "db.dump").stat().st_size < 1024:
        raise BackupError(f"Copying the database failed ({(err or b'').decode(errors='replace').strip()[-200:]}).")
    for item in STATE_ITEMS:
        src = config.STATE_DIR / item
        if src.exists():
            dst = STAGING / "state" / item
            dst.parent.mkdir(parents=True, exist_ok=True)
            (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst)
    stage_pad(STAGING / "state")
    st = state.load_state()
    meta = {"server_name": st.get("server_name"), "mode": st.get("mode"), "version": config.VERSION,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "counts": await counts(),
            # where this computer is at home: a restore on another computer tells it to stand down (moved.py)
            "addresses": hw.addresses()}
    state.write_json(STAGING / "backup.json", meta, 0o600)
    return meta


def stage_pad(dest_state: Path) -> bool:
    """The Pad state (person mutes; 0.3.16, docs/RELEASING.md, Pad state) into a backup: ONE read of the file (the API
    only ever replaces it by rename, so the copy is whole), never following a link (the API's own folder: a link there
    must not copy another file of this computer into a backup); never its folder (the API's temp files). A restore takes
    it only when its own API loads it (install._restore_pad). False: there's none (or not a plain file)."""
    try:
        dfd = _pad_dir_fd(state=config.STATE_DIR)
        if dfd is None:
            return False
        try:
            pad = _read_nofollow("state.json", dfd)
        finally:
            os.close(dfd)
    except OSError as e:  # a link (left out on purpose) or a failed read (said in the log: the backup goes on)
        if not isinstance(e, NotPlain) and e.errno != errno.ELOOP:
            log.warning("backup: the Pad state couldn't be read (%s); this backup has no person mutes", e)
        return False
    if pad is None:
        return False
    copy = dest_state / PAD_FILE
    copy.parent.mkdir(parents=True, exist_ok=True)
    with open(os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
        f.write(pad)
    return True

async def run_backup(repo: str, pw: str, media: bool = True, prune: bool = True) -> dict:
    """One backup into `repo` (created if new). Returns {snapshot, size, counts}."""
    exists = await asyncio.to_thread(repo_exists, repo, pw)
    if exists is None:
        raise BackupError("There's already a Tin Hat backup there with a different password.")
    if exists is False:
        r = await asyncio.to_thread(restic, repo, pw, "init", timeout=300)
        if r.returncode != 0:
            raise BackupError(f"Couldn't start a backup there: {_why(r)}")
    meta = await prepare_staging()
    # Absolute paths, as they are on the server: a restore puts them back where they belong.
    args = ["backup", "--json", "--tag", "tinhat", "--host", meta["server_name"] or "tinhat", str(STAGING)]
    if media and MEDIA.exists():
        args.append(str(MEDIA))
    try:
        r = await asyncio.to_thread(restic, repo, pw, *args, timeout=6 * 3600)
    finally:
        shutil.rmtree(STAGING, ignore_errors=True)
    if r.returncode not in (0, 3):  # 3: some files couldn't be read (a file deleted mid-backup); the rest is saved
        raise BackupError(f"The backup didn't finish: {_why(r)}")
    summary = {}
    for line in (r.stdout or "").splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("message_type") == "summary":
            summary = j
    if prune:
        await asyncio.to_thread(restic, repo, pw, "forget", "--tag", "tinhat", *KEEP, "--prune", timeout=3 * 3600)
    return {"snapshot": summary.get("snapshot_id", "")[:8], "added": summary.get("data_added", 0),
            "total": summary.get("total_bytes_processed", 0), "counts": meta["counts"]}


async def backup_now(why: str = "by owner") -> dict:
    st = state.load_state()
    pw = password()
    if not pw:
        raise BackupError("Set a backup password first.")
    set_status(running=True, phase="running", message=None)
    try:
        repo = await asyncio.to_thread(repo_for, st["server_name"])
        res = await run_backup(repo, pw)
        snaps = await asyncio.to_thread(snapshots, repo, pw)
        return set_status(running=False, phase="ok", last={"at": int(time.time()), **res, "why": why},
                          copies=len(snaps), message=None)
    except (BackupError, OSError, subprocess.SubprocessError) as e:
        log.warning("backup failed: %s", e)
        return set_status(running=False, phase="failed", failed={"at": int(time.time()), "why": why}, message=str(e))
    finally:
        await asyncio.to_thread(unmount_all)


# ---- a one-file copy for the browser --------------------------------------------------------------------------------


async def download_file(media: bool) -> Path:
    """A fresh repository with one snapshot, as a .tar the browser downloads (encrypted with the backup password)."""
    pw = password()
    if not pw:
        raise BackupError("Set a backup password first.")
    st = state.load_state()
    work = Path(tempfile.mkdtemp(dir=DIR, prefix="download-"))
    repo = work / "repo"
    await run_backup(str(repo), pw, media=media, prune=False)
    stamp = owner_now().strftime("%Y-%m-%d-%H%M")  # the owner's date, as the dashboard shows it
    out = work / f"tinhat-backup-{(st.get('server_name') or 'server').split('.')[0]}-{stamp}.tar"
    with tarfile.open(out, "w") as t:
        t.add(repo, arcname=f"{REPO_DIR}/{st.get('server_name') or 'server'}")
    shutil.rmtree(repo, ignore_errors=True)
    return out


# ---- test restore ---------------------------------------------------------------------------------------------------

async def test_restore() -> dict:
    """Restore the newest backup into a throwaway database (dbcheck.isolated: no network, not as a superuser) and
    compare it with the live one."""
    st = state.load_state()
    pw = password()
    if not pw:
        raise BackupError("Set a backup password first.")
    work = Path(tempfile.mkdtemp(dir=DIR, prefix="test-"))
    try:
        repo = await asyncio.to_thread(repo_for, st["server_name"])
        snaps = await asyncio.to_thread(snapshots, repo, pw)
        if not snaps:
            raise BackupError("There's no backup to test yet.")
        try:  # bounded (restorecap): a Test restore runs on the live server's own disk
            r = await asyncio.to_thread(restore_capped, repo, pw, snaps[0]["id"], work, str(STAGING), 3600)
        except restoresafe.UnsafeBackup as e:
            raise BackupError(str(e))
        if r.returncode != 0:
            raise BackupError(f"Couldn't read the backup: {_why(r)}")
        # untrusted input (restoresafe), as in the setup's restore: no link or special file survives to be read below
        # (review 0.3.16: a signing.key linked to the live key or to /dev/zero)
        try:
            removed = await asyncio.to_thread(restoresafe.strip_specials, work)
        except restoresafe.UnsafeBackup as e:
            raise BackupError(str(e))
        if removed:
            log.warning("test restore: removed %d link(s)/special file(s) from the backup: %s", len(removed), ", ".join(removed[:20]))
        dump = next(work.rglob("db.dump"), None)
        meta = state.read_json(next(work.rglob("backup.json"), work / "none"), {})
        key = next(work.rglob("signing.key"), None)
        if dump is None or key is None:
            raise BackupError("The backup is missing the database or the server's signing key.")
        same_key = key.read_bytes() == (config.SYNAPSE_DIR / "signing.key").read_bytes()
        # the same isolated restore a real one uses (dbcheck, 0.3.16): no network, not as a superuser, checked
        try:
            checked = await dbcheck.isolated(dump, work / "dbcheck", st["server_name"], _postgres_image(),
                                             await dbcheck.synapse_schema_version(config.OPT / "compose.yaml"))
        except restoresafe.UnsafeBackup as e:
            raise BackupError(str(e))
        restored = checked.counts
        ok = same_key and restored == (meta.get("counts") or restored)
        res = {"at": int(time.time()), "ok": ok, "snapshot": snaps[0]["id"], "backup_time": snaps[0]["time"],
               "restored": restored, "in_backup": meta.get("counts"), "live": await counts(), "same_identity": same_key}
        set_status(test=res)
        return res
    finally:
        shutil.rmtree(work, ignore_errors=True)
        await asyncio.to_thread(unmount_all)


def _postgres_image() -> str:
    for line in (config.OPT / "compose.yaml").read_text().splitlines():
        if line.strip().startswith("image: postgres"):
            return line.split("image:", 1)[1].strip()
    return "postgres:17-alpine"


# ---- the nightly run ------------------------------------------------------------------------------------------------

def owner_now() -> datetime:
    tz = (state.load_state().get("updates") or {}).get("tz")
    try:
        return datetime.now(ZoneInfo(tz) if tz else timezone.utc)
    except (KeyError, ValueError):
        return datetime.now(timezone.utc)


def due() -> bool:
    """At 2:30 AM (the owner's time): a destination and a password are set, and tonight's backup hasn't run."""
    st = settings()
    if not st.get("dest") or not password() or status().get("running"):
        return False
    now = owner_now()
    if (now.hour, now.minute) < NIGHT_AT or now.hour >= NIGHT_AT[0] + 1:
        return False
    last = (status().get("last") or {}).get("at", 0)
    failed = (status().get("failed") or {}).get("at", 0)
    return time.time() - max(last, failed) > 20 * 3600


def find_servers(root: Path) -> list[str]:
    """Server names with a backup repository under root/TinHatBackups/."""
    base = root / REPO_DIR
    if not base.is_dir():
        return []
    return sorted(d.name for d in base.iterdir() if (d / "config").is_file())


#: the most read_from_snapshot takes (backup.json is a few hundred bytes; a backup's own file can say anything)
SMALL_FILE_MAX = 1024 * 1024


def read_from_snapshot(repo: str, pw: str, snap: str, rel: str) -> bytes | None:
    """One small file out of a snapshot (relative to the staging folder), e.g. backup.json; None when it isn't there
    or is bigger than SMALL_FILE_MAX (read as a stream and stopped there: never held whole in memory)."""
    return restorecap.read_capped(["restic", "--no-cache", "dump", snap, f"{STAGING}/{rel}"], restic_env(repo, pw),
                                  SMALL_FILE_MAX)


def cleanup_downloads(max_age: float = 3600) -> None:
    for d in DIR.glob("download-*"):
        if time.time() - d.stat().st_mtime > max_age:
            shutil.rmtree(d, ignore_errors=True)

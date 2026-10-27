"""Updates: a signed channel, checked daily. Installs at night when nobody is in a call, or right away when the owner
asks.

The channel (environment `updates_url`: one URL or several, e.g. GitHub's
https://github.com/OWNER/REPO/releases/latest/download/stable.json and then a mirror) is a small manifest signed with
minisign; the public keys this manager trusts are keys/*.pub. Every source must carry that signature, and the newest
signed version among them wins, so a mirror or an old copy can neither hand out anything we didn't sign nor hold a
server back. The manifest names one bundle (manager + pages, compose file, images.lock, Tin Hat Web) by URL (relative
to the manifest, or absolute: a GitHub release pins its own assets), sha256 and size, plus any of our own images that
can't be pulled from a registry. Applying is done by tinhat-update.service (updater.py), outside the manager's process, so the
manager itself can be replaced and the whole update rolled back if the new version doesn't come up healthy.
"""
import asyncio
import hashlib
import json
import logging
import shutil
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

import aiohttp

from . import config, environment, state

log = logging.getLogger("tinhat.updates")

DIR = config.STATE_DIR / "updates"
STATUS = DIR / "status.json"
HISTORY = DIR / "history.json"
MANIFEST = DIR / "manifest.json"
JOB = DIR / "job.json"
KEYS = Path(__file__).with_name("keys")
NIGHT = (3, 5)  # installs start between 3 and 5 AM, the owner's time
CHECK_EVERY = 24 * 3600
# GitHub answers release downloads with a content-security-policy header of about 9.2 KB (seen 2026-10-24); aiohttp's
# default limit is 8190 bytes per header line, so 0.3.0 and 0.3.1 never got a file from GitHub and kept updating only
# through the mirror. 64 KiB leaves room.
HEADER_LIMIT = 1 << 16
IMAGE_MAX = 2 << 30  # an image of our own without a size in its manifest (before 0.3.2): ~300 MB today


def _session(**timeout) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(**timeout), max_line_size=HEADER_LIMIT,
                                 max_field_size=HEADER_LIMIT)


# ---- versions, status ---------------------------------------------------------------------------------------------

def version_tuple(v: str) -> tuple:
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return (0,)


def newer(a: str, b: str) -> bool:
    return version_tuple(a) > version_tuple(b)


def status() -> dict:
    return state.read_json(STATUS, {"phase": "idle"})


def set_status(**changes) -> dict:
    st = {**status(), **changes, "at": int(time.time())}
    state.write_json(STATUS, st, 0o644)
    return st


def history() -> list:
    return state.read_json(HISTORY, [])


def settings() -> dict:
    u = state.load_state().get("updates") or {}
    return {"auto": u.get("auto", True), "tz": u.get("tz")}


def save_settings(**changes) -> dict:
    u = {**(state.load_state().get("updates") or {}), **changes}
    state.save_state(updates=u)
    return settings()


def doc() -> dict:
    """Everything the dashboard's Updates card shows."""
    st = status()
    return {"installed": config.VERSION, "status": st, "settings": settings(), "history": history()[-5:],
            "window": f"{NIGHT[0]}–{NIGHT[1]} AM",
            # the Docker Compose edition updates with a new image, not from here (compose_entry.py does the rest)
            "compose": config.compose_edition()}


# ---- the signed channel ---------------------------------------------------------------------------------------------

def verify(manifest: bytes, sig: bytes) -> bool:
    """True when one of our trusted keys signed exactly these bytes (minisign: Ed25519)."""
    with tempfile.TemporaryDirectory() as d:
        m, s = Path(d) / "manifest", Path(d) / "manifest.minisig"
        m.write_bytes(manifest)
        s.write_bytes(sig)
        for key in sorted(KEYS.glob("*.pub")):
            r = subprocess.run(["minisign", "-V", "-q", "-p", str(key), "-m", str(m), "-x", str(s)],
                               capture_output=True, timeout=30)
            if r.returncode == 0:
                return True
    return False


async def _get(session: aiohttp.ClientSession, url: str, limit: int = 1 << 20) -> bytes:
    async with session.get(url, ssl=environment.ssl_context()) as r:
        if r.status != 200:
            raise RuntimeError(f"{url}: HTTP {r.status}")
        # read() returns what has arrived so far, not the whole body: read to the end (a manifest that came in two
        # TLS records used to fail its signature check), never more than the limit
        body = bytearray()
        async for chunk in r.content.iter_chunked(1 << 16):
            body += chunk
            if len(body) > limit:
                raise RuntimeError(f"{url}: too big")
        return bytes(body)


def channel_urls() -> list[str]:
    """Where to ask, in order: `updates_url` is one URL, several separated by spaces, or a list."""
    v = environment.env()["updates_url"]
    return [u for u in (v.split() if isinstance(v, str) else map(str, v)) if u]


class Unsigned(Exception):
    pass


def pinned(url: str, version: str) -> str:
    """Where a manifest's files are, for the download that may come hours later (at night). The manifest names the
    bundle relative to itself (0.3.2), and GitHub's `latest` moves: by then it may be a newer release that lacks this
    version's bundle. So a manifest read at …/releases/latest/download/ counts as read at its tag (release.sh tags every
    release vVERSION). The mirror's and any other address stay as they are."""
    pre, sep, name = url.partition("/releases/latest/download/")
    if sep and pre.startswith("https://github.com/") and version and "/" not in name:
        return f"{pre}/releases/download/v{version}/{name}"
    return url


async def _signed(session: aiohttp.ClientSession, url: str) -> dict:
    """One source's manifest, once our signature checks out. A release that lands between the two requests (GitHub's
    "latest" moved on) looks like a bad signature, so a mismatch is fetched once more before it counts."""
    for _ in range(2):
        body = await _get(session, url)
        sig = await _get(session, url + ".minisig", 4096)
        if verify(body, sig):
            try:
                return json.loads(body)
            except ValueError:
                raise RuntimeError(f"{url}: not a manifest")
    raise Unsigned(url)


async def check() -> dict:
    """Ask the channel what's newest. Never downloads the bundle; only the small signed manifests."""
    found, unsigned = [], False
    async with _session(total=30) as s:
        for u in channel_urls():
            try:
                found.append((u, await _signed(s, u)))
            except Unsigned:
                log.warning("update check: %s: the manifest's signature didn't verify", u)
                unsigned = True
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError, RuntimeError, ValueError) as e:
                log.info("update check: %s: %s", u, e)
    if not found:
        if unsigned:
            return set_status(checked=int(time.time()),
                              check_error="The update service's answer wasn't signed by Tin Hat, so it was ignored.")
        return set_status(checked=int(time.time()), check_error="Couldn't reach the update service.")
    # the newest signed version; on a tie the first source in the list (max keeps the first of equals)
    url, m = max(found, key=lambda f: version_tuple(str(f[1].get("version", ""))))
    latest = str(m.get("version", ""))
    base = {"checked": int(time.time()), "check_error": None, "latest": latest}
    if not newer(latest, config.VERSION):
        return set_status(**base, phase="current", available=None, message=None)
    if config.manifest_images(m) is None and m.get("images") is not None:
        return set_status(**base, phase="current", available=None,
                          message=f"Tin Hat Server {latest} isn't out for this server's processor ({config.arch()}) yet.")
    if m.get("min_from") and newer(m["min_from"], config.VERSION):
        return set_status(**base, phase="blocked", available=None,
                          message=f"Tin Hat Server {latest} can't be installed straight from {config.VERSION}.")
    state.write_json(MANIFEST, {"url": url, "base": pinned(url, latest), "manifest": m}, 0o644)
    if status().get("phase") == "staged" and (status().get("available") or {}).get("version") == latest:
        return set_status(**base)
    return set_status(**base, phase="available", available={
        "version": latest, "notes": m.get("notes") or [], "security": bool(m.get("security")),
        "size": (m.get("bundle") or {}).get("size"), "published": m.get("published")})


async def download() -> Path:
    """Fetch the bundle the verified manifest names, check its sha256 and size, unpack it into updates/staged/."""
    saved = state.read_json(MANIFEST)
    if not saved:
        raise RuntimeError("No update to download.")
    m, url = saved["manifest"], saved.get("base") or saved["url"]  # a manifest saved by 0.3.1 has no base
    b = m["bundle"]
    ver = m["version"]
    dl = DIR / "download"
    dl.mkdir(parents=True, exist_ok=True)
    target = dl / Path(b["url"]).name
    set_status(phase="downloading", message=None)
    h, size = hashlib.sha256(), 0
    async with _session(total=1800, sock_read=120) as s:
        async with s.get(urljoin(url, b["url"]), ssl=environment.ssl_context()) as r:
            if r.status == 404:  # a newer release replaced it (the mirror keeps only the newest): check again soon
                set_status(checked=0)
                raise RuntimeError("bundle: no longer there (a newer release is out); checking again")
            if r.status != 200:
                raise RuntimeError(f"bundle: HTTP {r.status}")
            with open(target, "wb") as f:
                async for chunk in r.content.iter_chunked(1 << 16):
                    size += len(chunk)
                    if size > int(b["size"]) + 1:
                        raise RuntimeError("bundle: bigger than the manifest says")
                    h.update(chunk)
                    f.write(chunk)
        extras = []
        for ref, img in (config.manifest_images(m) or {}).items():  # our own images (tinhat/caddy), when missing here
            if subprocess.run(["docker", "image", "inspect", img["id"]], capture_output=True).returncode == 0:
                continue
            p = dl / Path(img["url"]).name
            # streamed to disk and hashed on the way (an image is ~300 MB: it used to be held in memory twice), never
            # more than the manifest's size (0.3.2+ manifests name it) or IMAGE_MAX
            cap, ih, got = int(img.get("size") or IMAGE_MAX), hashlib.sha256(), 0
            async with s.get(urljoin(url, img["url"]), ssl=environment.ssl_context()) as r:
                if r.status != 200:
                    raise RuntimeError(f"{ref}: HTTP {r.status}")
                with open(p, "wb") as f:
                    async for chunk in r.content.iter_chunked(1 << 16):
                        got += len(chunk)
                        if got > cap:
                            raise RuntimeError(f"{ref}: bigger than the manifest says")
                        ih.update(chunk)
                        f.write(chunk)
            if ih.hexdigest() != img["sha256"] or (img.get("size") and got != int(img["size"])):
                p.unlink(missing_ok=True)
                raise RuntimeError(f"{ref}: checksum mismatch")
            extras.append(p)
    if size != int(b["size"]) or h.hexdigest() != b["sha256"]:
        target.unlink(missing_ok=True)
        raise RuntimeError("bundle: checksum mismatch")
    staged = DIR / "staged" / ver
    shutil.rmtree(staged, ignore_errors=True)
    staged.mkdir(parents=True)
    with tarfile.open(target) as t:
        t.extractall(staged, filter="data")
    if (staged / "VERSION").read_text().strip() != ver:
        raise RuntimeError("bundle: its VERSION doesn't match the manifest")
    if extras:
        (staged / "images").mkdir(exist_ok=True)
        for p in extras:
            shutil.move(str(p), staged / "images" / p.name)
    target.unlink(missing_ok=True)
    set_status(phase="staged")
    return staged


def start_install(by: str) -> None:
    """Hand the staged release to tinhat-update.service. The installed manager runs it (a copy of it), so a broken new
    release can't break its own rollback."""
    if config.compose_edition():
        raise RuntimeError("This server runs as a Docker Compose app: update it with `docker compose pull && docker compose up -d` "
                           "where its compose file is. It installs the new version, checks it and goes back by itself if needed.")
    st = status()
    ver = (st.get("available") or {}).get("version")
    if st.get("phase") != "staged" or not ver:
        raise RuntimeError("Nothing is ready to install.")
    runner = DIR / "runner"
    shutil.rmtree(runner, ignore_errors=True)
    shutil.copytree(config.OPT / "manager", runner, ignore=shutil.ignore_patterns("__pycache__"))
    state.write_json(JOB, {"version": ver, "from": config.VERSION, "by": by, "at": int(time.time())}, 0o644)
    set_status(phase="installing", step="starting", message=None)
    subprocess.run(["systemctl", "start", "--no-block", "tinhat-update.service"], check=True, timeout=30)
    log.info("installing %s (%s)", ver, by)


# ---- when to do what (called by the manager's background loop) -----------------------------------------------------

def owner_hour() -> int:
    tz = settings().get("tz")
    try:
        return datetime.now(ZoneInfo(tz) if tz else timezone.utc).hour
    except (KeyError, ValueError):
        return datetime.now(timezone.utc).hour


def in_window() -> bool:
    return NIGHT[0] <= owner_hour() < NIGHT[1]


def wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower()
    except OSError:
        return False


def clear_stale_download() -> None:
    """At the manager's start. A download runs inside the manager, so a "downloading" the status still says now is left
    from before (a restart mid-download, or a check that didn't put the phase back): it would make tick() skip the daily
    check and the night install and refuse Install now for good (gates, 2026-10-26). Back to what is true."""
    st = status()
    if st.get("phase") == "downloading":
        set_status(phase="available" if st.get("available") else "current", step=None,
                   message="The download stopped when the manager restarted. Install now tries again."
                   if st.get("available") else None)
        log.info("update status: a stale \"downloading\" cleared at start")


async def tick(busy_call) -> None:  # the manager runs this as its own task (a download can take minutes)
    """Daily check; at night, install what's available (auto) and restart for a kernel security update, never while
    `busy_call()` says someone is in a call (it returns True, False, or None when it can't tell)."""
    st = status()
    if st.get("phase") in ("installing", "rolling-back", "downloading"):
        return
    if time.time() - (st.get("checked") or 0) > CHECK_EVERY:
        await check()
        st = status()
    if config.compose_edition():  # updates come with a new image; the check above still says what's out
        return
    if not settings()["auto"] or not in_window():
        return
    if st.get("phase") in ("available", "staged"):
        if await busy_call() is not False:
            return
        try:
            if st.get("phase") == "available":
                await download()
            start_install("automatic")
        except Exception as e:  # noqa: BLE001 — a failed night install must not stop the loop
            log.exception("automatic update")
            set_status(phase="available", message=f"The automatic update didn't start: {e}")
        return
    # The image restarts itself for kernel security updates; on the owner's own machine the system is theirs.
    if Path("/run/reboot-required").exists() and not wsl() and not config.own_machine():
        if await busy_call() is not False:
            return
        h = history()
        h.append({"at": int(time.time()), "kind": "restart", "result": "done",
                  "message": "Restarted at night to finish a security update for the operating system."})
        state.write_json(HISTORY, h[-50:], 0o644)
        log.info("restarting for a kernel security update")
        subprocess.run(["systemctl", "reboot"], timeout=30)

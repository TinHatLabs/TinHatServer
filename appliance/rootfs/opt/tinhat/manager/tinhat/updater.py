"""tinhat-update.service: install a staged update, check it comes up healthy, roll back if it doesn't.

Runs from updates/runner (a copy of the manager that was installed when the update started), never from the release
it installs. Order, so that a failure at any point leaves a working server:
  1. every new image is pulled (by digest) or loaded before anything stops: no internet → nothing changed;
  2. snapshot: the database (pg_dump), the generated configs and secrets, the current release's files;
  3. the manager stops, the new files go in, the new release's `after-update` runs (migrations, configs);
  4. every service is recreated and the manager starts;
  5. health check (database, chat, calls, web, the manager answering with the new version), up to 10 minutes;
  6. healthy → done (the last two safety copies are kept); not → everything from the snapshot goes back, the database included.
"""
import fcntl
import json
import platform
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

OPT = Path("/opt/tinhat")
# this processor's images.lock in a release bundle (config.lock_name; the updater runs without the package around it)
LOCK_NAME = "images.lock.arm64" if platform.machine().lower() in ("aarch64", "arm64") else "images.lock"
STATE = Path("/var/lib/tinhat")
DIR = STATE / "updates"
LOG = DIR / "update.log"
COMPOSE = ["docker", "compose", "--ansi", "never", "-p", "tinhat", "-f", str(OPT / "compose.yaml"),
           "--env-file", str(STATE / "compose.env")]
# What a snapshot keeps of the box's own state: small files only (people's uploads and the database files stay put;
# the database is dumped instead).
STATE_ITEMS = ["state.json", "secrets.json", "compose.env", "environment.json", "names.json", "caddy/etc",
               "synapse/homeserver.yaml", "synapse/log.config", "livekit", "wellknown", "ca"]
HEALTH_WAIT = 600


class SystemdManager:
    """How the updater stops and starts the manager: tinhat-manager.service (the image, install.sh)."""

    def stop(self) -> None:
        sh("systemctl", "stop", "tinhat-manager")

    def start(self) -> None:
        sh("systemctl", "start", "tinhat-manager")


class ProcessManager:
    """The Compose edition has no systemd: the container's entry (compose_entry.py) runs the updater itself, and the
    manager is a child process it starts for the health check and stops again before handing over."""

    def __init__(self):
        self.proc = None

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def start(self) -> None:
        self.stop()
        self.proc = subprocess.Popen([sys.executable, "-m", "tinhat"], cwd=str(OPT / "manager"))


MANAGER = SystemdManager()


def say(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)  # a brand-new machine (the Compose edition's first start)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def status(**changes) -> None:
    p = DIR / "status.json"
    try:
        st = json.loads(p.read_text())
    except (OSError, ValueError):
        st = {}
    st.update(changes, at=int(time.time()))
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=2, sort_keys=True) + "\n")
    tmp.replace(p)


def add_history(entry: dict) -> None:
    p = DIR / "history.json"
    try:
        h = json.loads(p.read_text())
    except (OSError, ValueError):
        h = []
    h.append({"at": int(time.time()), **entry})
    p.write_text(json.dumps(h[-50:], indent=2) + "\n")


def sh(*cmd, timeout: float = 600, stdin=None, stdout=None, cwd=None) -> subprocess.CompletedProcess:
    r = subprocess.run(list(cmd), stdin=stdin, stdout=stdout if stdout is not None else subprocess.PIPE,
                       stderr=subprocess.STDOUT if stdout is None else subprocess.PIPE, timeout=timeout, cwd=cwd)
    if r.returncode != 0:
        out = (r.stdout if stdout is None else r.stderr) or b""
        say(f"  {' '.join(map(str, cmd[:6]))}… exited {r.returncode}: {out.decode(errors='replace')[-600:]}")
    return r


# ---- images ----------------------------------------------------------------------------------------------------------

def _lab() -> bool:
    """A lab server (environment.json "lab": true, written only by the lab's own tools): images moved with
    docker save/load have no registry digest and the closed lab can't pull, so a present tag is used as it is."""
    try:
        return json.loads((STATE / "environment.json").read_text()).get("lab") is True
    except (OSError, ValueError):
        return False


def lock_entries(path: Path) -> list[tuple[str, str]]:
    """images.lock: `repo:tag sha256:…` per line (our own tinhat/* images list their image id instead)."""
    out = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("sha256:"):
            out.append((parts[0], parts[1]))
    return out


def present(ref: str) -> bool:
    return subprocess.run(["docker", "image", "inspect", ref], capture_output=True).returncode == 0


def image_id(ref: str) -> str | None:
    r = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", ref], capture_output=True, text=True)
    return r.stdout.strip() or None if r.returncode == 0 else None


def _local_id(lock: Path, ref: str, old: str, new: str) -> None:
    """Our own image as THIS machine's Docker names it, in the lock that gets installed: Docker's containerd image
    store (Docker 29, Ubuntu 24.04) gives a loaded image another id than the build machine's, so rollbacks retag by
    the local one."""
    lock.write_text("".join(f"{ref} {new}{l[len(ref) + 1 + len(old):]}\n" if l.startswith(f"{ref} {old}") else l + "\n"
                            for l in lock.read_text().splitlines()))


def compose_images(compose: Path) -> set[str]:
    """The images a compose file runs (`image: repo:tag` lines)."""
    try:
        return {l.split()[1] for l in compose.read_text().splitlines() if l.split()[:1] == ["image:"] and len(l.split()) > 1}
    except OSError:
        return set()


def fetch_images(lock: Path, staged: Path) -> bool:
    used = compose_images(staged / "compose.yaml")
    for ref, digest in lock_entries(lock):
        if used and ref not in used:  # older locks also listed the base image our Caddy is built from: never run
            continue
        repo = ref.rsplit(":", 1)[0]
        if repo.startswith("tinhat/"):
            if not present(digest):
                tars = sorted((staged / "images").glob("*.tar*")) if (staged / "images").exists() else []
                for t in tars:
                    if sh("docker", "load", "-i", str(t), timeout=900).returncode != 0:
                        say(f"  couldn't load {t.name}")
                        return False  # never fall back to whatever image happens to carry that tag
                if not present(digest):
                    # A store that names images its own way: the tarball was checked against the signed manifest,
                    # so the tag it brought is our image; note this machine's id for it.
                    local = image_id(ref) if tars else None
                    if not local:
                        say(f"  missing our image {ref} ({digest[:19]})")
                        return False
                    _local_id(lock, ref, digest, local)
                    digest = local
            sh("docker", "tag", digest, ref)
            continue
        pinned = f"{repo}@{digest}"
        if not present(pinned) and _lab() and present(ref):
            say(f"  lab: {ref} as loaded (the closed lab can't pull by digest)")
            continue
        if not present(pinned) and sh("docker", "pull", "-q", pinned, timeout=1800).returncode != 0:
            return False
        if sh("docker", "tag", pinned, ref).returncode != 0:
            return False
    return True


def retag(lock: Path) -> None:
    """Point every tag back at the image the given images.lock names (the old images are still on disk)."""
    for ref, digest in lock_entries(lock):
        repo = ref.rsplit(":", 1)[0]
        sh("docker", "tag", digest if repo.startswith("tinhat/") else f"{repo}@{digest}", ref)


# ---- files -----------------------------------------------------------------------------------------------------------

def replace_contents(src: Path, dst: Path) -> None:
    """Put src's contents into dst without replacing dst itself (Caddy's bind mount holds on to the directory)."""
    dst.mkdir(parents=True, exist_ok=True)
    for child in dst.iterdir():
        shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
    for child in src.iterdir():
        (shutil.copytree if child.is_dir() else shutil.copy2)(child, dst / child.name)


def snapshot(snap: Path) -> None:
    shutil.rmtree(snap, ignore_errors=True)
    (snap / "state").mkdir(parents=True)
    with open(snap / "db.dump", "wb") as f:
        r = sh(*COMPOSE, "exec", "-T", "postgres", "pg_dump", "-U", "synapse", "-Fc", "synapse", stdout=f, timeout=1800)
    if r.returncode != 0 or (snap / "db.dump").stat().st_size < 1024:
        raise RuntimeError("the database copy before the update failed")
    for item in STATE_ITEMS:
        src = STATE / item
        if src.exists():
            dst = snap / "state" / item
            dst.parent.mkdir(parents=True, exist_ok=True)
            (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst)
    for f in ("compose.yaml", "images.lock", "VERSION"):
        if (OPT / f).exists():
            shutil.copy2(OPT / f, snap / f)
    shutil.copytree(OPT / "web", snap / "web")


CLI = Path("/usr/local/sbin/tinhat")


def install_files(staged: Path, snap: Path) -> None:
    shutil.move(str(OPT / "manager"), str(snap / "manager"))
    shutil.copytree(staged / "manager", OPT / "manager")
    for f in ("compose.yaml", "VERSION"):
        shutil.copy2(staged / f, OPT / f)
    # this processor's images.lock (an arm64 server's comes as images.lock.arm64 in the bundle)
    shutil.copy2(staged / LOCK_NAME if (staged / LOCK_NAME).exists() else staged / "images.lock", OPT / "images.lock")
    replace_contents(staged / "web", OPT / "web")
    cli = staged / "host" / "usr" / "local" / "sbin" / "tinhat"
    if cli.exists():  # the `tinhat` command follows releases too (0.2.9+ bundles carry it)
        if CLI.exists():
            shutil.copy2(CLI, snap / "tinhat-cli")
        shutil.copy2(cli, CLI)
        CLI.chmod(0o755)


def restore_files(snap: Path) -> None:
    if (snap / "manager").exists():
        shutil.rmtree(OPT / "manager", ignore_errors=True)
        shutil.copytree(snap / "manager", OPT / "manager")
    for f in ("compose.yaml", "images.lock", "VERSION"):
        if (snap / f).exists():
            shutil.copy2(snap / f, OPT / f)
    if (snap / "web").exists():
        replace_contents(snap / "web", OPT / "web")
    if (snap / "tinhat-cli").exists():
        shutil.copy2(snap / "tinhat-cli", CLI)
    for item in STATE_ITEMS:
        src = snap / "state" / item
        if src.exists():
            dst = STATE / item
            if src.is_dir():
                shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
    sh("chown", "-R", "991:991", str(STATE / "synapse" / "homeserver.yaml"), str(STATE / "synapse" / "log.config"))


def restore_db(snap: Path) -> bool:
    sh(*COMPOSE, "stop", "synapse", timeout=180)
    sh(*COMPOSE, "up", "-d", "--no-build", "--pull", "never", "postgres", timeout=300)
    for _ in range(60):
        if sh(*COMPOSE, "exec", "-T", "postgres", "pg_isready", "-U", "synapse").returncode == 0:
            break
        time.sleep(2)
    psql = [*COMPOSE, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", "postgres", "-c"]
    if sh(*psql, "DROP DATABASE IF EXISTS synapse WITH (FORCE)").returncode != 0:
        return False
    if sh(*psql, "CREATE DATABASE synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0").returncode != 0:
        return False
    with open(snap / "db.dump", "rb") as f:
        # one transaction: all of it, or an empty database (and a failed restore that starts nothing, below)
        r = sh(*COMPOSE, "exec", "-T", "postgres", "pg_restore", "-U", "synapse", "-d", "synapse", "--no-owner",
               "--single-transaction", "--exit-on-error", stdin=f, timeout=3600)
    return r.returncode == 0


# ---- health ----------------------------------------------------------------------------------------------------------

def _http_ok(url: str, want: bytes | None = None) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            body = r.read(4096)
            return r.status == 200 and (want is None or want in body)
    except OSError:
        return False


def _tls_ok(server_name: str) -> bool:
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # the web server answering is what's checked here
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=5) as s, ctx.wrap_socket(s, server_hostname=server_name):
            return True
    except OSError:
        return False


def _proxy_only() -> bool:
    try:
        return (OPT / "PORTS").read_text().strip() == "proxy"
    except OSError:
        return False


def _manager_version() -> str | None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8090/admin/setup/status", timeout=5) as r:
            return json.loads(r.read()).get("version")
    except (OSError, ValueError):
        return None


def healthy(version: str, wait: float = HEALTH_WAIT) -> tuple[bool, list[str]]:
    st = json.loads((STATE / "state.json").read_text())
    calls = st.get("calls", True)
    sn = st.get("server_name") or "localhost"
    deadline = time.time() + wait
    bad: list[str] = []
    while time.time() < deadline:
        checks = {
            "database": sh("docker", "inspect", "-f", "{{.State.Health.Status}}", "tinhat-postgres-1").stdout.strip() == b"healthy",
            "chat server": _http_ok("http://127.0.0.1:8008/health", b"OK"),
            # behind a reverse proxy on this same machine there's no HTTPS of our own (install.sh --behind-proxy)
            "web server": True if _proxy_only() else _tls_ok(sn),
            "manager": _manager_version() == version,
        }
        if st.get("mode") == "domain" and (st.get("domain") or {}).get("provider") == "proxy":
            # behind the owner's reverse proxy: the plain port it sends everything to (owndomain.PROXY_PORT)
            checks["web server for your proxy"] = _http_ok("http://127.0.0.1:8080/_matrix/client/versions")
        checks["extras (Tin Hat API)"] = _http_ok("http://127.0.0.1:3001/health", b'"ok":true')
        checks["games catalogue"] = _http_ok("http://127.0.0.1:3003/health", b'"ok":true')
        if calls:
            checks["call server"] = _http_ok("http://127.0.0.1:7880/")
            checks["call sign-in"] = _http_ok("http://127.0.0.1:8070/healthz")
        bad = [k for k, ok in checks.items() if not ok]
        if not bad:
            return True, []
        time.sleep(5)
    return False, bad


# ---- the job ---------------------------------------------------------------------------------------------------------

def services_up() -> bool:
    return sh(*COMPOSE, "up", "-d", "--no-build", "--pull", "never", "--remove-orphans", "--force-recreate",
              timeout=900).returncode == 0


def rollback(snap: Path, ver: str, frm: str, why: str) -> int:
    status(phase="rolling-back", step="rollback", message=f"Tin Hat Server {ver} didn't come up healthy ({why}); "
                                                          f"going back to {frm}.")
    say(f"rolling back to {frm}: {why}")
    MANAGER.stop()
    restore_files(snap)
    retag(snap / "images.lock")
    db_ok = restore_db(snap)
    if db_ok:
        services_up()
    else:  # the database didn't come back: chat stays off (only the web server for the dashboard), never half a database
        sh(*COMPOSE, "stop", "synapse", "api", "games", "livekit", "lk-jwt", timeout=300)
        sh(*COMPOSE, "up", "-d", "--no-build", "--pull", "never", "caddy", timeout=300)
    MANAGER.start()
    ok, bad = healthy(frm, 300)
    msg = (f"Tin Hat Server {ver} didn't start properly ({why}), so the server went back to {frm} by itself. "
           "Messages sent during the few minutes of the update may be missing." if ok and db_ok else
           f"Tin Hat Server {ver} didn't start properly, and going back to {frm} didn't fully work either "
           f"({', '.join(bad) or 'database restore'}). Restore your latest backup, or ask for help.")
    status(phase="rolled-back" if ok and db_ok else "broken", step=None, message=msg)
    add_history({"kind": "update", "from": frm, "to": ver, "result": "rolled back" if ok and db_ok else "broken",
                 "message": msg})
    say(msg)
    return 1


def _fresh() -> bool:
    """Not set up yet: a new computer about to be set up, or about to restore a backup from a newer version."""
    try:
        return json.loads((STATE / "state.json").read_text()).get("phase") != "ready"
    except (OSError, ValueError):
        return True


def apply_fresh(staged: Path, snap: Path, ver: str, frm: str) -> int:
    """A computer that isn't set up yet has no database or chat to keep safe: the new files go in, the web server and
    the manager restart, and if the new manager doesn't answer the old files come back."""
    status(phase="installing", step="images", message=None)
    lock = staged / LOCK_NAME if (staged / LOCK_NAME).exists() else staged / "images.lock"
    if not fetch_images(lock, staged):
        retag(OPT / "images.lock")
        msg = "Couldn't download the new version's parts (no internet, or the image registry didn't answer). Nothing changed."
        status(phase="available", step=None, message=msg)
        say(msg)
        return 1
    status(step="switch")
    shutil.rmtree(snap, ignore_errors=True)
    snap.mkdir(parents=True)
    for f in ("compose.yaml", "images.lock", "VERSION"):
        if (OPT / f).exists():
            shutil.copy2(OPT / f, snap / f)
    shutil.copytree(OPT / "web", snap / "web")
    MANAGER.stop()
    try:
        install_files(staged, snap)
    except OSError as e:
        why = f"copying the new files failed: {e}"
    else:
        sh(*COMPOSE, "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "caddy", timeout=300)
        MANAGER.start()
        status(step="check")
        for _ in range(40):
            if _manager_version() == ver:
                msg = f"Updated to Tin Hat Server {ver}."
                status(phase="done", step=None, message=msg, available=None)
                add_history({"kind": "update", "from": frm, "to": ver, "result": "done", "message": msg})
                say(msg)
                shutil.rmtree(staged, ignore_errors=True)
                return 0
            time.sleep(3)
        why = "the new version's setup page didn't start"
    say(f"going back to {frm}: {why}")
    MANAGER.stop()
    restore_files(snap)
    retag(snap / "images.lock")
    sh(*COMPOSE, "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "caddy", timeout=300)
    MANAGER.start()
    msg = f"Tin Hat Server {ver} didn't start properly ({why}), so this computer stayed on {frm}."
    status(phase="rolled-back", step=None, message=msg)
    add_history({"kind": "update", "from": frm, "to": ver, "result": "rolled back", "message": msg})
    say(msg)
    return 1


def apply() -> int:
    job = json.loads((DIR / "job.json").read_text())
    ver, frm = job["version"], job["from"]
    staged = DIR / "staged" / ver
    snap = DIR / "snapshots" / f"{frm}-to-{ver}"
    say(f"update {frm} → {ver} ({job.get('by', '?')})")
    if _fresh():
        return apply_fresh(staged, snap, ver, frm)

    status(phase="installing", step="images", message=None)
    lock = staged / LOCK_NAME if (staged / LOCK_NAME).exists() else staged / "images.lock"
    if not fetch_images(lock, staged):
        retag(OPT / "images.lock")
        msg = "Couldn't download the new version's parts (no internet, or the image registry didn't answer). Nothing changed."
        status(phase="available", step=None, message=msg)
        add_history({"kind": "update", "from": frm, "to": ver, "result": "not started", "message": msg})
        say(msg)
        return 1

    status(step="snapshot")
    try:
        snapshot(snap)
    except (RuntimeError, OSError) as e:
        retag(OPT / "images.lock")
        msg = f"Couldn't make the safety copy before updating ({e}). Nothing changed."
        status(phase="available", step=None, message=msg)
        add_history({"kind": "update", "from": frm, "to": ver, "result": "not started", "message": msg})
        say(msg)
        return 1

    status(step="switch")
    MANAGER.stop()
    try:
        install_files(staged, snap)
    except OSError as e:
        return rollback(snap, ver, frm, f"copying the new files failed: {e}")
    r = sh(sys.executable, "-m", "tinhat", "after-update", cwd=str(OPT / "manager"), timeout=600)
    say("  " + (r.stdout or b"").decode(errors="replace").strip()[-400:])
    if r.returncode != 0:
        return rollback(snap, ver, frm, "its configuration step failed")

    status(step="restart")
    if not services_up():
        return rollback(snap, ver, frm, "its services didn't start")
    MANAGER.start()

    status(step="check")
    ok, bad = healthy(ver)
    if not ok:
        return rollback(snap, ver, frm, "not answering: " + ", ".join(bad))

    msg = f"Updated to Tin Hat Server {ver}."
    status(phase="done", step=None, message=msg, available=None)
    add_history({"kind": "update", "from": frm, "to": ver, "result": "done", "message": msg})
    say(msg)
    shutil.rmtree(staged, ignore_errors=True)
    snaps = sorted((DIR / "snapshots").iterdir(), key=lambda p: p.stat().st_mtime)
    for old in snaps[:-2]:  # keep the last two safety copies
        shutil.rmtree(old, ignore_errors=True)
    return 0


LOCK = DIR / ".update.lock"  # in the server's own state: every updater on this machine (a service, a container) sees it


def locked_apply() -> int:
    """apply() under the one update lock, with whatever goes wrong left as a readable status."""
    DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            say("another update is already running")
            return 1
        try:
            return apply()
        except Exception as e:  # noqa: BLE001 — leave a readable status whatever happened
            say(f"update failed unexpectedly: {e!r}")
            status(phase="broken", step=None, message=f"The update stopped unexpectedly ({e}). Check the server, or "
                                                      "restore your latest backup.")
            return 1


def main() -> int:
    if sys.argv[1:2] != ["apply"]:
        print("usage: python3 -m tinhat.updater apply", file=sys.stderr)
        return 2
    return locked_apply()


if __name__ == "__main__":
    sys.exit(main())

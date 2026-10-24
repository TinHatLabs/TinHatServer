"""The Docker Compose edition's entry (`python3 -m tinhat.compose_entry`, the tinhat/server image's command).

The image carries a whole release (/usr/share/tinhat/release: manager/, compose.yaml, VERSION, images.lock[.arm64],
web/, our own images' tarballs in images/) and the tools (docker CLI + compose plugin, minisign, restic). The person's
compose file runs it with the Docker socket and /var/lib/tinhat + /opt/tinhat at the same paths inside and outside,
so the stack's own compose file (which names host paths) means the same thing to the host's Docker.

Each start:
  1. /opt/tinhat/EDITION = compose (+ PORTS = proxy with TINHAT_BEHIND_PROXY=1, like install.sh --behind-proxy);
  2. nothing installed yet: the release goes into /opt/tinhat, our images are loaded, the others pulled by digest;
  3. an older release installed: the same update the other editions run (updater.apply: images, a safety copy of the
     database and configs, the new files, after-update, the services, a health check, back to the old release by
     itself if it isn't healthy) — with the manager run as a child process instead of a systemd service;
  4. then the manager runs as this container's main process, from /opt/tinhat/manager (the installed release, so a
     rollback runs the old code). On a fresh server the setup code and address go to the log (`docker logs`).
"""
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

REL = Path(os.environ.get("TINHAT_RELEASE", "/usr/share/tinhat/release"))
OPT = Path("/opt/tinhat")
STATE = Path("/var/lib/tinhat")
LOCK_NAME = "images.lock.arm64" if platform.machine().lower() in ("aarch64", "arm64") else "images.lock"


def say(msg: str) -> None:
    print(f"[tinhat] {msg}", flush=True)


def version(p: Path) -> str | None:
    try:
        return (p / "VERSION").read_text().strip() or None
    except OSError:
        return None


def updater_phase() -> str:
    try:
        return json.loads((STATE / "updates" / "status.json").read_text()).get("phase", "")
    except (OSError, ValueError):
        return ""


def mark_edition() -> str:
    """Mark this machine's release as the Compose edition; returns the edition it was before ("" when none)."""
    OPT.mkdir(parents=True, exist_ok=True)
    try:
        before = (OPT / "EDITION").read_text().strip()
    except OSError:
        before = ""
    (OPT / "EDITION").write_text("compose\n")
    behind = os.environ.get("TINHAT_BEHIND_PROXY", "").strip().lower() in ("1", "true", "yes")
    if behind:
        (OPT / "PORTS").write_text("proxy\n")
    elif (OPT / "PORTS").exists():
        (OPT / "PORTS").unlink()
    return before


PORTS_TCP, PORTS_UDP = (80, 443, 7880, 7881, 8008, 8070, 8090, 3001, 3003), (7882,)


def _listening(proto: str, port: int) -> bool:
    r = subprocess.run(["ss", "-Hln" + proto, f"sport = :{port}"], capture_output=True, text=True)
    return r.returncode == 0 and bool(r.stdout.strip())


def _proxy_here() -> bool:
    """Something answers on 443 where the parts will look for it: every address, or this machine's own (the one its
    name leads to in proxy mode, templates._self_ip). Unknown (no ss) counts as yes: it's only a warning."""
    from tinhat import hw
    me = (hw.addresses() or [""])[0]
    try:
        r = subprocess.run(["ss", "-Hltn", "sport = :443"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return True
    for line in r.stdout.splitlines():
        f = line.split()
        if len(f) >= 4 and f[3].rsplit(":", 1)[0] in ("0.0.0.0", "*", "[::]", me):
            return True
    return False


def ports_busy() -> list[str]:
    """What already listens on the ports this server needs (on this machine: the container shares its network)."""
    want_tcp = [p for p in PORTS_TCP if p not in (80, 443)] + ([8080] if (OPT / "PORTS").exists() else [80, 443])
    return [f"{'TCP' if proto == 't' else 'UDP'} {port}"
            for proto, ports in (("t", want_tcp), ("u", PORTS_UDP)) for port in ports if _listening(proto, port)]


def fresh_install() -> None:
    """Nothing installed (or nothing set up yet): our release's files into /opt/tinhat, its images into Docker."""
    from tinhat import updater
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    updater.DIR.mkdir(parents=True, exist_ok=True)
    lock = REL / LOCK_NAME if (REL / LOCK_NAME).exists() else REL / "images.lock"
    tmp_lock = Path("/tmp/images.lock")
    shutil.copy2(lock, tmp_lock)
    if not updater.fetch_images(tmp_lock, REL):
        say("couldn't get the container images (is this machine online?); retrying in 30 s")
        time.sleep(30)
        sys.exit(1)  # the restart policy brings us back
    if (OPT / "manager").exists():
        shutil.rmtree(OPT / "manager")
    shutil.copytree(REL / "manager", OPT / "manager")
    # the web app's folder is the web server's bind mount: replace what's in it, never the folder itself
    updater.replace_contents(REL / "web", OPT / "web")
    for f in ("compose.yaml", "VERSION"):
        shutil.copy2(REL / f, OPT / f)
    shutil.copy2(tmp_lock, OPT / "images.lock")  # with this machine's ids for our own images
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    say(f"Tin Hat Server {version(REL)} installed")


def upgrade(frm: str, to: str) -> int:
    """The other editions' update, run from here (updater.apply with a child-process manager)."""
    from tinhat import updater
    updater.MANAGER = updater.ProcessManager()
    staged = updater.DIR / "staged" / to
    shutil.rmtree(staged, ignore_errors=True)
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REL, staged, symlinks=True)
    updater.DIR.mkdir(parents=True, exist_ok=True)
    (updater.DIR / "job.json").write_text(json.dumps({"version": to, "from": frm, "by": "a new image", "at": int(time.time())}))
    updater.status(phase="installing", step="starting", message=None)
    try:
        rc = updater.locked_apply()  # the one update lock (shared with any other updater on this machine) + error status
    finally:
        updater.MANAGER.stop()  # the manager is started again below, as this container's main process
    return rc


def adopt_existing() -> None:
    """A set-up server's data with no installed release: a safety copy of its database and settings, then its
    configs written by this release (migrations included). Without the safety copy nothing is changed."""
    from tinhat import updater
    subprocess.run([*updater.COMPOSE, "up", "-d", "--no-build", "--pull", "never", "postgres"], capture_output=True)
    for _ in range(60):
        if subprocess.run([*updater.COMPOSE, "exec", "-T", "postgres", "pg_isready", "-U", "synapse"], capture_output=True).returncode == 0:
            break
        time.sleep(2)
    snap = updater.DIR / "snapshots" / f"adopted-{time.strftime('%Y%m%d-%H%M%S')}"
    try:
        updater.snapshot(snap)
    except (RuntimeError, OSError) as e:
        say(f"this machine already holds a set-up server, but its safety copy failed ({e}); nothing was changed. "
            "Start the stack once more, or ask for help.")
        return
    r = subprocess.run([sys.executable, "-m", "tinhat", "after-update"], cwd=str(OPT / "manager"))
    say(f"this machine's server data was already set up: its configs were written again (safety copy: {snap})"
        if r.returncode == 0 else f"writing the existing server's configs failed (see above); safety copy: {snap}")


def _flag() -> dict:
    try:
        return json.loads((STATE / "updates" / "compose-failed").read_text())
    except (OSError, ValueError):
        return {}


def _set_flag(value: dict | None) -> None:
    f = STATE / "updates" / "compose-failed"
    if value is None:
        f.unlink(missing_ok=True)
    else:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(value))
        tmp.replace(f)


def _ready() -> bool:
    try:
        return json.loads((STATE / "state.json").read_text()).get("phase") == "ready"
    except (OSError, ValueError):
        return False


def print_setup_hint() -> None:
    try:
        st = json.loads((STATE / "state.json").read_text())
    except (OSError, ValueError):
        st = {}
    if st.get("phase") == "ready":
        return
    for _ in range(60):  # the manager writes the code when it starts; this runs just before, so look a moment later
        code = STATE / "setup-code"
        if code.exists() and code.read_text().strip():
            break
        time.sleep(1)
    try:
        code = (STATE / "setup-code").read_text().strip()
    except OSError:
        return
    from tinhat import hw
    port = ":8080" if (OPT / "PORTS").exists() else ""
    addrs = [a for a in hw.addresses() if ":" not in a][:3]
    say("Set up Tin Hat Server in a browser: " + ", ".join(f"http://{a}{port}/" for a in addrs))
    say(f"Setup code: {code}   (again later: docker exec tinhat-manager tinhat setup-code)")


def main() -> int:
    if not Path("/var/run/docker.sock").exists():
        say("the Docker socket isn't mounted: add /var/run/docker.sock:/var/run/docker.sock to the compose file")
        return 1
    before = mark_edition()
    if (OPT / "PORTS").exists() and not _proxy_here():
        # Behind a proxy, the parts check sign-ins at https://<name>, which leads to this machine: the proxy must be
        # here (another container on this host is fine). Not refused: it may simply start after this one.
        say("TINHAT_BEHIND_PROXY=1, but nothing on this machine answers on port 443 yet. It's for a reverse proxy on "
            "THIS machine (or in a container on it): calls can't sign in without it. If your proxy runs on another "
            "computer, leave TINHAT_BEHIND_PROXY out and choose My own domain → My own reverse proxy at setup.")
    to, frm = version(REL), version(OPT)
    if frm is not None and frm == to and before not in ("compose", "") and _ready():
        say(f"this machine's server ran as the {before} edition: taking it over")
        adopt_existing()  # a safety copy, then this edition's configs
    if frm is None:
        if not (STATE / "state.json").exists() and (busy := ports_busy()):
            say("these ports are already in use on this machine: " + ", ".join(busy) + ". Tin Hat Server needs them "
                "(behind your own reverse proxy: TINHAT_BEHIND_PROXY=1 in .env). Trying again in a minute.")
            time.sleep(60)
            return 1
        fresh_install()
        if _ready():  # a server's data was already here (moved from install.sh, or /opt/tinhat was deleted)
            adopt_existing()
    elif frm != to:
        ready = _ready()
        flag = _flag()
        retry = os.environ.get("TINHAT_RETRY_UPDATE", "").strip() in ("1", "true", "yes")
        if ready and flag.get("version") == to and not (retry and not flag.get("retried")):
            say(f"{to} didn't start properly here before, so this server stays on {frm}. "
                + ("It was already tried again once; wait for a newer version, or ask for help."
                   if flag.get("retried") else "To try it once more: TINHAT_RETRY_UPDATE=1 docker compose up -d"))
        elif ready:
            if flag.get("version") == to:
                _set_flag({**flag, "retried": True})  # one retry per request, even if this start is cut short
            say(f"updating {frm} → {to}")
            rc = upgrade(frm, to)
            phase = updater_phase()
            if rc == 0:
                _set_flag(None)
            elif phase in ("rolled-back", "broken"):  # it really didn't run: remember that version
                _set_flag({"version": to, "retried": flag.get("version") == to, "phase": phase})
            # else: it never started (no internet, the safety copy failed): nothing to remember, the next start tries
            say("updated" if rc == 0 else f"the update to {to} didn't work out; still running {version(OPT)} (see the dashboard)")
        else:
            fresh_install()
    cli = REL / "host" / "usr" / "local" / "sbin" / "tinhat"
    if cli.exists() and version(OPT) == to:  # after a rollback the old release's command (restored) stays
        shutil.copy2(cli, "/usr/local/sbin/tinhat")
        os.chmod("/usr/local/sbin/tinhat", 0o755)
    os.chdir(OPT / "manager")
    if os.fork() == 0:  # the hint waits for the manager's first start; the manager itself takes this process
        try:
            print_setup_hint()
        finally:
            os._exit(0)
    os.execv(sys.executable, [sys.executable, "-m", "tinhat"])
    return 0


if __name__ == "__main__":
    sys.exit(main())

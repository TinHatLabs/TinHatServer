"""Keep the setup address working after setup.

People set the server up at http://tinhat.local. At the end the box renames itself to <name>.local (the name in every
link, certificate and account), and a browser that restarts to pick up the certificate would otherwise find
tinhat.local gone. So once the server is set up, the manager also publishes tinhat.local as an extra mDNS name for the
box's current address (avahi-publish), where the welcome page answers. If another box on the network already uses
tinhat.local, avahi-publish fails and nothing else changes.
"""
import asyncio
import logging
import socket
import subprocess
import time

from . import config, hw, state

log = logging.getLogger("tinhat.mdns")
ALIAS = "tinhat.local"
_proc: asyncio.subprocess.Process | None = None
_want: tuple[str, str] | None = None
_missing = False  # no avahi on this machine (an own Linux machine may not have it): stop trying
_started = 0.0
_backoff_until = 0.0  # the name is taken on this network (the publisher quit at once): try again after this


async def _stop() -> None:
    global _proc
    if _proc and _proc.returncode is None:
        _proc.terminate()
        try:
            await asyncio.wait_for(_proc.wait(), 5)
        except asyncio.TimeoutError:
            _proc.kill()
    _proc = None


def _when(v) -> float:
    """A time from state: seconds, or an ISO date (installed_at)."""
    if isinstance(v, (int, float)):
        return float(v)
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(v)).timestamp() if v else 0.0
    except ValueError:
        return 0.0


def own_name() -> str | None:
    """The .local name avahi really holds for this box: tinhat-2.local when another box had tinhat.local first."""
    try:
        r = subprocess.run(["busctl", "call", "org.freedesktop.Avahi", "/", "org.freedesktop.Avahi.Server",
                            "GetHostNameFqdn"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0 and '"' in r.stdout:
            return r.stdout.split('"')[1] or None
    except (OSError, subprocess.SubprocessError):
        pass
    return None


_released = False
_reclaim_at = 0.0


async def release_name() -> None:
    """This server moved to another computer: free its home-network name (<name>.local) for the new one at once. The
    image's hostname is ours to rename; on someone's own machine the name is theirs, so only our extra name stops."""
    global _released
    _released = True
    await _stop()
    if not config.own_machine():
        host = socket.gethostname()
        try:
            subprocess.run(["avahi-set-host-name", f"{host}-moved"], capture_output=True, timeout=5)
            log.info("home-network name %s.local let go (now %s-moved.local)", host, host)
        except (OSError, subprocess.SubprocessError) as e:
            log.warning("avahi-set-host-name: %s", e)


def reclaim_name(ready: bool) -> None:
    """After a move the new computer may have ended up as <name>-2.local (the old one still held the name). Once the
    old one lets go, take the real name back: try every 2 minutes, and every 15 while another box still holds it."""
    global _reclaim_at
    if _released or not ready or config.own_machine() or time.time() < _reclaim_at:
        return
    host = socket.gethostname()
    have = own_name()
    if not have or have.lower() == f"{host}.local".lower():
        return
    try:
        r = subprocess.run(["avahi-set-host-name", host], capture_output=True, timeout=5)
        log.info("home-network name was %s; asked for %s.local again (%s)", have, host, r.returncode)
    except (OSError, subprocess.SubprocessError):
        pass
    _reclaim_at = time.time() + (900 if have.lower().startswith(f"{host}-".lower()) else 120)


async def keep_setup_alias(ready: bool) -> None:
    """The image: tinhat.local after setup (the box renamed itself). The owner's own Linux machine keeps its name, so
    a home-network server's own name (<name>.local) is the extra mDNS name there."""
    global _proc, _want, _missing, _started, _backoff_until
    if _missing or _released:
        return
    addrs = hw.addresses()
    if config.own_machine():
        st = state.load_state()
        sn = st.get("server_name") or ""
        if st.get("mode") != "lan":  # moved to its own domain (move.py): its old home-network name keeps answering
            sn = next((f["name"] for f in reversed(st.get("former_names") or []) if isinstance(f, dict)
                       and f.get("mode") == "lan" and not f.get("released")
                       and str(f.get("name", "")).endswith(".local")), "")
        want = (sn, addrs[0]) if ready and addrs and sn.endswith(".local") else None
    else:
        # Only for the first day after setup (or a restore): long enough for a browser that restarted after trusting
        # the certificate, and then tinhat.local is free again for the next new box on the network (round 6: a
        # restore on a new computer showed tinhat.local, which still led to the old one).
        st = state.load_state()
        since = max(_when(st.get("installed_at")), _when((st.get("restored_from") or {}).get("at")))
        fresh = time.time() - since < 86400
        want = (ALIAS, addrs[0]) if ready and fresh and addrs and socket.gethostname() != "tinhat" else None
    running = _proc is not None and _proc.returncode is None
    if want == _want and (want is None or running):
        return
    if want is not None and want == _want:  # it stopped: right after starting means another box has the name
        if time.time() < _backoff_until:
            return
        if time.time() - _started < 60:
            _backoff_until = time.time() + 900
            log.info("%s is taken on this network; trying again in 15 minutes", want[0])
            return
    await _stop()
    _want = want
    if want:
        try:
            _proc = await asyncio.create_subprocess_exec("avahi-publish", "-a", "-R", *want,
                                                         stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            _started = time.time()
            log.info("publishing %s → %s", *want)
        except OSError as e:
            log.warning("avahi-publish unavailable: %s", e)
            _missing = True

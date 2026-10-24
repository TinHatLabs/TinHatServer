"""The Tin Hat relay, on the box (docs/RELAY.md).

For homes whose internet provider shares one public address between many homes ("carrier NAT": T-Mobile and Verizon
5G home internet, Starlink), so nothing from outside can reach the server. The box opens an outbound WireGuard tunnel
to a Tin Hat relay (a keepalive every 25 s holds the carrier's NAT open). The relay:
  * passes HTTPS to this box by its name without decrypting it (the certificate and its key never leave the box), with
    a PROXY header that tells Caddy the friend's real address (accepted only from the relay's tunnel address);
  * forwards one port of its own, TCP and UDP, into the tunnel for calls. LiveKit listens on that port number and
    announces the relay's address to callers outside; people at home still reach it directly (advertise_internal_ip).
The names service hands out the place (relay endpoint + key, tunnel address, port) and points the name at the relay.

The tunnel is systemd-networkd's (60-tinhat-relay.netdev/.network), so it comes back at boot by itself, before the
call server starts. Its address is a /32 with one route (to the relay), and nothing arriving through it is forwarded.
"""
import asyncio
import base64
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from . import compose, config, environment, names, state, templates

log = logging.getLogger("tinhat.relay")

IFACE = "wg-tinhat"
NETDIR = Path(os.environ.get("TINHAT_NETWORKD_DIR", "/etc/systemd/network"))
KEY_FILE = NETDIR / "tinhat-relay.key"
NETDEV = NETDIR / "60-tinhat-relay.netdev"
NETWORK = NETDIR / "60-tinhat-relay.network"
KEEPALIVE = 25
HANDSHAKE_STALE = 180  # WireGuard re-handshakes every 2 minutes while anything flows (the keepalive counts)

_lock = asyncio.Lock()


class RelayError(Exception):
    def __init__(self, msg: str, code: str = ""):
        super().__init__(msg)
        self.code = code


# ---- WireGuard keys (X25519, RFC 7748): no wireguard-tools needed ------------------------------------------------

_P = 2 ** 255 - 19


def _x25519(k: bytes, u: bytes) -> bytes:
    """Scalar multiplication on Curve25519, straight from RFC 7748 section 5 (tests/test_relay.py has its vectors)."""
    kb = bytearray(k)
    kb[0] &= 248
    kb[31] &= 127
    kb[31] |= 64
    n = int.from_bytes(kb, "little")
    x1 = int.from_bytes(u, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        bit = (n >> t) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b = (x2 + z2) % _P, (x2 - z2) % _P
        aa, bb = a * a % _P, b * b % _P
        e = (aa - bb) % _P
        c, d = (x3 + z3) % _P, (x3 - z3) % _P
        da, cb = d * a % _P, c * b % _P
        x3, z3 = (da + cb) ** 2 % _P, x1 * (da - cb) ** 2 % _P
        x2, z2 = aa * bb % _P, e * (aa + 121665 * e) % _P
    if swap:
        x2, z2 = x3, z3
    return (x2 * pow(z2, _P - 2, _P) % _P).to_bytes(32, "little")


def public_key(private_b64: str) -> str:
    return base64.b64encode(_x25519(base64.b64decode(private_b64), (9).to_bytes(32, "little"))).decode()


def new_private_key() -> str:
    k = bytearray(os.urandom(32))
    k[0] &= 248
    k[31] = (k[31] & 127) | 64
    return base64.b64encode(bytes(k)).decode()


def keypair() -> tuple[str, str]:
    """The box's tunnel key, made once and kept with its other secrets."""
    s = state.load_secrets()
    priv = s.get("relay_key")
    if not priv:
        priv = new_private_key()
        state.save_secrets(relay_key=priv)
    return priv, public_key(priv)


# ---- what other parts ask -----------------------------------------------------------------------------------------

def info() -> dict:
    return state.load_state().get("relay") or {}


def on() -> bool:
    return bool(info().get("on"))


def call_ports() -> tuple[int, int]:
    """(TCP, UDP) the call server listens on: the relay's port for this box while relayed, else 7881 / 7882."""
    r = info()
    if r.get("on") and r.get("ports"):
        return int(r["ports"]["tcp"]), int(r["ports"]["udp"])
    return 7881, 7882


def proxy_from() -> str | None:
    """The one address Caddy takes a PROXY header from: the relay's end of the tunnel."""
    r = info()
    return r["relay"]["tunnel_ip"] if r.get("on") and r.get("relay") else None


def livekit_yaml(s: dict, public_ip: str | None) -> str:
    """The call server's settings: while relayed it listens on the relay's port and announces the relay's address."""
    r = info()
    if r.get("on") and r.get("relay"):
        tcp, udp = call_ports()
        return templates.livekit_yaml(s, public_ip=r["relay"]["public_ip"], tcp_port=tcp, udp_port=udp)
    return templates.livekit_yaml(s, public_ip=public_ip)


# ---- the tunnel (systemd-networkd) --------------------------------------------------------------------------------

def _run(*args: str, timeout: float = 20) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), capture_output=True, text=True, timeout=timeout)


def _files(doc: dict) -> dict[Path, str]:
    peer = doc["relay"]
    head = "# Tin Hat Server: the tunnel to the Tin Hat relay. Written by the manager (relay.py); docs/RELAY.md.\n"
    netdev = (head + "[NetDev]\nName=%s\nKind=wireguard\nMTUBytes=1420\n\n[WireGuard]\nPrivateKeyFile=%s\n\n"
              "[WireGuardPeer]\nPublicKey=%s\nEndpoint=%s\n# Only the relay's own tunnel address comes in through it.\n"
              "AllowedIPs=%s/32\nPersistentKeepalive=%d\n") % (IFACE, KEY_FILE, peer["public_key"], peer["endpoint"],
                                                               peer["tunnel_ip"], KEEPALIVE)
    network = (head + "[Match]\nName=%s\n\n[Network]\nAddress=%s/32\nLinkLocalAddressing=no\n"
               "# Nothing that arrives through the tunnel is passed on (to the home network or the containers).\n"
               "IPv4Forwarding=no\n\n[Route]\nDestination=%s/32\n\n[Link]\nRequiredForOnline=no\n") % (
        IFACE, doc["tunnel_ip"], peer["tunnel_ip"])
    return {NETDEV: netdev, NETWORK: network}


def _write(path: Path, text: str, mode: int, group: str | None = None) -> bool:
    try:
        if path.read_text() == text:
            return False
    except FileNotFoundError:
        pass
    state.write_text(path, text, mode)
    if group:
        try:
            shutil.chown(path, "root", group)
        except (LookupError, OSError) as e:
            log.warning("chown %s: %s", path, e)
    return True


def _link() -> dict | None:
    r = _run("ip", "-j", "-s", "addr", "show", "dev", IFACE)
    if r.returncode != 0:
        return None
    try:
        return (json.loads(r.stdout) or [None])[0]
    except ValueError:
        return None


def _write_tunnel(doc: dict, private_key: str) -> bool:
    """Write the networkd files and make the interface match them. True when anything changed."""
    changed = _write(KEY_FILE, private_key + "\n", 0o640, "systemd-network")
    for path, text in _files(doc).items():
        changed |= _write(path, text, 0o644)
    if changed and _link() is not None:
        # networkd never changes a WireGuard device that already exists: take it away so the reload makes it anew.
        _run("networkctl", "delete", IFACE)
    if changed or _link() is None:
        r = _run("networkctl", "reload")
        if r.returncode != 0:
            raise RelayError(f"Couldn't start the tunnel ({r.stderr.strip()[:200]}).", "networkd")
    return changed


def _remove_tunnel() -> None:
    for p in (NETDEV, NETWORK, KEY_FILE):
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    if _link() is not None:
        _run("networkctl", "delete", IFACE)
    _run("networkctl", "reload")


def _has_address(tunnel_ip: str) -> bool:
    link = _link() or {}
    return any(a.get("local") == tunnel_ip for a in link.get("addr_info") or [])


def _ping(ip: str) -> float | None:
    r = _run("ping", "-n", "-c", "1", "-W", "2", "-I", IFACE, ip, timeout=6)
    m = re.search(r"time=([\d.]+) ms", r.stdout)
    return float(m.group(1)) if r.returncode == 0 and m else None


def _wg_peer() -> dict:
    """Handshake time and byte counts from wireguard-tools, when the image has them (0.2.4+); else from `ip -s`."""
    out = {}
    if shutil.which("wg"):
        r = _run("wg", "show", IFACE, "dump")
        lines = r.stdout.splitlines()[1:] if r.returncode == 0 else []
        if lines:
            f = lines[0].split("\t")
            if len(f) >= 7:
                out = {"handshake": int(f[4] or 0), "rx": int(f[5] or 0), "tx": int(f[6] or 0)}
    if not out:
        st = (_link() or {}).get("stats64") or {}
        if st:
            out = {"rx": int(st.get("rx", {}).get("bytes", 0)), "tx": int(st.get("tx", {}).get("bytes", 0))}
    return out


async def _wait_up(doc: dict, seconds: int = 25) -> dict:
    """The address is on the interface and the relay answers through the tunnel (the first ping starts the handshake)."""
    relay_ip = doc["relay"]["tunnel_ip"]
    deadline = time.time() + seconds
    while time.time() < deadline:
        if _has_address(doc["tunnel_ip"]):
            rtt = await asyncio.to_thread(_ping, relay_ip)
            if rtt is not None:
                return {"ok": True, "rtt_ms": rtt, "checked": int(time.time()), **_wg_peer()}
        await asyncio.sleep(1)
    return {"ok": False, "checked": int(time.time()), **_wg_peer()}


def health() -> dict:
    """Is the tunnel up right now? (Blocking: a ping of at most 2 s.)"""
    r = info()
    if not r.get("on"):
        return {"ok": False}
    if not _has_address(r.get("tunnel_ip", "")):
        return {"ok": False, "why": "no-tunnel", "checked": int(time.time())}
    peer = _wg_peer()
    rtt = _ping(r["relay"]["tunnel_ip"])
    return {"ok": rtt is not None, "rtt_ms": rtt, "checked": int(time.time()), **peer,
            **({} if rtt is not None else {"why": "no-answer"})}


# ---- services that change with the relay ----------------------------------------------------------------------------

async def _apply_caddy() -> None:
    """Rewrite the web server's settings (with or without the relay's PROXY header) and reload it, the same way setup
    does: Caddy checks the new file before it replaces the old one."""
    st = state.load_state()
    sn = st.get("server_name")
    acme = (names.creds() or {}).get("acme")
    if not sn or not acme:
        return
    new = config.CADDYFILE.with_name("Caddyfile.new")
    state.write_text(new, templates.caddy_anywhere(sn, acme, environment.env()["acme_directory"],
                                                   environment.has_extra_roots(), proxy_from=proxy_from()), 0o600)
    rc, out = await compose.caddy_validate("/etc/caddy/Caddyfile.new")
    if rc != 0:
        raise RelayError("The web server refused its new settings.", "caddy")
    os.replace(new, config.CADDYFILE)
    rc, out = await compose.caddy_reload()
    if rc != 0:
        raise RelayError("The web server didn't take its new settings.", "caddy")


async def _apply_livekit(public_ip: str | None, restart: bool) -> None:
    s = state.load_secrets()
    state.write_text(config.LIVEKIT_DIR / "livekit.yaml", livekit_yaml(s, public_ip), 0o600)
    ip = (info().get("relay") or {}).get("public_ip") if on() else public_ip
    if ip:
        state.save_state(livekit_public_ip=ip)
    if restart and (await compose.ps()).get("livekit", {}).get("state") == "running":
        rc, _ = await compose.restart("livekit")
        log.info("livekit restarted for the relay change (rc %s)", rc)


def _livekit_has_tunnel_socket(tunnel_ip: str, udp: int) -> bool:
    """LiveKit opens its UDP port on each address the box has when it starts; one started before the tunnel existed
    can't receive calls through it."""
    r = _run("ss", "-H", "-uln", f"sport = :{udp}")
    return any(f"{tunnel_ip}:{udp}" in line or f"0.0.0.0:{udp}" in line or f"*:{udp}" in line
               for line in r.stdout.splitlines())


# ---- on and off ----------------------------------------------------------------------------------------------------

def _save(doc: dict, **extra) -> dict:
    keep = {k: doc[k] for k in ("relay", "tunnel_ip", "ports", "status", "reason", "usage", "fqdn") if k in doc}
    cur = info()
    new = {**cur, **keep, "on": True, **extra}
    new.setdefault("since", int(time.time()))
    state.save_state(relay=new)
    return new


async def enable(calls: bool, restart: bool = True) -> dict:
    """Ask the names service for a place (or the same one again), bring the tunnel up, and point the call server and
    the web server at the relay. RelayError carries words for the owner."""
    async with _lock:
        priv, pub = keypair()
        try:
            doc = await names._call("POST", "/v1/relay", json={"public_key": pub}, auth=True, timeout=45)
        except names.NamesError as e:
            raise RelayError(str(e), e.code or "names") from e
        try:
            ipaddress.IPv4Address(doc["tunnel_ip"])
            ipaddress.IPv4Address(doc["relay"]["tunnel_ip"])
            ipaddress.IPv4Address(doc["relay"]["public_ip"])
        except (KeyError, ValueError) as e:
            raise RelayError("The names service sent a relay place this server doesn't understand.", "bad-place") from e
        await asyncio.to_thread(_write_tunnel, doc, priv)
        up = await _wait_up(doc)
        _save(doc, health=up, lost=False, error=None if up["ok"] else "no-answer")
        await _apply_livekit(None, restart=restart and calls)
        await _apply_caddy()
        log.info("relay on: %s via %s (tunnel %s, port %s, %s)", doc.get("fqdn"), doc["relay"]["public_ip"],
                 doc["tunnel_ip"], doc["ports"]["tcp"], "up" if up["ok"] else "no answer yet")
        return info()


async def disable(calls: bool, restart: bool = True) -> dict:
    """Give the place back, take the tunnel down, and put the call server and web server back as they were."""
    async with _lock:
        if not on():
            return info()
        try:
            res = await names._call("DELETE", "/v1/relay", auth=True, timeout=30)
        except names.NamesError as e:
            if e.code == "offline":
                raise RelayError("Can't reach the Tin Hat names service right now, so the relay can't be turned off "
                                 "yet. Try again in a few minutes.", "offline") from e
            raise RelayError(str(e), e.code) from e
        await asyncio.to_thread(_remove_tunnel)
        home = res.get("ip4") or (state.load_state().get("names_status") or {}).get("ip4")
        state.save_state(relay={"on": False, "off_at": int(time.time())},
                         names_status={**(state.load_state().get("names_status") or {}), "ip4": home})
        await _apply_livekit(home, restart=restart and calls)
        await _apply_caddy()
        log.info("relay off; name points home again (%s)", home)
        return info()


async def drop_local() -> dict:
    """This server's name moved to another computer: take the tunnel down here without asking the names service (the
    old key doesn't work there any more, and the move already freed the relay place)."""
    async with _lock:
        if not on():
            return info()
        await asyncio.to_thread(_remove_tunnel)
        state.save_state(relay={"on": False, "off_at": int(time.time()), "why": "moved"})
        await _apply_caddy()
        log.info("relay tunnel taken down here: the name moved to another computer")
        return info()


async def tick(calls: bool, n: int) -> None:
    """From the manager's loop (every 10 s): keep the tunnel healthy while the relay is on.
    Every 30 s: is the tunnel there and does the relay answer through it? Every 10 min: is the place still ours, and
    what does it say (state, this month's traffic)? Repairs: files missing (an update) → write them; the place changed
    (new relay, new port) → follow it; LiveKit without a socket on the tunnel → restart it when no call is on."""
    r = info()
    if not r.get("on") or _lock.locked():
        return
    if n % 3 == 0:
        h = await asyncio.to_thread(health)
        prev = r.get("health") or {}
        if not h["ok"] and (not NETDEV.exists() or h.get("why") == "no-tunnel"):
            try:
                priv, _ = keypair()
                await asyncio.to_thread(_write_tunnel, r, priv)
            except RelayError as e:
                log.warning("tunnel repair: %s", e)
        if h["ok"] != prev.get("ok"):
            log.info("relay tunnel %s", "up" if h["ok"] else f"DOWN ({h.get('why')})")
        if not h["ok"] and prev.get("ok") is False:
            h["down_since"] = prev.get("down_since") or prev.get("checked")
        _save(r, health=h)
        tcp, udp = call_ports()
        if h["ok"] and calls and not await asyncio.to_thread(_livekit_has_tunnel_socket, r["tunnel_ip"], udp):
            from . import lkadmin
            if (await compose.ps()).get("livekit", {}).get("state") != "running":
                log.info("livekit isn't running; starting it")
                await compose.up("livekit")
            elif await lkadmin.call_in_progress() is False:
                log.info("livekit has no socket on the tunnel address; restarting it")
                await compose.restart("livekit")
    if n % 60 == 7:
        try:
            doc = await names._call("GET", "/v1/relay", auth=True)
        except names.NamesError as e:
            log.warning("relay status: %s", e)
            return
        if not doc.get("relay"):
            # The names service has no place for us (its database came back from a backup, say): ask again.
            log.warning("the names service lost this server's relay place; asking again")
            _save(r, lost=True)
            try:
                await enable(calls)
            except RelayError as e:
                _save(info(), error=str(e))
            return
        moved = (doc["relay"] != r.get("relay") or doc["tunnel_ip"] != r.get("tunnel_ip")
                 or doc["ports"] != r.get("ports"))
        _save(r, **{k: doc[k] for k in ("status", "reason", "usage") if k in doc}, lost=False)
        if moved:
            log.info("the relay place changed; following it")
            try:
                await enable(calls)
            except RelayError as e:
                _save(info(), error=str(e))


def note_update(res: dict) -> None:
    """/v1/update's answer carries the place's state and traffic for a relayed server."""
    doc = res.get("relay")
    if doc and on():
        _save(info(), **{k: doc[k] for k in ("status", "reason", "usage") if k in doc})


# ---- words for the wizard and the dashboard -------------------------------------------------------------------------

_avail: tuple[float, bool] | None = None


async def is_available() -> bool:
    """Does the names service have a relay place to offer right now? (Asked at most every 10 minutes.)"""
    global _avail
    if _avail and time.time() - _avail[0] < 600:
        return _avail[1]
    try:
        ok = bool((await names.info()).get("relay_available"))
    except names.NamesError:
        ok = _avail[1] if _avail else False
    _avail = (time.time(), ok)
    return ok


def status_doc() -> dict:
    r = info()
    if not r.get("on"):
        return {"on": False, "offAt": r.get("off_at")}
    rel, h, u = r.get("relay") or {}, r.get("health") or {}, r.get("usage") or {}
    return {"on": True, "since": r.get("since"), "relayAddress": rel.get("public_ip"), "relayId": rel.get("id"),
            "port": (r.get("ports") or {}).get("tcp"), "tunnelOk": bool(h.get("ok")), "rttMs": h.get("rtt_ms"),
            "checked": h.get("checked"), "downSince": h.get("down_since"), "handshake": h.get("handshake"),
            "status": r.get("status", "active"), "reason": r.get("reason"), "usedBytes": u.get("bytes"),
            "quotaBytes": u.get("quota"), "month": u.get("month"), "error": r.get("error")}


STATUS_LINES = {
    "calls-paused": "This month's relay allowance is used up, so calls with friends outside your home are paused until "
                    "the 1st. Chat keeps working.",
    "paused": "The relay has paused this server until the 1st: it used twice this month's allowance.",
    "suspended": "The Tin Hat team paused the relay for this server.",
}


def summary(outside: dict) -> dict:
    """reach.summary for a relayed server: what friends outside get, in words."""
    r = info()
    res = outside.get("results") or {}
    st = r.get("status", "active")
    cgnat = (state.load_state().get("ports") or {}).get("kind") == "cgnat"
    h = r.get("health") or {}
    if outside.get("ok") and h.get("ok") is False and (h.get("checked") or 0) > (outside.get("at") or 0):
        # The last check passed, but the tunnel is down now: say what's true now.
        return {"level": "bad", "headline": "Friends outside your home can't reach your server right now.",
                "lines": ["The tunnel to the Tin Hat relay is down. This server keeps trying by itself; check that it's "
                          "online."], "fix": []}
    if outside.get("ok"):
        lines = [("Your internet provider doesn't allow incoming connections, so friends connect through the Tin Hat "
                  "relay. " if cgnat else "Friends connect through the Tin Hat relay. ")
                 + "It passes their traffic on without being able to read it."]
        return {"level": "good", "headline": "Friends outside your home reach your server through the Tin Hat relay.",
                "lines": lines + ([STATUS_LINES[st]] if st in STATUS_LINES else []), "fix": []}
    lines = []
    if st in STATUS_LINES:
        lines.append(STATUS_LINES[st] + (f" ({r['reason']})" if st == "suspended" and r.get("reason") else ""))
    elif not (r.get("health") or {}).get("ok"):
        lines.append("The tunnel to the relay isn't up. This server keeps trying by itself; check that it's online.")
    if outside.get("error"):
        lines.append(outside["error"])
    tls = (res.get("tls443") or {}).get("ok")
    if (res.get("tls443") or {}).get("why") == "certificate":
        lines.append("Your server's certificate isn't valid yet. It renews by itself; check again in a few minutes.")
    blocked = [k for k in ("tcp7881", "udp7882") if k in res and not res[k].get("ok")]
    if tls and blocked:
        lines.append("Chat works through the relay, but its call port doesn't answer yet.")
    level = "warn" if tls else "bad"
    head = ("Friends outside your home can chat through the relay, but calls may not connect." if tls
            else "Friends outside your home can't reach your server through the relay right now.")
    return {"level": level, "headline": head, "lines": lines, "fix": []}


# ---- the setup wizard's question (install.py's ports step, when it finds carrier NAT) -------------------------------

_question: dict | None = None
_answer: asyncio.Future | None = None
QUESTION_TIMEOUT = 1800  # nobody answered within 30 min (the page was closed): carry on without the relay


def question() -> dict | None:
    """The question the setup page should show now, if any."""
    return _question


def answer(use: bool) -> bool:
    if _answer is not None and not _answer.done():
        _answer.set_result(bool(use))
        return True
    return False


async def _ask() -> bool:
    global _question, _answer
    _answer = asyncio.get_running_loop().create_future()
    _question = {
        "id": "relay",
        "title": "Friends outside your home can't reach your server directly",
        "lines": [
            "Your internet provider shares one public address between many homes (\"carrier NAT\"). T-Mobile and "
            "Verizon 5G home internet, AT&T Internet Air and Starlink usually do this, so nothing from outside can "
            "reach your home, and no router setting changes that.",
            "The Tin Hat relay fixes it: your server keeps a connection open to the relay, and friends reach your server "
            "through it. Your server keeps its own certificate, so the relay passes everything on without being able "
            "to read it. People at home still connect straight to the server.",
        ],
        "yes": "Use the Tin Hat relay",
        "no": "Not now",
    }
    try:
        return await asyncio.wait_for(asyncio.shield(_answer), QUESTION_TIMEOUT)
    except asyncio.TimeoutError:
        return False
    finally:
        _question, _answer = None, None


async def setup_step(set_step, calls: bool):
    """The ports step behind carrier NAT: ask, then connect to the relay. Returns (status, detail) for the step."""
    if not on():
        try:
            available = bool((await names.info()).get("relay_available"))
        except names.NamesError:
            available = False
        if not available:  # no relay to offer (none running yet, or all full): the plain words, as before
            return ("warn", "Your internet provider doesn't allow incoming connections (carrier NAT).")
        set_step("ask", "Your internet provider doesn't allow incoming connections (carrier NAT). Choose below.")
        if not await _ask():
            return ("warn", "Your internet provider doesn't allow incoming connections (carrier NAT), so friends outside "
                            "your home can't reach your server. You can turn on the Tin Hat relay on the last page.")
    set_step("running", "Connecting to the Tin Hat relay…")
    try:
        await enable(calls, restart=False)
    except RelayError as e:
        return ("warn", f"Couldn't connect to the Tin Hat relay: {e}")
    d = status_doc()
    if not d["tunnelOk"]:
        return ("warn", "The Tin Hat relay gave this server a place, but the tunnel to it isn't answering yet. The server "
                        "keeps trying by itself.")
    cgnat = (state.load_state().get("ports") or {}).get("kind") == "cgnat"
    return ("done", ("Your internet provider doesn't allow incoming connections (carrier NAT), so friends will reach "
                     if cgnat else "Friends will reach ") + f"your server through the Tin Hat relay ({d['relayAddress']}).")

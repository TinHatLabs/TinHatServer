"""A server whose copy was restored on another computer (moving to a new computer) stands down, so the two never both
answer: chat and calls stop here, the router's ports, the relay and the home-network name are let go (the new computer
takes them), and nothing written here gets lost on a computer nobody will use again. The dashboard and the screen say
so, and that this computer can be switched off; its data stays on disk.

How it learns, whichever comes first:
- the new computer tells it right after the restore (`GET` then `POST /admin/name-check` on its home address): it
  proves it holds a restored copy of this server with an HMAC over a fresh challenge, keyed by a secret both copies
  share from the backup (secrets.json); anyone may ask, only a real copy can say so;
- for a tinhat.me name, the names service says "moved" (on its own every 10 minutes, or at once when asked without a
  proof).
"""
import asyncio
import hashlib
import hmac
import ipaddress
import logging
import secrets
import time

from . import compose, console, mdns, names, portmap, reach, relay, state

log = logging.getLogger("tinhat.moved")
SERVICES = ("synapse", "livekit", "lk-jwt")
_last_check = 0.0
_nonces: dict[str, float] = {}
_lock = asyncio.Lock()  # the nudge and the background loop can both get here at once


# Where clouds keep their metadata service outside link-local (AWS over IPv6, Alibaba): never a Tin Hat server.
METADATA = {ipaddress.ip_address("fd00:ec2::254"), ipaddress.ip_address("100.100.100.200")}


def old_bases(addrs: list, mine: set[str]) -> list[tuple[str, list[str]]]:
    """Where the new computer tells the old one (its addresses as the backup recorded them): literal addresses only,
    never this computer's own, nor any that no Tin Hat server answers on (loopback, link-local, multicast, a cloud's
    metadata service), and a handful at most. Each with http://ADDR and :8080 (a server behind its owner's reverse
    proxy)."""
    out = []
    for a in addrs[:8]:
        try:
            ip = ipaddress.ip_address(str(a).strip())
        except ValueError:
            continue
        if (str(ip) in mine or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified
                or ip.is_reserved or ip in METADATA):
            continue
        host = f"[{ip}]" if ip.version == 6 else str(ip)
        out.append((str(ip), [f"http://{host}", f"http://{host}:8080"]))
    return out


def is_moved(st: dict | None = None) -> bool:
    st = st if st is not None else state.load_state()
    return (st.get("names_status") or {}).get("status") == "moved" or bool(st.get("moved_away"))


def challenge() -> dict:
    now = time.time()
    for k in [k for k, v in _nonces.items() if v < now]:
        _nonces.pop(k, None)
    if len(_nonces) > 100:
        _nonces.clear()
    n = secrets.token_hex(16)
    _nonces[n] = now + 120
    return {"nonce": n}


def _key() -> bytes:
    return hashlib.sha256(b"tinhat-moved|" + str(state.load_secrets().get("macaroon_secret_key", "")).encode()).digest()


def proof(nonce: str, server_name: str) -> str:
    """What a restored copy of this server answers to a challenge (the old computer computes the same)."""
    return hmac.new(_key(), f"{server_name}|{nonce}".encode(), hashlib.sha256).hexdigest()


async def stand_down() -> None:
    """Idempotent: chat and calls off, ports, relay and the home-network name let go, the screen updated."""
    async with _lock:
        await _stand_down()


async def _stand_down() -> None:
    st = state.load_state()
    if st.get("stood_down"):
        return
    log.warning("this server moved to another computer: standing down (chat and calls off, ports, relay and name let go)")
    rc, out = await compose.run("stop", *SERVICES, timeout=180)
    if rc != 0:
        log.error("stopping %s: %s", SERVICES, out[-400:])
    if relay.on():  # the move already freed the relay place: only the tunnel is ours to drop
        try:
            await relay.drop_local()
        except Exception as e:  # noqa: BLE001 — standing down must go on
            log.error("relay: %s", e)
    if state.public_mode(st):
        try:
            let_go = await portmap.close_ports(reach.wanted(st.get("calls", True), state.behind_proxy(st)))
            log.info("router ports given back: %s", ", ".join(let_go) or "none were ours")
        except Exception as e:  # noqa: BLE001
            log.error("giving the router's ports back: %s", e)
    await mdns.release_name()
    state.save_state(stood_down=int(time.time()))
    console.refresh(force=True)


async def check_now(nonce: str | None = None, sig: str | None = None, to: str | None = None) -> dict:
    """The new computer's nudge. With a proof: a restored copy of this server says it took over. Without: for a
    tinhat.me name, ask the names service now (at most every 20 seconds, whoever asks)."""
    global _last_check
    st = state.load_state()
    if st.get("phase") != "ready":
        return {"moved": False, "checked": False}
    if nonce or sig:
        good = _nonces.pop(str(nonce), 0) > time.time() and hmac.compare_digest(
            str(sig or ""), proof(str(nonce), st.get("server_name") or ""))
        if not good:
            return {"moved": is_moved(st), "checked": False, "error": "not a copy of this server"}
        if not is_moved(st):
            state.save_state(moved_away={"at": int(time.time()), "to": str(to or "")[:64]})
            log.warning("a copy of this server was restored on another computer (%s)", to or "?")
    elif st.get("mode") == "anywhere" and not is_moved(st) and time.time() - _last_check > 20:
        _last_check = time.time()
        try:
            await names.update()
        except names.NamesError as e:
            log.info("name check: %s", e)
    if is_moved():
        await stand_down()
        return {"moved": True, "checked": True}
    return {"moved": False, "checked": True}

"""LiveKit's room service, read-only: is anyone in a call right now, and who? The manager asks before anything that pauses
the call server (the automatic outside check, an update), so it never cuts into a call without saying so."""
import base64
import hashlib
import hmac
import json
import logging
import re
import time

import aiohttp

from . import state

log = logging.getLogger("tinhat.lkadmin")

URL = "http://127.0.0.1:7880/twirp/livekit.RoomService/ListRooms"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(key: str, secret: str, ttl: int = 60, room: str | None = None) -> str:
    """A short-lived admin token (HS256, the way LiveKit's own SDKs sign them) that can only list rooms, or, with
    `room`, list that one room's participants (LiveKit asks for roomAdmin of that room; the manager only reads)."""
    now = int(time.time())
    video = {"roomAdmin": True, "room": room} if room else {"roomList": True}
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps({"iss": key, "sub": "tinhat-manager", "nbf": now - 10, "exp": now + ttl,
                            "video": video}, separators=(",", ":")).encode())
    sig = _b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


async def call_in_progress() -> bool | None:
    """True when a room has people in it, False when none has, None when LiveKit can't be asked."""
    try:
        s = state.load_secrets()
        tok = token(s["livekit_key"], s["livekit_secret"])
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4)) as c:
            async with c.post(URL, json={}, headers={"Authorization": f"Bearer {tok}"}) as r:
                if r.status != 200:
                    return None
                body = await r.json(content_type=None)
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError, KeyError) as e:
        log.debug("room list: %s", e)
        return None
    return any(int(x.get("num_participants") or 0) > 0 for x in body.get("rooms") or [])


_MXID = re.compile(r"@[^:\s]+:[^\s]+")


def mxid_of(identity) -> str | None:
    """The account behind a LiveKit identity: `<mxid>:<device>`, with a Pad / Watch tag after `~` or LiveKit's own `#X`
    (the api's identity.mjs). None for anything else (it is counted, not named)."""
    if not isinstance(identity, str):
        return None
    base = re.split(r"[~#]", identity, maxsplit=1)[0]
    mx, sep, device = base.rpartition(":")
    return mx if sep and device and _MXID.fullmatch(mx) else None


ROOMS_MAX = 20  # rooms asked about one by one; more than that and the rest are counted, not named


async def who_in_calls() -> dict | None:
    """Who is in a call right now: {"calls": rooms with someone in them, "people": [mxid, …] each once, sorted,
    "others": connections that aren't anyone's account}. None when LiveKit can't be asked (treat that as a call)."""
    try:
        s = state.load_secrets()
        key, secret = s["livekit_key"], s["livekit_secret"]
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as c:
            async def ask(method: str, tok: str, body: dict) -> dict | None:
                async with c.post(URL.replace("ListRooms", method), json=body,
                                  headers={"Authorization": f"Bearer {tok}"}) as r:
                    return await r.json(content_type=None) if r.status == 200 else None
            rooms = await ask("ListRooms", token(key, secret), {})
            if rooms is None:
                return None
            busy = [(x.get("name"), int(x.get("num_participants") or 0)) for x in rooms.get("rooms") or []
                    if int(x.get("num_participants") or 0) > 0]
            people, others = set(), 0
            for i, (name, n) in enumerate(busy):
                listed = await ask("ListParticipants", token(key, secret, room=name), {"room": name}) \
                    if i < ROOMS_MAX and isinstance(name, str) and name else None
                if listed is None:
                    others += n
                    continue
                for p in listed.get("participants") or []:
                    mx = mxid_of(p.get("identity"))
                    if mx:
                        people.add(mx)
                    else:
                        others += 1
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError, KeyError) as e:
        log.debug("who is in a call: %s", e)
        return None
    return {"calls": len(busy), "people": sorted(people), "others": others}

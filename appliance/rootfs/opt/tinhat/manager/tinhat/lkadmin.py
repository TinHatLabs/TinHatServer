"""LiveKit's room service, read-only: is anyone in a call right now? The manager asks before anything that pauses the
call server by itself (the automatic outside check), so it never cuts into a call."""
import base64
import hashlib
import hmac
import json
import logging
import time

import aiohttp

from . import state

log = logging.getLogger("tinhat.lkadmin")

URL = "http://127.0.0.1:7880/twirp/livekit.RoomService/ListRooms"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(key: str, secret: str, ttl: int = 60) -> str:
    """A short-lived admin token that can only list rooms (HS256, the way LiveKit's own SDKs sign them)."""
    now = int(time.time())
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps({"iss": key, "sub": "tinhat-manager", "nbf": now - 10, "exp": now + ttl,
                            "video": {"roomList": True}}, separators=(",", ":")).encode())
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

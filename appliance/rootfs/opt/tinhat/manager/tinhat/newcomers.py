"""New people land in the server's first room (#general).

Synapse's `auto_join_rooms` used to do it, but it joins EVERY account it registers, the guest room's temporary guest
accounts too (they would land in General and could read what it lets members read). Synapse has no way to leave some
accounts out, so the manager does it instead: every tick it asks for the accounts made since its last look and joins
the real ones (not the box's system account, not guests, not bots) to #general through the admin API. A guest is
never joined anywhere but the Guests room (api/tinhat-api/guests.mjs).

State: `newcomers_since` (ms) in state.json — the newest account already handled; set to "now" the first time, so the
people who were there before are never joined again (they chose their rooms).
"""
import logging
import time
from urllib.parse import quote

from . import config, state

log = logging.getLogger("tinhat.newcomers")

GUEST_PREFIX = "@guest-"
SKIP_TYPES = {"bot", "support"}


def _ms(ts) -> int:
    """Synapse's creation_ts: milliseconds on current versions, seconds on old ones."""
    try:
        n = int(ts)
    except (TypeError, ValueError):
        return 0
    return n if n > 10**11 else n * 1000


def wanted(user: dict, server_name: str) -> bool:
    name = str(user.get("name") or "")
    if not name.startswith("@") or not name.endswith(f":{server_name}"):
        return False
    if name.startswith(f"@{config.SYSTEM_LOCALPART}:") or name.startswith(GUEST_PREFIX):
        return False
    if user.get("deactivated") or user.get("is_guest") or str(user.get("user_type") or "") in SKIP_TYPES:
        return False
    return True


OVERLAP_MS = 5 * 60_000  # look back this far past the watermark (accounts made in the same instant, clock skew)
DONE_KEEP = 500          # names already handled, remembered so the overlap never joins anyone twice
MAX_TRIES = 5            # a join that keeps failing is given up after this many ticks (logged)


async def tick(synapse) -> int:
    """Join the accounts made since the last look to #general. Returns how many were joined. Pages through Synapse's
    list (newest first) until it passes the watermark minus an overlap; names already handled are remembered, and a
    join that failed is retried next tick (the watermark only moves past accounts that are done)."""
    st = state.load_state()
    if st.get("phase") != "ready" or not st.get("server_name"):
        return 0
    tok = state.load_secrets().get("system_token")
    if not tok:
        return 0
    sn = st["server_name"]
    since = st.get("newcomers_since")
    now_ms = int(time.time() * 1000)
    if not isinstance(since, int):
        state.save_state(newcomers_since=now_ms, newcomers_done=[], newcomers_tries={})
        return 0
    done = list(st.get("newcomers_done") or [])
    tries = dict(st.get("newcomers_tries") or {})
    seen = set(done)
    fresh, frm = [], "0"
    while frm is not None and len(fresh) < 2000:
        code, body = await synapse.req("GET", f"/_synapse/admin/v2/users?from={quote(str(frm))}&limit=100&guests=false"
                                              "&deactivated=false&order_by=creation_ts&dir=b", token=tok)
        if code != 200:
            return 0
        users = body.get("users", [])
        fresh += [u for u in users if _ms(u.get("creation_ts")) > since - OVERLAP_MS and u.get("name") not in seen]
        if not users or _ms(users[-1].get("creation_ts")) <= since - OVERLAP_MS:
            break
        frm = body.get("next_token")
    if not fresh:
        return 0
    code, room = await synapse.req("GET", f"/_matrix/client/v3/directory/room/{quote(f'#general:{sn}')}", token=tok)
    general = room.get("room_id") if code == 200 else None
    if not general:
        return 0  # no #general (yet): nobody is marked done, so they are joined once it exists
    joined, failed_at = 0, None
    for u in sorted(fresh, key=lambda u: _ms(u.get("creation_ts"))):
        name, ts = str(u.get("name") or ""), _ms(u.get("creation_ts"))
        if not wanted(u, sn):
            done.append(name)
            continue
        code, out = await synapse.req("POST", f"/_synapse/admin/v1/join/{quote(general)}", token=tok, json={"user_id": name})
        if code == 200:
            joined += 1
            done.append(name)
            tries.pop(name, None)
            log.info("%s joined %s (new here)", name, f"#general:{sn}")
            continue
        tries[name] = tries.get(name, 0) + 1
        if tries[name] >= MAX_TRIES:
            log.warning("gave up joining %s to #general after %d tries: %s %s", name, tries[name], code, out.get("errcode", ""))
            done.append(name)
            tries.pop(name, None)
        else:
            log.warning("couldn't join %s to #general (try %d): %s %s", name, tries[name], code, out.get("errcode", ""))
            failed_at = ts if failed_at is None else min(failed_at, ts)
    handled = [_ms(u.get("creation_ts")) for u in fresh if u.get("name") in set(done)]
    newest = max([since] + handled) if failed_at is None else max(since, min(failed_at - 1, max([since] + handled)))
    state.save_state(newcomers_since=newest, newcomers_done=done[-DONE_KEEP:], newcomers_tries=tries)
    return joined

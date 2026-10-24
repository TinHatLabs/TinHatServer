"""Repairs for servers that earlier versions set up, done once by the running manager: they need the chat server up,
which migrations (run while an update switches files) can't count on. Each one records itself in state["repairs"]."""
import logging
import time
from urllib.parse import quote

from . import state
from .synapse import Synapse

log = logging.getLogger("tinhat.repairs")

CALL_MEMBER = "org.matrix.msc3401.call.member"  # joining a call is a room state event (MatrixRTC)


def done(key: str) -> bool:
    return bool((state.load_state().get("repairs") or {}).get(key))


def mark(key: str) -> None:
    r = dict(state.load_state().get("repairs") or {})
    r[key] = int(time.time())
    state.save_state(repairs=r)


async def general_calls(synapse: Synapse) -> None:
    """General, as setup made it before 0.2.9, kept room state events for moderators, so only its admin could start or
    join a call there. Members may now. Changed as the room's admin (the owner) through Synapse's admin login, which
    makes no new device; the room shows "changed the power levels" from the owner."""
    st, sec = state.load_state(), state.load_secrets()
    sn, owner, tok = st.get("server_name"), st.get("admin"), sec.get("system_token")
    if not (sn and owner and tok):
        return
    code, res = await synapse.req("GET", f"/_matrix/client/v3/directory/room/{quote('#general:' + sn)}")
    if code == 404:  # no General (the owner removed it)
        return mark("general_calls")
    if code != 200:
        return  # the chat server isn't answering yet: next time
    room = res["room_id"]
    code, res = await synapse.req("GET", f"/_synapse/admin/v1/rooms/{quote(room)}/state", tok)
    pl = next((e for e in res.get("state", []) if e.get("type") == "m.room.power_levels"), None) if code == 200 else None
    if pl is None:
        return
    content = dict(pl["content"])
    events = dict(content.get("events") or {})
    member = int(content.get("users_default", 0))
    if int(events.get(CALL_MEMBER, content.get("state_default", 50))) <= member:
        return mark("general_calls")
    users = content.get("users") or {}
    need = int(events.get("m.room.power_levels", content.get("state_default", 50)))
    actor = owner if int(users.get(owner, member)) >= need else next(
        (u for u, lvl in users.items() if int(lvl) >= need and u.endswith(":" + sn)), None)
    if actor is None:
        log.warning("General: nobody on this server may change its power levels; members still can't join calls there")
        return mark("general_calls")
    code, res = await synapse.req("POST", f"/_synapse/admin/v1/users/{quote(actor)}/login", tok,
                                  json={"valid_until_ms": int(time.time() * 1000) + 120_000})
    if code != 200:
        log.warning("General: admin login as %s failed (%s)", actor, res.get("error", code))
        return
    as_admin = res["access_token"]
    try:
        events[CALL_MEMBER] = member
        content["events"] = events
        code, res = await synapse.req("PUT", f"/_matrix/client/v3/rooms/{quote(room)}/state/m.room.power_levels",
                                      as_admin, json=content)
    finally:
        await synapse.logout(as_admin)
    if code == 200:
        mark("general_calls")
        log.info("General: members may join calls now (power levels changed as %s)", actor)
    else:
        log.warning("General: power levels not changed (%s)", res.get("error", code))

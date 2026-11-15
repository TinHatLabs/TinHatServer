"""Tell the server's admins in Tin Hat when something needs them (D04.1, QOL sweep 2026-11-13).

The Overview's watch list (web.Manager._watch: backups not set up, the backup drive away, a failed or old backup, an
update that broke or went back, an update waiting with automatic updates off) used to be shown only to an owner who
happened to open the dashboard: a nightly backup could stop a month before the disk died. Now the server's own account
(config.SYSTEM_LOCALPART, shown as "Tin Hat Server") sends each admin one direct message when an item appears, again at
most once a day while a serious one stays, and once more when backups work again. Phones get it as a normal message
notification. The room is not encrypted: the server's account has no devices, and the text says nothing private.

State: notices.json in the state dir, {"rooms": {mxid: room_id}, "sent": {mxid: {key: {"at", "text"[, "held"]}}},
"named": bool}: what each admin was told, so one admin's failed delivery never counts as told for them.
"""
import logging
import time
import uuid
from urllib.parse import quote

from . import config, state

log = logging.getLogger("tinhat.notices")

FILE = config.STATE_DIR / "notices.json"
DAY = 24 * 3600
NAME = "Tin Hat Server"
# How often a key is said again while it stays: None = once. The serious backup and update troubles daily; the rest once.
REPEAT = {"backup-drive": DAY, "backup-failed": DAY, "backup-old": DAY, "update-broken": DAY}
BACKUP = ("backup-drive", "backup-failed", "backup-old")
# Said only once it has stayed this long: a server just set up has no backups yet, and that is no news on day one.
HOLD = {"backup-setup": 2 * DAY}


def plan(items: list[dict], sent: dict, now: float) -> tuple[list[tuple[str, str]], dict]:
    """What to say now, and the new `sent`. `items` = the watch list ({"key", "level", "text"}); items without a key,
    or of the "info" level, are never sent. Pure: the tests drive it directly."""
    out, new = [], {}
    live = {i["key"]: i for i in items if i.get("key") and i.get("level") in ("warn", "bad")}
    for key, it in live.items():
        prev = sent.get(key)
        again = REPEAT.get(key)
        if key in HOLD and (prev is None or prev.get("held")):
            since = prev["at"] if prev else now
            if now - since < HOLD[key]:
                new[key] = {"at": since, "text": it["text"], "held": True}
                continue
            prev = None
        if prev is None or (prev.get("text") != it["text"] and key not in BACKUP) or (again and now - prev["at"] >= again):
            out.append((key, it["text"]))
            new[key] = {"at": now, "text": it["text"]}
        else:
            new[key] = prev
    # Backups that were in trouble and now aren't: say so once. Not when the trouble only turned into "not set up"
    # (the backup settings were removed): that isn't backups working again.
    if any(k in sent for k in BACKUP) and not any(k in live for k in BACKUP + ("backup-setup",)):
        out.append(("backup-ok", "Backups work again."))
    return out, new


def message(text: str, link: str | None) -> dict:
    body = text.rstrip() + (f" Open the dashboard: {link}" if link else "")
    # m.text, not m.notice: the default push rule .m.rule.suppress_notices would keep phones quiet
    return {"msgtype": "m.text", "body": body}


async def _room_for(synapse, tok: str, me: str, mxid: str, rooms: dict) -> str | None:
    """The DM with this admin: the one made before while they are still in it (or invited), else a new one."""
    rid = rooms.get(mxid)
    if rid:
        st, body = await synapse.req("GET", f"/_matrix/client/v3/rooms/{quote(rid, safe='')}/state/m.room.member/"
                                     f"{quote(mxid, safe='')}", token=tok)
        if st == 200 and body.get("membership") in ("join", "invite"):
            return rid
    st, body = await synapse.req("POST", "/_matrix/client/v3/createRoom", token=tok, json={
        "preset": "trusted_private_chat", "is_direct": True, "invite": [mxid], "name": NAME,
        "topic": "Messages from your Tin Hat Server about backups and updates."})
    if st != 200 or not body.get("room_id"):
        log.warning("notices: no room for %s (%s)", mxid, st)
        return None
    rooms[mxid] = body["room_id"]
    return body["room_id"]


async def tick(synapse, items: list[dict], link: str | None, now: float | None = None) -> int:
    """Send what plan() says to every admin of this server, each admin with their own record of what they were told
    (one admin's failed delivery is retried for them next time, the others aren't told twice). Returns how many
    messages went out."""
    now = time.time() if now is None else now
    doc = state.read_json(FILE, {})
    sent_by = doc.get("sent") if isinstance(doc.get("sent"), dict) else {}
    if not any(i.get("key") for i in items) and not sent_by:
        return 0
    tok = state.load_secrets().get("system_token")
    sn = state.load_state().get("server_name")
    if not tok or not sn:
        return 0
    me = f"@{config.SYSTEM_LOCALPART}:{sn}"
    admins = [u["name"] for u in await synapse.users(tok)
              if u.get("admin") and not u.get("deactivated") and u.get("name") != me
              and str(u.get("name", "")).endswith(f":{sn}")]
    rooms = doc.get("rooms") or {}
    n, said_keys, new_by = 0, set(), {}
    for mxid in admins:
        mine = sent_by.get(mxid) if isinstance(sent_by.get(mxid), dict) else {}
        say, new = plan(items, mine, now)
        new_by[mxid] = new
        if not say:
            continue
        if not doc.get("named"):
            st, _ = await synapse.req("PUT", f"/_matrix/client/v3/profile/{quote(me, safe='')}/displayname", token=tok,
                                      json={"displayname": NAME})
            doc["named"] = st == 200
        rid = await _room_for(synapse, tok, me, mxid, rooms)
        ok = rid is not None
        for key, text in say if ok else []:
            st, _ = await synapse.req("PUT", f"/_matrix/client/v3/rooms/{quote(rid, safe='')}/send/m.room.message/"
                                      f"th-{uuid.uuid4().hex}", token=tok, json=message(text, link))
            if st == 200:
                n += 1
                said_keys.add(key)
            else:
                ok = False
        if not ok:  # this admin is told again next time (the whole set: a partly told set is rare and harmless)
            new_by[mxid] = mine
    doc = {**doc, "rooms": rooms, "sent": new_by}  # admins no longer admins drop out
    if doc != state.read_json(FILE, {}):
        state.write_json(FILE, doc, 0o600)
    if n:
        log.info("notices: %d message(s) to the admins: %s", n, ", ".join(sorted(said_keys)))
    return n

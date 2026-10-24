#!/usr/bin/env python3
"""move_synapse.py OLD NEW [--check] — rebuild Synapse's database under a new server name ("Move to your own domain").

Run by move.py in a one-off container of the server's own Synapse image (its event hashing and signing code), with
Synapse stopped, the database up and /data = Synapse's data folder. Prints JSON lines: {"phase", "done", "total"} as it
goes, then {"result": …} or {"error": …}. Exit 0 committed (or --check passed), 3 refused (nothing touched), 2 failed
(rolled back: nothing changed).

A Matrix event's id is the hash of its contents, and Synapse checks that whenever it loads one, so renaming the people
inside events (sender, membership, power levels, mentions) means giving every event a new id, in dependency order (an
event's prev_events and auth_events are part of its contents, and so are the ids its content names), re-hashed and
re-signed under the new name. Room ids stay: they're random in room versions 10 and 11, and an encrypted message carries
its room id inside the encryption, which only the members' devices could change. Then every other table: people and
aliases renamed, old event ids mapped to new ones. Everyone is signed out and their encryption identities (signed over
their old account names) are dropped; Secret Storage (their Security Key) and their key backups stay, so each person's
app restores their message keys with the same Security Key and makes a fresh identity under it.

All of it is one transaction, with every table locked against other writers until the commit; checks before the
commit (no account or sender left on the old name, every event's id = the hash of its content, no reference to an event
that isn't there that wasn't missing before) roll it back if anything is off.
"""
import collections
import heapq
import json
import re
import sys

ROOM_VERSIONS = {"10", "11"}
MAX_EVENTS = 500_000  # memory: ids, names and new ids of every event are held at once (Synapse is stopped meanwhile)
BATCH = 2000
EVID = re.compile(r"\$[A-Za-z0-9_-]{43}")
# Signed out (every device, token and session) and identities dropped: the move signs everyone in again at the new
# name. Children before their parents (foreign keys).
SIGN_OUT = ["access_tokens", "refresh_tokens", "devices", "e2e_device_keys_json", "e2e_one_time_keys_json",
            "e2e_fallback_keys_json", "device_inbox", "dehydrated_devices", "e2e_cross_signing_keys",
            "e2e_cross_signing_signatures", "pushers", "open_id_tokens", "login_tokens", "sliding_sync_connections",
            "device_auth_providers", "ui_auth_sessions_ips", "ui_auth_sessions_credentials", "ui_auth_sessions"]
OLD_IDENTITY_SECRETS = ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]
# In each moved event's unsigned: the ids it had before (every move so far) and, for an encrypted event, its relation by
# the new ids. Relations (edits, reactions, replies, threads) sit outside the encryption, where they are renamed, and
# also inside it, where nothing can change them; apps decrypt to the inside copy, so they read the note (Tin Hat's
# shared rule: tinhat-web src/core/matrix/moved.ts, the desktop's moved.rs).
MOVED = "dev.tinhat.moved"
# Tables whose event ids must point at events that exist (checked before and after: the move adds no broken ones).
REF_CHECKS = [("current_state_events", "event_id"), ("state_groups_state", "event_id"), ("event_edges", "event_id"),
              ("event_edges", "prev_event_id"), ("event_forward_extremities", "event_id"),
              ("room_memberships", "event_id"), ("local_current_membership", "event_id"),
              ("event_relations", "event_id"), ("event_relations", "relates_to_id"), ("redactions", "event_id"),
              ("redactions", "redacts"), ("receipts_linearized", "event_id"), ("event_push_actions", "event_id"),
              ("threads", "thread_id"), ("threads", "latest_event_id")]


def person_pattern(old: str) -> re.Pattern:
    """A person (@localpart:OLD) or an alias (#name:OLD); never a room (!id:OLD), a longer name (OLD.example), a word
    that only ends in one (x@alex:OLD) or a link's fragment (#/!room:OLD, #/room/!id:OLD: their room id stays). A call
    membership's state key (_@alex:OLD_DEVICE_m.call) names its person, so "_" may stand before one."""
    return re.compile(r'(?<![A-Za-z0-9.+-])(@[A-Za-z0-9._=/+-]+|#[^:\s"\\,{}/!$?&=#]+):' + re.escape(old)
                      + r"(?![A-Za-z0-9.-])")


def renamer(old: str, new: str):
    pat = person_pattern(old)
    return lambda s: pat.sub(lambda m: m.group(1) + ":" + new, s)


def map_ids(s: str, new_id: dict) -> str:
    return EVID.sub(lambda m: new_id.get(m.group(0), m.group(0)), s)


def named_ids(js: str, known, own: str) -> set:
    """The known events an event's JSON names (prev/auth events, redactions, relations, pins, …), itself not; never
    its unsigned part (what the server noted about it later, e.g. which state it replaced)."""
    d = json.loads(js)
    d.pop("unsigned", None)
    return {x for x in EVID.findall(json.dumps(d)) if x in known and x != own}


def graph_order(ids, stream: dict, refs: dict) -> tuple[list, int]:
    """Every event after every event it names (refs: event → the events it names), otherwise in the order they were
    stored (stream: event → stream_ordering). Returns (order, stuck): events caught in a loop of names (only a damaged
    database has one) can't be ordered; they come last and `stuck` counts them."""
    known = set(ids)
    waiting = {e: 0 for e in known}
    children = collections.defaultdict(list)
    for e, named in refs.items():
        if e not in known:
            continue
        for d in set(named):
            if d in known and d != e:
                waiting[e] += 1
                children[d].append(e)
    heap = [(stream[e], e) for e, n in waiting.items() if n == 0]
    heapq.heapify(heap)
    order = []
    while heap:
        _, e = heapq.heappop(heap)
        order.append(e)
        for c in children[e]:
            waiting[c] -= 1
            if waiting[c] == 0:
                heapq.heappush(heap, (stream[c], c))
    stuck = sorted((e for e in known if waiting[e] > 0), key=lambda e: stream[e])
    return order + stuck, len(stuck)


def rewrite_event(d: dict, rename, new_id: dict, old: str, new: str) -> tuple[dict, object]:
    """The event renamed, with every earlier event it names (prev/auth events, redactions, relations, pins, ids in
    Tin Hat's own events) by its new id; returns (event without hashes/signatures, its unsigned part). The caller
    hashes and signs. An encrypted message's ciphertext is never touched (it holds no "$")."""
    unsigned = d.pop("unsigned", None)
    d.pop("signatures", None)
    d.pop("hashes", None)
    d.pop("event_id", None)
    d = json.loads(map_ids(rename(json.dumps(d, ensure_ascii=False)), new_id))
    if d.get("origin") == old:
        d["origin"] = new
    return d, unsigned


def moved_note(old_id: str, d: dict, before) -> dict:
    """unsigned[MOVED] of an event after the move (d: the event as rebuilt): the ids it had before, every move so far
    (before: its note from an earlier move), and for an encrypted event its relation by the new ids."""
    former = [x for x in ((before or {}).get("former_ids") or []) if isinstance(x, str)] if isinstance(before, dict) else []
    note = {"former_ids": former + [old_id]}
    content = d.get("content") if isinstance(d.get("content"), dict) else {}
    if d.get("type") == "m.room.encrypted" and isinstance(content.get("m.relates_to"), dict):
        note["relates_to"] = content["m.relates_to"]
    return note


def changed_columns(values, rename, new_id) -> list:
    """[(index, new value)] for the values a row's text columns need changed (None stays None)."""
    out = []
    for i, v in enumerate(values):
        if v is None:
            continue
        fixed = map_ids(rename(v), new_id)
        if fixed != v:
            out.append((i, fixed))
    return out


def say(**kw) -> None:
    print(json.dumps(kw), flush=True)


def missing_refs(cur, columns: set) -> dict:
    """For each (table, column) of REF_CHECKS that exists: how many rows name an event that isn't there."""
    out = {}
    for t, c in REF_CHECKS:
        if (t, c) not in columns:
            continue
        cur.execute(f'SELECT count(*) FROM "{t}" x WHERE x."{c}" IS NOT NULL '
                    f'AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = x."{c}")')
        out[f"{t}.{c}"] = cur.fetchone()[0]
    return out


def main(argv) -> int:
    import psycopg2
    import psycopg2.extras
    import yaml
    from signedjson.key import read_signing_keys
    from synapse.api.room_versions import KNOWN_ROOM_VERSIONS
    from synapse.crypto.event_signing import add_hashes_and_signatures
    from synapse.events import make_event_from_dict

    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        say(error="usage: move_synapse.py OLD NEW [--check]")
        return 2
    old, new = args
    check_only = "--check" in argv
    cfg = yaml.safe_load(open("/data/homeserver.yaml"))
    a = cfg["database"]["args"]
    conn = psycopg2.connect(user=a["user"], password=a["password"], dbname=a["dbname"], host=a["host"])
    cur = conn.cursor()

    # ---- what this server holds, and whether it can move ---------------------------------------------------
    cur.execute("SELECT DISTINCT room_version FROM rooms")
    versions = {r[0] for r in cur.fetchall()}
    if versions - ROOM_VERSIONS:
        say(error=f"Some rooms are on a newer room version ({', '.join(sorted(versions - ROOM_VERSIONS))}) whose ids "
                  "come from their creator: they can't move to a new name.", code="room-version")
        return 3
    cur.execute("SELECT count(*) FROM events WHERE sender NOT LIKE %s", (f"%:{old}",))
    if cur.fetchone()[0]:
        say(error="This server has talked to other servers: their messages can't be moved to a new name.",
            code="federated")
        return 3
    cur.execute("SELECT count(*) FROM events")
    total = cur.fetchone()[0]
    if total > MAX_EVENTS:
        say(error=f"{total} messages and events: too many to move in one go for now.", code="too-big")
        return 3
    cur.execute("SELECT count(*) FROM users")
    users = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM rooms")
    rooms = cur.fetchone()[0]
    say(phase="check", events=total, users=users, rooms=rooms)
    if check_only:
        say(result={"ok": True, "events": total, "users": users, "rooms": rooms})
        return 0

    with open(cfg["signing_key_path"]) as f:
        signing_key = read_signing_keys(f)[0]
    rename = renamer(old, new)
    try:
        # ---- 0. nobody else in the database until the commit -----------------------------------------------
        cur.execute("SET lock_timeout = '60s'")
        cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND pid <> pg_backend_pid()")
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        tables = sorted(r[0] for r in cur.fetchall())
        cur.execute("LOCK TABLE " + ", ".join(f'"{t}"' for t in tables) + " IN SHARE ROW EXCLUSIVE MODE")
        cur.execute("""SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
                       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'""")
        all_columns = cur.fetchall()
        column_set = {(t, c) for t, c, _ in all_columns}
        refs_before = missing_refs(cur, column_set)

        # ---- 1. every event after the events it names, re-hashed and re-signed under the new name ---------------
        cur.execute("SELECT e.event_id, r.room_version, e.stream_ordering FROM events e "
                    "JOIN rooms r ON r.room_id = e.room_id")
        rows = cur.fetchall()
        version_of = {r[0]: r[1] for r in rows}
        stream = {r[0]: r[2] for r in rows}
        del rows
        refs: dict[str, set] = {}
        read = conn.cursor(name="refs")
        read.itersize = BATCH
        read.execute("SELECT event_id, json FROM event_json")
        for eid, js in read:
            named = named_ids(js, version_of, eid)
            if named:
                refs[eid] = named
        read.close()
        order, stuck = graph_order(version_of.keys(), stream, refs)
        del refs, stream
        if stuck:
            conn.rollback()
            say(error=f"{stuck} events in the chat database name each other in a loop, so they can't be given new "
                      "ids in order. Nothing was changed.", code="loop")
            return 3
        new_id: dict[str, str] = {}
        late: list[str] = []  # unsigned naming events after it (redacted_because): mapped once every id is known
        done = 0
        dump = lambda d: json.dumps(d, separators=(",", ":"), ensure_ascii=False)  # noqa: E731
        for i in range(0, len(order), BATCH):
            chunk = order[i:i + BATCH]
            cur.execute("SELECT event_id, json FROM event_json WHERE event_id = ANY(%s)", (chunk,))
            stored = dict(cur.fetchall())
            writes = []
            for eid in chunk:
                rv = KNOWN_ROOM_VERSIONS[version_of[eid]]
                d, unsigned = rewrite_event(json.loads(stored[eid]), rename, new_id, old, new)
                add_hashes_and_signatures(rv, d, new, signing_key)
                new_id[eid] = make_event_from_dict(dict(d), rv).event_id
                u = unsigned if isinstance(unsigned, dict) else {}
                before = u.pop(MOVED, None)
                if any(x in version_of and x not in new_id for x in EVID.findall(dump(u))):
                    late.append(eid)
                u = json.loads(map_ids(rename(dump(u)), new_id))
                u[MOVED] = moved_note(eid, d, before)
                d["unsigned"] = u
                writes.append((dump(d), eid))
            psycopg2.extras.execute_batch(cur, "UPDATE event_json SET json = %s WHERE event_id = %s", writes)
            done += len(chunk)
            say(phase="events", done=done, total=total)
        for eid in late:
            cur.execute("SELECT json FROM event_json WHERE event_id = %s", (eid,))
            d = json.loads(cur.fetchone()[0])
            note = d["unsigned"].pop(MOVED)  # its former ids are old ids on purpose
            d["unsigned"] = json.loads(map_ids(dump(d["unsigned"]), new_id))
            d["unsigned"][MOVED] = note
            cur.execute("UPDATE event_json SET json = %s WHERE event_id = %s", (dump(d), eid))

        # ---- 2. everyone signed out, the old identities dropped --------------------------------------------
        for t in SIGN_OUT:
            if t in tables:
                cur.execute(f'DELETE FROM "{t}"')
        cur.execute("DELETE FROM account_data WHERE account_data_type = ANY(%s)", (OLD_IDENTITY_SECRETS,))
        say(phase="signout")

        # ---- 3. every other table: people, aliases, event ids; each row written once ----------------------
        cur.execute("SET session_replication_role = replica")  # foreign keys between renamed rows
        by_table: dict[str, list] = collections.defaultdict(list)
        for t, c, dtype in sorted(all_columns):
            if dtype in ("text", "character varying", "json", "jsonb") and (t, c) != ("event_json", "json"):
                by_table[t].append((c, dtype))
        look = r"\$|:" + re.escape(old)
        changed = 0
        for n, (table, cols) in enumerate(sorted(by_table.items()), 1):
            read = conn.cursor(name=f"tab{n}")
            read.itersize = BATCH
            sel = ", ".join('"%s"::text' % c for c, _ in cols)
            where = " OR ".join('"%s"::text ~ %%s' % c for c, _ in cols)
            read.execute(f'SELECT ctid, {sel} FROM "{table}" WHERE {where}', [look] * len(cols))
            by_set: dict[tuple, list] = collections.defaultdict(list)
            for row in read:
                fixes = changed_columns(row[1:], rename, new_id)
                if fixes:
                    by_set[tuple(i for i, _ in fixes)].append(tuple(v for _, v in fixes) + (row[0],))
            read.close()
            for which, writes in by_set.items():
                sets = ", ".join(f'"{cols[i][0]}" = %s' + ("" if cols[i][1] in ("text", "character varying")
                                                          else f"::{cols[i][1]}") for i in which)
                psycopg2.extras.execute_batch(cur, f'UPDATE "{table}" SET {sets} WHERE ctid = %s', writes)
                changed += len(writes)
            say(phase="tables", done=n, total=len(by_table))
        cur.execute("UPDATE room_alias_servers SET server = %s WHERE server = %s", (new, old))
        cur.execute("SET session_replication_role = origin")

        # ---- 4. checks, then commit ------------------------------------------------------------------------
        cur.execute("SELECT count(*) FROM users WHERE name LIKE %s", (f"%:{old}",))
        left_users = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM events WHERE sender LIKE %s", (f"%:{old}",))
        left_senders = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM devices")
        left_devices = cur.fetchone()[0]
        refs_after = missing_refs(cur, column_set)
        broken = {k: v - refs_before.get(k, 0) for k, v in refs_after.items() if v > refs_before.get(k, 0)}
        mismatch = 0
        read = conn.cursor(name="verify")
        read.itersize = BATCH
        read.execute("SELECT e.event_id, j.json, r.room_version FROM events e JOIN event_json j USING (event_id) "
                     "JOIN rooms r ON r.room_id = e.room_id")
        checked = 0
        for eid, js, rv in read:
            d = json.loads(js)
            d.pop("unsigned", None)
            if make_event_from_dict(d, KNOWN_ROOM_VERSIONS[rv]).event_id != eid:
                mismatch += 1
            checked += 1
            if checked % BATCH == 0:
                say(phase="verify", done=checked, total=total)
        read.close()
        result = {"events": len(new_id), "rows_changed": changed, "left_users": left_users,
                  "left_senders": left_senders, "left_devices": left_devices, "id_mismatches": mismatch,
                  "broken_references": broken, "checked": checked}
        if left_users or left_senders or left_devices or mismatch or broken or checked != total:
            conn.rollback()
            say(error="The checks after the rebuild didn't all pass: nothing was changed.", result=result)
            return 2
        conn.commit()
        say(result=result)
        return 0
    except Exception as e:  # noqa: BLE001 — anything at all: roll back, say what
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001 — the connection is gone: the transaction never committed
            pass
        say(error=f"The rebuild stopped: {type(e).__name__}: {e}. Nothing was changed.")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""tinhat_network — a Synapse module: the owner's deny-list and each person's rule for invites from other servers
(docs/NETWORK-RULES.md; share design MATRIX-FRONTEND-DESIGN.md A4/A5). Active in every mode that federates: blocking
a server that is allowed by name, or connected, means something too.

Blocked servers (Network → Blocked servers on the dashboard; state.json `blocked_servers`). The manager also takes a
blocked server off Synapse's federation allow-list, out of media downloads (`prevent_media_downloads_from`) and makes
Caddy refuse federation requests that claim it. This module adds, whatever reaches Synapse anyway:
  - an invite whose sender is on a blocked server is refused: 403 M_FORBIDDEN {"dev.tinhat.reason": "server-blocked"}
    when it is sent to this server (/invite), soft-failed when it arrives inside a room this server is in (/send).
    Synapse has already checked that the invite came from the sender's own server (on_invite_request), so the
    sender's server is the authenticated one, never a claimed header.
The list is read from network-rules.json next to this file (written by the manager, re-read when it changes) AND from
this module's config in homeserver.yaml (written at the same time, read at start): a server on either is blocked, so a
missing or broken file never unblocks anyone.

Invites from other servers, per person (account data `dev.tinhat.invite_rules` = {v: 1, remote: "anyone" | "known" |
"nobody"}; no document = "known"; a `v` this server can't read = "nobody"; appliance/tests/vectors/network/invite_rules_v.json):
  - "nobody": every invite from another server is refused;
  - "known" (the default): only from someone I have a DM with (`m.direct`), someone whose invite I accepted before
    (recorded here when I join a room a remote person invited me to), someone on a Tin Hat server connected to this
    one by code (both owners agreed), or a member of a room I'm in whose join rule isn't public. Sharing a public room
    doesn't count;
  - "anyone": every invite, within the quotas.
  A refusal is 403 M_FORBIDDEN {"dev.tinhat.reason": "invite-rules"}; it never reaches the person's sync.

Quotas (network.db, so a restart doesn't reset them; sliding hour), counted by the sender's (authenticated) server:
  - per_server: invites from one server, accepted and refused alike;
  - per_recipient: invites one person here may get from people they don't know (rule "anyone");
  - overall: invites accepted into the whole box.
  Over a quota: 403 M_FORBIDDEN {"dev.tinhat.reason": "too-many-invites"}.

An invite inside a room this server is in can skip both checks: when its content hash doesn't match, Synapse stores
its own redacted copy (still an invite) without asking any module. on_new_event judges every invite no check decided,
and declines a refused one on the person's behalf (it reached their sync for a moment; the decline is retried a few
times, then given up and logged).

Failure rules: the blocked check never fails open (it is a set lookup). If the invite rule or the "known" check
itself fails, the invite is refused (logged): a spam control must not let everything through on a bug. If the quota
database fails, the quotas are skipped (logged) and the rules still apply: a full disk must not cut people off from
their friends.
"""
import json
import logging
import math
import os
import sqlite3
import threading
import time

from synapse.api.errors import Codes
from synapse.module_api import NOT_SPAM, ModuleApi

logger = logging.getLogger(__name__)

RULE_TYPE = "dev.tinhat.invite_rules"
RULES = ("anyone", "known", "nobody")
DEFAULT_RULE = "known"
#: a rule document whose version this server can't read (parse_rule): never looser than any stored rule
UNREADABLE_RULE = "nobody"
REASONS = ("server-blocked", "invite-rules", "too-many-invites")
#: join rules that make a shared room count as "known" (everything but public; a missing join rule is the spec's
#: default, invite)
NOT_PUBLIC = ("invite", "knock", "restricted", "knock_restricted", "private")
DEFAULT_QUOTAS = {"per_server": 20, "per_recipient": 5, "overall": 100, "window_s": 3600}
#: how many shared rooms are looked at for "known" (the rest count as not known: refused, never a long stall)
MAX_SHARED = 200
#: invites waiting for their answer are remembered this long (accepting later doesn't make the inviter "known")
PENDING_S = 30 * 86400
#: refused invites stay in the database this long (the dashboard's "Busy servers" looks at a day)
KEEP_S = 25 * 3600
#: the database layout (PRAGMA user_version)
SCHEMA = 3
#: _outcome: the database didn't answer (never "no decision")
LOOKUP_FAILED = "\0lookup-failed"
#: seconds between tries of an on-behalf decline (then it is given up, logged)
DECLINE_RETRY_S = (5, 30, 120)


def host_of(server) -> str:
    """A server name as compared here: lower case, no trailing dot, no port ("Evil.Example:8448." -> "evil.example")."""
    s = str(server or "").strip().lower()
    if s.startswith("["):  # an IPv6 literal
        return s.split("]", 1)[0] + "]"
    if s.count(":") == 1:
        s = s.split(":", 1)[0]
    return s.rstrip(".")


def server_of(user_id) -> str:
    u = str(user_id or "")
    return host_of(u.split(":", 1)[1]) if u.startswith("@") and ":" in u else ""


def _names(v) -> set:
    return {host_of(x) for x in v or [] if isinstance(x, str) and x.strip()} if isinstance(v, (list, tuple)) else set()


class _File:
    """A JSON file re-read when its mtime or size changes; missing or broken reads as None."""

    def __init__(self, path: str):
        self.path, self.sig, self.value = path, None, None

    def get(self):
        try:
            st = os.stat(self.path)
        except OSError:
            self.sig, self.value = None, None
            return None
        sig = (st.st_mtime_ns, st.st_size)
        if sig != self.sig:
            try:
                with open(self.path, encoding="utf-8") as f:
                    self.value = json.load(f)
            except (OSError, ValueError):
                self.value = None
            self.sig = sig
        return self.value


class Quotas:
    """The invite counters and the accepted inviters, in one small SQLite file (one Synapse process on a Tin Hat box).
    Every call is synchronous and short; NetworkRules runs them on Synapse's thread pool (never on the reactor)."""

    def __init__(self, path: str, now=time.time, quotas: dict | None = None):
        self.path, self.now = path, now
        self.quotas = dict(quotas or DEFAULT_QUOTAS)  # the window pruning keeps (the configured one, on every path)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, timeout=2, check_same_thread=False, isolation_level=None)
        if int(self.db.execute("PRAGMA user_version").fetchone()[0]) < SCHEMA:
            # a database from a build before this layout (never released): its counters start again
            self.db.executescript("DROP TABLE IF EXISTS invites; DROP TABLE IF EXISTS pending;")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS invites (ts REAL NOT NULL, server TEXT NOT NULL, recipient TEXT NOT NULL,
                                                outcome TEXT NOT NULL, stranger INTEGER NOT NULL DEFAULT 0,
                                                event_id TEXT);
            CREATE INDEX IF NOT EXISTS invites_ts ON invites (ts);
            CREATE INDEX IF NOT EXISTS invites_server ON invites (server, ts);
            CREATE INDEX IF NOT EXISTS invites_event ON invites (event_id);
            CREATE TABLE IF NOT EXISTS pending (room TEXT NOT NULL, recipient TEXT NOT NULL, inviter TEXT NOT NULL,
                                                ts REAL NOT NULL, event_id TEXT, PRIMARY KEY (room, recipient));
            CREATE TABLE IF NOT EXISTS accepted (recipient TEXT NOT NULL, inviter TEXT NOT NULL, ts REAL NOT NULL,
                                                 PRIMARY KEY (recipient, inviter));
        """)
        self.db.execute(f"PRAGMA user_version = {SCHEMA}")
        try:
            os.chmod(path, 0o644)  # the manager reads it (dashboard: recent refusals); nothing in it is secret
        except OSError:
            pass

    def _count(self, sql: str, *args) -> int:
        return int(self.db.execute(sql, args).fetchone()[0])

    def _seen(self, event_id: str) -> str | None:
        """The outcome recorded for this invite event before (a retried or replayed delivery counts once)."""
        if not event_id:
            return None
        row = self.db.execute("SELECT outcome FROM invites WHERE event_id = ? LIMIT 1", (event_id,)).fetchone()
        return None if row is None else str(row[0])

    def check(self, server: str, recipient: str, stranger: bool, quotas: dict, refused_as: str | None = None,
              event_id: str = "", count: bool = True, room: str = "", inviter: str = "") -> str:
        """Decide this invite's quotas once per event id, in one locked transaction -> its outcome: "ok",
        "too-many-invites", or refused_as.
        - per_server counts every invite from that server (this one included, refused ones too); per_recipient
          (strangers only) and overall count accepted invites. refused_as: refused anyway (the person's rule): only
          per_server is checked;
        - an event seen before keeps a refusal (a refusal sticks); one seen as "ok" and refused now becomes refused,
          and its pending invite goes;
        - count False (an old invite, fetched with history): never counted, never pending;
        - a new accepted invite with a room becomes the person's pending invite there (the latest one wins)."""
        t = self.now()
        since = t - quotas["window_s"]
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._prune(t)
                prev = self._seen(event_id)
                if prev is not None:
                    if prev == "ok" and refused_as:
                        self._refuse_seen(event_id, refused_as)
                        prev = refused_as
                    result = prev
                elif not count:
                    result = refused_as or "ok"
                else:
                    over = self._count("SELECT COUNT(*) FROM invites WHERE server = ? AND ts >= ?", server, since) + 1 > quotas["per_server"]
                    if not over and refused_as is None and stranger:
                        over = self._count("SELECT COUNT(*) FROM invites WHERE recipient = ? AND stranger = 1 AND outcome = 'ok' "
                                           "AND ts >= ?", recipient, since) + 1 > quotas["per_recipient"]
                    if not over and refused_as is None:
                        over = self._count("SELECT COUNT(*) FROM invites WHERE outcome = 'ok' AND ts >= ?", since) + 1 > quotas["overall"]
                    result = "too-many-invites" if over else (refused_as or "ok")
                    self.db.execute("INSERT INTO invites (ts, server, recipient, outcome, stranger, event_id) VALUES (?, ?, ?, ?, ?, ?)",
                                    (t, server, recipient, result, 1 if stranger else 0, event_id or None))
                    if result == "ok" and room and inviter:
                        self.db.execute("INSERT OR REPLACE INTO pending (room, recipient, inviter, ts, event_id) VALUES (?, ?, ?, ?, ?)",
                                        (room, recipient, inviter, t, event_id or None))
                if result != "ok" and event_id:  # whatever was recorded (or pruned): a refused invite is never pending
                    self.db.execute("DELETE FROM pending WHERE event_id = ?", (event_id,))
                self.db.execute("COMMIT")
                return result
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def _prune(self, t: float) -> None:
        self.db.execute("DELETE FROM invites WHERE ts < ?", (t - max(2 * self.quotas["window_s"], KEEP_S),))
        self.db.execute("DELETE FROM pending WHERE ts < ?", (t - PENDING_S,))

    def _refuse_seen(self, event_id: str, reason: str) -> None:
        """An event recorded as accepted is refused now: it stays refused, and its pending invite goes."""
        self.db.execute("UPDATE invites SET outcome = ? WHERE event_id = ? AND outcome = 'ok'", (reason, event_id))
        self.db.execute("DELETE FROM pending WHERE event_id = ?", (event_id,))

    def refused(self, server: str, recipient: str, reason: str, event_id: str = "", count: bool = True) -> None:
        """An invite refused before the quotas (blocked server, a failed check): counted for its server and kept for
        the dashboard (once per event; never for an old one), and sticky like every refusal."""
        t = self.now()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._prune(t)
                prev = self._seen(event_id)
                if event_id:
                    self.db.execute("DELETE FROM pending WHERE event_id = ?", (event_id,))
                if prev == "ok":
                    self._refuse_seen(event_id, reason)
                elif prev is None and count:
                    self.db.execute("INSERT INTO invites (ts, server, recipient, outcome, event_id) VALUES (?, ?, ?, ?, ?)",
                                    (t, server, recipient, reason, event_id or None))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def answered(self, room: str, recipient: str, joined: bool, replaces: str = "") -> str | None:
        """The person answered the invite they have in room (one transaction). joined, and the join replaced exactly
        that invite (`replaces`: the membership event the join replaced, Synapse's unsigned.replaces_state) -> its
        inviter becomes accepted (returned). Anything else (declined, left, banned, a join that didn't follow this
        invite) forgets it, so a later join some other way trusts nobody."""
        t = self.now()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute("SELECT inviter, event_id FROM pending WHERE room = ? AND recipient = ? AND ts >= ?",
                                      (room, recipient, t - PENDING_S)).fetchone()
                self.db.execute("DELETE FROM pending WHERE room = ? AND recipient = ?", (room, recipient))
                inviter = None
                if row is not None and joined and (row[1] is None or row[1] == replaces):
                    self.db.execute("INSERT OR REPLACE INTO accepted (recipient, inviter, ts) VALUES (?, ?, ?)",
                                    (recipient, row[0], t))
                    inviter = str(row[0])
                self.db.execute("COMMIT")
                return inviter
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def outcome(self, event_id: str) -> str | None:
        """The outcome recorded for this invite event, or None (never decided, or pruned)."""
        with self.lock:
            return self._seen(event_id)

    def is_accepted(self, recipient: str, inviter: str) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM accepted WHERE recipient = ? AND inviter = ?",
                                   (recipient, inviter)).fetchone() is not None


def _refuse(reason: str):
    return Codes.FORBIDDEN, {"dev.tinhat.reason": reason}


def version_ok(v) -> bool:
    """The rule document's `v` is 1: a JSON number exactly equal to 1 (1, 1.0, 1e0: one value once JSON is parsed in
    JavaScript, so every side must take them alike), or the string "1" or "1.0" exactly. Never a boolean (Python's
    True == 1; JavaScript's doesn't). appliance/tests/vectors/network/invite_rules_v.json is the shared definition."""
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return v == 1
    return isinstance(v, str) and v in ("1", "1.0")


def _finite(value, depth: int = 0) -> bool:
    """Every number in value fits a finite double (what every side's JSON reader can hold), at most 32 levels deep."""
    if depth > 32:
        return False
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return True
    if isinstance(value, int):
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_finite(v, depth + 1) for v in value.values())
    if isinstance(value, (list, tuple)):
        return all(_finite(v, depth + 1) for v in value)
    return False


def parse_rule(content) -> str:
    """The person's rule from their account data (appliance/tests/vectors/network/invite_rules_v.json):
    - no document, or an empty object (how Tin Hat clears the setting) -> the default, "known";
    - a document that isn't an object, holds a number no double can (anywhere), or whose `v` isn't 1 (version_ok)
      or is missing -> "nobody": a rule this server can't read is never looser than what the person stored, whatever
      they stored (the apps read the same file);
    - `v` 1 -> its `remote` word when it is exactly one of RULES, else the default."""
    if content is None:
        return DEFAULT_RULE
    try:
        if not hasattr(content, "keys") or not hasattr(content, "get"):
            return UNREADABLE_RULE
        if len(content) == 0:
            return DEFAULT_RULE
        if not _finite(dict(content)) or not version_ok(content.get("v")):
            return UNREADABLE_RULE
        remote = content.get("remote")
        return str(remote) if isinstance(remote, str) and remote in RULES else DEFAULT_RULE
    except (AttributeError, TypeError, ValueError):
        return UNREADABLE_RULE


class NetworkRules:
    def __init__(self, config: dict, api: ModuleApi, now=time.time):
        self.api = api
        here = os.path.dirname(os.path.abspath(__file__))
        self.file = _File(config.get("rules") or os.path.join(here, "network-rules.json"))
        self.blocked_cfg = _names(config.get("blocked"))
        self.blocked_live: set = set()  # the last list read from the file (kept when the file goes missing or breaks)
        self.connected = _names(config.get("connected"))
        q = dict(DEFAULT_QUOTAS)
        for k, v in (config.get("quotas") or {}).items():
            if k in q and isinstance(v, int) and not isinstance(v, bool) and v > 0:
                q[k] = v
        self.quotas = q
        self.now = now
        self.db = None
        try:
            self.db = Quotas(config.get("db") or "/data/tinhat-network.db", now, q)
        except (OSError, sqlite3.Error):
            logger.exception("tinhat_network: no quota database; invite quotas are off until Synapse restarts")
        api.register_spam_checker_callbacks(federated_user_may_invite=self.federated_user_may_invite,
                                            check_event_for_spam=self.check_event_for_spam)
        api.register_third_party_rules_callbacks(on_new_event=self.on_new_event)

    @staticmethod
    def parse_config(config: dict) -> dict:
        return config or {}

    async def _db(self, fn, *args):
        """A Quotas call on Synapse's thread pool (SQLite never blocks the reactor), or directly without one."""
        run = getattr(self.api, "defer_to_thread", None)
        return await run(fn, *args) if run is not None else fn(*args)

    # ---- the deny-list -------------------------------------------------------------------------------------------
    def blocked(self) -> set:
        """The list from homeserver.yaml and the last good one from the file: a missing or broken file never unblocks
        a server (one blocked since Synapse started stays blocked until the manager writes a list without it)."""
        f = self.file.get()
        if isinstance(f, dict) and isinstance(f.get("blocked"), list):
            self.blocked_live = _names(f.get("blocked"))
        return self.blocked_cfg | self.blocked_live

    def is_blocked(self, server: str) -> bool:
        return host_of(server) in self.blocked()

    # ---- known people ---------------------------------------------------------------------------------------------
    async def rule_of(self, user_id: str) -> str:
        return parse_rule(await self.api.account_data_manager.get_global(user_id, RULE_TYPE))

    async def is_known(self, local: str, remote: str) -> bool:
        if server_of(remote) in self.connected:
            return True
        direct = await self.api.account_data_manager.get_global(local, "m.direct")
        if direct is not None and hasattr(direct, "keys") and remote in direct.keys():
            return True
        if self.db is not None:
            try:
                if await self._db(self.db.is_accepted, local, remote):
                    return True
            except sqlite3.Error:
                logger.exception("tinhat_network: couldn't read the accepted inviters")
        store = self.api._store  # noqa: SLF001  (no public ModuleApi call lists a user's rooms)
        shared = set(await store.get_rooms_for_user(local)) & set(await store.get_rooms_for_user(remote))
        for room in sorted(shared)[:MAX_SHARED]:
            state = await self.api.get_room_state(room, [("m.room.join_rules", "")])
            ev = state.get(("m.room.join_rules", "")) if state else None
            rule = (ev.content or {}).get("join_rule", "invite") if ev is not None else "invite"
            if rule in NOT_PUBLIC:
                return True
        return False

    # ---- the callbacks ----------------------------------------------------------------------------------------------
    async def federated_user_may_invite(self, event):
        """An invite sent to this server directly (/invite). Synapse has checked the event's signatures (the
        sender's server signed it) before this runs; that the sending server is the sender's own is checked after
        it, so a retried or relayed copy of the same invite is counted once, by its event id."""
        why = await self.decide(event)
        return NOT_SPAM if why is None else _refuse(why)

    async def check_event_for_spam(self, event):
        """Every event received over federation (and every local one: those pass). An invite for someone here can
        also arrive inside a room this server is already in (/send), where federated_user_may_invite never runs:
        the same rules apply, and Synapse soft-fails the refused invite (it never becomes the person's invite).
        The /invite path calls this too, before federated_user_may_invite: the event id makes it one decision."""
        try:
            if event.type != "m.room.member" or not event.is_state() or (event.content or {}).get("membership") != "invite":
                return NOT_SPAM
            if self.api.is_mine(event.sender) or not self.api.is_mine(event.state_key):
                return NOT_SPAM
        except Exception:  # noqa: BLE001  not an event we decide on
            return NOT_SPAM
        why = await self.decide(event)
        return NOT_SPAM if why is None else _refuse(why)

    async def decide(self, event) -> str | None:
        """None: the invite may come in; else the reason it is refused ("server-blocked" | "invite-rules" |
        "too-many-invites")."""
        inviter, recipient, room = str(event.sender), str(event.state_key or ""), str(event.room_id)
        eid = str(getattr(event, "event_id", "") or "")
        server = server_of(inviter)
        # An invite older than the quota window is history Synapse fetched (backfill, state, auth chains): judged by
        # the rules but never counted, and it never becomes a pending invite (astra r2/r3). A sender can backdate an
        # invite to skip the quotas, not the rules.
        ts = getattr(event, "origin_server_ts", None)
        live = not isinstance(ts, (int, float)) or self.now() * 1000 - ts <= self.quotas["window_s"] * 1000
        if not server or self.is_blocked(server):
            await self._note_refused(server, recipient, "server-blocked", eid, live)
            logger.info("tinhat_network: refused an invite from %s (a blocked server) to %s", server, recipient)
            return "server-blocked"
        if not self.api.is_mine(recipient):
            return None
        try:
            rule = await self.rule_of(recipient)
            known = False if rule == "nobody" else await self.is_known(recipient, inviter)
        except Exception:  # noqa: BLE001  fail closed (module docstring)
            logger.exception("tinhat_network: couldn't check the invite rules for %s; refusing the invite", recipient)
            await self._note_refused(server, recipient, "invite-rules", eid, live)
            return "invite-rules"
        if rule == "nobody" or (rule == "known" and not known):
            out = await self._quota(server, recipient, False, "invite-rules", eid, live)
            logger.info("tinhat_network: refused an invite from %s to %s (their rule: %s)", inviter, recipient, rule)
            return "too-many-invites" if out == "too-many-invites" else "invite-rules"
        # accepted: counted, and (the first time only, in the same transaction) the person's pending invite there
        out = await self._quota(server, recipient, not known, None, eid, live, room, inviter)
        if out != "ok":  # over a quota, or this very invite was refused before (the other path, a failed check)
            logger.info("tinhat_network: refused an invite from %s to %s (%s)", inviter, recipient, out)
            return out if out in REASONS else "too-many-invites"
        return None

    async def _quota(self, server: str, recipient: str, stranger: bool, refused_as, event_id: str,
                     count: bool = True, room: str = "", inviter: str = "") -> str:
        """The invite's outcome (Quotas.check); the database failing skips the quotas (docstring)."""
        if self.db is None:
            return refused_as or "ok"
        try:
            return await self._db(self.db.check, server, recipient, stranger, self.quotas, refused_as, event_id, count,
                                  room, inviter)
        except sqlite3.Error:
            logger.exception("tinhat_network: the quota database failed; invite quotas skipped for this invite")
            return refused_as or "ok"

    async def _note_refused(self, server: str, recipient: str, reason: str, event_id: str = "", count: bool = True) -> None:
        if self.db is None:
            return
        try:
            await self._db(self.db.refused, server or "?", recipient, reason, event_id, count)
        except sqlite3.Error:
            logger.exception("tinhat_network: couldn't record a refused invite")

    async def _outcome(self, event_id: str) -> str | None:
        """The decision recorded for this invite before (either check), None (never decided, or no database), or
        LOOKUP_FAILED (the database didn't answer: the caller must not decide again, review r4-1 M2)."""
        if self.db is None or not event_id:
            return None
        try:
            return await self._db(self.db.outcome, event_id)
        except sqlite3.Error:
            logger.exception("tinhat_network: couldn't read an invite's recorded outcome")
            return LOOKUP_FAILED

    async def _enforce(self, event, state_map) -> None:
        """An invite from another server that became a person's membership here. Synapse runs check_event_for_spam
        on what arrives by /send, except when the event's content hash doesn't match: then it stores its own redacted
        copy (membership survives the redaction) without asking any module (federation_base._check_sigs_and_hash),
        so the rules, the deny-list and the quotas never saw it (review round 4, ON-1). Here every such invite gets
        the same decision; a refused one that is the person's current membership in that room is declined on their
        behalf. An invite decided before keeps that decision (a hiccup now never undoes an accepted invite); a
        refused one that is not the current membership (soft-failed, or already answered) is left alone."""
        if self.api.is_mine(event.sender):
            return
        eid = str(getattr(event, "event_id", "") or "")
        prev = await self._outcome(eid)
        if prev == LOOKUP_FAILED:  # an accepted invite must never be undone by a hiccup: left as it is (logged)
            return
        why = (None if prev == "ok" else prev) if prev is not None else await self.decide(event)
        if why is None:
            return
        cur = (state_map or {}).get(("m.room.member", str(event.state_key))) if hasattr(state_map, "get") else None
        if cur is None or not eid or str(getattr(cur, "event_id", "") or "") != eid:
            return
        self.api.run_as_background_process("tinhat_network_decline", self._decline, event, why)

    async def _decline(self, event, why: str) -> None:
        """Leave (= decline) a refused invite for the person while it is still their membership in that room, with a
        few retries. Tin Hat runs Synapse as one process (no workers): the lock below is that process's. Each try re-checks the membership inside Synapse's own per-room membership lock and writes the
        leave there (_leave_locked), so a join the person makes meanwhile is never turned into a leave (review r4-1
        H1); the leave isn't rate-limited like a person's own (r4-1 M3)."""
        target, room, eid = str(event.state_key), str(event.room_id), str(event.event_id)
        for attempt, wait in enumerate(DECLINE_RETRY_S + (None,)):
            try:
                done = await self._leave_locked(target, room, eid)
                if done:
                    logger.info("tinhat_network: declined an invite from %s to %s for them (%s; it skipped the "
                                "checks on arrival)", event.sender, target, why)
                return  # declined, or not their invite any more
            except Exception:  # noqa: BLE001  retried; logged
                logger.exception("tinhat_network: couldn't decline a refused invite to %s (try %d)", target, attempt + 1)
            if wait is None:
                return
            await self.api.sleep(wait)

    async def _leave_locked(self, target: str, room: str, eid: str) -> bool:
        """True: left. False: the invite isn't their membership any more (answered or replaced: untouched)."""
        hs = getattr(self.api, "_hs", None)  # noqa: SLF001  (no public call checks and changes a membership in one step)
        rm = hs.get_room_member_handler() if hs is not None and hasattr(hs, "get_room_member_handler") else None
        if rm is None or not hasattr(rm, "member_linearizer") or not hasattr(rm, "update_membership_locked"):
            # a Synapse without these internals: never a leave that could race a join (review r4-2); the invite stays
            logger.error("tinhat_network: this Synapse lacks the membership lock this module uses; not declining "
                         "the refused invite %s to %s", eid, target)
            return False
        async with rm.member_linearizer.queue((room,)):  # the lock every local membership change of this room takes
            async with self._purge_lock(rm, room):
                return await self._leave_if_invite(rm, target, room, eid)

    @staticmethod
    def _purge_lock(rm, room: str):
        """update_membership's second lock (a room being purged gets no new events), when this Synapse has it."""
        wl = getattr(rm, "_worker_lock_handler", None)
        if wl is None:
            import contextlib
            return contextlib.nullcontext()
        from synapse.handlers.worker_lock import NEW_EVENT_DURING_PURGE_LOCK_NAME
        return wl.acquire_read_write_lock(NEW_EVENT_DURING_PURGE_LOCK_NAME, room, write=False)

    async def _leave_if_invite(self, rm, target: str, room: str, eid: str) -> bool:
        """Under both locks: leave only while the person's local membership is still exactly this invite."""
        from synapse.types import UserID, create_requester  # Synapse's own, inside the Synapse process
        membership, cur = await self.api._store.get_local_current_membership_for_user_in_room(target, room)  # noqa: SLF001
        if membership != "invite" or cur != eid:
            return False
        hs = self.api._hs  # noqa: SLF001
        # authenticated as the server: a server-wide block (MAU limits) never stops the server's own decline
        requester = create_requester(target, authenticated_entity=getattr(hs, "hostname", None) or None)
        await rm.update_membership_locked(requester, UserID.from_string(target), room, "leave",
                                          ratelimit=False, require_consent=False)
        return True

    async def on_new_event(self, event, state_map):
        """An invite from another server that skipped the checks on arrival: decided here (_enforce). A person here
        answered an invite: joining makes its (remote) inviter "known" from now on; declining or anything else forgets
        it."""
        try:
            if event.type != "m.room.member" or not event.is_state():
                return
            if not self.api.is_mine(event.state_key):
                return
            membership = (event.content or {}).get("membership")
            if membership == "invite":
                await self._enforce(event, state_map)
                return
            if self.db is None:
                return
            unsigned = getattr(event, "unsigned", None) or {}
            replaces = str(unsigned.get("replaces_state") or "") if hasattr(unsigned, "get") else ""
            inviter = await self._db(self.db.answered, str(event.room_id), str(event.state_key), membership == "join",
                                     replaces)
            if inviter:
                logger.info("tinhat_network: %s accepted an invite from %s", event.state_key, inviter)
        except Exception:  # noqa: BLE001  bookkeeping only
            logger.exception("tinhat_network: on_new_event failed")

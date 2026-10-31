"""tinhat_rules — a Synapse module: guests stay in the guest room (docs/GUESTS.md), and the owner's account can't be
deactivated (docs/ACCOUNT-SAFETY.md).

The guest room hands strangers a real Matrix account for a few hours. Without this module that account could do what
any account can: join the server's other public rooms by their address, accept invitations, start rooms and DMs.
With it, Synapse itself enforces, whatever an app or a copied token tries:
  - a guest account (any `@guest-…` account: only the Tin Hat API can register those names) may join ONLY the room
    the API made it for (guest-accounts.json lists each account with its room), and only if that room is the Guests
    room (guests-room.json). An account listed for any other room can join nothing, and when either list is missing
    or unreadable a guest can join nothing (fail closed);
  - a guest may not create rooms (so no DMs either) and may not invite anyone; nobody may invite a guest elsewhere;
  - nobody may register a `guest-…` name except the Tin Hat API, for the account it is making right now
    (guest-allow.json), so a real person can never be mistaken for a guest, and no guest name can be squatted.

The API publishes three small, non-secret files into /var/lib/tinhat/api/public (mounted read-only here): the guest
accounts, the names it is about to register, and the Guests room's id. They are re-read when they change.

The owner: nobody may deactivate the server owner's account or the box's own system account (`@tinhat-system:…`),
from any app, with a password or through the admin API (Synapse answers 403 M_FORBIDDEN "Deactivation of this user is
forbidden"). Deleting the owner would leave the server without anyone who can sign in to its dashboard; the apps
already refuse it, this makes it true for every Matrix client. The manager writes the owner's id into
protected-accounts.json next to this file (apiconf.publish_protected, whenever it writes the well-known); without that
file only the system account is protected.

Other servers' rooms (old apps, MATRIX-FRONTEND-DESIGN.md B0 "Old clients", 0.3.10): Tin Hat before 12.1.3 rewrote
power levels wherever its user may, also in rooms that live on another server. For senders on THIS server, in a room
whose creator (and every v12 additional creator) isn't on this server, one of its former names, or a connected Tin
Hat server (the federation allow-list), it refuses
  - any `dev.tinhat.*` state event, and
  - any `m.room.power_levels` event whose only differences from the current one are `dev.tinhat.*` keys under
    `events` (what an old app's automatic provisioning writes).
Everything else passes, a person's own power-level edits too. Never other servers' events. Should the check itself
fail, the event passes (it protects other people's rooms from old apps; it must never block normal use).
"""
import json
import logging
import os
import time

from synapse.api.errors import Codes
from synapse.module_api import NOT_SPAM, ModuleApi
from synapse.spam_checker_api import RegistrationBehaviour

logger = logging.getLogger(__name__)

PREFIX = "guest-"
SYSTEM_LOCALPART = "tinhat-system"  # config.SYSTEM_LOCALPART
ALLOW_FOR_S = 120  # a name in guest-allow.json may be registered for this long after it was written


class _File:
    """A JSON file re-read when its mtime changes; a missing or broken file reads as `default`."""

    def __init__(self, path: str, default):
        self.path, self.default, self.mtime, self.value = path, default, None, default

    def get(self):
        try:
            m = os.stat(self.path).st_mtime_ns
        except OSError:
            self.mtime, self.value = None, self.default
            return self.value
        if m != self.mtime:
            try:
                with open(self.path, encoding="utf-8") as f:
                    self.value = json.load(f)
            except (OSError, ValueError):
                self.value = self.default
            self.mtime = m
        return self.value


# ---- other servers' rooms: no automatic Tin Hat power-level writes from old apps ----------------------------------------
TINHAT_PREFIX = "dev.tinhat."
#: room versions before 12: `additional_creators` means nothing there (an unknown field)
PRE_V12 = {str(v) for v in range(1, 12)}


def _domain(user_id) -> str:
    u = str(user_id or "")
    return u.split(":", 1)[1].lower() if u.startswith("@") and ":" in u else ""


def _plain(v):
    """Synapse's frozen event content as plain dicts and lists (comparable)."""
    if isinstance(v, dict) or (hasattr(v, "keys") and hasattr(v, "items")):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def only_tinhat_keys_differ(old: dict, new: dict) -> bool:
    """Whether two m.room.power_levels contents differ in at least one `dev.tinhat.*` key under `events`, and in
    nothing else (a missing `events` map counts as an empty one: Astra on 84f06f9)."""
    old, new = _plain(old or {}), _plain(new or {})

    def events(c: dict) -> dict:
        ev = c.get("events")
        return ev if isinstance(ev, dict) else {}

    def rest(c: dict) -> dict:
        out = {k: v for k, v in c.items() if k != "events"}
        out["events"] = {k: v for k, v in events(c).items() if not k.startswith(TINHAT_PREFIX)}
        return out
    oe, ne = events(old), events(new)
    tinhat_changed = any(oe.get(k) != ne.get(k) for k in set(oe) | set(ne) if k.startswith(TINHAT_PREFIX))
    return tinhat_changed and rest(old) == rest(new)


def _level(v, default: int) -> int:
    """A power level as Synapse reads it (int(): an int, a bool of old room versions' content, or a string of an int);
    anything else: the default."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v.strip())
        except ValueError:
            return default
    return default


def tinhat_level_lowered(old: dict, new: dict) -> bool:
    """Whether some `dev.tinhat.*` key's EFFECTIVE level under `events` goes DOWN from old to new (0.3.10 release review:
    a raise, or removing an override that leaves the key higher, is someone tightening the room, not an old app's
    automatic lowering). A key not in `events` takes the room's default: `state_default` for a state event type,
    `events_default` for a message type; the content can't say which, so a change counts as lowering if it lowers under
    EITHER default (fail safe for the room). Missing defaults are the spec's: state_default 50, events_default 0."""
    old, new = _plain(old or {}), _plain(new or {})

    def events(c: dict) -> dict:
        ev = c.get("events")
        return ev if isinstance(ev, dict) else {}
    oe, ne = events(old), events(new)
    for k in set(oe) | set(ne):
        if not k.startswith(TINHAT_PREFIX) or oe.get(k) == ne.get(k):
            continue
        for dk, dv in (("state_default", 50), ("events_default", 0)):
            if _level(ne.get(k, new.get(dk)), _level(new.get(dk), dv)) < _level(oe.get(k, old.get(dk)), _level(old.get(dk), dv)):
                return True
    return False


class _ForeignRooms:
    """Mixed into GuestRules: check_event_allowed (third-party rules)."""

    def room_is_ours(self, state_events) -> bool:
        """The room's creator and every v12 additional creator on this server, a former name, or a connected server.
        No create event in the state (never for a real event): counted as ours (nothing to protect against)."""
        create = state_events.get(("m.room.create", "")) if state_events else None
        if create is None:
            return True
        creators = [create.sender]
        content = create.content or {}
        if str(content.get("room_version", "1")) not in PRE_V12:  # additional creators exist from room version 12 on
            extra = _plain(content.get("additional_creators"))
            if isinstance(extra, list):
                creators += extra
            elif extra is not None:
                return False  # malformed: not one of ours
        for c in creators:
            d = _domain(c)
            if not d or not (self.api.is_mine(c) or d in self.former or d in self.connected):
                return False
        return True

    async def check_event_allowed(self, event, state_events):
        try:
            if not self.api.is_mine(event.sender) or not event.is_state():
                return True, None
            t = event.type
            if not (t.startswith(TINHAT_PREFIX) or t == "m.room.power_levels"):
                return True, None
            if self.room_is_ours(state_events):
                return True, None
            if t.startswith(TINHAT_PREFIX):
                logger.info("tinhat_rules: refused %s from %s in %s (a room on another server)", t, event.sender,
                            event.room_id)
                return False, None
            cur = state_events.get(("m.room.power_levels", ""))
            if cur is not None and only_tinhat_keys_differ(cur.content, event.content) \
                    and tinhat_level_lowered(cur.content, event.content):
                logger.info("tinhat_rules: refused an automatic power-level change (dev.tinhat.* only) from %s in %s "
                            "(a room on another server; an older Tin Hat app)", event.sender, event.room_id)
                return False, None
            return True, None
        except Exception:  # noqa: BLE001  never block normal use on a bug here
            logger.exception("tinhat_rules: check_event_allowed failed; letting the event through")
            return True, None


class GuestRules(_ForeignRooms):
    def __init__(self, config: dict, api: ModuleApi):
        self.api = api
        d = config.get("dir", "/tinhat-api")
        self.accounts = _File(os.path.join(d, "guest-accounts.json"), [])
        self.allow = _File(os.path.join(d, "guest-allow.json"), {})
        self.room = _File(os.path.join(d, "guests-room.json"), {})
        self.protected = _File(config.get("protected", os.path.join(os.path.dirname(os.path.abspath(__file__)), "protected-accounts.json")), {})
        self.connected = {str(x).lower() for x in config.get("connected") or [] if isinstance(x, str)}
        self.former = {str(x).lower() for x in config.get("former") or [] if isinstance(x, str)}
        api.register_third_party_rules_callbacks(check_can_deactivate_user=self.check_can_deactivate_user,
                                                 check_event_allowed=self.check_event_allowed)
        api.register_spam_checker_callbacks(
            user_may_join_room=self.user_may_join_room,
            user_may_invite=self.user_may_invite,
            user_may_create_room=self.user_may_create_room,
            check_registration_for_spam=self.check_registration_for_spam,
        )

    @staticmethod
    def parse_config(config: dict) -> dict:
        return config or {}

    # ---- who is a guest, which rooms are theirs --------------------------------------------------------------------
    def is_guest(self, user_id: str) -> bool:
        """Every `@guest-…` account (reserved for the API: check_registration_for_spam), listed or not."""
        local = str(user_id or "").lstrip("@").split(":", 1)[0].lower()
        return local.startswith(PREFIX) or self.room_of(user_id) is not None

    def room_of(self, user_id: str) -> str | None:
        """The room the API made this guest account for; None when it isn't listed. (Older lists were plain user ids:
        those accounts get no room at all, so they can't join anything new.)"""
        acc = self.accounts.get()
        if not isinstance(acc, list):
            return None
        for a in acc:
            if isinstance(a, dict) and a.get("user") == user_id:
                return str(a.get("room") or "")
        return None

    def guests_room(self) -> str:
        r = self.room.get()
        return r.get("room", "") if isinstance(r, dict) else ""

    def room_takes_guests(self, room_id: str) -> bool:
        """Only the Guests room takes guests."""
        return bool(room_id) and room_id == self.guests_room()

    # ---- the callbacks -----------------------------------------------------------------------------------------------
    async def guest_may_be_in(self, user_id: str, room_id: str) -> bool:
        mine = self.room_of(user_id)
        return bool(mine) and mine == room_id and self.room_takes_guests(room_id)

    async def user_may_join_room(self, user_id: str, room_id: str, is_invited: bool):
        if not self.is_guest(user_id) or await self.guest_may_be_in(user_id, room_id):
            return NOT_SPAM
        logger.info("tinhat_rules: guest %s may not join %s", user_id, room_id)
        return Codes.FORBIDDEN, {}

    async def user_may_invite(self, inviter_userid: str, invitee_userid: str, room_id: str):
        if self.is_guest(inviter_userid):
            return Codes.FORBIDDEN, {}
        if self.is_guest(invitee_userid) and not await self.guest_may_be_in(invitee_userid, room_id):
            return Codes.FORBIDDEN, {}
        return NOT_SPAM

    async def user_may_create_room(self, userid: str, room_config: dict):
        return (Codes.FORBIDDEN, {}) if self.is_guest(userid) else NOT_SPAM

    async def check_registration_for_spam(self, email_threepid, username, request_info, auth_provider_id=None):
        if not username or not str(username).lower().startswith(PREFIX):
            return RegistrationBehaviour.ALLOW
        allow = self.allow.get()
        at = allow.get(str(username).lower()) if isinstance(allow, dict) else None
        if isinstance(at, (int, float)) and 0 <= time.time() - at / 1000 <= ALLOW_FOR_S:
            return RegistrationBehaviour.ALLOW
        logger.info("tinhat_rules: %r is a guest name; only the Tin Hat API registers those", username)
        return RegistrationBehaviour.DENY

    # ---- the owner ---------------------------------------------------------------------------------------------------
    def is_protected(self, user_id: str) -> bool:
        """The owner (protected-accounts.json, written by the manager) and this server's system account. Once an owner
        was read, it stays protected when the file later goes missing or breaks (the last good value is kept)."""
        uid = str(user_id or "")
        if uid.startswith(f"@{SYSTEM_LOCALPART}:") and self.api.is_mine(uid):
            return True
        p = self.protected.get()
        owner = p.get("owner") if isinstance(p, dict) else None
        if isinstance(owner, str) and owner.startswith("@") and ":" in owner:
            self.last_owner = owner
        elif isinstance(owner, str) and owner == "" and isinstance(p, dict):
            self.last_owner = ""  # the manager said: no owner known (setup not finished, or an owner who isn't local)
        return bool(getattr(self, "last_owner", "")) and self.last_owner == uid

    async def check_can_deactivate_user(self, user_id: str, by_admin: bool) -> bool:
        # Synapse treats an exception here as "allowed": decide inside a try and refuse when that fails.
        try:
            protected = self.is_protected(user_id)
        except Exception:  # noqa: BLE001
            logger.exception("tinhat_rules: couldn't tell whether %s is the owner; refusing its deactivation", user_id)
            return False
        if not protected:
            return True
        logger.warning("tinhat_rules: refused to deactivate %s (the server owner or its system account; by_admin=%s)",
                       user_id, by_admin)
        return False

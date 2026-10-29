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


class GuestRules:
    def __init__(self, config: dict, api: ModuleApi):
        self.api = api
        d = config.get("dir", "/tinhat-api")
        self.accounts = _File(os.path.join(d, "guest-accounts.json"), [])
        self.allow = _File(os.path.join(d, "guest-allow.json"), {})
        self.room = _File(os.path.join(d, "guests-room.json"), {})
        self.protected = _File(config.get("protected", os.path.join(os.path.dirname(os.path.abspath(__file__)), "protected-accounts.json")), {})
        api.register_third_party_rules_callbacks(check_can_deactivate_user=self.check_can_deactivate_user)
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

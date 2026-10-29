"""tinhat_calls — a Synapse module: the Tin Hat API hears about call membership changes, so a DM call rings on phones
whose app is closed (DM ringing, server half: docs/API.md "Ringing", docs/PHONE-PUSH.md).

Two small things, nothing else:
  - on every new `org.matrix.msc3401.call.member` state event (the type the apps ring on), in any room this server is
    in, local or over federation, it pokes the API with the room and the event id. The poke carries nothing the API
    trusts: the API reads the room's state itself through the admin API before it rings anyone, so a forged poke can
    only make it look again. Fire and forget: Synapse never waits for the API, and a failed poke is a missed ring at
    worst (the apps' in-app ringing is unchanged). Bounded: one poke per room in flight (a change meanwhile = one more
    poke after it), at most 8 in flight in all (beyond that a poke is dropped and logged); Synapse's client times out a
    request after 60 s.
  - `GET /_synapse/tinhat/v1/push_muted?user_id=…&room_id=…[&caller=…]` for the API (a server admin's token only; not under
    /_matrix or /_synapse/client, so the box's web server never forwards it): whether that local user muted that room,
    the same rule the apps use (an enabled override rule for the room without "notify"). A VoIP push must ring once it
    is sent, so "muted" is decided before anything goes out. With `caller`, also "ignored": whether that user ignores
    the caller (m.ignored_user_list).

Where the API listens: call-hook.json, which the API writes into /var/lib/tinhat/api/public (mounted read-only here).
No file, or a file without an http URL: no pokes.
"""
import json
import logging
import os

from synapse.http.server import DirectServeJsonResource
from synapse.module_api import ModuleApi

logger = logging.getLogger(__name__)

CALL_MEMBER_TYPE = "org.matrix.msc3401.call.member"
MUTED_PATH = "/_synapse/tinhat/v1/push_muted"
MAX_IN_FLIGHT = 8


def room_muted(rules: dict, room_id: str) -> bool:
    """The apps' rule (web callwatch.ts roomMuted, desktop callwatch.rs): an enabled override rule for the room, by its
    rule id or an event_match on room_id, whose actions have no "notify". "Mentions only" (a room rule) still rings."""
    glob = rules.get("global") if isinstance(rules, dict) else None
    for r in (glob or {}).get("override") or []:
        if not isinstance(r, dict) or r.get("enabled") is False:
            continue
        conds = r.get("conditions") or []
        hit = r.get("rule_id") == room_id or any(
            isinstance(c, dict) and c.get("kind") == "event_match" and c.get("key") == "room_id"
            and c.get("pattern") == room_id for c in conds)
        if hit and "notify" not in (r.get("actions") or []):
            return True
    return False


class _File:
    """A JSON file re-read when its mtime changes; a missing or broken file reads as {}."""

    def __init__(self, path: str):
        self.path, self.mtime, self.value = path, None, {}

    def get(self) -> dict:
        try:
            m = os.stat(self.path).st_mtime_ns
        except OSError:
            self.mtime, self.value = None, {}
            return self.value
        if m != self.mtime:
            try:
                with open(self.path, encoding="utf-8") as f:
                    v = json.load(f)
                self.value = v if isinstance(v, dict) else {}
            except (OSError, ValueError):
                self.value = {}
            self.mtime = m
        return self.value


class _Muted(DirectServeJsonResource):
    def __init__(self, hook: "CallHook"):
        super().__init__()
        self.hook = hook

    async def _async_render_GET(self, request):
        return await self.hook.muted_request(request)


class CallHook:
    def __init__(self, config: dict, api: ModuleApi):
        self.api = api
        self.hook = _File(os.path.join(config.get("dir", "/tinhat-api"), "call-hook.json"))
        self.in_flight: dict[str, bool] = {}  # room -> another poke wanted after this one
        api.register_third_party_rules_callbacks(on_new_event=self.on_new_event)
        api.register_web_resource(MUTED_PATH, _Muted(self))

    @staticmethod
    def parse_config(config: dict) -> dict:
        return config or {}

    def hook_url(self) -> str:
        u = self.hook.get().get("url")
        return u if isinstance(u, str) and u.startswith("http://") and len(u) < 512 else ""

    # ---- the poke ----------------------------------------------------------------------------------------------
    async def on_new_event(self, event, *_state) -> None:
        # Synapse awaits this for EVERY event: decide from the event alone and never wait on the network here.
        if event.type != CALL_MEMBER_TYPE or not event.is_state():
            return
        room = event.room_id
        if room in self.in_flight:
            self.in_flight[room] = True  # the poke running for this room is followed by one more
            return
        if len(self.in_flight) >= MAX_IN_FLIGHT:
            logger.info("tinhat_calls: %d call pokes in flight, dropped one for %s", len(self.in_flight), room)
            return
        self.in_flight[room] = False
        self.api.run_as_background_process("tinhat_call_poke", self._poke, room, event.event_id)

    async def _poke(self, room: str, event_id: str) -> None:
        try:
            while True:
                url = self.hook_url()
                if not url:
                    return
                try:
                    await self.api.http_client.post_json_get_json(url, {"room_id": room, "event_id": event_id})
                except Exception as e:  # noqa: BLE001 — a poke that fails is one ring missed, never Synapse's problem
                    logger.info("tinhat_calls: the API didn't take a call poke (%s)", type(e).__name__)
                if not self.in_flight.get(room):
                    return
                self.in_flight[room] = False
        finally:
            self.in_flight.pop(room, None)

    # ---- push_muted --------------------------------------------------------------------------------------------
    async def muted_request(self, request):
        requester = await self.api.get_user_by_req(request)
        if not await self.api.is_user_admin(requester.user.to_string()):
            return 403, {"errcode": "M_FORBIDDEN", "error": "server admins only"}
        args = request.args or {}
        user_id = (args.get(b"user_id") or [b""])[0].decode("utf-8", "replace")
        room_id = (args.get(b"room_id") or [b""])[0].decode("utf-8", "replace")
        caller = (args.get(b"caller") or [b""])[0].decode("utf-8", "replace")
        if not user_id.startswith("@") or not room_id.startswith("!") or not self.api.is_mine(user_id):
            return 400, {"errcode": "M_INVALID_PARAM", "error": "a local user_id and a room_id"}
        out = {"muted": room_muted(await self.push_rules(user_id), room_id)}
        if caller.startswith("@"):
            out["ignored"] = await self.ignores(user_id, caller)
        return 200, out

    async def ignores(self, user_id: str, caller: str) -> bool:
        """Whether `user_id` ignores `caller` (m.ignored_user_list; Synapse sends no push for an ignored user's events,
        so neither may a ring: assembly-038 review). The module API's public account-data reader (Synapse >= 1.57)."""
        data = await self.api.account_data_manager.get_global(user_id, "m.ignored_user_list")
        users = data.get("ignored_users") if data else None
        return bool(users) and hasattr(users, "keys") and caller in users

    async def push_rules(self, user_id: str) -> dict:
        """The user's push rules in the client format (what GET /pushrules/ answers them)."""
        from synapse.push.clientformat import format_push_rules_for_user
        from synapse.types import UserID
        store = self.api._hs.get_datastores().main  # no public module API reads another user's push rules
        return format_push_rules_for_user(UserID.from_string(user_id), await store.get_push_rules_for_user(user_id))

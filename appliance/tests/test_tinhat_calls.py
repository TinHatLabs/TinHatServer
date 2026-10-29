"""Synapse's tinhat_calls (manager/synapse/tinhat_calls.py): the call-membership poke and push_muted. Runs without
Synapse: its few imports are stood in for."""
import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

for name in ("synapse", "synapse.http", "synapse.http.server", "synapse.module_api"):
    sys.modules.setdefault(name, types.ModuleType(name))


class _Resource:
    def __init__(self, *a, **kw):
        pass


sys.modules["synapse.http.server"].DirectServeJsonResource = _Resource
sys.modules["synapse.module_api"].ModuleApi = object
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat" / "manager" / "synapse"))
import tinhat_calls  # noqa: E402

ROOM = "!dm:example.org"


class Ev:
    def __init__(self, type_, state=True, room="!r:x", eid="$e"):
        self.type, self._state, self.room_id, self.event_id = type_, state, room, eid

    def is_state(self):
        return self._state


class FakeApi:
    def __init__(self, admin=True):
        self.bg, self.posts, self.admin, self.tasks = [], [], admin, []
        self.http_client = self

    def register_third_party_rules_callbacks(self, **kw):
        self.cb = kw

    def register_web_resource(self, path, res):
        self.path, self.res = path, res

    def run_as_background_process(self, desc, fn, *args):
        self.bg.append(desc)
        self.tasks.append(asyncio.get_running_loop().create_task(fn(*args)))

    async def post_json_get_json(self, url, body):
        self.posts.append((url, body))
        return {}

    async def get_user_by_req(self, request):
        return types.SimpleNamespace(user=types.SimpleNamespace(to_string=lambda: "@admin:example.org"))

    async def is_user_admin(self, user_id):
        return self.admin

    def is_mine(self, user_id):
        return user_id.endswith(":example.org")


def hook(url="http://198.18.16.1:3091/_tinhat/v1/call-member", admin=True):
    d = tempfile.mkdtemp()
    if url is not None:
        Path(d, "call-hook.json").write_text(json.dumps({"url": url}))
    api = FakeApi(admin)
    return tinhat_calls.CallHook({"dir": d}, api), api


def new_event(h, api, ev):
    async def go():
        await h.on_new_event(ev, {})
        tasks, api.tasks = api.tasks, []
        await asyncio.gather(*tasks)
    asyncio.run(go())


def override(rule_id, actions, conditions=None, enabled=True):
    return {"rule_id": rule_id, "actions": actions, "enabled": enabled, "conditions": conditions or []}


class Muted(unittest.TestCase):
    def test_the_apps_rule(self):
        m = tinhat_calls.room_muted
        self.assertFalse(m({}, ROOM))
        self.assertFalse(m({"global": {"override": []}}, ROOM))
        self.assertTrue(m({"global": {"override": [override(ROOM, [])]}}, ROOM), "Element-style mute: rule id = room")
        self.assertTrue(m({"global": {"override": [override("x", ["dont_notify"], [
            {"kind": "event_match", "key": "room_id", "pattern": ROOM}])]}}, ROOM), "by condition")
        self.assertFalse(m({"global": {"override": [override(ROOM, [], enabled=False)]}}, ROOM), "a disabled rule")
        self.assertFalse(m({"global": {"override": [override(ROOM, ["notify"])]}}, ROOM), "a rule that notifies")
        self.assertFalse(m({"global": {"override": [override("!other:example.org", [])]}}, ROOM), "another room")
        self.assertFalse(m({"global": {"room": [{"rule_id": ROOM, "actions": [], "enabled": True}]}}, ROOM),
                         "Mentions only (a room rule) still rings")


class Poke(unittest.TestCase):
    def test_only_call_membership_state_is_poked(self):
        h, api = hook()
        self.assertIn("on_new_event", api.cb)
        self.assertEqual(api.path, "/_synapse/tinhat/v1/push_muted")
        for t in ("m.room.message", "m.room.member", "io.element.call.encryption_keys"):
            new_event(h, api, Ev(t))
        new_event(h, api, Ev(tinhat_calls.CALL_MEMBER_TYPE, state=False))
        self.assertEqual(api.posts, [])
        for t in ("m.call.member", "m.rtc.member"):  # the apps ring on msc3401 only, and so does the server
            new_event(h, api, Ev(t, room=ROOM, eid="$m"))
        self.assertEqual(api.posts, [])
        for _ in range(3):
            new_event(h, api, Ev(tinhat_calls.CALL_MEMBER_TYPE, room=ROOM, eid="$m"))
        self.assertEqual(api.posts, [("http://198.18.16.1:3091/_tinhat/v1/call-member", {"room_id": ROOM, "event_id": "$m"})] * 3)
        self.assertEqual(api.bg, ["tinhat_call_poke"] * 3, "never awaited inline")
        self.assertEqual(h.in_flight, {}, "nothing left in flight")

    def test_pokes_are_coalesced_per_room_and_capped(self):
        h, api = hook()
        gate = asyncio.Event()
        posted = []

        async def slow(url, body):
            posted.append(body["room_id"])
            await gate.wait()
        api.post_json_get_json = slow

        async def go():
            for i in range(5):  # five changes in one room while its poke hangs: one poke now, one after it
                await h.on_new_event(Ev(tinhat_calls.CALL_MEMBER_TYPE, room=ROOM, eid=f"$e{i}"), {})
            for i in range(20):  # twenty other rooms: at most 8 in flight in all
                await h.on_new_event(Ev(tinhat_calls.CALL_MEMBER_TYPE, room=f"!r{i}:x", eid="$e"), {})
            await asyncio.sleep(0)
            self.assertEqual(len(h.in_flight), tinhat_calls.MAX_IN_FLIGHT)
            gate.set()
            tasks, api.tasks = api.tasks, []
            await asyncio.gather(*tasks)
        asyncio.run(go())
        self.assertEqual(posted.count(ROOM), 2, "a burst in one room = two pokes")
        self.assertEqual(len(posted), 2 + tinhat_calls.MAX_IN_FLIGHT - 1)
        self.assertEqual(h.in_flight, {})

    def test_no_hook_file_or_a_strange_url_means_no_poke(self):
        for url in (None, "https://elsewhere.example/x", "file:///etc/passwd", 7):
            h, api = hook(url)
            new_event(h, api, Ev(tinhat_calls.CALL_MEMBER_TYPE))
            self.assertEqual(api.posts, [], url)

    def test_a_failed_poke_is_swallowed(self):
        h, api = hook()

        async def boom(url, body):
            raise ConnectionRefusedError()
        api.post_json_get_json = boom
        new_event(h, api, Ev(tinhat_calls.CALL_MEMBER_TYPE))


class MutedRequest(unittest.TestCase):
    def req(self, **q):
        return types.SimpleNamespace(args={k.encode(): [v.encode()] for k, v in q.items()})

    def test_admins_only_and_local_users_only(self):
        h, _ = hook(admin=False)
        code, body = asyncio.run(h.muted_request(self.req(user_id="@a:example.org", room_id=ROOM)))
        self.assertEqual(code, 403)
        h, _ = hook()
        for q in ({"user_id": "@a:other.org", "room_id": ROOM}, {"user_id": "a", "room_id": ROOM}, {"user_id": "@a:example.org"}):
            self.assertEqual(asyncio.run(h.muted_request(self.req(**q)))[0], 400, q)

        async def rules(user_id):
            return {"global": {"override": [override(ROOM, [])]}}
        h.push_rules = rules
        self.assertEqual(asyncio.run(h.muted_request(self.req(user_id="@a:example.org", room_id=ROOM))), (200, {"muted": True}))
        self.assertEqual(asyncio.run(h.muted_request(self.req(user_id="@a:example.org", room_id="!x:example.org"))),
                         (200, {"muted": False}))


    def test_ignored_caller(self):
        # assembly-038 review: with ?caller= the answer says whether the user ignores that caller (m.ignored_user_list,
        # read through the module API's public account-data reader); without it, the answer is as before
        h, api = hook()
        seen = []

        class Acc:
            async def get_global(self, user_id, data_type):
                seen.append((user_id, data_type))
                return {"ignored_users": {"@bad:example.org": {}}} if user_id == "@a:example.org" else None
        api.account_data_manager = Acc()

        async def rules(user_id):
            return {}
        h.push_rules = rules
        ask = lambda **q: asyncio.run(h.muted_request(self.req(user_id="@a:example.org", room_id=ROOM, **q)))
        self.assertEqual(ask(caller="@bad:example.org"), (200, {"muted": False, "ignored": True}))
        self.assertEqual(ask(caller="@friend:other.org"), (200, {"muted": False, "ignored": False}))
        self.assertEqual(ask(), (200, {"muted": False}))
        self.assertEqual(seen[0], ("@a:example.org", "m.ignored_user_list"))
        r = asyncio.run(h.muted_request(self.req(user_id="@b:example.org", room_id=ROOM, caller="@bad:example.org")))
        self.assertEqual(r, (200, {"muted": False, "ignored": False}), "no ignore list = nobody ignored")

class Template(unittest.TestCase):
    def test_homeserver_yaml_loads_the_module(self):
        src = (Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/templates.py").read_text()
        self.assertIn("  - module: tinhat_calls.CallHook\n    config:\n      dir: /tinhat-api\n", src)


if __name__ == "__main__":
    unittest.main()

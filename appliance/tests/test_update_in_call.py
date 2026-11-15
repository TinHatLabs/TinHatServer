"""Install now never ends a live call unasked (D04.7, QOL sweep 2026-11-13): web.Manager.updates_install asks LiveKit who
is in a call and answers 409 with their names unless the owner confirmed; "Install when the calls end" waits in
updates.tick until no call has been going for a minute; "Don't wait" takes it back. LiveKit not answering counts as a
call. lkadmin.mxid_of reads the account out of a LiveKit identity the way the api's identity.mjs writes it.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

_OPT = pathlib.Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))
_saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _saved:
    del sys.modules[_k]
try:
    import aiohttp
    HAVE_AIOHTTP = getattr(aiohttp, "__file__", None) is not None
    from tinhat import web  # noqa: F401
except ImportError:
    HAVE_AIOHTTP = False
_real = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
for _k in _real:
    del sys.modules[_k]
sys.modules.update(_saved)

SN = "crew.test"
OWNER = f"@owner:{SN}"


class _Lazy:
    """A who_in_calls answer computed when LiveKit is asked (the test's stand-in for things happening meanwhile)."""
    def __init__(self, fn):
        self.fn = fn


class Req:
    def __init__(self, body):
        self.body = body

    async def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class FakeSynapse:
    def __init__(self, names):
        self.names = names

    async def user(self, mxid, tok):
        return (200, {"name": mxid, "displayname": self.names[mxid]}) if mxid in self.names else (404, {})


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class InstallNowAsks(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.status = {"phase": "staged", "available": {"version": "9.9.9"}}
        self.started = []

    def call(self, body, who, calls_on=True):
        st = self.status

        def set_status(**changes):
            st.update(changes)
            return st

        def start_install(by):
            self.started.append(by)
            st.update(phase="installing")

        async def who_in_calls():
            if isinstance(who, Exception):
                raise who
            return who.fn() if isinstance(who, _Lazy) else who
        m = web.Manager.__new__(web.Manager)
        m._admin = lambda req: {"mxid": OWNER}
        m._csrf_ok = lambda req: True
        m._system_token = lambda: "syt_test"
        m.synapse = FakeSynapse({f"@ana:{SN}": "Ana", f"@sam:{SN}": "  "})
        m.mover = mock.Mock(running=False)
        m.network_busy = False

        async def run():
            r = await m.updates_install(Req(body))
            if getattr(m, "_bg_update", None):
                await m._bg_update
            return r
        with mock.patch.object(web.updates, "status", lambda: st), \
                mock.patch.object(web.updates, "set_status", set_status), \
                mock.patch.object(web.updates, "start_install", start_install), \
                mock.patch.object(web.updates, "doc", lambda: {"status": dict(st)}), \
                mock.patch.object(web.lkadmin, "who_in_calls", who_in_calls), \
                mock.patch.object(web.state, "load_state", return_value={"server_name": SN, "calls": calls_on}):
            resp = asyncio.run(run())
        return resp.status, json.loads(resp.text)

    def test_a_live_call_is_named_and_nothing_installs(self):
        code, out = self.call({}, {"calls": 1, "people": [f"@ana:{SN}", f"@sam:{SN}", f"@zed:other.example"], "others": 1})
        self.assertEqual(code, 409)
        # display name when it has one, else the account's own name; the unnamed connection is "1 more"
        self.assertEqual(out["in_call"], {"known": True, "calls": 1, "names": ["Ana", "sam", "zed"], "more": 1})
        self.assertEqual(self.started, [])
        self.assertEqual(self.status["phase"], "staged")

    def test_livekit_not_answering_counts_as_a_call(self):
        code, out = self.call({}, None)
        self.assertEqual((code, out["in_call"]), (409, {"known": False}))
        self.assertEqual(self.started, [])

    def test_only_unnamed_connections_still_ask(self):
        code, out = self.call({}, {"calls": 2, "people": [], "others": 3})
        self.assertEqual((code, out["in_call"]["more"], out["in_call"]["names"]), (409, 3, []))

    def test_install_anyway_installs(self):
        code, _ = self.call({"confirm": True}, {"calls": 1, "people": [f"@ana:{SN}"], "others": 0})
        self.assertEqual(code, 200)
        self.assertEqual(self.started, [f"by {OWNER}"])

    def test_nobody_in_a_call_installs_at_once(self):
        code, _ = self.call({}, {"calls": 0, "people": [], "others": 0})
        self.assertEqual((code, self.started), (200, [f"by {OWNER}"]))

    def test_a_server_without_calls_never_asks_livekit(self):
        code, _ = self.call({}, AssertionError("asked LiveKit"), calls_on=False)
        self.assertEqual((code, self.started), (200, [f"by {OWNER}"]))

    def test_when_the_calls_end_waits_and_dont_wait_takes_it_back(self):
        code, out = self.call({"when": "calls-end"}, AssertionError("asked LiveKit"))
        self.assertEqual(code, 200)
        self.assertEqual(self.started, [])
        self.assertEqual(out["status"]["after_calls"]["by"], OWNER)
        code, out = self.call({"when": "cancel"}, AssertionError("asked LiveKit"))
        self.assertEqual((code, out["status"]["after_calls"]), (200, None))
        self.assertEqual(self.started, [])

    def test_a_second_request_while_livekit_answers_starts_nothing(self):
        """Astra review r1 (High): two requests both passed the phase check before the LiveKit await; the phase is
        checked again after it, with no await before the busy status."""
        def started_meanwhile():
            self.status["phase"] = "installing"  # the other request (or the night install) got there first
            return {"calls": 0, "people": [], "others": 0}
        code, _ = self.call({}, _Lazy(started_meanwhile))
        self.assertEqual(code, 409)
        self.assertEqual(self.started, [])

    def test_unknown_requests_are_refused(self):
        self.assertEqual(self.call({"when": "tomorrow"}, None)[0], 400)
        self.assertEqual(self.call(["x"], None)[0], 400)
        self.assertEqual(self.started, [])


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class InstallWhenTheCallsEnd(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)
        self.u = web.updates
        self.u._quiet_since = 0.0
        self.st = {"phase": "staged", "checked": 10**12, "available": {"version": "9.9.9"},
                   "after_calls": {"by": OWNER, "at": 1}}
        self.started = []

    def tick(self, busy, now, auto=False, window=False, during_download=None):
        st = self.st
        answers = list(busy) if isinstance(busy, list) else None

        def set_status(**changes):
            st.update(changes)
            return st

        def start_install(by):
            self.started.append(by)
            st.update(phase="installing", after_calls=None)

        async def busy_call():
            return answers.pop(0) if answers is not None else busy

        async def download():
            st["phase"] = "staged"
            if during_download:
                during_download(st)
        with mock.patch.object(self.u, "download", download), \
                mock.patch.object(self.u, "status", lambda: dict(st)), \
                mock.patch.object(self.u, "set_status", set_status), \
                mock.patch.object(self.u, "start_install", start_install), \
                mock.patch.object(self.u, "settings", lambda: {"auto": auto, "tz": None}), \
                mock.patch.object(self.u, "in_window", lambda: window), \
                mock.patch.object(self.u.config, "compose_edition", lambda: False), \
                mock.patch.object(self.u.time, "time", lambda: now):
            asyncio.run(self.u.tick(busy_call))

    def test_installs_after_a_quiet_minute_at_any_hour_with_auto_off(self):
        self.tick(True, 1000)
        self.tick(False, 1060)   # the first quiet tick: not yet (a gap between two calls)
        self.assertEqual(self.started, [])
        self.tick(False, 1120)
        self.assertEqual(self.started, [f"when the calls ended ({OWNER})"])

    def test_a_call_in_between_starts_the_wait_again(self):
        self.tick(False, 1000)
        self.tick(True, 1060)
        self.tick(False, 1120)
        self.assertEqual(self.started, [])
        self.tick(False, 1180)
        self.assertEqual(len(self.started), 1)

    def test_a_call_that_starts_during_the_download_is_not_cut(self):
        """Astra review r1 (High): the download takes minutes; calls are asked about again after it."""
        self.st["phase"] = "available"
        self.tick(False, 1000)
        self.tick([False, True], 1060)  # quiet before the download, a call by the time it's done
        self.assertEqual(self.started, [])
        self.assertEqual(self.st["phase"], "staged")
        self.assertTrue(self.st["after_calls"])  # still waiting
        self.tick(False, 1120)
        self.tick(False, 1180)
        self.assertEqual(len(self.started), 1)

    def test_dont_wait_during_the_download_holds(self):
        """Astra review r1 (Medium): a Don't wait that answered while the tick downloaded must not install."""
        self.st["phase"] = "available"
        self.tick(False, 1000)
        self.tick(False, 1060, during_download=lambda st: st.update(after_calls=None))
        self.assertEqual(self.started, [])

    def test_livekit_not_answering_never_installs(self):
        for t in range(1000, 1600, 60):
            self.tick(None, t)
        self.assertEqual(self.started, [])

    def test_nothing_to_install_any_more_drops_the_wish(self):
        self.st["phase"] = "current"
        self.tick(False, 1000)
        self.assertIsNone(self.st["after_calls"])
        self.assertEqual(self.started, [])

    def test_without_the_wish_nothing_installs_by_day(self):
        self.st["after_calls"] = None
        for t in (1000, 1060, 1120):
            self.tick(False, t)
        self.assertEqual(self.started, [])


@unittest.skipUnless(HAVE_AIOHTTP, "needs the real aiohttp")
class OverviewSaysAnUpdateWaits(unittest.TestCase):
    """With automatic updates off the Overview said "Everything is running" for weeks while an update waited."""
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)

    def item(self, st, auto=False, compose=False):
        return web.updates.watch_item(st, auto, compose)

    def test_auto_off_says_it_waits_and_security_is_serious(self):
        st = {"phase": "available", "available": {"version": "9.9.9"}}
        w = self.item(st)
        self.assertEqual(w["level"], "warn")
        self.assertIn("Tin Hat Server 9.9.9 is out", w["text"])
        st["available"]["security"] = True
        self.assertEqual(self.item(st)["level"], "bad")
        self.assertEqual(self.item({**st, "phase": "staged"})["level"], "bad")

    def test_auto_on_installs_tonight_without_a_line(self):
        self.assertIsNone(self.item({"phase": "available", "available": {"version": "9.9.9", "security": True}}, auto=True))

    def test_the_compose_edition_always_says_so(self):
        self.assertIn("new image", self.item({"phase": "available", "available": {"version": "9.9.9"}}, auto=True, compose=True)["text"])

    def test_waiting_for_the_calls_is_said_plainly(self):
        w = self.item({"phase": "staged", "available": {"version": "9.9.9"}, "after_calls": {"by": OWNER}}, auto=True)
        self.assertEqual(w, {"key": "update-waiting", "level": "info", "text": "Tin Hat Server 9.9.9 installs as soon as the calls end."})

    def test_nothing_waiting_no_line(self):
        for st in ({"phase": "current"}, {"phase": "installing", "available": {"version": "9.9.9"}}, {"phase": "available"}):
            self.assertIsNone(self.item(st), st)


class MxidOfIdentity(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(sys.modules, _real)
        p.start()
        self.addCleanup(p.stop)

    def test_vectors(self):
        if not HAVE_AIOHTTP:
            self.skipTest("needs the real aiohttp")
        f = web.lkadmin.mxid_of
        for ident, want in [(f"@ana:{SN}:ABCDEF", f"@ana:{SN}"),
                            (f"@ana:{SN}:ABCDEF~watch-0123456789abcdef", f"@ana:{SN}"),
                            (f"@ana:{SN}:ABCDEF~pad-mic-0123456789abcdef", f"@ana:{SN}"),
                            (f"@ana:{SN}:ABCDEF#cam", f"@ana:{SN}"),
                            (f"@ana:{SN}:8448:DEV", f"@ana:{SN}:8448"),  # a server name with a port
                            (f"@ana:{SN}", None),                          # no device: not an account's connection
                            (f"@ana:{SN}:", None),
                            ("guest-1234", None), ("", None), (None, None), (42, None)]:
            self.assertEqual(f(ident), want, ident)


if __name__ == "__main__":
    unittest.main()

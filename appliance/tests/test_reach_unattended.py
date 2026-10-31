"""The manager's own outside checks never pause the call server (BACKLOG-SERVER-037): a call started during the old
~20 s pause failed ("Unable to create room on SFU"). Unattended checks look at HTTPS and TCP 7881 with LiveKit
running and keep the last real UDP 7882 result (or say it wasn't checked); a check someone starts still pauses it.

Runs anywhere (no aiohttp needed): the modules reach imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
STATE = {}
CALLS = []


class NamesError(Exception):
    def __init__(self, msg, code=""):
        super().__init__(msg)
        self.code = code


def _mod(name, **attrs):
    m = types.ModuleType(f"tinhat.{name}")
    m.__dict__.update(attrs)
    return m


async def _run(*args, **kw):
    CALLS.append(("compose", args))
    return 0, ""


async def _up(*args, **kw):
    CALLS.append(("up", args))
    return 0, ""


async def _probe(nonce, checks, family=None, timeout=None):
    CALLS.append(("probe", tuple(checks), family))
    return {"results": {c: {"ok": True} for c in checks}, "ip": "203.0.113.9"}


def load():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        stubs = {
            "compose": _mod("compose", run=_run, up=_up),
            "hw": _mod("hw", addresses=lambda: []),
            "names": _mod("names", probe=_probe, NamesError=NamesError),
            "portmap": _mod("portmap"),
            "owndomain": _mod("owndomain"),
            "state": _mod("state", load_state=lambda: dict(STATE), save_state=lambda **kw: STATE.update(kw) or STATE),
            "relay": _mod("relay", on=lambda: False, call_ports=lambda: (17881, 17882)),
        }
        for k, v in stubs.items():
            sys.modules[f"tinhat.{k}"] = v
            setattr(pkg, k, v)
        spec = importlib.util.spec_from_file_location("tinhat.reach", PKG / "reach.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.reach"] = mod
        spec.loader.exec_module(mod)
        return mod, stubs
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


reach, STUBS = load()


class Unattended(unittest.TestCase):
    def setUp(self):
        STATE.clear()
        STATE["mode"] = "anywhere"
        CALLS.clear()
        self.p = {k: v for k, v in STUBS.items()}
        self._saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        for k, v in STUBS.items():
            setattr(pkg, k, v)
        sys.modules["tinhat"] = pkg
        sys.modules.update({f"tinhat.{k}": v for k, v in STUBS.items()})

    def tearDown(self):
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(self._saved)

    def check(self, unattended):
        async def stand_in(*a, **kw):  # no real sockets in a unit test
            CALLS.append(("stand-in", a))
            return lambda: None
        orig = reach._stand_in
        reach._stand_in = stand_in
        try:
            return asyncio.run(reach.Checker().outside(True, unattended=unattended))
        finally:
            reach._stand_in = orig

    def test_unattended_never_touches_livekit(self):
        out = self.check(True)
        kinds = [c[0] for c in CALLS]
        self.assertNotIn("compose", kinds)
        self.assertNotIn("up", kinds)
        self.assertNotIn("stand-in", kinds)
        probes = [c for c in CALLS if c[0] == "probe"]
        self.assertTrue(probes)
        for _, checks, _fam in probes:
            self.assertNotIn("udp7882", checks)  # only the manager's echo answers that one
        v4 = [c for c in probes if c[2] is not None and c[2].name == "AF_INET"]
        self.assertEqual(v4[0][1], ("tls443", "tcp7881"))  # TCP 7881: the running LiveKit answers the connect
        self.assertEqual(out["results"]["udp7882"], reach.UNCHECKED)
        self.assertTrue(out["ok"], "an unchecked UDP port neither passes nor fails the check")

    def test_a_check_someone_starts_still_pauses_and_checks_udp(self):
        out = self.check(False)
        self.assertIn(("compose", ("stop", "livekit")), CALLS)
        self.assertIn(("up", ("livekit",)), CALLS)
        v4 = [c for c in CALLS if c[0] == "probe" and c[2] is not None and c[2].name == "AF_INET"]
        self.assertEqual(v4[0][1], ("tls443", "tcp7881", "udp7882"))
        self.assertTrue(out["results"]["udp7882"]["ok"])

    def test_the_last_real_udp_result_is_kept(self):
        STATE["reach_udp"] = {"at": 1000, "route": ["direct", "203.0.113.9", None, None],
                              "result": {"ok": False, "why": "no-answer"}}
        out = self.check(True)
        self.assertEqual(out["results"]["udp7882"], {"ok": False, "why": "no-answer", "kept": 1000})
        self.assertFalse(out["ok"], "a UDP port that failed its last real check still counts")
        # kept again by the next unattended check: still the time of the real one
        out2 = self.check(True)
        self.assertEqual(out2["results"]["udp7882"]["kept"], 1000)

    def test_a_result_for_another_address_is_not_kept(self):
        STATE["reach_udp"] = {"at": 1000, "route": ["direct", "198.51.100.1", None, None], "result": {"ok": True}}
        out = self.check(True)
        self.assertEqual(out["results"]["udp7882"], reach.UNCHECKED)

    def test_a_new_relay_place_is_a_new_question(self):
        old = {"via": "relay", "public_ip": "203.0.113.9", "target": "198.51.100.7", "ports": [20001]}
        new = {**old, "target": "198.51.100.8", "at": 2000, "results": {"tls443": {"ok": True}}}
        last = {"at": 1000, "route": reach.route_of(old), "result": {"ok": True}}
        self.assertEqual(reach.keep_udp(new, last)["results"]["udp7882"], reach.UNCHECKED)
        self.assertTrue(reach.keep_udp({**new, "target": "198.51.100.7"}, last)["results"]["udp7882"]["ok"])

    def test_a_names_outage_does_not_erase_the_real_udp_result(self):
        self.check(False)  # a real check: UDP answered (the stub says ok)
        self.assertTrue(STATE["reach_udp"]["result"]["ok"])
        real = STATE["reach_udp"]
        orig = STUBS["names"].probe

        async def offline(*a, **kw):
            raise NamesError("offline", "offline")
        STUBS["names"].probe = offline
        try:
            self.check(True)  # the outage: an error, no results
        finally:
            STUBS["names"].probe = orig
        self.assertEqual(STATE["reach_udp"], real)
        out = self.check(True)
        self.assertTrue(out["results"]["udp7882"]["ok"])
        self.assertEqual(out["results"]["udp7882"]["kept"], real["at"])

    def test_an_updated_server_keeps_the_udp_answer_it_had(self):
        STATE["reach"] = {"at": 900, "ok": False, "public_ip": "203.0.113.9",
                          "results": {"tls443": {"ok": True}, "tcp7881": {"ok": True},
                                      "udp7882": {"ok": False, "why": "no-answer"}}}  # 0.3.9: no reach_udp yet
        out = self.check(True)
        self.assertEqual(out["results"]["udp7882"], {"ok": False, "why": "no-answer", "kept": 900})
        self.assertFalse(out["ok"])
        # and the next unattended check still has it (the seed is saved, not only used once: found in the lab)
        out = self.check(True)
        self.assertEqual(out["results"]["udp7882"], {"ok": False, "why": "no-answer", "kept": 900})
        self.assertEqual(STATE["reach_udp"]["at"], 900)
        self.assertIsNone(reach.seed_udp({"results": {"udp7882": dict(reach.UNCHECKED)}}))
        self.assertIsNone(reach.seed_udp(None))

    def test_the_ipv4_family_agrees_with_the_answer(self):
        STATE["reach_udp"] = {"at": 1000, "route": ["direct", "203.0.113.9", None, None],
                              "result": {"ok": False, "why": "no-answer"}}
        out = self.check(True)
        v4 = out["families"]["ipv4"]
        self.assertEqual(v4["results"]["udp7882"]["why"], "no-answer")
        self.assertFalse(v4["ok"])
        self.assertFalse(out["ok"])

    def test_a_kept_udp_failure_alone_stops_the_rechecks(self):
        kept = {"tls443": {"ok": True}, "tcp7881": {"ok": True}, "udp7882": {"ok": False, "kept": 1000}}
        self.assertFalse(reach.recheck_due({"ok": False, "results": kept}))
        self.assertFalse(reach.recheck_due({"ok": True, "results": {**kept, "udp7882": dict(reach.UNCHECKED)}}))
        self.assertTrue(reach.recheck_due({"ok": False, "results": {**kept, "tcp7881": {"ok": False}}}))
        self.assertTrue(reach.recheck_due({"ok": False, "results": {}, "error": "offline"}))
        self.assertTrue(reach.recheck_due({}))
        # a real (not kept) UDP failure from a full check: the loop may look again (it can't see UDP, but tls/tcp yes)
        self.assertTrue(reach.recheck_due({"ok": False, "results": {**kept, "udp7882": {"ok": False}}}))

    def test_calls_off_checks_https_only(self):
        async def go():
            return await reach.Checker().outside(False, unattended=True)
        out = asyncio.run(go())
        self.assertNotIn("udp7882", out["results"])
        self.assertNotIn("compose", [c[0] for c in CALLS])


class Words(unittest.TestCase):
    PORTS = {"kind": "public", "method": "upnp", "lan_ip": "10.90.0.187", "mapped": [
        {"proto": "TCP", "port": 443, "ok": True}, {"proto": "TCP", "port": 7881, "ok": True},
        {"proto": "UDP", "port": 7882, "ok": True}]}

    def test_unchecked_is_neither_good_nor_blocked(self):
        o = {"ok": True, "results": {"tls443": {"ok": True}, "tcp7881": {"ok": True}, "udp7882": dict(reach.UNCHECKED)}}
        s = reach.summary(self.PORTS, o)
        self.assertEqual(s["level"], "good")
        self.assertIn("Check again", " ".join(s["lines"]))

    def test_unchecked_with_a_blocked_port_names_only_the_blocked_one(self):
        o = {"ok": False, "results": {"tls443": {"ok": True}, "tcp7881": {"ok": False, "why": "unreachable"},
                                      "udp7882": dict(reach.UNCHECKED)}}
        s = reach.summary(self.PORTS, o)
        text = " ".join(s["lines"]) + " " + " ".join(str(x) for x in s.get("fix") or [])
        self.assertIn("7881", text)
        self.assertNotIn("UDP 7882 don't", text)

    def test_kept_failure_says_to_check_again(self):
        o = {"ok": False, "results": {"tls443": {"ok": True}, "tcp7881": {"ok": True},
                                      "udp7882": {"ok": False, "why": "no-answer", "kept": 1000}}}
        self.assertIn("last full check", " ".join(reach.summary(self.PORTS, o)["lines"]))


class LoopSource(unittest.TestCase):
    """The manager's loop asks for unattended checks only (web.py is aiohttp-bound: read as source)."""
    def test_loop_checks_are_unattended(self):
        src = (PKG / "web.py").read_text()
        self.assertIn("m.checker.outside(calls, unattended=True)", src)
        self.assertEqual(src.count("reach.recheck_due(last)"), 2)
        self.assertNotIn("out = await m.checker.outside(calls)\n", src)


if __name__ == "__main__":
    unittest.main()

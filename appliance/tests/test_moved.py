"""Moving to another computer: the old computer stands down only when a real restored copy says so (an HMAC over a
fresh challenge, keyed by a secret both copies share from the backup), each challenge works once, and a tinhat.me name
can also learn it from the names service.

Runs anywhere: the modules moved.py imports are stubbed.
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
SECRETS = {"macaroon_secret_key": "shared-by-both-copies"}
CALLS = []


def load():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        st = types.ModuleType("tinhat.state")
        st.load_state = lambda: dict(STATE)
        st.save_state = lambda **kw: STATE.update(kw)
        st.load_secrets = lambda: dict(SECRETS)
        st.public_mode = lambda s: s.get("mode") in ("anywhere", "domain")
        st.behind_proxy = lambda s=None: False

        async def run(*args, timeout=0):
            CALLS.append(("compose", args))
            return 0, ""
        compose = types.ModuleType("tinhat.compose")
        compose.run = run
        console = types.ModuleType("tinhat.console")
        console.refresh = lambda force=False: CALLS.append(("console",))

        async def release_name():
            CALLS.append(("mdns",))
        mdns = types.ModuleType("tinhat.mdns")
        mdns.release_name = release_name

        class NamesError(Exception):
            def __init__(self, msg, code=""):
                super().__init__(msg)
                self.code = code

        async def update():
            CALLS.append(("names",))
            STATE["names_status"] = {"status": "moved"}
            raise NamesError("moved", "moved")
        names = types.ModuleType("tinhat.names")
        names.NamesError, names.update = NamesError, update

        async def close_ports(ports):
            CALLS.append(("ports", tuple(ports)))
            return []
        portmap = types.ModuleType("tinhat.portmap")
        portmap.close_ports = close_ports
        reach = types.ModuleType("tinhat.reach")
        reach.ports = lambda calls, proxy=False: [("TCP", 443)]
        reach.wanted = lambda calls, proxy=False: [("TCP", 443)]  # every port the server asked the router for
        relay = types.ModuleType("tinhat.relay")
        relay.on = lambda: False
        for name, m in (("state", st), ("compose", compose), ("console", console), ("mdns", mdns), ("names", names),
                        ("portmap", portmap), ("reach", reach), ("relay", relay)):
            sys.modules[f"tinhat.{name}"] = m
            setattr(pkg, name, m)
        spec = importlib.util.spec_from_file_location("tinhat.moved", PKG / "moved.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.moved"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


moved = load()


class Moved(unittest.TestCase):
    def setUp(self):
        STATE.clear()
        STATE.update(phase="ready", mode="lan", server_name="crew.local")
        CALLS.clear()
        moved._last_check = 0.0

    def nudge(self, **kw):
        return asyncio.run(moved.check_now(**kw))

    def test_a_restored_copy_makes_it_stand_down(self):
        n = moved.challenge()["nonce"]
        out = self.nudge(nonce=n, sig=moved.proof(n, "crew.local"), to="10.0.0.9")
        self.assertTrue(out["moved"])
        self.assertTrue(STATE["moved_away"]["at"])
        self.assertEqual(STATE["moved_away"]["to"], "10.0.0.9")
        self.assertIn(("compose", ("stop", "synapse", "livekit", "lk-jwt")), CALLS)
        self.assertIn(("mdns",), CALLS)
        self.assertNotIn(("ports", (("TCP", 443),)), CALLS)  # a home-network server never opened router ports
        self.assertTrue(STATE["stood_down"])

    def test_anything_else_is_refused(self):
        n = moved.challenge()["nonce"]
        self.assertFalse(self.nudge(nonce=n, sig="0" * 64)["moved"])
        self.assertFalse(self.nudge(nonce="made-up", sig=moved.proof("made-up", "crew.local"))["moved"])
        n = moved.challenge()["nonce"]
        self.assertFalse(self.nudge(nonce=n, sig=moved.proof(n, "another.local"))["moved"])  # a copy of another server
        self.assertNotIn("moved_away", STATE)
        self.assertEqual(CALLS, [])

    def test_a_challenge_works_once(self):
        n = moved.challenge()["nonce"]
        sig = moved.proof(n, "crew.local")
        self.assertTrue(self.nudge(nonce=n, sig=sig)["moved"])
        STATE.pop("moved_away")
        STATE.pop("stood_down")
        self.assertFalse(self.nudge(nonce=n, sig=sig)["moved"])

    def test_a_tinhat_me_name_asks_the_names_service(self):
        STATE.update(mode="anywhere", server_name="crew.tinhat.me")
        out = self.nudge()
        self.assertTrue(out["moved"])
        self.assertIn(("names",), CALLS)
        self.assertIn(("ports", (("TCP", 443),)), CALLS)

    def test_a_home_network_server_without_proof_stays(self):
        self.assertFalse(self.nudge()["moved"])
        self.assertEqual(CALLS, [])

    def test_standing_down_happens_once(self):
        STATE.update(stood_down=1)
        asyncio.run(moved.stand_down())
        self.assertEqual(CALLS, [])


class OldComputerAddresses(unittest.TestCase):
    """The old computer's addresses come from the backup: only real computers' addresses are ever contacted."""

    def test_home_and_public_addresses_are_tried_on_both_ports(self):
        got = moved.old_bases(["192.168.1.20", "11.90.5.5", "fd12::7"], {"192.168.1.30"})
        self.assertEqual(got, [("192.168.1.20", ["http://192.168.1.20", "http://192.168.1.20:8080"]),
                               ("11.90.5.5", ["http://11.90.5.5", "http://11.90.5.5:8080"]),
                               ("fd12::7", ["http://[fd12::7]", "http://[fd12::7]:8080"])])

    def test_nothing_that_isnt_a_computer_on_the_network(self):
        bad = ["127.0.0.1", "::1", "169.254.169.254", "fe80::1", "fd00:ec2::254", "100.100.100.200", "224.0.0.251",
               "0.0.0.0", "240.0.0.1", "evil.example/x#", "10.0.0.5:22", "user@10.0.0.5", "", None]
        self.assertEqual(moved.old_bases(bad, set()), [])

    def test_this_computer_and_more_than_a_handful_are_skipped(self):
        self.assertEqual(moved.old_bases(["192.168.1.30"], {"192.168.1.30"}), [])
        self.assertEqual(len(moved.old_bases([f"10.0.0.{i}" for i in range(1, 50)], set())), 8)


if __name__ == "__main__":
    unittest.main()

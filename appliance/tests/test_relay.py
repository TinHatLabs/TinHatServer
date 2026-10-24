"""relay.py: WireGuard keys without wireguard-tools, the tunnel's networkd files, what the call server and the web server
are told while relayed, the words people read, and the setup question.

Runs anywhere (no aiohttp needed): the network modules relay.py and reach.py import are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import base64
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
TMP = tempfile.mkdtemp(prefix="tinhat-relay-test-")
os.environ["TINHAT_STATE"] = TMP
os.environ["TINHAT_NETWORKD_DIR"] = os.path.join(TMP, "network")


def load():
    for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
        del sys.modules[k]
    pkg = types.ModuleType("tinhat")
    pkg.__path__ = [str(PKG)]
    sys.modules["tinhat"] = pkg
    for name in ("compose", "hw", "portmap"):
        sys.modules[f"tinhat.{name}"] = types.ModuleType(f"tinhat.{name}")
    names = types.ModuleType("tinhat.names")

    class NamesError(Exception):
        def __init__(self, msg, code="", status=0):
            super().__init__(msg)
            self.code, self.status = code, status
    names.NamesError = NamesError
    sys.modules["tinhat.names"] = names
    mods = {}
    for name in ("config", "state", "templates", "environment", "relay", "reach"):
        spec = importlib.util.spec_from_file_location(f"tinhat.{name}", PKG / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"tinhat.{name}"] = mod
        spec.loader.exec_module(mod)
        mods[name] = mod
    return mods


M = load()
relay, state, reach = M["relay"], M["state"], M["reach"]

DOC = {"ok": True, "fqdn": "crew.tinhat.me", "tunnel_ip": "100.96.0.2", "ports": {"tcp": 20000, "udp": 20000},
       "relay": {"id": "relay1", "public_ip": "11.91.0.50", "endpoint": "11.91.0.50:51820",
                 "public_key": base64.b64encode(b"r" * 32).decode(), "tunnel_ip": "100.96.0.1"},
       "status": "active", "usage": {"month": "2026-10", "bytes": 5, "quota": 100}}


def relayed(**extra):
    state.save_state(relay={**{k: DOC[k] for k in ("relay", "tunnel_ip", "ports", "status", "usage", "fqdn")},
                            "on": True, **extra})


class Keys(unittest.TestCase):
    def test_rfc7748_vectors(self):
        h = bytes.fromhex
        self.assertEqual(relay._x25519(h("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
                                       h("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")).hex(),
                         "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552")
        alice = h("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        bob_pub = h("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        self.assertEqual(base64.b64decode(relay.public_key(base64.b64encode(alice).decode())).hex(),
                         "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        self.assertEqual(relay._x25519(alice, bob_pub).hex(),
                         "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")

    @unittest.skipUnless(shutil.which("wg"), "wireguard-tools not installed here")
    def test_same_public_key_as_wireguard_tools(self):
        priv = relay.new_private_key()
        wg = subprocess.run(["wg", "pubkey"], input=priv, capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(relay.public_key(priv), wg)

    def test_the_key_is_made_once_and_kept(self):
        a = relay.keypair()
        self.assertEqual(relay.keypair(), a)
        self.assertEqual(len(base64.b64decode(a[0])), 32)
        self.assertEqual(relay.public_key(a[0]), a[1])


class TunnelFiles(unittest.TestCase):
    def test_networkd_files(self):
        f = relay._files(DOC)
        netdev, network = f[relay.NETDEV], f[relay.NETWORK]
        self.assertIn("Kind=wireguard", netdev)
        self.assertIn("Endpoint=11.91.0.50:51820", netdev)
        self.assertIn("AllowedIPs=100.96.0.1/32", netdev)          # only the relay's own address comes in
        self.assertIn("PersistentKeepalive=25", netdev)              # holds the carrier's NAT open
        self.assertIn(f"PrivateKeyFile={relay.KEY_FILE}", netdev)    # the key itself is never in this file
        self.assertIn("Address=100.96.0.2/32", network)
        self.assertIn("IPv4Forwarding=no", network)                  # nothing from the tunnel is passed on
        self.assertIn("Destination=100.96.0.1/32", network)
        self.assertIn("RequiredForOnline=no", network)               # boot never waits for the relay


class WhileRelayed(unittest.TestCase):
    def tearDown(self):
        state.save_state(relay={"on": False})

    def test_off(self):
        state.save_state(relay={"on": False})
        self.assertEqual(relay.call_ports(), (7881, 7882))
        self.assertIsNone(relay.proxy_from())
        y = relay.livekit_yaml({"livekit_key": "k", "livekit_secret": "s"}, "11.91.0.3")
        self.assertIn("udp_port: 7882", y)
        self.assertIn("node_ip: 11.91.0.3", y)

    def test_on(self):
        relayed()
        self.assertEqual(relay.call_ports(), (20000, 20000))
        self.assertEqual(relay.proxy_from(), "100.96.0.1")
        y = relay.livekit_yaml({"livekit_key": "k", "livekit_secret": "s"}, "11.91.0.3")
        self.assertIn("tcp_port: 20000", y)
        self.assertIn("udp_port: 20000", y)
        self.assertIn("node_ip: 11.91.0.50", y)                      # callers outside get the relay's address
        self.assertIn("advertise_internal_ip: true", y)              # callers at home still get the box's own

    def test_words(self):
        relayed(health={"ok": True})
        good = reach.summary({"kind": "cgnat"}, {"ok": True, "via": "relay", "results": {}})
        self.assertEqual(good["level"], "good")
        self.assertIn("through the Tin Hat relay", good["headline"])
        chat_only = reach.summary({"kind": "cgnat"}, {"ok": False, "via": "relay", "results": {
            "tls443": {"ok": True}, "tcp7881": {"ok": False}, "udp7882": {"ok": False}}})
        self.assertEqual(chat_only["level"], "warn")
        relayed(health={"ok": False}, status="active")
        down = reach.summary({}, {"ok": False, "via": "relay", "results": {"tls443": {"ok": False}}})
        self.assertEqual(down["level"], "bad")
        self.assertTrue(any("tunnel to the relay isn't up" in l for l in down["lines"]))
        relayed(health={"ok": True}, status="calls-paused")
        paused = reach.summary({}, {"ok": False, "via": "relay", "results": {"tls443": {"ok": True}}})
        self.assertTrue(any("allowance is used up" in l for l in paused["lines"]))
        # the last check passed, but the tunnel went down since: what's true now
        relayed(health={"ok": False, "checked": 200}, status="active")
        now_down = reach.summary({}, {"ok": True, "at": 100, "via": "relay", "results": {}})
        self.assertEqual(now_down["level"], "bad")
        # without the relay the carrier-NAT words are unchanged
        self.assertIn("doesn't allow incoming", reach.summary({"kind": "cgnat"}, {"ok": False})["headline"])

    def test_status_doc(self):
        relayed(health={"ok": True, "rtt_ms": 1.5, "checked": 10})
        d = relay.status_doc()
        self.assertEqual((d["on"], d["relayAddress"], d["port"], d["tunnelOk"]), (True, "11.91.0.50", 20000, True))
        state.save_state(relay={"on": False, "off_at": 5})
        self.assertEqual(relay.status_doc(), {"on": False, "offAt": 5})


class SetupQuestion(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.available = True

        async def info():
            return {"relay_available": self.available}
        sys.modules["tinhat.names"].info = info

    async def test_no_relay_to_offer_means_no_question(self):
        self.available = False
        status, detail = await relay.setup_step(lambda st, d: self.fail("asked"), True)
        self.assertEqual(status, "warn")
        self.assertIsNone(relay.question())

    async def test_ask_and_answer(self):
        steps = []

        async def fake_enable(calls, restart=True):
            relayed(health={"ok": True})
            return relay.info()
        orig = relay.enable
        relay.enable = fake_enable
        try:
            task = asyncio.create_task(relay.setup_step(lambda st, d: steps.append(st), True))
            for _ in range(50):
                if relay.question():
                    break
                await asyncio.sleep(0.01)
            q = relay.question()
            self.assertEqual(q["yes"], "Use the Tin Hat relay")
            self.assertTrue(relay.answer(True))
            status, detail = await task
        finally:
            relay.enable = orig
            state.save_state(relay={"on": False})
        self.assertEqual(steps, ["ask", "running"])
        self.assertEqual(status, "done")
        self.assertIn("through the Tin Hat relay (11.91.0.50)", detail)
        self.assertIsNone(relay.question())

    async def test_not_now(self):
        task = asyncio.create_task(relay.setup_step(lambda st, d: None, True))
        for _ in range(50):
            if relay.question():
                break
            await asyncio.sleep(0.01)
        relay.answer(False)
        status, detail = await task
        self.assertEqual(status, "warn")
        self.assertIn("carrier NAT", detail)
        self.assertFalse(relay.on())


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

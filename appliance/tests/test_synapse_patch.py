"""The Synapse image's backported security fix (rootfs/opt/tinhat/build/synapse/patch_todevice_spoof.py, upstream
GHSA-rgv2-84w7-5j9p): to-device messages whose sender isn't on the sending server are dropped.

Always: the patch on the exact 1.145 shape, and its refusals (any other code, or code that already has the fix).
With TINHAT_TEST_SYNAPSE_PY (a python with matrix-synapse 1.145.0, twisted and parameterized installed) and
TINHAT_TEST_SYNAPSE_SRC (a checkout of element-hq/synapse at v1.145.0, for its tests/ harness): Synapse's own
federation EDU handler (FederationRegistry.on_edu) on a stock copy and on a patched copy of the installed package.
The stock run must FAIL (it delivers the spoofed messages: the negative control) and the patched run must pass."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "rootfs" / "opt" / "tinhat" / "build" / "synapse"))
import patch_todevice_spoof as p  # noqa: E402

FIXTURE = (
    "class DeviceMessageHandler:\n"
    "    async def on_direct_to_device_edu(self, origin, content):\n"
    "        local_messages = {}\n"
    '        sender_user_id = content["sender"]\n'
    + p.BUGGY
    + '        message_id = content["message_id"]\n'
)

SYN_PY = os.environ.get("TINHAT_TEST_SYNAPSE_PY", "")
SYN_SRC = os.environ.get("TINHAT_TEST_SYNAPSE_SRC", "")

# Runs inside Synapse's own test harness (HomeserverTestCase: a real homeserver, server name "test", SQLite).
SPOOF_TEST = '''
import os

import synapse
from synapse.api.constants import EduTypes
from synapse.rest import admin
from synapse.rest.client import login, sendtodevice, sync

from tests.unittest import HomeserverTestCase


class SpoofedToDevice(HomeserverTestCase):
    # sendtodevice brings up DeviceMessageHandler, which registers the m.direct_to_device EDU handler (as on a server)
    servlets = [admin.register_servlets, login.register_servlets, sendtodevice.register_servlets, sync.register_servlets]

    def test_only_the_genuine_sender_arrives(self) -> None:
        # the copy under test, never an installed Synapse
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        me = self.register_user("u2", "pass")
        tok = self.login("u2", "pass", "d2")
        registry = self.hs.get_federation_registry()
        self.assertIn(EduTypes.DIRECT_TO_DEVICE, registry.edu_handlers, "the real handler is the one under test")

        def edu(origin, sender, n, mid):
            self.get_success(registry.on_edu(EduTypes.DIRECT_TO_DEVICE, origin, {
                "sender": sender, "type": "m.key.verification.request",
                "messages": {me: {"d2": {"n": n}}}, "message_id": mid}))

        edu("evil.example", "@friend:friend.example", "remote-spoof", "a")  # someone on another server
        edu("evil.example", "@owner:test", "local-spoof", "b")  # one of this server's own people
        edu("evil.example", "@spam:evil.example", "genuine", "c")  # the sending server's own user: the sentinel
        channel = self.make_request("GET", "/sync", access_token=tok)
        self.assertEqual(channel.code, 200, channel.result)
        got = [e["content"]["n"] for e in channel.json_body.get("to_device", {}).get("events", [])]
        print("DELIVERED", got)
        # stock 1.145 delivers all three (the bug, shown by a run that completes); patched, only the genuine one
        want = os.environ["TINHAT_SYNPATCH_EXPECT"].split(",")
        self.assertEqual(got, want)
        for e in channel.json_body["to_device"]["events"]:
            self.assertEqual(e["type"], "m.key.verification.request")
        senders = {e["content"]["n"]: e["sender"] for e in channel.json_body["to_device"]["events"]}
        self.assertEqual(senders.get("genuine"), "@spam:evil.example")
        if "local-spoof" in want:
            self.assertEqual(senders["local-spoof"], "@owner:test")
'''


class Patch(unittest.TestCase):
    def test_the_1_145_shape_gets_the_return(self):
        out = p.patch(FIXTURE)
        self.assertNotIn(p.BUGGY, out)
        self.assertIn(p.FIXED, out)
        self.assertEqual(out.count("\n            return\n"), 1)
        compile(out, "devicemessage.py", "exec")

    def test_other_code_is_refused(self):
        for changed in (FIXTURE.replace("origin,\n", "origin ,\n"), FIXTURE.replace(p.BUGGY, ""), FIXTURE + p.BUGGY):
            with self.assertRaises(SystemExit) as e:
                p.patch(changed)
            self.assertIn("refusing", str(e.exception))

    def test_already_fixed_code_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            p.patch(p.patch(FIXTURE))
        self.assertIn("remove this patch", str(e.exception))

    def test_a_refusal_changes_nothing(self):
        d = tempfile.mkdtemp(prefix="ths-synpatch-")
        try:
            f = Path(d) / "devicemessage.py"
            f.write_text("x = 1\n")
            with self.assertRaises(SystemExit):
                p.main(["patch", str(f)])
            self.assertEqual(f.read_text(), "x = 1\n")
            f.write_text(FIXTURE)
            self.assertEqual(p.main(["patch", str(f)]), 0)
            self.assertIn(p.FIXED, f.read_text())
        finally:
            shutil.rmtree(d)


@unittest.skipUnless(SYN_PY and SYN_SRC, "set TINHAT_TEST_SYNAPSE_PY and TINHAT_TEST_SYNAPSE_SRC (see the docstring)")
class RealSynapse(unittest.TestCase):
    def installed(self) -> Path:
        out = subprocess.check_output([SYN_PY, "-c", "import importlib.util, synapse; "
                                       "print(synapse.__version__); "
                                       "print(importlib.util.find_spec('synapse').submodule_search_locations[0])"],
                                      text=True, cwd="/").split()
        self.assertEqual(out[0], "1.145.0", "the Synapse every Tin Hat Server runs")
        return Path(out[1])

    def trial(self, patched: bool, expect: str) -> subprocess.CompletedProcess:
        d = Path(tempfile.mkdtemp(prefix="ths-synpatch-"))
        self.addCleanup(shutil.rmtree, d, True)
        shutil.copytree(self.installed(), d / "synapse", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(Path(SYN_SRC) / "tests", d / "tests", ignore=shutil.ignore_patterns("__pycache__"))
        (d / "tests" / "rest" / "client" / "test_tinhat_todevice_spoof.py").write_text(SPOOF_TEST)
        if patched:
            self.assertEqual(p.main(["patch", str(d / "synapse" / "handlers" / "devicemessage.py")]), 0)
        env = {**os.environ, "PYTHONPATH": str(d), "PYTHONDONTWRITEBYTECODE": "1", "TINHAT_SYNPATCH_DIR": str(d),
               "TINHAT_SYNPATCH_EXPECT": expect}
        return subprocess.run([SYN_PY, "-m", "twisted.trial", "tests.rest.client.test_tinhat_todevice_spoof"],
                              cwd=d, env=env, capture_output=True, text=True, timeout=600)

    def test_the_installed_file_is_the_tagged_one(self):
        """The file the image carries is v1.145.0's own (the wheel and the tag agree), and the patch fits it."""
        f = self.installed() / "handlers" / "devicemessage.py"
        self.assertEqual(f.read_text(), (Path(SYN_SRC) / "synapse" / "handlers" / "devicemessage.py").read_text())
        p.patch(f.read_text())

    def test_stock_1_145_delivers_spoofed_senders(self):
        """The negative control: without the patch Synapse's own handler hands the spoofed messages to the person."""
        r = self.trial(patched=False, expect="remote-spoof,local-spoof,genuine")
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-3000:])
        self.assertIn("DELIVERED ['remote-spoof', 'local-spoof', 'genuine']", r.stdout)

    def test_patched_drops_them(self):
        r = self.trial(patched=True, expect="genuine")
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-3000:])
        self.assertIn("DELIVERED ['genuine']", r.stdout)


if __name__ == "__main__":
    unittest.main()

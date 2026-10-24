"""The Docker Compose edition (compose_entry.py, config.edition() == "compose"): it behaves like an own machine,
updates only through a new image, and its entry marks the edition and the proxy mode."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_OPT_SRC = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
_OPT = Path(tempfile.mkdtemp())
os.environ["TINHAT_OPT"] = str(_OPT)
os.environ["TINHAT_STATE"] = tempfile.mkdtemp()
sys.path.insert(0, str(_OPT_SRC / "manager"))

try:
    import aiohttp  # noqa: F401
except ImportError:  # the build host has no aiohttp: updates.py only needs it inside its network calls
    import types
    _aio = types.ModuleType("aiohttp")
    _aio.ClientSession = _aio.ClientTimeout = _aio.ClientError = object
    sys.modules["aiohttp"] = _aio
from tinhat import compose_entry, config, updater, updates  # noqa: E402


class _TmpOpt(unittest.TestCase):
    """Every test gets its own /opt/tinhat (never the source tree, whichever test module imported config first)."""

    def setUp(self):
        self.opt = Path(tempfile.mkdtemp())
        self._p = [mock.patch.object(config, "OPT", self.opt), mock.patch.object(config, "EDITION_FILE", self.opt / "EDITION"),
                   mock.patch.object(config, "PORTS_FILE", self.opt / "PORTS"), mock.patch.object(compose_entry, "OPT", self.opt)]
        for x in self._p:
            x.start()

    def tearDown(self):
        for x in self._p:
            x.stop()


class Edition(_TmpOpt):

    def test_editions(self):
        self.assertEqual(config.edition(), "appliance")
        (config.OPT / "EDITION").write_text("compose\n")
        self.assertEqual(config.edition(), "compose")
        self.assertTrue(config.own_machine() and config.compose_edition())
        (config.OPT / "EDITION").write_text("something else\n")
        self.assertEqual(config.edition(), "appliance")

    def test_proxy_only_works_for_compose_too(self):
        (config.OPT / "EDITION").write_text("compose\n")
        (config.OPT / "PORTS").write_text("proxy\n")
        self.assertTrue(config.proxy_only())

    def test_no_install_from_the_dashboard(self):
        (config.OPT / "EDITION").write_text("compose\n")
        with self.assertRaises(RuntimeError) as e:
            updates.start_install("owner")
        self.assertIn("docker compose pull", str(e.exception))
        self.assertTrue(updates.doc()["compose"])


class Entry(_TmpOpt):
    def test_mark_edition_and_proxy(self):
        with mock.patch.dict(os.environ, {"TINHAT_BEHIND_PROXY": "1"}):
            compose_entry.mark_edition()
        self.assertEqual((self.opt / "EDITION").read_text().strip(), "compose")
        self.assertEqual((self.opt / "PORTS").read_text().strip(), "proxy")
        with mock.patch.dict(os.environ, {"TINHAT_BEHIND_PROXY": "0"}):
            compose_entry.mark_edition()
        self.assertFalse((self.opt / "PORTS").exists())

    def test_process_manager_stops_what_it_started(self):
        pm = updater.ProcessManager()
        with mock.patch.object(updater.subprocess, "Popen") as popen:
            proc = popen.return_value
            proc.poll.return_value = None
            pm.start()
            pm.stop()
            proc.terminate.assert_called_once()
        self.assertIsNone(pm.proc)

    def test_proxy_here_only_where_the_name_leads(self):
        from tinhat import hw
        def ss(out):
            return mock.patch.object(compose_entry.subprocess, "run", return_value=mock.Mock(stdout=out, returncode=0))
        with mock.patch.object(hw, "addresses", return_value=["192.168.1.50"], create=True):  # another test may stub hw
            for out, want in (("LISTEN 0 511 0.0.0.0:443 0.0.0.0:*\n", True), ("LISTEN 0 511 [::]:443 [::]:*\n", True),
                              ("LISTEN 0 511 192.168.1.50:443 0.0.0.0:*\n", True), ("LISTEN 0 511 127.0.0.1:443 0.0.0.0:*\n", False),
                              ("", False)):
                with ss(out):
                    self.assertEqual(compose_entry._proxy_here(), want, out)

    def test_updater_defaults_to_systemd(self):
        self.assertIsInstance(updater.MANAGER, updater.SystemdManager)


if __name__ == "__main__":
    unittest.main()

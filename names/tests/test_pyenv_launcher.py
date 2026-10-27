"""M15: the names launcher (tinhat-names) starts the service on Tin Hat's pinned aiohttp only through pyenv.choose(),
before its app (and so aiohttp) is imported; without a built venv it runs on the system's aiohttp and says so (the
journal, its state folder's pyenv.json, `tinhat-names pyenv status`). tinhat_names/pyenv.py is the manager's own file.

Runs anywhere: a copy of this folder without wheels/ or venv/, in a scratch folder.
    python3 -m unittest discover -s tests
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
REPO = HERE.parent


class Launcher(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d)
        self.code, self.state = self.d / "code", self.d / "state"
        self.code.mkdir()
        self.state.mkdir()
        shutil.copy2(HERE / "tinhat-names", self.code / "tinhat-names")
        shutil.copytree(HERE / "tinhat_names", self.code / "tinhat_names", ignore=shutil.ignore_patterns("__pycache__"))

    def run_it(self, *args):
        env = {k: v for k, v in os.environ.items() if k != "TINHAT_PYENV"}
        env["STATE_DIRECTORY"] = str(self.state)
        return subprocess.run([sys.executable, "-B", str(self.code / "tinhat-names"), *args], capture_output=True,
                              text=True, env=env, timeout=120)

    def test_the_same_pyenv_as_the_manager(self):
        self.assertEqual((HERE / "tinhat_names/pyenv.py").read_bytes(),
                         (REPO / "appliance/rootfs/opt/tinhat/manager/tinhat/pyenv.py").read_bytes())

    def test_serve_without_its_venv_runs_on_the_systems_and_says_why(self):
        r = self.run_it("serve", "-c", str(self.d / "missing-config.json"))
        st = json.loads((self.state / "pyenv.json").read_text())  # written before the app was imported
        self.assertEqual(st["runtime"], "system")
        self.assertIn("no wheels", st["reason"])
        self.assertIn("NOT the pinned one", r.stderr)
        out = self.run_it("pyenv", "status")
        self.assertEqual(out.returncode, 0)
        self.assertIn("NOT Tin Hat's pinned copy", out.stdout)

    def test_check_without_a_venv_fails(self):
        (self.code / "wheels").mkdir()
        shutil.copy2(REPO / "build/wheels.lock", self.code / "wheels/wheels.lock")
        r = self.run_it("pyenv", "check")
        self.assertEqual(r.returncode, 1)
        self.assertIn("isn't built yet", r.stderr)
        r = self.run_it("serve", "-c", str(self.d / "missing-config.json"))
        self.assertIn("isn't built yet", json.loads((self.state / "pyenv.json").read_text())["reason"])

    def test_build_refuses_wheels_that_arent_there(self):
        (self.code / "wheels").mkdir()
        shutil.copy2(REPO / "build/wheels.lock", self.code / "wheels/wheels.lock")
        r = self.run_it("pyenv", "build")
        self.assertEqual(r.returncode, 1)
        self.assertIn("is missing", r.stderr)
        self.assertFalse((self.code / "venv").exists())


if __name__ == "__main__":
    unittest.main()

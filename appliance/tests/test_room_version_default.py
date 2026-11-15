"""New rooms' version (templates.HOMESERVER_YAML `default_room_version`): 11 since 0.3.17.

- 11, not 10: version 11's redaction rules keep what earlier versions let a redaction strip (MSC2176, MSC3821), so an
  event can't be stripped down into a different one that still checks out;
- never 12 (or later) without a decision: a v12 room's id is the hash of its create event, which names its creator on
  this server's name, so "Move to your own domain" refuses a server holding one (move_synapse.ROOM_VERSIONS);
- the default is always a version a move takes, and the only room version the file names.
Existing rooms keep theirs: the default only applies to rooms made after it.

Runs anywhere: the modules templates.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import re
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PKG = ROOT / "rootfs/opt/tinhat/manager/tinhat"


def load_templates():
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        for m in ("config", "environment", "state"):
            sys.modules[f"tinhat.{m}"] = types.ModuleType(f"tinhat.{m}")
        hw = types.ModuleType("tinhat.hw")
        hw.addresses = lambda: ["192.0.2.30"]
        sys.modules["tinhat.hw"] = hw
        spec = importlib.util.spec_from_file_location("tinhat.templates", PKG / "templates.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.templates"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


def load_move():
    spec = importlib.util.spec_from_file_location("move_synapse", PKG / "move_synapse.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


templates = load_templates()
move = load_move()
SECRETS = {"postgres_password": "p", "registration_shared_secret": "r", "macaroon_secret_key": "m", "form_secret": "f"}
LINE = re.compile(r'^default_room_version:\s*"([^"]*)"\s*$', re.M)


def rendered(**kw) -> str:
    return templates.homeserver_yaml("crew.example.org", SECRETS, **kw)


class DefaultRoomVersion(unittest.TestCase):
    def test_new_rooms_are_version_11(self):
        for kw in ({}, {"federation": []}, {"federation": ["friends.example.net"]}):
            found = LINE.findall(rendered(**kw))
            self.assertEqual(found, ["11"], kw)

    def test_never_12_or_later_by_default(self):
        (v,) = LINE.findall(rendered())
        self.assertTrue(v.isdigit() and int(v) < 12, v)

    def test_a_version_a_move_takes(self):
        (v,) = LINE.findall(rendered())
        self.assertIn(v, move.ROOM_VERSIONS)
        self.assertEqual(move.refused_versions({v}), set())

    def test_one_room_version_setting(self):
        y = rendered(federation=["friends.example.net"])
        self.assertEqual(len(re.findall(r"room_version", y)), 1, "only default_room_version names a room version")


if __name__ == "__main__":
    unittest.main()

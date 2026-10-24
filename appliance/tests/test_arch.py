"""Which build an update or install.sh takes: amd64 keeps the manifest's old `images` key (servers already out there
read only that), arm64 takes `images_arm64` and the bundle's images.lock.arm64, and a release without an arm64
build is "not out for this processor yet" there.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import platform
import sys
import types
import unittest
from unittest import mock

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load_config():
    pkg = sys.modules.get("tinhat") or types.ModuleType("tinhat")
    pkg.__path__ = [str(PKG)]
    sys.modules["tinhat"] = pkg
    spec = importlib.util.spec_from_file_location("tinhat.config", PKG / "config.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


config = load_config()
MANIFEST = {"version": "0.3.0", "images": {"tinhat/caddy:2.10.2-dns": {"id": "sha256:aaa"}},
            "images_arm64": {"tinhat/caddy:2.10.2-dns": {"id": "sha256:bbb"}}}


class Arch(unittest.TestCase):
    def test_amd64(self):
        with mock.patch.object(platform, "machine", return_value="x86_64"):
            self.assertEqual(config.arch(), "amd64")
            self.assertEqual(config.lock_name(), "images.lock")
            self.assertEqual(config.manifest_images(MANIFEST)["tinhat/caddy:2.10.2-dns"]["id"], "sha256:aaa")

    def test_arm64(self):
        with mock.patch.object(platform, "machine", return_value="aarch64"):
            self.assertEqual(config.arch(), "arm64")
            self.assertEqual(config.lock_name(), "images.lock.arm64")
            self.assertEqual(config.manifest_images(MANIFEST)["tinhat/caddy:2.10.2-dns"]["id"], "sha256:bbb")
            self.assertIsNone(config.manifest_images({"images": MANIFEST["images"]}))


if __name__ == "__main__":
    unittest.main()

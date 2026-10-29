"""The home-network certificate authority's private key is not in a backup (security review, server manager lows;
sec-night-2 2026-10-27): whoever holds a backup could otherwise issue certificates the owner's devices trust. The public
root ("ca") still is; a restore from a backup without the key says each device installs the new certificate once.

Runs anywhere (reads the sources; backup.py / install.py need the manager's runtime to import):
    python3 -m unittest discover -s appliance/tests
"""
import ast
import pathlib
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def _list(src: str, name: str) -> list:
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found")


class BackupHasNoCaKey(unittest.TestCase):
    def test_the_pki_folder_is_not_backed_up(self):
        items = _list((PKG / "backup.py").read_text(), "STATE_ITEMS")
        self.assertIn("ca", items)  # the public root: yes
        self.assertIn("synapse/signing.key", items)  # the server's identity: yes
        for it in items:
            self.assertFalse(it.startswith("caddy/data"), it)

    def test_the_update_snapshot_on_this_box_still_keeps_it(self):
        # updater.py's own list is the same machine's rollback copy, not a backup: unchanged
        self.assertIsInstance(_list((PKG / "updater.py").read_text(), "STATE_ITEMS"), list)

    def test_a_restore_without_the_key_tells_the_owner(self):
        src = (PKG / "install.py").read_text()
        self.assertIn('not (root / "state" / "caddy" / "data" / "caddy" / "pki").exists()', src)
        self.assertIn("install it once more on each phone", src)


if __name__ == "__main__":
    unittest.main()

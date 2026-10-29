"""Old guest links (the call-only scheme removed in 0.3.1: /call/legacy.html?room=…, /?join=…, /guest/…) get the guest
door page in every Caddy mode, which explains them (api/guest/door.js; docs/GUESTS.md "Old guest links"), instead of
the web app being handed an address it doesn't know. With TINHAT_TEST_CADDY=/path/to/caddy Caddy adapts every file."""
import os
import pathlib
import subprocess
import tempfile
import unittest

from test_manager_limits import caddyfiles, CADDY

SERVING = ("home network", "from anywhere", "from anywhere, relay, lab roots", "own domain", "own reverse proxy",
           "own reverse proxy on this machine", "moved, former names")
BLOCK = ("\t\t@oldguest {\n\t\t\tpath /call/legacy.html /guest /guest/*\n\t\t}\n"
         "\t\t@oldjoin {\n\t\t\tpath / /index.html\n\t\t\tquery join=*\n\t\t}\n"
         "\t\trewrite @oldguest /call/index.html\n\t\trewrite @oldjoin /call/index.html\n"
         "\t\ttry_files {path} {path}index.html /index.html\n")


class EveryMode(unittest.TestCase):
    def test_every_web_app_block_sends_old_guest_links_to_the_door_page(self):
        files = caddyfiles()
        for mode in SERVING:
            cf = files[mode]
            with self.subTest(mode):
                apps = cf.count("try_files {path} {path}index.html /index.html\n")
                self.assertGreaterEqual(apps, 1)
                self.assertEqual(cf.count(BLOCK), apps, "right before the web app's own fallback, in every web app block")
                self.assertEqual(cf.count("/call/ /call/* /guest /guest/*\n"), apps, "the aliases are no-cache like the door page")
                # the API's own /api/guest/* routes are untouched (the door page's knock and ticket calls)
                self.assertNotIn("path /api/guest", cf.split("@oldguest", 1)[1].split("}", 1)[0])


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyAdaptsThem(unittest.TestCase):
    def test_adapts(self):
        for mode, text in caddyfiles().items():
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                (pathlib.Path(d) / "Caddyfile").write_text(text)
                env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
                r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                   capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-1500:])


if __name__ == "__main__":
    unittest.main()

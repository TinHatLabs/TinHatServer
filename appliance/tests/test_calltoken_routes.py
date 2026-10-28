"""Calls round M1b (0.3.7): call sign-ins go through the API's room check (api/tinhat-api/calltoken.mjs) in every Caddy
mode, a former name's site included: /livekit/jwt and everything under it reach the API at /calltoken/…, and only lk-jwt's
health check goes to lk-jwt (127.0.0.1:8070) directly. The owner's switch CALL_TOKEN_ROOM_CHECK is one of the API's
limits (apiconf.LIMITS: on|off, written into the API's environment by env_text).

Runs anywhere (templates.py's own imports are stubbed, as in test_manager_limits). With TINHAT_TEST_CADDY=/path/to/caddy
every Caddyfile is also adapted by Caddy itself and the order of its routes is checked.
    python3 -m unittest discover -s appliance/tests
"""
import json
import os
import subprocess
import tempfile
import pathlib
import unittest

from test_manager_limits import caddyfiles, walk_routes, CADDY

SERVING = ("home network", "from anywhere", "from anywhere, relay, lab roots", "own domain", "own reverse proxy",
           "own reverse proxy on this machine", "moved, former names")


class TheText(unittest.TestCase):
    def test_every_mode_sends_call_signins_to_the_api(self):
        files = caddyfiles()
        for mode in SERVING:
            cf = files[mode]
            with self.subTest(mode):
                sites = cf.count("handle /livekit/jwt {\n")
                self.assertGreaterEqual(sites, 1)
                self.assertEqual(cf.count("\t\trewrite * /calltoken/sfu/get\n"), sites)
                self.assertEqual(cf.count("handle_path /livekit/jwt/* {\n\t\trewrite * /calltoken{path}\n"), sites)
                self.assertEqual(cf.count("handle /livekit/jwt/healthz {\n\t\trewrite * /healthz\n\t\treverse_proxy 127.0.0.1:8070\n\t}"), sites)
                # lk-jwt is reached for its health check only
                self.assertEqual(cf.count("127.0.0.1:8070"), sites)
                self.assertNotIn("rewrite * /sfu/get", cf)
        self.assertEqual(files["moved, former names"].count("handle /livekit/jwt {\n"), 3)  # the name + two former ones


@unittest.skipUnless(CADDY and os.access(CADDY, os.X_OK), "TINHAT_TEST_CADDY isn't set")
class CaddyAdaptsThem(unittest.TestCase):
    def test_health_check_first_everything_else_to_the_api(self):
        files = caddyfiles()
        for mode in SERVING:
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                (pathlib.Path(d) / "Caddyfile").write_text(files[mode])
                env = {"HOME": d, "XDG_DATA_HOME": d, "XDG_CONFIG_HOME": d, "PATH": "/usr/bin:/bin"}
                r = subprocess.run([CADDY, "adapt", "--adapter", "caddyfile", "--config", f"{d}/Caddyfile"],
                                   capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-1500:])
                seen = 0
                for routes in walk_routes(json.loads(r.stdout), []):
                    paths = [p for rt in routes for m in rt.get("match", []) for p in m.get("path", [])]
                    if "/livekit/jwt/*" not in paths:
                        continue
                    seen += 1
                    def at(p):
                        return next(i for i, rt in enumerate(routes) if any(p in m.get("path", []) for m in rt.get("match", [])))
                    self.assertLess(at("/livekit/jwt/healthz"), at("/livekit/jwt/*"))
                    for p, dial in (("/livekit/jwt/healthz", "127.0.0.1:8070"), ("/livekit/jwt", "127.0.0.1:3001"),
                                    ("/livekit/jwt/*", "127.0.0.1:3001")):
                        text = json.dumps(routes[at(p)])
                        self.assertIn(f'"dial": "{dial}"', text, (mode, p))
                        self.assertNotIn("8070" if dial != "127.0.0.1:8070" else "3001", text, (mode, p))
                self.assertGreaterEqual(seen, 1)


if __name__ == "__main__":
    unittest.main()

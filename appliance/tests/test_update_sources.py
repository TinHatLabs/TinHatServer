"""The update check with several sources (GitHub's latest release, then a mirror): only signed answers count, the
newest signed version wins (a tie goes to the first source), a signature that fails once because a release landed
between the two requests is fetched again, and the owner sees one plain message when nothing usable came back.

Runs anywhere (no aiohttp needed): the modules updates.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import json
import pathlib
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
GH = "https://github.com/OWNER/REPO/releases/latest/download/stable.json"
MIRROR = "https://updates.tinhat.dev/server/stable.json"
STORE = {}
ENV = {"updates_url": f"{GH} {MIRROR}"}


class Session:
    def __init__(self, **_):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


def load():
    """updates.py against stubs, in a package of its own; the other tests' modules are put back afterwards."""
    saved = {k: v for k, v in sys.modules.items() if k in ("tinhat", "aiohttp") or k.startswith("tinhat.")}
    try:
        return _load()
    finally:
        for k in [k for k in sys.modules if k in ("tinhat", "aiohttp") or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


def _load():
    pkg = types.ModuleType("tinhat")
    pkg.__path__ = [str(PKG)]
    sys.modules["tinhat"] = pkg
    aio = types.ModuleType("aiohttp")
    aio.ClientSession, aio.ClientTimeout = Session, lambda **_: None
    aio.ClientError = type("ClientError", (Exception,), {})
    sys.modules["aiohttp"] = aio
    config = types.ModuleType("tinhat.config")
    config.STATE_DIR, config.VERSION = pathlib.Path("/nonexistent/tinhat"), "0.2.13"
    config.arch, config.manifest_images = (lambda: "amd64"), (lambda m: m.get("images"))
    environment = types.ModuleType("tinhat.environment")
    environment.env, environment.ssl_context = (lambda: ENV), (lambda: None)
    state = types.ModuleType("tinhat.state")
    state.read_json = lambda p, default=None: STORE.get(str(p), default)
    state.write_json = lambda p, d, mode=0o600: STORE.__setitem__(str(p), d)
    state.load_state = lambda: {}
    for name, m in (("config", config), ("environment", environment), ("state", state)):
        sys.modules[f"tinhat.{name}"] = m
        setattr(pkg, name, m)
    spec = importlib.util.spec_from_file_location("tinhat.updates", PKG / "updates.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["tinhat.updates"] = mod
    spec.loader.exec_module(mod)
    return mod


updates = load()


def channel(answers: dict):
    """answers: url → list of (manifest dict | None for unreachable, signed?) per attempt."""
    seen = {u: 0 for u in answers}

    async def get(_session, url, limit=1 << 20):
        base = url[: -len(".minisig")] if url.endswith(".minisig") else url
        tries = answers.get(base)
        if tries is None:
            raise OSError(f"{url}: unreachable")
        i = min(seen[base], len(tries) - 1)
        m, signed = tries[i]
        if m is None:
            raise OSError(f"{url}: unreachable")
        if url.endswith(".minisig"):
            seen[base] += 1
            return b"good" if signed else b"bad"
        return json.dumps(m).encode()

    updates._get = get
    updates.verify = lambda body, sig: sig == b"good"


def release(v):
    return {"version": v, "bundle": {"url": f"tinhat-server-{v}.update.tar.gz", "size": 1, "sha256": "0"},
            "images": {}, "notes": []}


class Sources(unittest.TestCase):
    def setUp(self):
        STORE.clear()
        ENV["updates_url"] = f"{GH} {MIRROR}"

    def run_check(self):
        return asyncio.run(updates.check())

    def test_urls(self):
        self.assertEqual(updates.channel_urls(), [GH, MIRROR])
        ENV["updates_url"] = [MIRROR]
        self.assertEqual(updates.channel_urls(), [MIRROR])
        ENV["updates_url"] = MIRROR
        self.assertEqual(updates.channel_urls(), [MIRROR])

    def test_newest_signed_wins(self):
        channel({GH: [(release("0.3.0"), True)], MIRROR: [(release("0.3.1"), True)]})
        st = self.run_check()
        self.assertEqual(st["phase"], "available")
        self.assertEqual(st["available"]["version"], "0.3.1")
        self.assertEqual(STORE[str(updates.MANIFEST)]["url"], MIRROR)

    def test_tie_goes_to_the_first(self):
        channel({GH: [(release("0.3.0"), True)], MIRROR: [(release("0.3.0"), True)]})
        self.run_check()
        self.assertEqual(STORE[str(updates.MANIFEST)]["url"], GH)

    def test_unsigned_newer_is_ignored(self):
        channel({GH: [(release("0.3.0"), True)], MIRROR: [(release("9.9.9"), False)]})
        st = self.run_check()
        self.assertEqual(st["available"]["version"], "0.3.0")
        self.assertIsNone(st["check_error"])

    def test_first_unreachable(self):
        channel({MIRROR: [(release("0.3.0"), True)]})
        st = self.run_check()
        self.assertEqual(st["available"]["version"], "0.3.0")
        self.assertEqual(STORE[str(updates.MANIFEST)]["url"], MIRROR)

    def test_release_landing_mid_check(self):
        channel({GH: [(release("0.3.0"), False), (release("0.3.1"), True)]})
        ENV["updates_url"] = GH
        st = self.run_check()
        self.assertEqual(st["available"]["version"], "0.3.1")

    def test_nothing_signed(self):
        channel({GH: [(release("0.3.0"), False)], MIRROR: [(release("0.3.0"), False)]})
        st = self.run_check()
        self.assertIn("wasn't signed by Tin Hat", st["check_error"])

    def test_nothing_reachable(self):
        channel({})
        st = self.run_check()
        self.assertEqual(st["check_error"], "Couldn't reach the update service.")

    def test_current(self):
        channel({GH: [(release("0.2.13"), True)], MIRROR: [(release("0.2.12"), True)]})
        st = self.run_check()
        self.assertEqual(st["phase"], "current")


if __name__ == "__main__":
    unittest.main()

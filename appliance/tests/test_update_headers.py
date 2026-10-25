"""0.3.2: the updater's HTTP session takes a header as big as GitHub's release downloads send (a ~9.2 KB
content-security-policy, 2026-10-24) — with the real aiohttp against a local server that sends a 20 KB header. The
default session refuses it (what kept 0.3.0 and 0.3.1 off GitHub). Skipped where aiohttp isn't installed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest

try:
    import aiohttp
    from aiohttp import web
except ImportError:  # pragma: no cover
    aiohttp = None

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load_updates():
    """updates.py with the REAL aiohttp; only the package's own modules are stubbed (then put back)."""
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.")}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        config = types.ModuleType("tinhat.config")
        config.STATE_DIR, config.VERSION = pathlib.Path("/nonexistent/tinhat"), "0.3.2"
        environment = types.ModuleType("tinhat.environment")
        environment.env, environment.ssl_context = (lambda: {"updates_url": ""}), (lambda: None)
        state = types.ModuleType("tinhat.state")
        for name, m in (("config", config), ("environment", environment), ("state", state)):
            sys.modules[f"tinhat.{name}"] = m
            setattr(pkg, name, m)
        spec = importlib.util.spec_from_file_location("tinhat.updates", PKG / "updates.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


@unittest.skipIf(aiohttp is None, "aiohttp isn't installed here")
class BigHeaders(unittest.TestCase):
    def test_github_sized_header(self):
        updates = load_updates()

        async def run():
            async def hello(_req):
                return web.Response(text="ok", headers={"Content-Security-Policy": "x" * 20000})

            app = web.Application()
            app.router.add_get("/stable.json", hello)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            url = f"http://127.0.0.1:{port}/stable.json"
            try:
                async with aiohttp.ClientSession() as plain:  # what 0.3.0/0.3.1 did
                    with self.assertRaises(aiohttp.ClientError):
                        async with plain.get(url) as r:
                            await r.read()
                async with updates._session(total=10) as s:
                    self.assertEqual(await updates._get(s, url), b"ok")
            finally:
                await runner.cleanup()

        asyncio.run(run())

    def test_body_in_pieces(self):
        """A manifest that arrives in several pieces is read whole (read(n) used to stop at the first), and the limit
        still holds."""
        updates = load_updates()

        async def run():
            async def pieces(_req):
                r = web.StreamResponse()
                await r.prepare(_req)
                for part in (b'{"version": ', b'"0.3.2", ', b'"pad": "' + b"x" * 3000 + b'"}'):
                    await r.write(part)
                    await asyncio.sleep(0.05)
                await r.write_eof()
                return r

            app = web.Application()
            app.router.add_get("/stable.json", pieces)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/stable.json"
            try:
                async with updates._session(total=10) as s:
                    body = await updates._get(s, url)
                    self.assertTrue(body.startswith(b'{"version": "0.3.2", "pad": "xxx'))
                    self.assertTrue(body.endswith(b'"}'))
                    with self.assertRaises(RuntimeError):
                        await updates._get(s, url, limit=100)
            finally:
                await runner.cleanup()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

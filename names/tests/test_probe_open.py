"""/v1/probe-open: the outside check for servers on their owners' own domains. A proof of work bound to the domain
instead of an account; it only ever connects back to the caller, with the domain as the TLS name. The network probes are
fakes. Needs aiohttp (skipped without it): run where the service runs, e.g.
    python3 -m unittest discover -s names/tests
"""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    from aiohttp.test_utils import TestClient, TestServer
    from tinhat_names import app as app_mod
    from tinhat_names import config as config_mod
    from tinhat_names import pow as pow_mod
    HAVE_AIOHTTP = True
except ImportError:  # a machine without aiohttp: these tests skip
    HAVE_AIOHTTP = False


class FakeDNS:
    def __init__(self, *a, **k):
        pass

    async def start(self):
        pass

    async def close(self):
        pass

    async def baseline(self, apex_ip, mail=None):
        pass


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class ProbeOpen(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / "cf.token").write_text("x")
        (d / "admin.token").write_text("admintoken")
        cfg = config_mod.load(None)
        cfg.update(db=str(d / "n.db"), secret_key_file=str(d / "pow.key"), admin_token_file=str(d / "admin.token"),
                   invite_only=False, pow_bits=4)
        cfg["dns"]["token_file"] = str(d / "cf.token")
        cfg["limits"].update(probes_per_hour=3)
        self.orig = (app_mod.Cloudflare, app_mod.probe.tls443, app_mod.probe.tcp, app_mod.probe.udp_echo)
        app_mod.Cloudflare = FakeDNS
        self.seen = []

        async def tls443(ip, host, nonce, ctx, timeout):
            self.seen.append(("tls443", ip, host))
            return {"ok": True}

        async def tcp(ip, port, timeout):
            self.seen.append(("tcp", ip, port))
            return {"ok": True}

        async def udp_echo(ip, port, nonce, timeout):
            self.seen.append(("udp", ip, port))
            return {"ok": False, "why": "no-answer"}
        app_mod.probe.tls443, app_mod.probe.tcp, app_mod.probe.udp_echo = tls443, tcp, udp_echo
        self.client = TestClient(TestServer(app_mod.make_app(cfg)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        app_mod.Cloudflare, app_mod.probe.tls443, app_mod.probe.tcp, app_mod.probe.udp_echo = self.orig
        self.tmp.cleanup()

    async def ask(self, host, solve_for=None, checks=("tls443", "tcp7881", "udp7882"), reuse=None):
        r = await self.client.post("/v1/challenge", json={})
        ch = await r.json()
        if reuse:
            ch = reuse
        # the work is bound to the domain as the service writes it (lower case, no final dot), like the box sends it
        sol = pow_mod.solve(ch["nonce"], solve_for or host.strip().lower().rstrip("."), ch["bits"])
        r = await self.client.post("/v1/probe-open", json={"host": host, "pow_nonce": ch["nonce"], "solution": sol,
                                                           "nonce": "n0nce-abcdefgh", "checks": list(checks)})
        return r.status, await r.json(), ch

    async def test_checks_the_caller_with_its_own_domain(self):
        st, out, _ = await self.ask("Chat.Example.com.")
        self.assertEqual(st, 200, out)
        self.assertEqual(out["host"], "chat.example.com")
        self.assertEqual(set(out["results"]), {"tls443", "tcp7881", "udp7882"})
        ip = out["ip"]
        self.assertEqual(self.seen, [("tls443", ip, "chat.example.com"), ("tcp", ip, 7881), ("udp", ip, 7882)])

    async def test_refuses_what_it_isnt_for(self):
        for host in ("1.2.3.4", "localhost", "crew.tinhat.me", "tinhat.me", "", "a..b.com"):
            st, out, _ = await self.ask(host)
            self.assertEqual(st, 400, host)
        self.assertEqual(self.seen, [])

    async def test_the_work_is_bound_to_the_domain_and_used_once(self):
        st, out, _ = await self.ask("chat.example.com", solve_for="other.example.com")
        self.assertEqual((st, out["error"]), (400, "pow"))
        st, _, ch = await self.ask("chat.example.com")
        self.assertEqual(st, 200)
        st, out, _ = await self.ask("chat.example.com", reuse=ch)
        self.assertEqual((st, out["error"]), (400, "pow"))

    async def test_hourly_limit_per_address(self):
        for _ in range(3):
            self.assertEqual((await self.ask("chat.example.com"))[0], 200)
        st, out, _ = await self.ask("chat.example.com")
        self.assertEqual((st, out["error"]), (429, "limit-probe"))

    async def test_only_known_checks(self):
        st, out, _ = await self.ask("chat.example.com", checks=("tls443", "tcp22"))
        self.assertEqual(set(out["results"]), {"tls443"})


if __name__ == "__main__":
    unittest.main()

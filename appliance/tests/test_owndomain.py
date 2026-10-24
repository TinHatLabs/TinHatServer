"""Own domains: what setup accepts, the Caddy lines per provider, and which server names a connection accepts.

Runs anywhere (no aiohttp needed): the modules these import are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load(name: str):
    pkg = sys.modules.get("tinhat") or types.ModuleType("tinhat")
    pkg.__path__ = [str(PKG)]
    sys.modules["tinhat"] = pkg
    try:
        import aiohttp  # noqa: F401  (the real one when it's there)
    except ImportError:
        stub = types.ModuleType("aiohttp")
        stub.ClientSession, stub.ClientTimeout, stub.ClientError = object, object, Exception
        sys.modules["aiohttp"] = stub
    env = types.ModuleType("tinhat.environment")
    env.env = lambda: {"zone": "tinhat.me"}
    sys.modules["tinhat.environment"] = env
    pkg.environment = env
    for stub in ("compose", "config", "names", "state"):
        m = sys.modules.setdefault(f"tinhat.{stub}", types.ModuleType(f"tinhat.{stub}"))
        setattr(pkg, stub, m)
    sys.modules["tinhat.config"].INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    spec = importlib.util.spec_from_file_location(f"tinhat.{name}", PKG / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"tinhat.{name}"] = mod
    setattr(pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


owndomain = load("owndomain")
federation = load("federation")
CF = "a" * 40


class Validate(unittest.TestCase):
    def ok(self, name, domain):
        got, problem = owndomain.validate({"name": name, "domain": domain})
        self.assertIsNone(problem)
        return got

    def bad(self, name, domain, words):
        got, problem = owndomain.validate({"name": name, "domain": domain})
        self.assertIsNone(got)
        self.assertIn(words, problem)

    def test_cloudflare(self):
        got = self.ok(" Chat.Example.com. ", {"provider": "cloudflare", "token": CF})
        self.assertEqual(got, {"domain": "chat.example.com", "provider": "cloudflare", "creds": {"token": CF}})

    def test_porkbun_needs_both_keys(self):
        self.ok("chat.example.com", {"provider": "porkbun", "apiKey": "pk1_x", "secretKey": "sk1_y"})
        self.bad("chat.example.com", {"provider": "porkbun", "apiKey": "pk1_x"}, "Porkbun")

    def test_names_that_cant_have_a_certificate(self):
        for name in ("chat", "chat.local", "crew.tinhat.me", "tinhat.me", "1.2.3.4", "-x.example.com", "a..b.com"):
            got, problem = owndomain.validate({"name": name, "domain": {"provider": "cloudflare", "token": CF}})
            self.assertIsNone(got, name)

    def test_provider_and_credentials(self):
        self.bad("chat.example.com", {"provider": "route53", "token": CF}, "provider")
        self.bad("chat.example.com", {"provider": "cloudflare", "token": ""}, "Cloudflare")
        self.bad("chat.example.com", {"provider": "cloudflare", "token": "two words"}, "Cloudflare")

    def test_keys_never_carry_caddyfile_syntax(self):
        # They go into the Caddyfile as bare words: a quote, brace, comment or placeholder would change its meaning.
        for token in ('abc"', "abc}", "a{$HOME}", "x#y", "`x`", "a\nb", "a;b"):
            with self.subTest(token=token):
                self.bad("chat.example.com", {"provider": "cloudflare", "token": token}, "API key")
                with self.assertRaises(ValueError):
                    owndomain.caddy_tls("cloudflare", {"token": token})
        self.ok("chat.example.com", {"provider": "desec", "token": "Ab-9_x.y~z+/="})

    def test_duckdns_only_under_duckdns(self):
        self.ok("crew.duckdns.org", {"provider": "duckdns", "token": "t"})
        self.bad("chat.example.com", {"provider": "duckdns", "token": "t"}, "duckdns.org")


class CaddyLines(unittest.TestCase):
    def test_each_provider(self):
        self.assertEqual(owndomain.caddy_tls("cloudflare", {"token": CF}), f"\t\tdns cloudflare {CF}\n")
        self.assertIn("api_secret_key s", owndomain.caddy_tls("porkbun", {"apiKey": "k", "secretKey": "s"}))
        self.assertIn("token t", owndomain.caddy_tls("desec", {"token": "t"}))
        self.assertEqual(owndomain.caddy_tls("duckdns", {"token": "t"}), "\t\tdns duckdns t\n")
        with self.assertRaises(ValueError):
            owndomain.caddy_tls("route53", {})


class ConnectionNames(unittest.TestCase):
    def test_tinhat_names(self):
        for given in ("crew", "Crew", "crew.tinhat.me", "https://crew.tinhat.me/", "http://crew.tinhat.me/x"):
            self.assertEqual(federation.normalize(given), "crew.tinhat.me", given)
        self.assertIsNone(federation.normalize("a.b.tinhat.me"))
        self.assertIsNone(federation.normalize("cr_ew"))

    def test_own_domains(self):
        self.assertEqual(federation.normalize("chat.example.com"), "chat.example.com")
        self.assertEqual(federation.normalize("https://Chat.Example.com./"), "chat.example.com")

    def test_never_home_names_or_addresses(self):
        for given in ("printer.local", "nas.lan", "box.home.arpa", "10.0.0.5", "1.2.3.4", "x.localhost", "", "   "):
            self.assertIsNone(federation.normalize(given), given)


class PublicAddress(unittest.TestCase):
    """The home's public address: a private answer (the router's NAT loopback, when the server is in the same house as
    the names service) is never used; a public "what's my address" service is asked instead."""

    def run_with(self, names_answer, echo_text):
        import asyncio

        class NamesError(Exception):
            pass

        async def info():
            if isinstance(names_answer, Exception):
                raise names_answer
            return {"your_ip": names_answer}

        class Resp:
            async def text(self):
                return echo_text

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

        class Session:
            asked = []

            def __init__(self, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def get(self, url, **kw):
                Session.asked.append(url)
                return Resp()

        names = owndomain.names
        aio = owndomain.aiohttp
        saved = (getattr(names, "info", None), getattr(names, "NamesError", None), aio.ClientSession, aio.ClientTimeout,
                 getattr(owndomain.environment, "ssl_context", None))
        names.info, names.NamesError, aio.ClientSession, aio.ClientTimeout = info, NamesError, Session, lambda **kw: None
        owndomain.environment.ssl_context = lambda: None
        try:
            return asyncio.run(owndomain.public_ip()), Session.asked
        finally:
            names.info, names.NamesError, aio.ClientSession, aio.ClientTimeout, owndomain.environment.ssl_context = saved

    def test_public_answer_from_the_names_service(self):
        ip, asked = self.run_with("11.91.0.3", "ip=11.91.0.4")
        self.assertEqual((ip, asked), ("11.91.0.3", []))

    def test_nat_loopback_answer_is_never_used(self):
        ip, asked = self.run_with("192.168.1.1", "fl=1\nip=11.91.0.4\nts=1")
        self.assertEqual(ip, "11.91.0.4")
        self.assertTrue(asked)

    def test_no_private_echo_either(self):
        self.assertEqual(self.run_with("10.0.0.1", "192.168.1.1")[0], None)

    def test_is_public_v4(self):
        self.assertTrue(owndomain.is_public_v4("11.91.0.3"))
        for bad in (None, "", "192.168.1.1", "100.64.0.2", "127.0.0.1", "224.0.0.1", "2001:db8::1", "nonsense"):
            self.assertFalse(owndomain.is_public_v4(bad), bad)


if __name__ == "__main__":
    unittest.main()

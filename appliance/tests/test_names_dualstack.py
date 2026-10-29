"""A box with IPv4 and IPv6 gets both addresses under its tinhat.me name (assembly-038, launch-gate's P1 of 2026-10-28).

The names service puts the CALLER's address under the name (A for an IPv4 caller, AAAA for an IPv6 one) and leaves the
other record alone, so names.update() speaks to it once per family. A fake names service here sees each family and keeps
an A and an AAAA, counting a change only when that family's address really changes (its daily limit).
Also: owndomain.public_ip() takes an IPv6 answer as public and asks for IPv4 over IPv4; reach's words per family.

Runs anywhere: the manager modules names.py / owndomain.py / reach.py import are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import importlib.util
import pathlib
import socket
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
STATE, SECRETS = {}, {"names": {"box_id": "box1", "secret": "s"}}


def _load(modname: str, extra: dict):
    saved = {k: v for k, v in sys.modules.items() if k == "tinhat" or k.startswith("tinhat.") or k == "aiohttp"}
    try:
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        try:
            import aiohttp  # noqa: F401  (the real one when it is installed)
        except ImportError:
            a = types.ModuleType("aiohttp")
            a.ClientError = type("ClientError", (Exception,), {})
            a.ClientTimeout = lambda **kw: None
            a.TCPConnector = lambda **kw: None
            sys.modules["aiohttp"] = a
        st = types.ModuleType("tinhat.state")
        st.load_state = lambda: dict(STATE)
        st.save_state = lambda **kw: STATE.update(kw)
        st.load_secrets = lambda: dict(SECRETS)
        st.save_secrets = lambda **kw: SECRETS.update(kw)
        st.write_json = lambda *a, **k: None
        cfg = types.ModuleType("tinhat.config")
        cfg.VERSION, cfg.STATE_DIR = "0.3.8", pathlib.Path("/nonexistent")
        env = types.ModuleType("tinhat.environment")
        env.env = lambda: {"names_url": "https://names.example", "zone": "example.me"}
        env.ssl_context = lambda: None
        pow_ = types.ModuleType("tinhat.pow_client")
        pow_.solve = lambda *a: "sol"
        for name, m in {"state": st, "config": cfg, "environment": env, "pow_client": pow_, **extra}.items():
            sys.modules[f"tinhat.{name}"] = m
        spec = importlib.util.spec_from_file_location(f"tinhat.{modname}", PKG / f"{modname}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"tinhat.{modname}"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k == "tinhat" or k.startswith("tinhat.") or k == "aiohttp"]:
            if k not in saved:
                del sys.modules[k]
        sys.modules.update(saved)


names = _load("names", {})
REAL_CALL = names._call  # the other classes swap in a fake service; the pinning test needs the real one


class FakeService:
    """What names.tinhat.dev does per family: the caller's address goes under the name, the other record stays."""

    def __init__(self, v4="198.51.100.7", v6="2001:db8:5::7", routes=(socket.AF_INET, socket.AF_INET6), default=socket.AF_INET6):
        self.addr = {socket.AF_INET: v4, socket.AF_INET6: v6}
        self.routes, self.default = set(routes), default
        self.a = self.aaaa = None
        self.changes, self.calls, self.notices = 0, [], [{"id": 1, "text": "hello"}]
        self.status = 200
        self.fail = {}  # family -> NamesError for that family only

    async def call(self, method, path, *, json=None, params=None, auth=False, timeout=20, family=0):
        fam = family or self.default
        self.calls.append((path, fam))
        if fam not in self.routes:
            raise names.NamesError("Can't reach the Tin Hat names service.", "offline")
        if fam in self.fail:
            raise self.fail[fam]
        if self.status != 200:
            raise names.NamesError("This server's name was moved.", "moved", self.status)
        ip = self.addr[fam]
        if path in ("/v1/update", "/v1/register"):
            cur = self.a if fam == socket.AF_INET else self.aaaa
            if ip != cur:
                self.changes += 1
                if fam == socket.AF_INET:
                    self.a = ip
                else:
                    self.aaaa = ip
        if path == "/v1/register":
            return {"ok": True, "fqdn": "crew.example.me", "box_id": "box1", "secret": "s", "acme": {}, "ip": ip}
        if path == "/v1/challenge":
            return {"nonce": "n", "bits": 1}
        n, self.notices = self.notices, []
        return {"ok": True, "status": "active", "ip4": self.a, "ip6": self.aaaa, "notices": n, "changed": False}


def run(svc, coro_fn):
    names._call = svc.call
    return asyncio.run(coro_fn())


class Update(unittest.TestCase):
    def setUp(self):
        STATE.clear()

    def test_dual_stack_gets_both_records(self):
        svc = FakeService()
        res = run(svc, names.update)
        self.assertEqual((svc.a, svc.aaaa), ("198.51.100.7", "2001:db8:5::7"))
        self.assertEqual([f for _, f in svc.calls], [socket.AF_INET, socket.AF_INET6], "one call per family, pinned")
        self.assertEqual((res["ip4"], res["ip6"]), ("198.51.100.7", "2001:db8:5::7"))
        self.assertEqual((STATE["names_status"]["ip4"], STATE["names_status"]["ip6"]), ("198.51.100.7", "2001:db8:5::7"))
        self.assertEqual(STATE["names_notices"], [{"id": 1, "text": "hello"}], "notices kept once")

    def test_no_ipv6_route_is_quiet(self):
        svc = FakeService(routes=(socket.AF_INET,))
        res = run(svc, names.update)
        self.assertEqual((res["ip4"], res["ip6"]), ("198.51.100.7", None))
        self.assertEqual(STATE["names_status"]["status"], "active")

    def test_ipv6_only_box(self):
        svc = FakeService(routes=(socket.AF_INET6,))
        res = run(svc, names.update)
        self.assertEqual((res["ip4"], res["ip6"]), (None, "2001:db8:5::7"))

    def test_no_route_at_all_raises_offline(self):
        svc = FakeService(routes=())
        with self.assertRaises(names.NamesError) as c:
            run(svc, names.update)
        self.assertEqual(c.exception.code, "offline")

    def test_moved_on_every_family(self):
        svc = FakeService()
        svc.status = 401
        res = run(svc, names.update)
        self.assertEqual(res["status"], "error")
        self.assertEqual(STATE["names_status"]["status"], "moved")

    def test_moved_on_one_family_wins_over_an_error_or_a_success_on_the_other(self):
        for v4 in (names.NamesError("Try again in a minute.", "hairpin", 503), None):
            with self.subTest(v4=v4):
                STATE.clear()
                svc = FakeService()
                if v4:
                    svc.fail[socket.AF_INET] = v4
                svc.fail[socket.AF_INET6] = names.NamesError("This server's name was moved.", "moved", 401)
                res = run(svc, names.update)
                self.assertEqual(res["error"], "moved")
                self.assertEqual(STATE["names_status"]["status"], "moved")
                STATE.pop("former_name_status", None)
                self.assertEqual(run(svc, names.keep_former)["status"], "moved")

    def test_keep_former_reports_an_auth_error_over_a_hairpin(self):
        STATE.clear()
        svc = FakeService()
        svc.fail[socket.AF_INET] = names.NamesError("Try again in a minute.", "hairpin", 503)
        svc.fail[socket.AF_INET6] = names.NamesError("Unknown server.", "auth", 401)
        doc = run(svc, names.keep_former)
        self.assertEqual((doc["status"], doc["error"]), ("error", "Unknown server."))

    def test_only_real_changes_count_toward_the_daily_limit(self):
        svc = FakeService()
        for _ in range(12):  # two hours of 10-minute updates, both families each time
            run(svc, names.update)
        self.assertEqual(svc.changes, 2, "the first A and the first AAAA; nothing after (the limit is 6 a day)")
        svc.addr[socket.AF_INET] = "198.51.100.8"  # the home's IPv4 changed once
        run(svc, names.update)
        self.assertEqual(svc.changes, 3)


class Register(unittest.TestCase):
    def setUp(self):
        STATE.clear()

    def test_register_over_ipv6_then_ipv4_right_away(self):
        # the registration itself goes over the box's default route (IPv6 here): only the AAAA would exist without the
        # update right after it
        svc = FakeService(default=socket.AF_INET6)
        res = run(svc, lambda: names.register("crew", "CODE"))
        self.assertEqual((svc.a, svc.aaaa), ("198.51.100.7", "2001:db8:5::7"))
        self.assertEqual((res["ip4"], res["ip6"]), ("198.51.100.7", "2001:db8:5::7"))

    def test_register_survives_a_failed_follow_up(self):
        svc = FakeService(routes=(socket.AF_INET6,), default=socket.AF_INET6)
        res = run(svc, lambda: names.register("crew", "CODE"))
        self.assertEqual(res["fqdn"], "crew.example.me")
        self.assertEqual((svc.a, svc.aaaa), (None, "2001:db8:5::7"))


try:
    import aiohttp  # noqa: F401
    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False


def _loopback(fam):
    try:
        with socket.socket(fam, socket.SOCK_STREAM) as x:
            x.bind(("::1" if fam == socket.AF_INET6 else "127.0.0.1", 0))
        return True
    except OSError:
        return False


@unittest.skipUnless(HAVE_AIOHTTP and _loopback(socket.AF_INET6) and _loopback(socket.AF_INET),
                     "needs the real aiohttp and both loopback families")
class FamilyPinning(unittest.TestCase):
    """The real aiohttp connector pins the family: a name that resolves to both (localhost) with the service listening
    on ONE family only — the call over the other family fails, it never falls back (launch-gate, 2026-10-28: on a box
    whose gai.conf prefers IPv4 the update still went out over IPv6)."""

    def serve_on(self, host):
        from aiohttp import web

        async def go(fam):
            app = web.Application()
            app.router.add_get("/v1/info", lambda r: web.json_response({"your_ip": r.remote}))
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, host, 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            names.environment.env = lambda: {"names_url": f"http://localhost:{port}", "zone": "example.me"}
            try:
                await REAL_CALL("GET", "/v1/info", family=fam, timeout=5)
                return "answered"
            except names.NamesError as e:
                return e.code
            finally:
                await runner.cleanup()
        return go

    def test_ipv4_only_service(self):
        go = self.serve_on("127.0.0.1")
        self.assertEqual(asyncio.run(go(socket.AF_INET)), "answered")
        self.assertEqual(asyncio.run(go(socket.AF_INET6)), "offline", "the IPv6 call must not reach the IPv4 listener")

    def test_ipv6_only_service(self):
        go = self.serve_on("::1")
        self.assertEqual(asyncio.run(go(socket.AF_INET)), "offline", "the IPv4 call must not fall back to IPv6")
        try:  # getaddrinfo's AI_ADDRCONFIG hides ::1 on a host without an IPv6 address (= a box without IPv6)
            v6 = bool(socket.getaddrinfo("localhost", 80, socket.AF_INET6, socket.SOCK_STREAM, 0, socket.AI_ADDRCONFIG))
        except socket.gaierror:
            v6 = False
        if v6:
            self.assertEqual(asyncio.run(go(socket.AF_INET6)), "answered")
        else:
            self.assertEqual(asyncio.run(go(socket.AF_INET6)), "offline", "no IPv6 address here: no IPv6 call either")


class FamilyLog(unittest.TestCase):
    def setUp(self):
        STATE.clear()

    def test_a_changed_address_is_logged_per_family(self):
        svc = FakeService()
        with self.assertLogs("tinhat.names", "INFO") as cm:
            run(svc, names.update)
        text = "\n".join(cm.output)
        self.assertRegex(text, r"names: A \S.* → 198\.51\.100\.7 \(was none\)")
        self.assertRegex(text, r"names: AAAA \S.* → 2001:db8:5::7 \(was none\)")
        with self.assertLogs("tinhat.names", "INFO") as cm2:
            names.log.info("marker")
            run(svc, names.update)
        self.assertEqual([x for x in cm2.output if "→" in x], [], "no change, no line")

    def test_a_family_failing_over_an_hour_warns_once_an_hour(self):
        svc = FakeService()
        run(svc, names.update)  # both families work: A and AAAA exist
        svc.fail[socket.AF_INET6] = names.NamesError("Can't reach the Tin Hat names service.", "offline")
        real = names.time.time
        try:
            t = [real()]
            names.time.time = lambda: t[0]
            run(svc, names.update)  # starts failing
            t[0] += 1800
            with self.assertRaises(AssertionError):  # nothing to warn about yet
                with self.assertLogs("tinhat.names", "WARNING"):
                    run(svc, names.update)
            t[0] += 1900
            with self.assertLogs("tinhat.names", "WARNING") as cm:
                run(svc, names.update)
            self.assertIn("over ipv6 has failed for 61 min", cm.output[0])
            t[0] += 600
            with self.assertRaises(AssertionError):  # not again within the hour
                with self.assertLogs("tinhat.names", "WARNING"):
                    run(svc, names.update)
        finally:
            names.time.time = real


@unittest.skipUnless(HAVE_AIOHTTP, "owndomain imports the real aiohttp")
class PublicIp(unittest.TestCase):
    def test_ipv6_answer_then_ipv4_over_ipv4(self):
        nm = types.ModuleType("tinhat.names")
        nm.NamesError = names.NamesError
        asked = []

        async def info(family=0):
            asked.append(family)
            return {"your_ip": "2606:4700::1111" if family == 0 else "198.51.100.7"}
        nm.info = info
        hw = types.ModuleType("tinhat.hw")
        od = _load("owndomain", {"names": nm, "hw": hw})
        # no third-party echo may be asked in a test, and the documentation range stands in for a public IPv4 here
        od.environment.env = lambda: {"names_url": "https://names.example", "zone": "example.me", "ip_echoes": []}
        real_v4 = od.is_public_v4
        od.is_public_v4 = lambda ip: str(ip or "").startswith("198.51.100.") or real_v4(ip)
        self.assertEqual(asyncio.run(od.public_ip()), "198.51.100.7")
        self.assertEqual(asked, [0, socket.AF_INET], "the names service again, over IPv4, before any echo")
        self.assertTrue(od.is_public_v6("2606:4700::1111"))
        for bad in ("fd12:3456:789a::1", "fe80::1", "::1", "::ffff:198.51.100.7", "198.51.100.7", None, "x"):
            self.assertFalse(od.is_public_v6(bad), bad)


def _reach():
    nm = types.ModuleType("tinhat.names")
    nm.NamesError = names.NamesError
    mods = {n: types.ModuleType(f"tinhat.{n}") for n in ("compose", "hw", "portmap", "owndomain", "relay")}
    return _load("reach", {"names": nm, **mods}), nm


class ReachPerFamily(unittest.TestCase):
    OK = {"tls443": {"ok": True}, "tcp7881": {"ok": True}, "udp7882": {"ok": True}}
    BAD = {"tls443": {"ok": False, "why": "unreachable"}, "tcp7881": {"ok": False}, "udp7882": {"ok": False}}

    def probe_with(self, reach, nm, v4, v6):
        self.asked = {}

        async def probe(nonce, checks, family=0, timeout=45):
            self.asked[family] = (list(checks), timeout)
            r = v4 if family == socket.AF_INET else v6
            if r is None:
                raise names.NamesError("Can't reach the Tin Hat names service.", "offline")
            return {"results": r, "ip": "198.51.100.7" if family == socket.AF_INET else "2001:db8:5::7"}
        nm.probe = probe
        return asyncio.run(reach._per_family("n4" * 8, "n6" * 8, ["tls443", "tcp7881", "udp7882"]))

    def test_ipv4_decides_when_the_box_has_ipv4(self):
        reach, nm = _reach()
        out = self.probe_with(reach, nm, self.OK, self.BAD)
        self.assertTrue(out["ok"])
        self.assertFalse(out.get("only_ipv6"))
        sm = reach.summary({"kind": "direct"}, out)
        self.assertEqual(sm["level"], "good")
        self.assertTrue(any("Over IPv6" in x for x in sm["lines"]), sm["lines"])
        self.assertEqual(self.asked[socket.AF_INET6], (["tls443"], 25), "IPv6: HTTPS only (IPv4-only stand-ins), bounded")
        self.assertEqual(self.asked[socket.AF_INET][0], ["tls443", "tcp7881", "udp7882"])

    def test_only_ipv6_is_said_plainly(self):
        reach, nm = _reach()
        out = self.probe_with(reach, nm, None, self.OK)
        self.assertTrue(out["ok"] and out["only_ipv6"])
        sm = reach.summary({"kind": "direct"}, out)
        self.assertEqual(sm["level"], "warn")
        self.assertIn("without it can't", sm["headline"])
        self.assertTrue(any("over IPv6 friends can reach it" in x for x in sm["lines"]), sm["lines"])

    def test_ipv4_https_fine_but_a_call_port_blocked_is_not_called_an_https_failure(self):
        reach, nm = _reach()
        v4 = {"tls443": {"ok": True}, "tcp7881": {"ok": False, "why": "unreachable"}, "udp7882": {"ok": True}}
        out = self.probe_with(reach, nm, v4, {"tls443": {"ok": True}})
        self.assertFalse(any("over IPv4 they can't" in x for x in reach.family_lines(out)))

    def test_cgnat_with_working_ipv6_says_so(self):
        reach, nm = _reach()
        out = self.probe_with(reach, nm, self.BAD, {"tls443": {"ok": True}})
        sm = reach.summary({"kind": "cgnat"}, out)
        self.assertEqual(sm["level"], "warn")
        self.assertIn("IPv6 can still reach", sm["headline"])

    def test_no_ipv4_answer_and_ipv6_failing_is_not_only_ipv6(self):
        reach, nm = _reach()
        out = self.probe_with(reach, nm, None, self.BAD)
        self.assertFalse(out["ok"])
        self.assertFalse(out.get("only_ipv6"))

    def test_both_families_without_a_route(self):
        reach, nm = _reach()
        with self.assertRaises(names.NamesError):
            self.probe_with(reach, nm, None, None)

    def test_ipv4_blocked_ipv6_fine(self):
        reach, nm = _reach()
        out = self.probe_with(reach, nm, self.BAD, self.OK)
        self.assertFalse(out["ok"], "IPv4 decides: IPv4-only friends can't connect")
        self.assertTrue(out["families"]["ipv6"]["ok"])


if __name__ == "__main__":
    unittest.main()

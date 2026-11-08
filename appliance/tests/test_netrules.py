"""The owner's deny-list (netrules.py, docs/NETWORK-RULES.md): what an owner may block, the edge refusal in every
Caddyfile (checked against how Synapse 1.145 itself reads the X-Matrix header, with a harness shown able to fail),
Synapse's config (allow-list, media, the module), the apps' document and Federation.block / unblock."""
import asyncio
import importlib
import json
import os
import random
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_manager_limits as tml  # noqa: E402  (every rendered Caddyfile, with its stand-ins)

T = tml.templates


# ---- how Synapse reads the header (synapse/federation/transport/server/_base.py, 1.145, _parse_auth_header) ------
def synapse_origin(value: str):
    """The origin Synapse takes from one Authorization value, or None when it refuses the header."""
    if not value.startswith("X-Matrix"):
        return None
    try:
        params = re.split(r"[ \t]*,[ \t]*", re.split(r"^X-Matrix +", value, maxsplit=1)[1])
        d = {k.lower(): v for k, v in [p.split("=", maxsplit=1) for p in params]}

        def strip_quotes(v: str) -> str:
            if v.startswith('"'):
                return re.sub("\\\\(.)", lambda m: m.group(1), v[1:-1])
            return v
        origin = strip_quotes(d["origin"])
        if not origin or not d.get("key") or not d.get("sig"):
            return None
        return origin
    except (IndexError, ValueError, KeyError):
        return None


def same_machine(origin: str, name: str) -> bool:
    """origin names the blocked server as Synapse 1.145 splits a server name (synapse/util/stringutils.py
    parse_server_name: rsplit at the last colon, the port through Python's int()): any case, a trailing dot."""
    host, sep, port = origin.rpartition(":")
    if sep:
        try:
            int(port)
        except ValueError:
            return False
    else:
        host = origin
    return host.rstrip(".").lower() == name


BLOCKED = ["evil.example", "spam-farm.example"]
NEAR = ["notevil.example", "evil.example.org", "evil-example", "evil.exampl", "xevil.example", "evil.examples",
        "spam-farm.example.net", "friend.example"]


def variants(rng: random.Random, name: str) -> list[str]:
    """Authorization values that claim `name` (or come close), in the ways a header can be written."""
    def case(s):
        return "".join(c.upper() if rng.random() < 0.3 else c for c in s)

    def esc(s):
        return "".join(("\\" + c) if rng.random() < 0.3 else c for c in s)
    suffix = rng.choice(["", ".", ":8448", ".:443", ":", ":0", ":+8448", ":8_448", ": 8448", ":\u0668\u0664\u0664\u0668", ":-1"])
    n = case(name) + suffix
    origin = rng.choice([n, f'"{n}"', f'"{esc(n)}"', f'"{n}x', f'"{esc(n)}\\"', f'"{n}', f'"{n}"x', f'{n}"'])
    key = rng.choice(["origin", "Origin", "ORIGIN", " origin", "origin "])
    parts = [f"{key}={origin}", 'key="ed25519:a1"', 'sig="c2lnbmF0dXJl"', 'destination="home.example"']
    rng.shuffle(parts)
    if rng.random() < 0.3:
        parts.insert(rng.randrange(len(parts) + 1), "origin=innocent.example")
    sep = lambda: rng.choice([",", ", ", " ,", "\t,\t", " , "])  # noqa: E731
    head = rng.choice(["X-Matrix ", "X-Matrix  ", "X-Matrix\t", "x-matrix ", "X-Matrix"])
    out = head + parts[0]
    for p in parts[1:]:
        out += sep() + p
    if rng.random() < 0.2:  # a random character dropped in somewhere
        i = rng.randrange(len(out) + 1)
        out = out[:i] + rng.choice(['"', "\\", ",", " ", "=", "a", "."]) + out[i:]
    return [out]


def bypasses(pattern: str, rounds: int = 6000, seed: int = 1107) -> list[str]:
    """Headers Synapse would take as from a blocked server that the pattern doesn't refuse."""
    rx = re.compile(pattern)
    rng = random.Random(seed)
    found = []
    for _ in range(rounds):
        name = rng.choice(BLOCKED + NEAR)
        for v in variants(rng, name):
            o = synapse_origin(v)
            if o is not None and any(same_machine(o, b) for b in BLOCKED) and not rx.search(v):
                found.append(v)
    return found


class EdgePattern(unittest.TestCase):
    def test_no_spelling_synapse_takes_for_a_blocked_server_gets_past(self):
        self.assertEqual(bypasses(T.fed_deny_regex(BLOCKED))[:5], [])

    def test_the_harness_can_fail(self):
        # negative controls: a naive pattern, and the real one without its quote rule, both let something through
        naive = r'origin="?(?:evil\.example|spam-farm\.example)"?'
        self.assertTrue(bypasses(naive), "the harness must find a way past a naive pattern")
        real = T.fed_deny_regex(BLOCKED)
        no_drop = real.replace(r"[^,][ \t]*(?:,|$))", r'"[ \t]*(?:,|$))')
        self.assertNotEqual(no_drop, real)
        self.assertTrue(bypasses(no_drop), "Synapse drops the last character of a quoted value whatever it is")

    def test_well_formed_headers_of_other_servers_pass(self):
        rx = re.compile(T.fed_deny_regex(BLOCKED))
        for n in NEAR + ["innocent.example"]:
            for o in (n, f'"{n}"', f'"{n}:8448"'):
                for v in (f'X-Matrix origin={o},key="ed25519:a",sig="s"', f'X-Matrix key="ed25519:a", origin={o}, sig="s"'):
                    self.assertIsNone(rx.search(v), v)
        self.assertIsNone(rx.search('Bearer origin="evil.example"'), "not a federation header")
        self.assertIsNone(rx.search('X-Matrix key="origin=evil.example",origin=friend.example,sig="s"'),
                          "Synapse reads origin=friend.example here")

    def test_names_that_arent_names_are_left_out(self):
        self.assertRaises(ValueError, T.fed_deny_regex, ["bad name", "x`y", ""])
        self.assertNotIn("`", T.fed_deny_regex(["a.example", "x`y.example"]))


class EveryCaddyfile(unittest.TestCase):
    def test_refusal_first_in_every_synapse_route(self):
        for mode, cf in tml.caddyfiles().items():
            with self.subTest(mode):
                self.assertEqual(T.with_fed_deny(cf, []), cf, "nothing blocked: the file as it was")
                out = T.with_fed_deny(cf, ["evil.example"])
                lines = out.splitlines()
                src = cf.splitlines()
                to_synapse = sum(1 for i, l in enumerate(src) if re.fullmatch(r"\t+handle /_matrix/\* \{", l)
                                 and src[i + 1].strip() == "import tinhat_no_multipart"
                                 and src[i + 2].strip().startswith("reverse_proxy 127.0.0.1:8008"))
                handles = [i for i, l in enumerate(lines) if re.fullmatch(r"\t+handle /_matrix/\* \{", l)
                           and lines[i + 1].strip().startswith("@tinhat_blocked_origin_")]
                self.assertTrue(to_synapse or mode.startswith("setup"), "Synapse is served after setup")
                self.assertEqual(len(handles), to_synapse, "every block that goes to Synapse, only those")
                self.assertEqual(T.strip_fed_deny(out), cf)
                for k, i in enumerate(handles, 1):
                    self.assertEqual(lines[i + 1].strip(),
                                     f"@tinhat_blocked_origin_{k} header_regexp Authorization `{T.fed_deny_regex(['evil.example'])}`")
                    self.assertEqual(lines[i + 2].strip(), f'respond @tinhat_blocked_origin_{k} "{T.FED_DENY_REFUSED}" 403')
                    self.assertEqual(lines[i + 3].strip(), "import tinhat_no_multipart")
                    self.assertIn("reverse_proxy 127.0.0.1:8008", lines[i + 4])
                self.assertEqual(out.count("@tinhat_blocked_origin_"), 2 * len(handles))

    def test_refusal_also_in_a_route_written_before_the_multipart_rule(self):
        cf = ":443 {\n\thandle /_matrix/* {\n\t\treverse_proxy 127.0.0.1:8008\n\t}\n}\n"
        out = T.with_fed_deny(cf, ["evil.example"])
        self.assertEqual(out.count("@tinhat_blocked_origin_"), 2)
        self.assertEqual(T.strip_fed_deny(out), cf)

    def test_no_refusal_in_a_block_that_does_not_go_to_synapse(self):
        cf = ":80 {\n\thandle /_matrix/* {\n\t\timport tinhat_no_multipart\n\t\tredir https://x{uri}\n\t}\n}\n"
        self.assertEqual(T.with_fed_deny(cf, ["evil.example"]), cf)

    @unittest.skipUnless(os.environ.get("TINHAT_TEST_CADDY"), "TINHAT_TEST_CADDY isn't set")
    def test_caddy_adapts_it(self):
        import subprocess
        caddy = os.environ["TINHAT_TEST_CADDY"]
        for mode, cf in tml.caddyfiles().items():
            if "handle /_matrix/* {" not in cf:
                continue
            with self.subTest(mode), tempfile.TemporaryDirectory() as d:
                p = Path(d, "Caddyfile")
                p.write_text(T.with_fed_deny(cf, BLOCKED))
                r = subprocess.run([caddy, "adapt", "--config", str(p), "--adapter", "caddyfile"], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr[-800:])
                self.assertIn("header_regexp", r.stdout)


# ---- the manager's side, on a temporary state folder -----------------------------------------------------------------
_OPT = HERE.parent / "rootfs" / "opt" / "tinhat"


def _real_package():
    """The real tinhat package (the template tests above leave no stand-ins behind: tml.stubs() restores them)."""
    os.environ.setdefault("TINHAT_OPT", str(_OPT))
    os.environ["TINHAT_STATE"] = os.environ.get("TINHAT_STATE") or tempfile.mkdtemp()
    if str(_OPT / "manager") not in sys.path:
        sys.path.insert(0, str(_OPT / "manager"))
    return importlib.import_module("tinhat.apiconf"), importlib.import_module("tinhat.netrules"), \
        importlib.import_module("tinhat.state"), importlib.import_module("tinhat.config")


try:
    APICONF, NETRULES, STATE, CONFIG = _real_package()
    TEMPLATES = importlib.import_module("tinhat.templates")
except Exception as e:  # noqa: BLE001
    APICONF = None
    WHY = repr(e)


def on_disk(**st):
    Path(CONFIG.STATE_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(CONFIG.STATE_FILE).write_text(json.dumps(st))


SECRETS = {k: "x" for k in ("postgres_password", "registration_shared_secret", "macaroon_secret_key", "form_secret")}


@unittest.skipIf(APICONF is None, "the manager package didn't load")
class Manager(unittest.TestCase):
    def test_names_the_owner_may_block(self):
        n = NETRULES.normalize_block
        for typed, want in (("Example.org", "example.org"), ("https://example.org/x", "example.org"), ("@sam:Evil.Example", "evil.example"),
                            ("crew.tinhat.me", "crew.tinhat.me"), ("evil.example.", "evil.example")):
            self.assertEqual(n(typed), (want, None), typed)
        for bad in ("", "evil.example:8448", "10.0.0.1", "box.local", "bad name", "exämple.org", "x" * 301):
            self.assertIsNone(n(bad)[0], bad)
        self.assertEqual(n("Home.Example", own="home.example")[0], None)

    def test_entries_survive_a_damaged_list(self):
        st = {"blocked_servers": [{"server": "Evil.Example", "since": 1}, {"server": "evil.example"}, "junk", {"server": 7},
                                  {"server": "bad name"}, {"server": "b.example", "since": 2}]}
        self.assertEqual(NETRULES.names(st), ["b.example", "evil.example"])
        self.assertEqual(NETRULES.without_blocked(["Evil.Example", "ok.example", "b.example."], ["evil.example", "b.example"]), ["ok.example"])

    def test_homeserver_yaml(self):
        y = TEMPLATES.homeserver_yaml("home.example", SECRETS, None, ["friend.example", "Evil.Example", "peer.example"],
                                      connected=["peer.example", "evil.example"], blocked=["evil.example"])
        self.assertIn('federation_domain_whitelist: ["friend.example", "peer.example"]', y)
        self.assertIn('prevent_media_downloads_from: ["evil.example"]', y)
        mod = y[y.index("tinhat_network.NetworkRules"):]
        self.assertIn('blocked: ["evil.example"]', mod)
        self.assertIn('connected: ["peer.example"]', mod, "a blocked server is never counted as connected")
        self.assertIn('"per_server": 20', mod)
        self.assertIn("db: /data/tinhat-network.db", mod)
        guard = y[y.index("tinhat_rules.GuestRules"):y.index("tinhat_calls.CallHook")]
        self.assertIn('connected: ["peer.example"]', guard)
        y0 = TEMPLATES.homeserver_yaml("home.example", SECRETS, None, None, blocked=["evil.example"])
        self.assertIn("federation_domain_whitelist: []", y0)  # home mode: no federation listener anyway
        y1 = TEMPLATES.homeserver_yaml("home.example", SECRETS, None, ["friend.example"])
        self.assertIn("prevent_media_downloads_from: []", y1)
        try:
            import yaml  # noqa: PLC0415
        except ImportError:
            return  # the text checks above ran; PyYAML parses it where it's installed
        doc = yaml.safe_load(y)
        self.assertEqual(doc["federation_domain_whitelist"], ["friend.example", "peer.example"])
        mods = {m["module"]: m.get("config") for m in doc["modules"]}
        self.assertEqual(mods["tinhat_network.NetworkRules"]["quotas"], {"overall": 100, "per_recipient": 5, "per_server": 20, "window_s": 3600})

    def test_the_apps_document(self):
        st = {"mode": "anywhere", "connections": [{"server": "peer.example"}, {"server": "evil.example"}],
              "blocked_servers": [{"server": "evil.example", "since": 1}, {"server": "plain.example", "since": 1}]}
        self.assertEqual(APICONF.network(st), {"v": 1, "mode": "connected", "connected": ["peer.example"],
                                               "blocked": ["evil.example", "plain.example"], "invites": {"default": "known"}})
        self.assertEqual(APICONF.network({"mode": "lan", **{k: v for k, v in st.items() if k != "mode"}})["blocked"], [])
        self.assertTrue(APICONF.features({"mode": "anywhere"}, {})["invite_rules"])
        self.assertFalse(APICONF.features({"mode": "lan"}, {})["invite_rules"])

    def test_module_file(self):
        on_disk(blocked_servers=[{"server": "evil.example", "since": 1}])
        self.assertTrue(NETRULES.publish_rules())
        p = APICONF.MODULES_DIR / NETRULES.RULES_FILE
        self.assertEqual(json.loads(p.read_text()), {"v": 1, "blocked": ["evil.example"]})
        self.assertEqual(p.stat().st_mode & 0o777, 0o644)
        self.assertFalse(NETRULES.publish_rules(), "unchanged: not written again")

    def test_refusals_from_the_modules_database(self):
        d = tempfile.mkdtemp()
        db = Path(d, "x.db")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE invites (ts REAL, server TEXT, recipient TEXT, outcome TEXT, stranger INTEGER)")
        c.executemany("INSERT INTO invites VALUES (?, ?, ?, ?, 0)", [(100, "a.example", "@me:h", "ok"), (200, "b.example", "@me:h", "invite-rules"),
                                                                     (300, "b.example", "@you:h", "too-many-invites"), (400, "c.example", "@me:h", "server-blocked")])
        c.commit()
        c.close()
        r = NETRULES.recent_refusals(db_path=db)
        self.assertEqual([x["server"] for x in r], ["c.example", "b.example", "b.example"])
        self.assertNotIn("recipient", json.dumps(r), "who was invited stays out of the dashboard")
        self.assertEqual(NETRULES.busy_servers(db_path=db, now=500)[0], {"server": "b.example", "refused": 2})
        self.assertEqual(NETRULES.recent_refusals(db_path=Path(d, "missing.db")), [])

    def test_stale_edge(self):
        try:
            from tinhat import web  # noqa: PLC0415  (needs aiohttp)
        except ImportError as e:
            self.skipTest(f"the dashboard module needs aiohttp: {e}")
        cf = tml.caddyfiles()["from anywhere"]
        self.assertFalse(web.fed_deny_stale(cf, []))
        self.assertTrue(web.fed_deny_stale(cf, ["evil.example"]))
        live = T.with_fed_deny(cf, ["evil.example"])
        self.assertFalse(web.fed_deny_stale(live, ["evil.example"]))
        self.assertTrue(web.fed_deny_stale(live, ["evil.example", "b.example"]))
        self.assertTrue(web.fed_deny_stale(live, []), "left after the last Unblock")
        y = TEMPLATES.homeserver_yaml("home.example", SECRETS, None, ["a.example"], blocked=["evil.example"])
        self.assertFalse(web.synapse_denylist_stale(y, ["evil.example"]))
        self.assertTrue(web.synapse_denylist_stale(y, []))
        self.assertTrue(web.synapse_denylist_stale(y, ["evil.example", "b.example"]))
        old = y.replace('prevent_media_downloads_from: ["evil.example"]\n', "")
        self.assertFalse(web.synapse_denylist_stale(old, []), "a file from before the deny-list, nothing blocked")
        self.assertTrue(web.synapse_denylist_stale(old, ["evil.example"]))


@unittest.skipIf(APICONF is None, "the manager package didn't load")
class BlockUnblock(unittest.TestCase):
    """Through the modules federation.py itself uses (other test files may have loaded their own copies)."""
    def setUp(self):
        try:
            self.fed = importlib.import_module("tinhat.federation")
        except ImportError as e:
            self.skipTest(f"federation needs aiohttp: {e}")
        self.state, self.nr = self.fed.state, self.fed.netrules
        self.api, self.cfg = self.nr.apiconf, self.state.config
        self.tmp = tempfile.TemporaryDirectory()
        saved = (self.cfg.STATE_FILE, self.api.MODULES_DIR, self.api.DIR)

        def restore():
            self.cfg.STATE_FILE, self.api.MODULES_DIR, self.api.DIR = saved
            self.tmp.cleanup()
        self.addCleanup(restore)
        self.cfg.STATE_FILE = Path(self.tmp.name) / "state.json"
        self.api.MODULES_DIR = Path(self.tmp.name) / "modules"
        self.api.DIR = Path(self.tmp.name) / "api"
        self.disk(server_name="home.example", mode="anywhere", phase="ready",
                  connections=[{"server": "peer.example", "since": 1, "by": "x"}],
                  allowed_servers=[{"server": "plain.example", "since": 1, "by": "x"}], federation=["peer.example", "plain.example"])
        self.calls = []

        async def apply(allow):
            self.calls.append(("synapse", list(allow)))
            return True, "ok"

        async def edge():
            self.calls.append(("caddy",))
            return True, "ok"
        self.f = self.fed.Federation(apply, edge_cb=edge)

    def disk(self, **st):
        Path(self.cfg.STATE_FILE).write_text(json.dumps(st))

    def run_(self, coro):
        async def go():
            r = await coro
            await asyncio.sleep(0.05)  # the background apply
            return r
        return asyncio.run(go())

    def test_block_keeps_the_lists_and_applies_caddy_first(self):
        ok, msg = self.run_(self.f.block("https://Plain.Example/", "@owner:home.example", "spam\ninvites"))
        self.assertTrue(ok, msg)
        st = self.state.load_state()
        self.assertEqual([e["server"] for e in st["blocked_servers"]], ["plain.example"])
        self.assertEqual(st["blocked_servers"][0]["reason"], "spam invites")
        self.assertEqual([a["server"] for a in st["allowed_servers"]], ["plain.example"], "the allowance stays for Unblock")
        self.assertEqual(st["federation"], ["peer.example", "plain.example"], "Synapse's effective list leaves it out (templates)")
        self.assertEqual(self.calls[0], ("caddy",))
        self.assertEqual(self.calls[1][0], "synapse")
        self.assertEqual(json.loads((self.api.MODULES_DIR / self.nr.RULES_FILE).read_text())["blocked"], ["plain.example"])
        self.assertEqual(self.api.network()["blocked"], ["plain.example"])
        self.assertFalse(self.run_(self.f.block("plain.example", "x"))[0], "already blocked")
        self.assertFalse(self.run_(self.f.block("home.example", "x"))[0], "this server")
        ok, _ = self.run_(self.f.unblock("plain.example"))
        self.assertTrue(ok)
        self.assertEqual(self.nr.names(), [])
        self.assertEqual(json.loads((self.api.MODULES_DIR / self.nr.RULES_FILE).read_text())["blocked"], [])
        self.assertEqual([a["server"] for a in self.state.load_state()["allowed_servers"]], ["plain.example"])
        self.assertFalse(self.run_(self.f.unblock("plain.example"))[0])

    def test_blocking_a_connected_server(self):
        self.assertTrue(self.run_(self.f.block("peer.example", "x"))[0])
        self.assertEqual(self.api.network()["connected"], [], "never connected for the apps while blocked")
        self.assertEqual([c["server"] for c in self.state.load_state()["connections"]], ["peer.example"])

    def test_a_cap(self):
        self.disk(server_name="home.example", mode="anywhere",
                  blocked_servers=[{"server": f"s{i}.example", "since": 1} for i in range(self.nr.MAX_BLOCKED)])
        self.assertFalse(self.run_(self.f.block("one-more.example", "x"))[0])

    def test_home_mode_saves_the_list_only(self):
        self.disk(server_name="home.example", mode="lan", phase="ready")
        self.assertTrue(self.run_(self.f.block("evil.example", "x"))[0])
        self.assertEqual(self.nr.names(), ["evil.example"])
        self.assertEqual(self.calls, [], "no Synapse restart, no federation listener in home mode")

    def test_not_while_moving(self):
        self.f.busy = lambda: "moving"
        self.assertEqual(self.run_(self.f.block("evil.example", "x")), (False, "moving"))
        self.assertEqual(self.nr.names(), [])


if __name__ == "__main__":
    unittest.main()

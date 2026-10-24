import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tinhat_names import pow as pw  # noqa: E402
from tinhat_names import rules  # noqa: E402
from tinhat_names.db import DB  # noqa: E402


class Rules(unittest.TestCase):
    def ok(self, n):
        self.assertTrue(rules.check(n)[0], n)

    def bad(self, n, code):
        ok, c, _ = rules.check(n)
        self.assertFalse(ok, n)
        self.assertEqual(c, code, n)

    def test_plain_names(self):
        for n in ("crew", "squad", "sams-crew", "the-boys-2026", "minecraft-crew", "valorant-squad", "riot-squad",
                  "epic-gamers", "live-crew", "pineapple"):
            self.ok(n)

    def test_format(self):
        for n in ("ab", "abc", "-crew", "crew-", "Crew!", "cr ew", "a" * 33, "cr--ew", "crew.me", ""):
            self.assertFalse(rules.check(n)[0], n)
        self.bad("xn--crew", "punycode")

    def test_system(self):
        self.assertFalse(rules.check("www")[0])  # too short anyway
        for n in ("admin", "tinhat", "names", "abuse", "wallet"):
            self.bad(n, "system")
        # a deployment's own reserved names (config.json "reserved")
        self.assertTrue(rules.check("ourcrew")[0])
        self.assertEqual(rules.check("ourcrew", frozenset({"ourcrew"}))[:2], (False, "system"))

    def test_brands_and_lookalikes(self):
        for n in ("paypal", "paypa1", "rnicrosoft", "steam-gifts", "discord-crew", "g00gle", "coinbase"):
            self.bad(n, "brand")

    def test_phish(self):
        for n in ("crew-login", "secure-verify", "support-desk", "nitro-claim", "my-wallet-sync", "steamlogin"):
            ok, code, _ = rules.check(n)
            self.assertFalse(ok, n)
            self.assertIn(code, ("phish", "brand"), n)

    def test_offensive(self):
        self.bad("shit-crew", "offensive")
        self.bad("n1gger", "offensive")
        self.ok("scunthorpe-fc")  # mild words only match as whole parts


class Pow(unittest.TestCase):
    def test_roundtrip(self):
        key = os.urandom(32)
        ch = pw.make(key, 12)
        sol = pw.solve(ch["nonce"], "crew", ch["bits"])
        self.assertEqual(pw.check(key, ch["nonce"], "crew", sol, 12), (True, ""))
        self.assertFalse(pw.check(key, ch["nonce"], "other", sol, 12)[0])  # bound to the name
        self.assertFalse(pw.check(os.urandom(32), ch["nonce"], "crew", sol, 12)[0])  # bound to our key
        self.assertFalse(pw.check(key, ch["nonce"], "crew", sol, 16)[0])  # too easy for the current setting

    def test_expired(self):
        key = os.urandom(32)
        ch = pw.make(key, 4, ttl=-1)
        sol = pw.solve(ch["nonce"], "crew", 4)
        self.assertEqual(pw.check(key, ch["nonce"], "crew", sol, 4), (False, "challenge expired"))


class Store(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.db = DB(os.path.join(self.d.name, "n.db"))

    def tearDown(self):
        self.d.cleanup()

    def test_codes(self):
        c = self.db.new_code(max_uses=1, days=1, note="test")
        self.assertRegex(c, r"^TN-[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.assertTrue(self.db.code_ok(c.lower()))
        self.db.use_code(c)
        self.assertFalse(self.db.code_ok(c))
        c2 = self.db.new_code()
        self.db.revoke_code(c2)
        self.assertFalse(self.db.code_ok(c2))

    def test_auth_and_never_reused(self):
        box, secret = self.db.create("crew", "11.91.0.2", None)
        self.assertIsNotNone(self.db.auth(box, secret))
        self.assertIsNone(self.db.auth(box, secret + "x"))
        self.db.set("crew", status="retired")
        with self.assertRaises(Exception):
            self.db.create("crew", "11.91.0.3", None)

    def test_txt_keeps_two_newest(self):
        self.db.add_txt("crew", "a" * 43)
        time.sleep(0.01)
        self.db.add_txt("crew", "b" * 43)
        time.sleep(0.01)
        vals = self.db.add_txt("crew", "c" * 43)
        self.assertEqual(vals, ["c" * 43, "b" * 43])


if __name__ == "__main__":
    unittest.main()

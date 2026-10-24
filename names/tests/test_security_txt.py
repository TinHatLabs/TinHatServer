"""names.tinhat.dev/.well-known/security.txt (RFC 9116): Contact lines in order of preference, security reports first
(security_contact, default security@tinhat.me), then abuse (abuse_contact); a configured one replaces the default,
the same address is listed once, and "" leaves the security line out."""
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names import config  # noqa: E402

try:
    import aiohttp  # noqa: F401
    from tinhat_names import app
    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False


def text(**over):
    cfg = config.load(None)
    cfg.update(over)
    return app.Service.security_txt_text(types.SimpleNamespace(cfg=cfg))


class Defaults(unittest.TestCase):
    def test_security_contact_by_default(self):
        cfg = config.load(None)
        self.assertEqual(cfg["security_contact"], "security@tinhat.me")
        self.assertEqual(cfg["abuse_contact"], "abuse@tinhat.me")


@unittest.skipUnless(HAVE_AIOHTTP, "needs aiohttp")
class SecurityTxt(unittest.TestCase):
    def contacts(self, body):
        return [l.split(": ", 1)[1] for l in body.splitlines() if l.startswith("Contact: ")]

    def test_security_first_then_abuse(self):
        body = text()
        self.assertEqual(self.contacts(body), ["mailto:security@tinhat.me", "mailto:abuse@tinhat.me"])
        self.assertTrue(body.startswith("Contact: mailto:security@tinhat.me\n"))
        self.assertRegex(body, r"(?m)^Expires: \d{4}-\d\d-\d\dT00:00:00Z$")
        self.assertIn("Preferred-Languages: en\n", body)

    def test_configured_contacts(self):
        self.assertEqual(self.contacts(text(security_contact="sec@example.org", abuse_contact="abuse@example.org")),
                         ["mailto:sec@example.org", "mailto:abuse@example.org"])
        self.assertEqual(self.contacts(text(security_contact="")), ["mailto:abuse@tinhat.me"])
        self.assertEqual(self.contacts(text(security_contact="abuse@tinhat.me")), ["mailto:abuse@tinhat.me"])


if __name__ == "__main__":
    unittest.main()

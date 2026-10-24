"""An aiohttp response is a mapping with no items, so it is FALSY: `if resp:` and `resp or …` silently pass a 401/403
through as if nothing was wrong (2026-10-21: the setup-code gate guarded nothing on nine wizard endpoints, and the
apps' invite-code API answered anyone). Every response a helper hands back is compared with None. This test reads
the manager's code and refuses the patterns."""
import pathlib
import re
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
# helpers that return a response or None
HELPERS = r"_setup_gate|_bearer_operator|_moving|_backup_task"
BAD = [
    re.compile(rf"if \(?\w+ := self\.(?:{HELPERS})\([^)]*\)\)?\s*(?:or|and|:)"),  # walrus tested for truth
    re.compile(r"\breturn (?:bad|busy|denied|resp) or\b"),
    re.compile(r"\b(?:bad|denied|resp) or await\b"),
    re.compile(rf"self\.(?:{HELPERS})\([^\n]*\)\s+or\b"),  # helper(...) or …
]


class ResponsesAreComparedWithNone(unittest.TestCase):
    def test_no_truth_tests_of_responses(self):
        hits = []
        for f in sorted(PKG.glob("*.py")):
            for i, line in enumerate(f.read_text().splitlines(), 1):
                if any(b.search(line) for b in BAD):
                    hits.append(f"{f.name}:{i}: {line.strip()}")
        self.assertEqual(hits, [], "a response tested for truth (it is always falsy):\n" + "\n".join(hits))

    def test_the_helpers_are_still_called(self):
        web = (PKG / "web.py").read_text()
        self.assertGreaterEqual(web.count("(bad := self._setup_gate(req)) is not None"), 11)


if __name__ == "__main__":
    unittest.main()

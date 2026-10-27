"""A "downloading" the update status still says when the manager starts can't be live (downloads run inside the
manager): clear_stale_download() puts the phase back (gates, 2026-10-26: an unreachable channel during "update before
setup" left "downloading" for good, so tick() skipped every daily check and night install and Install was refused).
Runs anywhere: updates.py's imports are stubbed (as in test_update_sources).
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_update_sources as src  # noqa: E402  (its stubbed loader)


class StaleDownload(unittest.TestCase):
    def setUp(self):
        self.u = src.load()
        self.st = {}
        self.u.status = lambda: dict(self.st)
        self.u.set_status = lambda **kw: self.st.update(kw) or dict(self.st)

    def test_downloading_with_an_update_available_goes_back_to_available(self):
        self.st.update(phase="downloading", available={"version": "0.3.5"})
        self.u.clear_stale_download()
        self.assertEqual(self.st["phase"], "available")
        self.assertIn("Install now", self.st["message"])

    def test_downloading_with_nothing_available_goes_back_to_current(self):
        self.st.update(phase="downloading", available=None)
        self.u.clear_stale_download()
        self.assertEqual(self.st["phase"], "current")

    def test_other_phases_are_left_alone(self):
        for ph in ("current", "available", "staged", "installing", "rolling-back", "done", "broken"):
            self.st.clear(); self.st.update(phase=ph)
            self.u.clear_stale_download()
            self.assertEqual(self.st["phase"], ph)


class SetupUpdatePutsThePhaseBack(unittest.TestCase):
    """web.py's "update before setup": every outcome of the check but "available" sets the phase again (source check:
    the handler needs the whole manager to run; the lab proves it end to end)."""
    def test_the_handler_sets_a_phase_on_every_non_available_outcome(self):
        w = (pathlib.Path(src.PKG) / "web.py").read_text()
        body = w[w.index("async def setup_update"):w.index("async def restore_start")]
        i = body.index('if st.get("phase") != "available":')
        self.assertIn("updates.set_status(phase=ph,", body[i:i + 600])
        self.assertIn('before in ("available", "current", "blocked", "done", "rolled-back")', body)
        self.assertIn("updates.clear_stale_download()", w[w.index("async def on_startup"):][:400])


if __name__ == "__main__":
    unittest.main()

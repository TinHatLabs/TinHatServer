"""The installer's image step (updater.fetch_images) for our own images: an image already here by id is only tagged;
a missing one comes from the release's verified tarballs, and on a store that names images its own way (Docker's
containerd store) only a tag one of THOSE tarballs brought counts — an older image that merely carries the tag never
does (0.3.2, Astra review). A failed `docker tag` stops the install. Docker is stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

UPDATER = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/updater.py"
spec = importlib.util.spec_from_file_location("tinhat_updater_under_test", UPDATER)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

OURS = "sha256:" + "a" * 64
LOCAL = "sha256:" + "b" * 64


class Docker:
    """ids: image refs/ids that `docker image inspect` finds; tags: ref → id; load_says: what `docker load` prints."""

    def __init__(self, ids=(), tags=None, load_says="", tag_fails=False):
        self.ids, self.tags, self.load_says, self.tag_fails, self.calls = set(ids), dict(tags or {}), load_says, tag_fails, []

    def sh(self, *cmd, timeout=600, stdin=None, stdout=None, cwd=None):
        self.calls.append(cmd)
        if cmd[:2] == ("docker", "load"):
            for line in self.load_says.splitlines():
                if line.startswith("Loaded image:"):
                    self.tags[line.split(":", 1)[1].strip()] = LOCAL
                    self.ids.add(LOCAL)
            return subprocess.CompletedProcess(cmd, 0, self.load_says.encode(), b"")
        if cmd[:2] == ("docker", "tag"):
            return subprocess.CompletedProcess(cmd, 1 if self.tag_fails else 0, b"", b"")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    def present(self, ref):
        return ref in self.ids or ref in self.tags

    def image_id(self, ref):
        return self.tags.get(ref)


class FetchImages(unittest.TestCase):
    def run_with(self, docker, tarball=True):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / "compose.yaml").write_text("services:\n  api:\n    image: tinhat/api:0.3.2\n")
        lock = d / "images.lock"
        lock.write_text(f"tinhat/api:0.3.2 {OURS} (the Tin Hat API, node 22)\n")
        if tarball:
            (d / "images").mkdir()
            (d / "images" / "tinhat-api-aaaaaaaaaaaa.tar.gz").write_bytes(b"x")
        updater.sh, updater.present, updater.image_id = docker.sh, docker.present, docker.image_id
        updater.say = lambda _m: None
        return updater.fetch_images(lock, d), lock.read_text()

    def test_already_here_is_only_tagged(self):
        dk = Docker(ids={OURS})
        ok, _ = self.run_with(dk, tarball=False)
        self.assertTrue(ok)
        self.assertEqual([c[:2] for c in dk.calls], [("docker", "tag")])

    def test_containerd_store_takes_the_tag_its_tarball_brought(self):
        ok, lock = self.run_with(Docker(load_says="Loaded image: tinhat/api:0.3.2\n"))
        self.assertTrue(ok)
        self.assertIn(LOCAL, lock)

    def test_an_old_image_with_the_tag_never_counts(self):
        # the tarball brought something else; tinhat/api:0.3.2 was already on the machine (stale)
        stale = Docker(tags={"tinhat/api:0.3.2": "sha256:" + "c" * 64}, load_says="Loaded image: tinhat/caddy:2.10.2-dns\n")
        ok, lock = self.run_with(stale)
        self.assertFalse(ok)
        self.assertIn(OURS, lock)

    def test_no_tarball_no_guess(self):
        ok, _ = self.run_with(Docker(tags={"tinhat/api:0.3.2": LOCAL}), tarball=False)
        self.assertFalse(ok)

    def test_failed_tag_stops(self):
        ok, _ = self.run_with(Docker(ids={OURS}, tag_fails=True), tarball=False)
        self.assertFalse(ok)

    def test_loaded_refs(self):
        self.assertEqual(updater.loaded_refs(b"Loaded image: tinhat/api:0.3.2\nLoaded image ID: sha256:abc\n"),
                         {"tinhat/api:0.3.2"})


if __name__ == "__main__":
    unittest.main()

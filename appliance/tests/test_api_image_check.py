"""build/api-image-check.py: build.sh reuses a release's API image only when it carries exactly this tree's API code
(review of 116d103, #4). Synthetic `docker save` archives, layers applied in order, whiteouts included.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("api_image_check", REPO / "build" / "api-image-check.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def tar_bytes(files: dict, gz=False) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz" if gz else "w") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class ApiImageCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.api = pathlib.Path(self.tmp.name) / "api"
        for rel, data in {"tinhat-api/server.mjs": b"server v2", "tinhat-api/access.mjs": b"access",
                          "tinhat-api/mi-fetch.py": b"py", "tinhat-api/package.json": b"{}",
                          "tinhat-api/package-lock.json": b"{}", "tinhat-api/test/x.test.mjs": b"not shipped",
                          "games/server.mjs": b"games", "games/limits.mjs": b"limits", "games/seed.json": b"[]",
                          "games/package.json": b"{}", "games/package-lock.json": b"{}"}.items():
            (self.api / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.api / rel).write_bytes(data)

    def image(self, layers: list[dict], oci=False) -> str:
        names = [f"blobs/sha256/{i:064x}" if oci else f"l{i}/layer.tar" for i in range(len(layers))]
        outer = {"manifest.json": json.dumps([{"Config": "c.json", "Layers": names}]).encode(), "c.json": b"{}"}
        for n, files in zip(names, layers):
            outer[n] = tar_bytes(files)
        path = pathlib.Path(self.tmp.name) / ("img-oci.tar.gz" if oci else "img.tar.gz")
        path.write_bytes(tar_bytes(outer, gz=True))
        return str(path)

    def shipped(self, **override):
        files = {f"opt/tinhat-api/{p.relative_to(self.api)}": p.read_bytes() for p in self.api.rglob("*")
                 if p.is_file() and "/test/" not in str(p)}
        files.update(override)
        return files

    def test_the_same_code_passes(self):
        base = {"usr/bin/node": b"node", "opt/tinhat-api/tinhat-api/node_modules/express/index.js": b"x"}
        self.assertEqual(check.main(["x", self.image([base, self.shipped()]), str(self.api)]), 0)
        self.assertEqual(check.main(["x", self.image([base, self.shipped()], oci=True), str(self.api)]), 0)

    def test_a_changed_new_or_removed_file_is_refused(self):
        old = self.shipped(**{"opt/tinhat-api/tinhat-api/server.mjs": b"server v1"})
        self.assertEqual(check.main(["x", self.image([old]), str(self.api)]), 1)
        missing = self.shipped()
        del missing["opt/tinhat-api/games/limits.mjs"]   # an older image without games/limits.mjs
        self.assertEqual(check.main(["x", self.image([missing]), str(self.api)]), 1)
        extra = self.shipped(**{"opt/tinhat-api/tinhat-api/gone.mjs": b"removed since"})
        self.assertEqual(check.main(["x", self.image([extra]), str(self.api)]), 1)

    def test_layers_apply_in_order_whiteouts_included(self):
        old = self.shipped(**{"opt/tinhat-api/tinhat-api/server.mjs": b"server v1", "opt/tinhat-api/tinhat-api/gone.mjs": b"x"})
        fix = {"opt/tinhat-api/tinhat-api/server.mjs": b"server v2", "opt/tinhat-api/tinhat-api/.wh.gone.mjs": b""}
        self.assertEqual(check.main(["x", self.image([old, fix]), str(self.api)]), 0)
        self.assertEqual(check.main(["x", self.image([fix, old]), str(self.api)]), 1, "the later layer wins")

    def test_unreadable(self):
        bad = pathlib.Path(self.tmp.name) / "bad.tar.gz"
        bad.write_bytes(b"not a tarball")
        self.assertEqual(check.main(["x", str(bad), str(self.api)]), 2)
        self.assertEqual(check.main(["x", self.image([{"a": b"b"}]), str(pathlib.Path(self.tmp.name) / "nothing")]), 2)


class BuildShUsesIt(unittest.TestCase):
    def test_stage_checks_the_web_and_the_reused_api(self):
        sh = (REPO / "build" / "build.sh").read_text()
        self.assertIn('python3 "$HERE/build/api-image-check.py" "$f" "$HERE/api"', sh)
        self.assertIn("< (12, 0, 3)", sh)
        self.assertIn("templates.web_app_csp(web)", sh)


if __name__ == "__main__":
    unittest.main()

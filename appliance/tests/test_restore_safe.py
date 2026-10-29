"""Restoring from an untrusted backup (security review, server manager lows; sec-night-2 2026-10-27): malicious
tarballs are refused before anything is extracted, links and special files never survive into the restored tree, the
restored secrets must look like Tin Hat's own before they reach a config or SQL, and the database password reaches
psql as a quoted variable only.

Runs anywhere (restoresafe.py imports nothing of the manager):
    python3 -m unittest discover -s appliance/tests
"""
import gzip
import importlib.util
import io
import os
import pathlib
import re
import shutil
import tarfile
import tempfile
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"
_spec = importlib.util.spec_from_file_location("restoresafe", PKG / "restoresafe.py")
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

BIG = 100 * 1024**3  # free space in the tests


def _tar(path, members, mode="w"):
    """members: (TarInfo, bytes|None)"""
    with tarfile.open(path, mode) as t:
        for info, data in members:
            t.addfile(info, io.BytesIO(data) if data is not None else None)


def _file(name, data=b"x"):
    i = tarfile.TarInfo(name)
    i.size = len(data)
    return i, data


def _special(name, kind, target=""):
    i = tarfile.TarInfo(name)
    i.type = kind
    i.linkname = target
    return i, None


def good_secrets():
    return {"postgres_password": "A" * 32, "registration_shared_secret": "b" * 43, "macaroon_secret_key": "c-_" * 15,
            "form_secret": "d" * 43, "livekit_key": "tinhat0a1b2c3d", "livekit_secret": "e" * 43, "system_password": "f" * 43,
            "system_token": None, "names": {"key": "abc"}, "backup_password": "correct horse battery staple"}


class TarChecks(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_a_plain_repository_tar_extracts(self):
        p2 = self.d / "ok.tar"
        d = tarfile.TarInfo("srv")
        d.type = tarfile.DIRTYPE
        _tar(p2, [(d, None), _file("srv/config", b"cfg"), _file("srv/data/00/abc", b"pack")])
        rs.extract_tar(p2, self.d / "out", BIG)
        self.assertEqual((self.d / "out/srv/config").read_bytes(), b"cfg")

    def test_links_and_special_files_are_refused(self):
        for kind, target in ((tarfile.SYMTYPE, "/etc/passwd"), (tarfile.SYMTYPE, "inside"), (tarfile.LNKTYPE, "srv/config"),
                             (tarfile.CHRTYPE, ""), (tarfile.FIFOTYPE, "")):
            p = self.d / f"bad{kind}.tar"
            _tar(p, [_file("srv/config"), _special("srv/evil", kind, target)])
            with self.assertRaises(rs.UnsafeBackup, msg=kind):
                rs.extract_tar(p, self.d / "out", BIG)
            self.assertFalse((self.d / "out").exists(), "nothing is extracted before the check")

    def test_names_outside_the_folder_are_refused(self):
        for name in ("/etc/cron.d/x", "../../x", "srv/../../x", "srv\\x", "srv/x\nnewline"):
            p = self.d / "bad.tar"
            _tar(p, [_file(name)])
            with self.assertRaises(rs.UnsafeBackup, msg=repr(name)):
                rs.check_tar(p, BIG)

    def test_bigger_than_the_free_space_is_refused(self):
        p = self.d / "big.tar"
        _tar(p, [_file("srv/a", b"x" * 4096)])
        with self.assertRaises(rs.UnsafeBackup):
            rs.check_tar(p, rs.RESERVE_BYTES + 1000)
        rs.check_tar(p, rs.RESERVE_BYTES + 10_000)  # fits
        self.assertEqual(rs.upload_limit(rs.RESERVE_BYTES - 5), 0)

    def test_a_compressed_bomb_is_refused_before_extracting(self):
        p = self.d / "bomb.tar.gz"
        _tar(p, [_file("srv/zeros", b"\0" * (8 * 1024 * 1024))], mode="w:gz")
        self.assertLess(p.stat().st_size, 8 * 1024 * 1024 // rs.MAX_RATIO)
        with self.assertRaises(rs.UnsafeBackup):
            rs.extract_tar(p, self.d / "out", BIG)
        self.assertFalse((self.d / "out").exists())
        # an uncompressed tar of the same content is fine (Tin Hat's own download is uncompressed)
        p2 = self.d / "plain.tar"
        _tar(p2, [_file("srv/zeros", b"\0" * (1024 * 1024))])
        rs.check_tar(p2, BIG)


class StripSpecials(unittest.TestCase):
    def test_links_fifos_and_shared_hard_links_never_survive(self):
        d = pathlib.Path(tempfile.mkdtemp())
        outside = pathlib.Path(tempfile.mkdtemp())
        try:
            root = d / "files"
            (root / "state/synapse").mkdir(parents=True)
            (root / "state/synapse/signing.key").write_text("key")
            os.symlink("/etc/passwd", root / "state/secrets.json")
            os.symlink(outside, root / "state/caddy")  # a directory link: never walked into
            os.mkfifo(root / "state/pipe")
            secret = outside / "host-file"
            secret.write_text("host")
            os.link(secret, root / "state/shared")  # a hard link to a file outside the tree
            removed = rs.strip_specials(root)
            self.assertEqual(sorted(removed), ["state/caddy", "state/pipe", "state/secrets.json"])
            self.assertTrue((root / "state/synapse/signing.key").is_file())
            self.assertFalse(any(p.is_symlink() for p in root.rglob("*")))
            (root / "state/shared").write_text("changed")
            self.assertEqual(secret.read_text(), "host", "writing the restored copy must not write the outside file")
            self.assertEqual(os.stat(secret).st_nlink, 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)

    def test_a_directory_that_cant_be_listed_stops_the_restore(self):
        from unittest import mock
        d = pathlib.Path(tempfile.mkdtemp())
        try:
            (d / "files/state").mkdir(parents=True)
            real_scandir = os.scandir

            def scandir(p="."):
                if str(p).endswith("state"):
                    raise PermissionError(13, "Permission denied", str(p))
                return real_scandir(p)
            with mock.patch("os.scandir", scandir):
                with self.assertRaises(rs.UnsafeBackup):
                    rs.strip_specials(d / "files")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_planted_split_name_is_never_written_through(self):
        # assembly-038 review: a hard-linked file plus a symlink at the name the old split used ("<name>.tinhat-split")
        # pointing outside — whatever order the walk meets them in, the outside file is never written
        from unittest import mock
        real_walk = os.walk
        for order in ("as listed", "reversed"):
            with self.subTest(order=order):
                d = pathlib.Path(tempfile.mkdtemp())
                outside = pathlib.Path(tempfile.mkdtemp())
                try:
                    root = d / "files"
                    (root / "state").mkdir(parents=True)
                    target = outside / "cron-payload"
                    target.write_text("host")
                    other = outside / "other-link"
                    (root / "state/a").write_text("backup data")
                    os.link(root / "state/a", other)  # "a" has two links
                    os.symlink(target, root / "state/a.tinhat-split")

                    def walk(top, **kw):
                        for dp, dn, fn in real_walk(top, **kw):
                            if order == "reversed":
                                fn[:] = fn[::-1]
                                dn[:] = dn[::-1]
                            yield dp, dn, fn
                    with mock.patch.object(rs.os, "walk", walk):
                        removed = rs.strip_specials(root)
                    self.assertEqual(removed, ["state/a.tinhat-split"])
                    self.assertEqual(target.read_text(), "host", "the planted link's target is untouched")
                    self.assertEqual((root / "state/a").read_text(), "backup data")
                    self.assertEqual(os.stat(root / "state/a").st_nlink, 1)
                    self.assertEqual(sorted(p.name for p in (root / "state").iterdir()), ["a"], "no temp file left")
                finally:
                    shutil.rmtree(d, ignore_errors=True)
                    shutil.rmtree(outside, ignore_errors=True)


class Secrets(unittest.TestCase):
    def test_tin_hats_own_shapes_pass(self):
        self.assertEqual(rs.check_secrets(good_secrets()), good_secrets())

    def test_values_that_would_inject_into_configs_or_sql_are_refused(self):
        bad = {
            "postgres_password": "x'; COPY t TO PROGRAM 'id'; --",
            "macaroon_secret_key": 'abcdefghijklmnopqrstuvwxyz"\nmodules: [{module: evil}]',
            "registration_shared_secret": "short",
            "livekit_secret": "a" * 30 + "\n",
            "livekit_key": "tin hat",
            "form_secret": 12345678901234567890,
        }
        for k, v in bad.items():
            s = good_secrets()
            s[k] = v
            with self.assertRaises(rs.UnsafeBackup, msg=k):
                rs.check_secrets(s)
        for k in rs.CONFIG_SECRETS:  # an older backup without one passes this check (the loader's own handling)
            s = good_secrets()
            del s[k]
            rs.check_secrets(s)
        s = good_secrets()
        s["names"] = {"key": "ok\nINJECTED=1"}  # any other string: no control characters (env files)
        with self.assertRaises(rs.UnsafeBackup):
            rs.check_secrets(s)
        with self.assertRaises(rs.UnsafeBackup):
            rs.check_secrets(["not", "an", "object"])

    def test_the_password_never_enters_the_sql_text(self):
        sql = rs.alter_role_sql()
        self.assertEqual(sql, "ALTER ROLE synapse WITH PASSWORD :'pw';\n")


class Wiring(unittest.TestCase):
    """The callers use it (source checks: install.py / web.py need aiohttp to import)."""

    def test_install_and_web_use_restoresafe(self):
        install = (PKG / "install.py").read_text()
        web = (PKG / "web.py").read_text()
        self.assertNotRegex(install, r"PASSWORD '\{")
        self.assertIn("restoresafe.strip_specials, files)", install)
        self.assertIn("restoresafe.check_secrets(", install)
        self.assertIn('stdin=restoresafe.alter_role_sql().encode()', install)
        self.assertIn("shutil.copytree(src, dst, symlinks=True)", install)
        self.assertIn("restoresafe.extract_tar", web)
        self.assertIn("restoresafe.upload_limit", web)
        self.assertNotIn("def _untar", web)
        self.assertIsNone(re.search(r"extractall\(dest, filter=\"data\"\)\n\n\nasync def _background", web))


if __name__ == "__main__":
    unittest.main()

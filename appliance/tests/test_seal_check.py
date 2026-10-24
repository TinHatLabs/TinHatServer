"""build.sh export's checks of a sealed disk. build/check-sealed.sh (also run by windows/build-rootfs.sh) on the root
filesystem: a sealed root passes; each thing the build can leave behind is refused (0.3.0's image kept root's
authorized_keys with the build key, the build's journal and a random seed every image shared); links in the image are
never followed. build/check-free.py on a filesystem image: zero free blocks pass, one that holds data doesn't.
    python3 -m unittest discover -s appliance/tests
"""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

BUILD = pathlib.Path(__file__).resolve().parents[2] / "build"
SCRIPT = BUILD / "check-sealed.sh"


def write(root, rel, text=""):
    f = root / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)


def sealed_root(d):
    r = pathlib.Path(d)
    write(r, "opt/tinhat/VERSION", "0.3.1\n")
    write(r, "etc/ssh/sshd_config")
    write(r, "etc/machine-id")
    write(r, "etc/hostname", "tinhat\n")
    for f in ("passwd", "group", "shadow", "gshadow"):
        write(r, f"etc/{f}", "root:x:0:0:root:/root:/bin/bash\n")
    for d in ("root", "home", "var/log/journal", "var/lib/tinhat", "var/lib/systemd", "var/lib/dbus",
              "var/lib/docker/containers", "var/lib/docker/volumes"):
        (r / d).mkdir(parents=True, exist_ok=True)
    write(r, "var/lib/docker/volumes/metadata.db", "bolt")
    os.symlink("/etc/machine-id", r / "var/lib/dbus/machine-id")
    return r


# What a build leaves when seal.sh misses it: name, how to make it in a sealed root.
LEFTOVERS = [
    ("root's authorized_keys", lambda r: write(r, "root/.ssh/authorized_keys", "ssh-ed25519 AAAA build\n")),
    ("a user's authorized_keys", lambda r: write(r, "home/someone/.ssh/authorized_keys", "ssh-ed25519 AAAA x\n")),
    ("a user's .ssh behind a link", lambda r: (write(r, "srv/keys/authorized_keys", "ssh-ed25519 AAAA x\n"),
                                               (r / "home/someone").mkdir(parents=True),
                                               os.symlink("../../srv/keys", r / "home/someone/.ssh"))),
    ("an SSH host key", lambda r: write(r, "etc/ssh/ssh_host_ed25519_key", "key\n")),
    ("the random seed", lambda r: write(r, "var/lib/systemd/random-seed", "seed")),
    ("systemd's credential key", lambda r: write(r, "var/lib/systemd/credential.secret", "secret")),
    ("a machine id", lambda r: write(r, "etc/machine-id", "0123456789abcdef0123456789abcdef\n")),
    ("the build's journal", lambda r: write(r, "var/log/journal/0123/system.journal", "LPKSHHRH")),
    ("setup state", lambda r: write(r, "var/lib/tinhat/compose.env", "POSTGRES_PASSWORD=x\n")),
    ("hidden setup state", lambda r: write(r, "var/lib/tinhat/.done", "")),
    ("the build account's home", lambda r: (r / "home/tinhatbuild").mkdir()),
    ("the build account", lambda r: write(r, "etc/passwd", "root:x:0:0::/root:/bin/bash\ntinhatbuild:x:1000:1000::/home/tinhatbuild:/bin/bash\n")),
    ("a passwd backup", lambda r: write(r, "etc/passwd-", "root:x:0:0::/root:/bin/bash\n")),
    ("cloud-init's sudoers entry", lambda r: write(r, "etc/sudoers.d/90-cloud-init-users", "tinhatbuild ALL=(ALL) NOPASSWD:ALL\n")),
    ("cloud-init's config", lambda r: (r / "etc/cloud").mkdir()),
    ("cloud-init's state", lambda r: (r / "var/lib/cloud").mkdir()),
    ("the payload", lambda r: (r / "root/payload").mkdir()),
    ("seal.sh's log", lambda r: write(r, "root/seal.log", "sealed\n")),
    ("the build's hostname", lambda r: write(r, "etc/hostname", "tinhat-build\n")),
    ("a D-Bus machine id of its own", lambda r: ((r / "var/lib/dbus/machine-id").unlink(),
                                                 write(r, "var/lib/dbus/machine-id", "0123456789abcdef\n"))),
    ("a container", lambda r: write(r, "var/lib/docker/containers/abc/config.v2.json", '{"Env":["X=1"]}')),
    ("a volume", lambda r: (r / "var/lib/docker/volumes/tinhat_db/_data").mkdir(parents=True)),
    ("a folder named like Docker's volume database", lambda r: ((r / "var/lib/docker/volumes/metadata.db").unlink(),
                                                               write(r, "var/lib/docker/volumes/metadata.db/x", "data"))),
    ("a hidden file in /var/tmp", lambda r: write(r, "var/tmp/.credentials", "password\n")),
    ("a file in /tmp", lambda r: write(r, "tmp/build.log", "log\n")),
    ("a parent that isn't a folder", lambda r: (shutil.rmtree(r / "var/log"), write(r, "var/log", "not a folder"))),
    ("no passwd", lambda r: (r / "etc/passwd").unlink()),
    # links: where a checked folder or file (or a parent of one) should be
    ("setup state behind a link", lambda r: (shutil.rmtree(r / "var/lib/tinhat"), (r / "srv/setup").mkdir(parents=True),
                                             write(r, "srv/setup/compose.env", "X=1\n"),
                                             os.symlink("../../srv/setup", r / "var/lib/tinhat"))),
    ("passwd behind a link", lambda r: (os.rename(r / "etc/passwd", r / "etc/passwd.real"),
                                        os.symlink("passwd.real", r / "etc/passwd"))),
    ("a linked parent", lambda r: (os.rename(r / "var", r / "var.real"), os.symlink("var.real", r / "var"))),
]


class SealCheck(unittest.TestCase):
    def check(self, root):
        return subprocess.run(["bash", str(SCRIPT), str(root)], capture_output=True, text=True)

    def test_sealed_root_passes(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.check(sealed_root(d))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stderr, "")

    def test_every_leftover_is_refused(self):
        for name, make in LEFTOVERS:
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                root = sealed_root(d)
                make(root)
                r = self.check(root)
                self.assertEqual(r.returncode, 1, f"{name}: {r.stderr}")
                self.assertIn("check-sealed:", r.stderr)

    def test_links_are_not_followed(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside:
            root = sealed_root(d)
            # an absolute link points into the host: an empty file there must not pass for the image's machine id
            pathlib.Path(outside, "empty").write_text("")
            (root / "etc/machine-id").unlink()
            os.symlink(os.path.join(outside, "empty"), root / "etc/machine-id")
            r = self.check(root)
            self.assertEqual(r.returncode, 1)
            self.assertIn("/etc/machine-id isn't a plain file", r.stderr)
        with tempfile.TemporaryDirectory() as d:
            root = sealed_root(d)
            os.symlink("/nonexistent/.ssh", root / "root/.ssh")  # a dangling link is still a leftover
            r = self.check(root)
            self.assertEqual(r.returncode, 1)
            self.assertIn("/root/.ssh", r.stderr)

    def test_not_a_root_filesystem(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.check(d)
            self.assertEqual(r.returncode, 2)


@unittest.skipUnless(shutil.which("mkfs.ext4") and shutil.which("dumpe2fs") and shutil.which("debugfs"), "needs e2fsprogs")
class FreeBlocks(unittest.TestCase):
    """check-free.py PARTITION on an ext4 image file (no root needed: mkfs.ext4 fills it from a folder)."""

    def make(self, d, block_size):
        src = pathlib.Path(d, "src")
        write(src, "etc/hosts", "127.0.1.1\ttinhat\n")
        img = pathlib.Path(d, f"fs-{block_size}.img")
        subprocess.run(["mkfs.ext4", "-q", "-F", "-b", str(block_size), "-d", str(src), str(img), "16M"],
                       check=True, capture_output=True, env=dict(os.environ, E2FSPROGS_FAKE_TIME="1"))
        return img

    def check(self, img):
        return subprocess.run(["python3", str(BUILD / "check-free.py"), str(img)], capture_output=True, text=True)

    def free_block(self, img):
        out = subprocess.run(["dumpe2fs", str(img)], capture_output=True, text=True, check=True,
                             env=dict(os.environ, LC_ALL="C")).stdout
        bs = int(next(l.split()[-1] for l in out.splitlines() if l.startswith("Block size:")))
        last = [l for l in out.splitlines() if l.startswith("  Free blocks: ") and l[15:16].isdigit()][-1]
        return bs, int(last[15:].split(",")[-1].split("-")[-1])  # the last free block of the last group

    def test_zero_free_blocks_pass_and_data_in_one_fails(self):
        for block_size in (4096, 1024):  # 1 KiB blocks: the first data block is 1, not 0
            with self.subTest(block_size=block_size), tempfile.TemporaryDirectory() as d:
                img = self.make(d, block_size)
                r = self.check(img)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn("all zero", r.stdout)
                bs, blk = self.free_block(img)
                with open(img, "r+b") as f:
                    f.seek(blk * bs)
                    f.write(b"127.0.1.1\ttinhat-build\n")
                r = self.check(img)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn(f"1 still hold data (blocks {blk})", r.stdout)

    def test_a_used_journal_fails(self):
        with tempfile.TemporaryDirectory() as d:
            img = self.make(d, 4096)
            out = subprocess.run(["debugfs", "-R", "blocks <8>", str(img)], capture_output=True, text=True,
                                 check=True).stdout.split()
            self.assertGreater(len(out), 2)
            r = self.check(img)
            self.assertIn("journal of %d blocks, new" % len(out), r.stdout)
            with open(img, "r+b") as f:  # an old transaction left in the journal's ring
                f.seek(int(out[5]) * 4096)
                f.write(b"\xc0\x3b\x39\x98 old transaction")
            r = self.check(img)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn(f"past its superblock hold data (blocks {out[5]})", r.stdout)

    def test_not_ext4(self):
        with tempfile.TemporaryDirectory() as d:
            f = pathlib.Path(d, "zeros")
            f.write_bytes(bytes(1 << 20))
            self.assertEqual(self.check(f).returncode, 2)


if __name__ == "__main__":
    unittest.main()

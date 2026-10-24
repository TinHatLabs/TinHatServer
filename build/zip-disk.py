#!/usr/bin/env python3
"""zip-disk.py DISK ZIP SHA256 MAX — DISK zipped into ZIP for a GitHub release, which refuses files of 2 GiB and more
(the .vhdx is ~4.1 GiB, the .vmdk ~2.8 GiB; both shrink to about a quarter). One entry under DISK's own name, Deflate
(what Windows' Explorer, macOS and every unzip open), Zip64 when the disk is over 4 GiB. Then ZIP is read back whole:
exactly that one entry, every byte through the CRC check, and the content's sha256 must be SHA256 (DISK's, from
build.sh). Refuses a ZIP of MAX bytes or more. Exit 0 = ZIP is right; else ZIP is deleted."""
import hashlib
import os
import sys
import zipfile


def main(disk: str, out: str, want: str, most: int) -> int:
    name = os.path.basename(disk)
    try:
        info = zipfile.ZipInfo.from_file(disk, arcname=name)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16  # a plain file, rw-r--r--
        with zipfile.ZipFile(out, "x", allowZip64=True) as z, open(disk, "rb") as src, z.open(info, "w") as dst:
            while chunk := src.read(8 << 20):
                dst.write(chunk)
        size = os.path.getsize(out)
        if size >= most:
            raise SystemExit(f"{out}: {size} bytes, over the {most} a release file may have")
        h = hashlib.sha256()
        with zipfile.ZipFile(out) as z:
            entries = z.infolist()
            if [e.filename for e in entries] != [name]:
                raise SystemExit(f"{out}: holds {[e.filename for e in entries]}, not just {name}")
            with z.open(entries[0]) as f:  # reading to the end checks the CRC (BadZipFile otherwise)
                while chunk := f.read(8 << 20):
                    h.update(chunk)
        if h.hexdigest() != want:
            raise SystemExit(f"{out}: its {name} doesn't read back as the disk (sha256 {h.hexdigest()}, not {want})")
        print(f"{os.path.basename(out)}: {size} bytes ({size / os.path.getsize(disk):.0%} of {name}), read back: sha256 {want}")
        return 0
    except BaseException:
        try:
            os.unlink(out)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])))

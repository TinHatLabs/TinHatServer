#!/usr/bin/env python3
"""check-free.py PARTITION [ROOT] — does space that no file can read still hold data on the ext4 filesystem on
PARTITION? Read-only.

    build/check-free.py /dev/loop0p1 /mnt/root

Free blocks: every one must read as zeros. The journal: every block but its first (the journal's superblock) too, so
only a journal made new and never used passes. With ROOT (PARTITION's filesystem mounted read-only there) also the
unwritten extents of its files (allocated, never written: a file reads zeros there, the disk may hold anything).
Exit 0: all zero. 1: some aren't (how many, the first few). 2: can't tell (not an ext4 filesystem this reads,
dumpe2fs failed, its listing doesn't add up, a short read, an extent it can't place): never a pass.

build.sh export runs it on the sealed disk. build.sh seal zeroes the free blocks with zerofree; this is a second,
independent reading of the same disk: the block bitmap as dumpe2fs lists it (each group's free-block ranges, checked
against that group's own free-block count), then every one of those blocks.

For build.sh seal (they write nothing else):
    check-free.py --list-unwritten ROOT   "OFFSET LENGTH" (bytes on the partition) per unwritten extent
    check-free.py --zero PARTITION        writes zeros over each "OFFSET LENGTH" read on stdin (the filesystem
                                          unmounted: those blocks read as zeros to their files anyway)
"""
import fcntl
import os
import re
import stat
import struct
import subprocess
import sys

CHUNK = 8 << 20  # bytes read at a time
SHOW = 10        # places listed when some hold data
FS_IOC_FIEMAP = 0xC020660B
FIEMAP_HDR = struct.Struct("=QQIIII")      # fm_start fm_length fm_flags fm_mapped_extents fm_extent_count fm_reserved
FIEMAP_EXT = struct.Struct("=QQQQQIIII")   # fe_logical fe_physical fe_length 2×reserved fe_flags 3×reserved
EXT_LAST, EXT_UNKNOWN, EXT_DELALLOC, EXT_ENCODED = 0x1, 0x2, 0x4, 0x8
EXT_NOT_ALIGNED, EXT_DATA_INLINE, EXT_UNWRITTEN = 0x100, 0x200, 0x800
PER_CALL = 512


def fail(msg):
    print(f"check-free: {msg}", file=sys.stderr)
    sys.exit(2)


def run(cmd):
    out = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, LC_ALL="C"))
    if out.returncode != 0:
        fail(f"{' '.join(cmd)} failed: {out.stderr.strip()[-200:]}")
    return out.stdout


def free_ranges(part):
    """(block size, [(byte offset, length)] of the free blocks, [(byte offset, length)] of the journal past its first
    block)."""
    text = run(["dumpe2fs", part])
    head = {k: re.search(rf"^{k}:\s+(.*)$", text, re.M) for k in ("Block size", "Block count", "First block",
                                                                   "Filesystem features")}
    if not all(head.values()):
        fail(f"no ext4 superblock in dumpe2fs's listing of {part}")
    if "bigalloc" in head["Filesystem features"].group(1).split():
        fail("bigalloc filesystems (free space in clusters) aren't supported")
    bs, total, first = (int(head[k].group(1)) for k in ("Block size", "Block count", "First block"))
    groups = re.split(r"^Group \d+: ", text, flags=re.M)[1:]
    if not groups:
        fail("dumpe2fs listed no block groups")
    ranges, covered = [], first
    for i, g in enumerate(groups):
        span = re.match(r"\(Blocks (\d+)-(\d+)\)", g)
        count = re.search(r"^  (\d+) free blocks, ", g, re.M)
        listed = re.search(r"^  Free blocks: ?(.*)$", g, re.M)
        if not span or not count or not listed:
            fail(f"can't read group {i} in dumpe2fs's listing")
        lo, hi = int(span.group(1)), int(span.group(2))
        if lo != covered:
            fail(f"group {i} starts at block {lo}, expected {covered}")
        covered = hi + 1
        n = 0
        for item in filter(None, (s.strip() for s in listed.group(1).split(","))):
            a, _, b = item.partition("-")
            a, b = int(a), int(b or a)
            if not lo <= a <= b <= hi:
                fail(f"group {i}: free range {item} lies outside the group's blocks {lo}-{hi}")
            ranges.append((a * bs, (b - a + 1) * bs))
            n += b - a + 1
        if n != int(count.group(1)):
            fail(f"group {i}: dumpe2fs lists {n} free blocks, the group says {count.group(1)}")
    if covered != total:
        fail(f"the groups cover blocks {first}-{covered - 1}, the filesystem has {total}")
    return bs, ranges, journal_ranges(part, text, bs, total)


def journal_ranges(part, text, bs, total):
    if "has_journal" not in re.search(r"^Filesystem features:\s+(.*)$", text, re.M).group(1).split():
        return []
    if re.search(r"^Journal device:", text, re.M):
        fail("an external journal isn't something this checks")
    ino = re.search(r"^Journal inode:\s+(\d+)$", text, re.M)
    count = re.search(r"^Total journal blocks:\s+(\d+)$", text, re.M)
    if not ino or not count:
        fail("can't find the journal in dumpe2fs's listing")
    # The journal's data blocks from its block map, by logical block: "(0-16383):3678208-3694591, (16384):…".
    # Mapping metadata ((ETB0):…, (IND):…) isn't journal data and is left out.
    st = run(["debugfs", "-R", f"stat <{ino.group(1)}>", part])
    m = re.search(r"^(?:EXTENTS|BLOCKS):\n(.*?)(?:\n\S|\Z)", st, re.M | re.S)
    if not m:
        fail("debugfs shows no block map for the journal")
    n, out = int(count.group(1)), []
    want = 0
    for item in (x.strip() for x in m.group(1).replace("\n", " ").split(",")):
        if not item or re.match(r"^\((?:ETB\d+|IND|DIND|TIND)\):", item):
            continue
        e = re.fullmatch(r"\((\d+)(?:-(\d+))?\):(\d+)(?:-(\d+))?(?: \[uninit\])?", item)
        if not e:
            fail(f"can't read the journal's block map entry {item!r}")
        l0, l1 = int(e.group(1)), int(e.group(2) or e.group(1))
        p0, p1 = int(e.group(3)), int(e.group(4) or e.group(3))
        if l0 != want or l1 - l0 != p1 - p0 or not 0 < p0 <= p1 < total:
            fail(f"the journal's block map doesn't add up at {item!r}")
        want = l1 + 1
        if l0 == 0:  # logical block 0: the journal's own superblock
            p0 += 1
        if p0 <= p1:
            out.append((p0 * bs, (p1 - p0 + 1) * bs))
    if want != n:
        fail(f"the journal's block map covers {want} blocks, the superblock says {n}")
    return out


def unwritten_ranges(root):
    """(byte offset on the partition, length, file) of every unwritten extent of every regular file under root."""
    out, root_dev = [], os.lstat(root).st_dev
    for d, dirs, files in os.walk(root, onerror=lambda e: fail(f"can't read {e.filename}: {e.strerror}")):
        dirs[:] = [x for x in dirs if os.lstat(os.path.join(d, x)).st_dev == root_dev]  # this filesystem only
        for name in files:
            p = os.path.join(d, name)
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or st.st_dev != root_dev:  # empty ones too: unwritten blocks past the end
                continue
            try:
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except OSError as e:
                fail(f"can't open {p}: {e.strerror}")
            try:
                start = 0
                while True:
                    buf = bytearray(FIEMAP_HDR.pack(start, 2**64 - 1 - start, 0, 0, PER_CALL, 0)
                                    + bytes(FIEMAP_EXT.size * PER_CALL))
                    try:
                        fcntl.ioctl(fd, FS_IOC_FIEMAP, buf)
                    except OSError as e:
                        fail(f"can't map {p}: {e.strerror}")
                    n, done = FIEMAP_HDR.unpack_from(buf)[3], False
                    for i in range(n):
                        lg, ph, ln, _, _, fl, _, _, _ = FIEMAP_EXT.unpack_from(buf, FIEMAP_HDR.size + i * FIEMAP_EXT.size)
                        if fl & (EXT_UNKNOWN | EXT_DELALLOC | EXT_ENCODED | EXT_NOT_ALIGNED | EXT_DATA_INLINE):
                            if fl & EXT_UNWRITTEN:
                                fail(f"{p}: an unwritten extent that can't be placed on the disk (flags {fl:#x})")
                        elif fl & EXT_UNWRITTEN:
                            out.append((ph, ln, p[len(root):] or "/"))
                        done = done or bool(fl & EXT_LAST)
                        start = lg + ln
                    if n == 0 or done:
                        break
            finally:
                os.close(fd)
    return out


def nonzero_blocks(dev, offset, length, bs, zero):
    """Offsets of the blocks in [offset, offset+length) that don't read as zeros."""
    found, pos, end = [], offset, offset + length
    while pos < end:
        n = min(end - pos, CHUNK)
        dev.seek(pos)
        buf = dev.read(n)
        if len(buf) != n:
            fail(f"short read at byte {pos}")
        if buf != zero[:n]:
            found += [pos + j for j in range(0, n, bs) if buf[j:j + bs].count(0) != len(buf[j:j + bs])]
        pos += n
    return found


def zero_ranges(part):
    zero = bytes(CHUNK)
    with open(part, "r+b", buffering=0) as dev:
        size = dev.seek(0, os.SEEK_END)
        for line in sys.stdin:
            f = line.split()
            if not f:
                continue
            if len(f) != 2 or not f[0].isdigit() or not f[1].isdigit():
                fail(f"--zero: can't read {line.strip()!r}")
            pos, end = int(f[0]), int(f[0]) + int(f[1])
            if end > size:
                fail(f"--zero: bytes {pos}-{end} lie past the end of {part}")
            while pos < end:
                n = min(end - pos, CHUNK)
                dev.seek(pos)
                if dev.write(zero[:n]) != n:
                    fail(f"short write at byte {pos}")
                pos += n
        os.fsync(dev.fileno())


def main():
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "--list-unwritten":
        for ph, ln, _ in unwritten_ranges(a[1]):  # no file names: this feeds --zero
            print(ph, ln)
        return
    if len(a) == 2 and a[0] == "--zero":
        zero_ranges(a[1])
        return
    if len(a) not in (1, 2) or a[0].startswith("-"):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        sys.exit(2)
    part, root = a[0], (a[1] if len(a) == 2 else None)
    bs, ranges, journal = free_ranges(part)
    zero = bytes(CHUNK)
    bad = False
    with open(part, "rb", buffering=0) as dev:
        held, free = [], 0
        for off, ln in ranges:
            held += nonzero_blocks(dev, off, ln, bs, zero)
            free += ln // bs
        if held:
            bad = True
            print(f"{free} free blocks, {len(held)} still hold data (blocks "
                  f"{', '.join(str(o // bs) for o in held[:SHOW])}{', …' if len(held) > SHOW else ''})")
        else:
            print(f"{free} free blocks, all zero")
        if journal:
            held = [o for off, ln in journal for o in nonzero_blocks(dev, off, ln, bs, zero)]
            n = sum(ln for _, ln in journal) // bs + 1
            if held:
                bad = True
                print(f"journal of {n} blocks: {len(held)} past its superblock hold data (blocks "
                      f"{', '.join(str(o // bs) for o in held[:SHOW])}{', …' if len(held) > SHOW else ''}): not a new one")
            else:
                print(f"journal of {n} blocks, new (zero past its superblock)")
        if root is not None:
            unw = unwritten_ranges(root)
            held = [(o, f) for ph, ln, f in unw for o in nonzero_blocks(dev, ph, ln, bs, zero)]
            if held:
                bad = True
                print(f"{len(unw)} unwritten extents, {len(held)} of their blocks hold data ("
                      f"{', '.join(f'block {o // bs} of {f}' for o, f in held[:SHOW])}{', …' if len(held) > SHOW else ''})")
            else:
                print(f"{len(unw)} unwritten extents, all zero")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

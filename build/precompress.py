#!/usr/bin/env python3
"""Pre-compressed side files for the web app a Tin Hat Server serves (build.sh stage + artifacts, release.sh).

    precompress.py make DIR [--zstd]
        write FILE.br (brotli, quality 11) next to every compressible FILE of at least MIN_SIZE bytes (not in
        SKIP_DIRS), keeping FILE; with --zstd also FILE.zst (zstd, level 19). A side file that comes out no smaller
        than FILE is not kept. Side files from an earlier run are removed first.
    precompress.py verify DIR
        every side file decodes to exactly its FILE's bytes, sits next to an allowed FILE, is the kind its name says,
        and neither is a link; exit 1 with the list of problems otherwise
    precompress.py record DIR OUT
        verify, then write OUT: the sha256 of every side file and of its FILE (build.sh artifacts)
    precompress.py check DIR RECORD
        DIR's side files and their FILEs are exactly the ones RECORD lists, byte for byte (release.sh, on a machine
        that may not have the two commands: what was decoded at artifacts time is what gets signed)
    precompress.py strip DIR
        remove every side file this tool makes (an update bundle's web: servers make their own, websides.py)
    precompress.py report DIR
        bytes per file: raw, .br, .zst (JSON lines)

Caddy serves FILE.br / FILE.zst to a browser that accepts br / zstd, with Content-Encoding and FILE's own type
(templates.WEB_FILES); everyone else gets FILE, compressed on the fly as before. The side files are made here, once
per build, at levels too slow to run per request. make and verify need the `brotli` and `zstd` commands.

Update bundles carry none (release.sh strips them: ~3 MB that don't shrink in the bundle, which has to stay under
the mirror's 24 MiB); a server makes its own after an update (the manager's websides.py, Node's brotli from the
box's own API image, each copy decoded back before it is used). The server's images carry these.

Why brotli only by default: every browser that takes zstd also takes brotli (and brotli 11 is the smaller of the two),
so a .zst would never be chosen while it adds ~3 MB to every update bundle, which has to stay under the mirror's 24 MiB
(release.sh). Caddy still serves a FILE.zst to a browser that takes zstd but not brotli, should a build carry one.

Each side file's time is FILE's plus 1 s (.br) or 2 s (.zst): Caddy's ETag is the file's time and size, so FILE and
its copies never share one (a cache that revalidates one encoding with another's ETag gets a full answer, not a 304).
Whole seconds, because the update bundle's tar keeps only those.
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

#: the kinds Caddy serves from a side file (templates.WEB_FILES's path matcher names the same, test_web_precompress)
EXTENSIONS = (".js", ".mjs", ".css", ".html", ".wasm", ".svg", ".json")
#: below this, compression saves less than a packet and costs a decode
MIN_SIZE = 1024
#: top-level folders left as they are: the icon pack's ~750 small SVGs (2 MB as brotli) load one by one, only when an
#: icon theme or the icon gallery asks for them, and on-the-fly compression already serves them well
SKIP_DIRS = ("iconpack",)
#: suffix -> (encode, decode, magic bytes or b"", name, seconds added to FILE's time)
SIDES = {".br": (["brotli", "-q", "11", "-c"], ["brotli", "-d", "-c"], b"", "brotli", 1),
         ".zst": (["zstd", "-19", "-q", "-c", "--no-progress"], ["zstd", "-d", "-q", "-c"], b"\x28\xb5\x2f\xfd", "zstd", 2)}
JOBS = min(4, os.cpu_count() or 1)


def _tools():
    missing = [t for t in ("brotli", "zstd") if shutil.which(t) is None]
    if missing:
        sys.exit(f"precompress.py needs {' and '.join(missing)} (apt install brotli zstd)")


def wanted(p: pathlib.Path, root: pathlib.Path) -> bool:
    if p.relative_to(root).parts[0] in SKIP_DIRS:
        return False
    return not p.is_symlink() and p.is_file() and p.suffix in EXTENSIONS and p.stat().st_size >= MIN_SIZE


def originals(root: pathlib.Path):
    return sorted(p for p in root.rglob("*") if wanted(p, root))


def side_files(root: pathlib.Path):
    """Every FILE.br / FILE.zst under root (links too: verify refuses them)."""
    return sorted(p for p in root.rglob("*") if p.suffix in SIDES and (p.is_symlink() or p.is_file()))


def _run(cmd, path) -> bytes:
    with open(path, "rb") as fh:
        r = subprocess.run(cmd, stdin=fh, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed on {path}: {r.stderr.decode(errors='replace').strip()[:200]}")
    return r.stdout


def _make_one(p: pathlib.Path, suffixes) -> list:
    out = []
    st = p.stat()
    for suffix in suffixes:
        enc, _dec, _magic, _name, later = SIDES[suffix]
        side = p.with_name(p.name + suffix)
        data = _run(enc, p)
        if len(data) >= st.st_size:
            continue
        # a new file of our own (never through a link or a name someone else left), then renamed over the side file
        fd, tmp = tempfile.mkstemp(prefix=f".{p.name}.", suffix=".part", dir=p.parent)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.chmod(tmp, st.st_mode & 0o777)
            t = st.st_mtime_ns // 1_000_000_000 + later
            os.utime(tmp, (t, t))
            os.replace(tmp, side)
        except BaseException:
            pathlib.Path(tmp).unlink(missing_ok=True)
            raise
        out.append((side, len(data)))
    return out


def ours(side: pathlib.Path, root: pathlib.Path) -> bool:
    """A side file this tool could have made: of an EXTENSIONS file, outside SKIP_DIRS (anything else ending in .br
    or .zst, such as a download, isn't touched)."""
    orig = side.with_name(side.name[: -len(side.suffix)])
    return side.relative_to(root).parts[0] not in SKIP_DIRS and orig.suffix in EXTENSIONS


def make(root: pathlib.Path, zstd: bool = False) -> int:
    _tools()
    for s in side_files(root):  # an earlier run's (a file that shrank, a run with --zstd): only this run's stay
        if ours(s, root):
            s.unlink()
    files = originals(root)
    raw = sum(p.stat().st_size for p in files)
    suffixes = (".br", ".zst") if zstd else (".br",)
    made = []
    with concurrent.futures.ThreadPoolExecutor(JOBS) as ex:
        for r in ex.map(lambda p: _make_one(p, suffixes), files):
            made += r
    br = sum(n for s, n in made if s.suffix == ".br")
    zst = sum(n for s, n in made if s.suffix == ".zst")
    print(f"precompressed {len(files)} files ({raw / 1e6:.2f} MB): {br / 1e6:.2f} MB brotli"
          + (f", {zst / 1e6:.2f} MB zstd" if zstd else "") + " side files")
    return 0


def problems(root: pathlib.Path) -> list:
    out = []
    # rglob doesn't go into a linked folder, Caddy does: none at all in the web tree
    for d, dirs, _files in os.walk(root):
        out += [f"{(pathlib.Path(d) / x).relative_to(root)}: a linked folder" for x in dirs if (pathlib.Path(d) / x).is_symlink()]
    for side in side_files(root):
        rel = side.relative_to(root)
        orig = side.with_name(side.name[: -len(side.suffix)])
        if side.is_symlink() or orig.is_symlink():
            out.append(f"{rel}: a link (side files and their files are plain files)")
            continue
        if orig.suffix in SIDES:
            out.append(f"{rel}: a side file of a side file")
            continue
        if not orig.is_file():
            out.append(f"{rel}: no {orig.name} next to it")
            continue
        if orig.suffix not in EXTENSIONS:
            out.append(f"{rel}: {orig.suffix or 'that kind of file'} isn't served from a side file")
            continue
        _enc, dec, magic, name, _later = SIDES[side.suffix]
        if magic and side.read_bytes()[: len(magic)] != magic:
            out.append(f"{rel}: not {name} data")
            continue
        try:
            data = _run(dec, side)
        except RuntimeError:
            out.append(f"{rel}: doesn't decode as {name}")
            continue
        if data != orig.read_bytes():
            out.append(f"{rel}: decodes to something other than {orig.name}")
    return out


def verify(root: pathlib.Path) -> int:
    _tools()
    bad = problems(root)
    if bad:
        print(f"web side files: {len(bad)} problem(s) in {root}", file=sys.stderr)
        for b in bad:
            print(f"  {b}", file=sys.stderr)
        return 1
    print(f"web side files: {len(side_files(root))} checked, each decodes to its file")
    return 0


def _sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _listing(root: pathlib.Path) -> dict:
    out = {}
    for side in side_files(root):
        orig = side.with_name(side.name[: -len(side.suffix)])
        for p in (side, orig):
            rel = str(p.relative_to(root))
            out[rel] = "link" if p.is_symlink() else _sha(p) if p.is_file() else "missing"
    return out


def record(root: pathlib.Path, dest: pathlib.Path) -> int:
    if verify(root):
        return 1
    dest.write_text("".join(f"{h}  {rel}\n" for rel, h in sorted(_listing(root).items())))
    return 0


def check(root: pathlib.Path, rec: pathlib.Path) -> int:
    try:
        want = {}
        for line in rec.read_text().splitlines():
            h, rel = line.split("  ", 1)
            want[rel] = h
    except (OSError, ValueError) as e:
        print(f"{rec}: unreadable ({e})", file=sys.stderr)
        return 1
    have = _listing(root)
    # every recorded file still there and the same; no side file the record doesn't name
    bad = [f"{rel}: {'not there' if rel not in have else 'changed'}" for rel, h in sorted(want.items()) if have.get(rel) != h]
    bad += [f"{rel}: not in the record" for rel in sorted(set(have) - set(want))]
    if bad:
        print(f"web side files: {len(bad)} difference(s) from {rec.name}", file=sys.stderr)
        for b in bad:
            print(f"  {b}", file=sys.stderr)
        return 1
    print(f"web side files: {sum(1 for r in want if pathlib.Path(r).suffix in SIDES)} exactly as recorded (decoded when recorded)")
    return 0


def strip(root: pathlib.Path) -> int:
    n = 0
    for s in side_files(root):
        if ours(s, root):
            s.unlink()
            n += 1
    left = [str(s.relative_to(root)) for s in side_files(root) if ours(s, root)]
    if left:
        print(f"still there: {left[:5]}", file=sys.stderr)
        return 1
    print(f"web side files: {n} removed")
    return 0


def report(root: pathlib.Path) -> int:
    for p in originals(root):
        row = {"file": str(p.relative_to(root)), "raw": p.stat().st_size}
        for suffix in SIDES:
            s = p.with_name(p.name + suffix)
            row[suffix[1:]] = s.stat().st_size if s.is_file() else None
        print(json.dumps(row))
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    zst = "--zstd" in a
    a = [x for x in a if x != "--zstd"]
    n = {"make": 2, "verify": 2, "report": 2, "strip": 2, "record": 3, "check": 3}
    if not a or a[0] not in n or len(a) != n[a[0]] or (zst and a[0] != "make"):
        sys.exit(__doc__)
    d = pathlib.Path(a[1])
    if not d.is_dir():
        sys.exit(f"{d}: not a folder")
    if a[0] == "make":
        sys.exit(make(d, zst))
    if a[0] in ("record", "check"):
        sys.exit((record if a[0] == "record" else check)(d, pathlib.Path(a[2])))
    sys.exit({"verify": verify, "report": report, "strip": strip}[a[0]](d))

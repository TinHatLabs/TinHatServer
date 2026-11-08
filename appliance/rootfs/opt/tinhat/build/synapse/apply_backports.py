"""Apply a pinned series of upstream Synapse fixes to a Synapse 1.145.0 tree, or refuse and change nothing.

Usage: apply_backports.py ROOT PATCHDIR
  ROOT      the directory the patches' paths are relative to (the image's `synapse` package for the source series,
            a scratch copy of a v1.145.0 checkout for the test series)
  PATCHDIR  holds SERIES (`<sha256> <patch file>` per line, applied in that order) and FILES (`<sha256 before|->
            <sha256 after> <path>` for every file the series touches; `-` = a file the series adds)

Each patch file must hash to its SERIES line. Every file must be a regular file (no symlink) hashing to its "before"
value; a file the series adds must not exist in any form, and its directory must. Every hunk must match the file
exactly at the line it names, its new-side line must agree, and hunks must come in order inside the file (no fuzz, no
offsets). Every result must hash to its "after" value. All of that is checked in memory before anything is written:
any mismatch exits non-zero with the files untouched. (An I/O error while writing can still leave the tree half
written; in the Dockerfile that fails the build, so no image has it.) A tree that already has the fixes (every file at its "after" hash: an upgraded Synapse, or a second
run) is refused as well, so the series is never stacked on code it wasn't written for.
"""
import hashlib
import os
import re
import sys
from pathlib import Path

HUNK = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def fail(msg: str) -> "NoReturn":  # noqa: F821
    raise SystemExit(f"apply_backports: {msg}: refusing (nothing changed)")


def parse_patch(text: str) -> list[tuple[str, str, list]]:
    """-> [(old_path or "", new_path, hunks)]; hunks = [(old_start, old_lines, new_lines)]."""
    files, lines, i = [], text.splitlines(keepends=True), 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("\\"):
            fail("a patch line without a final newline is not supported")
        if not ln.startswith("--- "):
            i += 1
            continue
        old = ln[4:].rstrip("\n")
        new = lines[i + 1][4:].rstrip("\n") if lines[i + 1].startswith("+++ ") else fail("--- without +++")
        old = "" if old == "/dev/null" else old.removeprefix("a/")
        if new == "/dev/null" or not new.startswith("b/"):
            fail(f"unsupported target {new!r}")
        new = new.removeprefix("b/")
        if old and old != new:
            fail(f"a rename ({old} -> {new})")
        i += 2
        hunks = []
        while i < len(lines) and lines[i].startswith("@@"):
            m = HUNK.match(lines[i]) or fail(f"bad hunk header {lines[i]!r}")
            o_start, o_len = int(m[1]), int(m[2] if m[2] is not None else 1)
            n_start, n_len = int(m[3]), int(m[4] if m[4] is not None else 1)
            i += 1
            o, n = [], []
            while len(o) < o_len or len(n) < n_len:
                ln = lines[i] if i < len(lines) else fail("a hunk ends early")
                tag, body = ln[:1], ln[1:]
                if tag == " ":
                    o.append(body); n.append(body)
                elif tag == "-":
                    o.append(body)
                elif tag == "+":
                    n.append(body)
                else:
                    fail(f"unexpected hunk line {ln!r}")
                i += 1
            if len(o) != o_len or len(n) != n_len:
                fail("a hunk's line counts don't match its header")
            hunks.append((o_start, n_start, o, n))
        files.append((old, new, hunks))
    return files


def apply_hunks(path: str, content: list[str], hunks: list) -> list[str]:
    out, delta, done = list(content), 0, 0  # done: lines of the original already behind us
    for o_start, n_start, o, n in hunks:
        first = o_start - 1 if o else o_start  # 0-based index of the first old line (or the insertion point)
        if first < done or first + len(o) > len(content):
            fail(f"{path}: a hunk at line {o_start} is out of order or outside the file")
        if n_start != (o_start if o else o_start + 1) + delta - (0 if n else 1):
            fail(f"{path}: a hunk at line {o_start} names the wrong new line {n_start}")
        at = first + delta
        if out[at:at + len(o)] != o:
            fail(f"{path}: a hunk at line {o_start} doesn't match")
        out[at:at + len(o)] = n
        delta += len(n) - len(o)
        done = first + len(o)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        raise SystemExit(__doc__)
    root, pdir = Path(argv[1]), Path(argv[2])
    series = [ln.split() for ln in (pdir / "SERIES").read_text().splitlines() if ln.strip() and not ln.startswith("#")]
    pins = {}
    for ln in (pdir / "FILES").read_text().splitlines():
        if ln.strip() and not ln.startswith("#"):
            before, after, path = ln.split()
            pins[path] = (before, after)
    if not series or not pins:
        fail("an empty SERIES or FILES")
    state: dict[str, bytes | None] = {}
    for path, (before, _) in pins.items():
        f = root / path
        if ".." in Path(path).parts or Path(path).is_absolute():
            fail(f"{path}: outside the tree")
        regular = f.is_file() and not f.is_symlink()
        if before == "-" and os.path.lexists(f) and not regular:
            fail(f"{path} exists already (not as a file)")
        if before == "-" and not f.parent.is_dir():
            fail(f"{path}: its directory is missing")
        if before != "-" and os.path.lexists(f) and not regular:
            fail(f"{path} isn't a regular file")
        state[path] = f.read_bytes() if regular else None
    if all(state[p] is not None and sha(state[p]) == a for p, (_, a) in pins.items()):
        fail("this tree has the fixes already (remove the series)")
    for path, (before, _) in pins.items():
        if before == "-":
            if state[path] is not None:
                fail(f"{path} exists already (a newer Synapse, or the series ran before)")
        elif state[path] is None:
            fail(f"{path} is missing")
        elif sha(state[path]) != before:
            fail(f"{path} isn't the Synapse 1.145.0 file this series was written for")
    for want, name in series:
        raw = (pdir / name).read_bytes()
        if sha(raw) != want:
            fail(f"{name} doesn't hash to its SERIES line")
        for old, new, hunks in parse_patch(raw.decode("utf-8")):
            if new not in pins:
                fail(f"{name} touches {new}, which FILES doesn't pin")
            if not old and state[new] is not None:
                fail(f"{name} adds {new}, which is already there")
            cur = [] if state[new] is None else state[new].decode("utf-8").splitlines(keepends=True)
            state[new] = "".join(apply_hunks(new, cur, hunks)).encode("utf-8")
    for path, (_, after) in pins.items():
        if state[path] is None or sha(state[path]) != after:
            fail(f"{path}: the result isn't the pinned patched file")
    for path, data in state.items():
        (root / path).write_bytes(data)
    for path, (_, after) in pins.items():
        if sha((root / path).read_bytes()) != after:
            raise SystemExit(f"apply_backports: {path} doesn't read back as written")
    print(f"apply_backports: {len(series)} patches, {len(pins)} files: " + ", ".join(n for _, n in series))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

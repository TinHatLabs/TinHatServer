#!/usr/bin/env python3
"""wheels.py — the Python wheels a release ships (build/wheels.lock: aiohttp and what it needs, and pip), at build time.

  wheels.py fetch DEST [--cache DIR]   DEST gets exactly the files the lock names + the lock itself (wheels.lock), each
                                       downloaded from PyPI's file host (or taken from the cache) and refused unless
                                       its sha256 is the lock's. DEST is emptied first. Default cache: out/wheels-cache.
  wheels.py verify DIR                 DIR holds exactly that: the lock (identical to build/wheels.lock) and its files,
                                       each with its sha256, nothing else (release.sh checks the bundle's with it).
  wheels.py audit [--allow FILE]       every pinned version against the OSV advisory database (what pip-audit reads);
                                       exit 1 when any has an advisory that build/wheels-advisories.allow doesn't name
                                       (with its one-line reason), or when OSV can't be asked. release.sh runs it first.

The lock is read with the same code the servers use (tinhat/pyenv.py). Servers never download anything: they install
these files offline (`pip install --no-index --require-hashes`).
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
LOCK = HERE / "build" / "wheels.lock"
HOST = "https://files.pythonhosted.org/"
ALLOW = HERE / "build" / "wheels-advisories.allow"
OSV = "https://api.osv.dev/v1/querybatch"
MAX = 16 << 20  # no wheel in the lock is near this


def pyenv():
    spec = importlib.util.spec_from_file_location(
        "tinhat_pyenv_build", HERE / "appliance/rootfs/opt/tinhat/manager/tinhat/pyenv.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def die(msg: str) -> None:
    print(f"wheels.py: {msg}", file=sys.stderr)
    sys.exit(1)


def entries() -> list[dict]:
    pe = pyenv()
    try:
        es = pe.read_lock(LOCK)
    except pe.Problem as e:
        die(str(e))
    for e in es:
        if not e["url"].startswith(HOST):
            die(f"{e['file']}: {e['url']} isn't on {HOST}")
    return es


def download(url: str, dest: Path, sha: str) -> None:
    """url → dest, only when its sha256 is sha (written next to dest first, renamed when it checks out)."""
    tmp = dest.with_name(dest.name + ".part")
    h, n = hashlib.sha256(), 0
    req = urllib.request.Request(url, headers={"User-Agent": "tinhat-build-wheels"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        if r.status != 200:
            die(f"{url}: HTTP {r.status}")
        while chunk := r.read(1 << 16):
            n += len(chunk)
            if n > MAX:
                tmp.unlink(missing_ok=True)
                die(f"{url}: bigger than {MAX} bytes")
            h.update(chunk)
            f.write(chunk)
    if h.hexdigest() != sha:
        tmp.unlink(missing_ok=True)
        die(f"{url}: sha256 {h.hexdigest()}, the lock says {sha}: refused")
    os.replace(tmp, dest)


def fetch(dest: Path, cache: Path) -> None:
    pe, es = pyenv(), entries()
    cache.mkdir(parents=True, exist_ok=True)
    for e in es:
        c = cache / e["file"]
        if c.is_file() and not c.is_symlink() and pe.sha256_file(c) == e["sha256"]:
            continue
        c.unlink(missing_ok=True)
        download(e["url"], c, e["sha256"])
        print(f"downloaded {e['file']}")
    if dest.is_symlink():
        die(f"{dest} is a link")
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    for e in es:
        shutil.copyfile(cache / e["file"], dest / e["file"])
    shutil.copyfile(LOCK, dest / pe.LOCK_FILE)
    verify(dest)
    print(f"wheels: {len(es)} files in {dest}, each matches build/wheels.lock")


def verify(d: Path) -> None:
    pe, es = pyenv(), entries()
    lock = d / pe.LOCK_FILE
    if lock.is_symlink() or not lock.is_file() or lock.read_bytes() != LOCK.read_bytes():
        die(f"{d}: its {pe.LOCK_FILE} isn't build/wheels.lock")
    want = {e["file"] for e in es} | {pe.LOCK_FILE}
    have = {p.name for p in d.iterdir()}
    if have != want:
        die(f"{d}: " + "; ".join(x for x in (
            "missing " + ", ".join(sorted(want - have)) if want - have else "",
            "not in the lock: " + ", ".join(sorted(have - want)) if have - want else "") if x))
    try:
        pe.verify(d, es)
    except pe.Problem as e:
        die(f"{d}: {e}")


def read_allow(path: Path) -> dict:
    """The reviewed exceptions: `ADVISORY-ID  why it doesn't apply to us (one line)` per line, # comments. An entry
    without a reason is refused: never a silent exception."""
    out = {}
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return out
    for n, line in enumerate(lines, 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        aid, _, why = line.partition(" ")
        if not why.strip():
            die(f"{path.name} line {n}: {aid} has no reason (ID, then one line saying why it doesn't apply)")
        out[aid] = why.strip()
    return out


def audit(allow_file: Path = ALLOW) -> int:
    """Known advisories (OSV, the database pip-audit reads) against each pinned package version. 0 only when every one
    found is in the allowlist with its reason; 1 for any other, or when OSV can't be asked (no answer = not checked)."""
    allow = read_allow(allow_file)
    pkgs = sorted({(e["name"], e["version"]) for e in entries()})
    body = json.dumps({"queries": [{"package": {"name": n, "ecosystem": "PyPI"}, "version": v} for n, v in pkgs]})
    req = urllib.request.Request(OSV, data=body.encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "tinhat-build-wheels"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            results = json.load(r)["results"]
        if len(results) != len(pkgs):
            raise ValueError(f"{len(results)} answers for {len(pkgs)} packages")
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"wheels.py audit: couldn't ask OSV ({e}): not checked, so refused; try again", file=sys.stderr)
        return 1
    bad, used = 0, set()
    for (n, v), res in zip(pkgs, results):
        ids = [x["id"] for x in (res or {}).get("vulns") or []]
        if not ids:
            print(f"{n} {v}: no known advisories")
            continue
        for aid in ids:
            if aid in allow:
                used.add(aid)
                print(f"{n} {v}: {aid} allowed ({allow[aid]})")
            else:
                bad += 1
                print(f"{n} {v}: {aid} NOT allowed")
    for aid in sorted(set(allow) - used):
        print(f"wheels.py audit: {allow_file.name} names {aid}, which no pinned package has any more: remove it",
              file=sys.stderr)
    if bad:
        print(f"wheels.py audit: {bad} advisory(ies) against the pinned wheels: move the lock on, or (reviewed) name "
              f"them in {allow_file.name} with the reason (docs/RELEASING.md)", file=sys.stderr)
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["fetch"] and len(argv) in (2, 4) and (len(argv) == 2 or argv[2] == "--cache"):
        fetch(Path(argv[1]), Path(argv[3]) if len(argv) == 4 else HERE / "out" / "wheels-cache")
    elif argv == ["audit"]:
        return audit()
    elif argv[:2] == ["audit", "--allow"] and len(argv) == 3:
        return audit(Path(argv[2]))
    elif argv[:1] == ["verify"] and len(argv) == 2:
        verify(Path(argv[1]))
        print(f"{argv[1]}: matches build/wheels.lock")
    else:
        print(__doc__.strip().split("\n\n")[0], file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

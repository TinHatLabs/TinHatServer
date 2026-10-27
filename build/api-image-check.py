#!/usr/bin/env python3
"""api-image-check.py IMAGE.tar.gz API_DIR: does the saved tinhat/api image carry exactly the API code in API_DIR?

build.sh runs it before it reuses a release's API image (REUSE_IMAGES_FROM): reusing an image whose code differs from
this tree would ship the old API under the new version (review of 116d103, #4: nothing checked it, and the private
repository has no release tags to diff against). It compares what api/Dockerfile copies into the image, file by file:
    api/tinhat-api/{*.mjs, mi-fetch.py, package.json, package-lock.json} -> opt/tinhat-api/tinhat-api/
    api/games/{*.mjs, seed.json, package.json, package-lock.json}       -> opt/tinhat-api/games/
(node_modules and the image's other files aside). Reads `docker save` archives (manifest.json + layer tars, also the
OCI layout's blobs) in one pass, applies the layers in order (whiteouts included). Exit 0 = the same; 1 = differs
(each difference printed); 2 = the archive can't be read.
"""
import fnmatch
import hashlib
import json
import posixpath
import sys
import tarfile
from pathlib import Path

ROOT = "opt/tinhat-api/"
SOURCES = {
    "tinhat-api": ["*.mjs", "mi-fetch.py", "package.json", "package-lock.json"],
    "games": ["*.mjs", "seed.json", "package.json", "package-lock.json"],
}


def wanted(api_dir: Path) -> dict:
    """image path -> sha256 of what this tree would put there."""
    out = {}
    for sub, patterns in SOURCES.items():
        d = api_dir / sub
        for f in sorted(d.iterdir()) if d.is_dir() else []:
            if f.is_file() and any(fnmatch.fnmatch(f.name, p) for p in patterns):
                out[f"{ROOT}{sub}/{f.name}"] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def _norm(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    name = name.lstrip("/")
    return posixpath.normpath(name) if name not in ("", ".") else ""


def _relevant(path: str) -> bool:
    return any(path.startswith(f"{ROOT}{sub}/") and "/node_modules" not in path[len(ROOT):] for sub in SOURCES)


def _layer(fileobj) -> dict:
    """path -> sha256 | None (a whiteout) for the relevant files of one layer."""
    got = {}
    with tarfile.open(fileobj=fileobj, mode="r|*") as t:
        for m in t:
            p = _norm(m.name)
            base = posixpath.basename(p)
            if base.startswith(".wh."):
                target = posixpath.join(posixpath.dirname(p), base[4:])
                if _relevant(target) or _relevant(target + "/x"):
                    got[target] = None
                continue
            if not m.isfile() or not _relevant(p) or posixpath.dirname(p) not in (ROOT + s for s in SOURCES):
                continue
            got[p] = hashlib.sha256(t.extractfile(m).read()).hexdigest()
    return got


def image_files(archive: str) -> dict:
    layers, manifest = {}, None
    with tarfile.open(archive, mode="r|*") as outer:
        for m in outer:
            name = _norm(m.name)
            if name == "manifest.json":
                manifest = json.load(outer.extractfile(m))
            elif m.isfile() and (name.endswith("/layer.tar") or name.startswith("blobs/")):
                try:
                    layers[name] = _layer(outer.extractfile(m))
                except tarfile.TarError:
                    layers[name] = {}  # a config or index blob, not a layer
    if not manifest:
        raise ValueError("no manifest.json: not a docker save archive")
    files = {}
    for layer in manifest[0]["Layers"]:
        for p, h in layers.get(_norm(layer), {}).items():
            if h is None:
                for k in [k for k in files if k == p or k.startswith(p + "/")]:
                    del files[k]
            else:
                files[p] = h
    return files


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.splitlines()[0], file=sys.stderr)
        return 2
    try:
        have = image_files(argv[1])
    except (OSError, ValueError, KeyError, IndexError, tarfile.TarError, json.JSONDecodeError) as e:
        print(f"api-image-check: can't read {argv[1]}: {e}", file=sys.stderr)
        return 2
    want = wanted(Path(argv[2]))
    if not want:
        print(f"api-image-check: no API sources under {argv[2]}", file=sys.stderr)
        return 2
    diffs = [f"changed: {p}" for p in sorted(want) if p in have and have[p] != want[p]]
    diffs += [f"new in this tree: {p}" for p in sorted(want) if p not in have]
    diffs += [f"only in the image: {p}" for p in sorted(have) if p not in want]
    for d in diffs:
        print(d)
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

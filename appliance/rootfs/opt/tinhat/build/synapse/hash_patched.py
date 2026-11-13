"""Run inside a built Synapse image (python -B - < this file): prints the sha256 of every patched Synapse file
(devicemessage.py + backports/FILES) and of its compiled copies, and of the pinned Pillow / msgpack install (RECORD
plus every .py/.pyc/.so under the package), and says whether each default .pyc is checked-hash and matches its source.
Two builds of the same inputs must print the same lines (the 0.3.15 build recipe's "built twice" step). Exit 1 = a
missing file or default .pyc, a timestamp .pyc, or a .pyc of other source. Never imports synapse, PIL or msgpack."""
import hashlib
import importlib.metadata
import importlib.util
import sys
from pathlib import Path

FILES = ["handlers/devicemessage.py", "api/errors.py", "config/_base.pyi", "config/_util.py", "config/homeserver.py",
         "config/push_rules.py", "events/validator.py", "federation/federation_server.py", "handlers/federation.py", "handlers/worker_lock.py",
         "http/site.py", "replication/http/_base.py", "rest/client/push_rule.py", "storage/databases/main/event_federation.py",
         "storage/databases/main/push_rule.py"]
root = Path(importlib.util.find_spec("synapse").submodule_search_locations[0])
ok = True
for rel in FILES:
    src = root / rel
    if not src.is_file():
        print("MISSING", rel)
        ok = False
        continue
    data = src.read_bytes()
    print("source", hashlib.sha256(data).hexdigest(), rel)
    if not rel.endswith(".py"):
        continue
    stem = src.name[:-3]
    if not (src.parent / "__pycache__" / f"{stem}.{sys.implementation.cache_tag}.pyc").is_file():
        print("MISSING default pyc", rel)
        ok = False
    for pyc in sorted((src.parent / "__pycache__").glob(f"{stem}.*.pyc")):
        b = pyc.read_bytes()
        print("pyc", hashlib.sha256(b).hexdigest(), rel, pyc.name)
        if pyc.name == f"{stem}.{sys.implementation.cache_tag}.pyc":
            checked = int.from_bytes(b[4:8], "little") == 0b11
            matches = b[8:16] == importlib.util.source_hash(data)
            print("default pyc:", rel, "checked-hash" if checked else "NOT checked-hash",
                  "matches source" if matches else "DOES NOT match source")
            ok = ok and checked and matches
for name, pkg in (("pillow", "PIL"), ("msgpack", "msgpack")):
    dist = importlib.metadata.distribution(name)
    record = dist.read_text("RECORD") or ""
    print("dist", name, dist.version, "RECORD", hashlib.sha256(record.encode()).hexdigest())
    base = Path(importlib.util.find_spec(pkg).submodule_search_locations[0])
    h = hashlib.sha256()
    n = 0
    for f in sorted(p for p in base.rglob("*") if p.is_file()):
        h.update(str(f.relative_to(base)).encode() + b"\0" + hashlib.sha256(f.read_bytes()).digest())
        n += 1
        if f.suffix == ".pyc" and int.from_bytes(f.read_bytes()[4:8], "little") != 0b11:  # any cache, default or not
            print("NOT checked-hash", f.relative_to(base.parent))
            ok = False
        if f.suffix == ".py":  # every module: a checked-hash default .pyc of exactly this source
            pyc = Path(importlib.util.cache_from_source(str(f)))
            b = pyc.read_bytes() if pyc.is_file() else b""
            if len(b) < 16 or int.from_bytes(b[4:8], "little") != 0b11 or b[8:16] != importlib.util.source_hash(f.read_bytes()):
                print("NOT a checked-hash pyc of its source", f.relative_to(base.parent))
                ok = False
    print("tree", pkg, n, "files", h.hexdigest())
sys.exit(0 if ok else 1)

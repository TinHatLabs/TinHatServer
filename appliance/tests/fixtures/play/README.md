# Real games-database dumps (G1: playdb's layer-1 tests and its reference)

Made 2026-11-19 by `pg_dump` 17.11 (the box's `postgres:17-alpine`) in a THROWAWAY container on a lab box, from the
real migrations (`api/tinhat-api/play/db.mjs`, schema 2) run by the games API image, with three wallets created by
the real ledger (`L.createWallet`). No real person's data: `@g1-a/b/c:ref.example`.

- `play-v2.dump`: the real thing. `appliance/rootfs/opt/tinhat/manager/tinhat/play_pg_reference.json` is made from it
  (every non-data entry byte for byte, the COPY lines, the sequences).
- `planted-*.dump`: the same database after one change each, dumped again: an extra function (`g1_evil`), the
  append-only trigger `play_entries_ro` dropped, a view, an extra table, an extra column, a default that calls
  `pg_read_file`. Each must be refused by `playdb.check`.

**Regenerate both (the fixtures AND the reference) when the games schema (a new migration) or the postgres image
changes:** `mkdumps.sh` here, on a lab box as root (its paths are the lab box's; the passwords are a throwaway
container's): a throwaway `postgres:17-alpine` + the games API image running `migrate()` and three `createWallet`s,
`pg_dump -U synapse -Fc tinhat_play`, then the planted changes one by one. Then the reference, from the manager folder:

```python
import json, sys; sys.path.insert(0, ".")
from pathlib import Path
from tinhat import dbcheck, playdb
es = dbcheck.read_toc(Path("../../../../tests/fixtures/play/play-v2.dump"))
ref = json.loads(Path("tinhat/play_pg_reference.json").read_text()) | {"entries": {}, "copies": {}, "sequences": []}
for e in es:
    if e.desc in playdb.SKIP or e.desc == "SEQUENCE SET": continue
    if e.desc == "TABLE DATA": ref["copies"][e.tag] = e.copy; continue
    ref["entries"][f"{e.desc}|{e.tag}"] = e.defn
    if e.desc == "SEQUENCE": ref["sequences"].append(e.tag)
Path("tinhat/play_pg_reference.json").write_text(json.dumps(ref, indent=1, sort_keys=True) + "\n")
```
and set `schema` there to the new migration's number.

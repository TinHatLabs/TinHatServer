"""The games database in backups (GAMES G1; launch-gate 12:22 + 13:50): `play.dump` beside `db.dump`, and a VETTED
restore, dbcheck's three layers made for `tinhat_play`:

  1. THE LIST (read here, in Python, before anything runs): every schema entry of the archive is EXACTLY the games
     schema's own, byte for byte (play_pg_reference.json, made from the real migrations by pg_dump 17: its tables,
     constraints, indexes, the four trigger functions and the six triggers that keep the journal append-only and
     zero-sum), none missing and nothing else; every data entry the exact `COPY public.<table> (<its columns>) FROM
     stdin;`; a sequence's setval only that. Anything else refuses the backup.
  2. A THROWAWAY DATABASE: a postgres container of this server's own image with no network, the dump read-only, restored
     as a role that is NOT a superuser and owns only that database (dbcheck's container, bounded the same way).
  3. CHECKS, THEN OUR OWN DUMP: the games schema version; the ledger's invariants (every balance = its entries, every
     transaction zero-sum and in one space, no negative wallet/seat/pot/escrow, every space sums to zero); the counts,
     equal to what the backup recorded when it was made. Then our own pg_dump of that database, checked again with the
     same list rules: only that dump reaches the live database, restored AS `tinhat_play` (never a superuser).

A refused or failed games restore never fails a server restore: the games then start with an empty database and the
restore says so (state play_restore).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import dbcheck
from .restoresafe import UnsafeBackup

log = logging.getLogger("tinhat.playdb")
REFERENCE = Path(__file__).with_name("play_pg_reference.json")
DATABASE = "tinhat_play"
ROLE = "tinhat_play"
#: the kinds the games database's dump has; SKIP = allowed but not restored (the database's own entry, privileges)
RUN = {"TABLE", "TABLE DATA", "SEQUENCE", "SEQUENCE OWNED BY", "SEQUENCE SET", "DEFAULT", "INDEX", "CONSTRAINT",
       "FK CONSTRAINT", "FUNCTION", "TRIGGER", "ENCODING", "STDSTRINGS", "SEARCHPATH"}
SKIP = {"DATABASE", "DATABASE PROPERTIES", "ACL"}
_SETVAL = re.compile(r"SELECT pg_catalog\.setval\('public\.([a-z_][a-z0-9_]*)', [0-9]{1,19}, (?:true|false)\);\n")
#: the ledger's invariants (tinhat play audit's): each answer is a count of violations, all must be 0
AUDIT_SQL = """\
SELECT (SELECT count(*) FROM play_accounts a
          WHERE a.balance <> coalesce((SELECT sum(e.delta) FROM play_entries e WHERE e.account = a.id), 0)),
       (SELECT count(*) FROM (SELECT tx FROM play_entries GROUP BY tx HAVING sum(delta) <> 0) z),
       (SELECT count(*) FROM play_entries e JOIN play_tx t ON t.tx = e.tx JOIN play_accounts a ON a.id = e.account
          WHERE a.sid <> t.sid),
       (SELECT count(*) FROM play_accounts WHERE kind IN ('w', 'seat', 'pot', 'esc') AND balance < 0),
       (SELECT count(*) FROM (SELECT sid FROM play_accounts GROUP BY sid HAVING sum(balance) <> 0) z);
"""
AUDIT_NAMES = ("balances that aren't their entries", "unbalanced transactions", "transactions across spaces",
               "negative accounts", "spaces that don't sum to zero")
#: what the backup records and the restore compares: wallets, transactions, entries, chips in wallets, chips people hold
COUNT_SQL = """\
SELECT (SELECT count(*) FROM play_wallets), (SELECT count(*) FROM play_tx), (SELECT count(*) FROM play_entries),
       (SELECT coalesce(sum(balance), 0) FROM play_accounts WHERE kind = 'w'),
       (SELECT coalesce(sum(balance), 0) FROM play_accounts WHERE kind IN ('w', 'seat', 'pot', 'esc'));
"""
COUNT_NAMES = ("wallets", "transactions", "entries", "chips_in_wallets", "chips_held")


def reference() -> dict:
    return json.loads(REFERENCE.read_text())


#: the section each kind lives in (pg_dump: 2 pre-data, 3 data, 4 post-data), and the order we restore in: OUR order,
#: by kind (the archive's own order is the backup's choice: triggers before the data would fire on every row)
ORDER = ["ENCODING", "STDSTRINGS", "SEARCHPATH", "FUNCTION", "TABLE", "SEQUENCE", "SEQUENCE OWNED BY", "DEFAULT",
         "TABLE DATA", "SEQUENCE SET", "CONSTRAINT", "INDEX", "TRIGGER", "FK CONSTRAINT"]
SECTION = {k: 3 if k in ("TABLE DATA", "SEQUENCE SET") else 4 if k in ("CONSTRAINT", "INDEX", "TRIGGER", "FK CONSTRAINT") else 2
           for k in ORDER}


def check(entries: list, ref: dict | None = None) -> list[int]:
    """Layer 1 (and layer 3 on our own dump): refuse (UnsafeBackup) an archive that isn't exactly the games schema;
    returns the entry ids to restore, in OUR order (ORDER)."""
    ref = ref or reference()
    want, copies, seqs = ref["entries"], ref["copies"], set(ref["sequences"])

    def refuse(e, what: str):
        raise UnsafeBackup(f"The backup's games database holds something a Tin Hat server's doesn't ({what}: "
                           f"{e.desc} {e.tag[:60]!r}); the games weren't restored.")
    keep, seen, ids = [], set(), set()
    for e in entries:
        if e.id in ids:
            refuse(e, "an entry id twice")
        ids.add(e.id)
        if e.desc in SKIP:
            if getattr(e, "had_data", False):
                refuse(e, "a data stream on an entry that has none")
            continue
        if e.desc not in RUN:
            refuse(e, "a kind of entry")
        if e.namespace not in ("", "public"):
            refuse(e, "a schema")
        if getattr(e, "tablespace", ""):
            refuse(e, "a tablespace")
        if getattr(e, "section", 0) != SECTION[e.desc]:
            refuse(e, "an entry in another section")
        # only a data entry carries a data stream, and only as its COPY (pg_restore runs a stream's SQL otherwise)
        if getattr(e, "had_data", False) != (e.desc == "TABLE DATA"):
            refuse(e, "a data stream on an entry that has none" if e.desc != "TABLE DATA" else "a data entry without data")
        if e.desc == "TABLE DATA":
            if copies.get(e.tag) != e.copy or e.defn:
                refuse(e, "a data entry")
        elif e.copy:
            refuse(e, "a data entry")
        elif e.desc == "SEQUENCE SET":
            m = _SETVAL.fullmatch(e.defn)
            if not m or m.group(1) not in seqs or e.tag not in seqs:
                refuse(e, "a sequence value")
        else:
            key = f"{e.desc}|{e.tag}"
            if want.get(key) != e.defn:
                refuse(e, "a schema entry that isn't the games schema's own")
            if key in seen:
                refuse(e, "a schema entry twice")
            seen.add(key)
        keep.append((ORDER.index(e.desc), e.id))
    missing = sorted(set(want) - seen)
    if missing:
        raise UnsafeBackup("The backup's games database is missing part of the games schema "
                           f"({', '.join(m.split('|', 1)[1] for m in missing[:5])}); the games weren't restored.")
    return [i for _, i in sorted(keep)]


def valid_counts(c) -> dict | None:
    """A backup.json "play" counts object, or None if it isn't one (a backup's metadata is untrusted input too)."""
    if not isinstance(c, dict):
        return None
    out = {k: c.get(k) for k in COUNT_NAMES}
    return out if all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 1 << 62 for v in out.values()) else None


@dataclass
class Result:
    dump: Path
    counts: dict


def _ints(out: str, n: int) -> tuple[int, ...] | None:
    try:
        vals = tuple(int(x) for x in out.strip().splitlines()[-1].split("|"))
    except (ValueError, IndexError):
        return None
    return vals if len(vals) == n else None


async def isolated(dump: Path, work: Path, image: str, expect: dict | None = None) -> Result:
    """Layers 1–3 for a backup's play.dump: our own, checked dump (in work/) with the counts. Raises UnsafeBackup.
    expect: the counts the backup recorded (backup.json "play"); a restored copy that differs is refused."""
    from . import restorecap
    ref = reference()
    if expect is not None:
        expect = valid_counts(expect)
        if expect is None:
            raise UnsafeBackup("The backup's record of its games database isn't one Tin Hat writes; the games weren't restored.")
    ids = check(dbcheck.read_toc(dump), ref)
    work.mkdir(parents=True, exist_ok=True)
    data = work / "pgcheck"
    shutil.rmtree(data, ignore_errors=True)
    data.mkdir(mode=0o700)
    (work / "restore.list").write_text(dbcheck.list_file(ids))
    name = f"tinhat-playcheck-{secrets.token_hex(4)}"
    admin_pw, pw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    clean = work / "checked-play.dump"
    sh = dbcheck._sh
    try:
        rc, out = await sh("docker", "run", "-d", "--rm", "--name", name, "--network", "none", "--log-driver", "none",
                           "--pids-limit", "512", "--memory", dbcheck.CONTAINER_MEMORY, "--memory-swap", dbcheck.CONTAINER_MEMORY,
                           "-e", f"POSTGRES_PASSWORD={admin_pw}", "-e", "PGDATA=/var/lib/postgresql/data",
                           "-e", "POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=C --lc-ctype=C",
                           "-v", f"{dump}:/backup/play.dump:ro", "-v", f"{work / 'restore.list'}:/backup/restore.list:ro",
                           "-v", f"{data}:/var/lib/postgresql/data", image)
        if rc != 0:
            raise UnsafeBackup(f"Couldn't start the games database check ({out.strip()[-200:]}).")
        for _ in range(90):
            if (await sh("docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"))[0] == 0:
                break
            await asyncio.sleep(1)
        else:
            raise UnsafeBackup("The games database check didn't start.")
        rc, out = await sh("docker", "exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-v", f"pw={pw}",
                           "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres",
                           stdin=b"CREATE ROLE restorer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION "
                                 b"NOBYPASSRLS PASSWORD :'pw';\n"
                                 b"CREATE DATABASE tinhat_play OWNER restorer ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' "
                                 b"TEMPLATE template0;\n")
        if rc != 0:
            raise UnsafeBackup(f"Couldn't prepare the games database check ({out.strip()[-200:]}).")
        claim = restorecap.Claim(max(dump.stat().st_size * dbcheck.DB_RATIO, dbcheck.MIN_DB_BYTES), 1_000_000)
        r = await asyncio.to_thread(
            restorecap.run_capped,
            ["docker", "exec", "-e", f"PGPASSWORD={pw}", name, "pg_restore", "-h", "127.0.0.1", "-U", "restorer",
             "-d", DATABASE, "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error",
             "-L", "/backup/restore.list", "/backup/play.dump"],
            None, data, claim, 3600)
        if r.returncode != 0:
            raise UnsafeBackup("The backup's games database couldn't be restored on its own (it may be damaged): "
                               f"{(r.stderr or r.stdout or '').strip()[-300:]}")
        r = await asyncio.to_thread(
            restorecap.run_capped,
            ["docker", "exec", "-e", f"PGPASSWORD={pw}", name, "pg_dump", "-h", "127.0.0.1", "-U", "restorer", "-Fc",
             "--no-owner", "--no-privileges", "-f", "/var/lib/postgresql/data/checked-play.dump", DATABASE],
            None, data, claim, 3600)
        if r.returncode != 0 or not (data / "checked-play.dump").is_file():
            raise UnsafeBackup(f"Couldn't copy the checked games database ({(r.stderr or '').strip()[-200:]}).")
        os.replace(data / "checked-play.dump", clean)
        check(dbcheck.read_toc(clean), ref)  # layer 3: our own dump, the same rules
        psql = ("docker", "exec", "-i", "-e", f"PGPASSWORD={pw}", "-e", "PGOPTIONS=-c client_min_messages=error", name,
                "psql", "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "restorer", "-d", DATABASE)
        rc, out = await sh(*psql, stdin=b"SELECT count(*), max(version) FROM play_schema;\n")
        v = _ints(out, 2)
        if rc != 0 or not v or v[1] != ref["schema"]:
            raise UnsafeBackup("The backup's games database is from another games version than this server runs; the "
                               "games weren't restored.")
        rc, out = await sh(*psql, stdin=AUDIT_SQL.encode())
        bad = _ints(out, len(AUDIT_NAMES))
        if rc != 0 or bad is None or any(bad):
            what = ", ".join(n for n, x in zip(AUDIT_NAMES, bad or ()) if x) or "the check didn't answer"
            raise UnsafeBackup(f"The backup's games database fails the ledger check ({what}); the games weren't restored.")
        rc, out = await sh(*psql, stdin=COUNT_SQL.encode())
        c = _ints(out, len(COUNT_NAMES))
        if rc != 0 or c is None:
            raise UnsafeBackup("The backup's games database couldn't be counted; the games weren't restored.")
        counts = dict(zip(COUNT_NAMES, c))
        if expect is not None and expect != counts:
            raise UnsafeBackup(f"The backup's games database doesn't match what the backup recorded ({counts} vs "
                               f"{expect}); the games weren't restored.")
        return Result(clean, counts)
    except BaseException:
        clean.unlink(missing_ok=True)
        raise
    finally:
        try:
            rc, out = await sh("docker", "rm", "-f", name, timeout=120)
            if rc != 0 and "No such container" not in out:
                log.warning("playdb: couldn't remove %s: %s", name, out.strip()[-200:])
        except Exception as e:  # noqa: BLE001
            log.warning("playdb: couldn't remove %s: %r", name, e)
        shutil.rmtree(data, ignore_errors=True)
        (work / "restore.list").unlink(missing_ok=True)


# ---- the live side (through the server's own postgres container) ---------------------------------------------------

async def _live(*args: str, stdin: bytes | None = None, timeout: float = 600) -> tuple[int, str]:
    from . import compose
    return await compose.run("exec", "-T", "postgres", *args, timeout=timeout, stdin=stdin)


async def exists(run=_live) -> bool | None:
    rc, out = await run("psql", "-X", "-tA", "-U", "synapse", "-d", "postgres",
                        stdin=b"SELECT count(*) FROM pg_database WHERE datname = 'tinhat_play';\n")
    v = _ints(out, 1) if rc == 0 else None
    return None if v is None else v[0] == 1


async def counts(run=_live) -> dict | None:
    rc, out = await run("psql", "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", DATABASE, stdin=COUNT_SQL.encode())
    c = _ints(out, len(COUNT_NAMES)) if rc == 0 else None
    return dict(zip(COUNT_NAMES, c)) if c else None


async def dump_to(path: Path, base: list[str] | None = None) -> dict | None:
    """The backup's play.dump + its counts, both from ONE snapshot: a psql session opens a REPEATABLE READ transaction,
    exports its snapshot and counts in it; pg_dump --snapshot writes exactly that state; then the session ends. Games
    may go on writing meanwhile (astra G1: a before/after comparison starved busy servers of games backups). None: no
    games database on this server. Never raises: a failure is returned ({"ok": False, "why": …})."""
    hold = None
    try:
        if base is None:
            from . import compose
            base = compose.base()
        cmd = list(base)
        have = await exists()
        if not have:
            return None if have is False else {"ok": False, "why": "couldn't ask the database"}
        hold = await asyncio.create_subprocess_exec(*cmd, "exec", "-T", "postgres", "psql", "-X", "-q", "-tA", "-v",
                                                    "ON_ERROR_STOP=1", "-U", "synapse", "-d", DATABASE,
                                                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        # lock_timeout: the counts take shared locks; a schema change queued meanwhile must not stall the dump behind
        # it (astra G1 r2): then the dump fails fast, the backup records it, the next one tries again
        hold.stdin.write(b"SET lock_timeout = '60s';\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n"
                         + COUNT_SQL.encode())
        await hold.stdin.drain()
        snap_line = (await asyncio.wait_for(hold.stdout.readline(), 60)).decode(errors="replace").strip()
        count_line = (await asyncio.wait_for(hold.stdout.readline(), 120)).decode(errors="replace").strip()
        if not re.fullmatch(r"[0-9A-F]{8}-[0-9A-F]{8}-[0-9]{1,8}", snap_line):
            return {"ok": False, "why": f"couldn't hold a snapshot ({snap_line[-120:]})"}
        c = _ints(count_line, len(COUNT_NAMES))
        if c is None:
            return {"ok": False, "why": "couldn't count the games database"}
        with open(path, "wb") as f:
            proc = await asyncio.create_subprocess_exec(*cmd, "exec", "-T", "postgres", "pg_dump", "-U", "synapse", "-Fc",
                                                        "--lock-wait-timeout=60000", f"--snapshot={snap_line}", DATABASE,
                                                        stdout=f, stderr=asyncio.subprocess.PIPE)
            try:
                _, err = await asyncio.wait_for(proc.communicate(), 1800)
            finally:
                if proc.returncode is None:  # a timeout or a cancel: the dump never outlives its wait
                    proc.kill()
                    await proc.wait()
        if proc.returncode != 0 or path.stat().st_size < 1024:
            path.unlink(missing_ok=True)
            return {"ok": False, "why": (err or b"").decode(errors="replace").strip()[-200:] or "pg_dump failed"}
        return {"ok": True, "counts": dict(zip(COUNT_NAMES, c))}
    except BaseException as e:
        path.unlink(missing_ok=True)
        if not isinstance(e, Exception):
            raise
        return {"ok": False, "why": repr(e)[:200]}
    finally:
        if hold is not None and hold.returncode is None:
            try:  # ends the snapshot's transaction (the session reads EOF and ends too)
                hold.stdin.write(b"COMMIT;\n")
                hold.stdin.close()
                await asyncio.wait_for(hold.wait(), 30)
            except BaseException:  # noqa: BLE001
                hold.kill()
                await hold.wait()


ROLE_CHECK_SQL = """\
SELECT count(*) FROM pg_roles r
WHERE r.rolname = 'tinhat_play' AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND NOT r.rolbypassrls AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid);
"""
STAGE = "tinhat_play_restore"
PREV = "tinhat_play_prev"


async def load(dump: Path, run=_live, prepare=None) -> dict:
    """Our own CHECKED play.dump (isolated()) into the live server: restored AS `tinhat_play` (asserted: not a
    superuser, no CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, no memberships) into a REPLACEMENT database, checked there
    (the ledger + the counts), and only then swapped in for `tinhat_play` (the old one dropped). Any failure drops the
    replacement and leaves `tinhat_play` as it was. Returns the counts; raises RuntimeError."""
    if prepare is None:
        async def prepare():
            from . import play
            return await play.ensure_db(force=True, apply=False)
    ok, msg = await prepare()
    if not ok and "G9" not in msg:  # (a G9 finding is about Synapse's database, not this one: the restore goes on)
        raise RuntimeError(f"the games database couldn't be prepared: {msg}")
    as_synapse = ("psql", "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", "postgres")
    rc, out = await run(*as_synapse, stdin=ROLE_CHECK_SQL.encode())
    if rc != 0 or _ints(out, 1) != (1,):
        raise RuntimeError("the games role isn't the plain role it must be (not a superuser, no extra rights); the games "
                           "weren't restored")
    drop_stage = f"DROP DATABASE IF EXISTS {STAGE} WITH (FORCE);\n".encode()
    rc, out = await run(*as_synapse, stdin=drop_stage
                        + f"CREATE DATABASE {STAGE} OWNER tinhat_play ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;\n"
                          f"REVOKE ALL ON DATABASE {STAGE} FROM PUBLIC;\nGRANT CONNECT, TEMPORARY ON DATABASE {STAGE} TO tinhat_play;\n".encode())
    if rc != 0:
        raise RuntimeError(f"couldn't prepare the replacement games database: {out.strip()[-200:]}")
    try:
        rc, out = await run("pg_restore", "-U", ROLE, "-d", STAGE, "--no-owner", "--no-privileges", "--single-transaction",
                            "--exit-on-error", stdin=dump.read_bytes(), timeout=3600)
        if rc != 0:
            raise RuntimeError(f"the checked games database couldn't be restored: {out.strip()[-300:]}")
        rc, out = await run("psql", "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", STAGE, stdin=AUDIT_SQL.encode())
        bad = _ints(out, len(AUDIT_NAMES))
        if rc != 0 or bad is None or any(bad):
            raise RuntimeError(f"the restored games database fails the ledger check ({out.strip()[-200:]})")
        rc, out = await run("psql", "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", STAGE, stdin=COUNT_SQL.encode())
        c = _ints(out, len(COUNT_NAMES)) if rc == 0 else None
        if c is None:
            raise RuntimeError("the restored games database couldn't be counted")
        # the swap, never destructive (astra G1 r2): the old one is RENAMED aside, the checked replacement takes its name
        # (its owner and ACL with it), and only then is the old one dropped. A failure renames the old one back; a crash
        # in between is repaired by play.ENSURE_SQL (a missing tinhat_play with a PREV beside it gets PREV back).
        kick = lambda db: f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{db}' AND pid <> pg_backend_pid();\n".encode()  # noqa: E731
        rc, out = await run(*as_synapse, stdin=f"DROP DATABASE IF EXISTS {PREV} WITH (FORCE);\n".encode() + kick("tinhat_play")
                            + f"ALTER DATABASE tinhat_play RENAME TO {PREV};\n".encode())
        if rc != 0:
            raise RuntimeError(f"couldn't move the old games database aside: {out.strip()[-200:]}")
        rc, out = await run(*as_synapse, stdin=kick(STAGE) + f"ALTER DATABASE {STAGE} RENAME TO tinhat_play;\n".encode())
        if rc != 0:
            back, _ = await run(*as_synapse, stdin=kick(PREV) + f"ALTER DATABASE {PREV} RENAME TO tinhat_play;\n".encode())
            raise RuntimeError(f"couldn't put the restored games database in place ({out.strip()[-160:]}); "
                               + ("the old one is back" if back == 0 else "the old one is kept as " + PREV))
        await run(*as_synapse, stdin=f"DROP DATABASE IF EXISTS {PREV} WITH (FORCE);\n".encode())
        return dict(zip(COUNT_NAMES, c))
    except BaseException:
        await run(*as_synapse, stdin=drop_stage)
        raise

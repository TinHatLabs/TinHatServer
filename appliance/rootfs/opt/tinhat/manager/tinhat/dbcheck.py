"""A backup's database, restored without trusting it (0.3.16; the 0.3.10 design note "Restore into an isolated
database first").

A backup's db.dump is a pg_dump custom archive: a list of SQL entries that whoever made the backup chose. Restored the
old way (pg_restore as the database's superuser, inside the live postgres container) a crafted one could run any SQL
as superuser (`COPY … FROM PROGRAM` = a shell in the container). Now, three layers:
  1. THE LIST (read here, in Python, before anything runs): only the kinds of entry a Synapse database has; its
     functions and triggers exactly Synapse's own (synapse_pg_functions.json, byte for byte); every data entry's COPY a
     plain `COPY public.t (cols) FROM stdin;`. Anything else refuses the backup. Early and cheap, not the boundary:
     every other entry's SQL text is still the backup's own.
  2. A THROWAWAY DATABASE: a postgres container of this server's own image with no network, the dump mounted read-only
     and a data folder of its own; the restore connects as a role that is NOT a superuser and owns only that database
     (connects as it, so no RESET ROLE climbs back). Superuser-only things (files, programs, large objects on the
     server) fail there, and the container can't reach anything anyway. Bounded like a restic restore (restorecap).
  3. CHECKS, THEN OUR OWN DUMP: Synapse's schema version is there, every account belongs to this server name, the
     counts. Then pg_dump of that database (pg_dump writes every entry from the catalog, so no statement of the
     backup's survives as text) is checked again with the list rules PLUS the expression rule: in every table,
     default, constraint and index, the only functions called are the few Synapse's schema uses (a default or check
     that called, say, lo_export would run as the live database's superuser the first time Synapse writes a row).
     Only that dump reaches the live database.
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

from .restoresafe import UnsafeBackup

REFERENCE = Path(__file__).with_name("synapse_pg_functions.json")
log = logging.getLogger("tinhat.dbcheck")

#: the kinds a Synapse database's dump has; RUN = restored, SKIP = allowed but not restored (settings pg_restore handles
#: by itself, the database's own entry, privileges: --no-privileges)
RUN = {"TABLE", "TABLE DATA", "SEQUENCE", "SEQUENCE OWNED BY", "SEQUENCE SET", "DEFAULT", "INDEX", "CONSTRAINT",
       "FK CONSTRAINT", "COMMENT", "FUNCTION", "TRIGGER", "SCHEMA", "ENCODING", "STDSTRINGS", "SEARCHPATH"}
SKIP = {"DATABASE", "DATABASE PROPERTIES", "ACL"}
#: COMMENT entries: on these only (Synapse comments its tables and columns)
COMMENT_ON = ("TABLE ", "COLUMN ", "INDEX ", "SEQUENCE ", "CONSTRAINT ", "SCHEMA public")
#: the words followed by "(" in pg_dump's text of Synapse's tables, defaults, constraints and indexes: SQL syntax,
#: type names, index methods and the only functions it calls (now, EXTRACT, nextval). Anything else is refused.
CALLS_OK = {
    # syntax
    "key", "unique", "check", "where", "and", "or", "not", "in", "identity", "include", "as", "any", "array", "exists",
    "references", "on", "using", "values", "default", "by", "with", "nulls", "set",  # SET (n_distinct=…)
    # types
    "character", "varying", "varchar", "char", "bpchar", "numeric", "decimal", "bit", "timestamp", "time", "interval",
    "float", "double", "precision",
    # index methods
    "btree", "gin", "gist", "hash", "brin",
    # functions in Synapse's schema
    "now", "extract", "nextval",
}
MAX_ENTRIES = 20_000
MAX_STR = 16 * 1024 * 1024
#: all of the list's text together (definitions, names) — a real Synapse list is about 1 MB
MAX_TOC_BYTES = 128 * 1024 * 1024
#: entry ids (pg_restore sizes arrays by the largest one)
MAX_ID = 10 * MAX_ENTRIES
#: Synapse's schema versions this check accepts (Synapse itself refuses one it can't run, at its first start)
SCHEMA_MIN, SCHEMA_MAX = 60, 999
#: the throwaway database's container (memory: PostgreSQL's defaults need far less)
CONTAINER_MEMORY = "2g"
_IDENT = r"[a-z_][a-z0-9_$]*"
_COPY = re.compile(rf"COPY public\.{_IDENT} \((?:{_IDENT}|\"[^\"\n]+\")(?:, (?:{_IDENT}|\"[^\"\n]+\"))*\) FROM stdin;\n")
_TRIGGER = re.compile(rf"CREATE TRIGGER ({_IDENT}) (?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE)(?: OR (?:INSERT|UPDATE|DELETE))* "
                      rf"ON public\.{_IDENT} FOR EACH ROW EXECUTE FUNCTION public\.({_IDENT})\(\);\n")


@dataclass
class Entry:
    id: int
    desc: str
    tag: str
    namespace: str
    defn: str
    copy: str


# ---- layer 1: the archive's list of entries (pg_dump custom format, read without its data) ---------------------------

class _Reader:
    def __init__(self, f, int_size: int, off_size: int):
        self.f, self.int_size, self.off_size = f, int_size, off_size
        self.total = 0

    def read(self, n: int) -> bytes:
        b = self.f.read(n)
        if len(b) != n:
            raise UnsafeBackup("The backup's database copy is cut short; it wasn't restored.")
        return b

    def int(self) -> int:
        sign = self.read(1)[0]
        v = int.from_bytes(self.read(self.int_size), "little")
        return -v if sign else v

    def str(self) -> str | None:
        n = self.int()
        if n < 0:
            return None
        self.total += n
        if n > MAX_STR or self.total > MAX_TOC_BYTES:
            raise UnsafeBackup("The backup's database copy isn't one Tin Hat made; it wasn't restored.")
        return self.read(n).decode("utf-8", errors="replace")


def read_toc(path: Path) -> list[Entry]:
    """The entries of a pg_dump custom-format archive (format 1.12 to 1.16 = PostgreSQL 9.5 to 17)."""
    with open(path, "rb") as f:
        if f.read(5) != b"PGDMP":
            raise UnsafeBackup("The backup's database copy isn't a PostgreSQL dump; it wasn't restored.")
        head = f.read(6)
        if len(head) != 6:
            raise UnsafeBackup("The backup's database copy is cut short; it wasn't restored.")
        vmaj, vmin, vrev, int_size, off_size, fmt = head
        ver = (vmaj, vmin, vrev)
        if not ((1, 12, 0) <= ver <= (1, 16, 255)) or fmt != 1 or not (1 <= int_size <= 8) or not (1 <= off_size <= 8):
            raise UnsafeBackup("The backup's database copy is in a format this server doesn't read; it wasn't restored.")
        r = _Reader(f, int_size, off_size)
        if ver >= (1, 15, 0):
            r.read(1)  # compression algorithm
        else:
            r.int()    # compression level
        for _ in range(7):
            r.int()    # the dump's time
        r.str()        # database name
        r.str()        # server version
        r.str()        # pg_dump version
        n = r.int()
        if not (0 <= n <= MAX_ENTRIES):
            raise UnsafeBackup("The backup's database copy isn't one Tin Hat made; it wasn't restored.")
        out = []
        for _ in range(n):
            dump_id = r.int()
            if not (1 <= dump_id <= MAX_ID):
                raise UnsafeBackup("The backup's database copy isn't one Tin Hat made; it wasn't restored.")
            r.int()    # has data
            r.str()    # table oid
            r.str()    # oid
            tag = r.str() or ""
            desc = r.str() or ""
            r.int()    # section
            defn = r.str() or ""
            r.str()    # drop statement
            copy = r.str() or ""
            namespace = r.str() or ""
            r.str()    # tablespace
            if ver >= (1, 14, 0):
                r.str()  # table access method
            if ver >= (1, 16, 0):
                r.int()  # relkind
            r.str()    # owner
            r.str()    # "false" (WITH OIDS, gone)
            for _ in range(MAX_ENTRIES * 4):
                if r.str() is None:  # the dependencies, up to a NULL
                    break
            else:
                raise UnsafeBackup("The backup's database copy isn't one Tin Hat made; it wasn't restored.")
            r.read(1 + off_size)  # where its data is
            out.append(Entry(dump_id, desc, tag, namespace, defn, copy))
    return out


def reference() -> dict:
    return json.loads(REFERENCE.read_text())


def _strip(sql: str) -> str:
    """The statement with every string literal ('…', E'…' with backslash escapes, $tag$…$tag$) turned into '' and every
    quoted name ("…") into the word q, comments dropped — in ONE left-to-right pass, so a quote character inside the
    other kind (a name "a'" or a string 'say "hi"') can't hide or fake anything. An unterminated one refuses."""
    out, i, n = [], 0, len(sql)

    def refuse():
        raise UnsafeBackup("The backup's database holds a definition that doesn't parse; it wasn't restored.")
    while i < n:
        c = sql[i]
        prev = sql[i - 1] if i else " "
        if c in "eE" and i + 1 < n and sql[i + 1] == "'" and not (prev.isalnum() or prev in "_$"):
            j = i + 2
            while True:
                if j >= n:
                    refuse()
                if sql[j] == "\\":
                    j += 2
                elif sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                    else:
                        break
                else:
                    j += 1
            out.append(" '' ")
            i = j + 1
        elif c == "'":
            j = i + 1
            while True:
                k = sql.find("'", j)
                if k < 0:
                    refuse()
                if k + 1 < n and sql[k + 1] == "'":
                    j = k + 2
                    continue
                break
            out.append(" '' ")
            i = k + 1
        elif c == '"':
            j = i + 1
            while True:
                k = sql.find('"', j)
                if k < 0:
                    refuse()
                if k + 1 < n and sql[k + 1] == '"':
                    j = k + 2
                    continue
                break
            out.append(" q")
            i = k + 1
        elif c == "$" and not (prev.isalnum() or prev in "_$"):
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if not m:
                out.append(c)
                i += 1
                continue
            k = sql.find(m.group(0), i + len(m.group(0)))
            if k < 0:
                refuse()
            out.append(" '' ")
            i = k + len(m.group(0))
        elif sql.startswith("--", i):
            k = sql.find("\n", i)
            i = n if k < 0 else k
        elif sql.startswith("/*", i):
            depth, j = 1, i + 2
            while depth:
                if j >= n:
                    refuse()
                if sql.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif sql.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            out.append(" ")
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def calls(sql: str) -> set[str]:
    """The words followed by "(" in a statement (string literals and quoted names left out), lower-cased; a
    schema-qualified name counts by its last part unless it is a public.<table> reference."""
    found = set()
    text = _strip(sql)
    for m in re.finditer(r"([A-Za-z_][A-Za-z0-9_$.]*)\s*\(", text):
        name = m.group(1).lower()
        if re.fullmatch(rf"public\.{_IDENT}", name) and re.search(r"\b(?:TABLE|ONLY|REFERENCES)\s+$", text[:m.start()],
                                                                   re.IGNORECASE):
            continue  # a table, not a call: CREATE TABLE public.t (, REFERENCES public.t(col)
        found.add(name.rsplit(".", 1)[-1] if "." in name else name)
    return found


def check(entries: list[Entry], ours: bool = False, ref: dict | None = None) -> list[int]:
    """Refuse (UnsafeBackup) an archive with anything a Synapse database doesn't have; returns the entry ids to restore.
    ours: the archive is our own pg_dump of the throwaway database (layer 3): its text comes from the catalog, so the
    expression rule applies too."""
    ref = ref or reference()
    funcs, trig_defs = ref["functions"], set(ref["trigger_defs"])

    def refuse(e: Entry, what: str):
        raise UnsafeBackup(f"The backup's database holds something a Tin Hat server's doesn't ({what}: "
                           f"{e.desc} {e.tag[:60]!r}); it wasn't restored.")
    keep = []
    for e in entries:
        if e.desc in SKIP:
            continue
        if e.desc not in RUN:
            refuse(e, "a kind of entry")
        if e.namespace not in ("", "public"):
            refuse(e, "a schema")
        if e.desc == "SCHEMA" and e.tag != "public":
            refuse(e, "a schema")
        if e.desc == "COMMENT" and not e.tag.startswith(COMMENT_ON):
            refuse(e, "a comment")
        if e.desc == "FUNCTION" and funcs.get(e.tag) != e.defn:
            refuse(e, "a function")
        if e.desc == "TRIGGER":  # byte for byte, its table included (older pg_dumps say EXECUTE PROCEDURE)
            if e.defn.replace(" EXECUTE PROCEDURE ", " EXECUTE FUNCTION ", 1) not in trig_defs:
                refuse(e, "a trigger")
        if e.desc == "TABLE DATA" and not _COPY.fullmatch(e.copy):
            refuse(e, "a data entry")
        if e.desc != "TABLE DATA" and e.copy:
            refuse(e, "a data entry")
        if ours and e.desc in ("TABLE", "DEFAULT", "CONSTRAINT", "FK CONSTRAINT", "INDEX", "SEQUENCE", "SEQUENCE OWNED BY",
                               "COMMENT"):
            bad = calls(e.defn) - CALLS_OK
            if bad:
                refuse(e, f"a call to {', '.join(sorted(bad))[:60]}")
        keep.append(e.id)
    return keep


def list_file(ids: list[int]) -> str:
    """pg_restore -L input: one `id;` line per entry to restore."""
    return "".join(f"{i};\n" for i in ids)


# ---- layers 2 + 3: the throwaway database ------------------------------------------------------------------------------

@dataclass
class Result:
    dump: Path
    counts: dict
    schema_version: int


#: what a database restore may add to the throwaway's data folder: this many times the dump's size (indexes, a
#: compressed dump), at least MIN_DB_BYTES; plus restorecap's floors
DB_RATIO = 40
MIN_DB_BYTES = 4 * 1024**3
COUNT_SQL = ("SELECT (SELECT count(*) FROM users WHERE deactivated = 0 AND name NOT LIKE '@tinhat-system:%'), "
             "(SELECT count(*) FROM rooms), "
             "(SELECT count(*) FROM events WHERE type IN ('m.room.encrypted', 'm.room.message'))")


#: the most of a command's output kept (answers are a line; errors a few lines)
MAX_OUT = 256 * 1024


async def _sh(*cmd: str, timeout: float = 600, stdin: bytes | None = None) -> tuple[int, str]:
    """Run a command; (exit code, its output, at most MAX_OUT bytes: more stops it and counts as a failure). A timeout or
    a cancel kills it: a command never outlives its wait."""
    proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE if stdin is not None else None,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)

    async def run() -> bytes:
        if stdin is not None:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
            proc.stdin.close()
        out = b""
        while len(out) <= MAX_OUT:  # (read() returns what has arrived so far: loop to EOF or past the bound)
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            out += chunk
        if len(out) > MAX_OUT:
            proc.kill()
        await proc.wait()
        return out
    try:
        out = await asyncio.wait_for(run(), timeout)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    if len(out) > MAX_OUT:
        return 1, out[-4096:].decode(errors="replace") + "\n(output cut: too long)"
    return proc.returncode or 0, out.decode(errors="replace")


async def isolated(dump: Path, work: Path, server_name: str, image: str, synapse_version: int | None = None) -> Result:
    """Layers 1–3 for a backup's db.dump: returns our own, checked dump (in work/) with the counts. Raises UnsafeBackup.
    synapse_version: the schema version this server's Synapse runs (synapse_schema_version); a backup whose database
    needs a newer one is refused here, before anything is replaced (None: Synapse's own check at its first start).
    The throwaway container and its data folder are gone on every way out."""
    from . import restorecap
    ids = check(read_toc(dump))
    work.mkdir(parents=True, exist_ok=True)
    data = work / "pgcheck"
    shutil.rmtree(data, ignore_errors=True)
    data.mkdir(mode=0o700)
    (work / "restore.list").write_text(list_file(ids))
    name = f"tinhat-dbcheck-{secrets.token_hex(4)}"
    admin_pw, pw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    clean = work / "checked.dump"
    try:
        # --log-driver none: the backup's SQL runs here and could flood the server log (RAISE LOG in a loop); Docker's
        # default log has no size limit and isn't on the disk the watchdog watches (review 0.3.16)
        rc, out = await _sh("docker", "run", "-d", "--rm", "--name", name, "--network", "none", "--log-driver", "none",
                            "--pids-limit", "512",
                            "--memory", CONTAINER_MEMORY, "--memory-swap", CONTAINER_MEMORY,
                            "-e", f"POSTGRES_PASSWORD={admin_pw}", "-e", "PGDATA=/var/lib/postgresql/data",
                            "-e", "POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=C --lc-ctype=C",
                            "-v", f"{dump}:/backup/db.dump:ro", "-v", f"{work / 'restore.list'}:/backup/restore.list:ro",
                            "-v", f"{data}:/var/lib/postgresql/data", image)
        if rc != 0:
            raise UnsafeBackup(f"Couldn't start the database check ({out.strip()[-200:]}).")
        for _ in range(90):
            if (await _sh("docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"))[0] == 0:
                break
            await asyncio.sleep(1)
        else:
            raise UnsafeBackup("The database check didn't start.")
        # the restoring role: not a superuser, owns only the throwaway database (password: a psql variable, quoted)
        rc, out = await _sh("docker", "exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-v", f"pw={pw}",
                            "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres",
                            stdin=b"CREATE ROLE restorer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION "
                                  b"NOBYPASSRLS PASSWORD :'pw';\n"
                                  b"CREATE DATABASE synapse OWNER restorer ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' "
                                  b"TEMPLATE template0;\n")
        if rc != 0:
            raise UnsafeBackup(f"Couldn't prepare the database check ({out.strip()[-200:]}).")
        size = dump.stat().st_size
        claim = restorecap.Claim(max(size * DB_RATIO, MIN_DB_BYTES), 1_000_000)
        r = await asyncio.to_thread(
            restorecap.run_capped,
            ["docker", "exec", "-e", f"PGPASSWORD={pw}", name, "pg_restore", "-h", "127.0.0.1", "-U", "restorer",
             "-d", "synapse", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error",
             "-L", "/backup/restore.list", "/backup/db.dump"],
            None, data, claim, 6 * 3600)
        if r.returncode != 0:
            raise UnsafeBackup("The backup's database couldn't be restored on its own (it may be damaged, or not a "
                               f"Tin Hat server's): {(r.stderr or r.stdout or '').strip()[-300:]}")
        # our own dump, written inside the watched data folder (so it counts against the same cap), then moved out
        r = await asyncio.to_thread(
            restorecap.run_capped,
            ["docker", "exec", "-e", f"PGPASSWORD={pw}", name, "pg_dump", "-h", "127.0.0.1", "-U", "restorer", "-Fc",
             "--no-owner", "--no-privileges", "-f", "/var/lib/postgresql/data/checked.dump", "synapse"],
            None, data, claim, 6 * 3600)
        if r.returncode != 0 or not (data / "checked.dump").is_file() or (data / "checked.dump").stat().st_size < 1024:
            raise UnsafeBackup(f"Couldn't copy the checked database ({(r.stderr or '').strip()[-200:]}).")
        os.replace(data / "checked.dump", clean)
        check(read_toc(clean), ours=True)
        # Only now the questions: our own dump passed the rules, so the database holds tables, Synapse's exact functions
        # and triggers (they run on writes only) and nothing a SELECT could call (no views, rules or other functions).
        # Server notices off and every answer read with a bound (review round 3).
        psql = ("docker", "exec", "-e", f"PGPASSWORD={pw}", "-e", "PGOPTIONS=-c client_min_messages=error", name, "psql",
                "-X", "-tA", "-v", "ON_ERROR_STOP=1",
                "-h", "127.0.0.1", "-U", "restorer", "-d", "synapse")
        rc, out = await _sh(*psql, "-c", "SELECT count(*), max(version) FROM schema_version")
        try:
            rows, schema = (int(x) for x in out.strip().splitlines()[-1].split("|"))
        except (ValueError, IndexError):
            rows = schema = 0
        if rc != 0 or rows != 1 or not (SCHEMA_MIN <= schema <= SCHEMA_MAX):
            raise UnsafeBackup("The backup's database isn't a chat server's this version can run (its schema version); "
                               "it wasn't restored.")
        if synapse_version is not None:
            rc, out = await _sh(*psql, "-c", "SELECT coalesce(max(compat_version), 0) FROM schema_compat_version")
            try:
                compat = int(out.strip().splitlines()[-1])
            except (ValueError, IndexError):
                compat = -1
            if rc != 0 or not (0 <= compat <= synapse_version):
                raise UnsafeBackup("The backup's database is from a newer chat server than this version runs; update this "
                                   "computer first (the setup page offers it), then restore.")
        rc, out = await _sh("docker", "exec", "-i", "-e", f"PGPASSWORD={pw}", "-e", "PGOPTIONS=-c client_min_messages=error",
                            name, "psql", "-X", "-tA", "-v",
                            "ON_ERROR_STOP=1", "-v", f"sn={server_name}", "-h", "127.0.0.1", "-U", "restorer", "-d",
                            "synapse",
                            stdin=b"SELECT count(*) FROM users WHERE right(name, length(:'sn') + 1) <> ':' || :'sn';\n")
        if rc != 0 or out.strip().splitlines()[-1:] != ["0"]:
            raise UnsafeBackup(f"The backup's database has accounts of another server than {server_name}; it wasn't "
                               "restored.")
        rc, out = await _sh(*psql, "-c", COUNT_SQL)
        try:
            if rc != 0:
                raise ValueError(out)
            people, rooms, messages = (int(x) for x in out.strip().splitlines()[-1].split("|"))
        except (ValueError, IndexError):
            raise UnsafeBackup("The backup's database couldn't be counted; it wasn't restored.")
        return Result(clean, {"people": people, "rooms": rooms, "messages": messages}, schema)
    except BaseException:
        clean.unlink(missing_ok=True)
        raise
    finally:  # each step on its own: one failing never skips the next or hides the first error
        try:
            rc, out = await _sh("docker", "rm", "-f", name, timeout=120)
            if rc != 0 and "No such container" not in out:
                log.warning("dbcheck: couldn't remove %s: %s", name, out.strip()[-200:])
        except Exception as e:  # noqa: BLE001
            log.warning("dbcheck: couldn't remove %s: %r", name, e)
        shutil.rmtree(data, ignore_errors=True)
        (work / "restore.list").unlink(missing_ok=True)


async def synapse_schema_version(compose_yaml: Path) -> int | None:
    """SCHEMA_VERSION of this server's own Synapse image (read from the image, no network), or None."""
    image = next((ln.split("image:", 1)[1].strip() for ln in compose_yaml.read_text().splitlines()
                  if ln.strip().startswith("image:") and "synapse" in ln), None)
    if not image:
        return None
    try:
        rc, out = await _sh("docker", "run", "--rm", "--network", "none", "--log-driver", "none", "--entrypoint", "python", image, "-c",
                            "from synapse.storage.schema import SCHEMA_VERSION; print(SCHEMA_VERSION)", timeout=120)
        return int(out.strip().splitlines()[-1]) if rc == 0 else None
    except (ValueError, IndexError, asyncio.TimeoutError, OSError):
        return None


def postgres_image(compose_yaml: Path) -> str:
    for line in compose_yaml.read_text().splitlines():
        if line.strip().startswith("image: postgres"):
            return line.split("image:", 1)[1].strip()
    raise UnsafeBackup("This server's database image isn't named in its compose file.")


def main(argv: list[str]) -> int:
    """python3 -m tinhat.dbcheck list DUMP      the entries and what the rules say (layer 1)
       python3 -m tinhat.dbcheck reference DUMP the functions/triggers of a fresh server's dump, for
                                                synapse_pg_functions.json (on a Synapse bump)"""
    if len(argv) != 2 or argv[0] not in ("list", "reference"):
        print(main.__doc__)
        return 2
    entries = read_toc(Path(argv[1]))
    if argv[0] == "reference":
        funcs = {e.tag: e.defn for e in entries if e.desc == "FUNCTION"}
        trigs = {}
        for e in entries:
            if e.desc == "TRIGGER":
                m = _TRIGGER.fullmatch(e.defn)
                if m:
                    trigs[m.group(1)] = m.group(2)
        print(json.dumps({"functions": funcs, "triggers": trigs,
                          "trigger_defs": sorted(e.defn for e in entries if e.desc == "TRIGGER")}, indent=1))
        return 0
    try:
        check(entries)
        print(f"{len(entries)} entries: OK")
        return 0
    except UnsafeBackup as e:
        print(e)
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))

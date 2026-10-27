"""SQLite storage for the names service: names, names codes, notices for owners, the audit log, live ACME TXT values.

Small and synchronous on purpose: every call is a few rows, far below a millisecond, so handlers call it directly.
"""
import hashlib
import ipaddress
import json
import os
import secrets
import sqlite3
import stat
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS names (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL,              -- active | suspended | retired (a taken name is never given out again)
    box_id TEXT UNIQUE NOT NULL,
    secret_hash TEXT NOT NULL,
    created REAL NOT NULL,
    created_ip TEXT,
    ip4 TEXT, ip6 TEXT,
    last_seen REAL, last_change REAL,
    code TEXT,
    reason TEXT,                       -- why it is suspended / retired
    version TEXT,                      -- the box's Tin Hat Server version, as last reported
    strikes INTEGER NOT NULL DEFAULT 0, -- answered but wasn't a Tin Hat server, in a row
    old_hashes TEXT                    -- JSON: earlier secrets' hashes (a restored server rotated its key; see rotate)
);
CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL, uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1, note TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, ts REAL NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, name TEXT, kind TEXT NOT NULL, ip TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS events_name ON events(name, ts);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, ts);
CREATE TABLE IF NOT EXISTS txt (name TEXT NOT NULL, value TEXT NOT NULL, ts REAL NOT NULL);
"""

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # same as invite codes: no 0/O, 1/I


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def code_hint(code: str | None) -> str:
    """What the logs and the audit table say about a server code: its first two letters, never the whole code (an
    unused multi-use code in a log or a backup would still work)."""
    c = (code or "").strip().upper()
    return f"{c[:5]}…" if len(c) > 5 else ("…" if c else "")


def caller_net(ip: str | None):
    """Who a per-address limit counts: an IPv4 address, or the IPv6 /64 it is in (one home or one server: rotating
    addresses inside it buys nothing). IPv4-mapped IPv6 counts as the IPv4 address. None when it isn't an address."""
    try:
        a = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return None
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return ipaddress.ip_network(f"{a}/{32 if a.version == 4 else 64}", strict=False)


def canon_ip(ip: str | None) -> str | None:
    """One spelling per address, as it is stored and counted: IPv4-mapped IPv6 as its IPv4 (::ffff:203.0.113.5 is
    203.0.113.5), IPv6 compressed lower-case; anything that isn't an address as it came (second review: the IPv4 path
    compared the raw string, so the two spellings of one caller had two quotas)."""
    if ip is None:
        return None
    try:
        a = ipaddress.ip_address(ip.strip())
    except ValueError:
        return ip
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return str(a)


def _same_caller(net, stored) -> bool:
    try:
        a = ipaddress.ip_address((stored or "").strip())
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.version == net.version and a in net


def private_files(path: str) -> None:
    """The database is the service's alone: its folder 0700, the file and its WAL/SHM 0600. systemd's
    StateDirectoryMode= leaves a folder that already existed as it was (the live one stayed 0755 with a 0644 database:
    security review 2026-10-26), so this runs every time the database is opened. A shared folder (sticky, like /tmp,
    or another user's) is left alone."""
    d = os.path.dirname(os.path.abspath(path))
    try:
        st = os.stat(d)
        if st.st_uid == os.geteuid() and not st.st_mode & stat.S_ISVTX and stat.S_IMODE(st.st_mode) != 0o700:
            os.chmod(d, 0o700)
    except OSError:
        pass
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            if stat.S_IMODE(os.stat(path + suffix).st_mode) != 0o600:
                os.chmod(path + suffix, 0o600)
        except OSError:
            pass


class DB:
    def __init__(self, path: str):
        self.c = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.executescript(SCHEMA)
        self._migrate()
        if path != ":memory:":
            private_files(path)

    # ---- names ----
    def _migrate(self):
        cols = {r[1] for r in self.c.execute("PRAGMA table_info(names)")}
        if "old_hashes" not in cols:
            self.c.execute("ALTER TABLE names ADD COLUMN old_hashes TEXT")
        if "move_open_until" not in cols:  # allow-move: an earlier key may take the name over once, until then
            self.c.execute("ALTER TABLE names ADD COLUMN move_open_until REAL")
        if "moved_to" not in cols:  # the server moved to its own domain: the name's page points there
            self.c.execute("ALTER TABLE names ADD COLUMN moved_to TEXT")

    def name(self, name: str):
        return self.c.execute("SELECT * FROM names WHERE name=?", (name,)).fetchone()

    def by_box(self, box_id: str):
        return self.c.execute("SELECT * FROM names WHERE box_id=?", (box_id,)).fetchone()

    def auth(self, box_id: str, secret: str):
        row = self.by_box(box_id or "")
        if row is None or not secrets.compare_digest(row["secret_hash"], hash_secret(secret or "")):
            return None
        return row

    def moved(self, box_id: str, secret: str) -> bool:
        """Is this an earlier key of a server that has since rotated it (it was restored on another computer)?"""
        row = self.by_box(box_id or "")
        if row is None or not row["old_hashes"]:
            return False
        h = hash_secret(secret or "")
        return any(secrets.compare_digest(h, old) for old in json.loads(row["old_hashes"]))

    def by_old_key(self, box_id: str, secret: str):
        """The name row, if this is one of its earlier keys (see moved)."""
        return self.by_box(box_id or "") if self.moved(box_id, secret) else None

    def rotate(self, name: str) -> str:
        """A new secret for a name; the old one stops working (kept, hashed, to tell its holder it moved)."""
        row = self.name(name)
        old = json.loads(row["old_hashes"] or "[]")
        old = (old + [row["secret_hash"]])[-5:]
        secret = secrets.token_urlsafe(32)
        self.c.execute("UPDATE names SET secret_hash=?, old_hashes=? WHERE name=?",
                       (hash_secret(secret), json.dumps(old), name))
        return secret

    def notice_all(self, text: str, level: str = "info") -> int:
        """The same notice for every active server's owner (outages, planned work, important news)."""
        now = time.time()
        names = [r["name"] for r in self.c.execute("SELECT name FROM names WHERE status='active'")]
        self.c.executemany("INSERT INTO notices(name,ts,level,text) VALUES(?,?,?,?)", [(n, now, level, text) for n in names])
        return len(names)

    def create(self, name: str, ip: str, code: str | None) -> tuple[str, str]:
        box_id, secret = secrets.token_hex(12), secrets.token_urlsafe(32)
        now = time.time()
        self.c.execute("INSERT INTO names(name,status,box_id,secret_hash,created,created_ip,last_seen) "
                       "VALUES(?,?,?,?,?,?,?)", (name, "active", box_id, hash_secret(secret), now, canon_ip(ip), now))
        return box_id, secret

    def set(self, name: str, **fields):
        cols = ", ".join(f"{k}=?" for k in fields)
        self.c.execute(f"UPDATE names SET {cols} WHERE name=?", (*fields.values(), name))

    def names(self, status: str | None = None):
        if status:
            return self.c.execute("SELECT * FROM names WHERE status=? ORDER BY name", (status,)).fetchall()
        return self.c.execute("SELECT * FROM names ORDER BY name").fetchall()

    def live_for_ip(self, ip: str) -> int:
        """Active names registered from exactly this address (in any spelling, rows stored before canon_ip included).
        Not per /64: hosting providers hand each customer one address out of a shared /64 (review of 116d103, #7)."""
        return self._from_caller("SELECT created_ip FROM names WHERE status='active'", [], "created_ip", ip, per="address")

    def _from_caller(self, q: str, args: list, col: str, ip: str, per: str = "address") -> int:
        """How many rows of `q` came from the caller `ip`. per="address": exactly that address, in any spelling (an
        IPv4 one also as an older ::ffff: row). per="net": an IPv6 caller's whole /64 (burst limits: rotating addresses
        inside it buys nothing). Not an address: that exact string."""
        net = caller_net(ip)
        if net is None:
            return len(self.c.execute(f"{q} AND {col}=?", (*args, ip)).fetchall())
        canon = canon_ip(ip)
        if net.version == 4 or per == "address":
            rows = self.c.execute(f"{q} AND ({col}=? OR {col} LIKE '%:%')", (*args, canon))
            return sum(1 for r in rows if r[0] == canon or canon_ip(r[0]) == canon)
        rows = self.c.execute(f"{q} AND {col} LIKE '%:%'", args)  # the caller's whole /64 (few rows: rate-limited kinds)
        return sum(1 for r in rows if _same_caller(net, r[0]))

    def new_since(self, ts: float) -> int:
        return self.c.execute("SELECT COUNT(*) FROM names WHERE created>=?", (ts,)).fetchone()[0]

    # ---- codes ----
    def new_code(self, max_uses: int = 1, days: float | None = 30, note: str = "") -> str:
        code = "TN-" + "-".join("".join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(2))
        now = time.time()
        self.c.execute("INSERT INTO codes(code,created,expires,max_uses,note) VALUES(?,?,?,?,?)",
                       (code, now, now + days * 86400 if days else None, max_uses, note))
        return code

    def code(self, code: str):
        return self.c.execute("SELECT * FROM codes WHERE code=?", ((code or "").strip().upper(),)).fetchone()

    def code_ok(self, code: str) -> bool:
        row = self.code(code)
        return bool(row) and not row["revoked"] and row["uses"] < row["max_uses"] and \
            (row["expires"] is None or row["expires"] > time.time())

    def use_code(self, code: str):
        self.c.execute("UPDATE codes SET uses=uses+1 WHERE code=?", (code.strip().upper(),))

    def codes(self):
        return self.c.execute("SELECT * FROM codes ORDER BY created DESC").fetchall()

    def revoke_code(self, code: str) -> bool:
        return self.c.execute("UPDATE codes SET revoked=1 WHERE code=?", (code.strip().upper(),)).rowcount > 0

    # ---- notices for a box's owner (shown on their dashboard) ----
    def notice(self, name: str, text: str, level: str = "info"):
        self.c.execute("INSERT INTO notices(name,ts,level,text) VALUES(?,?,?,?)", (name, time.time(), level, text))

    def take_notices(self, name: str) -> list[dict]:
        rows = self.c.execute("SELECT id,ts,level,text FROM notices WHERE name=? AND delivered=0 ORDER BY ts",
                              (name,)).fetchall()
        if rows:
            self.c.execute("UPDATE notices SET delivered=1 WHERE name=? AND delivered=0", (name,))
        return [dict(r) for r in rows]

    # ---- audit log ----
    def event(self, kind: str, name: str | None = None, ip: str | None = None, detail: str = ""):
        self.c.execute("INSERT INTO events(ts,name,kind,ip,detail) VALUES(?,?,?,?,?)",
                       (time.time(), name, kind, canon_ip(ip), detail[:500]))

    def count(self, kind: str, since: float, name: str | None = None, ip: str | None = None, per: str = "address") -> int:
        """Events of `kind` since `since`, for a name and/or a caller (per="address": exactly that address; per="net":
        an IPv6 caller's /64, for burst limits)."""
        q, args = "SELECT COUNT(*) FROM events WHERE kind=? AND ts>=?", [kind, since]
        if name is not None:
            q += " AND name=?"
            args.append(name)
        if ip is not None:
            return self._from_caller(q.replace("SELECT COUNT(*)", "SELECT ip"), args, "ip", ip, per=per)
        return self.c.execute(q, args).fetchone()[0]

    def events(self, name: str | None = None, limit: int = 200):
        if name:
            return self.c.execute("SELECT * FROM events WHERE name=? ORDER BY ts DESC LIMIT ?", (name, limit)).fetchall()
        return self.c.execute("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()

    def prune(self, days: float):
        cut = time.time() - days * 86400
        self.c.execute("DELETE FROM events WHERE ts<?", (cut,))
        self.c.execute("DELETE FROM notices WHERE delivered=1 AND ts<?", (cut,))

    # ---- ACME TXT values (each lives a few minutes; at most two at once, for base + wildcard style orders) ----
    def add_txt(self, name: str, value: str) -> list[str]:
        self.c.execute("INSERT INTO txt(name,value,ts) VALUES(?,?,?)", (name, value, time.time()))
        rows = self.c.execute("SELECT rowid,value FROM txt WHERE name=? ORDER BY ts DESC", (name,)).fetchall()
        for r in rows[2:]:
            self.c.execute("DELETE FROM txt WHERE rowid=?", (r["rowid"],))
        return [r["value"] for r in rows[:2]]

    def expire_txt(self, lifetime: float) -> list[str]:
        """Drop old values; return the names whose TXT set changed."""
        cut = time.time() - lifetime
        names = [r[0] for r in self.c.execute("SELECT DISTINCT name FROM txt WHERE ts<?", (cut,)).fetchall()]
        self.c.execute("DELETE FROM txt WHERE ts<?", (cut,))
        return names

    def txt_values(self, name: str) -> list[str]:
        return [r[0] for r in self.c.execute("SELECT value FROM txt WHERE name=? ORDER BY ts DESC", (name,))]

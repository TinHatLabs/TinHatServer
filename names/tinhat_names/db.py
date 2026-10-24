"""SQLite storage for the names service: names, names codes, notices for owners, the audit log, live ACME TXT values.

Small and synchronous on purpose: every call is a few rows, far below a millisecond, so handlers call it directly.
"""
import hashlib
import json
import secrets
import sqlite3
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


class DB:
    def __init__(self, path: str):
        self.c = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.executescript(SCHEMA)
        self._migrate()

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
                       "VALUES(?,?,?,?,?,?,?)", (name, "active", box_id, hash_secret(secret), now, ip, now))
        return box_id, secret

    def set(self, name: str, **fields):
        cols = ", ".join(f"{k}=?" for k in fields)
        self.c.execute(f"UPDATE names SET {cols} WHERE name=?", (*fields.values(), name))

    def names(self, status: str | None = None):
        if status:
            return self.c.execute("SELECT * FROM names WHERE status=? ORDER BY name", (status,)).fetchall()
        return self.c.execute("SELECT * FROM names ORDER BY name").fetchall()

    def live_for_ip(self, ip: str) -> int:
        return self.c.execute("SELECT COUNT(*) FROM names WHERE status='active' AND created_ip=?", (ip,)).fetchone()[0]

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
                       (time.time(), name, kind, ip, detail[:500]))

    def count(self, kind: str, since: float, name: str | None = None, ip: str | None = None) -> int:
        q, args = "SELECT COUNT(*) FROM events WHERE kind=? AND ts>=?", [kind, since]
        if name is not None:
            q += " AND name=?"
            args.append(name)
        if ip is not None:
            q += " AND ip=?"
            args.append(ip)
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

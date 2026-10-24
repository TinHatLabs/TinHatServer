"""Tin Hat Relay places, kept in the names service's database (database level only; relay_api.py does the network).

A relay is one machine with a public address that carries traffic for servers behind carrier NAT. A place is one
server's seat on it: a tunnel address, one port number (TCP and UDP, for calls), the server's WireGuard public key, and
this month's traffic against its allowance (docs/RELAY.md).

Place states, and what the relay carries for each:
    active        HTTPS by name + calls
    calls-paused  over this month's allowance: HTTPS only (chat keeps working, calls through the relay stop)
    paused        twice the allowance: nothing, until the 1st of next month
    suspended     by the Tin Hat team (relay suspend): nothing, until they lift it
A new month starts every place's count at zero and lifts calls-paused / paused.
"""
import ipaddress
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS relays (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,                  -- its control API, https://relay1.tinhat.dev:8443
    token_file TEXT NOT NULL,           -- its bearer token (a root-only file on this machine)
    cert_file TEXT NOT NULL,            -- its self-signed certificate, pinned
    public_ip TEXT NOT NULL,            -- names point here while relayed; friends connect here
    wg_endpoint TEXT NOT NULL,          -- host:port the home servers dial
    wg_public_key TEXT NOT NULL,
    tunnel_net TEXT NOT NULL,           -- the relay is its first address
    tunnel_ip TEXT NOT NULL,
    port_first INTEGER NOT NULL,
    port_last INTEGER NOT NULL,
    capacity INTEGER NOT NULL,          -- most places on it
    status TEXT NOT NULL DEFAULT 'active',  -- active | draining (keeps its places, takes no new ones)
    created REAL NOT NULL,
    last_sync REAL,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS relay_places (
    name TEXT PRIMARY KEY,
    relay_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    tunnel_ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    reason TEXT,
    quota_bytes INTEGER,                -- NULL = the service's default allowance
    month TEXT NOT NULL,                -- 'YYYY-MM' (UTC) that bytes_month belongs to
    bytes_month INTEGER NOT NULL DEFAULT 0,
    last_total INTEGER NOT NULL DEFAULT 0,  -- the relay's running total at the last sync
    warned INTEGER NOT NULL DEFAULT 0,  -- the 80 % notice went out this month
    home_ip TEXT,                       -- the server's own public address, as last seen
    created REAL NOT NULL,
    updated REAL NOT NULL,
    UNIQUE (relay_id, tunnel_ip),
    UNIQUE (relay_id, port)
);
-- What outlives a place: turning the relay off and on again must not reset this month's count, a custom allowance or a
-- suspension by the Tin Hat team.
CREATE TABLE IF NOT EXISTS relay_memory (
    name TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    bytes_month INTEGER NOT NULL DEFAULT 0,
    warned INTEGER NOT NULL DEFAULT 0,
    quota_bytes INTEGER,
    suspended_reason TEXT
);
"""

GB = 1000 ** 3
QUOTA_STATES = ("calls-paused", "paused")


def month_of(ts: float | None = None) -> str:
    return time.strftime("%Y-%m", time.gmtime(time.time() if ts is None else ts))


def next_month_name(ts: float | None = None) -> str:
    """'1 November' — when this month's allowance starts again."""
    t = time.gmtime(time.time() if ts is None else ts)
    y, m = (t.tm_year + 1, 1) if t.tm_mon == 12 else (t.tm_year, t.tm_mon + 1)
    return f"1 {time.strftime('%B', time.strptime(f'{y}-{m:02d}-01', '%Y-%m-%d'))}"


class Full(Exception):
    """No relay has room for another server."""


def web_calls(status: str) -> tuple[bool, bool]:
    return {"active": (True, True), "calls-paused": (True, False)}.get(status, (False, False))


class RelayStore:
    def __init__(self, conn):
        self.c = conn
        self.c.executescript(SCHEMA)

    # ---- relays ----
    def add_relay(self, rid: str, url: str, token_file: str, cert_file: str, info: dict, capacity: int | None = None):
        """info = the relay's own GET /v1/status answer."""
        cap = int(capacity or info["capacity"])
        first, last = info["ports"]
        self.c.execute(
            "INSERT INTO relays(id,url,token_file,cert_file,public_ip,wg_endpoint,wg_public_key,tunnel_net,tunnel_ip,"
            "port_first,port_last,capacity,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET url=excluded.url, token_file=excluded.token_file, cert_file=excluded.cert_file,"
            " public_ip=excluded.public_ip, wg_endpoint=excluded.wg_endpoint, wg_public_key=excluded.wg_public_key,"
            " tunnel_net=excluded.tunnel_net, tunnel_ip=excluded.tunnel_ip, port_first=excluded.port_first,"
            " port_last=excluded.port_last, capacity=excluded.capacity",
            (rid, url, token_file, cert_file, info["public_ip"], info["wg"]["endpoint"], info["wg"]["public_key"],
             info["tunnel_net"], info["tunnel_ip"], int(first), int(last), cap, time.time()))

    def relay(self, rid: str):
        return self.c.execute("SELECT * FROM relays WHERE id=?", (rid,)).fetchone()

    def relays(self):
        return self.c.execute("SELECT * FROM relays ORDER BY id").fetchall()

    def set_relay(self, rid: str, **fields):
        cols = ", ".join(f"{k}=?" for k in fields)
        self.c.execute(f"UPDATE relays SET {cols} WHERE id=?", (*fields.values(), rid))

    def load(self, rid: str) -> int:
        return self.c.execute("SELECT COUNT(*) FROM relay_places WHERE relay_id=?", (rid,)).fetchone()[0]

    def pick(self):
        """The least busy relay that takes new places, or None when all are full."""
        rows = [r for r in self.c.execute("SELECT * FROM relays WHERE status='active' ORDER BY id").fetchall()
                if self.load(r["id"]) < r["capacity"]]
        return min(rows, key=lambda r: self.load(r["id"]), default=None)

    # ---- places ----
    def place(self, name: str):
        return self.c.execute("SELECT * FROM relay_places WHERE name=?", (name,)).fetchone()

    def places(self, relay_id: str | None = None):
        if relay_id:
            return self.c.execute("SELECT * FROM relay_places WHERE relay_id=? ORDER BY port", (relay_id,)).fetchall()
        return self.c.execute("SELECT * FROM relay_places ORDER BY relay_id, port").fetchall()

    def _free(self, relay) -> tuple[str, int]:
        used = self.c.execute("SELECT tunnel_ip, port FROM relay_places WHERE relay_id=?", (relay["id"],)).fetchall()
        ips, ports = {r["tunnel_ip"] for r in used}, {r["port"] for r in used}
        ip = next((str(a) for a in ipaddress.IPv4Network(relay["tunnel_net"]).hosts()
                   if str(a) != relay["tunnel_ip"] and str(a) not in ips), None)
        port = next((p for p in range(relay["port_first"], relay["port_last"] + 1) if p not in ports), None)
        if ip is None or port is None:
            raise Full(relay["id"])
        return ip, port

    def create_place(self, name: str, public_key: str, home_ip: str | None, now: float | None = None):
        """A seat on the least busy relay: a free tunnel address and port. Raises Full."""
        relay = self.pick()
        if relay is None:
            raise Full("all relays")
        ip, port = self._free(relay)
        now = time.time() if now is None else now
        m = month_of(now)
        self.c.execute("INSERT INTO relay_places(name,relay_id,public_key,tunnel_ip,port,month,home_ip,created,updated) "
                       "VALUES(?,?,?,?,?,?,?,?,?)", (name, relay["id"], public_key, ip, port, m, home_ip, now, now))
        mem = self.c.execute("SELECT * FROM relay_memory WHERE name=?", (name,)).fetchone()
        if mem is not None:  # it had a place before: same count this month, same allowance, same suspension
            fields = {"quota_bytes": mem["quota_bytes"]}
            if mem["month"] == m:
                fields.update(bytes_month=mem["bytes_month"], warned=mem["warned"])
            if mem["suspended_reason"]:
                fields.update(status="suspended", reason=mem["suspended_reason"])
            self.set_place(name, **fields)
        return self.place(name)

    def set_place(self, name: str, **fields):
        fields["updated"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        self.c.execute(f"UPDATE relay_places SET {cols} WHERE name=?", (*fields.values(), name))

    def remove_place(self, name: str):
        p = self.place(name)
        if p is not None:
            self.c.execute("INSERT OR REPLACE INTO relay_memory(name,month,bytes_month,warned,quota_bytes,suspended_reason) "
                           "VALUES(?,?,?,?,?,?)", (name, p["month"], p["bytes_month"], p["warned"], p["quota_bytes"],
                                                   p["reason"] if p["status"] == "suspended" else None))
        self.c.execute("DELETE FROM relay_places WHERE name=?", (name,))

    def idle(self, seen_before: float) -> list:
        """Places whose server hasn't checked in since `seen_before` (or whose name is gone): their seats can go back.
        A server that returns asks for a place again by itself (relay.py on the box)."""
        return self.c.execute(
            "SELECT rp.name, rp.relay_id FROM relay_places rp LEFT JOIN names n ON n.name = rp.name "
            "WHERE n.name IS NULL OR n.status = 'retired' OR COALESCE(n.last_seen, 0) < ?", (seen_before,)).fetchall()

    def remember_suspension(self, name: str, reason: str | None) -> None:
        """Suspend (reason) or lift (None) for a server that has no place right now; applies when it asks again."""
        self.c.execute("INSERT INTO relay_memory(name, month, suspended_reason) VALUES(?,?,?) "
                       "ON CONFLICT(name) DO UPDATE SET suspended_reason=excluded.suspended_reason",
                       (name, month_of(), reason))

    def desired(self, relay_id: str, zone: str) -> list[dict]:
        """What the relay should carry, in its control API's shape."""
        out = []
        for p in self.places(relay_id):
            web, calls = web_calls(p["status"])
            out.append({"name": p["name"], "fqdn": f"{p['name']}.{zone}", "public_key": p["public_key"],
                        "tunnel_ip": p["tunnel_ip"], "port": p["port"], "web": web, "calls": calls})
        return out

    # ---- allowance ----
    @staticmethod
    def quota(p, default_bytes: int) -> int:
        return int(p["quota_bytes"]) if p["quota_bytes"] is not None else int(default_bytes)

    @staticmethod
    def quota_state(used: int, quota: int, status: str) -> str:
        """The state a place should be in for this month's use (never changes 'suspended')."""
        if status == "suspended":
            return status
        if quota > 0 and used >= 2 * quota:
            return "paused"
        if quota > 0 and used >= quota:
            return "calls-paused"
        return "active"

    def record_usage(self, name: str, total: int, default_quota: int, warn_at: float = 0.8,
                     now: float | None = None) -> list[str]:
        """The relay's running total for this place is now `total`: add what's new to this month's count and move the
        place between states. Returns what the owner should hear about: warn | calls-paused | paused | back."""
        p = self.place(name)
        if p is None:
            return []
        events = self._rollover_one(p, now)
        p = self.place(name)
        total = int(total)
        new = total - p["last_total"] if total >= p["last_total"] else total  # a smaller total: the relay started over
        used = p["bytes_month"] + max(0, new)
        q = self.quota(p, default_quota)
        state = self.quota_state(used, q, p["status"])
        fields = {"bytes_month": used, "last_total": total}
        if state != p["status"]:
            fields["status"] = state
            fields["reason"] = "quota" if state in QUOTA_STATES else None
            events.append(state if state in QUOTA_STATES else "back")
        if not p["warned"] and q > 0 and used >= warn_at * q:
            fields["warned"] = 1
            if state == "active":
                events.append("warn")
        self.set_place(name, **fields)
        return events

    def _rollover_one(self, p, now: float | None = None) -> list[str]:
        m = month_of(now)
        if p["month"] == m:
            return []
        fields = {"month": m, "bytes_month": 0, "warned": 0}
        events = []
        if p["status"] in QUOTA_STATES:
            fields.update(status="active", reason=None)
            events.append("back")
        self.set_place(p["name"], **fields)
        return events

    def rollover(self, now: float | None = None) -> dict:
        """A new month: every count starts at zero and the allowance pauses end. {name: events}."""
        out = {}
        for p in self.places():
            ev = self._rollover_one(p, now)
            if ev:
                out[p["name"]] = ev
        return out

    def recheck_quota(self, name: str, default_quota: int) -> list[str]:
        """After the allowance changed: the state that fits this month's use now."""
        p = self.place(name)
        if p is None:
            return []
        state = self.quota_state(p["bytes_month"], self.quota(p, default_quota), p["status"])
        if state == p["status"]:
            return []
        self.set_place(name, status=state, reason="quota" if state in QUOTA_STATES else None)
        return [state if state in QUOTA_STATES else "back"]

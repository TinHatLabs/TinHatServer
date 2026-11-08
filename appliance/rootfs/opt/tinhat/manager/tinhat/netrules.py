"""The owner's deny-list: servers this one refuses (docs/NETWORK-RULES.md; share design MATRIX-FRONTEND-DESIGN.md A4).

state.json `blocked_servers`: [{server, since, by, reason}] (lower-case names; written by Federation.block/unblock
only). Active in every mode that federates, so blocking a server that is allowed by name or connected by code means
something before the open Matrix network exists:
  - Synapse: the server is taken off the federation allow-list (templates.homeserver_yaml), its media is never
    downloaded (`prevent_media_downloads_from`), and tinhat_network.NetworkRules refuses its invites;
  - Caddy: a federation request whose X-Matrix origin claims a blocked server gets 403 before Synapse works
    (templates.with_fed_deny; an optimisation: a forged claim only hurts the forger, and Caddy's parse is never used
    for anything but this refusal);
  - the apps: GET /api/network lists it in `blocked` (they hide its people like ignored users), and a blocked server
    is never "connected" for them.
Unblocking removes it from all of those. The lists of connected servers and servers allowed by name are kept as they
were, so Unblock brings back exactly what was there.
"""
import json
import logging
import sqlite3
import time

from . import apiconf, config, owndomain, state

log = logging.getLogger("tinhat.netrules")

MAX_BLOCKED = 500
MAX_REASON = 200
RULES_FILE = "network-rules.json"  # next to the Synapse modules (read live by tinhat_network)
DB_FILE = "tinhat-network.db"      # in Synapse's data folder (written by tinhat_network; read here for the dashboard)
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".internal", ".localhost", ".home.arpa", ".localdomain")


def normalize_block(server: str, own: str = "") -> tuple[str | None, str | None]:
    """A server's name as the owner may type it to block it ('example.org', 'https://example.org/', '@sam:example.org',
    a Tin Hat server's full name too) -> (lower-case name, None), or (None, why not)."""
    s = (server or "").strip()
    if len(s) > 300:
        return None, "That name is too long."
    if s.startswith("@") and ":" in s:
        s = s.split(":", 1)[1]
    for scheme in ("https://", "http://"):
        if s[:len(scheme)].lower() == scheme:
            s = s[len(scheme):]
    s = s.split("/")[0].rstrip(".")
    low = s.lower()
    if not low:
        return None, "Type the other server's name, like example.org."
    if ":" in low:
        return None, "Leave out the port: type just the server's name, like example.org."
    if not low.isascii() or not owndomain.HOST_RE.match(low) or low.endswith(LOCAL_SUFFIXES):
        return None, ("Use the server's name as it appears after the colon in people's Matrix IDs, like example.org: "
                      "not an address or a home-network name.")
    if own and low == own.lower().rstrip("."):
        return None, "That's this server."
    return low, None


def entries(st: dict | None = None) -> list[dict]:
    """The blocked servers, well-formed entries only (a hand-edited or damaged list never breaks the dashboard)."""
    st = st if st is not None else state.load_state()
    out, seen = [], set()
    for e in st.get("blocked_servers") or []:
        if not isinstance(e, dict) or not isinstance(e.get("server"), str):
            continue
        name, _ = normalize_block(e["server"])
        if name and name not in seen:
            seen.add(name)
            out.append({**e, "server": name})
    return out


def names(st: dict | None = None) -> list[str]:
    return sorted(e["server"] for e in entries(st))


def without_blocked(servers, blocked) -> list[str]:
    """servers minus the blocked ones (compared without regard to case or a trailing dot), in their own spelling."""
    b = {str(x).lower().rstrip(".") for x in blocked or []}
    return sorted({s for s in servers or [] if isinstance(s, str) and s.lower().rstrip(".") not in b})


def publish_rules(st: dict | None = None) -> bool:
    """network-rules.json next to the Synapse modules: the deny-list tinhat_network reads live (it also has the list
    from homeserver.yaml, so a missing file never unblocks anyone). True when it changed."""
    st = st if st is not None else state.load_state()
    apiconf.MODULES_DIR.mkdir(parents=True, exist_ok=True)
    path = apiconf.MODULES_DIR / RULES_FILE
    text = json.dumps({"v": 1, "blocked": names(st)}, sort_keys=True) + "\n"
    try:
        if path.read_text() == text and path.stat().st_mode & 0o777 == 0o644:
            return False
    except OSError:
        pass
    state.write_text(path, text, 0o644)
    return True


def recent_refusals(limit: int = 20, db_path=None) -> list[dict]:
    """The latest invites tinhat_network refused ([{at, server, reason}], newest first; who they were for stays out:
    the owner sees which servers are pushy, not who gets invited). [] when there is no database yet."""
    path = db_path or (config.SYNAPSE_DIR / DB_FILE)
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)
    except sqlite3.Error:
        return []
    try:
        rows = db.execute("SELECT ts, server, outcome FROM invites WHERE outcome != 'ok' ORDER BY ts DESC LIMIT ?",
                          (max(1, min(int(limit), 100)),)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        db.close()
    return [{"at": int(ts), "server": str(srv)[:255], "reason": str(why)[:40]} for ts, srv, why in rows]


def busy_servers(hours: int = 24, db_path=None, now: float | None = None) -> list[dict]:
    """Servers by invites refused in the last `hours` ([{server, refused}], most first, at most 10)."""
    path = db_path or (config.SYNAPSE_DIR / DB_FILE)
    since = (time.time() if now is None else now) - hours * 3600
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)
    except sqlite3.Error:
        return []
    try:
        rows = db.execute("SELECT server, COUNT(*) AS n FROM invites WHERE outcome != 'ok' AND ts >= ? GROUP BY server "
                          "ORDER BY n DESC, server LIMIT 10", (since,)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        db.close()
    return [{"server": str(s)[:255], "refused": int(n)} for s, n in rows]

"""The game-servers widget, set up from the dashboard (Features & keys → Game servers): the owner's own Pelican (or
Pterodactyl) panel, a client API key, which of its servers the widget shows, the address players type and the space
whose members see it. Writes the two files the Tin Hat API reads (api/gameservers.mjs re-reads them within 5 s):
`gameservers.json` (contract: docs/GAMESERVERS.md in both app repos) and `pelican.key` (0600).

The rules here mirror gameservers.mjs's parseConfig, so the dashboard never saves a file the API would refuse; the
API's own test parses what this writes (api/tinhat-api/test/gameservers-dashboard.test.mjs). Settings the card doesn't
show (cap, memoryBudgetMB, hostCores, test, a server's steamAppId/emoji/label/calendar…) are kept as they were, so a
file someone wrote by hand keeps working when the card saves it.
"""
import json
import logging
import re
from urllib.parse import urlsplit

import aiohttp

from . import apiconf, environment, state

log = logging.getLogger("tinhat.gameservers")

CONFIG = apiconf.DIR / "gameservers.json"
KEY = apiconf.DIR / "pelican.key"
# The API's KINDS (gameservers.mjs): the one panel variable that is the join password, and whether players are read
# from the console. "other": any other game (no password variable, no player list).
KINDS = {"valheim": "Valheim", "pz": "Project Zomboid", "minecraft": "Minecraft", "palworld": "Palworld",
         "abiotic": "Abiotic Factor", "satisfactory": "Satisfactory", "other": "Another game"}
PASSWORD_VAR = {"valheim": True, "palworld": True, "abiotic": True}  # kinds whose join password is a panel variable
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
ROOM_RE = re.compile(r"^![A-Za-z0-9._~=+/-]{1,255}(?::[A-Za-z0-9.-]{1,255}(?::\d{1,5})?)?\Z")
ORIGIN_RE = re.compile(r"^(?:https?|wss?)://[A-Za-z0-9.-]+(?::\d{1,5})?\Z")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}\Z")
KEY_RE = re.compile(r"^[A-Za-z0-9_]{16,128}\Z")  # Pelican: pacc_…/ptlc_… (client keys); no spaces, quotes or line breaks
UNSAFE_TEXT = re.compile("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]")  # = reachcommon.mjs


class GameServersError(Exception):
    pass


def configured() -> bool:
    return CONFIG.exists() and KEY.exists()


def _load() -> dict:
    try:
        c = json.loads(CONFIG.read_text())
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def origin_of(url: str) -> str | None:
    """scheme://host[:port] of a URL, or None when it isn't one the API accepts (gameservers.mjs: ≤ 200 characters)."""
    try:
        u = urlsplit(str(url or "").strip())
        port = u.port  # raises for a port out of range
    except ValueError:
        return None
    if u.scheme not in ("http", "https", "ws", "wss") or not u.hostname:
        return None
    o = f"{u.scheme}://{u.hostname}" + (f":{port}" if port else "")
    return o if ORIGIN_RE.match(o) and len(o) <= 200 else None


def u16(s: str) -> int:
    """A string's length the way JavaScript counts it (UTF-16 code units): the API's limits are in those."""
    return len(s.encode("utf-16-le")) // 2


def saved_key_for(base: str) -> str | None:
    """The saved key, only for the panel it was saved with: it is never sent to another address."""
    panel = _load().get("panel") or {}
    if not KEY.exists() or origin_of(panel.get("url") or "") != base:
        return None
    try:
        return KEY.read_text().strip() or None
    except OSError:
        return None


def guess_kind(*words: str | None) -> str:
    """The widget's kind from what the panel says about a server (its name, egg, docker image)."""
    t = " ".join(w for w in words if w).lower()
    for kind, needles in (("valheim", ("valheim",)), ("pz", ("zomboid",)), ("palworld", ("palworld",)),
                          ("abiotic", ("abiotic",)), ("satisfactory", ("satisfactory",)),
                          ("minecraft", ("minecraft", "paper", "spigot", "forge", "fabric", "purpur", "bungee", "velocity"))):
        if any(n in t for n in needles):
            return kind
    return "other"


def doc() -> dict:
    """The card's view: what is set (never the key)."""
    c = _load()
    panel = c.get("panel") if isinstance(c.get("panel"), dict) else {}
    servers = [{k: s.get(k) for k in ("uuid", "kind", "game", "label", "info", "outside", "joinPasswordText")}
               for s in c.get("servers") or [] if isinstance(s, dict)]
    return {"configured": configured(), "keySet": KEY.exists(), "url": panel.get("url") or "",
            "wings": panel.get("wings") or "", "origin": panel.get("origin") or "", "joinHost": c.get("joinHost") or "",
            "space": c.get("space") or "", "announceRoom": c.get("announceRoom") or "", "servers": servers,
            "testOverrides": len(c.get("test") or []) if isinstance(c.get("test"), list) else 0,
            "kinds": KINDS, "passwordVarKinds": sorted(PASSWORD_VAR)}


async def _panel_get(url: str, key: str, path: str) -> dict:
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
            async with s.get(url + path, headers=headers, allow_redirects=False, ssl=environment.ssl_context()) as r:
                if r.status in (401, 403):
                    raise GameServersError("The panel refused that key. Use a client API key (Account → API "
                                           "Credentials) of a user who can see the servers, allowed from this server's address.")
                if r.status != 200:
                    raise GameServersError(f"The panel answered {r.status} at {url}. Is that the panel's address?")
                body = await r.json(content_type=None)
    except GameServersError:
        raise
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError) as e:
        raise GameServersError(f"Couldn't reach a panel at {url} ({type(e).__name__}).") from e
    if not isinstance(body, dict):
        raise GameServersError("That address answered, but not like a Pelican or Pterodactyl panel.")
    return body


async def discover(url: str, key: str | None) -> dict:
    """Ask the panel which servers the key can see (and where its Wings websocket is). key None = the saved one."""
    base = origin_of(url)
    if not base or base.split("://")[0] not in ("http", "https"):
        raise GameServersError("Type the panel's address, like https://panel.example.com or http://192.168.1.20.")
    if key is None:
        key = saved_key_for(base)
        if key is None:
            raise GameServersError("Paste the panel's API key (a saved key is only ever used with the panel it was "
                                   "saved for).")
    key = str(key).strip()
    if not KEY_RE.match(key):
        raise GameServersError("That doesn't look like a panel API key (letters, digits and _ only).")
    body = await _panel_get(base, key, "/api/client?per_page=100&include=egg")
    items = list(body.get("data") or [])
    pages = min(int(((body.get("meta") or {}).get("pagination") or {}).get("total_pages") or 1), 10)
    for page in range(2, pages + 1):
        items += (await _panel_get(base, key, f"/api/client?per_page=100&include=egg&page={page}")).get("data") or []
    servers, wings = [], ""
    for item in items:
        a = (item or {}).get("attributes") if isinstance(item, dict) else None
        if not isinstance(a, dict) or not isinstance(a.get("uuid"), str) or not UUID_RE.match(a["uuid"]):
            continue
        egg = (((a.get("relationships") or {}).get("egg") or {}).get("attributes") or {}).get("name")
        allocs = [x.get("attributes") or {} for x in ((a.get("relationships") or {}).get("allocations") or {}).get("data") or []
                  if isinstance(x, dict)]
        main = next((x for x in allocs if x.get("is_default")), allocs[0] if allocs else {})
        name = str(a.get("name") or a.get("identifier") or "")[:64]
        servers.append({"uuid": a["uuid"], "identifier": a.get("identifier"), "name": name, "egg": egg or "",
                        "kind": guess_kind(name, egg, a.get("docker_image")),
                        "address": (main.get("ip_alias") or main.get("ip") or ""), "port": main.get("port")})
    if not servers:
        raise GameServersError("The panel answered, but that key sees no servers. Give its user access to them "
                               "(a subuser on each server: Control → start/stop/restart/console, Startup → read).")
    # Where each server's Wings websocket is (a websocket ticket per server: its node). The widget talks to ONE node
    # (one Wings address), so the card lets the owner pick servers of one node only.
    for s in servers[:32]:
        try:
            ws = await _panel_get(base, key, f"/api/client/servers/{s['identifier']}/websocket")
            s["node"] = origin_of(((ws.get("data") or {}).get("socket")) or "") or ""
        except GameServersError as e:
            log.info("no websocket ticket for %s: %s", s["identifier"], e)
            s["node"] = ""
    for s in servers[32:]:
        s["node"] = ""
    wings = next((s["node"] for s in servers if s.get("node")), "")
    return {"url": base, "wings": wings, "origin": base, "servers": servers}


def build(body: dict, existing: dict | None = None) -> dict:
    """The config the card saves, merged into what's there; raises GameServersError with the first problem. The result
    is checked against the API's own rules (check_api) before anything is written."""
    old = existing if existing is not None else _load()
    url, wings = origin_of(body.get("url") or ""), origin_of(body.get("wings") or "")
    if not url or url.split("://")[0] not in ("http", "https"):
        raise GameServersError("The panel's address: like https://panel.example.com.")
    if not wings:
        raise GameServersError("The panel's Wings websocket: like wss://node.example.com:8080 (Connect fills it in).")
    origin = url
    if str(body.get("origin") or "").strip():
        origin = origin_of(body["origin"])
        if not origin:
            raise GameServersError("The panel's public address: like https://panel.example.com (or leave it empty).")
    join = str(body.get("joinHost") or "").strip().lower()
    if not HOST_RE.match(join):
        raise GameServersError("The address players type, like games.example.com (no port: each server adds its own).")
    space = str(body.get("space") or "").strip()
    if not ROOM_RE.match(space):
        raise GameServersError("Choose the space whose members see the game servers.")
    announce = str(body.get("announceRoom") or "").strip() or None
    if announce and not ROOM_RE.match(announce):
        raise GameServersError("The room for announcements must be a room id (or empty).")
    old_by = {s.get("uuid"): s for s in old.get("servers") or [] if isinstance(s, dict)}
    picked, seen = [], set()
    for s in body.get("servers") or []:
        if not isinstance(s, dict):
            continue
        uuid = str(s.get("uuid") or "")
        if not UUID_RE.match(uuid) or uuid in seen:
            raise GameServersError("A server without a valid id, or listed twice.")
        seen.add(uuid)
        kind = s.get("kind") if s.get("kind") in KINDS else "other"
        game = str(s.get("game") or "").strip()
        if not game or u16(game) > 64 or UNSAFE_TEXT.search(game):
            raise GameServersError("Each server needs its game's name (up to 64 characters).")
        info = str(s.get("info") or "").strip()
        if u16(info) > 280 or UNSAFE_TEXT.search(info):
            raise GameServersError(f"The note for {game} is plain text, up to 280 characters.")
        pw = s.get("joinPasswordText")
        pw = pw if isinstance(pw, str) else ""  # exactly as typed: spaces can be part of a password
        if pw and (kind in PASSWORD_VAR or u16(pw) > 64 or UNSAFE_TEXT.search(pw)):
            raise GameServersError(f"The join password for {game}: only for games whose password isn't a panel setting "
                                   "(up to 64 characters).")
        entry = dict(old_by.get(uuid) or {})  # keep what the card doesn't show (checked below like the rest)
        entry.update({"uuid": uuid, "kind": kind, "game": game, "info": info, "outside": s.get("outside") is True})
        if pw:
            entry["joinPasswordText"] = pw
        else:
            entry.pop("joinPasswordText", None)
        picked.append(entry)
    if not 1 <= len(picked) <= 32:
        raise GameServersError("Pick between 1 and 32 servers.")
    out = {k: v for k, v in old.items() if k not in ("v", "space", "announceRoom", "joinHost", "panel", "servers", "test")}
    # Test overrides (a hand-written file's "these people see another space") only survive while the space stays the
    # same: a new "Who sees them" must not leave anyone else with access.
    if isinstance(old.get("test"), list) and old.get("space") == space:
        out["test"] = old["test"]
    out.update({"v": 1, "space": space, "announceRoom": announce, "joinHost": join,
                "panel": {"url": url, "wings": wings, "origin": origin}, "servers": picked})
    check_api(out)
    return out


MXID_RE = re.compile(r"^@[^:\s]{1,255}:[A-Za-z0-9.-]{1,255}(?::\d{1,5})?\Z")


def check_api(c: dict) -> None:
    """gameservers.mjs parseConfig, rule for rule (lengths in UTF-16 units, as JavaScript counts): what the card writes
    is never a file the API refuses (it would keep its previous one while the dashboard shows the new)."""
    def bad(what):
        raise GameServersError(f"This setting can't be saved: {what}.")
    if c.get("v") != 1 or not isinstance(c.get("space"), str) or not ROOM_RE.match(c["space"]):
        bad("the space")
    if c.get("announceRoom") is not None and not (isinstance(c["announceRoom"], str) and ROOM_RE.match(c["announceRoom"])):
        bad("the announcements room")
    j = c.get("joinHost")
    if not isinstance(j, str) or u16(j) > 253 or not re.match(r"^[A-Za-z0-9.-]+\Z", j):
        bad("the join address")
    for k in ("url", "wings", "origin"):
        v = (c.get("panel") or {}).get(k)
        if not isinstance(v, str) or len(v) > 200 or not ORIGIN_RE.match(v):
            bad(f"the panel's {k}")
    servers = c.get("servers")
    if not isinstance(servers, list) or not 1 <= len(servers) <= 32:
        bad("1 to 32 servers")
    seen = set()
    for s in servers:
        if not isinstance(s, dict) or not isinstance(s.get("uuid"), str) or not UUID_RE.match(s["uuid"]) or s["uuid"] in seen:
            bad("a server's id")
        seen.add(s["uuid"])
        if s.get("kind") not in KINDS:
            bad("a server's game")
        g = s.get("game")
        if not isinstance(g, str) or u16(g) > 64 or not g.strip():
            bad("a game's name")
        if s.get("steamAppId") is not None and not (type(s["steamAppId"]) is int and 0 < s["steamAppId"] < 10**9):
            bad(f"the Steam app id of {g}")
        if s.get("joinPasswordText") is not None:
            pw = s["joinPasswordText"]
            if s["kind"] in PASSWORD_VAR or not isinstance(pw, str) or u16(pw) > 64 or UNSAFE_TEXT.search(pw):
                bad(f"the join password of {g}")
        info = "" if s.get("info") is None else s["info"]
        if not isinstance(info, str) or u16(info) > 280 or UNSAFE_TEXT.search(info):
            bad(f"the note of {g}")
        lab = s.get("label")
        if lab is not None and (not isinstance(lab, str) or u16(lab) > 64 or not lab.strip() or UNSAFE_TEXT.search(lab)):
            bad(f"the display name of {g} (in the file)")
        em = s.get("emoji")
        if em is not None and (not isinstance(em, str) or u16(em) > 16 or not em or UNSAFE_TEXT.search(em)):
            bad(f"the emoji of {g} (in the file)")
    test = c.get("test")
    if test is not None:
        if not isinstance(test, list) or len(test) > 8:
            bad("the test overrides (in the file)")
        for x in test:
            us = x.get("users") if isinstance(x, dict) else None
            if (not isinstance(us, list) or not 1 <= len(us) <= 16 or not all(isinstance(u, str) and MXID_RE.match(u) for u in us)
                    or not isinstance(x.get("space"), str) or not ROOM_RE.match(x["space"])
                    or (x.get("announceRoom") is not None and not (isinstance(x["announceRoom"], str) and ROOM_RE.match(x["announceRoom"])))):
                bad("a test override (in the file)")


def save(body: dict) -> dict:
    cfg = build(body)
    key = body.get("key")
    if key is not None:
        key = str(key).strip()
        if not KEY_RE.match(key):
            raise GameServersError("That doesn't look like a panel API key (letters, digits and _ only).")
    elif saved_key_for(cfg["panel"]["url"]) is None:
        raise GameServersError("Paste the panel's API key (a saved key is only ever used with the panel it was saved for).")
    apiconf.ensure_dirs()
    if key is not None:
        state.write_text(KEY, key + "\n", 0o600)
    state.write_text(CONFIG, json.dumps(cfg, indent=1, ensure_ascii=False) + "\n", 0o600)
    return doc()


def remove() -> None:
    for p in (CONFIG, KEY):
        try:
            p.unlink()
        except FileNotFoundError:
            pass

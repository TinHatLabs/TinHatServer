"""The Tin Hat API on this server (api/ in the repository): the soundboard and myinstants, GIFs, YouTube search, guest
links, Memories files, call moderation, Reach presence, web push and its gateway, game servers; and the games
catalogue. Two containers from one image (compose services `api` and `games`), on the host's network like the call
server. Everything they need lives in ONE folder, /var/lib/tinhat/api (root only), written here by the manager:

  env                     their environment (addresses, public bases, where things are); PORT differs per service
  synapse-admin.token     the box's system account (Synapse admin: guest accounts, moderation, presence, push)
  synapse.secret          Synapse's registration shared secret (guest accounts)
  livekit.secret          the call server's secret (guest call tokens, moderation)
  giphy.key, youtube.key, steam.key, steamgriddb.key
                          the owner's own API keys, pasted in the dashboard's Features card (secrets.json is the
                          source of truth; a key that is cleared is removed here)
  gameservers.json, pelican.key
                          the game-servers widget's panel and servers (docs/API.md; written by the owner for now)
  cache/ uploads/ games/ watch/ reports/ logs/
                          the services' own data: the myinstants clip cache, people's uploaded sounds, the games
                          catalogue, the YouTube cache, problem reports and shared logs (the dashboard's Reports card)
  vapid.json, push-owners.json, guests.json, guest-accounts.json, vods.secret
                          state the services keep themselves

Recordings for Memories are read from /var/lib/tinhat/vods (mounted read-only into the api container as /vods): a
folder the owner's recorder writes to; Tin Hat Server doesn't run a recorder itself.

The push gateway: Synapse delivers notifications to the gateway at the box's address on the compose project's own
network (`tinhat_backend`'s gateway, e.g. 198.18.16.1): the one address a container on that network can reach the host
at. The gateway listens there only, and Synapse's ip_range_whitelist names only that address (templates.homeserver_yaml),
so the pusher URL a device registers can't make Synapse talk to anything else on the box.
"""
import contextlib
import fcntl
import ipaddress
import json
import logging
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

from . import config, environment, state

log = logging.getLogger("tinhat.api")

DIR = config.STATE_DIR / "api"
ENV = DIR / "env"
VODS_DIR = config.STATE_DIR / "vods"
GATEWAY_PORT = 3091
API_PORT, GAMES_PORT = 3001, 3003
# secrets.json key → the file the service reads
KEY_FILES = {"giphy_key": "giphy.key", "youtube_key": "youtube.key", "steam_key": "steam.key", "sgdb_key": "steamgriddb.key"}
KEY_LABELS = {"giphy_key": "GIFs (Giphy)", "youtube_key": "YouTube search", "steam_key": "Steam library import",
              "sgdb_key": "Game cover art (SteamGridDB)"}
SUBDIRS = ["cache", "uploads", "games", "watch", "reports", "logs"]
TURN_PROTOCOLS = ("udp", "tcp", "tls")


# The owner's own numbers for the API's limits (docs/API.md "Who may use the extras"), kept in state api.limits and
# written into its environment by env_text: the env file itself is regenerated on every refresh, update and settings
# save, so an edit there never lasted (review of 116d103, #3). Only these names, each checked: "onoff" = on|off, else
# (low, high) = a whole number in that range, bounds included: digits only (no sign, decimals, exponent, inf or nan),
# so always a safe integer. Where 0 is allowed it means none (docs/API.md): nobody in that group gets any of it; the
# token-less lane itself is API_LEGACY_ANON. Set from the console: `tinhat api-limits NAME=VALUE …`.
COUNT = (0, 999_999_999)            # calls, units, sounds per hour / day: 0 = none
FILE_MB = (1, 100)                  # one file, held in memory while it is checked: at least 1 MB
STORE_MB = (0, 1_048_576)           # disk for uploads, up to 1 TB: 0 = no uploads
LIMITS = {
    "API_LEGACY_ANON": "onoff",
    # call sign-ins only for rooms the caller is in (calltoken.mjs; docs/API.md "Call sign-ins"): on unless the owner says off
    "CALL_TOKEN_ROOM_CHECK": "onoff",
    **{k: COUNT for k in (
        "API_ANON_GIF_PER_HOUR", "API_ANON_GIF_ALL_PER_HOUR", "API_ANON_SOUNDSEARCH_PER_HOUR",
        "API_ANON_SOUNDSEARCH_ALL_PER_HOUR", "API_ANON_CLIPFETCH_PER_HOUR", "API_ANON_CLIPFETCH_ALL_PER_HOUR",
        "API_USER_GIF_PER_HOUR", "API_USER_SOUNDSEARCH_PER_HOUR", "API_USER_CLIPFETCH_PER_HOUR", "API_USER_CLIPSIGN_PER_HOUR",
        "API_SEARCHED_CLIPFETCH_PER_IP_HOUR", "API_SEARCHED_CLIPFETCH_PER_HOUR",
        "WATCH_USER_UNITS_PER_DAY", "WATCH_ANON_UNITS_PER_DAY", "WATCH_ANON_ALL_UNITS_PER_DAY",
        "SOUNDBOARD_USER_UPLOADS_MAX")},
    "SOUNDBOARD_CLIP_MAX_MB": FILE_MB, "GIF_FETCH_MAX_MB": FILE_MB,
    "SOUNDBOARD_CACHE_MAX_MB": (1, 1_048_576),   # the myinstants clip cache: at least 1 MB (it always keeps one clip)
    "SOUNDBOARD_USER_UPLOADS_MB": STORE_MB, "SOUNDBOARD_UPLOADS_TOTAL_MB": STORE_MB,
    "SOUNDBOARD_CLIP_LINK_MIN": (1, 10_080),      # a signed clip link lives 1 minute to a week
}


def limit_value(name: str, value) -> str | None:
    """The value as it goes into the env file, or None when the name isn't one of LIMITS or the value doesn't fit."""
    kind = LIMITS.get(str(name))
    if isinstance(value, bool):
        return None  # JSON true/false is neither on/off nor a number
    v = str(value).strip().lower() if value is not None else ""
    if kind == "onoff":
        return v if v in ("on", "off") else None
    if isinstance(kind, tuple) and re.fullmatch(r"[0-9]{1,10}", v, re.ASCII):
        n = int(v)
        return str(n) if kind[0] <= n <= kind[1] else None
    return None


def limit_help(name: str) -> str:
    """What a value of this limit may be, for the console."""
    kind = LIMITS.get(name)
    if kind == "onoff":
        return "on or off"
    low, high = kind
    return f"a whole number from {low} to {high:,}" + (" (0 = none)" if low == 0 else "")


def limits(st: dict | None = None) -> dict:
    """The owner's limits from state (api.limits), only the valid ones (a hand-edited state.json can't add anything)."""
    st = st if st is not None else state.load_state()
    raw = (st.get("api") or {}).get("limits")
    out = {}
    for k, v in (raw.items() if isinstance(raw, dict) else []):
        val = limit_value(k, v)
        if val is not None:
            out[k] = val
    return out


def settings(st: dict | None = None) -> dict:
    """The owner's choices for the API, from state: {memories: bool, recorder: "@…:…", turn: {...}|None, web: host}.
    web: where the owner's reverse proxy serves the web app when the server's own name is another website's (a
    domain whose front page is the owner's site): guest links and hand-offs go there. "" = the server's own name."""
    st = st if st is not None else state.load_state()
    a = st.get("api") or {}
    turn = a.get("turn") if isinstance(a.get("turn"), dict) else None
    web = str(a.get("web") or "") if st.get("mode") == "domain" else ""
    return {"memories": bool(a.get("memories")), "recorder": str(a.get("recorder") or ""), "turn": turn, "web": web,
            "limits": limits(st),
            # notifications to the Tin Hat phone apps through the relay (docs/PHONE-PUSH.md): on unless the owner says no
            "phone_push": a.get("phone_push") is not False}


def relay_origin(raw) -> str:
    """A relay address as the API will take it (webpush.mjs relayOrigin): https://host[:port] (http only for a loopback
    lab relay), nothing else, in canonical form; "" for anything else. It goes into the env file, so no whitespace or
    control characters can ever pass (a newline would smuggle another assignment)."""
    if not isinstance(raw, str):
        return ""
    v = raw.strip()
    if not v or any(ord(c) <= 0x20 or ord(c) == 0x7F for c in v):
        return ""
    try:
        u = urllib.parse.urlsplit(v)
        port = u.port
    except ValueError:
        return ""
    host = (u.hostname or "").lower()
    loopback = host in ("127.0.0.1", "localhost", "::1")
    if not (u.scheme == "https" or (u.scheme == "http" and loopback)):
        return ""
    if u.username or u.password or u.path not in ("", "/") or u.query or u.fragment or "?" in v or "#" in v or port == 0:
        return ""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    # a host name, or a real IPv4/IPv6 address. A name whose last label is a number (999.999.999.999, 127.1, 0x7f.1) is
    # an IPv4 address to the API's URL parser (WHATWG "ends in a number"), read differently or refused: never pass one
    last = host.rstrip(".").rsplit(".", 1)[-1]
    if ip is None and (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or re.fullmatch(r"[0-9]+|0x[0-9a-f]*", last)):
        return ""
    default = 443 if u.scheme == "https" else 80
    shown = f"[{ip.compressed}]" if ip is not None and ip.version == 6 else host
    return f"{u.scheme}://{shown}" + (f":{port}" if port and port != default else "")


def push_relay(st: dict | None = None) -> str:
    """The relay the API sends phone pushes through (PUSH_RELAY), checked; "" when phone notifications are off here or
    the configured address isn't a valid relay origin (then the API refuses phone pushers and the apps are told so)."""
    return relay_origin(environment.env().get("push_relay")) if settings(st)["phone_push"] else ""


def docker_gateway() -> str:
    """The box's address on the compose project's backend network (where Synapse can reach the push gateway). The
    network exists once any backend service was created (install's prepare step makes sure); "" before that."""
    try:
        r = subprocess.run(["docker", "network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", "tinhat_backend"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    gw = r.stdout.strip() if r.returncode == 0 else ""
    return gw if gw and all(p.isdigit() for p in gw.split(".")) and gw.count(".") == 3 else ""


MODULES_SRC = Path(__file__).resolve().parents[1] / "synapse"  # manager/synapse/ (tinhat_rules.py)
MODULES_DIR = config.STATE_DIR / "synapse-modules"  # what Synapse mounts: a folder that is never replaced, only its files


def sync_synapse_modules() -> bool:
    """Copy the manager's Synapse modules into the folder Synapse mounts. Files are replaced one by one and the folder
    itself never is: a bind mount holds on to its directory, and an update replaces the whole manager folder. True when
    a file changed (Synapse needs a restart to load it)."""
    MODULES_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(MODULES_DIR, 0o755)
    changed = False
    for src in sorted(MODULES_SRC.glob("*.py")) if MODULES_SRC.exists() else []:
        dst = MODULES_DIR / src.name
        data = src.read_bytes()
        if not dst.exists() or dst.read_bytes() != data:
            state.write_text(dst, data.decode(), 0o644)
            changed = True
    return changed


def publish_protected(owner: str) -> bool:
    """protected-accounts.json next to the Synapse modules: the owner's id, which tinhat_rules refuses to deactivate
    (docs/ACCOUNT-SAFETY.md). Written with the well-known (install.write_wellknowns: setup, every update, adopt, a
    move), so it follows the owner the apps are told about. True when it changed (the module re-reads it by itself)."""
    MODULES_DIR.mkdir(parents=True, exist_ok=True)
    path = MODULES_DIR / "protected-accounts.json"
    text = json.dumps({"owner": owner or ""}) + "\n"
    try:
        if path.read_bytes() == text.encode() and path.stat().st_mode & 0o777 == 0o644:
            return False
    except OSError:
        pass  # missing or unreadable: written below
    state.write_text(path, text, 0o644)
    return True


def gameservers_configured() -> bool:
    return (DIR / "gameservers.json").exists() and (DIR / "pelican.key").exists()


def features(st: dict | None = None, s: dict | None = None) -> dict:
    """What this server offers beyond chat, for the well-known (`dev.tinhat.server.features`): the apps show exactly
    what works here. Only an explicit false switches a feature off in the apps."""
    st = st if st is not None else state.load_state()
    s = s if s is not None else state.load_secrets()
    a = settings(st)
    return {
        "calls": bool(st.get("calls", True)),
        "soundboard": True,
        "gifs": bool(s.get("giphy_key")),
        "watch": bool(s.get("youtube_key")),  # YouTube search in Watch Party / Media Party (pasted links need no key)
        "games": True,  # the catalogue answers without a key (Steam's store search is keyless)
        "steam": bool(s.get("steam_key")),  # importing someone's Steam library
        "gameservers": gameservers_configured(),
        "presence": True,
        "push": True,
        "phone_push": bool(push_relay(st)),  # the Tin Hat phone apps can get notifications from this server
        "memories": a["memories"],
        "reports": True,
        "guests": True,  # the guest room (docs/GUESTS.md): off until a manager turns it on, but always offered
        # Pad Watch: this server mints subscribe-only Watch tokens (/livekit/jwt/watch, calltoken.mjs; share
        # claude/tinhat-pad/WATCH-LEASE/DESIGN.md). The apps offer Watch only when this is true; an older server has no
        # key, so no Watch (never a normal token instead).
        "pad_watch": bool(st.get("calls", True)) and bool(s.get("livekit_secret")),
        # Pad on the phone, Step A (share claude/tinhat-pad/PAD-PHONE/DESIGN.md): this API re-mints EVERY call token with
        # the server's own `tinhat.person` and holds every sign-in to the exact account + device, so the apps may show one
        # tile per person (grouping only when that attribute matches the identity) and the Pad chip from `tinhat.pad`.
        # (and only once the call-server key pair has been replaced: no pre-0.3.13 credential can join; lkrotate.py)
        "person_tiles": bool(st.get("calls", True)) and bool(s.get("livekit_secret")) and bool(s.get("livekit_rotated")),
        "pad_chip": bool(st.get("calls", True)) and bool(s.get("livekit_secret")) and bool(s.get("livekit_rotated")),
        # Pad on the phone, Step B (0.3.14): the phone as the person's microphone / camera (/livekit/jwt/pad: a fresh
        # `~pad-mic-` / `~pad-cam-` identity publishing its ONE source, the device's earlier Pad sessions retired, a
        # moderator's person mute respected). Each capability on its own: the apps never substitute a normal token. Only
        # once rotated, like the chip (the chip is how everyone sees whose phone it is).
        "pad_mic": bool(st.get("calls", True)) and bool(s.get("livekit_secret")) and bool(s.get("livekit_rotated")),
        "pad_camera": bool(st.get("calls", True)) and bool(s.get("livekit_secret")) and bool(s.get("livekit_rotated")),
        # Open network (share MATRIX-FRONTEND-DESIGN.md B7): which network mode this server is in, a word, not a switch
        # ("home" | "connected"; "open" arrives with 0.4.0). The apps read only booleans as switches, so this never
        # turns a feature off in an older app.
        "network": network_mode(st),
        # Each person's rule for invites from other servers (dev.tinhat.invite_rules account data) is enforced by this
        # server (tinhat_network.NetworkRules, docs/NETWORK-RULES.md): the apps show the setting only when this is true.
        "invite_rules": network_mode(st) != "home",
    }


def network_mode(st: dict | None = None) -> str:
    """"home": no federation listener at all (setup's home-network mode); "connected": only the allow-list
    (docs/FEDERATION.md). The open Matrix network ("open") is the 0.4.0 switch and not offered yet."""
    st = st if st is not None else state.load_state()
    return "home" if st.get("mode", "lan") == "lan" else "connected"


def network(st: dict | None = None) -> dict:
    """What the apps read at GET /api/network (api network.mjs; docs/API.md "Federation for the apps"): the mode and
    the Tin Hat servers connected by code, so the apps can tell a room made on a connected Tin Hat server (Tin Hat's
    own room state may be sent there) from a room on any other server. Servers allowed by name are plain Matrix
    servers and are NOT listed. `blocked`: the owner's deny-list (netrules.py; the apps hide its people like ignored
    users); a blocked server is never `connected`, whatever the connections say. `invites`: the rule a person has
    when they never chose one (tinhat_network.NetworkRules)."""
    from . import netrules  # imported here: netrules imports this module
    st = st if st is not None else state.load_state()
    mode = network_mode(st)
    blocked = netrules.names(st) if mode != "home" else []
    conns = set()
    if mode != "home":
        for c in st.get("connections") or []:
            srv = c.get("server") if isinstance(c, dict) else None
            if isinstance(srv, str) and srv.strip():
                conns.add(srv.strip().lower())
    return {"v": 1, "mode": mode, "connected": netrules.without_blocked(conns, blocked), "blocked": blocked,
            "invites": {"default": "known"}}


#: network.json carries when it was written; the API refuses one older than NETWORK_MAX_AGE_S (apps fail closed), and
#: the manager's minute loop writes it again once it is older than NETWORK_RENEW_S. So a list that could not be
#: replaced (a disconnect whose publish failed in a way that also kept the old file) is served for at most that long
#: (astra r2 P1). Keep NETWORK_MAX_AGE_S equal to the API's NETWORK.MAX_AGE_S (network.mjs).
NETWORK_RENEW_S = 3600
NETWORK_MAX_AGE_S = 6 * 3600


def publish_network(st: dict | None = None, now: float | None = None) -> bool:
    """network.json in the API's folder (GET /api/network; the API re-reads it every few seconds: no restart).

    Always from the state on disk, read under one lock across processes (the dashboard, the loop, the console): a
    publisher holding an older snapshot can never put back a connection that was ended since (astra r1 P2). `st` is
    accepted for the callers' convenience and ignored. Any failure while holding the lock removes the old file, so the
    API answers 503 and the apps stop treating any server as connected until it is written again (fail closed); a
    failure before the lock is bounded by the file's age (NETWORK_MAX_AGE_S). Written when the content changed or it
    is older than NETWORK_RENEW_S. True when it was written."""
    del st
    t = int(time.time() if now is None else now)
    ensure_dirs()
    path = DIR / "network.json"
    with _network_lock():
        try:
            doc = network(state.load_state())
            try:
                old = json.loads(path.read_text())
                if isinstance(old, dict) and isinstance(old.get("issued"), int) and 0 <= t - old["issued"] < NETWORK_RENEW_S \
                        and {k: v for k, v in old.items() if k != "issued"} == doc:
                    return False
            except (OSError, ValueError):
                pass  # missing or unreadable: written below
            state.write_text(path, json.dumps({**doc, "issued": t}, sort_keys=True) + "\n", 0o600)
        except BaseException:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logging.getLogger("tinhat.apiconf").exception("couldn't remove a stale network.json (it expires by itself)")
            raise
    return True


@contextlib.contextmanager
def _network_lock(wait_s: float = 10.0):
    """An exclusive flock on DIR/network.lock, waited for up to wait_s (then taken anyway would be wrong: raise)."""
    fd = os.open(DIR / "network.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise TimeoutError("network.json is being written by another process")
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def recorder(st: dict | None = None) -> str:
    """The Memories recorder's account (the apps hide it from call tiles), only while Memories is on."""
    a = settings(st)
    return a["recorder"] if a["memories"] else ""


# A localpart as Synapse accepts it (historic ones included): anything but ':', whitespace and control characters.
_LOCALPART = re.compile(r"[^:\s\x00-\x1f\x7f]{1,255}")


def owner(st: dict | None = None) -> str:
    """The server owner's Matrix id, announced in the well-known (dev.tinhat.server.account.owner) so the apps refuse
    "Delete my account" for it (docs/ACCOUNT-SAFETY.md). An adopted Synapse's owner (adopt.py: setup's own account
    went with setup's database) before setup's; after "Move to your own domain" the same account under the current
    name (move.py renames every account). "" when unknown or not an account of this server."""
    st = st if st is not None else state.load_state()
    sn = st.get("server_name") or ""
    adopted = st.get("adopted") if isinstance(st.get("adopted"), dict) else {}
    names = {sn} | {f["name"] for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name")}
    for cand in (adopted.get("owner"), st.get("admin")):
        if not isinstance(cand, str) or not cand.startswith("@") or ":" not in cand:
            continue
        local, _, host = cand[1:].partition(":")
        if sn and host in names and _LOCALPART.fullmatch(local):
            return f"@{local}:{sn}"
    return ""


def env_text(server_name: str, s: dict, gateway: str, web: str = "", relay: str = "", owner_limits: dict | None = None) -> str:
    base = f"https://{server_name}"
    gw = gateway or "127.0.0.1"
    lines = {
        "PORT": str(API_PORT),
        "API_CONF_DIR": "/conf",
        "TINHAT_BOX": "1",
        "SERVER_NAME": server_name,
        "SYNAPSE_INTERNAL": config.SYNAPSE_URL,
        "SYNAPSE_PUBLIC": base,
        "WEB_BASE": f"https://{web}" if web else base,  # where a guest is handed to the web app (settings: web)
        "SOUNDBOARD_PUBLIC_BASE": f"{base}/api/soundboard",
        "VODS_PUBLIC_BASE": f"{base}/api/vods",
        "VODS_DIR": "/vods",
        "LK_API_URL": "http://127.0.0.1:7880",
        "LK_API_KEY": s["livekit_key"],
        # the call-server key pair replaced since 0.3.13 (lkrotate.py): until then the API attributes no token to a
        # person and refuses Pad Mic / Camera (the features below say the same)
        "LK_ROTATED": "1" if s.get("livekit_rotated") else "0",
        "TRUST_PROXY": "loopback",  # Caddy on this box hands over the caller's address
        "PUSH_GATEWAY_HOST": gw,
        "PUSH_GATEWAY_PORT": str(GATEWAY_PORT),
        "PUSH_GATEWAY_URL": f"http://{gw}:{GATEWAY_PORT}/_matrix/push/v1/notify",
        "PUSH_SUBJECT": base,  # VAPID's contact: an https URL is allowed, and it names nobody's mailbox
        "GAMES_DATA_DIR": "/conf/games",
    }
    if relay:
        lines["PUSH_RELAY"] = relay  # the phone apps' relay (docs/PHONE-PUSH.md); absent = phone pushers refused
    for k, v in (owner_limits or {}).items():  # the owner's numbers (LIMITS only, re-checked: never another variable)
        val = limit_value(k, v)
        if val is not None and k not in lines:
            lines[k] = val
    return "".join(f"{k}={v}\n" for k, v in lines.items())


def ensure_dirs() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DIR, 0o700)
    for d in SUBDIRS:
        (DIR / d).mkdir(exist_ok=True)
    pub = DIR / "public"  # read by Synapse's tinhat_rules (it runs as its own user): nothing secret in there
    pub.mkdir(exist_ok=True)
    os.chmod(pub, 0o755)
    sync_synapse_modules()
    VODS_DIR.mkdir(exist_ok=True)
    if not ENV.exists():  # compose reads env_file for every command, even before setup
        state.write_text(ENV, "", 0o600)


def write(st: dict | None = None, s: dict | None = None) -> bool:
    """Write the environment and the secret files from state and secrets. True when something the services read
    changed (the caller restarts `api` and `games`)."""
    st = st if st is not None else state.load_state()
    s = s if s is not None else state.load_secrets()
    ensure_dirs()
    sn = st.get("server_name") or ""
    if not sn:
        return False
    changed = False
    files = {
        "env": env_text(sn, s, docker_gateway(), settings(st)["web"], push_relay(st), limits(st)),
        "synapse-admin.token": s.get("system_token") or "",
        "synapse.secret": s.get("registration_shared_secret") or "",
        "livekit.secret": s.get("livekit_secret") or "",
    }
    for key, name in KEY_FILES.items():
        files[name] = s.get(key) or ""
    for name, text in files.items():
        p = DIR / name
        if not text:
            if name != "env" and p.exists():
                p.unlink()
                changed = True
            continue
        if not p.exists() or p.read_text() != text:
            state.write_text(p, text, 0o600)
            changed = True
    try:
        publish_network()  # read live by the API (no restart), so it doesn't count as a change here
    except Exception:  # noqa: BLE001 - never fails the write; publish_network removed the old file (apps fail closed)
        logging.getLogger("tinhat.apiconf").exception("couldn't publish network.json")
    return changed


def owner_ids(st: dict | None = None) -> set:
    """The owner's id under this server's name and every former one (a report filed before "Move to your own domain"
    names the owner as they were then)."""
    st = st if st is not None else state.load_state()
    me = owner(st)
    if not me:
        return set()
    local = me[1:].split(":", 1)[0]
    names = {st.get("server_name") or ""} | {f["name"] for f in st.get("former_names") or [] if isinstance(f, dict) and f.get("name")}
    return {f"@{local}:{n}" for n in names if n}


def about_owner(reported_user: str, me=None) -> bool:
    """Is this abuse report about the server owner (the one person who reads the dashboard)? Then the card doesn't name
    who sent it (round 3 security review, ACCWEB-4: the apps say the reported person isn't told who reported them).
    `me`: owner_ids() (or one id), worked out once by a caller that checks many reports."""
    me = owner_ids() if me is None else ({me} if isinstance(me, str) else set(me))
    me.discard("")
    return isinstance(reported_user, str) and reported_user in me


def redacted_report(text: str) -> str:
    """A stored abuse report about the owner without its sender: what Download hands out for it."""
    try:
        j = json.loads(text)
    except (ValueError, RecursionError):
        return text
    if isinstance(j, dict):
        j["user"] = ""
        if isinstance(j.get("report"), dict):
            j["report"]["reporter"] = ""
    return json.dumps(j, indent=1)


def reports(limit: int = 50, abuse_limit: int | None = 200) -> list[dict]:
    """Problem reports and shared logs people sent to this server, newest first (the dashboard's Reports card)."""
    return reports_doc(limit, abuse_limit)["items"]


def reports_doc(limit: int | None = 50, abuse_limit: int | None = 200) -> dict:
    """The Reports card's list: abuse reports ("Report…" on a person or a message) and problem reports / logs are cut
    to their newest `abuse_limit` / `limit` SEPARATELY (None = all), so a pile of one kind never pushes the other off
    the card (round 3 security review, ACCWEB-3), with how many of each there are. Newest first."""
    me = owner_ids()
    out = []
    for kind in ("reports", "logs"):
        d = DIR / kind
        if not d.exists():
            continue
        for p in d.iterdir():
            if not p.is_file():
                continue
            try:
                stt = p.stat()
            except OSError:
                continue
            item = {"kind": kind[:-1], "name": p.name, "size": stt.st_size, "at": int(stt.st_mtime)}
            if kind == "reports" and stt.st_size <= 2 * 1024 * 1024:  # (an older API wrote bigger, deeper files: listed by name)
                try:
                    j = json.loads(p.read_text())
                    item["user"] = str(j.get("user") or "")
                    body = j.get("report") if isinstance(j.get("report"), dict) else {}
                    item["title"] = str(body.get("title") or body.get("summary") or "")[:120]
                    if body.get("kind") == "abuse":  # "Report…" on a person or a message (the API checked it)
                        item["abuse"] = {k: str(body.get(k) or "")[:n] for k, n in (
                            ("category", 20), ("reported_user", 300), ("room_id", 300), ("event_id", 300),
                            ("details", 1000))}
                        if about_owner(item["abuse"]["reported_user"], me):
                            item["user"], item["reporterHidden"] = "", True
                            item["size"] = len(redacted_report(p.read_text()).encode())  # the size of what Download gives
                except (OSError, ValueError, RecursionError):  # a file from an older API may be nested very deep
                    pass
            else:
                item["user"] = p.name.split("-", 2)[1] if p.name.count("-") >= 2 else ""
            out.append(item)
    out.sort(key=lambda i: i["at"], reverse=True)
    abuse = [i for i in out if "abuse" in i]
    other = [i for i in out if "abuse" not in i]
    a = abuse if abuse_limit is None else abuse[:abuse_limit]
    o = other if limit is None else other[:limit]
    items = sorted(a + o, key=lambda i: i["at"], reverse=True)
    return {"items": items, "abuseTotal": len(abuse), "abuseShown": len(a), "otherTotal": len(other), "otherShown": len(o)}


def report_path(kind: str, name: str) -> Path | None:
    """A report's or log's file for download, only by its plain name (no paths)."""
    if kind not in ("report", "log") or not name or "/" in name or name.startswith("."):
        return None
    p = DIR / ("reports" if kind == "report" else "logs") / name
    return p if p.is_file() else None


def valid_turn(t: dict | None) -> tuple[dict | None, str | None]:
    """A TURN server for calls ({host, port, protocol, username}; the credential goes to secrets): checked."""
    if not t:
        return None, None
    host = str(t.get("host") or "").strip().lower()
    proto = str(t.get("protocol") or "udp").strip().lower()
    try:
        port = int(t.get("port") or (5349 if proto == "tls" else 3478))
    except (TypeError, ValueError):
        return None, "The TURN port must be a number."
    from . import templates
    if not templates.is_hostname(host):
        return None, "Type the TURN server's host name (like turn.example.com)."
    if proto not in TURN_PROTOCOLS:
        return None, "The TURN protocol is udp, tcp or tls."
    if not 1 <= port <= 65535:
        return None, "The TURN port is between 1 and 65535."
    user = str(t.get("username") or "").strip()
    if not user or len(user) > 200 or any(c in user for c in "\"\n\r"):
        return None, "Type the TURN user name."
    return {"host": host, "port": port, "protocol": proto, "username": user}, None


def doc(st: dict | None = None, s: dict | None = None) -> dict:
    """The Features card's view of the API: which keys are set (never their values), Memories, TURN, game servers."""
    st = st if st is not None else state.load_state()
    s = s if s is not None else state.load_secrets()
    a = settings(st)
    return {"keys": {k.replace("_key", ""): bool(s.get(k)) for k in KEY_FILES},
            "memories": a["memories"], "recorder": a["recorder"],
            # phone notifications through the Tin Hat relay: the owner's choice, and the relay's host when it's on
            "phonePush": a["phone_push"], "phoneRelay": urllib.parse.urlsplit(push_relay(st)).hostname or "",
            "web": a["web"], "webOffered": st.get("mode") == "domain", "serverName": st.get("server_name") or "",
            "turn": {k: v for k, v in (a["turn"] or {}).items() if k != "credential"} if a["turn"] else None,
            "gameservers": gameservers_configured(), "vodsDir": str(VODS_DIR), "apiDir": str(DIR),
            "reports": len(reports(500))}

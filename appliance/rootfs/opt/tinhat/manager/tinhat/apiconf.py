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
import json
import logging
import os
import subprocess
import time
from pathlib import Path

from . import config, state

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


def settings(st: dict | None = None) -> dict:
    """The owner's choices for the API, from state: {memories: bool, recorder: "@…:…", turn: {...}|None, web: host}.
    web: where the owner's reverse proxy serves the web app when the server's own name is another website's (a
    domain whose front page is the owner's site): guest links and hand-offs go there. "" = the server's own name."""
    st = st if st is not None else state.load_state()
    a = st.get("api") or {}
    turn = a.get("turn") if isinstance(a.get("turn"), dict) else None
    web = str(a.get("web") or "") if st.get("mode") == "domain" else ""
    return {"memories": bool(a.get("memories")), "recorder": str(a.get("recorder") or ""), "turn": turn, "web": web}


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
        "memories": a["memories"],
        "reports": True,
        "guests": True,  # the guest room (docs/GUESTS.md): off until a manager turns it on, but always offered
    }


def recorder(st: dict | None = None) -> str:
    """The Memories recorder's account (the apps hide it from call tiles), only while Memories is on."""
    a = settings(st)
    return a["recorder"] if a["memories"] else ""


def env_text(server_name: str, s: dict, gateway: str, web: str = "") -> str:
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
        "TRUST_PROXY": "loopback",  # Caddy on this box hands over the caller's address
        "PUSH_GATEWAY_HOST": gw,
        "PUSH_GATEWAY_PORT": str(GATEWAY_PORT),
        "PUSH_GATEWAY_URL": f"http://{gw}:{GATEWAY_PORT}/_matrix/push/v1/notify",
        "PUSH_SUBJECT": base,  # VAPID's contact: an https URL is allowed, and it names nobody's mailbox
        "GAMES_DATA_DIR": "/conf/games",
    }
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
        "env": env_text(sn, s, docker_gateway(), settings(st)["web"]),
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
    return changed


def reports(limit: int = 50) -> list[dict]:
    """Problem reports and shared logs people sent to this server, newest first (the dashboard's Reports card)."""
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
            if kind == "reports":
                try:
                    j = json.loads(p.read_text())
                    item["user"] = str(j.get("user") or "")
                    body = j.get("report") if isinstance(j.get("report"), dict) else {}
                    item["title"] = str(body.get("title") or body.get("summary") or "")[:120]
                except (OSError, ValueError):
                    pass
            else:
                item["user"] = p.name.split("-", 2)[1] if p.name.count("-") >= 2 else ""
            out.append(item)
    out.sort(key=lambda i: i["at"], reverse=True)
    return out[:limit]


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
            "web": a["web"], "webOffered": st.get("mode") == "domain", "serverName": st.get("server_name") or "",
            "turn": {k: v for k, v in (a["turn"] or {}).items() if k != "credential"} if a["turn"] else None,
            "gameservers": gameservers_configured(), "vodsDir": str(VODS_DIR), "apiDir": str(DIR),
            "reports": len(reports(500))}

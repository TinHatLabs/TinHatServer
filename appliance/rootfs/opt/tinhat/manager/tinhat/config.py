"""Paths and constants shared by the Tin Hat Server manager."""
import os
from pathlib import Path

OPT = Path(os.environ.get("TINHAT_OPT", "/opt/tinhat"))
STATE_DIR = Path(os.environ.get("TINHAT_STATE", "/var/lib/tinhat"))

VERSION = (OPT / "VERSION").read_text().strip() if (OPT / "VERSION").exists() else "dev"
COMPOSE_FILE = OPT / "compose.yaml"
UI_DIR = OPT / "manager" / "ui"
WEB_DIR = OPT / "web"

STATE_FILE = STATE_DIR / "state.json"
SECRETS_FILE = STATE_DIR / "secrets.json"
SETUP_CODE_FILE = STATE_DIR / "setup-code"
COMPOSE_ENV = STATE_DIR / "compose.env"
CADDY_DIR = STATE_DIR / "caddy"
CADDYFILE = CADDY_DIR / "etc" / "Caddyfile"  # the directory is mounted, so atomic replaces show up live
CA_ROOT = CADDY_DIR / "data" / "caddy" / "pki" / "authorities" / "local" / "root.crt"
SYNAPSE_DIR = STATE_DIR / "synapse"
POSTGRES_DIR = STATE_DIR / "postgres"
LIVEKIT_DIR = STATE_DIR / "livekit"  # mounted as /etc/livekit
CA_DIR = STATE_DIR / "ca"  # a copy of the CA root for lk-jwt (mounted as /etc/tinhat-ca) and downloads
WELLKNOWN_DIR = STATE_DIR / "wellknown"
LOG_FILE = STATE_DIR / "manager.log"
API_DIR = STATE_DIR / "api"  # the Tin Hat API's environment, keys and state (apiconf.py)
VODS_DIR = STATE_DIR / "vods"  # Memories recordings (the owner's recorder writes here; the api reads)

EDITION_FILE = OPT / "EDITION"


def edition() -> str:
    """"appliance": the Tin Hat Server image, the whole machine is the server. "linux": install.sh on the owner's own
    Linux machine, VM or VPS; the manager then leaves the machine's name, network, SSH and system updates alone.
    "compose": the Docker Compose edition (the manager in a container, compose_entry.py): the machine is theirs too,
    and updates come with a new image (`docker compose pull && docker compose up -d`)."""
    try:
        e = EDITION_FILE.read_text().strip()
    except OSError:
        return "appliance"
    return e if e in ("linux", "compose") else "appliance"


def own_machine() -> bool:
    return edition() in ("linux", "compose")


def compose_edition() -> bool:
    return edition() == "compose"


def arch() -> str:
    """amd64 or arm64: which build of our own images (and which images.lock) an update needs."""
    import platform
    return "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "amd64"


def lock_name() -> str:
    """The release bundle's images.lock for this processor (bundles carry images.lock.arm64 beside the amd64 one)."""
    return "images.lock" if arch() == "amd64" else f"images.lock.{arch()}"


def manifest_images(m: dict) -> dict | None:
    """Our own images (tinhat/caddy) for this processor from a release manifest; None when it has no build for it."""
    return m.get("images") if arch() == "amd64" else m.get(f"images_{arch()}")


PORTS_FILE = OPT / "PORTS"


def proxy_only() -> bool:
    """install.sh --behind-proxy: another web server on this machine (nginx, Traefik, Caddy, Nginx Proxy Manager) has
    ports 80 and 443, so Tin Hat Server never binds them: setup answers on port 8080, and afterwards the owner's
    reverse proxy sends the server's domain there (setup's "My own domain → My own reverse proxy")."""
    try:
        return own_machine() and PORTS_FILE.read_text().strip() == "proxy"
    except OSError:
        return False


# The address the box's own name resolves to on the box (/etc/hosts), for its own services (lk-jwt, health checks).
# The image owns 127.0.1.1 (Debian's line for the machine's name); on someone's own machine that line stays theirs.
SELF_IP_APPLIANCE, SELF_IP_OWN = "127.0.1.1", "127.0.1.2"

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8090
SYNAPSE_URL = "http://127.0.0.1:8008"
SYNAPSE_UID = 991  # the matrixdotorg/synapse image's default UID/GID

# The account the box itself uses for Synapse's admin API (registration tokens, the people list). It never
# signs in anywhere else; its token stays in secrets.json. Hidden from the dashboard's people list.
SYSTEM_LOCALPART = "tinhat-system"

# Invite codes, TH-XXXX-XXXX (web.py): the same format and alphabet as the Tin Hat API's (api/tinhat-api/invites.mjs),
# so Tin Hat's sign-up screen reads them the same way (no 0/O/1/I, survives being read out on a call).
INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
INVITE_PREFIX = "TH-"
# A password the owner hands to someone who forgot theirs (People → Set a new password): 4 groups of 4, no look-alikes
# (0/o, 1/l/i), lower case to type on a phone; 31^16 ≈ 2^79.
PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

"""Small JSON files on disk: the box's phase (state.json) and its generated secrets (secrets.json)."""
import json
import os
import secrets as _secrets
import tempfile
from pathlib import Path

from . import config


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return default


def write_json(path: Path, data, mode: int = 0o600) -> None:
    """Atomic write: a crash mid-write never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def write_text(path: Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def load_state() -> dict:
    return read_json(config.STATE_FILE, {}) or {}


def save_state(**changes) -> dict:
    s = load_state()
    s.update(changes)
    write_json(config.STATE_FILE, s, 0o644)
    return s


PUBLIC_MODES = ("anywhere", "domain")


def public_mode(st: dict | None = None) -> bool:
    """Reachable from anywhere: with a tinhat.me name ("anywhere") or the owner's own domain ("domain"). Both open
    the router's ports, check from outside, and can connect to other Tin Hat servers; only "anywhere" uses the names
    service for its name."""
    st = st if st is not None else load_state()
    return st.get("mode") in PUBLIC_MODES


def behind_proxy(st: dict | None = None) -> bool:
    """An own domain whose HTTPS is the owner's own reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager): the
    proxy has 443 and the certificate, this box answers it on PROXY_PORT; only the call ports are this box's."""
    st = st if st is not None else load_state()
    return st.get("mode") == "domain" and (st.get("domain") or {}).get("provider") == "proxy"


def phase() -> str:
    return load_state().get("phase", "unconfigured")


def load_secrets() -> dict:
    """Generated once and kept: a retried install must reuse the same database password etc."""
    s = read_json(config.SECRETS_FILE, None)
    if s:
        return s
    tok = lambda n=32: _secrets.token_urlsafe(n)  # noqa: E731
    s = {
        "postgres_password": tok(24),
        "registration_shared_secret": tok(),
        "macaroon_secret_key": tok(),
        "form_secret": tok(),
        "livekit_key": "tinhat" + _secrets.token_hex(4),
        "livekit_secret": tok(),
        "system_password": tok(),
        "system_token": None,
    }
    write_json(config.SECRETS_FILE, s)
    return s


def save_secrets(**changes) -> dict:
    s = load_secrets()
    s.update(changes)
    write_json(config.SECRETS_FILE, s)
    return s


def setup_code(create: bool = True) -> str | None:
    """The 8-digit code shown on the console; whoever runs the wizard must type it."""
    try:
        return config.SETUP_CODE_FILE.read_text().strip()
    except FileNotFoundError:
        if not create:
            return None
    code = "".join(_secrets.choice("0123456789") for _ in range(8))
    code = f"{code[:4]}-{code[4:]}"
    write_text(config.SETUP_CODE_FILE, code + "\n", 0o600)
    return code

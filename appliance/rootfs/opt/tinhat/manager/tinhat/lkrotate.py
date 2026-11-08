"""0.3.13 (PAD-PHONE Step A: share claude/tinhat-pad/PAD-PHONE/DESIGN.md "STEP A — decisions after review 4", STEP-A.md
"rollback"): the call server's key pair is replaced ONCE, so no call credential from before 0.3.13 can join, rejoin or
resume a call (the update's restart of the call server ends every running session).

It runs on every update (after_update, before the configs are written again) until it has happened, and only when a
FAILED update can't leave the call server, the call sign-in service and the Tin Hat API on different key pairs: the
updater that runs this update must have kept a safety copy of the API's own copy of the key (api/env + api/livekit.secret,
updater.py STATE_ITEMS since 0.3.12) — the old pair in secrets.json, livekit/ and compose.env always is. An older
updater's copy lacks those two files: its rollback would bring secrets.json, LiveKit and lk-jwt back to the old pair while
the API container kept the new one. Then nothing is replaced now (it happens on the next update, made by this release's
updater), and the person tiles / Pad chip stay off until it has: the features don't offer them (apiconf.features), and
the API (LK_ROTATED=0 in its environment) adds no `tinhat.person` to any token, gives Watch only the watch mark and
refuses Pad Mic / Camera.
New servers (secrets made by this release) never had an older credential: they count as replaced."""
import logging
import secrets as _secrets

from . import config, state

log = logging.getLogger("tinhat.lkrotate")
SNAPSHOTS = config.STATE_DIR / "updates" / "snapshots"


def safety_copy_has_api_key() -> bool:
    """The running update's safety copy (the newest snapshot) holds the API's copy of the key."""
    try:
        snaps = sorted((p for p in SNAPSHOTS.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
    except OSError:
        return False
    if not snaps:
        return False
    api = snaps[-1] / "state" / "api"
    return (api / "env").is_file() and (api / "livekit.secret").is_file()


def maybe_rotate() -> str:
    if not config.SECRETS_FILE.exists():
        return "call-server key: not set up yet"
    s = state.load_secrets()
    if s.get("livekit_rotated"):
        return "call-server key: already replaced"
    if not safety_copy_has_api_key():
        return ("call-server key: NOT replaced yet — this update's safety copy doesn't keep the API's copy of the key, "
                "so a failed update could leave it mixed; the next update replaces it (person tiles stay off until then)")
    old = s.get("livekit_key") or ""
    key = "tinhat" + _secrets.token_hex(4)
    while key == old:
        key = "tinhat" + _secrets.token_hex(4)
    state.save_secrets(livekit_key=key, livekit_secret=_secrets.token_urlsafe(32), livekit_rotated="0.3.13")
    return "call-server key: replaced (every call token from before this update is refused)"

"""Where this box lives: the real internet (defaults) or the Tin Hat lab (environment.json, written by the lab's deploy).

The lab swaps in its own names service URL, Pebble instead of Let's Encrypt, and extra root certificates (the lab CA
and Pebble's root). Production images never have environment.json, so they use Let's Encrypt, names.tinhat.dev, the GitHub releases
and the system's own trust store only.
"""
import json
import ssl
from functools import lru_cache

from . import config, state

ENV_FILE = config.STATE_DIR / "environment.json"
EXTRA_ROOTS = config.CA_DIR / "extra-roots.pem"  # lab only: the lab CA + Pebble's root
BUNDLE = config.CA_DIR / "bundle.pem"  # system roots + extra roots, for containers that take one file (lk-jwt, Synapse)
SYSTEM_ROOTS = "/etc/ssl/certs/ca-certificates.crt"

DEFAULTS = {
    "names_url": "https://names.tinhat.dev",
    "zone": "tinhat.me",
    "acme_directory": "https://acme-v02.api.letsencrypt.org/directory",
    # Releases come from GitHub, then our mirror if GitHub doesn't answer (the newest signed version wins: updates.py).
    "updates_url": "https://github.com/TinHatLabs/TinHatServer/releases/latest/download/stable.json "
                   "https://updates.tinhat.dev/server/stable.json",
    "lab": False,
}


@lru_cache(maxsize=1)
def env() -> dict:
    e = dict(DEFAULTS)
    try:
        e.update(json.loads(ENV_FILE.read_text()))
    except (FileNotFoundError, ValueError):
        pass
    return e


def has_extra_roots() -> bool:
    return EXTRA_ROOTS.exists() and EXTRA_ROOTS.stat().st_size > 0


def write_bundle() -> str | None:
    """system roots + extra roots in one file; None when there are no extra roots (then nothing needs overriding).
    Behind the owner's reverse proxy the box's own CA root goes in too: the box answers its own name on its loopback
    addresses with a certificate of its own (lk-jwt checks sign-ins through https://<name>), and still needs the
    system's roots for connected servers."""
    box = config.CA_DIR / "root.crt"
    with_box = state.behind_proxy() and box.exists()
    if not has_extra_roots() and not with_box:
        return None
    config.CA_DIR.mkdir(parents=True, exist_ok=True)
    parts = []
    try:
        parts.append(open(SYSTEM_ROOTS).read())
    except OSError:
        pass
    if has_extra_roots():
        parts.append(EXTRA_ROOTS.read_text())
    if with_box:
        parts.append(box.read_text())
    state.write_text(BUNDLE, "\n".join(parts), 0o644)
    return str(BUNDLE)


def synapse_root_files() -> list[str]:
    """The lab roots, one certificate per file in Synapse's /data: federation_custom_ca_list reads only the FIRST
    certificate of each file (and replaces the system's roots, which the closed lab doesn't need)."""
    if not has_extra_roots() or not config.SYNAPSE_DIR.exists():
        return []
    pem = EXTRA_ROOTS.read_text()
    certs = ["-----BEGIN CERTIFICATE-----" + c.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
             for c in pem.split("-----BEGIN CERTIFICATE-----")[1:]]
    out = []
    for old in config.SYNAPSE_DIR.glob("extra-root-*.pem"):
        old.unlink()
    for i, c in enumerate(certs):
        f = config.SYNAPSE_DIR / f"extra-root-{i}.pem"
        state.write_text(f, c, 0o644)
        out.append(f"/data/{f.name}")
    return out


def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if has_extra_roots():
        ctx.load_verify_locations(str(EXTRA_ROOTS))
    return ctx

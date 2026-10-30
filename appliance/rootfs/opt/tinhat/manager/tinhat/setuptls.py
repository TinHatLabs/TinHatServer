"""The setup wizard's own HTTPS, before the server has a certificate of its own (NEXT-ROUND "Dashboard access", P2:
"no secret-taking step over plain HTTP on a public address").

A VPS owner starts at http://<address>/, across the internet. Everything secret the wizard takes (the setup code, the
owner's password, a backup's password, the setup cookie) now goes only over https, or over plain http from the home
network (web.py `_secret_ok`). For that https the manager makes a self-signed certificate at its first start, and
Caddy serves it on port 443 for any address until setup is done (templates.CADDY_SETUP_TLS, and the public modes'
setup site while the install runs). The browser warns that it doesn't know the certificate; the owner compares its
SHA-256 fingerprint with the one install.sh printed (`sudo tinhat setup-code` shows both again) before going on.

The certificate is made once and kept (the fingerprint must stay what install.sh printed), made again only when it is
missing or about to expire. Never deleted while a Caddyfile could name it: Caddy wouldn't start without it. Without
openssl there is no private page: the wizard then says how to reach it through an SSH tunnel instead (127.0.0.1 is
home), and plain http from outside still takes no secret.
"""
import hashlib
import logging
import os
import shutil
import ssl
import subprocess

from . import config, hw, state

log = logging.getLogger("tinhat.setuptls")

DIR = config.CADDY_DIR / "data" / "tinhat-setup"  # Caddy's /data is /var/lib/tinhat/caddy/data
CERT, KEY = DIR / "cert.pem", DIR / "key.pem"
CADDY_CERT, CADDY_KEY = "/data/tinhat-setup/cert.pem", "/data/tinhat-setup/key.pem"
FINGERPRINT_FILE = config.STATE_DIR / "setup-fingerprint"  # for install.sh and `tinhat setup-code` (not a secret)
DAYS = 90
made = False  # this manager made a new certificate: Caddy must load it (a reload of an unchanged Caddyfile is a no-op)


def fingerprint(pem: str | None = None) -> str | None:
    """The certificate's SHA-256 fingerprint as browsers show it (pairs of hex digits, colons), or None."""
    try:
        pem = CERT.read_text() if pem is None else pem
        der = ssl.PEM_cert_to_DER_cert(pem)
    except (OSError, ValueError):
        return None
    return ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())


def short(fp: str | None) -> str:
    """The first and last four pairs: enough to compare by eye (a look-alike certificate would have to match 64 bits)."""
    if not fp:
        return ""
    p = fp.split(":")
    return f"{':'.join(p[:4])} ... {':'.join(p[-4:])}"


#: how long after setup (or a restore) ends the wizard's own https site stays: its last page moves to the server's name,
#: a restore's finish page offers "Set a new admin password" (web._drop_setup_site, templates.setup_site)
GRACE = 1800


def in_grace(st: dict) -> bool:
    """Still within GRACE of the end of this install or restore (state ready_at; none = not)."""
    import time
    at = st.get("ready_at")
    return isinstance(at, (int, float)) and time.time() - at < GRACE


def available() -> bool:
    return CERT.is_file() and KEY.is_file()


def _fresh(openssl: str) -> bool:
    """The kept certificate is there and good for at least another day."""
    if not available():
        return False
    r = subprocess.run([openssl, "x509", "-in", str(CERT), "-noout", "-checkend", "86400"], capture_output=True,
                       timeout=10)
    return r.returncode == 0


def ensure() -> str | None:
    """Make the certificate when there isn't a good one; write its fingerprint for the console tools. -> the
    fingerprint, or None (no openssl, or it failed: then there is no private setup page)."""
    openssl = shutil.which("openssl")
    if openssl is None:
        if not available():
            FINGERPRINT_FILE.unlink(missing_ok=True)
            log.warning("no openssl: no private (https) setup page; from outside, setup needs an SSH tunnel")
            return None
    elif not _fresh(openssl):
        try:
            _make(openssl)
        except (OSError, subprocess.SubprocessError) as e:
            log.warning("couldn't make the setup page's certificate: %s", e)
            if not available():
                FINGERPRINT_FILE.unlink(missing_ok=True)
                return None
    fp = fingerprint()
    if fp is None:
        return None
    state.write_text(FINGERPRINT_FILE, fp + "\n", 0o644)
    return fp


def _make(openssl: str) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DIR, 0o700)
    sans = ["IP:127.0.0.1"] + [f"IP:{a}" for a in hw.addresses() + hw.ipv6_addresses()]
    tmp_key, tmp_cert = DIR / ".key.pem.new", DIR / ".cert.pem.new"
    r = subprocess.run([openssl, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                        "-keyout", str(tmp_key), "-out", str(tmp_cert), "-days", str(DAYS), "-sha256",
                        "-subj", "/CN=Tin Hat Server setup", "-addext", f"subjectAltName={','.join(dict.fromkeys(sans))}",
                        "-addext", "extendedKeyUsage=serverAuth"],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        tmp_key.unlink(missing_ok=True)
        tmp_cert.unlink(missing_ok=True)
        raise OSError(r.stderr.strip()[-300:] or "openssl failed")
    os.chmod(tmp_key, 0o600)
    os.replace(tmp_key, KEY)  # both replaced before Caddy is (re)loaded: the manager does that only after ensure()
    os.replace(tmp_cert, CERT)
    global made
    made = True
    log.info("made the setup page's certificate (fingerprint %s)", short(fingerprint()))

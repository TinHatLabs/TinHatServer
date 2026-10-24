"""A forgotten admin password: a one-time code on the server's own screen.

Someone presses "Forgot your password?" on the dashboard's sign-in (or the welcome page); the server shows an 8-digit
code on its own screen for 10 minutes (on Windows, the tray icon shows it, from CODE_FILE); typing it with a new
password resets that admin's password. Whoever can see the server's screen owns it: the same trust as the setup code.
"""
import secrets
import time
from pathlib import Path

CODE_FILE = Path("/run/tinhat/recovery-code")
LIFETIME = 600
# Wrong tries one code takes before it stops working (then press "Forgot" again for a new one). With 10^8 codes,
# guessing is hopeless however many addresses a stranger has.
TRIES = 20

_code: str | None = None
_until = 0.0
_wrong = 0


def start() -> int:
    """Show a code on the server's screen; the one already there stays while it lasts (a stranger pressing "Forgot"
    can't swap the owner's code for a new one). Returns how many seconds it lasts."""
    global _code, _until, _wrong
    if active():
        return max(1, int(_until - time.time()))
    d = f"{secrets.randbelow(10 ** 8):08d}"
    _code, _until, _wrong = f"{d[:4]}-{d[4:]}", time.time() + LIFETIME, 0
    try:
        CODE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CODE_FILE.write_text(_code + "\n")
        CODE_FILE.chmod(0o600)
    except OSError:
        pass
    _redraw()
    return LIFETIME


def active() -> str | None:
    if _code and time.time() > _until:
        clear()
    return _code


def minutes_left() -> int:
    return max(0, int((_until - time.time() + 59) // 60)) if _code else 0


def check(typed: str) -> bool:
    """The code on the screen? The TRIES-th wrong one ends that code."""
    global _wrong
    code = active()
    if not code:
        return False
    digits = "".join(ch for ch in str(typed) if ch.isdigit())
    if secrets.compare_digest(digits, code.replace("-", "")):
        return True
    _wrong += 1
    if _wrong >= TRIES:
        clear()
    return False


def clear() -> None:
    global _code, _until
    _code, _until = None, 0.0
    CODE_FILE.unlink(missing_ok=True)
    _redraw()


def _redraw() -> None:
    from . import console  # console reads active() for its banner
    console.refresh(force=True)

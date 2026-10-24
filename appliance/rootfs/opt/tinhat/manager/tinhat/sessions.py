"""Dashboard sign-ins that survive the manager restarting (every update restarts it; before, that signed the owner
out in the middle of watching the update). Kept in /var/lib/tinhat/sessions.json, by the sha256 of each cookie, so the
file never holds anything a browser could use."""
import hashlib
import secrets
import time

from . import config, state

FILE = config.STATE_DIR / "sessions.json"
SAVE_EVERY = 600  # a sliding expiry moves on every request; write it down at most every ten minutes


def _key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Sessions:
    def __init__(self, hours: float, file=FILE):
        self.hours = hours
        self.file = file
        self.items: dict[str, dict] = {}
        self.saved = 0.0
        data = state.read_json(file, {})
        now = time.time()
        if isinstance(data, dict):
            self.items = {k: v for k, v in data.items() if isinstance(v, dict) and v.get("until", 0) > now}

    def _save(self) -> None:
        state.write_json(self.file, self.items, 0o600)
        self.saved = time.time()

    def new(self, mxid: str) -> str:
        tok = secrets.token_urlsafe(32)
        self.items[_key(tok)] = {"mxid": mxid, "until": time.time() + self.hours * 3600}
        self._save()
        return tok

    def get(self, token: str) -> dict | None:
        s = self.items.get(_key(token)) if token else None
        now = time.time()
        if not s or s["until"] < now:
            return None
        s["until"] = now + self.hours * 3600
        if now - self.saved > SAVE_EVERY:
            self._save()
        return s

    def drop(self, token: str) -> None:
        if token and self.items.pop(_key(token), None) is not None:
            self._save()

    def drop_for(self, mxid: str) -> int:
        """End every dashboard sign-in of this account (its password was reset, or it isn't an admin any more)."""
        gone = [k for k, v in self.items.items() if v.get("mxid") == mxid]
        for k in gone:
            del self.items[k]
        if gone:
            self._save()
        return len(gone)

    def rename(self, old: str, new: str) -> None:
        """The server moved to a new name (move.py): each sign-in's account is the same person under the new name."""
        changed = False
        for v in self.items.values():
            if isinstance(v.get("mxid"), str) and old and v["mxid"].endswith(":" + old):
                v["mxid"] = v["mxid"][: -len(old)] + new
                changed = True
        if changed:
            self._save()

    def prune(self) -> None:
        now = time.time()
        gone = [k for k, v in self.items.items() if v["until"] < now]
        for k in gone:
            self.items.pop(k)
        if gone:
            self._save()

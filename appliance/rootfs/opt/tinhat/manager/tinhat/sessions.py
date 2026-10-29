"""Dashboard sign-ins that survive the manager restarting (every update restarts it; before, that signed the owner
out in the middle of watching the update). Kept in /var/lib/tinhat/sessions.json, by the sha256 of each cookie, so the
file never holds anything a browser could use.

Security review, server manager lows (sec-night-2 2026-10-27): a sign-in also has an absolute lifetime (max_hours from
when it was made, however busy it is: a stolen cookie doesn't live forever by being used), and recheck() ends the
sign-ins of an account that isn't an admin any more (demoted elsewhere, deactivated, gone) — the background loop runs
it every few minutes; the chat server not answering keeps them (an outage doesn't sign the owner out)."""
import hashlib
import secrets
import time

from . import config, state

FILE = config.STATE_DIR / "sessions.json"
SAVE_EVERY = 600  # a sliding expiry moves on every request; write it down at most every ten minutes


def _key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Sessions:
    def __init__(self, hours: float, file=FILE, max_hours: float | None = None):
        self.hours = hours
        self.max_hours = max_hours
        self.file = file
        self.items: dict[str, dict] = {}
        self.saved = 0.0
        data = state.read_json(file, {})
        now = time.time()
        if isinstance(data, dict):
            self.items = {k: v for k, v in data.items() if isinstance(v, dict) and v.get("until", 0) > now}
        for v in self.items.values():  # a sign-in from before the absolute lifetime: it starts counting now
            if not isinstance(v.get("born"), (int, float)):
                v["born"] = now

    def _alive(self, s: dict, now: float) -> bool:
        if s.get("until", 0) < now:
            return False
        return self.max_hours is None or now - s.get("born", now) <= self.max_hours * 3600

    def _save(self) -> None:
        state.write_json(self.file, self.items, 0o600)
        self.saved = time.time()

    def new(self, mxid: str) -> str:
        tok = secrets.token_urlsafe(32)
        now = time.time()
        self.items[_key(tok)] = {"mxid": mxid, "until": now + self.hours * 3600, "born": now}
        self._save()
        return tok

    def get(self, token: str) -> dict | None:
        k = _key(token) if token else ""
        s = self.items.get(k) if token else None
        now = time.time()
        if not s:
            return None
        if not self._alive(s, now):  # gone once seen expired (a clock set back later can't revive it)
            self.items.pop(k, None)
            self._save()
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

    def mxids(self) -> list[str]:
        """The accounts with a live sign-in."""
        now = time.time()
        return sorted({v["mxid"] for v in self.items.values() if isinstance(v.get("mxid"), str) and self._alive(v, now)})

    def prune(self) -> None:
        now = time.time()
        gone = [k for k, v in self.items.items() if not self._alive(v, now)]
        for k in gone:
            self.items.pop(k)
        if gone:
            self._save()


async def recheck(store: Sessions, lookup) -> list[str]:
    """End the sign-ins of every account that isn't an admin any more. lookup(mxid) -> (status, user) is the chat
    server's admin API (GET /_synapse/admin/v2/users/<mxid>): 200 with admin true and not deactivated keeps it; 200
    otherwise or 404 ends it; anything else (the chat server down, an error) keeps it until the next look.
    Returns the accounts whose sign-ins ended."""
    ended = []
    for mxid in store.mxids():
        try:
            st, u = await lookup(mxid)
        except Exception:  # noqa: BLE001 — the chat server not answering: look again later
            continue
        u = u if isinstance(u, dict) else {}
        if st == 404 or (st == 200 and (u.get("admin") is not True or u.get("deactivated"))):
            if store.drop_for(mxid):
                ended.append(mxid)
    return ended

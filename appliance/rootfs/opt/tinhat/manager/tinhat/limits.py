"""Wrong tries (setup codes, passwords, recovery codes, connection codes) and who made them.

Counted per caller, so a stranger who keeps guessing locks out only themselves, never the owner. A caller is an IPv4
address or an IPv6 /64 (one home, one server: rotating addresses inside it buys nothing). All callers together may
make OVERALL times as many tries, which bounds guessing from many places at once; that ceiling never applies to the
home network, so the owner at home always gets in. Where guessing is hopeless anyway (a session token), the overall
ceiling is HARD times the per-caller one: it only bounds the work strangers can cause.

A try is counted the moment it starts, before anything is awaited (many parallel requests can't all pass the check
before the first failure is written down), and taken back (forgive) when it turns out right or wasn't a guess.
Checks are cheap whatever the traffic: per-caller queues, one queue for everyone, at most MAX_CALLERS callers kept.
"""
import collections
import ipaddress
import time
from typing import Callable, Iterable

OVERALL = 5
HARD = 25
MAX_CALLERS = 4096

# What Caddy calls private_ranges (and nothing else: Python's is_private also says yes to 6to4 and Teredo, which the
# internet can reach), the addresses Caddy itself trusts.
HOME_NETS = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fd00::/8", "::1/128"))


def _ip(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """An address as a proxy may write it ("1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443", "::1"), IPv4-mapped IPv6
    as IPv4; None when it isn't one."""
    s = (text or "").strip()
    if s.startswith("["):
        s = s[1:].split("]", 1)[0]
    elif s.count(":") == 1:
        s = s.split(":", 1)[0]
    try:
        a = ipaddress.ip_address(s)
    except ValueError:
        return None
    if a.version == 6 and a.ipv4_mapped:
        return a.ipv4_mapped
    return a


def home(ip: str, own_nets: Iterable = ()) -> bool:
    """A home-network (or this machine's own) address: Caddy's private ranges, or one of this machine's own on-link
    IPv6 networks (home devices often connect over their global IPv6 address)."""
    a = _ip(ip)
    return a is not None and any(a in n for n in (*HOME_NETS, *own_nets) if n.version == a.version)


def key(ip: str) -> str:
    """Who a try is counted against: an IPv4 address, or an IPv6 /64."""
    a = _ip(ip)
    if a is None:
        return ip or "?"
    if a.version == 6:
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def client(xff: str, remote: str | None, proxies: Callable[[], set[str] | None]) -> str:
    """The browser's address. Only the box's Caddy reaches the manager. Caddy replaces X-Forwarded-For with its
    caller's address, except for a proxy it trusts (the owner's own reverse proxy: on the home network, or on this
    machine), whose header it extends with that proxy's address. So read it from the right, past the proxies Caddy
    trusts, skipping anything that isn't an address: whatever a caller wrote into the header itself sits further left
    and is never reached. proxies(): None when Caddy trusts no proxy, else the addresses it trusts besides home ones."""
    hops = [str(a) for a in (_ip(h) for h in (xff or "").split(",")) if a is not None]
    if not hops:
        return remote or ""
    if len(hops) == 1:
        return hops[0]
    extra = proxies()
    if extra is None:
        return hops[-1]
    for hop in reversed(hops):
        if not (home(hop) or hop in extra):
            return hop
    return hops[-2]  # all home addresses: the one the owner's proxy saw


class Fails:
    def __init__(self, *kinds: str):
        self.by_caller: dict[str, collections.OrderedDict[str, collections.deque]] = {
            k: collections.OrderedDict() for k in kinds}
        self.everyone: dict[str, collections.deque] = {k: collections.deque() for k in kinds}

    @staticmethod
    def _now() -> float:
        return time.monotonic()  # a Pi without a clock battery steps its wall clock at boot

    def limited(self, kind: str, who: str, window: float, most: int, overall: bool = True,
                trust_home: bool = True, own_nets: Iterable = ()) -> bool:
        """Too many tries of this kind just now: from this caller (most), or from everyone together (OVERALL x most,
        HARD x most where overall=False). The home network skips the together-ceiling, unless its addresses come
        from a header nobody vouches for (trust_home=False: behind the owner's own proxy)."""
        now = self._now()
        q = self.everyone[kind]
        while q and now - q[0] >= window:
            q.popleft()
        k = key(who)
        mine = self.by_caller[kind].get(k)
        if mine is not None:
            while mine and now - mine[0] >= window:
                mine.popleft()
            if not mine:
                del self.by_caller[kind][k]
            elif len(mine) >= most:
                return True
        if trust_home and home(who, own_nets):
            return False
        return len(q) >= (OVERALL if overall else HARD) * most

    def failed(self, kind: str, who: str) -> None:
        """Count a try (at its start: see the module's docstring)."""
        now = self._now()
        callers = self.by_caller[kind]
        k = key(who)
        mine = callers.pop(k, None) or collections.deque()
        mine.append(now)
        callers[k] = mine  # the most recent caller last
        while len(callers) > MAX_CALLERS:
            callers.popitem(last=False)
        self.everyone[kind].append(now)

    def forgive(self, kind: str, who: str) -> None:
        """Take back this caller's latest try (it was right, or not a guess at all)."""
        mine = self.by_caller[kind].get(key(who))
        if not mine:
            return
        t = mine.pop()
        q = self.everyone[kind]
        for i in range(len(q) - 1, -1, -1):  # it's near the end
            if q[i] == t:
                del q[i]
                break

    def count(self, kind: str) -> int:
        return len(self.everyone[kind])

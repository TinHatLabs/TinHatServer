"""Who may open the dashboard (docs/REMOTE-ACCESS.md "Dashboard access"; NEXT-ROUND "Dashboard access",
2026-10-28): the owner's choice, kept in state as dashboard_access = {"mode", "addresses", "set_at", "set_by"}.

  anywhere   any address, with the owner's password (what every server did before this setting)
  addresses  only the home network and the addresses named here (setup names the browser's own address)
  home       only the home network

It applies to /admin and everything under it (the dashboard's pages and its API) on a server friends reach from
outside (state.public_mode). Twice: Caddy refuses other addresses before the manager sees them (templates.admin_gate,
written into every public Caddyfile), and the manager refuses them too (web.py's middleware), so a choice holds the
moment it is saved, and a Caddyfile that missed it still can't open the dashboard. A home-network server needs neither:
nothing outside reaches it.

"The home network" is what the manager counts as home everywhere else (limits.home): Caddy's private ranges (also this
machine itself, so an SSH tunnel to 127.0.0.1 always works) and this machine's own on-link IPv6 networks.

The Tin Hat apps' invite codes (/api/admin/* → the manager's /tinhat-api/admin/*) are not the dashboard: they sign in
with the app's own account and keep working from anywhere. The way back in, when the owner's own address changed or a
choice locked them out: `sudo tinhat dashboard-access anywhere` on the server's console.
"""
import ipaddress
import time

from . import limits, state

MODES = ("anywhere", "addresses", "home")
DEFAULT = "anywhere"
MAX_ADDRESSES = 8
# the widest network one entry may be: a whole provider's range would make the choice meaningless
WIDEST = {4: 16, 6: 48}

#: what the gate never closes (Caddy's and the manager's): another computer holding a restored copy of this server
#: tells this one to stand down here (moved.py), from wherever it is
GATE_OPEN = ("/admin/name-check",)

#: what Caddy answers an address the choice leaves out (templates.admin_gate); the manager's own refusal says the same
REFUSED = ("This server's dashboard only opens from its owner's chosen addresses. If it's your server: open it from "
           "home, or type  sudo tinhat dashboard-access anywhere  on the server's console.")


#: behind the owner's reverse proxy, a dashboard request that doesn't say who the visitor is (no X-Forwarded-For)
REFUSED_UNNAMED = ("This server's dashboard only opens from its owner's chosen addresses, and the reverse proxy in front "
                   "of it didn't say who you are (X-Forwarded-For). Set your proxy to send it, or type  sudo tinhat "
                   "dashboard-access anywhere  on the server's console.")


def _net(text) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    """An address or a network as the owner may write it ("203.0.113.7", "2001:db8:1:2::/64"), as a network; None
    when it isn't one."""
    s = str(text or "").strip()
    if s.startswith("[") and "]" in s:
        s = s[1:].split("]", 1)[0]
    try:
        n = ipaddress.ip_network(s, strict=False)
    except ValueError:
        return None
    if n.version == 6 and n.network_address.ipv4_mapped and n.prefixlen >= 96:
        return ipaddress.ip_network(f"{n.network_address.ipv4_mapped}/{n.prefixlen - 96}", strict=False)
    return n


def owner_entry(ip: str) -> str | None:
    """The entry "only from this address" saves for a browser's address: an IPv4 address as it is; an IPv6 address
    as its /64 (a device's IPv6 address changes every day or so inside the /64 its network was given)."""
    a = limits._ip(ip)
    if a is None or a.is_loopback or a.is_unspecified:
        return None
    if a.version == 6:
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def parse_addresses(raw) -> tuple[list[str], str | None]:
    """The owner's list (a list, or text with commas/spaces) → ([normalised entries], None), or ([], what's wrong)."""
    items = raw if isinstance(raw, list) else str(raw or "").replace(",", " ").split()
    out: list[str] = []
    for item in items:
        n = _net(item)
        if n is None:
            return [], f"{str(item)[:60]} isn't an address."
        if n.version == 6 and n.prefixlen == 128 and "/" not in str(item):  # a bare IPv6 address: its /64 (owner_entry)
            n = n.supernet(new_prefix=64)
        if n.prefixlen < WIDEST[n.version]:
            return [], f"{n} is too wide: name your own address (or at most a /{WIDEST[n.version]} network)."
        if n.network_address.is_unspecified or n.network_address.is_multicast:
            return [], f"{n} isn't an address a browser connects from."
        # canonical: an IPv4 address bare, an IPv6 /128 written with its /128 (read back, a bare IPv6 address would
        # widen to its /64: Astra on be9372e), networks as networks
        text = str(n.network_address) if n.version == 4 and n.prefixlen == 32 else str(n)
        if text not in out:
            out.append(text)
    if len(out) > MAX_ADDRESSES:
        return [], f"At most {MAX_ADDRESSES} addresses."
    return out, None


def policy(st: dict | None = None) -> dict:
    """The saved choice, cleaned: {"mode", "addresses"}. Nothing saved, or something this version can't read: anywhere
    (how every server worked before the setting existed). "addresses" with no address left is "home"."""
    st = state.load_state() if st is None else st
    raw = st.get("dashboard_access") if isinstance(st.get("dashboard_access"), dict) else {}
    mode = raw.get("mode") if raw.get("mode") in MODES else DEFAULT
    addrs, problem = parse_addresses(raw.get("addresses") or []) if mode == "addresses" else ([], None)
    if problem is not None:
        addrs = []
    if mode == "addresses" and not addrs:
        mode = "home"
    return {"mode": mode, "addresses": addrs}


def applies(st: dict | None = None) -> bool:
    """Only a server friends reach from outside has a dashboard the internet could reach."""
    return state.public_mode(st)


def restricted(st: dict | None = None) -> bool:
    st = state.load_state() if st is None else st
    return applies(st) and policy(st)["mode"] != "anywhere"


def allowed(ip: str, st: dict | None = None, own_nets=()) -> bool:
    """May this address open the dashboard? (the manager's own check; Caddy's says the same: caddy_ranges)."""
    st = state.load_state() if st is None else st
    if not restricted(st):
        return True
    if limits.home(ip, own_nets):
        return True
    p = policy(st)
    a = limits._ip(ip)
    if a is None or p["mode"] != "addresses":
        return False
    return any(a in n for n in (_net(x) for x in p["addresses"]) if n is not None and n.version == a.version)


#: Caddy 2.10.2 matches an IPv4-mapped IPv6 caller (a proxy may write ::ffff:203.0.113.7) against IPv6 ranges only,
#: while the manager reads it as IPv4 (limits._ip): every IPv4 range also goes in mapped (Astra on be9372e). These are
#: private_ranges' IPv4 parts.
MAPPED_PRIVATE = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"))


def caddy_ranges(st: dict | None = None, own_nets=()) -> str | None:
    """The `client_ip` words of the addresses that may open the dashboard, or None when any address may."""
    st = state.load_state() if st is None else st
    if not restricted(st):
        return None
    words = ["private_ranges", *(f"::ffff:{n.network_address}/{96 + n.prefixlen}" for n in MAPPED_PRIVATE)]
    for n in own_nets:
        if str(n) not in words:
            words.append(str(n))
    if policy(st)["mode"] == "addresses":
        for a in policy(st)["addresses"]:
            n = _net(a)
            for w in ([a] if n is None or n.version == 6 else [a, f"::ffff:{n.network_address}/{96 + n.prefixlen}"]):
                if w not in words:
                    words.append(w)
    return " ".join(words)


def save(mode: str, addresses: list[str], who: str) -> dict:
    """Keep the owner's choice (the caller puts it live: web.apply_dashboard_access)."""
    if mode not in MODES:
        raise ValueError(mode)
    doc = {"mode": mode, "addresses": addresses if mode == "addresses" else [], "set_at": int(time.time()),
           "set_by": who}
    state.save_state(dashboard_access=doc)
    return doc


def lockout_problem(mode: str, addresses: list[str], caller: str, own_nets=()) -> str | None:
    """A choice that leaves out the address this very request came from would lock its owner out at once: refused in
    the dashboard (the console's `tinhat dashboard-access` checks nothing: it is the way back in)."""
    if mode == "anywhere":
        return None
    trial = {"mode": "anywhere", "dashboard_access": {"mode": mode, "addresses": addresses}}  # a public mode: it applies
    if allowed(caller, trial, own_nets):
        return None
    here = owner_entry(caller) or caller or "this address"
    return (f"You're connecting from {here}, which this choice leaves out: saving it would close this page on you. "
            f"Add your address, or open the dashboard from home first.")


def doc(st: dict | None = None, caller: str = "", own_nets=()) -> dict:
    """What the dashboard's Network tab shows."""
    st = state.load_state() if st is None else st
    p = policy(st)
    raw = st.get("dashboard_access") if isinstance(st.get("dashboard_access"), dict) else {}
    return {"applies": applies(st), "mode": p["mode"], "addresses": p["addresses"], "setAt": raw.get("set_at"),
            "you": caller or None, "yourEntry": owner_entry(caller) if caller else None,
            "youAtHome": bool(caller) and limits.home(caller, own_nets)}


def from_setup(choice, caller: str, at_home: bool) -> tuple[dict | None, str | None]:
    """The wizard's answer (install.validate passes it on) → the dashboard_access to keep, or what's wrong.
    Asked only when the browser isn't on the home network; "address" names that browser's own address (from the
    request, never from the form)."""
    if choice in (None, "", "anywhere"):
        return {"mode": "anywhere", "addresses": []}, None
    if choice == "home":
        if not at_home:
            return None, ("You're not on the server's home network now, so \"only from the home network\" would close the "
                          "dashboard on you at the end of setup. Choose it later in the dashboard, from home.")
        return {"mode": "home", "addresses": []}, None
    if choice == "address":
        entry = owner_entry(caller)
        if entry is None:
            return None, "The server couldn't tell which address you're connecting from."
        return {"mode": "addresses", "addresses": [entry]}, None
    return None, "Choose who can open the dashboard."

"""What the relay should look like, as text: the nftables ruleset and HAProxy's name → tunnel map.

Pure functions, so they're tested without a relay (tests/test_render.py); system.py applies the results.

A place is one Tin Hat server on this relay:
    {"name": "crew", "fqdn": "crew.tinhat.me", "public_key": "<WireGuard key>", "tunnel_ip": "100.96.0.2",
     "port": 20001, "web": true, "calls": true}
web   HTTPS by name (443, passed through untouched to the server: the relay never holds its certificate or key)
calls the server's own call port, TCP and UDP (same number), forwarded into the tunnel
"""
import base64
import binascii
import ipaddress
import re

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$")
FQDN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


class PlaceError(ValueError):
    pass


def _key_ok(k: str) -> bool:
    try:
        return len(base64.b64decode(k, validate=True)) == 32
    except (binascii.Error, ValueError, TypeError):
        return False


def check_place(p: dict, cfg: dict) -> dict:
    """One place, cleaned; PlaceError says what's wrong with it."""
    try:
        name = str(p["name"]).lower()
        fqdn = str(p["fqdn"]).lower().rstrip(".")
        key = str(p["public_key"])
        tip = ipaddress.IPv4Address(str(p["tunnel_ip"]))
        port = int(p["port"])
    except (KeyError, ValueError, TypeError) as e:
        raise PlaceError(f"bad place: {e}") from e
    if not NAME_RE.match(name) or "--" in name:
        raise PlaceError(f"bad name {name!r}")
    if not FQDN_RE.match(fqdn) or not fqdn.startswith(name + "."):
        raise PlaceError(f"bad fqdn {fqdn!r} for {name}")
    if not _key_ok(key):
        raise PlaceError(f"bad WireGuard key for {name}")
    net = ipaddress.IPv4Network(cfg["tunnel_net"])
    if tip not in net or tip in (net.network_address, net.broadcast_address) or str(tip) == cfg["tunnel_ip"]:
        raise PlaceError(f"tunnel address {tip} isn't a free address of {net}")
    first, last = cfg["ports"]
    if not first <= port <= last:
        raise PlaceError(f"port {port} is outside {first}-{last}")
    return {"name": name, "fqdn": fqdn, "public_key": key, "tunnel_ip": str(tip), "port": port,
            "web": bool(p.get("web", True)), "calls": bool(p.get("calls", True))}


def check_places(places: list, cfg: dict) -> list[dict]:
    out = [check_place(p, cfg) for p in places]
    if len(out) > cfg["capacity"]:
        raise PlaceError(f"{len(out)} places, but this relay takes at most {cfg['capacity']}")
    for field in ("name", "fqdn", "public_key", "tunnel_ip", "port"):
        seen = set()
        for p in out:
            if p[field] in seen:
                raise PlaceError(f"two places share the {field} {p[field]}")
            seen.add(p[field])
    return sorted(out, key=lambda p: p["port"])


def counter_name(place: str, what: str) -> str:
    """nftables object names: a letter first, then letters, digits and underscores."""
    return "p_" + place.replace("-", "_") + "_" + what


COUNTERS = ("tcp_in", "tcp_out", "udp_in", "udp_out")


def nft_ruleset(cfg: dict, places: list[dict]) -> str:
    """The relay's whole firewall + NAT, replaced atomically by `nft -f` (the first two lines make that work whether
    or not the table exists yet)."""
    pub, wan, wg = cfg["public_ip"], cfg["public_if"], cfg["wg_if"]
    allow = ", ".join(cfg["control_allow"])
    ctl_port = int(cfg["control_listen"].rsplit(":", 1)[1])
    calls = [p for p in places if p["calls"]]
    L = [
        "# Tin Hat relay: written by tinhat-relay on every change (don't edit; it's replaced whole).",
        "table inet tinhat_relay",
        "delete table inet tinhat_relay",
        "table inet tinhat_relay {",
    ]
    for p in calls:
        for what in COUNTERS:
            L.append(f"\tcounter {counter_name(p['name'], what)} {{ }}")
    L += [
        "\tchain input {",
        "\t\ttype filter hook input priority 0; policy drop;",
        '\t\tiif "lo" accept',
        "\t\tct state established,related accept",
        "\t\tct state invalid drop",
        f'\t\tiifname "{wan}" ip daddr {pub} tcp dport {cfg["https_port"]} accept comment "HTTPS by name (HAProxy)"',
        f'\t\tiifname "{wan}" ip daddr {pub} udp dport {cfg["wg_port"]} accept comment "WireGuard from home servers"',
    ]
    if allow:
        L.append(f'\t\tiifname "{wan}" ip saddr {{ {allow} }} tcp dport {ctl_port} accept comment "the names service"')
    L += [
        "\t\ticmp type { echo-request, destination-unreachable, time-exceeded } accept comment \"pings, incl. home servers' tunnel checks\"",
        "\t}",
        "\tchain forward {",
        "\t\ttype filter hook forward priority 0; policy drop;",
        "\t\tct state established,related accept",
        f'\t\tiifname "{wan}" oifname "{wg}" ct status dnat accept comment "call ports, into the tunnel"',
        "\t\t# nothing else: a home server can neither go out through the relay nor reach another one",
        "\t}",
        "\tchain clamp {",
        "\t\ttype filter hook forward priority -150; policy accept;",
        f'\t\toifname "{wg}" tcp flags syn tcp option maxseg size set rt mtu',
        f'\t\tiifname "{wg}" tcp flags syn tcp option maxseg size set rt mtu',
        "\t}",
        "\tchain account {",
        "\t\ttype filter hook forward priority -10; policy accept;",
    ]
    for p in calls:
        ip, port, n = p["tunnel_ip"], p["port"], p["name"]
        L += [
            f"\t\tip daddr {ip} tcp dport {port} counter name {counter_name(n, 'tcp_in')}",
            f"\t\tip saddr {ip} tcp sport {port} counter name {counter_name(n, 'tcp_out')}",
            f"\t\tip daddr {ip} udp dport {port} counter name {counter_name(n, 'udp_in')}",
            f"\t\tip saddr {ip} udp sport {port} counter name {counter_name(n, 'udp_out')}",
        ]
    L += [
        "\t}",
        "\tchain prerouting {",
        "\t\ttype nat hook prerouting priority dstnat; policy accept;",
    ]
    for p in calls:
        L += [
            f'\t\tiifname "{wan}" ip daddr {pub} tcp dport {p["port"]} dnat ip to {p["tunnel_ip"]} comment "{p["name"]} calls (TCP)"',
            f'\t\tiifname "{wan}" ip daddr {pub} udp dport {p["port"]} dnat ip to {p["tunnel_ip"]} comment "{p["name"]} calls (UDP)"',
        ]
    L += [
        "\t}",
        "\tchain postrouting {",
        "\t\ttype nat hook postrouting priority srcnat; policy accept;",
        f'\t\toifname "{wg}" ct status dnat snat ip to {cfg["tunnel_ip"]} comment "replies come back through the tunnel"',
        "\t}",
        "}",
        "",
    ]
    return "\n".join(L)


def sni_map(places: list[dict]) -> str:
    """HAProxy map: server name → its tunnel address. Only names whose web traffic the relay carries."""
    lines = ["# Tin Hat relay: server name -> tunnel address (written by tinhat-relay)"]
    lines += [f"{p['fqdn']} {p['tunnel_ip']}" for p in sorted(places, key=lambda p: p["fqdn"]) if p["web"]]
    return "\n".join(lines) + "\n"


def accumulate(usage: dict, places: list[dict], peers: dict, counters: dict) -> dict:
    """Add what the kernel counted since last time to each place's running totals.

    usage     {name: {"key", "rx", "tx", "raw_rx", "raw_tx", "handshake", "calls": {what: bytes}, "raw_calls": {…}}}
    peers     WireGuard, by public key: {"rx", "tx", "handshake"} (counters start again at 0 when a peer is re-added)
    counters  nftables, by counter name: bytes (they start again at 0 when the ruleset is replaced)
    A counter lower than last time means it started again, so all of it is new. Returns usage (changed in place)."""
    for p in places:
        u = usage.setdefault(p["name"], {"key": p["public_key"], "rx": 0, "tx": 0, "raw_rx": 0, "raw_tx": 0,
                                         "handshake": 0, "calls": {}, "raw_calls": {}})
        if u.get("key") != p["public_key"]:  # a new key is a new WireGuard peer: its counters start at 0
            u["key"], u["raw_rx"], u["raw_tx"] = p["public_key"], 0, 0
        peer = peers.get(p["public_key"])
        if peer:
            for d in ("rx", "tx"):
                raw, last = int(peer[d]), int(u.get("raw_" + d, 0))
                u[d] = int(u.get(d, 0)) + (raw - last if raw >= last else raw)
                u["raw_" + d] = raw
            u["handshake"] = int(peer.get("handshake") or 0)
        for what in COUNTERS:
            cn = counter_name(p["name"], what)
            if cn not in counters:
                continue
            raw, last = int(counters[cn]), int(u.setdefault("raw_calls", {}).get(what, 0))
            u.setdefault("calls", {})[what] = int(u["calls"].get(what, 0)) + (raw - last if raw >= last else raw)
            u["raw_calls"][what] = raw
    return usage


def counters_restart(usage: dict) -> None:
    """The ruleset is about to be replaced: its counters start again at 0."""
    for u in usage.values():
        u["raw_calls"] = {}


def public_usage(usage: dict, names: list[str]) -> dict:
    """What the names service gets: totals only (bytes through the tunnel, and through the call ports)."""
    out = {}
    for n in names:
        u = usage.get(n)
        if u:
            out[n] = {"bytes": int(u.get("rx", 0)) + int(u.get("tx", 0)), "rx": int(u.get("rx", 0)),
                      "tx": int(u.get("tx", 0)), "handshake": int(u.get("handshake", 0)),
                      "calls": {k: int(v) for k, v in (u.get("calls") or {}).items()}}
    return out

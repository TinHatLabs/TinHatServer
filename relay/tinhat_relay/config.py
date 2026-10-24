"""Settings for a Tin Hat relay. A JSON file overrides the defaults (one level deep)."""
import copy
import ipaddress
import json

DEFAULTS = {
    "relay_id": "relay1",
    "public_ip": None,            # the relay's public IPv4: friends connect here, home servers dial it
    "public_if": "eth0",
    "control_listen": None,       # "<public_ip>:8443" when None
    "control_allow": [],          # CIDRs allowed to use the control API (the names service); empty = nobody
    "control_cert": "/etc/tinhat-relay/control.crt",
    "control_key": "/etc/tinhat-relay/control.key",
    "token_file": "/etc/tinhat-relay/control.token",
    "control_name": None,         # DNS name in the control certificate (e.g. relay1.tinhat.dev)
    "wg_if": "wg0",
    "wg_port": 51820,
    "wg_key_file": "/etc/tinhat-relay/wg.key",
    "wg_mtu": 1420,
    "tunnel_net": "100.96.0.0/16",  # shared address space (RFC 6598): never a home network's own range
    "ports": [20000, 20999],        # one number per server, used for both TCP and UDP (calls)
    "capacity": 50,                  # most servers on this relay
    "state_file": "/var/lib/tinhat-relay/state.json",
    "haproxy_map": "/etc/tinhat-relay/sni.map",
    "nft_file": "/etc/tinhat-relay/relay.nft",
    "https_port": 443,
}


def load(path: str | None) -> dict:
    cfg = copy.deepcopy(DEFAULTS)
    if path:
        with open(path) as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return finish(cfg)


def finish(cfg: dict) -> dict:
    """Fill in what follows from the rest, and refuse settings that can't work."""
    if not cfg.get("public_ip"):
        raise ValueError("public_ip is required")
    ipaddress.IPv4Address(cfg["public_ip"])
    net = ipaddress.IPv4Network(cfg["tunnel_net"])
    cfg["tunnel_ip"] = str(next(net.hosts()))  # the relay is the first address
    cfg["tunnel_prefix"] = net.prefixlen
    if not cfg.get("control_listen"):
        cfg["control_listen"] = f"{cfg['public_ip']}:8443"
    first, last = cfg["ports"]
    if not (1024 < first <= last < 32768):
        raise ValueError("ports must be a range between 1025 and 32767 (below Linux's ephemeral ports)")
    for c in cfg["control_allow"]:
        ipaddress.ip_network(c)
    return cfg

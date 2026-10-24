"""Apply the relay's wanted state to the machine: the WireGuard interface and its peers, the nftables ruleset, HAProxy's
map; and read the kernel's counters back. Everything here shells out to `ip`, `wg`, `nft` and `systemctl`."""
import hashlib
import ipaddress
import json
import logging
import os
import subprocess
import tempfile

log = logging.getLogger("tinhat-relay.system")


class SystemError_(RuntimeError):
    pass


def run(*args: str, input: str | None = None, check: bool = True) -> str:
    r = subprocess.run(list(args), input=input, capture_output=True, text=True, timeout=30)
    if check and r.returncode != 0:
        raise SystemError_(f"{' '.join(args[:3])}…: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout


def write_if_changed(path: str, text: str, mode: int = 0o644) -> bool:
    try:
        with open(path) as f:
            if f.read() == text:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path))
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return True


# ---- WireGuard ------------------------------------------------------------------------------------------------------

def ensure_wg(cfg: dict) -> None:
    """The relay's end of every tunnel: one interface, its key, its port, its address (first of tunnel_net)."""
    wg = cfg["wg_if"]
    if run("ip", "link", "show", wg, check=False) == "":
        run("ip", "link", "add", wg, "type", "wireguard")
        log.info("created %s", wg)
    run("wg", "set", wg, "private-key", cfg["wg_key_file"], "listen-port", str(cfg["wg_port"]))
    run("ip", "address", "replace", f"{cfg['tunnel_ip']}/{cfg['tunnel_prefix']}", "dev", wg)
    run("ip", "link", "set", wg, "mtu", str(cfg["wg_mtu"]), "up")


def wg_public_key(cfg: dict) -> str:
    with open(cfg["wg_key_file"]) as f:
        return run("wg", "pubkey", input=f.read()).strip()


def wg_peers(cfg: dict) -> dict:
    """{public key: {endpoint, allowed, handshake, rx, tx}} (the dump's first line is the interface itself, with its
    private key: skipped, never kept)."""
    out = {}
    lines = run("wg", "show", cfg["wg_if"], "dump").splitlines()
    for line in lines[1:]:
        f = line.split("\t")
        if len(f) < 8:
            continue
        out[f[0]] = {"endpoint": f[2] if f[2] != "(none)" else None, "allowed": f[3],
                     "handshake": int(f[4] or 0), "rx": int(f[5] or 0), "tx": int(f[6] or 0)}
    return out


def wg_reconcile(cfg: dict, places: list[dict]) -> dict:
    """Make the peers exactly the places' keys, each allowed only its own tunnel address."""
    wg = cfg["wg_if"]
    want = {p["public_key"]: f"{p['tunnel_ip']}/32" for p in places}
    have = wg_peers(cfg)
    removed = added = 0
    for key in have:
        if key not in want:
            run("wg", "set", wg, "peer", key, "remove")
            removed += 1
    for key, allowed in want.items():
        if have.get(key, {}).get("allowed") != allowed:
            run("wg", "set", wg, "peer", key, "allowed-ips", allowed)
            added += 1
    return {"peers": len(want), "added_or_changed": added, "removed": removed}


# ---- nftables -------------------------------------------------------------------------------------------------------

def nft_apply(cfg: dict, text: str) -> bool:
    """Replace the relay's table atomically when the ruleset changed; True if it did."""
    path = cfg["nft_file"]
    if not write_if_changed(path, text, 0o644):
        if run("nft", "list", "table", "inet", "tinhat_relay", check=False):
            return False  # unchanged and loaded
    run("nft", "-f", path)
    return True


def nft_counters() -> dict:
    """{counter name: bytes} for the relay's named counters."""
    out = {}
    raw = run("nft", "-j", "list", "counters", "table", "inet", "tinhat_relay", check=False)
    try:
        items = json.loads(raw or "{}").get("nftables", [])
    except ValueError:
        return out
    for it in items:
        c = it.get("counter")
        if c and c.get("table") == "tinhat_relay":
            out[c["name"]] = int(c.get("bytes", 0))
    return out


# ---- HAProxy --------------------------------------------------------------------------------------------------------

def haproxy_apply(cfg: dict, text: str) -> bool:
    """Write the map and reload HAProxy when it changed (a reload keeps open connections on the old process)."""
    if not write_if_changed(cfg["haproxy_map"], text, 0o644):
        return False
    run("systemctl", "reload-or-restart", "haproxy")
    return True


# ---- small helpers ----------------------------------------------------------------------------------------------------

def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def in_any(ip: str, nets: list[str]) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a in ipaddress.ip_network(n) for n in nets)

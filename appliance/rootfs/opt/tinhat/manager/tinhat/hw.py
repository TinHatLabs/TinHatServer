"""What is this box made of, and what does that mean for the people using it?

probe() reads the machine; advise() turns it into plain-language expectations and feature recommendations
for the wizard and the dashboard. The capacity numbers are deliberately conservative rules of thumb for
Synapse + LiveKit on a small box; a home-network call is limited by the CPU (the SFU forwards every stream),
a call over the internet by the box's upload speed (measured once the box is online — a later update).
"""
import json
import os
import platform
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from . import config


def docker_subnets() -> list[str]:
    """IPv4 ranges of this machine's Docker networks (an existing Docker on the owner's own machine keeps its own)."""
    try:
        ids = subprocess.run(["docker", "network", "ls", "-q"], capture_output=True, text=True, timeout=10).stdout.split()
        if not ids:
            return []
        out = subprocess.run(["docker", "network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", *ids],
                             capture_output=True, text=True, timeout=10).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({n for n in out if ":" not in n})

GiB = 1024 ** 3


def _meminfo() -> dict:
    out = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            out[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    return out


def _cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return " ".join(line.split(":", 1)[1].split())
    except OSError:
        pass
    return platform.processor() or platform.machine()


def _virt() -> str:
    try:
        v = subprocess.run(["systemd-detect-virt"], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        v = ""
    return {"none": "", "kvm": "virtual machine (KVM)", "qemu": "virtual machine (QEMU)", "microsoft": "virtual machine (Hyper-V)",
            "oracle": "virtual machine (VirtualBox)", "vmware": "virtual machine (VMware)", "apple": "virtual machine (Apple)",
            "wsl": "Windows (WSL 2)"}.get(v, v)


def windows() -> bool:
    """Tin Hat Server for Windows: this runs as a WSL 2 distribution on someone's PC."""
    try:
        return "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower()
    except OSError:
        return False


WSL_HOST_DISK = Path("/run/tinhat-wsl/host-disk.json")  # the PC's own drive, written by the Windows side every 10 min


def _disk() -> dict:
    """Free and total space where the server keeps its data. Under WSL that is a virtual disk that can grow to 1 TB, so
    the PC's own drive (as Windows reports it) is the real limit when it's smaller."""
    st = os.statvfs(config.STATE_DIR if config.STATE_DIR.exists() else "/")
    free, total = st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
    try:
        h = json.loads(WSL_HOST_DISK.read_text())
        if time.time() - float(h["at"]) < 3600:
            free, total = min(free, int(h["free"])), min(total, int(h["total"]))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return {"total": total, "free": free}


def addresses() -> list[str]:
    """The box's IPv4 addresses on real interfaces (not loopback, not Docker's bridges, not the relay tunnel), the one
    its default route uses first (a PC on Ethernet and Wi-Fi offers the one it actually uses). WSL puts its DNS address
    (10.255.255.254) on lo with scope global, and its mirrored loopback adapter is called loopback0: neither counts."""
    out = []
    try:
        r = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=3)
        for line in r.stdout.splitlines():
            parts = line.split()
            ifname, addr = parts[1], parts[3].split("/")[0]
            if ifname == "lo" or ifname.startswith(("lo:", "loopback", "docker", "br-", "veth", "wg-")):  # wg-tinhat: the relay tunnel
                continue
            out.append(addr)
        src = subprocess.run(["ip", "-4", "route", "get", "1.1.1.1"], capture_output=True, text=True, timeout=3).stdout.split()
        first = src[src.index("src") + 1] if "src" in src else None
        if first in out:
            out.remove(first)
            out.insert(0, first)
    except (OSError, subprocess.SubprocessError, IndexError):
        pass
    return out


def ipv6_addresses() -> list[str]:
    """The box's global IPv6 addresses on real interfaces (as ipv6_nets picks them): the setup page's own https
    listens on them too behind the owner's proxy (setuptls.py), and its certificate names them."""
    out = []
    try:
        r = subprocess.run(["ip", "-6", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=3)
        for line in r.stdout.splitlines():
            parts = line.split()
            ifname, addr = parts[1], parts[3].split("/")[0]
            if ifname == "lo" or ifname.startswith(("lo:", "loopback", "docker", "br-", "veth", "wg-")):
                continue
            if addr not in out:
                out.append(addr)
    except (OSError, subprocess.SubprocessError, IndexError):
        pass
    return out


def ipv6_nets() -> list:
    """The box's own on-link IPv6 networks (global addresses on real interfaces, as addresses() picks them): a device
    connecting from inside one of them is on the home network, even over its global IPv6 address."""
    import ipaddress
    out = []
    try:
        r = subprocess.run(["ip", "-6", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=3)
        for line in r.stdout.splitlines():
            parts = line.split()
            ifname, cidr = parts[1], parts[3]
            if ifname == "lo" or ifname.startswith(("lo:", "loopback", "docker", "br-", "veth", "wg-")):
                continue
            addr, _, plen = cidr.partition("/")
            plen = min(int(plen or 64), 64)  # a DHCPv6 /128 still sits in its /64
            net = ipaddress.ip_network(f"{addr}/{plen}", strict=False)
            if net not in out:
                out.append(net)
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        pass
    return out


def online(timeout: float = 2.0) -> bool:
    """Can the box reach the internet? A TCP connect to the Tin Hat names service (what "friends anywhere" needs),
    then to two well-known anycast resolvers."""
    targets = [("1.1.1.1", 443), ("9.9.9.9", 443)]
    try:
        from . import environment
        u = urlparse(environment.env()["names_url"])
        if u.hostname:
            targets.insert(0, (u.hostname, u.port or 443))
    except Exception:  # noqa: BLE001 — the probe must answer either way
        pass
    for host, port in targets:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            continue
    return False


def probe() -> dict:
    mem = _meminfo()
    load1, load5, load15 = os.getloadavg()
    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except OSError:
        uptime = 0.0
    return {
        "cpu": {"model": _cpu_model(), "cores": os.cpu_count() or 1, "arch": platform.machine()},
        "memory": {"total": mem.get("MemTotal", 0), "available": mem.get("MemAvailable", 0)},
        "disk": _disk(),
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "uptime": int(uptime),
        "virtualization": _virt(),
        "windows": windows(),
        "addresses": addresses(),
        "hostname": socket.gethostname(),
        "online": online(),
    }


def _rate(mbit: float) -> str:
    """Network speed for people: 940 Mbit/s, 4.8 Gbit/s."""
    return f"{mbit / 1000:.1f} Gbit/s" if mbit >= 1000 else f"{mbit:.0f} Mbit/s" if mbit >= 10 else f"{mbit:.1f} Mbit/s"


def _bytes_rate(mbs: float) -> str:
    """Disk/processor throughput: 75 MB/s, 1.3 GB/s."""
    return f"{mbs / 1000:.1f} GB/s" if mbs >= 1000 else f"{mbs:.0f} MB/s" if mbs >= 10 else f"{mbs:.1f} MB/s"


def _people(n: int, cap: int) -> str:
    """"about 12", or "40 or more" past the point where the number stops meaning anything at home."""
    return f"{cap} or more" if n >= cap else f"about {n}"


def _lvl(value: float, good: float, warn: float, higher_is_better: bool = True) -> str:
    if higher_is_better:
        return "good" if value >= good else "warn" if value >= warn else "bad"
    return "good" if value <= good else "warn" if value <= warn else "bad"


def _worst(*levels: str) -> str:
    order = ["bad", "warn", "good"]
    return min(levels, key=order.index)


UPLOAD_CHOICES = [25, 100, 500, 2000]  # MB — the "biggest file people can send" options


def advise(p: dict, bench: dict | None = None, net: dict | None = None) -> dict:
    """What this box can do and which features to run, each with green / yellow / red and the reason.

    p = probe(); bench = bench.run() (processor + disk, measured on the box); net = what the browser measured
    between itself and the box ({down, up} in Mbit/s, rtt in ms). Missing measurements are said to be missing,
    never guessed. The capacity numbers are rules of thumb for Synapse + LiveKit on a small box.
    """
    cores = p["cpu"]["cores"]
    ram = p["memory"]["total"] / GiB
    free = p["disk"]["free"] / GiB
    online = bool(p.get("online"))
    single = (bench or {}).get("cpu", {}).get("single")
    write = (bench or {}).get("disk", {}).get("write")
    commit = (bench or {}).get("disk", {}).get("commit_ms")
    local = bool((net or {}).get("local"))  # measured from the server itself: says nothing about the network
    down = None if local else (net or {}).get("down")
    up = None if local else (net or {}).get("up")

    # ---- the measurements themselves -------------------------------------------------------------------------
    cpu_l = _lvl(single, 25, 10) if single is not None else ("good" if cores >= 2 else "warn")
    # Tin Hat Server for Windows caps its memory at 3 GB so games keep theirs (the PC reports a bit less): enough there.
    capped = bool(p.get("windows")) and ram >= 2.5
    mem_l = "good" if capped else _lvl(ram, 3.5, 1.8)
    disk_l = _worst(_lvl(write, 100, 25), _lvl(commit, 10, 30, higher_is_better=False)) if write is not None else _lvl(free, 20, 8)
    if free < 8:
        disk_l = _worst(disk_l, "warn" if free >= 4 else "bad")
    net_l = _lvl(min(down, up), 100, 20) if down is not None and up is not None else "info"
    checks = [
        {"id": "cpu", "label": "Processor", "level": cpu_l,
         "value": f"{cores} core{'s' if cores != 1 else ''}",
         "text": ("Fast enough to keep busy chats snappy." if cpu_l == "good" else
                  "A little slow: big rooms and busy calls will feel it." if cpu_l == "warn" else
                  "Very slow: expect lag with more than a handful of people.") if single is not None
         else "Not measured."},
        {"id": "memory", "label": "Memory", "level": mem_l, "value": f"{ram:.1f} GB",
         "text": "Kept to this much on Windows, so your games keep theirs. Enough for a group of friends." if capped
         else "Plenty." if mem_l == "good" else "Enough for a small group." if mem_l == "warn"
         else "Too little: Tin Hat Server needs at least 2 GB."},
        {"id": "disk", "label": "Storage", "level": disk_l,
         "value": f"{free:.0f} GB free" + (f" · writes {_bytes_rate(write)} · saves in {commit:.1f} ms" if write is not None else ""),
         "text": ("Fast and roomy." if disk_l == "good" else
                  "Works, but saving messages and files is slow (an SD card or USB stick?) or space is short."
                  if disk_l == "warn" else "Too slow or too full for a chat server.") if write is not None
         else "Speed not measured."},
        {"id": "network", "label": "Network", "level": net_l,
         "value": f"↓ {_rate(down)} · ↑ {_rate(up)}" + (f" · {net['rtt']:.0f} ms" if net and net.get("rtt") is not None else "")
         if down is not None else "This device is the server" if local else "Not measured",
         "text": ("Fast between this device and the server." if net_l == "good" else
                  "Slow between this device and the server. Wi-Fi far from the router?" if net_l == "warn" else
                  "Very slow between this device and the server.") if down is not None
         else "Measured on the server itself, which says nothing about your network. Open this page from a phone on "
              "your Wi-Fi to see it." if local
         else "The speed test didn't run on this device."},
        {"id": "internet", "label": "Internet", "level": "good" if online else "info",
         "value": "Connected" if online else "Not connected",
         "text": "The server can reach the internet." if online
         else "Friends anywhere, updates and link previews need it. A server for your home works without it."},
    ]

    # ---- capacity: people chatting, people on camera together ------------------------------------------------
    chat_people = 0 if ram < 1.8 else 25 if ram < 3.5 else 100 if ram < 7 else 250 if ram < 15 else 500
    if cpu_l == "bad" or disk_l == "bad":
        chat_people = min(chat_people, 10)
    elif cpu_l == "warn" or disk_l == "warn":
        chat_people = min(chat_people, 25)
    # Calls: the call server sends every camera to every other person (about 1.5 Mbit/s each at the sizes Tin Hat
    # shows in a grid), so n people on camera need n·(n−1)·1.5 Mbit/s out of the server. The measured speed is from
    # THIS device; the server's own wired link is usually faster, so this is a floor, not a ceiling.
    cpu_people = max(2, cores * 12)
    if down is not None:
        budget = max(down * 0.7, 1)
        net_people = 1
        while (net_people + 1) * net_people * 1.5 <= budget:
            net_people += 1
        call_people = min(cpu_people, net_people)
    else:
        call_people = min(cpu_people, 12)
    calls_l = "good" if call_people >= 6 and cores >= 2 else "warn" if call_people >= 3 else "bad"
    share_viewers = int((down or 100) * 0.7 // 10)  # a Tin Hat screen share is ~8-12 Mbit/s per viewer today

    # Chat: say what holds it back, in words.
    chat_l = _worst(mem_l, cpu_l, disk_l) if ram >= 1.8 else "bad"
    causes = [c for c, bad in (("the processor is slow", cpu_l != "good"), ("saving to the disk is slow", disk_l != "good"),
                               ("memory is tight", mem_l != "good")) if bad]
    if ram < 1.8:
        chat_reason = "Needs at least 2 GB of memory."
    elif chat_l == "good":
        chat_reason = f"Good for about {chat_people} people."
    elif chat_l == "warn":
        chat_reason = f"Fine for about {chat_people} people; {' and '.join(causes)}."
    else:
        chat_reason = f"Works for a few people, but {' and '.join(causes)}, so busy rooms will lag."

    # ---- the features, each with a verdict, the reason and the choice --------------------------------------------
    upload_rec = 25 if free < 15 else 100 if free < 100 else 500 if free < 500 else 2000
    mem_rec = cores >= 4 and free >= 100 and (write or 0) >= 80
    features = [
        {"id": "chat", "name": "Chat, photos and files", "level": chat_l,
         "what": "Rooms, direct messages, photos, files and voice messages, end-to-end encrypted.",
         "reason": chat_reason,
         "control": {"type": "always"}},
        {"id": "calls", "name": "Voice and video calls", "level": calls_l,
         "what": "Group calls with cameras and screen sharing, through the server's own call service.",
         "reason": (f"{_people(call_people, 40).capitalize()} people on camera at once"
                    + (f", or a screen share to {_people(share_viewers, 50)} {'person' if share_viewers == 1 else 'people'}"
                       if down is not None and share_viewers >= 1 else "")
                    + (". Measured from this device; " + ("plenty for a family or friend group." if calls_l == "good"
                       else "fine for a few people." if calls_l == "warn" else "too slow for camera calls.")
                       if down is not None else " (the network wasn't measured).")),
         "control": {"type": "toggle", "value": calls_l != "bad", "recommended": calls_l != "bad"}},
        {"id": "previews", "name": "Link previews", "level": "good" if online else "off",
         "what": "A title and picture under links people post. The server fetches the page, so your devices never contact the website.",
         "reason": "The server is online." if online else "Needs the server to be online. It isn't, so this stays off for now.",
         "control": {"type": "toggle", "value": online, "recommended": online, "locked": not online}},
        {"id": "uploads", "name": "Biggest file people can send", "level": _lvl(free, 20, 8),
         "what": "The size limit for one photo, video or file.",
         "reason": (f"{free:.0f} GB free, so {upload_rec if upload_rec < 1000 else upload_rec // 1000} "
                    f"{'MB' if upload_rec < 1000 else 'GB'} per file is a sensible limit."
                    + ("" if free >= 8 else " Give the server a bigger disk if you can.")),
         "control": {"type": "select", "value": upload_rec, "recommended": upload_rec,
                     "options": [{"value": v, "label": f"{v} MB" if v < 1000 else f"{v // 1000} GB"} for v in UPLOAD_CHOICES]}},
        {"id": "directory", "name": "Find people by name", "level": "yours",
         "what": "Anyone on your server can search for everyone else on it when starting a chat.",
         "reason": "Usual for a server shared by friends or family. Turn off if people should only find those they share a room with.",
         "control": {"type": "toggle", "value": True, "recommended": True}},
        {"id": "watch", "name": "Watch together", "level": "good" if online else "warn",
         "what": "Media Party: everyone in a room watches the same video in sync.",
         "reason": "Works with YouTube and video links." if online
         else "Works with videos on your own network. YouTube needs the server's network to reach the internet.",
         "control": {"type": "info"}},
        {"id": "memories", "name": "Memories (call recordings)", "level": "off",
         "what": "Record calls and watch them back later.",
         "reason": "Coming in a later update. " + ("This server is big enough for it." if mem_rec else
                   f"It will need {'4 processor cores, ' if cores < 4 else ''}100 GB free{' and a faster disk' if (write or 0) < 80 else ''} "
                   f"(this server has {free:.0f} GB)."),
         "control": {"type": "soon"}},
    ]
    ready = ram >= 1.8 and free >= 4
    calls_text = (f"Calls with {_people(call_people, 40)} people on camera at once." if down is not None
                  else f"Calls with up to {_people(call_people, 40)} people.")
    return {
        "ready": ready,
        "headline": ("This machine is a good fit for a Tin Hat server." if ready and _worst(cpu_l, mem_l, disk_l) == "good"
                     else "This machine can run Tin Hat Server, with some limits." if ready
                     else "This machine is too small for Tin Hat Server."),
        "checks": checks,
        "features": features,
        # the dashboard's "What this server can do"
        "verdicts": [
            {"id": "chat", "level": chat_l, "text": (f"Chat for about {chat_people} people." if chat_l == "good" else chat_reason)
             if ram >= 1.8 else chat_reason},
            {"id": "calls", "level": calls_l, "text": calls_text},
            {"id": "storage", "level": disk_l, "text": f"Room for about {max(0, int(free - 5))} GB of shared photos and files."},
            {"id": "internet", "level": checks[-1]["level"], "text": checks[-1]["text"]},
        ],
        "chat_people": chat_people,
        "call_people": call_people,
    }

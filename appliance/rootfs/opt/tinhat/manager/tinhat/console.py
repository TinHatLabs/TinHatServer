"""The text on the server's own screen (the VM console): where to go and the setup code.

agetty prints /etc/issue + /etc/issue.d/*.issue above the login prompt; `agetty --reload` redraws it. The
manager calls refresh() every few seconds, and only rewrites the file when the text changes (a new address
from DHCP, setup finishing, …). ASCII only: the Linux console's font has no box-drawing guarantees.
"""
import socket
import subprocess
from pathlib import Path

from . import config, hw, mdns, state

ISSUE = Path("/etc/issue.d/50-tinhat.issue")
_last = None


def text() -> str:
    st = state.load_state()
    addrs = hw.addresses()
    rule = "=" * 64
    lines = ["", rule]
    from . import recovery
    code = recovery.active() if st.get("phase") == "ready" else None
    if code:
        lines += [
            "  Someone asked to reset an admin password (\"Forgot your password?\").",
            "  If that was you, type this code on that page:",
            "",
            f"      {code}      (works for {recovery.minutes_left()} more minutes)",
            "",
            "  If it wasn't you, ignore it: nothing changes without the code.",
            rule,
        ]
    if st.get("phase") == "ready" and (st.get("names_status") or {}).get("status") == "moved":
        name = st.get("server_name", "")
        lines += [
            f'  Tin Hat Server "{name}" moved to another computer.',
            "",
            "  It was restored there from a backup, so chat and calls stopped here.",
            "  When the other computer works, you can switch this one off.",
            "",
        ]
        if addrs:
            lines += [f"  This computer's dashboard: http://{addrs[0]}/admin", ""]
    elif st.get("phase") == "ready":
        name = st.get("server_name", "")
        lines += [
            f'  Tin Hat Server "{name}" is running.',
            "",
            f"  Tin Hat:      https://{name}",
            f"  Dashboard:    https://{name}/admin",
        ]
        if st.get("mode") == "anywhere":
            lines += [f"  Friends type: {name.split('.')[0]}"]
        elif st.get("mode") == "domain":
            lines += [f"  Friends type: {name}"]
        else:
            lines += [f"  New devices:  http://{name}  (trust the server, then open Tin Hat)"]
        if addrs:
            lines += [f"  Address:      {', '.join(addrs)}"]
        lines += ["", "  (No need to log in below: the dashboard is in the browser.)"]
    else:
        host = socket.gethostname()
        lines += ["  Tin Hat Server is ready to set up.", ""]
        if addrs:
            lines += [
                "  On a computer or phone on the same network, open:",
                "",
                f"      http://{mdns.own_name() or host + '.local'}      or      http://{addrs[0]}",
                "",
                f"  Setup code:   {state.setup_code()}",
                "",
                "  (No need to log in below: everything happens in the browser.)",
            ]
        else:
            lines += ["  Waiting for a network connection (is the network cable or adapter connected?)"]
    lines += [rule, "", ""]
    # ESC[H ESC[2J: start from a clean screen each time agetty redraws, so only the current banner is there.
    return "\x1b[H\x1b[2J" + "\n".join(lines)


def refresh(force: bool = False) -> None:
    global _last
    if config.own_machine():  # someone's own machine: its console is theirs (codes: sudo tinhat setup-code)
        return
    if hw.windows():  # Tin Hat Server for Windows has no console: the installer and the tray icon show the codes
        return
    t = text()
    if t == _last and not force:
        return
    try:
        ISSUE.parent.mkdir(parents=True, exist_ok=True)
        ISSUE.write_text(t)
        _last = t
        subprocess.run(["agetty", "--reload"], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass

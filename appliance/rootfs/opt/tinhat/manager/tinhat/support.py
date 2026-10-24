"""The support report: what someone helping the owner needs to know, as plain text the owner can read before sending.

In it: versions, the services and their state, the machine (cores, memory, disk), the network summary (the public
address with its last part hidden), updates and backups (results only), and the manager's recent warnings and errors.
Never in it: passwords, keys, tokens, invite or server codes, people's names, rooms or messages.
"""
import asyncio
import ipaddress
import re
import subprocess
import time

from . import backup, compose, config, hw, state, updates

SECRETISH = re.compile(r"(TN-[A-Z2-9]{4}-[A-Z2-9]{4}|TC-[A-Z2-9]{4}-[A-Z2-9]{4}|[A-Za-z0-9_-]{32,}|syt_[A-Za-z0-9_]+)")


def _mask(ip: str | None) -> str:
    try:
        a = ipaddress.ip_address(ip or "")
    except ValueError:
        return "-"
    if a.is_private:
        return str(a)
    parts = str(a).split(".")
    return ".".join(parts[:2] + ["x", "x"]) if a.version == 4 else str(a).rsplit(":", 4)[0] + ":…"


def _t(ts) -> str:
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ts)) if ts else "never"


def _recent_problems(lines: int = 40) -> list[str]:
    r = subprocess.run(["journalctl", "-u", "tinhat-manager", "--since", "-3 days", "-p", "warning", "--no-pager",
                        "-o", "short-iso", "-n", str(lines)], capture_output=True, text=True, timeout=30)
    return [SECRETISH.sub("…", x) for x in r.stdout.splitlines() if x.strip()][-lines:]


async def report() -> str:
    st = state.load_state()
    ps = await compose.ps()
    p = await asyncio.to_thread(hw.probe)
    out = [f"Tin Hat Server support report — {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}",
           "(No passwords, keys, codes, people or messages are in this report.)", "",
           f"Version: {config.VERSION}   Mode: {st.get('mode')}   Set up: {st.get('installed_at')}",
           f"Machine: {p.get('cpu', {}).get('cores')} cores, memory {round((p.get('memory') or {}).get('total', 0) / 2**30, 1)} GB, "
           f"disk free {round((p.get('disk') or {}).get('free', 0) / 2**30)} GB, online: {p.get('online')}",
           "", "Services:"]
    for svc in compose.SERVICES:
        i = ps.get(svc, {})
        out.append(f"  {compose.LABELS[svc]:<20} {i.get('state') or 'not running'} {i.get('health') or ''} {i.get('status') or ''}")
    if state.public_mode(st):
        prt, rch, nm = st.get("ports") or {}, st.get("reach") or {}, st.get("names_status") or {}
        out += ["", "Network:",
                f"  Name: {st.get('server_name')}  names service: {nm.get('status')} (checked {_t(nm.get('checked'))})",
                f"  Connection: {prt.get('kind')}  public {_mask(prt.get('public_ip'))}  router answered by: {prt.get('method')}",
                "  Ports: " + ", ".join(f"{m.get('proto')} {m.get('port')}: {'open' if m.get('ok') else (m.get('why') or 'no')}"
                                       for m in prt.get("mapped") or []),
                "  Outside check: " + ("reachable" if rch.get("ok") else ", ".join(f"{k} {v.get('why') or 'ok'}"
                                                                                 for k, v in (rch.get("results") or {}).items()))]
    u = updates.status()
    b = backup.status()
    out += ["", f"Updates: {u.get('phase')} (latest {u.get('latest')}, checked {_t(u.get('checked'))}) {u.get('message') or ''}"]
    for h in updates.history()[-3:]:
        out.append(f"  {time.strftime('%Y-%m-%d', time.gmtime(h['at']))} {h.get('kind')} {h.get('from', '')}→{h.get('to', '')} {h.get('result')}")
    out += [f"Backups: {(backup.settings() or {}).get('dest') or 'not set up'}; last "
            f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(b['last']['at'])) if b.get('last') else 'never'}; "
            f"{b.get('phase') or ''} {b.get('message') or ''}; test: {(b.get('test') or {}).get('ok')}"]
    out += ["", "Recent warnings and errors (manager):"] + [f"  {x}" for x in await asyncio.to_thread(_recent_problems)]
    return "\n".join(out) + "\n"

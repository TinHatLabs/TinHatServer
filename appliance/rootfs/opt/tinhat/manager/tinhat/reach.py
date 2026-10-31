"""Can friends outside the home reach this server? Open the ports, look at what kind of connection this is, then
have the names service check from outside (docs/REMOTE-ACCESS.md, "Wizard order").

The outside check needs the box to answer on each port while it's being checked: 443 is Caddy (the probe fetches
/.well-known/tinhat/probe/<nonce>, which the manager answers), and for calls the manager briefly stands in for
LiveKit on 7881/tcp and 7882/udp (LiveKit is paused for those few seconds).

Only a check someone asked for pauses LiveKit (setup, the dashboard's Check now, a relay change). The manager's own
checks (every 30 min while not reachable, after a port opened or was lost, through the relay) never touch it: a call
started in those seconds used to fail ("Unable to create room on SFU", BACKLOG-SERVER-037). They check HTTPS and TCP
7881 against the running LiveKit (the names service only connects there), and keep the last real UDP 7882 result
(UNCHECKED when there is none): UDP needs the manager's echo, which LiveKit doesn't give.
"""
import asyncio
import ipaddress
import logging
import secrets
import socket
import time

from . import compose, hw, names, owndomain, portmap, state

log = logging.getLogger("tinhat.reach")

PORTS_ALL = [("TCP", 443), ("TCP", 7881), ("UDP", 7882)]
CGNAT = ipaddress.ip_network("100.64.0.0/10")
XLAT = ipaddress.ip_network("192.0.0.0/29")  # 464XLAT (T-Mobile home internet)

#: an unattended check's word for UDP 7882 when no checked result can be kept: not a failure, not a pass
UNCHECKED = {"ok": None, "why": "unchecked"}


# Asked for too, but never needed: someone who types just the server's name into a browser that starts with http://
# reaches port 80, which sends them on to https (templates.CADDY_ANYWHERE). Never counted in "can friends reach it",
# never a reason to renew more often or to check again from outside.
OPTIONAL = [("TCP", 80)]


def wanted(calls: bool, proxy: bool = False) -> list[tuple[str, int]]:
    """Every port asked of the router: the needed ones, then the optional ones (behind the owner's own proxy, port 80
    is the proxy's, as 443 is)."""
    return ports(calls, proxy) + ([] if proxy else OPTIONAL)


def ports(calls: bool, proxy: bool = False) -> list[tuple[str, int]]:
    """The ports this box asks the router for. Behind the owner's own reverse proxy, 443 is the proxy's (the router
    already sends it there): only the call ports are this box's."""
    want = PORTS_ALL if calls else PORTS_ALL[:1]
    return [x for x in want if x != ("TCP", 443)] if proxy else want


def classify(router_ip: str | None, public_ip: str | None) -> str:
    """public | cgnat | double-nat | upstream-nat | unknown. ("direct", no router at all, is decided by Checker.)"""
    try:
        r = ipaddress.ip_address(router_ip) if router_ip else None
    except ValueError:
        r = None
    if r is None:
        return "unknown"
    if r in CGNAT or r in XLAT:
        return "cgnat"
    if r.is_private:
        return "double-nat"
    if public_ip and router_ip != public_ip:
        return "upstream-nat"
    return "public"


class _Echo(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.t = transport

    def datagram_received(self, data, addr):
        if data.startswith(b"tinhat-probe "):
            self.t.sendto(data, addr)


async def _stand_in(calls: bool, tcp_port: int = 7881, udp_port: int = 7882):
    """Answer on the call ports while LiveKit is paused; returns a closer. (Through the Tin Hat relay both are the
    relay's port number for this server.)"""
    if not calls:
        return lambda: None
    loop = asyncio.get_running_loop()
    udp, _ = await loop.create_datagram_endpoint(_Echo, local_addr=("0.0.0.0", udp_port))

    async def _accept(reader, writer):
        writer.close()
    tcp = await asyncio.start_server(_accept, "0.0.0.0", tcp_port)

    def close():
        udp.close()
        tcp.close()
    return close


class Checker:
    def __init__(self):
        self.nonces: set[str] = set()
        self.lock = asyncio.Lock()

    def answers(self, nonce: str) -> bool:
        return nonce in self.nonces

    async def open_ports(self, calls: bool) -> dict:
        from . import relay
        if relay.on():  # through the Tin Hat relay there's nothing for the router to open (relay.py)
            return state.load_state().get("ports") or {}
        public = await owndomain.public_ip()  # never a private address the router's NAT loopback hands back
        if public and public in hw.addresses():
            # The server has the public address itself (a machine plugged straight into the internet, or rented):
            # there's no router to ask.
            rep = {"at": int(time.time()), "gateway": None, "lan_ip": public, "method": None, "router": None,
                   "router_ip": public, "mapped": [], "public_ip": public, "kind": "direct"}
            state.save_state(ports=rep)
            return rep
        rep = await portmap.open_ports(wanted(calls, state.behind_proxy()), careful=frozenset(OPTIONAL))
        rep["public_ip"] = public
        rep["kind"] = classify(rep.get("router_ip"), public)
        state.save_state(ports=rep)
        return rep

    async def outside(self, calls: bool, unattended: bool = False) -> dict:
        """The real check, from the names service. Pauses calls for a few seconds when they're on, unless it is one of
        the manager's own (unattended): then LiveKit keeps running, TCP 7881 is checked against it and UDP 7882 keeps
        its last checked result (module docstring)."""
        from . import relay
        async with self.lock:
            relayed = relay.on()
            nonce = secrets.token_urlsafe(16)
            self.nonces.add(nonce)
            checks = ["tls443"] + (["tcp7881"] + ([] if unattended else ["udp7882"]) if calls else [])
            close = lambda: None  # noqa: E731
            paused = False
            try:
                if calls and not unattended:
                    rc, _ = await compose.run("stop", "livekit", timeout=60)
                    paused = rc == 0
                    await asyncio.sleep(0.5)
                    close = await _stand_in(True, *relay.call_ports())
                st = state.load_state()
                if st.get("mode") == "domain":  # no tinhat.me name: the open check (proof of work, no account)
                    res = await names.probe_open(st["server_name"], nonce, checks)
                    out = {"at": int(time.time()), "ok": all(v.get("ok") for v in res["results"].values()),
                           "results": res["results"], "public_ip": res.get("ip")}
                elif relayed:
                    res = await names.probe(nonce, checks)
                    out = {"at": int(time.time()), "ok": all(v.get("ok") for v in res["results"].values()),
                           "results": res["results"], "public_ip": res.get("ip")}
                else:
                    # the tinhat.me name has an A and/or an AAAA record (names.update speaks over both): check each
                    # family from outside, at once (one pause of the call server), with a nonce each
                    nonce6 = secrets.token_urlsafe(16)
                    self.nonces.add(nonce6)
                    try:
                        out = await _per_family(nonce, nonce6, checks)
                    finally:
                        self.nonces.discard(nonce6)
                    res = {}
                if relayed:  # the names service checked the relay's address, on this server's port there
                    out.update(via="relay", target=res.get("target"), ports=res.get("ports"))
            except names.NamesError as e:
                out = {"at": int(time.time()), "ok": False, "error": str(e), "results": {}}
            except OSError as e:
                out = {"at": int(time.time()), "ok": False, "error": f"Couldn't stand in for the call ports ({e}).",
                       "results": {}}
            finally:
                close()
                if paused:
                    await compose.up("livekit")
                self.nonces.discard(nonce)
            if relayed and "via" not in out:
                out["via"] = "relay"
            if calls and unattended:
                st = state.load_state()
                last = st.get("reach_udp")
                if last is None and (last := seed_udp(st.get("reach"))) is not None:
                    state.save_state(reach_udp=last)  # kept for good: the next check reads it here (found in the lab)
                out = keep_udp(out, last)
            elif calls and "udp7882" in (out.get("results") or {}):  # a real UDP answer: kept for later checks
                state.save_state(reach_udp={"at": out["at"], "route": route_of(out),
                                            "result": out["results"]["udp7882"]})
            state.save_state(reach=out)
            return out


def route_of(o: dict) -> list:
    """What a UDP answer was about: direct or through the relay, the public address, and through the relay its
    address and port. A result is only kept for the same route (a new relay place is a new question)."""
    return [o.get("via") or "direct", o.get("public_ip"), o.get("target"), o.get("ports")]


def seed_udp(prev: dict | None) -> dict | None:
    """A server updated from 0.3.9 has its last real UDP answer only in the last check (`reach`): taken from there
    once (its route and time), so the first unattended check after the update doesn't drop it (Astra round 2)."""
    prev = prev or {}
    udp = (prev.get("results") or {}).get("udp7882") or {}
    if udp.get("ok") is None or udp.get("why") == "unchecked" or udp.get("kept"):
        return None
    return {"at": prev.get("at"), "route": route_of(prev), "result": udp}


def _ok(res: dict) -> bool:
    """All checked results pass (an UNCHECKED one counts neither way); at least one was checked."""
    return all(v.get("ok") is not False for v in res.values()) and any(v.get("ok") for v in res.values())


def keep_udp(out: dict, last: dict | None) -> dict:
    """An unattended check's answer with UDP 7882 put in from the last check that really checked it (state
    `reach_udp`, which a failed or offline check never erases), marked `kept` with when that was, if it was about the
    same route (route_of); otherwise UNCHECKED. `ok` is worked out again (a kept failure keeps it false), and the
    IPv4 family's too (UDP is only ever checked over IPv4: the stand-ins listen on IPv4)."""
    if not out.get("results"):  # the check itself didn't run (names service offline, …): nothing to add
        return out
    last = last or {}
    old = last.get("result") or {}
    if last.get("route") == route_of(out) and old.get("ok") is not None and old.get("why") != "unchecked":
        udp = {**{k: v for k, v in old.items() if k != "kept"}, "kept": last.get("at")}
    else:
        udp = dict(UNCHECKED)
    res = {**out["results"], "udp7882": udp}
    new = {**out, "results": res, "ok": _ok(res)}
    fams = out.get("families")
    if fams and (fams.get("ipv4") or {}).get("results"):
        v4res = {**fams["ipv4"]["results"], "udp7882": udp}
        new["families"] = {**fams, "ipv4": {**fams["ipv4"], "results": v4res, "ok": _ok(v4res)}}
    return new


def recheck_due(o: dict) -> bool:
    """Whether the manager's own (unattended) checks should look again: something they can see failed or wasn't
    checked. A UDP failure kept from an earlier full check isn't one of those (only Check now can look at it), so it
    alone never keeps them going every 10 / 30 minutes."""
    res = {k: v for k, v in (o.get("results") or {}).items()
           if not (k == "udp7882" and (v.get("kept") or v.get("why") == "unchecked"))}
    return not res or not _ok(res) or bool(o.get("error"))


async def _per_family(nonce4: str, nonce6: str, checks: list[str]) -> dict:
    """The outside check over IPv4 and IPv6 (assembly-038). The overall answer is IPv4's when the box has an IPv4 route
    (what every friend can use), else IPv6's; `families` keeps both; `only_ipv6` says when IPv4 couldn't be checked at
    all (no IPv4 route to the names service): then IPv4-only friends can't connect."""
    async def one(nonce: str, fam: int) -> dict:
        # IPv6: HTTPS only (the call ports' stand-ins listen on IPv4 only), and a shorter bound, so a black-holed IPv6
        # path can't keep the call server paused much longer than before (Astra, assembly-038)
        cks, tmo = (checks, 45) if fam == socket.AF_INET else ([c for c in checks if c == "tls443"], 25)
        try:
            r = await names.probe(nonce, cks, family=fam, timeout=tmo)
            return {"ok": all(v.get("ok") for v in r["results"].values()), "results": r["results"], "ip": r.get("ip")}
        except names.NamesError as e:
            return {"ok": False, "results": {}, "error": str(e), "offline": e.code == "offline"}
    v4, v6 = await asyncio.gather(one(nonce4, socket.AF_INET), one(nonce6, socket.AF_INET6))
    fams = {"ipv4": v4, "ipv6": v6}
    if v4.get("offline") and v6.get("offline"):
        raise names.NamesError(v4.get("error") or "Can't reach the Tin Hat names service.", "offline")
    main = v6 if v4.get("offline") else v4
    out = {"at": int(time.time()), "ok": main["ok"], "results": main["results"], "public_ip": main.get("ip"),
           "families": {k: {x: v.get(x) for x in ("ok", "ip", "error", "offline") if v.get(x) is not None} | {"results": v["results"]}
                        for k, v in fams.items()}}
    if v4.get("offline") and v6.get("ok"):
        out["only_ipv6"] = True
    if "error" in main and not main["results"]:
        out["error"] = main["error"]
    return out


def udp_lines(o: dict) -> list[str]:
    """What an unattended check (it never pauses calls) says about UDP 7882, which only a check you start looks at."""
    if o.get("error") or not o.get("results"):
        return []
    udp = (o.get("results") or {}).get("udp7882") or {}
    if udp.get("why") == "unchecked":
        return ["Calls over UDP (7882) haven't been checked from outside yet: the automatic checks leave them out, "
                "because checking them pauses calls for about 10 seconds. Press Check again when nobody is in a call."]
    if udp.get("kept") and udp.get("ok") is False:
        return ["Calls over UDP (7882) didn't reach your server at the last full check. The automatic checks don't "
                "look at them again (that pauses calls for about 10 seconds): press Check again once they're open."]
    return []


def family_lines(o: dict) -> list[str]:
    """What the per-family check adds to the words (assembly-038)."""
    f = o.get("families") or {}
    v4, v6 = f.get("ipv4") or {}, f.get("ipv6") or {}
    if o.get("only_ipv6"):
        return ["The check over IPv4 didn't get through (this server may have no IPv4 connection to the outside); "
                "over IPv6 friends can reach it. Friends whose internet has no IPv6 may not be able to connect."]
    if v4.get("ok") and v6 and not v6.get("offline") and not v6.get("ok"):
        return [f"Over IPv6 ({v6.get('ip') or 'its IPv6 address'}) HTTPS isn't reachable from outside; friends connect "
                "over IPv4 instead (a firewall rule for IPv6 would let them use it)."]
    https4 = ((v4.get("results") or {}).get("tls443") or {}).get("ok")
    https6 = ((v6.get("results") or {}).get("tls443") or {}).get("ok")
    if https6 and not https4 and not v4.get("offline"):
        return ["Over IPv6 friends can reach this server's HTTPS; over IPv4 they can't yet (below)."]
    return []


CHECK_KEY = {("TCP", 443): "tls443", ("TCP", 7881): "tcp7881", ("UDP", 7882): "udp7882"}


def _list(keys) -> str:
    return ", ".join(f"{proto} {port}" for proto, port in keys)


def summary(ports_rep: dict | None, outside: dict | None, proxy: dict | None = None) -> dict:
    """_summary plus what the per-family check adds (assembly-038): said plainly when only IPv6 reaches the server."""
    out = _summary(ports_rep, outside, proxy)
    extra = [x for x in family_lines(outside or {}) + udp_lines(outside or {}) if x not in out.get("lines", [])]
    if extra:
        out = {**out, "lines": list(out.get("lines") or []) + extra}
    o = outside or {}
    if o.get("only_ipv6") and out.get("level") == "good":
        out = {**out, "level": "warn", "headline": "Friends with IPv6 can reach your server; friends without it can't yet."}
    v6 = (o.get("families") or {}).get("ipv6") or {}
    if (ports_rep or {}).get("kind") == "cgnat" and ((v6.get("results") or {}).get("tls443") or {}).get("ok"):
        out = {**out, "level": "warn", "headline": "Over IPv4 your provider blocks incoming connections; friends with "
                                                   "IPv6 can still reach your server."}
    return out


def _summary(ports_rep: dict | None, outside: dict | None, proxy: dict | None = None) -> dict:
    """What the wizard and the dashboard say, in words, plus the exact router settings if they must be set by hand.

    Per port it puts together what the router answered (opened it / another device holds it / refused / no answer)
    with what the outside check saw, so the words match what actually happened. proxy: {"serverName", "lanIp",
    "port"} behind the owner's own reverse proxy, where HTTPS is the proxy's job and not a router setting."""
    p, o = ports_rep or {}, outside or {}
    kind = p.get("kind", "unknown")
    if o.get("via") == "relay":  # through the Tin Hat relay: its own words (relay.py)
        from . import relay
        return relay.summary(o)
    if o.get("ok"):
        return {"level": "good", "headline": "Friends outside can reach this server.", "lines": [], "fix": []}
    if kind == "cgnat":
        return {"level": "bad", "headline": "Your internet provider doesn't allow incoming connections.",
                "lines": ["It shares one public address between many homes (\"carrier NAT\"). T-Mobile and Verizon 5G "
                          "home internet, AT&T Internet Air and Starlink usually do this, so nothing from outside can "
                          "reach your home.", "People on your home network can still use the server."], "fix": []}
    res = o.get("results") or {}
    lines, fix = [], []
    if kind == "direct":
        blocked = [k for k, key in CHECK_KEY.items() if key in res and res[key].get("ok") is False]
        lines = [o["error"]] if o.get("error") else []
        if blocked:
            lines.append(f"These ports don't reach your server from outside yet: {_list(blocked)}. This server has its own "
                         "public address, so there's no router to open; something in front of it filters traffic (a "
                         "hosting provider's firewall, or the machine's own). Let these ports in there.")
        level = "warn" if (res.get("tls443") or {}).get("ok") else "bad"
        return {"level": level, "lines": lines, "fix": [],
                "headline": "Friends outside can chat, but calls from outside may not connect." if level == "warn"
                else "Friends outside can't reach your server yet."}
    cert = (res.get("tls443") or {}).get("why") == "certificate"
    if cert:
        lines.append("Your server's certificate isn't valid yet. It renews by itself; check again in a few minutes.")
    if o.get("error"):
        lines.append(o["error"])
    blocked = [k for k, key in CHECK_KEY.items() if key in res and res[key].get("ok") is False and not (key == "tls443" and cert)]
    if proxy and ("TCP", 443) in blocked:
        blocked.remove(("TCP", 443))
        lines.append(f"Your reverse proxy doesn't pass https://{proxy['serverName']} on to this server yet. Point it at "
                     f"http://{proxy['lanIp']}:{proxy['port']} (this page has the settings for nginx, Caddy, Traefik and "
                     "Nginx Proxy Manager), and check that your router sends TCP 443 to the proxy and the domain points "
                     "at your home.")
    m = {(x.get("proto"), x.get("port")): x for x in p.get("mapped") or []}
    lan = p.get("lan_ip") or "this server's address"
    double = kind in ("double-nat", "upstream-nat")
    if kind == "double-nat":
        lines.append("There are two routers in a row (your provider's box, then your own router or mesh). Turn on "
                     "\"bridge mode\" or \"IP passthrough\" on the provider's box, or forward the ports on both.")
    if blocked:
        lines.append(f"These ports don't reach your server from outside yet: {_list(blocked)}.")
        taken = [k for k in blocked if m.get(k, {}).get("taken")]
        opened = [k for k in blocked if m.get(k, {}).get("ok")]
        refused = [k for k in blocked if k in m and not m[k].get("ok") and not m[k].get("taken")]
        if taken:
            holders = sorted({m[k]["holder"] for k in taken if m[k].get("holder")})
            who = "another device" + (f" ({', '.join(holders)})" if holders else "")
            line = f"Your router already sends {_list(taken)} to {who}, so it can't send {'it' if len(taken) == 1 else 'them'} here."
            if any(m[k].get("holder_tinhat") for k in taken):
                leases = [m[k].get("holder_lease") for k in taken if m[k].get("holder_tinhat")]
                if leases and all(isinstance(x, int) for x in leases) and min(leases) == 0:
                    line += (" It's another Tin Hat Server: an earlier setup of this one, the computer it moved from, or "
                             "another server in your home. This router keeps those ports until they're removed (below).")
                else:
                    left = max((x for x in leases if isinstance(x, int)), default=None)
                    if left is not None:  # the lease as the router told it at the last renewal, counted down to now
                        left -= max(0, int(time.time()) - int(p.get("at") or time.time()))
                    mins = round(left / 60) if left is not None else None
                    when = ("any moment now" if left is not None and left <= 60
                            else f"in about {mins} minute{'s' if mins != 1 else ''}" if left is not None else "within an hour")
                    line += (" It's an earlier Tin Hat Server: this same computer before it was set up again, the computer "
                             "this server moved from, or another server in your home. If it's off, the router lets go of the "
                             f"ports {when}, and this server takes them by itself.")
            lines.append(line)
            for k in taken:
                h = m[k].get("holder")
                fix.append(f"Remove the forward of {k[0]} port {k[1]}" + (f" to {h}" if h else "")
                           + " (in the router's settings, usually under port forwarding or UPnP)")
        if opened:
            if double:
                lines.append(f"Your router opened {_list(opened)}, but the provider's box in front of it doesn't pass "
                             f"{'it' if len(opened) == 1 else 'them'} on.")
            else:
                lines.append(f"Your router opened {_list(opened)}, but {'it still doesn' if len(opened) == 1 else 'they still don'}'t "
                             "reach your server. A firewall setting in the router, or your internet provider, may be "
                             "blocking incoming connections on these ports.")
        if refused:
            whys = sorted({m[k].get("why") for k in refused if m[k].get("why")})
            lines.append(f"Your router didn't open {_list(refused)} automatically" + (f" ({'; '.join(whys)})" if whys else "")
                         + ", so set them by hand.")
        if not p.get("method"):
            lines.append("Your router didn't answer the automatic request (UPnP / NAT-PMP is off or not supported), "
                         "so set them by hand.")
        by_hand = [k for k in blocked if k in taken or k in refused or not p.get("method") or (k in opened and double)]
        fix += [f"Forward {proto} port {port} to {lan}, port {port}" for proto, port in by_hand]
        if by_hand:
            fix.append(f"Give {lan} a fixed address (\"DHCP reservation\") in the router, so the forwards keep working.")
    if p.get("router") or p.get("gateway"):
        r = p.get("router") or {}
        name = " ".join(x for x in (r.get("maker"), r.get("model")) if x) or r.get("name")
        where = f"its settings are usually at http://{p['gateway']}" if p.get("gateway") else ""
        if name or where:
            lines.append("Your router: " + ", ".join(x for x in (name, where) if x) + ".")
    level = "warn" if (res.get("tls443") or {}).get("ok") else "bad"
    head = ("Friends outside can chat, but calls from outside may not connect." if level == "warn"
            else "Friends outside can't reach this server yet.")
    return {"level": level, "headline": head, "lines": lines, "fix": fix}

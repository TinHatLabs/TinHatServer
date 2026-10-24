"""Can friends outside the home reach this server? Open the ports, look at what kind of connection this is, then
have the names service check from outside (docs/REMOTE-ACCESS.md, "Wizard order").

The outside check needs the box to answer on each port while it's being checked: 443 is Caddy (the probe fetches
/.well-known/tinhat/probe/<nonce>, which the manager answers), and for calls the manager briefly stands in for
LiveKit on 7881/tcp and 7882/udp (LiveKit is paused for those few seconds).
"""
import asyncio
import ipaddress
import logging
import secrets
import time

from . import compose, hw, names, owndomain, portmap, state

log = logging.getLogger("tinhat.reach")

PORTS_ALL = [("TCP", 443), ("TCP", 7881), ("UDP", 7882)]
CGNAT = ipaddress.ip_network("100.64.0.0/10")
XLAT = ipaddress.ip_network("192.0.0.0/29")  # 464XLAT (T-Mobile home internet)


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

    async def outside(self, calls: bool) -> dict:
        """The real check, from the names service. Pauses calls for a few seconds when they're on."""
        from . import relay
        async with self.lock:
            relayed = relay.on()
            nonce = secrets.token_urlsafe(16)
            self.nonces.add(nonce)
            checks = ["tls443"] + (["tcp7881", "udp7882"] if calls else [])
            close = lambda: None  # noqa: E731
            paused = False
            try:
                if calls:
                    rc, _ = await compose.run("stop", "livekit", timeout=60)
                    paused = rc == 0
                    await asyncio.sleep(0.5)
                    close = await _stand_in(True, *relay.call_ports())
                st = state.load_state()
                if st.get("mode") == "domain":  # no tinhat.me name: the open check (proof of work, no account)
                    res = await names.probe_open(st["server_name"], nonce, checks)
                else:
                    res = await names.probe(nonce, checks)
                out = {"at": int(time.time()), "ok": all(v.get("ok") for v in res["results"].values()),
                       "results": res["results"], "public_ip": res.get("ip")}
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
            state.save_state(reach=out)
            return out


CHECK_KEY = {("TCP", 443): "tls443", ("TCP", 7881): "tcp7881", ("UDP", 7882): "udp7882"}


def _list(keys) -> str:
    return ", ".join(f"{proto} {port}" for proto, port in keys)


def summary(ports_rep: dict | None, outside: dict | None, proxy: dict | None = None) -> dict:
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
        return {"level": "good", "headline": "Friends outside your home can reach your server.", "lines": [], "fix": []}
    if kind == "cgnat":
        return {"level": "bad", "headline": "Your internet provider doesn't allow incoming connections.",
                "lines": ["It shares one public address between many homes (\"carrier NAT\"). T-Mobile and Verizon 5G "
                          "home internet, AT&T Internet Air and Starlink usually do this, so nothing from outside can "
                          "reach your home.", "People on your home network can still use the server."], "fix": []}
    res = o.get("results") or {}
    lines, fix = [], []
    if kind == "direct":
        blocked = [k for k, key in CHECK_KEY.items() if key in res and not res[key].get("ok")]
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
    blocked = [k for k, key in CHECK_KEY.items() if key in res and not res[key].get("ok") and not (key == "tls443" and cert)]
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
    head = ("Friends outside your home can chat, but calls from outside may not connect." if level == "warn"
            else "Friends outside your home can't reach your server yet.")
    return {"level": level, "headline": head, "lines": lines, "fix": fix}

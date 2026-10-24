"""Open the server's ports on the home router by asking it: UPnP-IGD first, then NAT-PMP (RFC 6886).

Most consumer routers do one of these (eero, Google/Nest Wifi, Netgear, Xfinity's gateways have UPnP on by default;
AT&T's gateways don't). The router also tells us its own outside address, which is how carrier NAT and a second
router in the house get noticed (reach.classify).

Mappings are leased short (UPnP 10 minutes, or permanent if that's all the router does; NAT-PMP 20) and renewed every
5 minutes (every 2 while one is missing), so when a server is reinstalled with a new address, its old mappings run out
within minutes even on routers that won't let the new one delete them.

A port another device already holds is never taken from it, with one exception: a mapping an earlier Tin Hat Server
made for a machine that no longer answers (a reinstall that got a new address). The owner is told who holds the rest.
A NAT-PMP router may hand out a different outside port when the one asked for is taken; friends always dial the
standard ports, so that mapping is given back at once.
"""
import asyncio
import ipaddress
import logging
import re
import socket
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlparse

import aiohttp

log = logging.getLogger("tinhat.portmap")

SSDP_ADDR = ("239.255.255.250", 1900)
IGD_TYPES = ("urn:schemas-upnp-org:device:InternetGatewayDevice:2", "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
             "urn:schemas-upnp-org:service:WANIPConnection:1")
WAN_SERVICES = ("urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1",
                "urn:schemas-upnp-org:service:WANPPPConnection:1")
# Where routers usually describe their UPnP service, asked only of the gateway itself when no router answers the
# discovery search: some (a Netgear Orbi, for one) run UPnP but never answer the search.
GATEWAY_DESCRIPTIONS = ((5000, "/rootDesc.xml"), (49000, "/igddesc.xml"), (1900, "/rootDesc.xml"), (1900, "/gateway.xml"),
                        (49152, "/rootDesc.xml"))
UPNP_LEASE = 600
NATPMP_LEASE = 1200
DESC = "Tin Hat Server"


def gateway() -> str | None:
    try:
        out = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"default via (\d+\.\d+\.\d+\.\d+)", out)
    return m.group(1) if m else None


def lan_ip(towards: str) -> str | None:
    """The address this box uses to reach `towards` (the router), i.e. where forwarded ports must point."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((towards, 9))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


# ---- UPnP-IGD ------------------------------------------------------------------------------------------------------

class IGD:
    def __init__(self, control: str, service: str, name: str, maker: str, model: str):
        self.control, self.service, self.name, self.maker, self.model = control, service, name, maker, model

    def describe(self) -> dict:
        return {"name": self.name, "maker": self.maker, "model": self.model}


class _SSDP(asyncio.DatagramProtocol):
    def __init__(self):
        self.locations: list[str] = []

    def datagram_received(self, data, addr):
        m = re.search(rb"(?im)^location:\s*(\S+)", data)
        if m:
            loc = m.group(1).decode(errors="replace")
            if loc not in self.locations:
                self.locations.append(loc)


async def discover(timeout: float = 2.5, local: str | None = None, gw: str | None = None) -> IGD | None:
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    if local:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(local))
    sock.bind(("", 0))
    transport, proto = await loop.create_datagram_endpoint(_SSDP, sock=sock)
    try:
        for st in IGD_TYPES:
            msg = (f'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n'
                   f"ST: {st}\r\n\r\n").encode()
            transport.sendto(msg, SSDP_ADDR)
        await asyncio.sleep(timeout)
    finally:
        transport.close()
    for loc in proto.locations:
        igd = await _describe(loc)
        if igd:
            return igd
    if gw and not proto.locations:  # nobody answered the search: the router's usual description addresses, itself only
        return await _from_gateway(gw)
    return None


async def _from_gateway(gw: str) -> IGD | None:
    """The gateway's own UPnP description at the addresses routers usually use (GATEWAY_DESCRIPTIONS)."""
    try:
        if ipaddress.ip_address(gw).version != 4:
            return None
    except ValueError:
        return None
    for port, path in GATEWAY_DESCRIPTIONS:
        igd = await _describe(f"http://{gw}:{port}{path}", 2)
        if igd:
            log.info("UPnP router found at %s:%s (it didn't answer the discovery search)", gw, port)
            return igd
    return None


DESCRIPTION_MAX = 256 * 1024  # a router's description is a few KB


async def _describe(location: str, timeout: float = 5) -> IGD | None:
    """The router's UPnP description at `location`: never a redirect (it could point anywhere), at most
    DESCRIPTION_MAX bytes, as sent (no decompression)."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), auto_decompress=False) as s:
            async with s.get(location, allow_redirects=False) as r:
                if r.status != 200:
                    return None
                body = await r.content.read(DESCRIPTION_MAX + 1)
                if len(body) > DESCRIPTION_MAX:
                    return None
                xml = body.decode("utf-8", errors="replace")
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    ns = {"d": "urn:schemas-upnp-org:device-1-0"}
    base = (root.findtext("d:URLBase", default="", namespaces=ns) or "").strip() or location
    dev = root.find("d:device", ns)
    name = maker = model = ""
    if dev is not None:
        name = dev.findtext("d:friendlyName", default="", namespaces=ns)
        maker = dev.findtext("d:manufacturer", default="", namespaces=ns)
        model = dev.findtext("d:modelName", default="", namespaces=ns)
    for svc in root.iter("{urn:schemas-upnp-org:device-1-0}service"):
        stype = svc.findtext("d:serviceType", default="", namespaces=ns)
        if stype in WAN_SERVICES:
            ctl = svc.findtext("d:controlURL", default="", namespaces=ns)
            return IGD(urljoin(base, ctl), stype, name, maker, model)
    return None


async def _soap(igd: IGD, action: str, args: dict) -> tuple[bool, dict]:
    body = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    env = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
           's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
           f'<u:{action} xmlns:u="{igd.service}">{body}</u:{action}></s:Body></s:Envelope>')
    headers = {"Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{igd.service}#{action}"'}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as s:
            async with s.post(igd.control, data=env.encode(), headers=headers) as r:
                text = await r.text()
                status = r.status
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
        return False, {"error": type(e).__name__}
    out = {}
    try:
        for el in ET.fromstring(text).iter():
            tag = el.tag.split("}")[-1]
            if el.text and tag not in ("Envelope", "Body"):
                out[tag] = el.text.strip()
    except ET.ParseError:
        pass
    if status != 200:
        return False, {"error": out.get("errorCode", str(status)), "description": out.get("errorDescription", "")}
    return True, out


async def upnp_external_ip(igd: IGD) -> str | None:
    ok, out = await _soap(igd, "GetExternalIPAddress", {})
    return out.get("NewExternalIPAddress") if ok else None


async def upnp_holder(igd: IGD, proto: str, port: int) -> dict | None:
    """Who the router sends this outside port to now (GetSpecificPortMappingEntry), or None."""
    ok, out = await _soap(igd, "GetSpecificPortMappingEntry", {"NewRemoteHost": "", "NewExternalPort": port, "NewProtocol": proto})
    if not ok or not out.get("NewInternalClient"):
        return None
    try:
        lease, iport = int(out.get("NewLeaseDuration") or 0), int(out.get("NewInternalPort") or 0)
    except ValueError:
        lease, iport = 0, 0
    return {"client": out["NewInternalClient"], "port": iport, "desc": out.get("NewPortMappingDescription") or "", "lease": lease}


async def upnp_lookup(igd: IGD, proto: str, port: int) -> tuple[str, dict | None]:
    """("free", None) when the router says nobody has this outside port (NoSuchEntryInArray), ("held", holder) when
    someone does, ("unknown", None) when the router didn't say either way."""
    ok, out = await _soap(igd, "GetSpecificPortMappingEntry", {"NewRemoteHost": "", "NewExternalPort": port, "NewProtocol": proto})
    if ok and out.get("NewInternalClient"):
        try:
            lease, iport = int(out.get("NewLeaseDuration") or 0), int(out.get("NewInternalPort") or 0)
        except ValueError:
            lease, iport = 0, 0
        return "held", {"client": out["NewInternalClient"], "port": iport, "desc": out.get("NewPortMappingDescription") or "",
                        "lease": lease}
    if not ok and out.get("error") == "714":
        return "free", None
    return "unknown", None


async def upnp_map(igd: IGD, proto: str, port: int, client: str) -> dict:
    """{ok, why, taken?, holder?, holder_tinhat?}."""
    args = {"NewRemoteHost": "", "NewExternalPort": port, "NewProtocol": proto, "NewInternalPort": port,
            "NewInternalClient": client, "NewEnabled": 1, "NewPortMappingDescription": f"{DESC} {proto} {port}",
            "NewLeaseDuration": UPNP_LEASE}
    ok, out = await _soap(igd, "AddPortMapping", args)
    if not ok and out.get("error") == "725":  # OnlyPermanentLeasesSupported
        args["NewLeaseDuration"] = 0
        ok, out = await _soap(igd, "AddPortMapping", args)
    if ok:
        return {"ok": True, "why": ""}
    code = out.get("error", "")
    if code == "718":  # ConflictInMappingEntry: someone holds it
        h = await upnp_holder(igd, proto, port)
        if h and h["client"] == client and h["port"] == port:
            return {"ok": True, "why": ""}  # it's ours already (some routers answer a renewal like this)
        r = {"ok": False, "why": "another device already uses this port on the router", "taken": True}
        if h:
            r.update(holder=h["client"], holder_tinhat=h["desc"].startswith(DESC), holder_lease=h["lease"])
        return r
    why = {"606": "the router refused (not allowed)", "729": "the router's own settings already use this port (a forward set by hand, say)"}.get(
        code, out.get("description") or f"error {code}")
    return {"ok": False, "why": why}


async def upnp_unmap(igd: IGD, proto: str, port: int) -> bool:
    ok, _ = await _soap(igd, "DeletePortMapping", {"NewRemoteHost": "", "NewExternalPort": port, "NewProtocol": proto})
    return ok


async def upnp_list(igd: IGD, limit: int = 128) -> list[dict]:
    """Every mapping the router lists (GetGenericPortMappingEntry 0, 1, … until it says there are no more)."""
    out = []
    for i in range(limit):
        ok, e = await _soap(igd, "GetGenericPortMappingEntry", {"NewPortMappingIndex": i})
        if not ok:
            break
        try:
            out.append({"proto": (e.get("NewProtocol") or "").upper(), "ext": int(e.get("NewExternalPort") or 0),
                        "client": e.get("NewInternalClient") or "", "port": int(e.get("NewInternalPort") or 0),
                        "desc": e.get("NewPortMappingDescription") or ""})
        except ValueError:
            continue
    return out


async def _alive(ip: str, timeout: float = 1.5) -> bool:
    """Is a machine at this address on the home network? (It answers on 443, or at least refuses: either way it's up.)"""
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(ip, 443), timeout)
        w.close()
        return True
    except ConnectionRefusedError:
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def _upnp_tidy(igd: IGD, me: str, ports: list[tuple[str, int]]) -> list[int]:
    """Give back mappings that point here from an outside port we don't use (a NAT-PMP router's substitute port,
    or an older setup); returns the outside ports given back."""
    want = {(proto, port) for proto, port in ports}
    inner = {port for _, port in ports}
    freed = []
    for e in await upnp_list(igd):
        ours = e["desc"].startswith((DESC, "NAT-PMP", "PCP"))  # made by us or by the router's NAT-PMP/PCP, never by hand
        if ours and e["client"] == me and e["port"] in inner and (e["proto"], e["ext"]) not in want:
            if await upnp_unmap(igd, e["proto"], e["ext"]):
                freed.append(e["ext"])
    if freed:
        log.info("gave back stray router ports %s", freed)
    return freed


# ---- NAT-PMP -------------------------------------------------------------------------------------------------------

class _PMP(asyncio.DatagramProtocol):
    def __init__(self):
        self.reply = asyncio.get_running_loop().create_future()

    def datagram_received(self, data, addr):
        if not self.reply.done():
            self.reply.set_result(data)


async def _pmp(gw: str, req: bytes, want_len: int) -> bytes | None:
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(_PMP, remote_addr=(gw, 5351))
    try:
        wait = 0.25
        for _ in range(4):
            transport.sendto(req)
            try:
                data = await asyncio.wait_for(asyncio.shield(proto.reply), wait)
                return data if len(data) >= want_len else None
            except asyncio.TimeoutError:
                wait *= 2
        return None
    finally:
        transport.close()


async def natpmp_external_ip(gw: str) -> str | None:
    data = await _pmp(gw, b"\x00\x00", 12)
    if not data or data[1] != 128 or struct.unpack("!H", data[2:4])[0] != 0:
        return None
    return socket.inet_ntoa(data[8:12])


async def natpmp_map(gw: str, proto: str, port: int, lifetime: int = NATPMP_LEASE) -> dict:
    """{ok, why, taken?}. A substitute outside port is given back right away: friends dial the standard one."""
    op = 1 if proto == "UDP" else 2
    data = await _pmp(gw, struct.pack("!BBHHHI", 0, op, 0, port, port, lifetime), 16)
    if not data:
        return {"ok": False, "why": "no answer"}
    result = struct.unpack("!H", data[2:4])[0]
    if result != 0:
        return {"ok": False, "why": {1: "unsupported version", 2: "not authorized", 3: "router network failure",
                                     4: "out of resources", 5: "unsupported"}.get(result, f"error {result}")}
    mapped = struct.unpack("!H", data[10:12])[0]
    if mapped != port:
        await _pmp(gw, struct.pack("!BBHHHI", 0, op, 0, port, 0, 0), 16)  # lifetime 0 = give it back (RFC 6886 3.4)
        log.info("NAT-PMP offered %s %s instead of %s; gave it back", proto, mapped, port)
        return {"ok": False, "why": "another device already uses this port on the router", "taken": True}
    return {"ok": True, "why": ""}


# ---- the whole job ---------------------------------------------------------------------------------------------------

async def close_ports(ports: list[tuple[str, int]]) -> list[str]:
    """Give the router's ports back (this server moved to another computer): UPnP mappings that point at this
    machine are deleted, NAT-PMP ones asked back with a zero lifetime. Returns what was let go, for the log."""
    gw = gateway()
    me = lan_ip(gw) if gw else None
    if not gw or not me:
        return []
    done: list[str] = []
    igd = await discover(local=me, gw=gw)
    if igd:
        for proto, port in ports:
            h = await upnp_holder(igd, proto, port)
            # only this server's own mapping (this machine, the same port): 80 → this machine:8080 is another app's
            if h and h["client"] == me and h["port"] == port and await upnp_unmap(igd, proto, port):
                done.append(f"{proto} {port}")
    if await natpmp_external_ip(gw):
        for proto, port in ports:
            if f"{proto} {port}" not in done:
                op = 1 if proto == "UDP" else 2
                if await _pmp(gw, struct.pack("!BBHHHI", 0, op, 0, port, 0, 0), 16):
                    done.append(f"{proto} {port} (NAT-PMP)")
    return done


async def open_ports(ports: list[tuple[str, int]], careful: frozenset = frozenset()) -> dict:
    """Ask the router for each port: UPnP first, NAT-PMP for what UPnP couldn't do (never for a port another device
    holds: it can't help there, and it would hand out a substitute). Returns what happened, per port, for the wizard,
    the dashboard and reach.classify. `method` is how the router answered, even when it refused. Every port is looked
    at first and left alone when another device (or another app on this machine) has it; `careful` ports (the optional
    ones: port 80 is often a NAS's or another web server's) are also left alone when the router doesn't say."""
    gw = gateway()
    me = lan_ip(gw) if gw else None
    rep = {"at": int(time.time()), "gateway": gw, "lan_ip": me, "method": None, "router": None, "router_ip": None,
           "mapped": []}
    if not gw or not me:
        rep["problem"] = "no-router"
        return rep
    got: dict[tuple[str, int], dict] = {}
    igd = await discover(local=me, gw=gw)
    if igd:
        rep["router"] = igd.describe()
        # miniupnpd behind carrier NAT opens ports over UPnP but won't name its 100.64 address there; NAT-PMP does, and
        # that address is how carrier NAT is recognised (reach.classify).
        rep["router_ip"] = await upnp_external_ip(igd) or await natpmp_external_ip(gw)
        rep["method"] = "upnp"
        await _upnp_tidy(igd, me, ports)
        for proto, port in ports:
            # Look first: some routers overwrite a mapping instead of refusing it, so a port the router says another
            # device has (or this machine for another app: 443 → here:8443) is never asked for. The exception is an
            # earlier Tin Hat Server's that nobody answers on any more: given back, then ours. When the router doesn't
            # say (twice), a needed port is asked for as it always was: leaving it alone would leave servers behind
            # routers without the lookup unreachable (accepted: such a router that also overwrites could take another
            # device's mapping, as before); an optional one is left alone.
            seen, h = await upnp_lookup(igd, proto, port)
            if seen == "unknown":  # one more look (a busy router): a needed port is asked for only after that
                seen, h = await upnp_lookup(igd, proto, port)
            mine = seen == "held" and h["client"] == me and h["port"] == port
            if seen == "held" and not mine:
                if h["desc"].startswith(DESC) and h["client"] != me and not await _alive(h["client"]):
                    if await upnp_unmap(igd, proto, port):
                        log.info("took %s %s over from %s (an earlier Tin Hat Server, gone)", proto, port, h["client"])
                else:
                    got[(proto, port)] = {"proto": proto, "port": port, "via": "upnp", "ok": False, "taken": True,
                                          "why": "another device already uses this port on the router",
                                          "holder": h["client"], "holder_tinhat": h["desc"].startswith(DESC),
                                          "holder_lease": h["lease"]}
                    continue
            elif seen == "unknown" and (proto, port) in careful:
                got[(proto, port)] = {"proto": proto, "port": port, "via": "upnp", "ok": False, "left": True,
                                      "why": "the router didn't say whether another device uses this port"}
                continue
            r = await upnp_map(igd, proto, port, me)
            if r.get("taken") and r.get("holder_tinhat") and r.get("holder") and not await _alive(r["holder"]):
                # an earlier Tin Hat Server, on an address nobody answers on any more: take its ports over
                if await upnp_unmap(igd, proto, port):
                    again = await upnp_map(igd, proto, port, me)
                    if again["ok"]:
                        log.info("took %s %s over from %s (an earlier Tin Hat Server, gone)", proto, port, r["holder"])
                        r = {**again, "took_over": r["holder"]}
            got[(proto, port)] = {"proto": proto, "port": port, "via": "upnp", **r}
    todo = [k for k in ports if not got.get(k, {}).get("ok") and not got.get(k, {}).get("taken")
            and not got.get(k, {}).get("left")]  # an optional port left alone isn't asked for another way either
    if todo:
        ext = await natpmp_external_ip(gw)
        if ext:
            rep["router_ip"] = rep["router_ip"] or ext
            rep["method"] = rep["method"] or "natpmp"
            for proto, port in todo:
                r = await natpmp_map(gw, proto, port)
                if r["ok"] or (proto, port) not in got:
                    got[(proto, port)] = {"proto": proto, "port": port, "via": "natpmp", **r}
    rep["mapped"] = [got[k] for k in ports if k in got]
    if not rep["method"]:
        rep["problem"] = "no-upnp"
    return rep


def is_private(ip: str | None) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False

"""Checks run from outside, back to a box's own public address (never to any other address, so the probe can't be
used to scan someone else).

tls443   HTTPS on 443 with the box's name: the certificate must be valid for it, and /.well-known/tinhat/probe/<nonce>
         must answer the nonce. That proves chat, the web app and call signalling are reachable.
tcp7881  calls' TCP fallback port accepts a connection.
udp7882  calls' media port: the box answers the nonce from a short-lived echo while it checks (LiveKit is paused).
still_tinhat  the weekly "is this still a Tin Hat server" check, by name.
"""
import asyncio
import ipaddress
import json
import socket
import ssl


def _is_tinhat(doc) -> bool:
    """A Tin Hat server's well-known carries its offer under dev.tinhat.server."""
    return isinstance(doc, dict) and isinstance(doc.get("dev.tinhat.server"), dict)


def tls_context(ca_file: str | None) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if ca_file:
        ctx.load_verify_locations(ca_file)
    return ctx


async def _https_get(ip: str, host: str, path: str, ctx: ssl.SSLContext, timeout: float) -> tuple[int, bytes]:
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(ip, 443, ssl=ctx, server_hostname=host), timeout)
    try:
        writer.write(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: tinhat-names-probe\r\n"
                     f"Accept: */*\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()
        data = await asyncio.wait_for(reader.read(65536), timeout)
    finally:
        writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    try:
        status = int(head.split(b" ", 2)[1])
    except (IndexError, ValueError):
        status = 0
    if b"transfer-encoding: chunked" in head.lower():
        out, rest = b"", body
        while rest:
            size_s, _, rest = rest.partition(b"\r\n")
            size = int(size_s.split(b";")[0] or b"0", 16)
            if size == 0:
                break
            out, rest = out + rest[:size], rest[size + 2:]
        body = out
    return status, body


async def tls443(ip: str, host: str, nonce: str, ctx: ssl.SSLContext, timeout: float) -> dict:
    try:
        status, body = await _https_get(ip, host, f"/.well-known/tinhat/probe/{nonce}", ctx, timeout)
    except ssl.SSLCertVerificationError as e:
        return {"ok": False, "why": "certificate", "detail": e.verify_message or str(e)}
    except (asyncio.TimeoutError, OSError) as e:
        return {"ok": False, "why": "unreachable", "detail": type(e).__name__}
    if status == 200 and body.strip() == nonce.encode():
        return {"ok": True}
    return {"ok": False, "why": "wrong-answer", "detail": f"HTTP {status}"}


async def tcp(ip: str, port: int, timeout: float) -> dict:
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout)
        w.close()
        return {"ok": True}
    except (asyncio.TimeoutError, OSError) as e:
        return {"ok": False, "why": "unreachable", "detail": type(e).__name__}


class _Echo(asyncio.DatagramProtocol):
    def __init__(self, want: bytes):
        self.want, self.got = want, asyncio.get_running_loop().create_future()

    def datagram_received(self, data, addr):
        if data == self.want and not self.got.done():
            self.got.set_result(True)


async def udp_echo(ip: str, port: int, nonce: str, timeout: float) -> dict:
    loop = asyncio.get_running_loop()
    msg = f"tinhat-probe {nonce}".encode()
    transport, proto = await loop.create_datagram_endpoint(lambda: _Echo(msg), remote_addr=(ip, port))
    try:
        for _ in range(4):
            transport.sendto(msg)
            try:
                await asyncio.wait_for(asyncio.shield(proto.got), timeout / 4)
                return {"ok": True}
            except asyncio.TimeoutError:
                continue
        return {"ok": False, "why": "no-answer"}
    finally:
        transport.close()


async def still_tinhat(ip: str, host: str, ctx: ssl.SSLContext, timeout: float) -> str:
    """'yes', 'no' (answers, but not as a Tin Hat server) or 'down' (unreachable: an off gaming PC is not abuse)."""
    try:
        status, body = await _https_get(ip, host, "/.well-known/matrix/client", ctx, timeout)
    except ssl.SSLError:
        return "no"
    except (asyncio.TimeoutError, OSError):
        return "down"
    try:
        doc = json.loads(body)
    except ValueError:
        return "no"
    return "yes" if status == 200 and _is_tinhat(doc) else "no"


async def moved_here(host: str, fqdn: str, ctx: ssl.SSLContext, timeout: float) -> str | None:
    """Is https://host the server that had the name fqdn ("Move to your own domain")? Its well-known must list fqdn in
    dev.tinhat.moved_from and mark a Tin Hat server. None when it does, else why not. Only a public address is asked,
    never this service's own networks."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, 443, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except OSError:
        return "That address doesn't resolve."
    public = sorted({i[4][0] for i in infos if ipaddress.ip_address(i[4][0]).is_global})
    if not public:
        return "That address doesn't lead to a public server."
    try:
        status, body = await _https_get(public[0], host, "/.well-known/matrix/client", ctx, timeout)
    except ssl.SSLError:
        return "That address has no valid certificate yet."
    except (asyncio.TimeoutError, OSError):
        return "That address doesn't answer from outside yet."
    try:
        doc = json.loads(body)
    except ValueError:
        doc = None
    if status != 200 or not isinstance(doc, dict) or not _is_tinhat(doc):
        return "That address doesn't answer as a Tin Hat server."
    if fqdn not in (doc.get("dev.tinhat.moved_from") or []):
        return f"That server doesn't say it was {fqdn}."
    return None

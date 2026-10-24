"""Proof of work for registrations: cheap for one new server, costly for thousands.

The challenge is stateless (an expiry, a random part and an HMAC over them), so the service keeps nothing until a
solution arrives; used challenges are remembered until they expire so one can't be spent twice.
A solution is any string x with sha256(f"{nonce}:{name}:{x}") starting with `bits` zero bits.
"""
import hashlib
import hmac
import os
import secrets
import time


def zero_bits(digest: bytes) -> int:
    n = 0
    for b in digest:
        if b == 0:
            n += 8
            continue
        return n + (8 - b.bit_length())
    return n


def make(key: bytes, bits: int, ttl: int = 900) -> dict:
    expires = int(time.time()) + ttl
    rand = secrets.token_hex(8)
    mac = hmac.new(key, f"{expires}.{rand}.{bits}".encode(), hashlib.sha256).hexdigest()[:32]
    return {"nonce": f"{expires}.{rand}.{bits}.{mac}", "bits": bits, "expires": expires}


def check(key: bytes, nonce: str, name: str, solution: str, min_bits: int) -> tuple[bool, str]:
    try:
        expires_s, rand, bits_s, mac = nonce.split(".")
        expires, bits = int(expires_s), int(bits_s)
    except ValueError:
        return False, "bad challenge"
    good = hmac.new(key, f"{expires}.{rand}.{bits}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(good, mac):
        return False, "bad challenge"
    if expires < time.time():
        return False, "challenge expired"
    if bits < min_bits:
        return False, "challenge too easy"
    if len(solution) > 64:
        return False, "bad solution"
    d = hashlib.sha256(f"{nonce}:{name}:{solution}".encode()).digest()
    if zero_bits(d) < bits:
        return False, "wrong solution"
    return True, ""


def solve(nonce: str, name: str, bits: int) -> str:
    """Client side (the box). Single core; at 24 bits this is a few seconds to half a minute."""
    prefix = f"{nonce}:{name}:".encode()
    base = hashlib.sha256(prefix)
    i = 0
    while True:
        h = base.copy()
        s = format(i, "x")
        h.update(s.encode())
        if zero_bits(h.digest()) >= bits:
            return s
        i += 1


def load_key(path: str) -> bytes:
    try:
        with open(path, "rb") as f:
            k = f.read()
            if len(k) >= 32:
                return k
    except FileNotFoundError:
        pass
    k = os.urandom(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(k)
    return k

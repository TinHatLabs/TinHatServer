"""Solve the names service's proof of work: find x with sha256(f"{nonce}:{name}:{x}") starting with `bits` zero bits.
Same rule as names/tinhat_names/pow.py (the service checks it)."""
import hashlib


def _zero_bits(digest: bytes) -> int:
    n = 0
    for b in digest:
        if b == 0:
            n += 8
            continue
        return n + (8 - b.bit_length())
    return n


def solve(nonce: str, name: str, bits: int) -> str:
    base = hashlib.sha256(f"{nonce}:{name}:".encode())
    i = 0
    while True:
        h = base.copy()
        s = format(i, "x")
        h.update(s.encode())
        if _zero_bits(h.digest()) >= bits:
            return s
        i += 1

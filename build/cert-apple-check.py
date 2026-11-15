#!/usr/bin/env python3
"""cert-apple-check.py: does a TLS server certificate (the leaf) pass Apple's leaf rules for iOS 13+ / macOS 10.15+?

Apple's trust refuses a server certificate (also one under a root the user installed and trusted) unless:
  subject  the subject is not empty, or the subjectAltName extension is marked critical (Apple's "NonEmptySubject";
           RFC 5280: an empty subject needs a critical SAN)
  san      the subjectAltName extension is there and names a DNS name or an IP address (the common name is ignored)
  eku      the extendedKeyUsage extension is there and has id-kp-serverAuth (*)
  ca       it is no CA: basicConstraints left out or CA:FALSE (openssl marks a self-signed one CA:TRUE unless told;
           a browser may refuse a CA certificate used as the server's own)
  validity notBefore to notAfter is 825 days or fewer (*), and notAfter comes after notBefore
  key      RSA of 2048 bits or more, or ECDSA on P-256 / P-384 / P-521
  hash     the signature uses SHA-2 (not SHA-1 / MD5; RSA-PSS only with a SHA-2 hash)
(*) Apple applies these two to certificates issued after 2019-07-01: every certificate made today.
Only the leaf's own profile: hostname matching, the chain (its CAs' keys and hashes), signatures and the current date
are the TLS stack's business. Go's crypto/x509 (Caddy's `tls internal`, Pebble, smallstep) marks the SAN critical by
itself when the subject is empty; a hand-made openssl certificate with `-subj /` doesn't, and that one fails on iOS.

    build/cert-apple-check.py CERT.pem [...]     the first certificate of each file (PEM or DER); exit 1 if any fails
Standard library only (its own strict DER reader): it runs wherever the server's tests run.
"""
import base64
import datetime
import re
import sys

MAX_DAYS = 825
# object identifiers as tuples (oid() returns them so)
SERVER_AUTH = (1, 3, 6, 1, 5, 5, 7, 3, 1)
SAN, EKU, BASIC = (2, 5, 29, 17), (2, 5, 29, 37), (2, 5, 29, 19)
RSA = (1, 2, 840, 113549, 1, 1, 1)
EC = (1, 2, 840, 10045, 2, 1)
CURVES = {(1, 2, 840, 10045, 3, 1, 7): "P-256", (1, 3, 132, 0, 34): "P-384", (1, 3, 132, 0, 35): "P-521"}
_RSA_SIG, _ECDSA_SIG = (1, 2, 840, 113549, 1, 1), (1, 2, 840, 10045, 4, 3)
PSS = _RSA_SIG + (10,)
SHA2_SIGS = {
    *(_RSA_SIG + (n,) for n in (11, 12, 13, 14)),  # RSA with SHA-256/384/512/224
    *(_ECDSA_SIG + (n,) for n in (1, 2, 3, 4)),  # ECDSA with SHA-224/256/384/512
}
SHA2_HASHES = {(2, 16, 840, 1, 101, 3, 4, 2, n) for n in (1, 2, 3, 4)}  # SHA-256/384/512/224, for RSA-PSS
SEQ, SET, OID_TAG, BOOL, OCTETS, BITS, INT = 0x30, 0x31, 0x06, 0x01, 0x04, 0x03, 0x02


class Bad(ValueError):
    pass


def tlv(b: bytes, i: int, end: int | None = None):
    """-> (tag, value start, value end) of the DER element at i, which must end by `end` (default: the buffer's)."""
    end = len(b) if end is None else end
    if i + 2 > end:
        raise Bad("truncated DER")
    tag, n = b[i], b[i + 1]
    i += 2
    if n & 0x80:
        k = n & 0x7F
        if k == 0 or k > 4 or i + k > end:
            raise Bad("bad DER length")
        n = int.from_bytes(b[i:i + k], "big")
        if n < 0x80 or b[i] == 0:
            raise Bad("non-minimal DER length")
        i += k
    if i + n > end:
        raise Bad("DER element runs past its parent")
    return tag, i, i + n


def children(b: bytes, start: int, end: int):
    out, i = [], start
    while i < end:
        t, s, e = tlv(b, i, end)
        out.append((t, s, e))
        i = e
    return out


def want(el, tag: int, what: str):
    if el[0] != tag:
        raise Bad(f"{what}: tag {el[0]:#x}, expected {tag:#x}")
    return el


def dotted(o: tuple) -> str:
    return ".".join(map(str, o))


def oid(v: bytes) -> tuple:
    parts, n, fresh = [], 0, True
    if not v:
        raise Bad("empty OID")
    for x in v:
        if fresh and x == 0x80:
            raise Bad("non-minimal OID component")
        n = (n << 7) | (x & 0x7F)
        fresh = not x & 0x80
        if fresh:
            parts.append(n)
            n = 0
    if not fresh:
        raise Bad("unterminated OID")
    first = min(parts[0] // 40, 2)
    return (first, parts[0] - 40 * first, *parts[1:])


def when(tag: int, v: bytes) -> datetime.datetime:
    s = v.decode("ascii")
    if tag == 0x17:  # UTCTime: YY 50-99 = 19YY, 00-49 = 20YY (RFC 5280)
        if not re.fullmatch(r"\d{12}Z", s):
            raise Bad("bad UTCTime")
        s = ("19" if int(s[:2]) >= 50 else "20") + s
    elif tag != 0x18 or not re.fullmatch(r"\d{14}Z", s):
        raise Bad("bad time")
    return datetime.datetime.strptime(s, "%Y%m%d%H%M%SZ").replace(tzinfo=datetime.timezone.utc)


def der_of(data: bytes) -> bytes:
    """The first certificate in PEM or DER bytes."""
    m = re.search(rb"-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----", data, re.S)
    if m:
        return base64.b64decode(b"".join(m.group(1).split()), validate=True)
    if data[:1] == b"\x30":
        return data
    raise Bad("no certificate in it")


def _alg(der: bytes, el) -> tuple:
    """AlgorithmIdentifier -> (oid, [params elements])."""
    parts = children(der, *want(el, SEQ, "algorithm")[1:])
    return oid(der[slice(*want(parts[0], OID_TAG, "algorithm id")[1:])]), parts[1:]


def _pss_hash(der: bytes, params) -> tuple:
    """RSASSA-PSS-params' hashAlgorithm; left out = SHA-1 (RFC 4055)."""
    sha1 = (1, 3, 14, 3, 2, 26)
    if not params:
        return sha1
    if len(params) != 1:
        raise Bad("PSS params")
    fields = children(der, *want(params[0], SEQ, "PSS params")[1:])
    tags = [t for t, _s, _e in fields]
    if tags != sorted(set(tags)) or any(t not in (0xA0, 0xA1, 0xA2, 0xA3) for t in tags):
        raise Bad("PSS params: fields out of order, repeated or unknown")
    for t, s, e in fields:
        if t == 0xA0:
            inner = tlv(der, s, e)
            if inner[2] != e:
                raise Bad("PSS hash: trailing data")
            return _alg(der, inner)[0]
    return sha1


def parse(der: bytes) -> dict:
    t, s, e = tlv(der, 0)
    if t != SEQ or e != len(der):
        raise Bad("not one DER certificate")
    cert = children(der, s, e)
    if len(cert) != 3:
        raise Bad("not a certificate")
    tbs = children(der, *want(cert[0], SEQ, "tbsCertificate")[1:])
    if tbs and tbs[0][0] == 0xA0:  # [0] version
        tbs = tbs[1:]
    if len(tbs) < 6:
        raise Bad("short tbsCertificate")
    want(tbs[0], INT, "serial")
    _serial, inner_alg, _issuer, validity, subject, spki = tbs[:6]
    want(_issuer, SEQ, "issuer")
    times = children(der, *want(validity, SEQ, "validity")[1:])
    if len(times) != 2:
        raise Bad("validity needs two times")
    nb, na = times
    sig, sig_params = _alg(der, cert[1])
    if der[slice(*want(inner_alg, SEQ, "signature")[1:])] != der[slice(*cert[1][1:])]:
        raise Bad("the two signature algorithms differ")  # RFC 5280: the same AlgorithmIdentifier, byte for byte
    info = {
        "subject_empty": want(subject, SEQ, "subject")[2] == subject[1],
        "not_before": when(nb[0], der[nb[1]:nb[2]]),
        "not_after": when(na[0], der[na[1]:na[2]]),
        "sig": sig,
        "sig_hash": _pss_hash(der, sig_params) if sig == PSS else None,
        "ext": {},
    }
    alg, bits = children(der, *want(spki, SEQ, "subjectPublicKeyInfo")[1:])
    info["key_alg"], key_params = _alg(der, alg)
    want(bits, BITS, "public key")
    if info["key_alg"] == EC and key_params and key_params[0][0] == OID_TAG:
        info["curve"] = oid(der[key_params[0][1]:key_params[0][2]])
    elif info["key_alg"] == RSA:
        _t, ks, ke = want(tlv(der, bits[1] + 1, bits[2]), SEQ, "RSA key")  # after the unused-bits byte
        mod = want(children(der, ks, ke)[0], INT, "modulus")
        info["rsa_bits"] = int.from_bytes(der[mod[1]:mod[2]], "big").bit_length()
    for t, s, e in tbs[6:]:
        if t != 0xA3:  # [3] extensions ([1]/[2] unique ids are skipped)
            continue
        seq = want(tlv(der, s, e), SEQ, "extensions")
        for x in children(der, seq[1], seq[2]):
            parts = children(der, *want(x, SEQ, "extension")[1:])
            xid = oid(der[slice(*want(parts[0], OID_TAG, "extension id")[1:])])
            if len(parts) == 3:
                want(parts[1], BOOL, "critical")
            elif len(parts) != 2:
                raise Bad("bad extension")
            critical = len(parts) == 3 and der[parts[1][1]:parts[1][2]] == b"\xff"
            val = der[slice(*want(parts[-1], OCTETS, "extension value")[1:])]
            if xid in info["ext"]:
                raise Bad(f"extension {dotted(xid)} twice")
            info["ext"][xid] = (critical, val)
    return info


def _inside(val: bytes, tag: int, what: str):
    """The children of an extension value that must be one `tag` element filling it."""
    t, s, e = tlv(val, 0)
    if t != tag or e != len(val):
        raise Bad(f"{what}: not one {tag:#x} element")
    return children(val, s, e)


def san_names(val: bytes) -> int:
    """How many DNS names / IP addresses the SAN holds; a malformed one (an empty or odd DNS name, an IP address that
    isn't 4 or 16 bytes) is refused outright, also next to a good one."""
    n = 0
    for t, s, e in _inside(val, SEQ, "subjectAltName"):
        if t == 0x82:  # dNSName
            if not re.fullmatch(rb"[A-Za-z0-9*._-]+", val[s:e]):
                raise Bad("subjectAltName: a malformed DNS name")
            n += 1
        elif t == 0x87:  # iPAddress
            if e - s not in (4, 16):
                raise Bad("subjectAltName: an IP address that is neither 4 nor 16 bytes")
            n += 1
    return n


def is_ca(ext) -> bool:
    """basicConstraints' cA flag (DEFAULT FALSE); no extension = not a CA."""
    if not ext:
        return False
    fields = _inside(ext[1], SEQ, "basicConstraints")
    if fields and fields[0][0] == BOOL:
        t, s, e = fields[0]
        if e - s != 1 or ext[1][s] not in (0x00, 0xFF):
            raise Bad("basicConstraints: a malformed cA flag")
        return ext[1][s] == 0xFF
    return False


def problems(der: bytes) -> list[str]:
    """Each rule the certificate breaks, in words (empty = it passes)."""
    c = parse(der)
    out = []
    san = c["ext"].get(SAN)
    if c["subject_empty"] and not (san and san[0]):
        out.append("subject: the subject is empty and the subjectAltName isn't critical (Apple: NonEmptySubject)")
    if not (san and san_names(san[1])):
        out.append("san: no subjectAltName with a DNS name or an IP address")
    eku = c["ext"].get(EKU)
    usages = []
    if eku:
        for el in _inside(eku[1], SEQ, "extendedKeyUsage"):
            usages.append(oid(eku[1][slice(*want(el, OID_TAG, "key purpose")[1:])]))
    if SERVER_AUTH not in usages:
        out.append("eku: no extendedKeyUsage serverAuth")
    if is_ca(c["ext"].get(BASIC)):
        out.append("ca: basicConstraints says CA:TRUE (a server certificate must not be a CA)")
    days = (c["not_after"] - c["not_before"]).total_seconds() / 86400
    if days > MAX_DAYS:
        out.append(f"validity: {days:.0f} days (Apple: {MAX_DAYS} at most)")
    elif days <= 0:
        out.append("validity: notAfter isn't after notBefore")
    if c["key_alg"] == RSA:
        if c.get("rsa_bits", 0) < 2048:
            out.append(f"key: RSA {c.get('rsa_bits')} bits (Apple: 2048 or more)")
    elif c["key_alg"] == EC:
        if c.get("curve") not in CURVES:
            out.append(f"key: ECDSA on curve {dotted(c.get('curve') or ())} (Apple: P-256, P-384 or P-521)")
    else:
        out.append(f"key: algorithm {dotted(c['key_alg'])} (Apple: RSA or ECDSA)")
    if c["sig"] == PSS:
        if c["sig_hash"] not in SHA2_HASHES:
            out.append(f"hash: RSA-PSS with hash {dotted(c['sig_hash'])}, not SHA-2")
    elif c["sig"] not in SHA2_SIGS:
        out.append(f"hash: signature algorithm {dotted(c['sig'])} isn't SHA-2")
    return out


def check_file(path: str) -> list[str]:
    with open(path, "rb") as f:
        return problems(der_of(f.read()))


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    bad = 0
    for p in argv:
        try:
            found = check_file(p)
        except (OSError, ValueError, IndexError) as e:  # Bad is a ValueError
            found = [f"unreadable: {e}"]
        if found:
            bad += 1
            print(f"FAIL {p}")
            for x in found:
                print(f"  - {x}")
        else:
            print(f"ok   {p}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

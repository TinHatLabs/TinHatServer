"""Review S4 (assembly-039): behind the owner's reverse proxy the dashboard gate refuses a request whose
X-Forwarded-For Caddy can't read a visitor's address from: then Caddy's client_ip is the proxy's own (home) address,
which the gate would let in. 0.3.9's character class let through non-addresses (`deadbeef`, `999.999.999.999`);
templates.XFF_PATTERN accepts a header only when EVERY entry is one Caddy parses. The oracle here is a model of Caddy
2.10's trustedRealClientIP (split at commas; Go's net.SplitHostPort before any trimming; TrimSpace; cut the zone;
netip.ParseAddr), with Python's ipaddress standing in for netip (they agree on these forms: no IPv4 leading zeros).
    python3 -m unittest discover -s appliance/tests
"""
import ipaddress
import pathlib
import random
import re
import unittest

SRC = (pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat/templates.py").read_text()
_ns = {}
exec(SRC[SRC.index("_XFF_OCTET ="):SRC.index("XFF_ADDRESSES = f")], _ns)  # the pattern's own lines, nothing else
PATTERN = _ns["XFF_PATTERN"]
RX = re.compile(PATTERN)


def go_split_host_port(hp: str):
    """Go's net.SplitHostPort: (host, port) or None (an error)."""
    i = hp.rfind(":")
    if i < 0:
        return None
    if hp.startswith("["):
        end = hp.find("]")
        if end < 0:
            return None
        if end + 1 == len(hp):
            return None  # missing port
        if end + 1 != i:
            return None  # too many colons / missing port
        host, j, k = hp[1:end], 1, end + 1
    else:
        host, j, k = hp[:i], 0, 0
        if ":" in host:
            return None  # too many colons
    if "[" in hp[j:] or "]" in hp[k:]:
        return None
    return host, hp[i + 1:]


def caddy_reads(entry: str):
    """The address Caddy takes from one entry, or None (it skips the entry)."""
    sp = go_split_host_port(entry)
    host = sp[0] if sp else entry
    host = host.strip(" \t\n\r\v\f").split("%", 1)[0]  # Go's TrimSpace (ASCII whitespace), then the zone
    if not host or host != host.strip():
        return None
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def all_read(h: str) -> bool:
    return all(caddy_reads(x) is not None for x in h.split(","))


def any_read(h: str) -> bool:
    return any(caddy_reads(x) is not None for x in h.split(","))


def _six_with_tail(six: list[str], tail: str, compress: bool) -> str:
    """Six IPv6 groups + a dotted IPv4 tail; compress: the longest run of zero groups (2+) written as `::`."""
    if compress:
        best, run = (0, 0), None
        for i, g in enumerate(six + ["x"]):
            if g == "0" and run is None:
                run = i
            elif g != "0" and run is not None:
                if i - run > best[1] - best[0]:
                    best = (run, i)
                run = None
        if best[1] - best[0] >= 2:
            left, right = six[:best[0]], six[best[1]:]
            return ":".join(left) + "::" + "".join(g + ":" for g in right) + tail
    return ":".join(six) + ":" + tail


def rand_v6(rnd) -> str:
    """A random IPv6 address as people write it: compressed (zero runs are common), full, or with a dotted tail."""
    groups = [format(rnd.getrandbits(16), "x") if rnd.random() < 0.6 else "0" for _ in range(8)]
    a = ipaddress.IPv6Address(":".join(groups))
    r = rnd.random()
    if r < 0.25:
        return _six_with_tail(groups[:6], str(ipaddress.IPv4Address(rnd.getrandbits(32))), rnd.random() < 0.7)
    return str(a) if r < 0.8 else a.exploded


class Strict(unittest.TestCase):
    def test_go_regexp_safe(self):
        self.assertNotIn("`", PATTERN)  # the Caddyfile string's quote
        for bad in ("(?=", "(?!", "(?<", "\\1"):
            self.assertNotIn(bad, PATTERN)  # RE2 has no lookarounds or back-references

    def test_addresses_pass(self):
        for h in ["203.0.113.7", "203.0.113.7, 10.0.0.1", "203.0.113.7:51234", "[2001:db8::1]:443", "2001:db8::1",
                  "::ffff:1.2.3.4", "::ffff:0:1.2.3.4", "::1", "::", "fe80::1", "1:2:3:4:5:6:7:8", "1::",
                  "1:2:3:4:5:6:1.2.3.4", "2001:DB8:0:0:8:800:200C:417A", "198.51.100.4,2001:db8::5", " 1.2.3.4 ,  ::1 ",
                  "2001:db8::1:192.0.2.1", "::1:192.0.2.1", "1:2::3:4:5:1.2.3.4", "1:2:3:4:5::1.2.3.4",
                  "198.51.100.4,[2001:db8::5]:80", "1.2.3.4:80 ", " 1.2.3.4:80"]:
            self.assertTrue(RX.match(h), h)
            self.assertTrue(all_read(h), h)

    def test_what_caddy_cannot_read_is_refused(self):
        for h in ["deadbeef", "999.999.999.999", "unknown", "", " ", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4",
                  "::g", "1.2.3.4]", "[1.2.3.4]", "[1.2.3.4]:80", ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "[::1",
                  "2001:db8::1:443x", "1.2.3.4,", ",1.2.3.4", "1.2.3.4,,198.51.100.8", "1.2.3.4 198.51.100.8",
                  "1.2.3.4:", "[::1]:", "::1:80:", "a.b.c.d", "1.2.3.4:123456", "_", "dead:beef",
                  # Astra round 1 (P1): Caddy can't read these, so they would fall back to the proxy's address
                  "[2001:db8::123]", "192.168.1.2, [2001:db8::123]:443", " [::1]:80"]:
            self.assertFalse(RX.match(h), h)
        # the two P1 forms really are unreadable for Caddy (the model), while the readable ones beside them are
        self.assertIsNone(caddy_reads("[2001:db8::123]"))
        self.assertIsNone(caddy_reads(" [2001:db8::123]:443"))
        self.assertIsNotNone(caddy_reads("[2001:db8::123]:443"))

    def test_the_model_reads_what_caddy_reads(self):
        self.assertEqual(str(caddy_reads("::ffff")), "::ffff")  # (round 2: the model had stripped letters)
        self.assertEqual(str(caddy_reads(" 1.2.3.4:80")), "1.2.3.4")
        self.assertEqual(str(caddy_reads("[2001:db8::1]:443")), "2001:db8::1")
        self.assertEqual(str(caddy_reads("fe80::1%eth0")), "fe80::1")
        self.assertIsNone(caddy_reads(" [2001:db8::1]:443"))
        self.assertIsNone(caddy_reads("[2001:db8::1]"))

    def test_zones_and_tabs_are_refused_though_caddy_reads_them(self):
        for h in ["fe80::1%eth0", "\t1.2.3.4", "1.2.3.4\t"]:
            self.assertFalse(RX.match(h), h)
            self.assertTrue(all_read(h), h)  # stricter than Caddy: never looser

    def test_never_looser_than_caddy_on_random_input(self):
        rnd = random.Random(310)
        alphabet = "0123456789abcdefABCDEF:.[], %"
        leaks = []
        for _ in range(40000):
            h = "".join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 30)))
            if RX.match(h) and not all_read(h):
                leaks.append(h)
        self.assertEqual(leaks[:10], [])

    def test_real_address_lists_pass(self):
        rnd = random.Random(311)
        missed = []
        for _ in range(8000):
            parts = []
            for _ in range(rnd.randint(1, 3)):
                if rnd.random() < 0.4:
                    a = str(ipaddress.IPv4Address(rnd.getrandbits(32)))
                    parts.append(a + (f":{rnd.randint(1, 65535)}" if rnd.random() < 0.3 else ""))
                else:
                    a = rand_v6(rnd)
                    parts.append(f"[{a}]:{rnd.randint(1, 65535)}" if rnd.random() < 0.3 else a)
            h = (", " if rnd.random() < 0.5 else ",").join(parts)
            if not all_read(h):
                continue  # a leading space before a bracket: Caddy can't read it either (refusing it is right)
            if not RX.match(h):
                missed.append(h)
        self.assertEqual(missed[:10], [])


if __name__ == "__main__":
    unittest.main()

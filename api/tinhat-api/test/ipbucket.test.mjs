// reachcommon.mjs ipBucket/clientKey — per-address limits count an IPv6 caller as its /64 (security review 2026-10-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ipBucket, clientKey, createMatrixAuth, AUTH, trustProxy, clientIp } from "../reachcommon.mjs";
import { call, bearer, clock, fakeHomeserver } from "./helpers.mjs";

test("ipv4 stays itself; ipv4-mapped ipv6 is its ipv4; a port or brackets are dropped", () => {
    assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
    assert.equal(ipBucket("203.0.113.7:4433"), "203.0.113.7");
    assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(ipBucket("::FFFF:cb00:7107"), "203.0.113.7");
    assert.equal(ipBucket("[::ffff:203.0.113.7]:443"), "203.0.113.7");
});

test("ipv6 is bucketed by its /64, however it is written", () => {
    const b = "2001:db8:1:2::/64";
    for (const a of ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "[2001:db8:1:2::5]:443",
        "2001:db8:1:2::7%eth0", "2001:db8:1:2:0:0:1.2.3.4"]) assert.equal(ipBucket(a), b, a);
    assert.notEqual(ipBucket("2001:db8:1:3::1"), b, "the next /64 is somebody else");
    assert.equal(ipBucket("::1"), "0:0:0:0::/64");
    assert.equal(ipBucket("fe80::1"), "fe80:0:0:0::/64");
    assert.equal(ipBucket("2001:db8::"), "2001:db8:0:0::/64");
});

test("not an address: returned as it was (cut), never merged with a real caller", () => {
    assert.equal(ipBucket(""), "-");
    assert.equal(ipBucket(undefined), "-");
    assert.equal(ipBucket("unknown"), "unknown");
    assert.equal(ipBucket("x".repeat(200)).length, 64);
    assert.equal(ipBucket("2001:db8::1::2"), "2001:db8::1::2");
});

test("clientKey reads the last forwarded hop and buckets it", () => {
    assert.equal(clientKey({ headers: { "x-forwarded-for": "1.1.1.1, 2001:db8:aa:bb::99" } }), "2001:db8:aa:bb::/64");
    assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "127.0.0.1");
});

test("sign-in checks: a whole ipv6 /64 shares one per-client budget for unknown tokens", async () => {
    const hs = fakeHomeserver({ tokens: { good: { user: "@a:example.org", device: "D" } } });
    const auth = createMatrixAuth({ hs, now: clock(1000) });
    const probe = async (req, res) => { const who = await auth.authenticate(req, res); if (who) res.json({ ok: true }); };
    let last;
    for (let i = 0; i < AUTH.UNKNOWN_PER_CLIENT + 5; i++) {
        // EDGE_PROXY is set by `npm test`: the hop before it is the caller
        last = await call(probe, { headers: { ...bearer(`bogus-${i}`), "x-forwarded-for": `2001:db8:5:6::${(i + 1).toString(16)}, ${process.env.EDGE_PROXY || "192.0.2.1"}` } });
    }
    assert.equal(last.statusCode, 429, "rotating addresses inside one /64 buys nothing");
    assert.equal(hs.count(/whoami$/), AUTH.UNKNOWN_PER_CLIENT);
});

/** What express (proxy-addr) makes req.ip from a trust function: the socket address, then X-Forwarded-For from the
 *  right, for as long as each hop before it is trusted. */
function reqIp(trust, socket, xff) {
    const addrs = [socket, ...String(xff || "").split(",").map((s) => s.trim()).filter(Boolean).reverse()];
    let n = addrs.length;
    for (let i = 0; i < addrs.length - 1; i++) if (!trust(addrs[i], i)) { n = i + 1; break; }
    return addrs[n - 1];
}

test("trust proxy: only the immediate hop (this box's Caddy on loopback); nothing left of the last entry is read (second review, #5)", () => {
    const t = trustProxy("loopback", "");
    assert.equal(reqIp(t, "127.0.0.1", "203.0.113.50"), "203.0.113.50");
    assert.equal(reqIp(t, "::ffff:127.0.0.1", "203.0.113.50"), "203.0.113.50", "an IPv4-mapped socket address");
    assert.equal(reqIp(t, "::1", "2001:db8::5"), "2001:db8::5");
    assert.equal(reqIp(t, "127.0.0.1", "127.0.0.1, 203.0.113.50"), "203.0.113.50", "a spoofed loopback entry on the left: never read");
    assert.equal(reqIp(t, "127.0.0.1", "203.0.113.50, 127.0.0.1"), "127.0.0.1",
        "express's own 'loopback' walked on to 203.0.113.50 here; Caddy only ever writes one address");
    assert.equal(reqIp(t, "127.0.0.1", ""), "127.0.0.1");
    assert.equal(reqIp(t, "192.0.2.9", "203.0.113.50"), "192.0.2.9", "not our proxy: its header isn't read");
    for (const [socket, xff] of [["127.0.0.1", "127.0.0.1, 203.0.113.50"], ["127.0.0.1", "10.0.0.1, ::1, 203.0.113.51"]])
        assert.equal(reqIp(t, socket, xff), clientIp({ headers: { "x-forwarded-for": xff } }), "the same caller as clientIp");
});

test("trust proxy: EDGE_PROXY is the one further hop believed; addresses, networks and express's names; junk ignored", () => {
    const t = trustProxy("loopback", "192.0.2.1");
    assert.equal(reqIp(t, "127.0.0.1", "203.0.113.7, 192.0.2.1"), "203.0.113.7");
    assert.equal(reqIp(t, "127.0.0.1", "198.51.100.1, 192.0.2.1, 203.0.113.7, 192.0.2.1"), "203.0.113.7");
    assert.equal(reqIp(t, "127.0.0.1", "203.0.113.7, 198.51.100.1"), "198.51.100.1");
    const many = trustProxy("10.1.2.0/28, fd00::5, uniquelocal, not-an-address, 10.0.0.1/99", "");
    assert.equal(reqIp(many, "10.1.2.7", "203.0.113.8"), "203.0.113.8");
    assert.equal(reqIp(many, "fd00::5", "203.0.113.8"), "203.0.113.8");
    assert.equal(reqIp(many, "192.168.3.3", "203.0.113.8"), "203.0.113.8", "uniquelocal");
    assert.equal(reqIp(many, "127.0.0.1", "203.0.113.8"), "127.0.0.1", "loopback isn't in this list");
    assert.equal(reqIp(trustProxy("10.0.0.1/99", ""), "10.0.0.1", "203.0.113.8"), "10.0.0.1", "a bad prefix length is ignored, not clamped");
    assert.equal(reqIp(trustProxy("", ""), "127.0.0.1", "203.0.113.8"), "127.0.0.1", "an empty list trusts nobody");
});

// foreign.mjs — other Tin Hat servers' sound links, fetched through this server (the maintainer's decision, 2026-10-26): the
// links taken, the addresses refused, the pinned connection, no redirects, the cap, audio only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseForeignClipUrl, isPublicAddress, resolvePublic, fetchForeignClip, foreignDownload, IPV6_ALLOCATED } from "../foreign.mjs";

const OWN = ["home.example", "chat.crew.test"];
const ID = "a".repeat(64);

test("the two link shapes are taken, normalised (the cache key)", () => {
    for (const [raw, url] of [
        [`https://peer.example/api/soundboard/clip?id=${ID}`, `https://peer.example/api/soundboard/clip?id=${ID}`],
        [`https://Peer.Example:443/api/soundboard/clip?id=${ID}`, `https://peer.example/api/soundboard/clip?id=${ID}`],
        [`https://peer.example./api/soundboard/clip?id=abc_DEF-1`, "https://peer.example/api/soundboard/clip?id=abc_DEF-1"],
        ["https://friends.tinhat.me/api/soundboard/file/air.horn-2_x.mp3", "https://friends.tinhat.me/api/soundboard/file/air.horn-2_x.mp3"],
    ]) {
        const got = parseForeignClipUrl(raw, OWN);
        assert.equal(got.url, url, raw);
        assert.equal(got.error, undefined);
    }
});

test("every other shape is refused", () => {
    const bad = [
        `http://peer.example/api/soundboard/clip?id=${ID}`,                    // not https
        `https://peer.example:8443/api/soundboard/clip?id=${ID}`,              // another port
        `https://u:p@peer.example/api/soundboard/clip?id=${ID}`,               // userinfo
        `https://peer.example/api/soundboard/clip?id=${ID}#x`,                 // fragment
        `https://peer.example/api/soundboard/clip?id=${ID}&x=1`,               // another parameter
        `https://peer.example/api/soundboard/clip?id=${ID}&id=b`,              // two ids
        "https://peer.example/api/soundboard/clip",                            // no id
        "https://peer.example/api/soundboard/clip?id=",                        // empty id
        "https://peer.example/api/soundboard/clip?id=a.b",                     // id characters
        "https://peer.example/api/soundboard/clip?id=a%41",                    // encoded id
        "https://peer.example/api/soundboard/clip?url=https://x",              // the other parameter
        "https://peer.example/api/soundboard/file/x.mp3?y=1",                  // query on a file link
        "https://peer.example/api/soundboard/file/x.mp3?",                     // an empty query
        "https://peer.example/api/soundboard/file/a%20b.mp3",                  // any escape in a name
        "https://peer.example/api/soundboard/file/a%2fb", "https://peer.example/api/soundboard/file/a%2Fb",
        "https://peer.example/api/soundboard/file/%2e%2e", "https://peer.example/api/soundboard/%2E%2E/file/x",
        "https://peer.example/api/soundboard/file/a%5cb", "https://peer.example/api/soundboard/file/a%5Cb",
        "https://peer.example/api/soundboard/file/a\\b",
        "https://peer.example/api/soundboard/file/..", "https://peer.example/api/soundboard/file/x/../../../_synapse/admin",
        "https://peer.example/api/soundboard/file/", "https://peer.example/api/soundboard/clip/sign?id=a",
        "https://peer.example/_matrix/media/v3/download/x/y", "https://peer.example/",
        `https://127.0.0.1/api/soundboard/clip?id=${ID}`, `https://[::1]/api/soundboard/clip?id=${ID}`,
        `https://10.0.0.5/api/soundboard/clip?id=${ID}`, `https://localhost/api/soundboard/clip?id=${ID}`,
        `https://home.example/api/soundboard/clip?id=${ID}`, `https://HOME.example./api/soundboard/clip?id=${ID}`,
        "not a url", "", "x".repeat(3000), 42, null,
    ];
    for (const raw of bad) {
        const got = parseForeignClipUrl(raw, OWN);
        assert.ok(got.error, `taken: ${String(raw).slice(0, 80)}`);
        assert.equal(got.url, undefined);
    }
    assert.equal(parseForeignClipUrl(`https://chat.crew.test/api/soundboard/clip?id=${ID}`, OWN).reason, "own");
    assert.equal(parseForeignClipUrl(`http://x.example/api/soundboard/clip?id=${ID}`, OWN).reason, "shape");
});

test("public addresses only", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "2606:4700:4700::1111", "2a01:4f8::1", "64:ff9b::808:808",
        "2001:200::1", "2001:4860:4860::8888", "2003:e4::1", "2410::1", "2630::1", "2a10::1", "2c0f:f248::1", "2620:fe::fe"]) {
        assert.equal(isPublicAddress(ip), true, ip);
    }
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
        "100.127.255.255", "0.0.0.0", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1", "192.0.2.1",
        "198.51.100.1", "203.0.113.1", "198.18.0.1", "192.0.0.1", "192.88.99.1",
        "::", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "::127.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
        "2001:db8::1", "2001::1", "2002:c0a8:101::1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1",
        "fec0::1", "3fff::1", "not an ip", "",
        // reserved by IANA, not allocated (second review, #3): 2000::/3 isn't all public
        "3ffe::1", "3000::1", "2d00::1", "2e00::1", "3800::1", "2000::1", "2004::1", "2420::1", "2640::1", "2c10::1",
        "2001:1000::1", "2001:6000::1",
        // a zone id is never an address here (rejected, not stripped)
        "fe80::1%eth0", "2606:4700:4700::1111%1", "8.8.8.8%eth0"]) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
    assert.equal(IPV6_ALLOCATED.length, 34, "the IANA table of 2025-10-10, minus 2001::/23 and 2002::/16");
});

/** A c-ares resolver double: {v4: [...] | Error, v6: [...] | Error}; `hang` never answers until cancel(). */
function resolver({ v4 = [], v6 = [], hang = false } = {}) {
    const r = { cancelled: false, asked: [] };
    let pending = [];
    const answer = (list) => (name) => {
        r.asked.push(name);
        if (hang) return new Promise((_, reject) => pending.push(reject));
        return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
    };
    r.resolve4 = answer(v4);
    r.resolve6 = answer(v6);
    r.cancel = () => { r.cancelled = true; for (const p of pending) p(Object.assign(new Error("cancelled"), { code: "ECANCELLED" })); pending = []; };
    return r;
}
const NODATA = Object.assign(new Error("no data"), { code: "ENODATA" });

test("a name that resolves to a non-public address (any of them) is refused; the first public one is pinned", async () => {
    assert.deepEqual(await resolvePublic("peer.example.org", resolver({ v4: ["8.8.8.8"], v6: ["2606:4700::1"] })), { address: "8.8.8.8", family: 4 });
    assert.deepEqual(await resolvePublic("peer.example.org", resolver({ v4: NODATA, v6: ["2606:4700::1"] })), { address: "2606:4700::1", family: 6 });
    for (const answers of [{ v4: ["10.0.0.5"] }, { v4: ["8.8.8.8", "127.0.0.1"] }, { v4: ["8.8.8.8"], v6: ["fd00::5"] },
        { v6: ["::ffff:192.168.1.2"] }, { v6: ["64:ff9b::c0a8:102"] }, { v6: ["3ffe::1"] }]) {
        await assert.rejects(resolvePublic("peer.example.org", resolver(answers)), (e) => e.status === 403 && e.reason === "not-public", JSON.stringify(answers));
    }
    await assert.rejects(resolvePublic("gone.example", resolver({ v4: NODATA, v6: NODATA })), (e) => e.status === 502);
    await assert.rejects(resolvePublic("empty.example", resolver({})), (e) => e.status === 502);
});

/** A transport double for https.request: answers with `status`, `headers` and `body` (or `forever`: chunks until it is
 *  torn down); records the options and whether request and response were destroyed. */
function transport({ status = 200, headers = {}, body = Buffer.alloc(0), chunks = null, never = false, forever = false } = {}) {
    const seen = [];
    const request = (opts, onResponse) => {
        const rec = { ...opts };
        seen.push(rec);
        const req = new EventEmitter();
        req.destroy = () => { req.destroyed = true; rec.reqDestroyed = true; };
        req.end = () => {
            if (never) return;
            // the connection goes where opts.lookup says
            opts.lookup(opts.host, { all: true }, (err, list) => {
                rec.connectedTo = list[0];
                const res = new PassThrough();
                res.statusCode = status;
                res.headers = headers;
                rec.sent = 0;
                res.destroy = () => { res.destroyed = true; rec.resDestroyed = true; clearInterval(rec.pump); };
                onResponse(res);
                if (forever) {
                    // (torn down already inside onResponse: no pump, or it would keep the test process alive)
                    if (!res.destroyed) rec.pump = setInterval(() => { if (!res.destroyed) { res.write(Buffer.alloc(1000)); rec.sent++; } }, 2);
                    return;
                }
                for (const c of chunks || [body]) if (!res.destroyed) res.write(c);
                if (!res.destroyed) res.end();
            });
        };
        return req;
    };
    request.seen = seen;
    return request;
}
const ADTS = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(300)]);
const URL1 = `https://peer.example/api/soundboard/clip?id=${ID}`;
const PIN = { address: "8.8.8.8", family: 4 };

test("the fetch connects to the pinned address with SNI and Host = the name; audio comes back typed from its bytes", async () => {
    const request = transport({ body: ADTS, headers: { "content-type": "text/html" } });
    const got = await fetchForeignClip(URL1, PIN, { maxBytes: 1000, request });
    assert.deepEqual([got.status, got.type, got.ext, got.data.length], [200, "audio/aac", "aac", ADTS.length]);
    const o = request.seen[0];
    assert.equal(o.servername, "peer.example");
    assert.equal(o.headers.host, "peer.example");
    assert.equal(o.path, `/api/soundboard/clip?id=${ID}`);
    assert.equal(o.port, 443);
    assert.deepEqual(o.connectedTo, PIN, "never looked up again: no DNS rebinding");
    let single;
    o.lookup("peer.example", {}, (e, a, f) => { single = [a, f]; });
    assert.deepEqual(single, ["8.8.8.8", 4]);
});

test("no redirects, a body that isn't audio is refused, the cap refuses (declared or streamed), another status passes through", async () => {
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 1000, request: transport({ status: 302, headers: { location: "http://127.0.0.1:8090/" } }) }),
        (e) => e.status === 502 && e.reason === "redirect" && e.upstream === 302);
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 1000, request: transport({ status: 301 }) }), (e) => e.reason === "redirect");
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 1000, request: transport({ body: Buffer.from("<!doctype html><script>x</script>".padEnd(200)) }) }),
        (e) => e.status === 415);
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 1000, request: transport({ body: ADTS, headers: { "content-length": "999999" } }) }),
        (e) => e.status === 413);
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 500, request: transport({ chunks: [ADTS, ADTS] }) }), (e) => e.status === 413);
    assert.deepEqual(await fetchForeignClip(URL1, PIN, { maxBytes: 1000, request: transport({ status: 404 }) }), { status: 404 });
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 1000, timeoutMs: 50, request: transport({ never: true }) }), (e) => e.status === 502);
});

test("the apps' shared vectors (soundRoute): the server takes exactly what the apps send it, and refuses the rest", async () => {
    const { readFileSync } = await import("node:fs");
    const { normaliseClipUrl } = await import("../clipcache.mjs");
    const { soundRoute } = JSON.parse(readFileSync(new URL("./vectors/soundRoute.json", import.meta.url), "utf8"));
    assert.equal(soundRoute.length, 36);
    for (const row of soundRoute) {
        const own = [new URL(row.base).hostname];
        const foreign = parseForeignClipUrl(row.url, own);
        const mi = normaliseClipUrl(row.url);
        if (row.route === "foreign") {
            assert.ok(foreign.url, `refused a foreign link the apps send: ${row.url}`);
            // what the apps put into ?url= is what the server takes
            const sent = new URL(row.play).searchParams.get("url");
            assert.equal(parseForeignClipUrl(sent, own).url, foreign.url, row.url);
        } else if (row.route === "refuse") {
            assert.ok(foreign.error, `took a link the apps refuse: ${row.url}`);
            assert.equal(mi, null, `took a link the apps refuse as myinstants: ${row.url}`);
        } else if (row.route === "own") {
            assert.equal(foreign.reason, "own", `the apps play their own server's sounds directly: ${row.url}`);
        } else if (row.route === "myinstants") {
            // the apps send anything mentioning myinstants.com to the server; the server takes only real myinstants clips
            const sent = new URL(row.play).searchParams.get("url");
            if (/^(https:\/\/www\.myinstants\.com\/|\/)/.test(row.url)) assert.ok(normaliseClipUrl(sent), row.url);
            else assert.equal(normaliseClipUrl(sent) || parseForeignClipUrl(sent, own).url || null, null, `server refuses ${row.url}`);
        } else assert.fail(`unknown route ${row.route}`);
    }
});

test("the stricter contract: whitespace, controls, backslashes, a file name starting with a dot, an over-long one", () => {
    for (const raw of [" https://peer.example.org/api/soundboard/clip?id=1", "https://peer.example.org/api/soundboard/clip?id=1 ",
        "https://peer.example.org/api/soundboard/file/a\tb", "https://peer.example.org/api/soundboard/file/a\u0000b",
        "https://peer.example.org/api/soundboard/file/a\u007fb", "https://peer.example.org/api/soundboard/file/a\\b",
        "https://peer.example.org/api/soundboard/file/.hidden", "https://peer.example.org/api/soundboard/file/.mp3",
        `https://peer.example.org/api/soundboard/file/${"a".repeat(129)}`, `https://peer.example.org/api/soundboard/clip?id=${"a".repeat(129)}`]) {
        assert.ok(parseForeignClipUrl(raw, []).error, JSON.stringify(raw));
    }
    assert.ok(parseForeignClipUrl(`https://peer.example.org/api/soundboard/file/${"a".repeat(128)}`, []).url);
    assert.ok(parseForeignClipUrl("https://peer.example.org/api/soundboard/file/a..b.mp3", []).url, "dots inside are fine");
});

test("a refused answer whose body never ends is torn down at once: no reading on, no cap or deadline escaped (second review, #1)", async () => {
    for (const status of [500, 302, 404]) {
        const request = transport({ status, forever: true });
        const t0 = Date.now();
        const got = fetchForeignClip(URL1, PIN, { maxBytes: 1000, request });
        if (status === 302) await assert.rejects(got, (e) => e.reason === "redirect");
        else assert.deepEqual(await got, { status });
        const rec = request.seen[0];
        assert.equal(rec.resDestroyed, true, `${status}: the response is destroyed`);
        assert.equal(rec.reqDestroyed, true, `${status}: and the request (its socket)`);
        const sent = rec.sent;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(rec.sent, sent, `${status}: nothing more is read`);
        assert.ok(Date.now() - t0 < 1000);
    }
    // a 200 that streams past the cap and a stalled answer: torn down too
    const big = transport({ forever: true });
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 5000, request: big }), (e) => e.status === 413);
    assert.equal(big.seen[0].resDestroyed && big.seen[0].reqDestroyed, true);
    const slow = transport({ never: true });
    await assert.rejects(fetchForeignClip(URL1, PIN, { maxBytes: 5000, timeoutMs: 30, request: slow }), (e) => e.status === 502);
    assert.equal(slow.seen[0].reqDestroyed, true);
});

test("resolution runs inside the one deadline and is cancelled with it; a private answer never connects (second review, #2)", async () => {
    const hang = resolver({ hang: true });
    const request = transport({ body: ADTS });
    const t0 = Date.now();
    await assert.rejects(foreignDownload(URL1, "peer.example.org", { maxBytes: 1000, timeoutMs: 60, resolver: hang, request }), (e) => e.status === 502);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(hang.cancelled, true, "the resolver's queries are cancelled, not left running");
    assert.equal(request.seen.length, 0);
    const priv = transport({ body: ADTS });
    await assert.rejects(foreignDownload(URL1, "peer.example.org", { maxBytes: 1000, resolver: resolver({ v4: ["192.168.1.9"] }), request: priv }),
        (e) => e.status === 403 && e.reason === "not-public");
    assert.equal(priv.seen.length, 0, "never connected");
    const ok = transport({ body: ADTS });
    const got = await foreignDownload(URL1, "peer.example.org", { maxBytes: 1000, resolver: resolver({ v4: ["8.8.4.4"] }), request: ok });
    assert.equal(got.type, "audio/aac");
    assert.deepEqual(ok.seen[0].connectedTo, { address: "8.8.4.4", family: 4 });
});

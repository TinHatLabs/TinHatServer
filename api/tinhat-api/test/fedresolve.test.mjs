// fedresolve.mjs — another server's OpenID token resolved here with SSRF guards (calls round M1b residual): the
// spec's server discovery (IP literal, explicit port, .well-known delegation, SRV, 8448), public addresses only and
// pinned, TLS names, redirects, caps, the userinfo answer. A scripted resolver and https.request; nothing on the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createFedResolver, parseServerName, FED } from "../fedresolve.mjs";

/** dns: {A: {host: [ip]}, AAAA: {...}, SRV: {name: [{name, port, priority, weight}]}}; web: (opts) -> {status, body|text, headers} */
function fx({ A = {}, AAAA = {}, SRV = {}, web = () => ({ status: 404, body: {} }) } = {}) {
    const dnsCalls = [], reqs = [];
    const resolver = () => ({
        resolve4: async (h) => { dnsCalls.push(`A ${h}`); if (A[h]) return A[h]; throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
        resolve6: async (h) => { dnsCalls.push(`AAAA ${h}`); if (AAAA[h]) return AAAA[h]; throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
        resolveSrv: async (n) => { dnsCalls.push(`SRV ${n}`); if (SRV[n]) return SRV[n]; throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
        cancel: () => {},
    });
    function request(opts, cb) {
        const req = new EventEmitter();
        let pinned;
        opts.lookup(opts.host, {}, (_e, address) => { pinned = address; });
        const rec = { host: opts.host, servername: opts.servername, port: opts.port, path: opts.path, hostHeader: opts.headers.host, pinned };
        reqs.push(rec);
        req.destroy = () => {};
        req.end = () => setImmediate(() => {
            const a = web(rec);
            if (a.dead) return req.emit("error", new Error("ECONNREFUSED"));
            const res = new EventEmitter();
            res.statusCode = a.status;
            const text = a.text ?? JSON.stringify(a.body ?? {});
            res.headers = { "content-type": "application/json", ...(a.headers || {}) };
            res.destroy = () => {};
            cb(res);
            setImmediate(() => { res.emit("data", Buffer.from(text)); res.emit("end"); });
        });
        return req;
    }
    let t = 1_000_000;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    const fed = createFedResolver({ resolver, request, now });
    return { fed, dnsCalls, reqs, now };
}

const WK = "/.well-known/matrix/server";
const UI = "/_matrix/federation/v1/openid/userinfo?access_token=";

test("server_names_parse_as_the_spec_allows", () => {
    assert.deepEqual(parseServerName("Example.ORG"), { host: "example.org", port: null, ip: false, raw: "example.org" });
    assert.deepEqual(parseServerName("example.org:8448"), { host: "example.org", port: 8448, ip: false, raw: "example.org:8448" });
    assert.deepEqual(parseServerName("1.2.3.4:99"), { host: "1.2.3.4", port: 99, ip: true, raw: "1.2.3.4:99" });
    assert.equal(parseServerName("[2a00::1]:8448").host, "2a00::1");
    for (const bad of ["", "a b", "x/y", "x?y", "user@x", "x:0", "x:65536", "x:abc", "[zz]", "a..b", "-a.b", "x#"]) assert.equal(parseServerName(bad), null, bad);
});

test("an_ip_literal_or_an_explicit_port_is_used_as_is", async () => {
    const { fed, reqs, dnsCalls } = fx({ A: { "other.test": ["93.184.216.34"] } });
    assert.deepEqual(await fed.discover("1.2.3.4"), [{ host: "1.2.3.4", hostHeader: "1.2.3.4", port: 8448, pin: { address: "1.2.3.4", family: 4 } }]);
    const [d] = await fed.discover("other.test:8443");
    assert.deepEqual([d.host, d.hostHeader, d.port, d.pin.address], ["other.test", "other.test:8443", 8443, "93.184.216.34"]);
    assert.equal(reqs.length, 0, "no well-known for an explicit port");
    assert.ok(!dnsCalls.some((c) => c.startsWith("SRV")));
});

test("private_or_mixed_answers_are_refused", async () => {
    const { fed } = fx({ A: { "lan.test": ["192.168.1.5"], "mixed.test": ["93.184.216.34", "10.0.0.7"], "nat.test": ["100.64.1.1"] } });
    for (const name of ["10.0.0.1", "127.0.0.1:8448", "[::1]", "lan.test:8448", "mixed.test:8448", "nat.test:8448", "169.254.169.254",
        "[::ffff:10.0.0.1]", "[::ffff:a00:1]", "[fe80::1]", "[fc00::1]", "[::]", "0.0.0.0", "lan.test"]) {
        await assert.rejects(fed.discover(name), (e) => e.status === 403 && e.reason === "not-public", name);
    }
});

test("a_well_known_delegation_is_followed_with_tls_on_the_delegated_name", async () => {
    const { fed, reqs } = fx({
        A: { "other.test": ["93.184.216.34"], "matrix.other.test": ["93.184.216.35"] },
        web: (r) => (r.path === WK && r.host === "other.test" ? { status: 200, body: { "m.server": "matrix.other.test:443" } } : { status: 404 }),
    });
    const [d] = await fed.discover("other.test");
    assert.deepEqual(reqs[0], { host: "other.test", servername: "other.test", port: 443, path: WK, hostHeader: "other.test", pinned: "93.184.216.34" });
    assert.deepEqual([d.host, d.hostHeader, d.port, d.pin.address], ["matrix.other.test", "matrix.other.test:443", 443, "93.184.216.35"]);
});

test("srv_after_a_delegation_connects_to_the_target_but_keeps_the_delegated_name", async () => {
    const { fed } = fx({
        A: { "other.test": ["93.184.216.34"], "fed.other.test": ["93.184.216.36"] },
        SRV: { "_matrix-fed._tcp.matrix.other.test": [{ name: "fed.other.test", port: 8449, priority: 10, weight: 5 }, { name: "slow.other.test", port: 1, priority: 20, weight: 99 }] },
        web: (r) => (r.path === WK ? { status: 200, body: { "m.server": "matrix.other.test" } } : { status: 404 }),
    });
    const list = await fed.discover("other.test");
    assert.deepEqual(list.map((d) => [d.host, d.hostHeader, d.port, d.pin.address]), [["matrix.other.test", "matrix.other.test", 8449, "93.184.216.36"]],
        "a target that doesn't resolve is skipped");
});

test("no_well_known_and_no_srv_is_port_8448_and_the_legacy_srv_counts", async () => {
    let r = fx({ A: { "other.test": ["93.184.216.34"] } });
    let [d] = await r.fed.discover("other.test");
    assert.deepEqual([d.host, d.port], ["other.test", FED.PORT]);
    assert.ok(r.dnsCalls.includes("SRV _matrix-fed._tcp.other.test") && r.dnsCalls.includes("SRV _matrix._tcp.other.test"));
    r = fx({ A: { "other.test": ["93.184.216.34"], "old.other.test": ["93.184.216.37"] }, SRV: { "_matrix._tcp.other.test": [{ name: "old.other.test", port: 8000, priority: 0, weight: 0 }] } });
    [d] = await r.fed.discover("other.test");
    assert.deepEqual([d.host, d.port, d.pin.address], ["other.test", 8000, "93.184.216.37"]);
});

test("an_srv_target_on_a_private_address_is_refused", async () => {
    const { fed } = fx({ A: { "other.test": ["93.184.216.34"], "inside.other.test": ["10.1.1.1"] },
        SRV: { "_matrix-fed._tcp.other.test": [{ name: "inside.other.test", port: 8448, priority: 0, weight: 0 }] } });
    await assert.rejects(fed.discover("other.test"), (e) => e.status === 403);
});

test("well_known_redirects_are_checked_and_bounded", async () => {
    // https -> https on another public host: followed
    let r = fx({ A: { "other.test": ["93.184.216.34"], "www.other.test": ["93.184.216.38"], "m.other.test": ["93.184.216.39"] },
        web: (q) => (q.host === "other.test" ? { status: 301, headers: { location: "https://www.other.test/.well-known/matrix/server" } }
            : q.host === "www.other.test" ? { status: 200, body: { "m.server": "m.other.test:8448" } } : { status: 404 }) });
    assert.equal((await r.fed.discover("other.test"))[0].host, "m.other.test");
    // to http: no delegation (the server itself on 8448)
    r = fx({ A: { "other.test": ["93.184.216.34"] }, web: () => ({ status: 302, headers: { location: "http://other.test/x" } }) });
    assert.deepEqual([(await r.fed.discover("other.test"))[0].host, (await r.fed.discover("other.test"))[0].port], ["other.test", 8448]);
    // to a private host: never fetched, counted as no well-known (the spec's next steps still run, guarded)
    r = fx({ A: { "other.test": ["93.184.216.34"], "lan.other.test": ["192.168.0.2"] }, web: () => ({ status: 302, headers: { location: "https://lan.other.test/" } }) });
    assert.deepEqual((await r.fed.discover("other.test")).map((d) => [d.host, d.port]), [["other.test", 8448]]);
    assert.ok(!r.reqs.some((q) => q.host === "lan.other.test"), "nothing sent to the private host");
    // an apex on a private address with a public SRV target: the SRV is used
    r = fx({ A: { "other.test": ["10.9.9.9"], "fed.other.test": ["93.184.216.40"] }, SRV: { "_matrix-fed._tcp.other.test": [{ name: "fed.other.test", port: 8448, priority: 0, weight: 0 }] } });
    assert.equal((await r.fed.discover("other.test"))[0].pin.address, "93.184.216.40");
    assert.equal(r.reqs.length, 0, "the private apex's well-known isn't fetched");
    // a loop: given up after 3 hops
    r = fx({ A: { "other.test": ["93.184.216.34"] }, web: () => ({ status: 302, headers: { location: "https://other.test/.well-known/matrix/server" } }) });
    assert.equal((await r.fed.discover("other.test"))[0].port, 8448);
    assert.equal(r.reqs.length, FED.REDIRECTS + 1);
});

test("userinfo_answers_only_for_that_servers_users", async () => {
    let answer = { status: 200, body: { sub: "@bob:other.test" } };
    const { fed, reqs } = fx({ A: { "other.test": ["93.184.216.34"] }, web: (r) => (r.path.startsWith(UI) ? answer : { status: 404 }) });
    assert.deepEqual(await fed.userinfo("other.test", "to/k en"), { sub: "@bob:other.test" });
    const u = reqs.at(-1);
    assert.deepEqual([u.host, u.port, u.hostHeader, u.path], ["other.test", 8448, "other.test", `${UI}to%2Fk%20en`]);
    answer = { status: 200, body: { sub: "@admin:home.test" } };
    assert.equal(await fed.userinfo("other.test", "t"), null, "a server can only vouch for its own users");
    answer = { status: 200, body: { sub: "@bob:other.test.evil" } };
    assert.equal(await fed.userinfo("other.test", "t"), null);
    answer = { status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } };
    assert.equal(await fed.userinfo("other.test", "t"), null);
    answer = { status: 500, body: {} };
    await assert.rejects(fed.userinfo("other.test", "t"), (e) => e.status === 502);
    answer = { status: 200, text: JSON.stringify({ sub: "@bob:other.test", pad: "x".repeat(FED.MAX_BYTES) }) };
    await assert.rejects(fed.userinfo("other.test", "t"), (e) => e.status === 502, "over the byte cap");
    answer = { status: 307, headers: { location: "https://elsewhere.test/" } };
    await assert.rejects(fed.userinfo("other.test", "t"), (e) => e.status === 502, "userinfo is never redirected");
});

test("discovery_is_cached_ten_minutes", async () => {
    const { fed, dnsCalls, now } = fx({ A: { "other.test": ["93.184.216.34"] } });
    await fed.discover("other.test");
    const n = dnsCalls.length;
    await fed.discover("other.test");
    assert.equal(dnsCalls.length, n);
    now.advance(FED.CACHE_MS);
    await fed.discover("other.test");
    assert.ok(dnsCalls.length > n);
});

test("an_unknown_name_is_502", async () => {
    const { fed } = fx();
    await assert.rejects(fed.discover("nowhere.test"), (e) => e.status === 502);
});

test("srv_targets_are_tried_in_order_and_a_failed_set_is_found_again", async () => {
    const down = new Set(["93.184.216.41"]);
    const { fed, reqs, dnsCalls } = fx({
        A: { "other.test": ["93.184.216.34"], "a.other.test": ["93.184.216.41"], "b.other.test": ["93.184.216.42"], "lan.other.test": ["10.0.0.3"] },
        SRV: { "_matrix-fed._tcp.other.test": [{ name: "a.other.test", port: 8448, priority: 0, weight: 9 },
            { name: "lan.other.test", port: 8448, priority: 0, weight: 5 }, { name: "b.other.test", port: 8448, priority: 1, weight: 0 }] },
        web: (r) => (down.has(r.pinned) ? { status: 599 } : r.path.startsWith(UI) ? { status: 200, body: { sub: "@bob:other.test" } } : { status: 404 }),
    });
    const list = await fed.discover("other.test");
    assert.deepEqual(list.map((d) => d.pin.address), ["93.184.216.41", "93.184.216.42"], "ordered; the private target skipped");
    // 599 = an answer (not a dead endpoint): reported as such
    await assert.rejects(fed.userinfo("other.test", "t"), (e) => e.status === 502);
    assert.equal(reqs.filter((r) => r.path.startsWith(UI)).length, 1, "an answering endpoint isn't retried elsewhere");
    void dnsCalls;
});

test("the_deadline_covers_the_whole_discovery", async () => {
    const { fed, now } = fx({ A: { "other.test": ["93.184.216.34"] } });
    await assert.rejects(fed.discover("other.test", now() - 1), (e) => e.status === 502, "no time left: nothing starts");
});

test("a_root_dot_name_parses", () => {
    assert.equal(parseServerName("example.org.").host, "example.org.");
});

test("a_dead_srv_target_falls_back_to_the_next", async () => {
    const { fed, reqs } = fx({
        A: { "a.other.test": ["93.184.216.41"], "b.other.test": ["93.184.216.42"] },
        SRV: { "_matrix-fed._tcp.other.test": [{ name: "a.other.test", port: 8448, priority: 0, weight: 0 }, { name: "b.other.test", port: 8448, priority: 1, weight: 0 }] },
        web: (r) => (r.pinned === "93.184.216.41" ? { dead: true } : r.path.startsWith(UI) ? { status: 200, body: { sub: "@bob:other.test" } } : { status: 404 }),
    });
    assert.deepEqual(await fed.userinfo("other.test", "t"), { sub: "@bob:other.test" });
    assert.deepEqual(reqs.filter((r) => r.path.startsWith(UI)).map((r) => r.pinned), ["93.184.216.41", "93.184.216.42"]);
});

test("all_dead_forgets_the_route", async () => {
    const { fed } = fx({ A: { "other.test": ["93.184.216.34"] }, web: (r) => (r.path.startsWith(UI) ? { dead: true } : { status: 404 }) });
    await assert.rejects(fed.userinfo("other.test", "t"), (e) => e.status === 502);
    assert.equal(fed._cache.has("other.test"), false);
});

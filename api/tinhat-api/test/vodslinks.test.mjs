// vodslinks.mjs (round 3 security review, RECORDER-8): a Memories link is bound to the person it was issued to, who
// must still be joined to the session's room; older links (no person) keep working until they expire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { vodsSig, vodsQuery, vodsAllowed, memberCache } from "../vodslinks.mjs";

const SECRET = ["vods", "test", "only"].join("-");
const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ROOM = "!r:example.org", P = "_r_example.org/s1/track.mka";
const q = (s) => Object.fromEntries(new URLSearchParams(s));

function setup(members) {
    const dir = mkdtempSync(join(tmpdir(), "vodslinks-"));
    mkdirSync(join(dir, "_r_example.org", "s1"), { recursive: true });
    writeFileSync(join(dir, "_r_example.org", "s1", "session.json"), JSON.stringify({ room: ROOM, start_ms: 1 }));
    let reads = 0, t = 1_000_000;
    const joined = memberCache(async (room) => { reads++; if (members.fail) throw new Error("down"); return room === ROOM ? new Set(members.list) : null; }, { now: () => t });
    const deps = { secret: SECRET, sameHex, vodsDir: dir, joined, now: () => t };
    return { dir, deps, advance: (ms) => { t += ms; }, reads: () => reads, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a link works for its holder while they're in the room, and stops within a minute of them leaving", async () => {
    const m = { list: ["@a:example.org"] };
    const s = setup(m);
    try {
        const link = q(vodsQuery(SECRET, P, 2_000_000, "@a:example.org"));
        assert.deepEqual(await vodsAllowed(s.deps, P, link), { ok: true });
        m.list = [];  // kicked
        assert.deepEqual(await vodsAllowed(s.deps, P, link), { ok: true }, "the member list is kept a minute");
        s.advance(61_000);
        assert.deepEqual(await vodsAllowed(s.deps, P, link), { status: 403 }, "then refused");
        assert.equal(s.reads(), 2);
    } finally { s.cleanup(); }
});

test("the person is part of the signature: changing or dropping it breaks the link", async () => {
    const s = setup({ list: ["@a:example.org", "@b:example.org"] });
    try {
        const link = q(vodsQuery(SECRET, P, 2_000_000, "@a:example.org"));
        assert.equal((await vodsAllowed(s.deps, P, { ...link, u: "@b:example.org" })).status, 403);
        const { u, ...noUser } = link;
        assert.equal((await vodsAllowed(s.deps, P, noUser)).status, 403, "can't be turned into an older-form link");
        assert.equal((await vodsAllowed(s.deps, "_r_example.org/s1/other.mka", link)).status, 403, "bound to its file");
    } finally { s.cleanup(); }
});

test("older links (no person) keep working until they expire; expired, bad paths and unknown rooms are refused; a failed check is 502", async () => {
    const m = { list: ["@a:example.org"] };
    const s = setup(m);
    try {
        const old = { exp: "2000000", sig: vodsSig(SECRET, P, 2_000_000) };
        assert.deepEqual(await vodsAllowed(s.deps, P, old), { ok: true });
        assert.equal((await vodsAllowed(s.deps, P, { exp: "999", sig: vodsSig(SECRET, P, 999) })).status, 403, "expired");
        assert.equal((await vodsAllowed(s.deps, "_r_example.org/../x", old)).status, 400);
        const nosession = q(vodsQuery(SECRET, "_r_example.org/s2/t.mka", 2_000_000, "@a:example.org"));
        assert.equal((await vodsAllowed(s.deps, "_r_example.org/s2/t.mka", nosession)).status, 403, "no session.json: no room to check");
        m.fail = true;
        s.advance(61_000);
        assert.equal((await vodsAllowed(s.deps, P, q(vodsQuery(SECRET, P, 2_000_000, "@a:example.org")))).status, 502);
    } finally { s.cleanup(); }
});

test("odd query shapes are refused, never thrown (Express makes objects and arrays out of exp[x]= and exp=1&exp=2)", async () => {
    const s = setup({ list: ["@a:example.org"] });
    try {
        const link = q(vodsQuery(SECRET, P, 2_000_000, "@a:example.org"));
        for (const bad of [{ ...link, exp: { toString: "x" } }, { ...link, exp: ["2000000", "1"] }, { ...link, u: ["@a:example.org"] },
            { ...link, sig: { a: 1 } }]) assert.equal((await vodsAllowed(s.deps, P, bad)).status, 400);
        assert.equal((await vodsAllowed(s.deps, P, { ...link, exp: "2e6" })).status, 403);
        assert.equal((await vodsAllowed(s.deps, P, { ...link, exp: "-1" })).status, 403);
    } finally { s.cleanup(); }
});

test("a burst of requests shares one member-list read; a failed read is remembered briefly", async () => {
    let reads = 0, release, fail = false, t = 0;
    const joined = memberCache(async () => { reads++; if (fail) throw new Error("down"); await new Promise((r) => { release = r; }); return new Set(["@a:x"]); }, { now: () => t });
    const all = Array.from({ length: 20 }, () => joined("!r:x", "@a:x"));
    await new Promise((r) => setTimeout(r, 10));
    release();
    assert.deepEqual(await Promise.all(all), Array(20).fill(true));
    assert.equal(reads, 1);
    t += 61_000; fail = true;
    await assert.rejects(joined("!r:x", "@a:x"));
    await assert.rejects(joined("!r:x", "@a:x"), /just now/, "remembered: no second read");
    assert.equal(reads, 2);
    t += 6_000; fail = false;
    const again = joined("!r:x", "@a:x");
    await new Promise((r) => setTimeout(r, 10));
    release();
    assert.equal(await again, true, "after the pause it reads again");
});

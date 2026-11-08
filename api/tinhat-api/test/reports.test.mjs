// reports.mjs — an abuse report's shape (docs/ACCOUNT-SAFETY.md; the apps send it from "Report…").
import { test } from "node:test";
import assert from "node:assert/strict";
import { abuseReport, isAbuse, ABUSE_CATEGORIES } from "../reports.mjs";

const ME = "@me:example.org";

test("only kind or type \"abuse\" is an abuse report; bug reports and older apps' reports are not", () => {
    assert.equal(isAbuse({ kind: "abuse" }), true);
    assert.equal(isAbuse({ type: "abuse" }), true);
    assert.equal(isAbuse({ type: "bug", title: "x" }), false);
    assert.equal(isAbuse(null), false);
    assert.equal(isAbuse([]), false);
});

test("a person, a message, both; the reporter is always the sender", () => {
    const p = abuseReport({ kind: "abuse", reported_user: "@bad:example.org", category: "spam", reporter: "@forged:x" }, ME);
    assert.equal(p.reporter, ME);
    assert.equal(p.reported_user, "@bad:example.org");
    assert.equal(p.category, "spam");
    assert.equal(p.room_id, undefined);
    const m = abuseReport({ kind: "abuse", room_id: "!r:example.org:8448", event_id: "$abc_DEF-1" }, ME);
    assert.equal(m.event_id, "$abc_DEF-1");
    assert.equal(m.title, "[report] other: $abc_DEF-1");
});

test("bad ids are refused, unknown categories become other, text is bounded", () => {
    for (const bad of [{ reported_user: "bad" }, { reported_user: "@a b:x" }, { reported_user: "@a:x/y" },
        { reported_user: "@a:x", room_id: "r:x" }, { room_id: "!r:x", event_id: "e" }, { event_id: "$e" }, {}]) {
        assert.ok(abuseReport({ kind: "abuse", ...bad }, ME).error, JSON.stringify(bad));
    }
    const r = abuseReport({ kind: "abuse", reported_user: "@a:x", category: "nope", details: "😀".repeat(1500) + "\u0000",
        title: 42, platform: "p".repeat(200) }, ME);
    assert.equal(r.category, "other");
    assert.equal(Array.from(r.details).length, 1000);
    assert.ok(!r.details.includes("�"), "no emoji cut in half");
    assert.equal(r.platform.length, 80);
    assert.deepEqual(ABUSE_CATEGORIES, ["spam", "harassment", "sexual", "violence", "other"]);
    assert.equal(Object.keys(r).includes("extra"), false);
});

test("ids as Matrix has them: domainless room ids (room version 12), IPv6 servers, ports; at most 255 bytes, well-formed", () => {
    assert.equal(abuseReport({ kind: "abuse", room_id: "!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ", event_id: "$e" }, ME).room_id,
        "!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ");
    assert.equal(abuseReport({ kind: "abuse", reported_user: "@a:[2001:db8::1]:8448" }, ME).reported_user, "@a:[2001:db8::1]:8448");
    assert.equal(abuseReport({ kind: "abuse", reported_user: "@a:example.org:8448" }, ME).reported_user, "@a:example.org:8448");
    assert.ok(abuseReport({ kind: "abuse", reported_user: "@" + "a".repeat(250) + ":example.org" }, ME).error, "over 255 bytes");
    assert.ok(abuseReport({ kind: "abuse", room_id: "!r:x", event_id: "$\ud800" }, ME).error, "a lone surrogate");
    assert.ok(abuseReport({ kind: "abuse", reported_user: "@\udc00:x" }, ME).error);
    const r = abuseReport({ kind: "abuse", reported_user: "@a:x", details: "ok \ud800 ok" }, ME);
    assert.ok(r.details.isWellFormed());
});

// ── stored size and nesting (a problem report's body is the app's JSON; what is written is bounded) ────────────────
import { depthWithin, reportText, quotaFile, REPORT_MAX_DEPTH, REPORT_MAX_WRITE_BYTES } from "../reports.mjs";
import { RateLimit } from "../reachcommon.mjs";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nested = (n, inner = "0") => "[".repeat(n) + inner + "]".repeat(n);

test("nesting: at most 32 levels; checked without recursion, so a body the parser took can't overflow the check", () => {
    assert.equal(REPORT_MAX_DEPTH, 32);
    assert.equal(depthWithin(JSON.parse(nested(32))), true);
    assert.equal(depthWithin(JSON.parse(nested(33))), false);
    assert.equal(depthWithin({ a: { b: [1, { c: 2 }] }, d: "x" }), true);
    assert.equal(depthWithin(JSON.parse(`{"a":${nested(32)}}`)), false, "objects count as levels too");
    assert.equal(depthWithin(42), true);
    assert.equal(depthWithin(null), true);
    const deep = JSON.parse(nested(400_000));  // V8's parser is iterative: this parses ...
    assert.throws(() => JSON.stringify(deep), RangeError, "... and the serialiser can't write it");
    assert.equal(depthWithin(deep), false, "refused before anything serialises it");
});

test("what is written: compact JSON, its real size, refused (never thrown) when it can't be written or is too big", () => {
    const ok = reportText({ at: 1, user: "@a:x", report: { title: "t" } });
    assert.equal(ok.text, '{"at":1,"user":"@a:x","report":{"title":"t"}}');
    assert.equal(ok.bytes, Buffer.byteLength(ok.text));
    assert.equal(reportText({ report: JSON.parse(nested(400_000)) }).status, 400);
    // numbers grow when written again (1e20 → 100000000000000000000): what counts is the written size
    const grows = JSON.parse("[" + Array(60_000).fill("1e20").join(",") + "]");
    const r = reportText({ at: 1, user: "@a:x", report: grows });
    assert.equal(r.status, 413);
    assert.ok(REPORT_MAX_WRITE_BYTES < 1.1 * 1024 * 1024);
    // the old writer (indent 1) blew a moderately nested body up far past what arrived
    const wide = JSON.parse(nested(30, Array(2000).fill("0").join(",")));
    const old = JSON.stringify(wide, null, 1).length, now = reportText(wide).bytes;
    assert.ok(old > 10 * now, `indent: ${old} bytes; compact: ${now}`);
    assert.ok(now <= JSON.stringify(wide).length);
});

test("daily quotas survive a restart (kept in a file; old, future and junk entries dropped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-"));
    try {
        let t = 1_800_000_000_000;
        const now = () => t;
        const file = join(dir, "q.json");
        const fs = { readFileSync, writeFileSync, renameSync, statSync };
        const a = new RateLimit(2, 24 * 3600_000, now);
        const qa = quotaFile(file, { reports: a }, fs);
        qa.load();  // no file yet: nothing
        assert.equal(a.hit("@m:x"), true);
        assert.equal(a.hit("@m:x"), true);
        qa.save();
        const b = new RateLimit(2, 24 * 3600_000, now);  // "restarted"
        quotaFile(file, { reports: b }, fs).load();
        assert.equal(b.hit("@m:x"), false, "the day isn't fresh after a restart");
        assert.equal(b.hit("@n:x"), true, "others unaffected");
        t += 24 * 3600_000;
        const c = new RateLimit(2, 24 * 3600_000, now);
        quotaFile(file, { reports: c }, fs).load();
        assert.equal(c.hit("@m:x"), true, "a day later: allowed again");
        writeFileSync(file, JSON.stringify({ reports: { "@j:x": ["x", null, t + 9e9, t - 1] }, other: 5 }));
        const d = new RateLimit(2, 24 * 3600_000, now);
        quotaFile(file, { reports: d }, fs).load();
        assert.deepEqual(d.m.get("@j:x"), [t - 1]);
        const logs = [];
        writeFileSync(file, "not json");
        quotaFile(file, { reports: new RateLimit(2, 1000, now) }, fs, (l) => logs.push(l)).load();  // ignored, no throw
        assert.match(logs.join(), /ALERT/, "a damaged file is reported, not taken for a missing one");
        logs.length = 0;
        writeFileSync(file, JSON.stringify({ reports: [] }));
        quotaFile(file, { reports: new RateLimit(2, 1000, now) }, fs, (l) => logs.push(l)).load();
        assert.match(logs.join(), /ALERT.*"reports" isn't a map/, "a wrong shape is reported too");
        logs.length = 0;
        writeFileSync(file, "[]");
        quotaFile(file, { reports: new RateLimit(2, 1000, now) }, fs, (l) => logs.push(l)).load();
        assert.match(logs.join(), /ALERT/);
        truncateSync(file, 17 * 1024 * 1024);
        const e = new RateLimit(2, 1000, now);
        quotaFile(file, { reports: e }, fs, (l) => logs.push(l)).load();
        assert.equal(e.m.size, 0, "an oversized file isn't read");
        assert.match(logs.at(-1), /too big/);
        const ro = quotaFile(join(dir, "no-such-dir", "q.json"), { reports: new RateLimit(2, 1000, now) }, fs, () => {});
        assert.equal(ro.save(), false, "a write that fails is reported to the caller");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

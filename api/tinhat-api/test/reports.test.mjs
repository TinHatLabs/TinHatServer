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

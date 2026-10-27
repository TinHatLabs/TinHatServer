// api/games/limits.mjs — the games catalogue's request limits (security review 2026-10-26: it had none).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGamesLimits, customAllowed, G } from "../../games/limits.mjs";
import { clock } from "./helpers.mjs";

test("per address: art has its own larger allowance; health is never limited", () => {
    const now = clock();
    const l = createGamesLimits(now);
    for (let i = 0; i < G.OTHER_PER_MIN; i++) assert.equal(l.request("/search", "198.51.100.1"), true);
    assert.equal(l.request("/seed", "198.51.100.1"), false);
    assert.equal(l.request("/art/steam:1/portrait", "198.51.100.1"), true, "covers still load");
    assert.equal(l.request("/health", "198.51.100.1"), true);
    assert.equal(l.request("/seed", "198.51.100.2"), true, "another caller");
    now.advance(60_001);
    assert.equal(l.request("/seed", "198.51.100.1"), true);
});

test("per person: searches a minute, custom games a day, library imports an hour", () => {
    const now = clock();
    const l = createGamesLimits(now);
    for (let i = 0; i < G.SEARCH_PER_MIN; i++) assert.equal(l.user("search", "@a:x"), true);
    assert.equal(l.user("search", "@a:x"), false);
    assert.equal(l.user("search", "@b:x"), true);
    assert.ok(l.retryAfter("search", "@a:x") >= 1);
    for (let i = 0; i < G.CUSTOM_PER_DAY; i++) assert.equal(l.user("custom", "@a:x"), true);
    assert.equal(l.user("custom", "@a:x"), false);
    now.advance(3600_000);
    assert.equal(l.user("custom", "@a:x"), false, "a day, not an hour");
    for (let i = 0; i < G.LIBRARY_PER_HOUR; i++) assert.equal(l.user("library", "@a:x"), true);
    assert.equal(l.user("library", "@a:x"), false);
});

test("custom games: at most CUSTOM_MAX made by one person in the catalogue", () => {
    const rows = Array.from({ length: G.CUSTOM_MAX - 1 }, (_, i) => ({ id: `custom:g${i}`, source: "custom", createdBy: "@a:x" }));
    rows.push({ id: "steam:1", source: "steam" }, { id: "custom:o", source: "custom", createdBy: "@b:x" }, null);
    assert.equal(customAllowed(rows, "@a:x"), true);
    rows.push({ id: "custom:last", source: "custom", createdBy: "@a:x" });
    assert.equal(customAllowed(rows, "@a:x"), false);
    assert.equal(customAllowed(rows, "@b:x"), true);
});

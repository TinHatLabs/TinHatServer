// The shared limiter's tiers (limits.mjs): clip reads get their own allowance, the rest stays strict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimits, STRICT_PER_MIN, SESSIONS_PER_MIN, CLIPS_PER_MIN } from "../limits.mjs";
import { clock } from "./helpers.mjs";

function hits(l, path, ip, n) {
    let ok = 0;
    for (let i = 0; i < n; i++) if (l.request(path, ip)) ok++;
    return ok;
}

test("everything outside the listed routes: 30 a minute per address", () => {
    const l = createLimits(clock());
    assert.equal(hits(l, "/search", "198.51.100.7", STRICT_PER_MIN + 5), STRICT_PER_MIN);
    assert.equal(l.request("/gif/trending", "198.51.100.7"), false, "one bucket for all strict routes");
    assert.equal(l.request("/search", "198.51.100.8"), true, "per address");
});

test("clip reads: 240 a minute, and they leave the strict allowance alone", () => {
    const l = createLimits(clock());
    const ip = "198.51.100.7";
    assert.equal(hits(l, "/clip", ip, 200), 200);
    assert.equal(hits(l, "/fetch", ip, 50), CLIPS_PER_MIN - 200, "/fetch (the old name) shares the clip tier");
    assert.equal(l.request("/clip", ip), false);
    assert.equal(hits(l, "/search", ip, STRICT_PER_MIN), STRICT_PER_MIN, "the strict tier is untouched");
});

test("a clip fetched from upstream also costs a strict one", () => {
    const l = createLimits(clock());
    const ip = "198.51.100.7";
    for (let i = 0; i < STRICT_PER_MIN; i++) assert.equal(l.upstreamFetch(ip), true);
    assert.equal(l.upstreamFetch(ip), false, "the 31st uncached clip in a minute waits");
    assert.equal(l.request("/search", ip), false, "and it is the same strict bucket");
    assert.equal(l.request("/clip", ip), true, "cached clips still play");
});

test("the signed media plane is exempt, sessions get 60", () => {
    const l = createLimits(clock());
    const ip = "198.51.100.7";
    assert.equal(hits(l, "/vods/file/r/s/a.mp4", ip, 1000), 1000);
    assert.equal(hits(l, "/vods/thumb/r/s/t.jpg", ip, 1000), 1000);
    assert.equal(hits(l, "/vods/sessions", ip, SESSIONS_PER_MIN + 3), SESSIONS_PER_MIN);
    assert.equal(l.request("/search", ip), true, "sessions don't use the strict bucket");
});

test("the window slides: a minute later it plays again", () => {
    const now = clock();
    const l = createLimits(now);
    const ip = "198.51.100.7";
    assert.equal(hits(l, "/clip", ip, CLIPS_PER_MIN + 1), CLIPS_PER_MIN);
    now.advance(60_001);
    assert.equal(l.request("/clip", ip), true);
    l.sweep();
    assert.equal(l.request("/clip", ip), true);
});

test("the clip tier covers the route variants Express serves (case, trailing slash)", () => {
    const l = createLimits(clock());
    const ip = "198.51.100.7";
    for (const p of ["/clip/", "/CLIP", "/Fetch/", "/fetch//"]) assert.equal(l.request(p, ip), true, p);
    assert.equal(hits(l, "/search", ip, STRICT_PER_MIN), STRICT_PER_MIN, "none of them took a strict one");
});

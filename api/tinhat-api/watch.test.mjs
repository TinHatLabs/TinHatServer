// watch.test.mjs — unit tests for the pure parts of watch.mjs (Media Party server, Tin Hat 11.4).
// Run in api/tinhat-api:   node --test watch.test.mjs
// Importing watch.mjs has no side effects (no store, no network); only installWatch() opens the DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MIN_CONFIDENCE, iso8601ToSec, pacificDay, pacificResetAt, parseMediaUrl,
    normaliseTitle, similarity, scoreCandidate, rankCandidates, pickBest,
} from "./watch.mjs";

// ── resolver ranking ──
const want = { artist: "Rick Astley", title: "Never Gonna Give You Up", durationSec: 213 };

test("exact match on a '- Topic' channel wins over the official video and a lyric upload", () => {
    const cands = [
        { id: "lyr", title: "Rick Astley - Never Gonna Give You Up (Lyrics)", channel: "LyricsVault", durationSec: 213 },
        { id: "off", title: "Rick Astley - Never Gonna Give You Up (Official Video)", channel: "Rick Astley", durationSec: 213 },
        { id: "top", title: "Never Gonna Give You Up", channel: "Rick Astley - Topic", description: "Provided to YouTube by Sony Music · Never Gonna Give You Up", durationSec: 213 },
    ];
    const ranked = rankCandidates(cands, want);
    assert.equal(ranked[0].id, "top");
    assert.equal(ranked[0].confidence, 1);
    assert.equal(ranked[0].parts.topic, 0.3);
    assert.equal(ranked[0].parts.artistHit, 0.2);
    assert.equal(ranked[0].parts.dur, 0.3);
    assert.ok(ranked[0].score > ranked[1].score, "Topic upload must outscore the official video");
    assert.equal(pickBest(cands, want).id, "top");
});

test("'Provided to YouTube by' counts like a Topic channel", () => {
    const a = scoreCandidate({ title: "Never Gonna Give You Up", channel: "Rick Astley", description: "Provided to YouTube by Sony Music Entertainment" }, want);
    const b = scoreCandidate({ title: "Never Gonna Give You Up", channel: "Rick Astley", description: "The official video" }, want);
    assert.equal(a.parts.topic, 0.3);
    assert.equal(b.parts.topic, 0);
});

test("a cover and a live version lose to the original", () => {
    const w = { artist: "Radiohead", title: "Creep", durationSec: 238 };
    const cands = [
        { id: "cover", title: "Creep - Radiohead (Cover)", channel: "Some Singer", durationSec: 238 },
        { id: "live", title: "Radiohead - Creep (Live at Glastonbury 2017)", channel: "Radiohead", durationSec: 260 },
        { id: "orig", title: "Radiohead - Creep", channel: "Radiohead", durationSec: 238 },
        { id: "piano", title: "Creep (Piano Version)", channel: "Piano Dreams", durationSec: 238 },
    ];
    const ranked = rankCandidates(cands, w);
    assert.equal(ranked[0].id, "orig");
    for (const r of ranked.slice(1)) {
        assert.ok(r.parts.variant.length > 0, `${r.id} should carry a variant tag`);
        assert.ok(r.score < ranked[0].score);
    }
});

test("a live version wanted on purpose is not penalised", () => {
    const w = { artist: "Radiohead", title: "Creep (Live at Glastonbury 2017)" };
    const s = scoreCandidate({ title: "Radiohead - Creep (Live at Glastonbury 2017)", channel: "Radiohead" }, w);
    assert.deepEqual(s.parts.variant, []);
    assert.ok(s.confidence >= MIN_CONFIDENCE);
});

test("duration: within 5 % wins, far off is penalised", () => {
    const w = { artist: "Daft Punk", title: "One More Time", durationSec: 320 };
    const cands = [
        { id: "long", title: "Daft Punk - One More Time", channel: "Daft Punk", durationSec: 612 },   // some 10-minute cut
        { id: "ok", title: "Daft Punk - One More Time", channel: "Daft Punk", durationSec: 322 },
        { id: "near", title: "Daft Punk - One More Time", channel: "Daft Punk", durationSec: 350 },  // 9 % off: no bonus, no penalty
    ];
    const ranked = rankCandidates(cands, w);
    assert.equal(ranked[0].id, "ok");
    assert.equal(ranked[0].parts.dur, 0.3);
    assert.equal(ranked[1].id, "near");
    assert.equal(ranked[1].parts.dur, 0);
    assert.equal(ranked[2].id, "long");
    assert.equal(ranked[2].parts.dur, -0.2);
    // unknown wanted duration: neutral
    assert.equal(scoreCandidate(cands[0], { artist: "Daft Punk", title: "One More Time" }).parts.dur, 0);
});

test("no plausible match -> null (confidence below the cutoff) -> the route answers 404 nomatch", () => {
    const w = { artist: "Zzyzx Quartet", title: "Unfindable Song Nobody Uploaded", durationSec: 200 };
    const cands = [
        { id: "a", title: "Totally different video about cooking", channel: "Kitchen Channel", durationSec: 600 },
        { id: "b", title: "Zzyzx Quartet interview 2024", channel: "Jazz Talk", durationSec: 1800 },
    ];
    for (const r of rankCandidates(cands, w)) assert.ok(r.confidence < MIN_CONFIDENCE, `${r.id} scored ${r.confidence}`);
    assert.equal(pickBest(cands, w), null);
    assert.equal(pickBest([], w), null);
});

test("confidence is clamped to 0..1 and rounded by the route, ties keep search order", () => {
    const w = { artist: "A", title: "B" };
    const r = rankCandidates([{ id: "1", title: "B", channel: "x" }, { id: "2", title: "B", channel: "y" }], w);
    assert.equal(r[0].id, "1");
    assert.ok(r[0].confidence <= 1 && r[0].confidence >= 0);
});

// ── title normalisation + similarity ──
test("normaliseTitle strips brackets, feat., noise words and the artist's own name", () => {
    assert.equal(normaliseTitle("Rick Astley - Never Gonna Give You Up (Official Music Video)", "Rick Astley"), "never gonna give you up");
    assert.equal(normaliseTitle("Never Gonna Give You Up - Rick Astley [HD]", "Rick Astley"), "never gonna give you up");
    assert.equal(normaliseTitle("Get Lucky feat. Pharrell Williams & Nile Rodgers", "Daft Punk"), "get lucky");
    assert.equal(normaliseTitle("Beyoncé – Déjà Vu (Lyrics)", "Beyoncé"), "deja vu");
    assert.equal(normaliseTitle("Song Title", ""), "song title");
});

test("similarity: identical 1, unrelated near 0, containment lifted", () => {
    assert.equal(similarity("never gonna give you up", "never gonna give you up"), 1);
    assert.ok(similarity("never gonna give you up", "cooking pasta tonight") < 0.2);
    assert.ok(similarity("one more time", "one more time extended club mix") >= 0.8);
    assert.equal(similarity("", "x"), 0);
});

// ── link parsing ──
test("parseMediaUrl: YouTube shapes", () => {
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { service: "youtube", kind: "video", id: "dQw4w9WgXcQ" });
    assert.deepEqual(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ?t=43"), { service: "youtube", kind: "video", id: "dQw4w9WgXcQ" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), { service: "youtube", kind: "video", id: "dQw4w9WgXcQ" });
    assert.deepEqual(parseMediaUrl("http://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
        { service: "youtube", kind: "video", id: "dQw4w9WgXcQ", list: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" });
    assert.deepEqual(parseMediaUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share"), { service: "ytmusic", kind: "video", id: "dQw4w9WgXcQ" });
    assert.deepEqual(parseMediaUrl("https://music.youtube.com/playlist?list=OLAK5uy_kJ8cZ9V3dWmr3fZ0uHJZ5Q0pE9bJ4F3E0"),
        { service: "ytmusic", kind: "playlist", id: "OLAK5uy_kJ8cZ9V3dWmr3fZ0uHJZ5Q0pE9bJ4F3E0" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
        { service: "youtube", kind: "playlist", id: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw"), { service: "youtube", kind: "channel", id: "UCuAXFkgsw1L7xaCfnd5JJOw" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/@RickAstleyYT/videos"), { service: "youtube", kind: "channel", handle: "@RickAstleyYT" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/user/RickAstleyVEVO"), { service: "youtube", kind: "channel", user: "RickAstleyVEVO" });
    assert.deepEqual(parseMediaUrl("https://www.youtube.com/feed/subscriptions"), { service: "youtube", kind: "unknown", id: "" });
    assert.equal(parseMediaUrl("https://www.youtube.com/watch?v=short").kind, "unknown");
});

test("parseMediaUrl: Spotify shapes", () => {
    const t = { service: "spotify", kind: "song", id: "4PTG3Z6ehGkBFwjybzWkR8" };
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8?si=abc"), t);
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/intl-de/track/4PTG3Z6ehGkBFwjybzWkR8"), t);
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/embed/track/4PTG3Z6ehGkBFwjybzWkR8"), t);
    assert.deepEqual(parseMediaUrl("spotify:track:4PTG3Z6ehGkBFwjybzWkR8"), t);
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/album/4PTG3Z6ehGkBFwjybzWkR8"), { service: "spotify", kind: "album", id: "4PTG3Z6ehGkBFwjybzWkR8" });
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), { service: "spotify", kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    assert.deepEqual(parseMediaUrl("https://open.spotify.com/show/4PTG3Z6ehGkBFwjybzWkR8"), { service: "spotify", kind: "unknown", id: "" });
});

test("parseMediaUrl: Apple Music shapes", () => {
    assert.deepEqual(parseMediaUrl("https://music.apple.com/us/album/never-gonna-give-you-up/1773292758?i=1773293184&uo=4"),
        { service: "apple", kind: "song", id: "1773293184", albumId: "1773292758", cc: "us" });
    assert.deepEqual(parseMediaUrl("https://music.apple.com/gb/album/the-best-of-me/1773292758"), { service: "apple", kind: "album", id: "1773292758", cc: "gb" });
    assert.deepEqual(parseMediaUrl("https://music.apple.com/us/song/never-gonna-give-you-up/1773293184"), { service: "apple", kind: "song", id: "1773293184", cc: "us" });
    assert.deepEqual(parseMediaUrl("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"),
        { service: "apple", kind: "playlist", id: "pl.f4d106fed2bd41149aaacabb233eb5eb", cc: "us", slug: "todays-hits" });
    assert.deepEqual(parseMediaUrl("https://music.apple.com/us/artist/rick-astley/669771"), { service: "apple", kind: "unknown", id: "" });
});

test("parseMediaUrl: rejects what it must", () => {
    assert.equal(parseMediaUrl("https://example.com/watch?v=dQw4w9WgXcQ"), null);
    assert.equal(parseMediaUrl("javascript:alert(1)"), null);
    assert.equal(parseMediaUrl("ftp://youtube.com/watch?v=dQw4w9WgXcQ"), null);
    assert.equal(parseMediaUrl("not a url"), null);
    assert.equal(parseMediaUrl(""), null);
    assert.equal(parseMediaUrl(42), null);
    assert.equal(parseMediaUrl("https://youtube.com/" + "a".repeat(2100)), null);
});

// ── misc ──
test("iso8601ToSec", () => {
    assert.equal(iso8601ToSec("PT3M33S"), 213);
    assert.equal(iso8601ToSec("PT1H2M3S"), 3723);
    assert.equal(iso8601ToSec("P1DT2H"), 93600);
    assert.equal(iso8601ToSec("PT0S"), 0);
    assert.equal(iso8601ToSec(""), 0);
    assert.equal(iso8601ToSec(undefined), 0);
});

test("pacific day + reset instant (DST-safe)", () => {
    assert.match(pacificDay(), /^\d{4}-\d{2}-\d{2}$/);
    for (const now of [Date.now(), Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 2, 8, 12), Date.UTC(2026, 11, 31, 23, 30)]) {
        const reset = Date.parse(pacificResetAt(now));
        assert.ok(reset > now && reset - now <= 25 * 3600_000, "reset within the next ~24 h");
        assert.notEqual(pacificDay(reset), pacificDay(now));
        assert.equal(pacificDay(reset - 60_000), pacificDay(now));
    }
    assert.equal(pacificResetAt(Date.UTC(2026, 9, 11, 16)), "2026-10-12T07:00:00.000Z");   // PDT
    assert.equal(pacificResetAt(Date.UTC(2026, 11, 11, 16)), "2026-12-12T08:00:00.000Z");  // PST
});

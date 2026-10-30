// presence.mjs — REACH §2.3 + A2.3/A2.4/A4.4: auth, the server-side opt-in, coalescing of identical beats, the
// revocation epoch, TTL, aggregation, visibility, custom status, limits and the off switch. Driven through the
// real handlers with a scripted homeserver and a hand-driven clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPresence, aggregate, validateBeat, validStatus, sharedZone, PRESENCE, PALETTE, TZ } from "../presence.mjs";
import { call, bearer, clock, fakeHomeserver, authFor } from "./helpers.mjs";

const A = "@alice:example.org", B = "@bob:example.org", C = "@carol:example.org";
const SHARED = "!shared:example.org", ALICE_ONLY = "!aliceonly:example.org", CALLROOM = "!call:example.org";
const WALL0 = 1_790_000_000_000;

function setup(over = {}, opts = {}) {
    const now = clock(1000);
    const wallNow = () => WALL0 + now();
    const hs = fakeHomeserver({
        tokens: {
            ta1: { user: A, device: "ADEV1" }, ta2: { user: A, device: "ADEV2" },
            tb: { user: B, device: "BDEV" }, tb2: { user: B, device: "BDEV2" }, tc: { user: C, device: "CDEV" },
        },
        share: { [A]: true, [B]: false },
        rooms: { [A]: [SHARED, ALICE_ONLY, CALLROOM], [B]: [SHARED], [C]: [] },
        ...over,
    });
    const logs = [];
    const p = createPresence({ auth: authFor(hs, now), hs, adminToken: "admintoken", now, wallNow, log: (s) => logs.push(s), getMinMs: opts.getMinMs ?? 0, serverName: opts.serverName });
    const put = (tok, body) => call(p.put, { method: "PUT", headers: bearer(tok), body });
    const get = (tok, query = {}) => call(p.get, { headers: bearer(tok), query });
    const del = (tok, query = {}) => call(p.del, { method: "DELETE", headers: bearer(tok), query });
    return { now, wallNow, hs, p, put, get, del, logs };
}
const online = { state: "online", call: null, client: "desktop" };
const away = { state: "away", call: null, client: "desktop" };

test("auth_401_without_or_with_a_rejected_token_502_when_synapse_is_down", async () => {
    const { p, hs, get } = setup();
    const r0 = await call(p.get);
    assert.equal(r0.statusCode, 401);
    assert.equal(r0.headers["cache-control"], "no-store", "no-store on every answer, errors included");
    assert.equal((await call(p.get, { headers: { authorization: "Basic abc" } })).statusCode, 401);
    assert.equal((await get("nope")).statusCode, 401);
    hs.state.down = true;
    assert.equal((await get("tb")).statusCode, 502, "a homeserver hiccup is not 'your token is dead'");
});

test("put_while_not_sharing_is_409_and_drops_entries", async () => {
    const { put, p } = setup();
    const r = await put("tb", online);
    assert.deepEqual([r.statusCode, r.body, r.headers["cache-control"]], [409, { error: "not_sharing" }, "no-store"]);
    assert.equal(p._users.size, 0);
});

test("share_then_beat_then_roommate_sees_online", async () => {
    const { put, get } = setup();
    const r = await put("ta1", online);
    assert.deepEqual([r.statusCode, r.body], [200, { ok: true, every: 30, ttl: 90 }]);
    const g = await get("tb");
    assert.deepEqual([g.statusCode, g.body], [200, { users: { [A]: { state: "online" } }, every: 20 }]);
    assert.equal(g.headers["cache-control"], "no-store");
});

test("away_and_call_with_room_only_for_readers_in_that_room", async () => {
    const { put, get } = setup({ share: { [A]: true, [B]: true } });
    await put("ta1", { state: "away", call: null, client: "web" });
    assert.deepEqual((await get("tb")).body.users[A], { state: "away" });
    await put("ta1", { state: "away", call: SHARED, client: "web" });
    assert.deepEqual((await get("tb")).body.users[A], { state: "call", room: SHARED }, "any call wins over away");
    await put("ta1", { state: "online", call: CALLROOM, client: "web" });
    assert.deepEqual((await get("tb")).body.users[A], { state: "call" }, "bob isn't in the call room: no room id");
    assert.deepEqual((await get("ta2")).body.users[A], { state: "call", room: CALLROOM }, "alice's other device is");
});

test("no_common_room_means_absent_and_the_requester_sees_themselves", async () => {
    const { put, get } = setup();
    await put("ta1", online);
    assert.deepEqual((await get("tc")).body.users, {}, "carol shares no room with alice");
    assert.deepEqual((await get("ta1")).body.users, { [A]: { state: "online" } }, "requester listed when sharing");
    assert.deepEqual((await get("tb")).body.users, { [A]: { state: "online" } }, "non-reciprocal: bob doesn't share but sees");
});

test("joined_rooms_lookup_error_fails_closed", async () => {
    const { put, get, hs } = setup();
    await put("ta1", online);
    const orig = hs.get;
    hs.get = async (path, token) => (path.includes(encodeURIComponent(A)) && path.endsWith("/joined_rooms") ? { ok: false, status: 500, body: {} } : orig(path, token));
    assert.deepEqual((await get("tb")).body.users, {}, "alice's rooms unknown: the pair is not listed");
});

test("aggregation_over_devices", async () => {
    assert.deepEqual(aggregate([{ state: "away", call: null, at: 1 }, { state: "online", call: null, at: 2 }]), { state: "online" });
    assert.deepEqual(aggregate([{ state: "away", call: null, at: 1 }, { state: "away", call: null, at: 2 }]), { state: "away" });
    assert.deepEqual(aggregate([{ state: "online", call: null, at: 3 }, { state: "away", call: "!x:y", at: 1 }]), { state: "call", room: "!x:y" });
    assert.deepEqual(aggregate([{ state: "away", call: "!old:y", at: 1 }, { state: "away", call: "!new:y", at: 2 }]), { state: "call", room: "!new:y" });
    const { put, get } = setup();
    await put("ta1", away);
    await put("ta2", { state: "online", call: null, client: "web" });
    assert.deepEqual((await get("tb")).body.users[A], { state: "online" });
});

test("identical_beats_under_5s_coalesce_changed_beats_apply_at_once", async () => {
    const { put, get, now } = setup();
    await put("ta1", online);                       // t0: processed
    now.advance(2000);
    const r = await put("ta1", online);             // identical within 5 s: acknowledged, not processed
    assert.deepEqual([r.statusCode, r.body], [200, { ok: true, every: 30, ttl: 90 }]);
    now.advance(88_001);                            // t0 + 90.001 s
    assert.deepEqual((await get("tb")).body.users, {}, "the coalesced beat did not refresh the entry");
    await put("ta1", online);
    now.advance(1000);
    assert.equal((await put("ta1", away)).statusCode, 200);
    assert.deepEqual((await get("tb")).body.users[A], { state: "away" }, "a changed state within 5 s is applied at once (A2.3)");
});

test("delete_is_the_off_switch_and_device_this_only_signs_out_one_device", async () => {
    const { put, get, del } = setup();
    await put("ta1", online);
    await put("ta2", { state: "away", call: null, client: "web" });
    const r = await del("ta2", { device: "this" });
    assert.deepEqual([r.statusCode, r.headers["cache-control"]], [204, "no-store"]);
    assert.deepEqual((await get("tb")).body.users[A], { state: "online" }, "desktop still there");
    assert.equal((await put("ta1", { state: "online", call: null, client: "web" })).statusCode, 200,
        "signing one device out never 409s the user's other devices");
    assert.equal((await del("ta1", { device: "other" })).statusCode, 400);
    assert.equal((await del("ta1")).statusCode, 204);
    assert.deepEqual((await get("tb")).body.users, {}, "gone at once, every device");
});

test("share_false_next_beat_409_and_readers_stop_seeing_within_the_positive_cache", async () => {
    const { put, get, now, hs, p } = setup();
    await put("ta1", online);
    hs.state.share[A] = false;
    now.advance(6000);
    assert.equal((await put("ta1", away)).statusCode, 200, "positive answer still cached");
    now.advance(PRESENCE.SHARE_CACHE_MS);
    assert.deepEqual((await get("tb")).body.users, {}, "fresh read on GET after the cache: absent + dropped");
    assert.equal(p._users.size, 0);
    const r = await put("ta1", online);
    assert.deepEqual([r.statusCode, r.body], [409, { error: "not_sharing" }]);
    assert.equal(p._users.size, 0);
});

test("positive_opt_in_cached_20s_negative_never_refresh_bypasses_once_per_5s", async () => {
    const { put, now, hs } = setup();
    const reads = () => hs.count(/accountdata$/);
    await put("ta1", online);
    now.advance(6000);
    await put("ta1", away);
    assert.equal(reads(), 1, "second beat inside 20 s: cached positive");
    now.advance(PRESENCE.SHARE_CACHE_MS);
    await put("ta1", online);
    assert.equal(reads(), 2);
    await put("tb", online);
    now.advance(6000);
    await put("tb", online);
    assert.equal(reads(), 4, "a negative answer is re-read every time");
    hs.state.share[B] = true;
    assert.equal((await put("tb", online)).statusCode, 200, "turning it on works on the very next beat");
    // refresh: re-read now even though the positive answer is cached — at most once per 5 s per user
    const r1 = reads();
    await put("ta1", { ...online, refresh: true });
    assert.equal(reads(), r1 + 1, "refresh bypassed the cache");
    now.advance(1000);
    await put("ta1", { ...online, refresh: true });
    assert.equal(reads(), r1 + 1, "a second refresh within 5 s is an ordinary (here identical, coalesced) beat");
    now.advance(4000);
    await put("ta1", { ...online, refresh: true });
    assert.equal(reads(), r1 + 2);
});

test("revocation_epoch_off_switch_racing_a_beat_wins", async () => {
    const { p, hs, get, del, put } = setup();
    let release;
    const orig = hs.get;
    hs.get = async (path, token) => {
        if (/accountdata$/.test(path)) await new Promise((r) => { release = r; });
        return orig(path, token);
    };
    const pending = put("ta1", online);
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.ok(release, "the beat is parked on the opt-in lookup");
    await del("ta1");          // the off switch lands meanwhile
    release();                 // ... and the lookup answers with a stale "share: true"
    const r = await pending;
    assert.deepEqual([r.statusCode, r.body], [409, { error: "not_sharing" }]);
    hs.get = orig;
    assert.deepEqual((await get("tb")).body.users, {});
    assert.equal(p._users.size, 0);
});

test("a_not_sharing_drop_also_voids_a_racing_beat_from_another_device", async () => {
    const { hs, put, p } = setup();
    let release;
    const orig = hs.get;
    let hold = true;
    hs.get = async (path, token) => {
        if (hold && /accountdata$/.test(path)) { hold = false; const r = await orig(path, token); await new Promise((x) => { release = x; }); return r; }
        return orig(path, token);
    };
    const pending = put("ta1", online);           // reads share=true, then parks
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.ok(release);
    hs.state.share[A] = false;
    // (a plain beat would join the parked lookup — in-flight reads are shared; refresh asks Synapse afresh)
    assert.equal((await put("ta2", { ...online, refresh: true })).statusCode, 409, "the other device sees share=false: drop + epoch bump");
    release();
    assert.equal((await pending).statusCode, 409, "the parked beat raced a not_sharing drop: not stored");
    hs.get = orig;
    assert.equal(p._users.size, 0);
});

test("ttl_90s_and_sweep", async () => {
    const { put, get, now, p } = setup();
    await put("ta1", online);
    now.advance(90_000);
    assert.ok((await get("tb")).body.users[A], "at 90 s still live (≤ 90 s)");
    now.advance(1);
    assert.deepEqual((await get("tb")).body.users, {});
    p.sweep();
    assert.equal(p._users.size, 0, "the 30 s sweep deletes expired entries");
    assert.equal(p._optCache.size, 1, "the opt-in answer read at 90 s is still fresh");
    now.advance(PRESENCE.SHARE_CACHE_MS);
    p.sweep();
    assert.equal(p._optCache.size, 0, "... and expired cache items go too");
});

test("joined_rooms_cached_30s_and_whoami_60s", async () => {
    const { put, get, now, hs } = setup();
    await put("ta1", online);
    await get("tb");
    await get("tb");
    assert.equal(hs.count(/joined_rooms$/), 2, "bob's + alice's rooms, once each");
    assert.equal(hs.count(/whoami$/), 2, "ta1 + tb, once each");
    now.advance(PRESENCE.ROOMS_CACHE_MS + 1);
    await put("ta1", away);
    await get("tb");
    assert.equal(hs.count(/joined_rooms$/), 4);
    assert.equal(hs.count(/whoami$/), 2, "still cached at 30 s");
    now.advance(30_000);
    await get("tb");
    assert.equal(hs.count(/whoami$/), 3, "tb's whoami re-asked once its 60 s were up");
});

test("get_at_most_once_per_5s_per_token", async () => {
    const { get, now } = setup({}, { getMinMs: PRESENCE.GET_MIN_MS });
    assert.equal((await get("tb")).statusCode, 200);
    const r = await get("tb");
    assert.equal(r.statusCode, 429);
    assert.ok(Number(r.headers["retry-after"]) >= 1);
    assert.equal((await get("tb2")).statusCode, 200, "per token: bob's other device is fine");
    now.advance(5000);
    assert.equal((await get("tb")).statusCode, 200);
});

test("custom_status_rides_on_the_same_read_and_is_validated", async () => {
    const status = (over) => ({ id: "lfg", text: "Looking for group", emoji: "🎯", color: "blurple", until: null, v: 1, ...over });
    const { put, get, hs, now, wallNow } = setup();
    const statuses = {};
    const orig = hs.get;
    hs.get = async (path, token) => {
        const r = await orig(path, token);
        const m = /users\/([^/]+)\/accountdata$/.exec(path);
        if (m && statuses[decodeURIComponent(m[1])] !== undefined) r.body.account_data.global["dev.tinhat.presence_status"] = statuses[decodeURIComponent(m[1])];
        return r;
    };
    statuses[A] = status();
    await put("ta1", online);
    assert.deepEqual((await get("tb")).body.users[A], { state: "online", status: { text: "Looking for group", emoji: "🎯", color: "blurple" } });
    // expiry is judged at read time (wall clock)
    statuses[A] = status({ until: wallNow() + 10_000 });
    now.advance(5000);
    await put("ta1", { ...online, refresh: true });
    assert.ok((await get("tb")).body.users[A].status);
    now.advance(10_001);
    assert.equal((await get("tb")).body.users[A].status, undefined, "expired: no status field");
    // invalid is ignored, never an error
    for (const bad of [status({ color: "gold" }), status({ text: "" }), status({ text: "x".repeat(41) }), status({ emoji: "🎯🎯🎯🎯🎯" }),
        status({ until: wallNow() - 1 }), status({ text: "a\u202eb" }), {}, "nope"]) {
        statuses[A] = bad;
        now.advance(5000);
        const r = await put("ta1", { ...online, refresh: true });
        assert.equal(r.statusCode, 200, JSON.stringify(bad));
        assert.equal((await get("tb")).body.users[A].status, undefined, JSON.stringify(bad));
    }
    // pure checks
    assert.deepEqual(validStatus({ text: "  Grinding  ", emoji: "", color: "orange" }, 0), { text: "Grinding", emoji: "", color: "orange", until: null });
    assert.equal(validStatus({ text: "x".repeat(40), color: "white" }, 0).text.length, 40);
    assert.equal(validStatus({ text: "👋".repeat(40), color: "white" }, 0).text, "👋".repeat(40), "40 characters, not UTF-16 units");
    assert.equal(validStatus({ text: "ok", emoji: "🛋️", color: "blue" }, 0).emoji, "🛋️");
    assert.equal(PALETTE.length, 12);
});

test("bad_bodies_400_and_over_1kb_413", async () => {
    const { put } = setup();
    for (const b of [{}, { state: "busy" }, { state: "online", call: "not-a-room" }, { state: "online", client: "phone" },
        { state: "online", call: 5 }, { state: "online", refresh: "yes" }, [], "x"]) {
        assert.equal((await put("ta1", b)).statusCode, 400, JSON.stringify(b));
    }
    assert.equal((await put("ta1", "{not json")).statusCode, 400);
    const big = { state: "online", call: null, client: "web", pad: "x".repeat(1100) };
    assert.equal((await put("ta1", big)).statusCode, 413);
    assert.deepEqual(validateBeat({ state: "online" }), { state: "online", call: null, client: null, refresh: false });
    assert.equal(validateBeat({ state: "away", call: "!kSsMwJk3n9pD4LZ0aA-_hQeX1cQz2yT7sR5vU8wI6oE", client: "web" }).call,
        "!kSsMwJk3n9pD4LZ0aA-_hQeX1cQz2yT7sR5vU8wI6oE", "room v12 ids have no server part");
});

test("per_user_put_rate_limit_429", async () => {
    const { put, now } = setup();
    let last;
    for (let i = 0; i < 61; i++) { last = await put("ta1", i % 2 ? online : away); now.advance(10); }
    assert.equal(last.statusCode, 429);
    assert.ok(Number(last.headers["retry-after"]) >= 1);
});

test("logs_are_counts_only", async () => {
    const { put, get, del, p, logs } = setup();
    await put("ta1", online);
    await put("tb", online);
    await get("tb");
    await del("ta1", { device: "this" });
    p.report();
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs.join("\n"), /@|!|example\.org|online|away|ADEV|BDEV/);
});

// ── Astra review 2026-09-25 (reach-server-astra.md) ──────────────────────────────────────────────────────────────

test("f1_a_stale_opt_in_read_never_repopulates_the_cache_after_the_off_switch", async () => {
    const { hs, put, get, del, p } = setup();
    let release;
    const orig = hs.get;
    let parkNext = true;
    hs.get = async (path, token) => {
        if (parkNext && /accountdata$/.test(path)) {
            parkNext = false;
            const snapshot = await orig(path, token);      // taken while sharing was still on
            await new Promise((r) => { release = r; });
            return snapshot;
        }
        return orig(path, token);
    };
    const first = put("ta1", online);                       // its read is parked with share:true
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.ok(release);
    hs.state.share[A] = false;                               // the user switches off: share:false first ...
    assert.equal((await del("ta1")).statusCode, 204);        // ... then DELETE
    const readsBefore = hs.count(/accountdata$/);
    const secondP = put("ta2", online);                      // another device beats while the old read is still out
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    const readsAfterSecond = hs.count(/accountdata$/);
    release();                                               // observe first, then let everything finish
    const [second, firstR] = [await secondP, await first];
    assert.equal(readsAfterSecond, readsBefore + 1, "the post-DELETE beat has a read of its own (it did not join the old one)");
    assert.deepEqual([second.statusCode, second.body], [409, { error: "not_sharing" }]);
    assert.equal(firstR.statusCode, 409, "the obsolete read is refused");
    assert.equal(p._optCache.has(A), false, "and it never reached the cache");
    const third = await put("ta2", online);
    assert.equal(third.statusCode, 409, "no restored cache to accept a later beat");
    assert.deepEqual((await get("tb")).body.users, {}, "never visible again");
    hs.get = orig;
});

test("f4_get_never_returns_a_row_revoked_while_another_lookup_was_pending", async () => {
    const D = "@dave:example.org";
    const { hs, put, get, del } = setup({
        tokens: { ta1: { user: A, device: "ADEV1" }, td: { user: D, device: "DDEV" }, tb: { user: B, device: "BDEV" } },
        share: { [A]: true, [D]: true, [B]: false },
        rooms: { [A]: [SHARED], [D]: [SHARED], [B]: [SHARED] },
    });
    await put("ta1", online);
    await put("td", online);
    let release;
    const orig = hs.get;
    hs.get = async (path, token) => {
        if (path.endsWith(`/users/${encodeURIComponent(D)}/joined_rooms`)) await new Promise((r) => { release = r; });
        return orig(path, token);
    };
    const pending = get("tb");                               // alice's checks finish, dave's rooms lookup hangs
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.ok(release);
    hs.state.share[A] = false;
    assert.equal((await del("ta1")).statusCode, 204);         // alice switches off while that GET is still running
    release();
    const r = await pending;
    assert.deepEqual(r.body.users, { [D]: { state: "online" } }, "alice's already-checked row is not sent after her DELETE");
    hs.get = orig;
});

test("f4_get_also_rechecks_devices_signed_out_or_expired_during_the_lookups", async () => {
    const D = "@dave:example.org";
    const { hs, put, get, del } = setup({
        tokens: { ta1: { user: A, device: "ADEV1" }, td: { user: D, device: "DDEV" }, tb: { user: B, device: "BDEV" } },
        share: { [A]: true, [D]: true, [B]: false },
        rooms: { [A]: [SHARED], [D]: [SHARED], [B]: [SHARED] },
    });
    await put("ta1", online);
    await put("td", online);
    let release;
    const orig = hs.get;
    hs.get = async (path, token) => {
        if (path.endsWith(`/users/${encodeURIComponent(D)}/joined_rooms`)) await new Promise((r) => { release = r; });
        return orig(path, token);
    };
    const pending = get("tb");
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.equal((await del("ta1", { device: "this" })).statusCode, 204); // alice's only device signs out
    release();
    assert.deepEqual((await pending).body.users, { [D]: { state: "online" } });
    hs.get = orig;
});

test("f9_generations_live_only_while_a_request_holds_them_and_never_come_back", async () => {
    const { hs, put, get, del, p } = setup({ share: { [A]: true, [B]: true } });
    await put("ta1", online);
    await put("tb", online);
    await get("tb");
    await del("ta2", { device: "this" });
    await del("tb");
    assert.equal(p._gens.size, 0, "no per-user generation outlives its requests");
    assert.equal(p._devGens.size, 0, "no signed-out device id is kept");
    // ABA: a request holding a revoked generation must never see it (or a look-alike) become current again.
    let release;
    const orig = hs.get;
    let park = true;
    hs.get = async (path, token) => {
        if (park && /accountdata$/.test(path)) { park = false; const r = await orig(path, token); await new Promise((x) => { release = x; }); return r; }
        return orig(path, token);
    };
    const held = put("ta2", { ...online, refresh: true });  // holds generation g1 (a fresh read, parked, share:true)
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    assert.ok(release, "the read is parked");
    assert.equal(p._gens.size, 1);
    await del("ta1");                                        // g1 retired: the map forgets it
    assert.equal(p._gens.size, 0);
    assert.equal((await put("ta1", online)).statusCode, 200, "sharing is still on: a new beat gets a NEW generation");
    assert.equal(p._gens.size, 0, "that beat's generation is forgotten once it finished; the parked request's revoked one never comes back");
    release();
    assert.equal((await held).statusCode, 409, "the request that started before the revocation still sees it as revoked");
    hs.get = orig;
    assert.equal(p._gens.size, 0);
    assert.deepEqual((await get("tb")).body.users[A], { state: "online" }, "the post-revocation beat is the one that counts");
});

// ---- time zones (A7, widgets W1 "Friends' clocks", 2026-09-28: opt-out) ----------------------------------------------

const TYO = { share: true, tz: "Asia/Tokyo", auto: true, v: 1 };
const NYC = { share: true, tz: "America/New_York", auto: false, v: 1 };

test("tz_only_with_the_query_and_a_tz_only_user_is_listed_with_tz_alone", async () => {
    // Carol shares a room with Bob and a time zone, but no presence at all
    const { get, put } = setup({ rooms: { [A]: [SHARED, ALICE_ONLY, CALLROOM], [B]: [SHARED], [C]: [SHARED] }, tz: { [C]: NYC, [A]: TYO } });
    await put("ta1", online);
    const plain = await get("tb");
    assert.deepEqual(plain.body, { users: { [A]: { state: "online" } }, every: 20 }, "older apps (no ?tz=1): exactly the old answer");
    const withTz = await get("tb", { tz: "1" });
    assert.deepEqual(withTz.body.users, { [A]: { state: "online", tz: "Asia/Tokyo" }, [C]: { tz: "America/New_York" } });
});

test("tz_needs_share_true_a_valid_zone_and_a_common_room", async () => {
    const { get } = setup({
        rooms: { [A]: [ALICE_ONLY], [B]: [SHARED], [C]: [SHARED] },
        tz: { [A]: TYO, [C]: { share: false, tz: "Europe/London", v: 1 } },
    });
    assert.deepEqual((await get("tb", { tz: "1" })).body.users, {}, "Alice: no common room; Carol: share false");
    for (const bad of [{ share: true, tz: "../etc/passwd" }, { share: true, tz: "" }, { share: "yes", tz: "Europe/Paris" }, { share: true }, { share: true, tz: "A".repeat(65) }, null, "Europe/Paris"])
        assert.equal(sharedZone(bad), null, JSON.stringify(bad));
    assert.equal(sharedZone({ share: true, tz: "UTC" }), "UTC");
    assert.equal(sharedZone({ share: true, tz: "America/Argentina/Buenos_Aires" }), "America/Argentina/Buenos_Aires");
    assert.equal(sharedZone({ share: true, tz: "Etc/GMT+10" }), "Etc/GMT+10");
});

test("the_reader_sees_their_own_zone_too", async () => {
    const { get } = setup({ tz: { [B]: TYO } });
    assert.deepEqual((await get("tb", { tz: "1" })).body.users, { [B]: { tz: "Asia/Tokyo" } });
});

test("tz_cached_20s_members_60s_and_the_off_switch_is_immediate", async () => {
    const { get, del, hs, now } = setup({ rooms: { [A]: [SHARED], [B]: [SHARED], [C]: [SHARED] }, tz: { [C]: NYC } });
    assert.equal((await get("tb", { tz: "1" })).body.users[C].tz, "America/New_York");
    const reads = () => hs.count(new RegExp(`users/${encodeURIComponent(C)}/accountdata`));
    const memberReads = () => hs.count(/rooms\/[^/]+\/members$/);
    const r0 = reads(), m0 = memberReads();
    now.advance(10_000);
    await get("tb", { tz: "1" });
    assert.equal(reads(), r0, "a zone is read at most once per 20 s");
    assert.equal(memberReads(), m0, "a room's members at most once per 60 s");
    // Carol switches off: her app writes share: false, then DELETE ?what=tz — gone at once, cache or not
    hs.state.tz[C] = { ...NYC, share: false };
    assert.equal((await del("tc", { what: "tz" })).statusCode, 204);
    assert.equal((await get("tb", { tz: "1" })).body.users[C], undefined);
    // a bad `what` is refused; the presence off switch is untouched by it
    assert.equal((await del("tc", { what: "all" })).statusCode, 400);
    // a switch back on shows after the cache (≤ 20 s)
    hs.state.tz[C] = NYC;
    now.advance(TZ.CACHE_MS + 1);
    assert.equal((await get("tb", { tz: "1" })).body.users[C].tz, "America/New_York");
});

test("a_tz_read_racing_the_off_switch_is_not_listed_or_cached", async () => {
    const { get, del, hs } = setup({ rooms: { [A]: [SHARED], [B]: [SHARED], [C]: [SHARED] }, tz: { [C]: NYC } });
    let release;
    const gate = new Promise((r) => (release = r));
    const orig = hs.get;
    hs.get = async (path, token) => {
        if (path.includes(encodeURIComponent(C)) && path.endsWith("/accountdata")) await gate;
        return orig(path, token);
    };
    const pending = get("tb", { tz: "1" });
    await new Promise((r) => setTimeout(r, 10));
    await del("tc", { what: "tz" }); // lands while the read is in flight
    release();
    const r = await pending;
    assert.equal(r.body.users[C], undefined, "the off switch wins over a read that started before it");
    hs.get = orig;
});

test("tz_lookup_errors_fail_closed", async () => {
    const { get, hs } = setup({ rooms: { [A]: [SHARED], [B]: [SHARED, CALLROOM], [C]: [CALLROOM] }, tz: { [C]: NYC }, membersDown: [CALLROOM] });
    assert.equal((await get("tb", { tz: "1" })).body.users[C], undefined, "the only common room's members can't be read: not listed");
    hs.state.membersDown = [];
    const orig = hs.get;
    hs.get = async (path, token) => (path.includes("accountdata") ? { ok: false, status: 500, body: {} } : orig(path, token));
    const r = await get("tb", { tz: "1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.users[C], undefined, "account data unreadable: not listed");
    hs.get = orig;
});

test("tz_logs_are_counts_only", async () => {
    const { get, del, p, logs } = setup({ rooms: { [A]: [SHARED], [B]: [SHARED], [C]: [SHARED] }, tz: { [C]: NYC } });
    await get("tb", { tz: "1" });
    await del("tc", { what: "tz" });
    p.report();
    const text = logs.join("\n");
    assert.ok(/time zones: 1 reads listing 1, 1 off/.test(text), text);
    assert.ok(!text.includes("New_York") && !text.includes("carol") && !text.includes("@"), "no zone, no user in the logs");
});


// ---- remote users (BACKLOG-SERVER-037, 0.3.9): Synapse's admin API only answers for local users ----------------------

test("remote_members_are_not_sharing_and_never_read_through_the_admin_api", async () => {
    const D = "@dave:other.example", E = "@eve:EXAMPLE.ORG.evil";
    const { get, put, hs, p, logs } = setup({
        rooms: { [A]: [SHARED], [B]: [SHARED], [C]: [], [D]: [SHARED], [E]: [SHARED] },
        share: { [A]: true, [B]: false, [D]: true, [E]: true }, tz: { [A]: TYO, [D]: NYC, [E]: NYC },
    }, { serverName: "Example.org" });
    await put("ta1", online);
    const r = await get("tb", { tz: "1" });
    assert.deepEqual(r.body.users, { [A]: { state: "online", tz: "Asia/Tokyo" } }, "only the local sharer; remote members are not listed");
    const remoteReads = hs.calls.filter((c) => /accountdata$/.test(c) && /dave|eve/.test(decodeURIComponent(c)));
    assert.deepEqual(remoteReads, [], "no admin account-data read for a remote mxid");
    p.report();
    assert.match(logs.at(-1), /remote users skipped/);
    assert.ok(!logs.join("\n").includes("dave"), "logs carry counts only");
});

test("without_a_server_name_every_user_is_read_as_before", async () => {
    const D = "@dave:other.example";
    const { get, hs } = setup({ rooms: { [A]: [SHARED], [B]: [SHARED], [D]: [SHARED] }, tz: { [D]: NYC } });
    await get("tb", { tz: "1" });
    assert.ok(hs.calls.some((c) => /accountdata$/.test(c) && decodeURIComponent(c).includes(D)), "old behaviour kept");
});

// vodslist.mjs (recorder fix 2026-11-04): a frameless capture (header-only, < 1 KiB — the recorder never got a frame)
// is not handed to players and never blocks `ready`; a session whose every capture is frameless is `empty`.
// Controls: the same session with REAL captures but a missing combined file / mix is still not ready (so the
// checks can fail), and the old rule (every listed video needs a combined file) is shown to keep it Processing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeSession, FRAMELESS_MAX_BYTES } from "../vodslist.mjs";

const urlFor = (f) => `https://example.org/api/vods/file/r/s/${f}`;

function session(files, tracks, sessionJson = { room: "!r:example.org", room_name: "R", start_ms: 1000, end_ms: 9000 }) {
    const root = mkdtempSync(join(tmpdir(), "vodslist-"));
    const sd = join(root, "s1");
    mkdirSync(sd);
    if (sessionJson) writeFileSync(join(sd, "session.json"), JSON.stringify(sessionJson));
    writeFileSync(join(sd, "tracks.jsonl"), tracks.map((t) => JSON.stringify(t)).join("\n") + "\n");
    for (const [name, size] of Object.entries(files)) writeFileSync(join(sd, name), Buffer.alloc(size, 1));
    return { root, sd };
}
const A = { kind: "audio", file: "audio-@a_example.org_DEV-TR_A1.mka", identity: "@a:example.org:DEV", start_ms: 1000 };
const V = { kind: "cam", file: "cam-@a_example.org_DEV-TR_V1.mkv", identity: "@a:example.org:DEV", start_ms: 1000 };
const S = { kind: "share", file: "share-@b_example.org_DEV2-TR_V2.mkv", identity: "@b:example.org:DEV2", start_ms: 2000 };
const HEADER = 173; // what the recorder leaves for a capture that never got a frame

test("threshold is the recorder's (1 KiB)", () => assert.equal(FRAMELESS_MAX_BYTES, 1024));

test("a frameless camera does not keep the session Processing", () => {
    const { root, sd } = session({ [A.file]: 50_000, [V.file]: HEADER, "mixed.mka": 50_000, [S.file]: 90_000, [`combined-${S.file}`]: 90_000 }, [A, V, S]);
    const e = describeSession(sd, "s1", urlFor);
    assert.equal(e.ready, true);
    assert.equal(e.empty, false);
    assert.deepEqual(e.frameless, [V.file]);
    assert.deepEqual(e.tracks.map((t) => t.file), [A.file, S.file]);
    assert.ok(e.tracks.find((t) => t.file === S.file).combined_url.endsWith(`combined-${S.file}`));
    assert.deepEqual(e.people, ["@a:example.org", "@b:example.org"]);
    // control: the old rule (every LISTED video needs a combined file) keeps this exact directory not ready
    const oldReady = !!e.mixed_url && [V, S].every((t) => t.file === S.file); // V has no combined file
    assert.equal(oldReady, false);
    rmSync(root, { recursive: true });
});

test("control: a REAL camera without its combined file still blocks ready", () => {
    const { root, sd } = session({ [A.file]: 50_000, [V.file]: 80_000, "mixed.mka": 50_000 }, [A, V]);
    const e = describeSession(sd, "s1", urlFor);
    assert.equal(e.ready, false);
    assert.deepEqual(e.frameless, []);
    rmSync(root, { recursive: true });
});

test("control: real audio without the mix still blocks ready", () => {
    const { root, sd } = session({ [A.file]: 50_000, [S.file]: 90_000, [`combined-${S.file}`]: 90_000 }, [A, S]);
    assert.equal(describeSession(sd, "s1", urlFor).ready, false);
    rmSync(root, { recursive: true });
});

test("only frameless audio and a real video WITHOUT a combined file: ready (no mix exists to combine with)", () => {
    const { root, sd } = session({ [A.file]: HEADER, [S.file]: 90_000 }, [A, S]);
    const e = describeSession(sd, "s1", urlFor);
    assert.equal(e.ready, true);
    assert.equal(e.tracks[0].combined_url, undefined);
    assert.ok(e.tracks[0].url.endsWith(S.file));
    rmSync(root, { recursive: true });
});

test("only frameless audio: no mix needed; videos with combined files make it ready", () => {
    const { root, sd } = session({ [A.file]: HEADER, [S.file]: 90_000, [`combined-${S.file}`]: 90_000 }, [A, S]);
    const e = describeSession(sd, "s1", urlFor);
    assert.equal(e.ready, true);
    assert.deepEqual(e.frameless, [A.file]);
    rmSync(root, { recursive: true });
});

test("every capture frameless (or missing) = empty, not Processing", () => {
    const { root, sd } = session({ [A.file]: HEADER, [V.file]: HEADER }, [A, V, S]); // S's file does not exist at all
    const e = describeSession(sd, "s1", urlFor);
    assert.equal(e.empty, true);
    assert.equal(e.tracks.length, 0);
    assert.deepEqual(e.frameless, [A.file, V.file, S.file]);
    // the apps' rule: processing = ready === false && !empty
    assert.equal(e.ready === false && !e.empty, false);
    rmSync(root, { recursive: true });
});

test("a live session stays live; no session.json = not a session", () => {
    const live = session({ [A.file]: 50_000 }, [A], { room: "!r:example.org", start_ms: 1000, end_ms: null });
    const e = describeSession(live.sd, "s1", urlFor);
    assert.equal(e.live, true);
    assert.equal(e.ready, false);
    rmSync(live.root, { recursive: true });
    const none = session({ [A.file]: 50_000 }, [A], null);
    assert.equal(describeSession(none.sd, "s1", urlFor), null);
    rmSync(none.root, { recursive: true });
});

test("a port in the server name is kept in people (the shared identity rule)", () => {
    const P = { ...A, identity: "@p:host.example:8448:DEVP", file: "audio-p.mka" };
    const { root, sd } = session({ [P.file]: 50_000, "mixed.mka": 50_000 }, [P]);
    assert.deepEqual(describeSession(sd, "s1", urlFor).people, ["@p:host.example:8448"]);
    rmSync(root, { recursive: true });
});

// ---- listRoom: a repaired copy replaces its original (add-only repairs never touch the original) ----
import { listRoom } from "../vodslist.mjs";

function room(sessions) {
    const root = mkdtempSync(join(tmpdir(), "vodsroom-"));
    for (const [id, sj, files, tracks] of sessions) {
        const sd = join(root, id);
        mkdirSync(sd);
        if (sj) writeFileSync(join(sd, "session.json"), JSON.stringify(sj));
        writeFileSync(join(sd, "tracks.jsonl"), tracks.map((t) => JSON.stringify(t)).join("\n") + "\n");
        for (const [name, size] of Object.entries(files)) writeFileSync(join(sd, name), Buffer.alloc(size, 1));
    }
    return root;
}
const ufs = (s) => (f) => `https://example.org/api/vods/file/r/${s}/${f}`;
const OK = { [A.file]: 50_000, "mixed.mka": 50_000 };

test("listRoom: the repaired copy replaces its original; other sessions stay; newest first", () => {
    const root = room([
        ["100", { start_ms: 100, end_ms: 200 }, { ...OK, [V.file]: 80_000 }, [A, V]], // stuck: real cam, no combined
        ["100-repaired", { start_ms: 100, end_ms: 200, repair_of: "100", repaired_ms: 5 }, OK, [A]],
        ["300", { start_ms: 300, end_ms: 400 }, OK, [A]],
    ]);
    const ids = listRoom(root, ufs).map((e) => e.id);
    assert.deepEqual(ids, ["300", "100-repaired"]);
    rmSync(root, { recursive: true });
});

test("listRoom control: without repair_of both are listed (so the rule above can fail)", () => {
    const root = room([
        ["100", { start_ms: 100, end_ms: 200 }, OK, [A]],
        ["100-repaired", { start_ms: 100, end_ms: 200 }, OK, [A]],
    ]);
    assert.equal(listRoom(root, ufs).length, 2);
    rmSync(root, { recursive: true });
});

test("listRoom: a dangling, self or mutual repair_of hides nothing; an unreadable copy hides nothing", () => {
    const root = room([
        ["a", { start_ms: 1, end_ms: 2, repair_of: "nope" }, OK, [A]],
        ["b", { start_ms: 3, end_ms: 4, repair_of: "b" }, OK, [A]],
        ["c", { start_ms: 5, end_ms: 6, repair_of: "d" }, OK, [A]],
        ["d", { start_ms: 7, end_ms: 8, repair_of: "c" }, OK, [A]],
        ["e", { start_ms: 9, end_ms: 10 }, OK, [A]],
        ["e-bad", null, OK, [A]], // no session.json: not a session, cannot hide "e"
    ]);
    assert.deepEqual(listRoom(root, ufs).map((x) => x.id).sort(), ["a", "b", "c", "d", "e"]);
    rmSync(root, { recursive: true });
});

test("listRoom: a chain or a longer cycle of repair_of never hides a repaired copy", () => {
    const root = room([
        ["o", { start_ms: 1, end_ms: 2 }, OK, [A]],
        ["r1", { start_ms: 1, end_ms: 2, repair_of: "o", repaired_ms: 5 }, OK, [A]],
        ["r2", { start_ms: 1, end_ms: 2, repair_of: "r1" }, OK, [A]],
        ["x", { start_ms: 3, end_ms: 4, repair_of: "y" }, OK, [A]],
        ["y", { start_ms: 5, end_ms: 6, repair_of: "z" }, OK, [A]],
        ["z", { start_ms: 7, end_ms: 8, repair_of: "x" }, OK, [A]],
    ]);
    assert.deepEqual(listRoom(root, ufs).map((e) => e.id).sort(), ["r1", "r2", "x", "y", "z"]);
    rmSync(root, { recursive: true });
});

test("listRoom: an unfinished repaired copy (no media, no mix, or still open) hides nothing (0.3.13 review)", () => {
    const root = room([
        ["1", { start_ms: 1, end_ms: 2 }, OK, [A]],
        ["1-repaired", { start_ms: 1, end_ms: 2, repair_of: "1", repaired_ms: 5 }, {}, []], // stopped right after session.json
        ["2", { start_ms: 3, end_ms: 4 }, OK, [A]],
        ["2-repaired", { start_ms: 3, end_ms: 4, repair_of: "2", repaired_ms: 5 }, { [A.file]: 50_000 }, [A]], // audio, the mix missing
        ["3", { start_ms: 5, end_ms: 6 }, OK, [A]],
        ["3-repaired", { start_ms: 5, repair_of: "3", repaired_ms: 5 }, OK, [A]], // no end_ms: still being written
        ["4", { start_ms: 7, end_ms: 8 }, OK, [A]],
        ["4-repaired", { start_ms: 7, end_ms: 8, repair_of: "4" }, OK, [A]], // complete-looking, no completion stamp
    ]);
    assert.deepEqual(listRoom(root, ufs).map((e) => e.id).sort(), ["1", "1-repaired", "2", "2-repaired", "3", "3-repaired", "4", "4-repaired"]);
    rmSync(root, { recursive: true });
});

test("listRoom: a missing room directory is an empty list", () => {
    assert.deepEqual(listRoom(join(tmpdir(), "no-such-room-" + process.pid), ufs), []);
});

// ---- round 3 security review, RECORDER-5: which recordings a member may see ----------------------------------------------
import { historySince, visibleSince, sinceFromState, membershipStart } from "../vodslist.mjs";

test("historySince: shared / world_readable rooms show everything to members; joined / invited / unknown from the join on; guests always from the join", () => {
    const base = { membership: "join", joinedAt: 5000, user: "@a:x", now: 9000 };
    assert.equal(historySince({ ...base, historyVisibility: "shared" }), 0);
    assert.equal(historySince({ ...base, historyVisibility: "world_readable" }), 0);
    for (const hv of ["joined", "invited", "something-new", undefined]) assert.equal(historySince({ ...base, historyVisibility: hv }), 5000, String(hv));
    assert.equal(historySince({ ...base, historyVisibility: "shared", user: "@guest-abc:x" }), 5000);
    assert.equal(historySince({ ...base, historyVisibility: "joined", joinedAt: NaN }), 9000, "join time unknown: only from now on");
    for (const m of ["leave", "invite", "ban", undefined]) assert.equal(historySince({ ...base, membership: m, historyVisibility: "shared" }), null, String(m));
});

test("visibleSince: a session is visible when it ended at or after the join (or is still live)", () => {
    assert.equal(visibleSince({ end_ms: 100 }, 0), true);
    assert.equal(visibleSince({ end_ms: 100 }, 101), false);
    assert.equal(visibleSince({ end_ms: 101 }, 101), true);
    assert.equal(visibleSince({ live: true }, 101, 500), true);
    assert.equal(visibleSince({}, 101), false, "no end and not live: not shown under the join rule");
});

test("sinceFromState: the join time is the member event's own (from the admin API's envelopes, never its content)", () => {
    const me = "@b:x";
    const st = (hv, member) => [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: hv } }, member];
    const joined = { type: "m.room.member", state_key: me, sender: me, origin_server_ts: 7000,
        content: { membership: "join", origin_server_ts: 1, content: { membership: "join" } } };
    assert.equal(sinceFromState(st("joined", joined), me, 9000), 7000, "a timestamp written into the content is ignored");
    assert.equal(sinceFromState(st("shared", joined), me, 9000), 0);
    assert.equal(sinceFromState([joined], me, 9000), 0, "no history_visibility: the spec's default (shared)");
    assert.equal(sinceFromState(st("joined", { ...joined, content: { membership: "leave" } }), me, 9000), null);
    assert.equal(sinceFromState(st("joined", joined), "@other:x", 9000), null, "not in the room");
});

// ---- 0.3.15 assembly: the membership start, not the latest member event (a rename is not a new join) ------------------
const ROOMX = "!r:x";
const mev = (id, ts, membership, replaces, user = "@b:x", extra = {}) => ({ event_id: id, type: "m.room.member", state_key: user, room_id: ROOMX,
    origin_server_ts: ts, content: { membership, ...extra }, unsigned: replaces ? { replaces_state: replaces } : {} });
const stateOf = (hv, ev) => [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: hv } }, ev];
const chainFn = (evs) => { const m = new Map(evs.map((e) => [e.event_id, e])); const f = async (id) => { f.calls++; return m.get(id) ?? null; }; f.calls = 0; return f; };

test("membershipStart: a rename after joining keeps the older recordings (joined history)", async () => {
    const f = chainFn([mev("$j", 7000, "join")]);
    const cur = mev("$r", 9000, "join", "$j", "@b:x", { displayname: "new" });
    const st = stateOf("joined", cur);
    const start = await membershipStart(st, "@b:x", f);
    assert.equal(start, 7000);
    const since = sinceFromState(st, "@b:x", 10000, start);
    assert.equal(visibleSince({ end_ms: 8000 }, since), true, "a recording from before the rename, after the join");
    assert.equal(visibleSince({ end_ms: 6000 }, since), false, "from before the join: still hidden");
    assert.equal(visibleSince({ end_ms: 8000 }, sinceFromState(st, "@b:x", 10000)), false, "the old rule hid it (the bug)");
});
test("membershipStart: several renames walk back to the first join", async () => {
    const f = chainFn([mev("$r1", 8000, "join", "$j"), mev("$j", 7000, "join", "$i"), mev("$i", 6000, "invite")]);
    assert.equal(await membershipStart(stateOf("joined", mev("$r2", 9000, "join", "$r1")), "@b:x", f), 7000);
});
test("membershipStart: a real leave and rejoin starts again from the rejoin", async () => {
    const f = chainFn([mev("$l", 8000, "leave", "$j"), mev("$j", 1000, "join")]);
    assert.equal(await membershipStart(stateOf("joined", mev("$rj", 9000, "join", "$l")), "@b:x", f), 9000);
    assert.equal(f.calls, 1, "stops at the first non-join");
});
test("membershipStart: invited history starts at the invite that led to this membership", async () => {
    const f = chainFn([mev("$j", 7000, "join", "$i"), mev("$i", 6000, "invite", "$l"), mev("$l", 5000, "leave", "$old"), mev("$old", 1000, "join")]);
    assert.equal(await membershipStart(stateOf("invited", mev("$r", 9000, "join", "$j")), "@b:x", f), 6000, "rename, join, then the invite");
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$j")), "@b:x", f), 7000, "joined history: the join, not the invite");
    assert.equal(await membershipStart(stateOf("invited", mev("$j2", 9000, "join", "$l")), "@b:x", f), 9000, "invited history, no invite before it: the join");
});
test("membershipStart: a guest who renames keeps its view (always from the join, also in shared rooms)", async () => {
    const me = "@guest-1:x", f = chainFn([mev("$j", 7000, "join", "$i", me), mev("$i", 6000, "invite", null, me)]);
    const st = stateOf("shared", mev("$r", 9000, "join", "$j", me));
    const start = await membershipStart(st, me, f);
    assert.equal(start, 7000, "from the join, not the rename");
    assert.equal(sinceFromState(st, me, 10000, start), 7000, "the guest rule applies in a shared room");
    assert.equal(await membershipStart(stateOf("invited", mev("$r", 9000, "join", "$j", me)), me, f), 7000, "a guest never gets the invite rule");
});
test("membershipStart: shared rooms read no extra events", async () => {
    const f = chainFn([]);
    assert.equal(await membershipStart(stateOf("shared", mev("$r", 9000, "join", "$j")), "@b:x", f), 9000);
    assert.equal(f.calls, 0);
});
test("membershipStart: an unreadable or foreign event, or a chain over the bound, fails closed to the current event", async () => {
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$gone")), "@b:x", chainFn([])), 9000, "null");
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$x")), "@b:x", async () => { throw new Error("down"); }), 9000, "rejected");
    const other = chainFn([mev("$x", 1000, "join", null, "@other:x")]);
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$x")), "@b:x", other), 9000, "another person's event");
    const roomB = chainFn([{ ...mev("$x", 1000, "join"), room_id: "!other:x" }]);
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$x")), "@b:x", roomB), 9000, "another room's event");
    const long = []; for (let i = 0; i < 70; i++) long.push(mev(`$e${i}`, 100 + i, "join", `$e${i + 1}`));
    const f = chainFn(long);
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$e0")), "@b:x", f), 9000, "over the bound");
    assert.equal(f.calls, 50, "bounded");
    let t = 0; const slow = chainFn(long);
    assert.equal(await membershipStart(stateOf("joined", mev("$r", 9000, "join", "$e0")), "@b:x", slow, { clock: () => (t += 3000), deadlineMs: 8000 }), 9000, "past the deadline");
    assert.ok(slow.calls < 5);
});
test("membershipStart: a read that returns after the deadline is not used (fails closed)", async () => {
    let t = 0;
    const f = chainFn([mev("$i", 6000, "invite")]);
    const slow = async (id) => { t += 9000; return f(id); };
    assert.equal(await membershipStart(stateOf("invited", mev("$j", 9000, "join", "$i")), "@b:x", slow, { clock: () => t, deadlineMs: 8000 }), 9000);
});
test("membershipStart: not joined stays not joined", async () => {
    const st = stateOf("joined", mev("$l", 9000, "leave", "$j"));
    assert.equal(sinceFromState(st, "@b:x", 10000, await membershipStart(st, "@b:x", chainFn([]))), null);
});

// ---- round 3 security review, RECORDER-10: one directory, two room ids -------------------------------------------------
test("listRoom: sessions of another room sharing the directory name are never listed", () => {
    const dir = mkdtempSync(join(tmpdir(), "vods-room-"));
    try {
        for (const [id, room] of [["mine", "!a/b:evil.example"], ["theirs", "!a_b:evil.example"], ["noroom", undefined]]) {
            mkdirSync(join(dir, id));
            writeFileSync(join(dir, id, "session.json"), JSON.stringify({ ...(room ? { room } : {}), start_ms: 1, end_ms: 2 }));
        }
        const ids = (room) => listRoom(dir, () => (f) => f, room).map((e) => e.id).sort();
        assert.deepEqual(ids("!a/b:evil.example"), ["mine"]);
        assert.deepEqual(ids("!a_b:evil.example"), ["theirs"]);
        assert.deepEqual(ids(undefined), ["mine", "noroom", "theirs"], "no room given: as before (the repair tool's own use)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

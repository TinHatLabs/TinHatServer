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

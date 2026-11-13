// The Pad state file's load rules, shared with the manager (0.3.16; RELEASING.md: Pad state): the updater's rollback decides
// "keep the live file" or "put the safety copy back" by asking whether THIS API would load it (updater.pad_problem).
// Both sides run the same vectors (vectors/padstate-load.json; the manager's copy of the check:
// appliance/tests/test_pad_rollback.py), so a change to either reader without the other fails a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPadState } from "../padstate.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/padstate-load.json", import.meta.url), "utf8"));

test("padstate-load vectors: every case loads (ok) or fails closed exactly as the manager's check says", () => {
    assert.ok(V.cases.length >= 30);
    assert.ok(V.cases.some((c) => c.ok) && V.cases.some((c) => !c.ok));
    const dir = mkdtempSync(join(tmpdir(), "padvec-"));
    try {
        for (const [i, c] of V.cases.entries()) {
            const file = join(dir, `s${i}.json`);
            writeFileSync(file, c.raw, "utf8");
            const logs = [];
            const s = createPadState({ file, log: (l) => logs.push(l) });
            assert.equal(s.ok(), c.ok, `${c.name}: ok() ${s.ok()}, the vector says ${c.ok}`);
            assert.equal(logs.some((l) => l.includes("ALERT")), !c.ok, `${c.name}: an ALERT exactly when it fails closed`);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("this API rewrites only what it knows: an additive top-level key is dropped on its next write (a newer release treats a missing key as empty)", () => {
    const dir = mkdtempSync(join(tmpdir(), "padvec-"));
    try {
        const file = join(dir, "state.json");
        writeFileSync(file, JSON.stringify({ v: 2, last: 0, gens: {}, watch: {}, muted: {}, unmuted: {}, issued: {}, future: { x: 1 } }));
        const s = createPadState({ file });
        assert.equal(s.ok(), true);
        s.setMuted("!r:test", "@b:test", "@a:test");
        const j = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(j.v, 2);
        assert.equal("future" in j, false);
        assert.ok(j.muted["!r:test\n@b:test"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

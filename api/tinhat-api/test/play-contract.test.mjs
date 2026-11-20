// The play contract (vectors/views/): the fixtures are generated from the projection code, validate against the
// schema, the repo copy is byte-identical to what the source builds, malformed cases fail, and no view leaks a secret
// (with a planted leak that must be caught).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SCHEMA } from "../play/contract/schema.mjs";
import { validate } from "../play/jsonschema.mjs";
import { allSteps } from "../play/contract/fixtures.mjs";
import * as views from "../play/views.mjs";
import { leaks } from "../play/privacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COPY = join(HERE, "vectors/play/views");

function listFiles(dir, rel = "") {
    const out = [];
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...listFiles(dir, r)); else out.push(r);
    }
    return out.sort();
}

test("the committed contract copy is byte-identical to what the source builds", () => {
    const tmp = mkdtempSync(join(tmpdir(), "games-s1-contract-"));
    try {
        execFileSync(process.execPath, [join(HERE, "../play/contract/build.mjs"), tmp], { stdio: "pipe" });
        const a = listFiles(tmp), b = listFiles(COPY);
        assert.deepEqual(b, a, "same file list");
        for (const f of a) assert.equal(readFileSync(join(COPY, f), "utf8"), readFileSync(join(tmp, f), "utf8"), f);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("every fixture view validates; every malformed case fails", () => {
    for (const f of listFiles(COPY).filter((f) => /^(holdem|rig)\//.test(f))) {
        const s = JSON.parse(readFileSync(join(COPY, f), "utf8"));
        for (const [who, v] of Object.entries(s.views)) {
            assert.deepEqual(validate(SCHEMA, { $ref: `#/$defs/${s.game}View` }, v), [], `${f} ${who}`);
        }
    }
    const mal = JSON.parse(readFileSync(join(COPY, "malformed.json"), "utf8"));
    assert.ok(mal.cases.length >= 20);
    for (const c of mal.cases) assert.notDeepEqual(validate(SCHEMA, { $ref: `#/$defs/${c.def}` }, c.value), [], c.id);
});

test("the schema checker itself can fail (negative control: a wrong type, a missing field, an extra field)", () => {
    const v = JSON.parse(readFileSync(join(COPY, "holdem/02-preflop.json"), "utf8")).views.seat6;
    assert.deepEqual(validate(SCHEMA, { $ref: "#/$defs/holdemView" }, v), []);
    assert.notDeepEqual(validate(SCHEMA, { $ref: "#/$defs/holdemView" }, { ...v, vseq: "2" }), []);
    const { table, ...noTable } = v; void table;
    assert.notDeepEqual(validate(SCHEMA, { $ref: "#/$defs/holdemView" }, noTable), []);
    assert.notDeepEqual(validate(SCHEMA, { $ref: "#/$defs/holdemView" }, { ...v, deck: [] }), []);
});

test("no view leaks a secret: every step, every viewer (and only the owner's view has `you`)", () => {
    const steps = allSteps();
    let checked = 0;
    for (const s of steps) {
        for (const [who, view] of Object.entries(s.views)) {
            const viewer = who === "spectator" ? null : s.people[who];
            assert.deepEqual(leaks(s.game, view, viewer, s.god), [], `${s.game}/${s.id} as ${who}`);
            checked++;
        }
    }
    assert.ok(checked > 100, `checked ${checked} views`);
});

test("negative control: a planted leak in the projection is caught", () => {
    const steps = allSteps();
    const h = steps.find((s) => s.game === "holdem" && s.id === "04-flop");
    // plant 1: another seat's hole cards copied into the public seat list
    const leaky = JSON.parse(JSON.stringify(h.views.seat4));
    leaky.seats.find((x) => x.seat === 1).shown = ["As", "Kd"];
    assert.notDeepEqual(leaks("holdem", leaky, h.people.seat4), []);
    // plant 2: a Mechanic's card in a Sharp's you
    const r = steps.find((s) => s.game === "rig" && s.id === "04-turn-full");
    const leaky2 = JSON.parse(JSON.stringify(r.views.ana));
    leaky2.round.whispers = [{ who: r.people.dee, spin: 4, text: "x" }];
    assert.notDeepEqual(leaks("rig", leaky2, r.people.ana), []);
    // plant 3: the reveal before the reveal
    const leaky3 = JSON.parse(JSON.stringify(r.views.ben));
    leaky3.round.reveal = steps.find((s) => s.game === "rig" && s.id === "10-reveal").views.ben.round.reveal;
    assert.notDeepEqual(leaks("rig", leaky3, r.people.ben), []);
    // plant 4: the Spinner's Audit in a House view
    const a = steps.find((s) => s.game === "rig" && s.id === "05-turn-audit");
    const leaky4 = JSON.parse(JSON.stringify(a.views.cy));
    leaky4.round.audit = a.views.ben.round.audit;
    assert.notDeepEqual(leaks("rig", leaky4, a.people.cy), []);
    // plant 5: a projection that spreads the god state (the bug views.mjs is written to avoid)
    const god = { game: "holdem", table: "tH3k9aB2cD4eF6gH", room: "!games:example.org", space: "!hangout:example.org", owner: "example.org", vseq: 1, now: 1, status: "hand", host: "@a:x", opts: { sb: 1, bb: 2, seats: 8, turn_s: 30 }, spectators: 0, closed: null, result: null,
        seats: [{ seat: 1, u: "@a:x", stack: 5, bet: 0, state: "active", hole: ["As", "Ad"], connected: true }, { seat: 2, u: "@b:x", stack: 5, bet: 0, state: "active", hole: ["Ks", "Kd"], connected: true, cap: 100, holdings: 5 }],
        hand: { n: 1, button: 1, sb: 1, bb: 2, street: "flop", board: ["2c", "3c", "4c"], pots: [], total: 0, to_act: null, last: null } };
    const spread = { ...views.holdemView(god, "@b:x"), seats: god.seats };
    assert.notDeepEqual(leaks("holdem", spread, "@b:x"), []);
    assert.deepEqual(leaks("holdem", views.holdemView(god, "@b:x"), "@b:x"), []);
});

test("the projection drops nested secrets it doesn't know (allowlists at every level), and shows Hold'em cards only for seats still in at a showdown", () => {
    const steps = allSteps();
    const r = steps.find((s) => s.game === "rig" && s.id === "04-turn-full");
    const god = JSON.parse(JSON.stringify(r.god));
    god.round.history[0].honest = ["hat", "hat", "hat"]; god.round.history[0].touched = ["moon-monday"]; god.round.history[0].stamps.push("muted-hidden");
    god.round.refilled[0].slot = 2; god.round.refilled[0].owner = r.people.cy;
    god.round.nudge = { open: false, deadline: null, reel: 3, step: 1, by: r.people.ana };
    god.round.bankroll.secret = 1; god.round.features.slots = [1, 2]; god.round.paused = { budget_ms: 1, who: r.people.ben };
    god.round.slots = [{ slot: 1, card: "moon-monday", owner: r.people.dee }]; god.round.mutes = [{ spin: 5, owner: r.people.dee }];
    god.round.audit = { spin: 2, honest_reels: ["dish", "dish", "dish"], honest_payout: 16, touched: 2, cards: ["rebound"] };
    god.end = null;
    for (const [who, u] of Object.entries(r.people)) {
        const v = views.rigView(god, who === "spectator" ? null : u);
        assert.deepEqual(leaks("rig", v, who === "spectator" ? null : u, god), [], `rig as ${who}`);
        const text = JSON.stringify(v);
        for (const bad of ['"honest"', '"slot"', '"by":"' + r.people.ana, '"secret"', '"slots"', '"mutes":[', '"muted-hidden"', '"cards"']) assert.ok(!text.includes(bad), `${who}: ${bad} leaked`);
    }
    // Hold'em: a folded seat named in hand.show / result.shown is never shown; an uncontested hand shows nothing
    const h = JSON.parse(JSON.stringify(steps.find((s) => s.game === "holdem" && s.id === "06-showdown").god));
    h.seats.find((s) => s.seat === 4).state = "folded";
    const v4 = views.holdemView(h, h.seats[0].u);
    assert.equal(v4.seats.find((s) => s.seat === 4).shown, undefined);
    assert.equal(v4.result.shown["4"], undefined); assert.equal(v4.result.best["4"], undefined);
    assert.ok(v4.result.shown["6"]);
    h.hand.street = "river"; // e.g. everyone else folded on the river: no showdown
    const vu = views.holdemView(h, h.seats[0].u);
    assert.deepEqual(vu.result.shown, {}); assert.ok(vu.seats.every((s) => !s.shown));
    h.hand.street = "showdown"; h.result.voided = true;
    assert.deepEqual(views.holdemView(h, null).result.shown, {});
});

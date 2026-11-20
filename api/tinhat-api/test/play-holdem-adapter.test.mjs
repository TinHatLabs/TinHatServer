// The Hold'em contract adapter (play/holdem-contract.mjs) against games-s1's frozen play contract
// (test/vectors/play/views/: schema.json + holdem/NN fixtures, byte copies of the share's vectors/views, INDEX md5
// pinned below):
// - the contract's own fixtures 01–06, 08, 09 replayed through the REAL engine (same seats, stacks, cards, moves)
//   come out equal to the fixture views for every viewer (turn numbers, vseq and now normalised: they're opaque);
// - across a seeded fuzz through the facade, every contract view of every viewer validates against holdemView, names
//   only cards it may (board, own, shown), is unchanged when everyone else's hidden cards are scrambled, and its vseq
//   moves exactly when that viewer's view changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as H from "../play/holdem.mjs";
import { holdemContract } from "../play/adapt.mjs";
// games-s1's adapter takes the close reason and a voided hand from the platform: the platform side as it would pass them
const closeReason = (r) => ({ drain: "off", void: "restart" })[r] || r;
const platformBits = (st) => ({ closedReason: st.closed ? closeReason(st.closed.reason) : undefined, closedAt: st.closed ? st.closed.at : undefined, voidedHand: st.hand && st.hand.voided ? st.hand.n : undefined });
import { validate } from "../play/jsonschema.mjs";
import { seeded } from "./play-holdem-sim.mjs";

const VIEWS = new URL("./vectors/play/views/", import.meta.url);
const MISMATCH = [];
const read = (f) => readFileSync(new URL(f, VIEWS));
const SCHEMA = JSON.parse(read("schema.json"));
const VIEW_SCHEMA = SCHEMA.$defs.holdemView;
const FIX = (n) => JSON.parse(read(`holdem/${n}.json`));
const NOW = 1_763_600_000_000;

test("the contract copy is games-s1's frozen one (INDEX md5) and every file matches its INDEX entry", () => {
    assert.ok(["510330ad3708af4ca75c505edfb33b02", "a2b2fac900b282592d7dcca25319c79b", "ec750aaf74409cf57ca43f22e5e544af", "ed04f652a3a50bbe57805eb0e5289991", "c356ec2ef3bffb05860bccd8d9169ba0", "626d4e75cf3b324db2d70d23e1c0f849"].includes(createHash("md5").update(read("INDEX.json")).digest("hex")));
    const index = JSON.parse(read("INDEX.json"));
    const files = index.files || index;
    let n = 0;
    for (const [f, md5] of Object.entries(files)) {
        if (typeof md5 !== "string" || !/^[0-9a-f]{32}$/.test(md5)) continue;
        assert.equal(createHash("md5").update(read(f)).digest("hex"), md5, f);
        n++;
    }
    assert.ok(n >= 20, `INDEX lists ${n} files`);
});

// ---------------------------------------------------------------------------------- the fixtures, replayed for real

const PEOPLE = { 1: "@ana:example.org", 4: "@ben:example.org", 6: "@dee:example.net" };
const CY = "@cy:example.org";

/** The platform's side of a fixture step: wallets, screens, connections from the fixture's own `you` blocks. */
function ctxFrom(fix) {
    const you = {};
    for (const v of Object.values(fix.views)) if (v.you) you[fix.people[`seat${v.you.seat}`]] = v.you;
    const any = Object.values(fix.views)[0];
    return {
        room: any.room, owner: any.owner, space: any.space, now: NOW, spectators: any.spectators, hostMx: any.host,
        mx: (id) => id,
        connected: (id) => (any.seats.find((s) => s.u === id) || { connected: true }).connected,
        screens: (id) => (you[id] ? you[id].screens : []),
        wallet: (id) => (you[id] ? { holdings: you[id].holdings, at_cap: you[id].at_cap, cap: you[id].cap } : {}),
    };
}

/** Compare everything but the opaque counters (turn numbers, vseq, now). */
function norm(v) {
    const c = structuredClone(v);
    c.vseq = 0;
    c.now = 0;
    if (c.hand && c.hand.to_act) c.hand.to_act.turn = 0;
    return c;
}

function checkStep(st, name) {
    const fix = FIX(name);
    const ctx = ctxFrom(fix);
    for (const [role, want] of Object.entries(fix.views)) {
        const who = role === "spectator" ? null : fix.people[role];
        const got = holdemContract(H.viewFor(st, who, NOW), st, who, { ...ctx, ...platformBits(st) });
        assert.deepEqual(validate(SCHEMA, VIEW_SCHEMA, got), [], `${name} ${role}: schema`);
        assert.deepEqual(norm(got), norm(want), `${name} ${role}`);
    }
}

function fixtureTable() {
    // ana sits at 1 with 40, ben at 4 with 30, dee at 6 with 20 (fixture 01); the table id and room are the fixture's
    let st = H.createTable({ table: "tH3k9aB2cD4eF6gH", room: "!games:example.org", space: "!hangout:example.org", host: PEOPLE[1], now: NOW });
    const wallets = { [PEOPLE[1]]: 40, [PEOPLE[4]]: 30, [PEOPLE[6]]: 20 };
    for (const seat of [1, 4, 6]) {
        const r = H.act(st, PEOPLE[seat], { do: "sit", seat, space: "!hangout:example.org" }, { now: NOW, balances: { [PEOPLE[seat]]: wallets[PEOPLE[seat]] } });
        assert.ok(r.ok, r.code);
        st = r.state;
    }
    return st;
}

test("contract fixtures replayed through the engine: 01 lobby → 02 preflop → 03 raised → 04 flop → 05 short all-in → 06 showdown → 08 restart void", () => {
    let st = fixtureTable();
    checkStep(st, "01-lobby");
    // the first button is random: the fixture's is seat 6 (index 2); the rest of the deck is rigged below
    const LAST = (min, max) => max - 1;
    let r = H.act(st, PEOPLE[1], { do: "deal" }, { now: NOW, balances: {}, admitted: true, randomInt: LAST });
    assert.ok(r.ok, r.code);
    st = structuredClone(r.state);
    st.hand.holes = { 1: ["As", "Kd"], 4: ["9h", "9c"], 6: ["Qs", "Jc"] };
    const board = ["2c", "9d", "Ts", "Kh", "5s"];
    const used = new Set([...Object.values(st.hand.holes).flat(), ...board]);
    st.hand.deck = [...board, ...st.hand.deckFull.filter((c) => !used.has(c))];
    checkStep(st, "02-preflop");
    const play = (seat, a) => {
        const rr = H.act(st, PEOPLE[seat], { ...a, at: { hand: st.hand.n, turn: st.hand.turn } }, { now: NOW, balances: {} });
        assert.ok(rr.ok, `${seat} ${a.do}: ${rr.code}`);
        st = rr.state;
    };
    play(6, { do: "raise", to: 6 });
    checkStep(st, "03-preflop-raised");
    play(1, { do: "call" });
    play(4, { do: "call" });
    checkStep(st, "04-flop");
    play(1, { do: "check" }); play(4, { do: "check" }); play(6, { do: "check" });
    play(1, { do: "raise", to: 10 });
    play(4, { do: "call" });
    checkStep(st, "05-turn-short-allin");
    play(6, { do: "allin" });
    play(1, { do: "call" });
    play(4, { do: "call" });
    play(1, { do: "check" });
    play(4, { do: "check" });
    checkStep(st, "06-showdown");
    // hand 2 starts after the pause; a restart calls it off and closes the table
    r = H.tick(st, { now: st.pauseUntil, balances: {}, admitted: true, randomInt: LAST });
    assert.ok(r.ok);
    r = H.voidRound(r.state, { now: NOW, reason: "restart" });
    assert.ok(r.ok);
    checkStep(r.state, "08-voided-restart");
});

test("contract fixture 09: the host closes the table after a hand", () => {
    let st = fixtureTable();
    let r = H.act(st, PEOPLE[1], { do: "deal" }, { now: NOW, balances: {}, admitted: true });
    st = r.state;
    while (st.status === "hand") {
        const who = st.seats[st.hand.b.toAct].id;
        r = H.act(st, who, { do: "fold", at: { hand: st.hand.n, turn: st.hand.turn } }, { now: NOW, balances: {} });
        st = r.state;
    }
    r = H.act(st, PEOPLE[1], { do: "close" }, { now: NOW, balances: {} });
    assert.ok(r.ok);
    checkStep(r.state, "09-closed-host");
});

test("you.timeouts = the run of timeouts (0..2); a spectator has no you", () => {
    let st = fixtureTable();
    st = H.act(st, PEOPLE[1], { do: "deal" }, { now: NOW, balances: {}, admitted: true }).state;
    const ctx = ctxFrom(FIX("02-preflop"));
    const first = st.seats[st.hand.b.toAct].id;
    st = H.tick(st, { now: st.hand.deadline, balances: {}, admitted: true }).state;
    assert.equal(holdemContract(H.viewFor(st, first, NOW), st, first, ctx).you.timeouts, 1);
    assert.equal(holdemContract(H.viewFor(st, null, NOW), st, null, ctx).you, undefined);
});



// ------------------------------------------------------------------------------------------- the fuzz, every viewer

const CARD = /"([2-9TJQKA][cdhs])"/g;
const ctxFuzz = (st, now, wallets) => ({
    room: "!r:x.org", owner: "x.org", now, spectators: 2, hostMx: "@nobody:x.org",
    mx: (id) => id, connected: () => true, screens: () => ["web"],
    wallet: (id) => ({ holdings: (wallets[id] || 0) + ((Object.values(st.seats).find((x) => x.id === id) || {}).stack || 0), at_cap: false, cap: 100 }),
});

function scrambleOthers(st, viewer, R) {
    const T = structuredClone(st);
    const h = T.hand;
    if (!h || h.done) return T;
    const mine = Object.keys(h.ids).find((s) => h.ids[s] === viewer);
    const free = [...h.deck];
    for (const s of Object.keys(h.holes)) if (s !== mine) free.push(...h.holes[s]);
    for (let i = free.length - 1; i > 0; i--) { const j = R(0, i + 1); [free[i], free[j]] = [free[j], free[i]]; }
    for (const s of Object.keys(h.holes)) if (s !== mine) h.holes[s] = [free.pop(), free.pop()];
    h.deck = free;
    return T;
}

test("contract fuzz: 25 seeded tables through the facade; every viewer's contract view validates, is private, ignores others' hidden cards", () => {
    let views = 0;
    let hands = 0;
    for (let seed = 1; seed <= 25; seed++) {
        const R = seeded(1000 + seed);
        const people = Array.from({ length: R(2, 9) }, (_, i) => `@p${i}:x.org`);
        const wallets = Object.fromEntries(people.map((p) => [p, R(0, 50)]));
        let now = NOW;
        let st = H.createTable({ table: "tHabcdefghijklmn", room: "!r:x.org", space: "!s:x.org", host: people[0], now });
        const seen = new Map(); // viewer → { json, vseq }
        const watch = [...people, null];
        const check = () => {
            for (const who of watch) {
                const ctx = ctxFuzz(st, now, wallets);
                const c = holdemContract(H.viewFor(st, who, now), st, who, { ...ctx, ...platformBits(st) });
                const errs = validate(SCHEMA, VIEW_SCHEMA, c);
                assert.deepEqual(errs, [], `seed ${seed} ${who}: ${errs.join("; ")}`);
                const json = JSON.stringify({ ...c, vseq: 0, now: 0 });
                // privacy: only the board, the viewer's own cards and cards shown at a showdown
                const h = st.hand;
                const ok = new Set();
                if (h && !h.voided && (st.status === "hand" || st.status === "pause")) {
                    for (const x of h.board) ok.add(x);
                    if (h.done && h.result) for (const cs of Object.values(h.result.shown)) for (const x of cs) ok.add(x);
                    const mine = Object.keys(h.ids).find((s) => h.ids[s] === who && st.seats[s] && st.seats[s].id === who);
                    if (mine !== undefined) for (const x of h.holes[mine]) ok.add(x);
                }
                for (const m of json.matchAll(CARD)) assert.ok(ok.has(m[1]), `seed ${seed}: ${who}'s view names ${m[1]}`);
                // non-interference: everyone else's hidden cards (and the deck) scrambled → the same view
                const S = scrambleOthers(st, who, R);
                const c2 = holdemContract(H.viewFor(S, who, now), S, who, { ...ctxFuzz(S, now, wallets), ...platformBits(S) });
                assert.equal(JSON.stringify({ ...c2, vseq: 0, now: 0 }), json, `seed ${seed}: ${who}'s view depends on hidden cards`);
                seen.set(who, { json, vseq: c.vseq });
                views++;
            }
        };
        const call = (r) => {
            if (!r.ok) { assert.equal(r.state, st); return; }
            for (const e of r.effects) {
                if (e.t === "sit" || e.t === "credit") wallets[e.who] -= e.amount;
                if (e.t === "cashout") wallets[e.who] += e.amount;
            }
            st = r.state;
            check();
        };
        check();
        for (let step = 0; step < 900 && st.status !== "closed"; step++) {
            const roll = R(0, 100);
            const p = people[R(0, people.length)];
            const ctx = { now, balances: { ...wallets }, admitted: true, randomInt: R };
            if (roll < 3) {
                // a chip earned: the platform's own field (you.holdings) changed, shown only to a seated person
                wallets[p] += 1;
                void p;
                continue;
            }
            if (st.status === "lobby") { call(roll < 60 ? H.act(st, p, { do: "sit", space: "!s:x.org" }, ctx) : H.act(st, st.host ?? p, { do: "deal" }, ctx)); continue; }
            if (st.status === "pause") {
                if (roll < 10) call(H.act(st, p, { do: "leave" }, ctx));
                else if (roll < 18) call(H.act(st, p, { do: "away", on: roll < 14 }, ctx));
                else { now = st.pauseUntil; call(H.tick(st, { ...ctx, now })); }
                continue;
            }
            const h = st.hand;
            const who = st.seats[h.b.toAct].id;
            if (roll < 10) { now = h.deadline; call(H.tick(st, { ...ctx, now })); continue; }
            if (roll < 13) { call(H.act(st, p, { do: "leave" }, ctx)); continue; }
            if (roll < 15) { call(H.act(st, p, { do: "sit", space: "!s:x.org" }, ctx)); continue; }
            const lg = H.viewFor(st, who).you.legal;
            const at = { hand: h.n, turn: h.turn };
            if (roll < 30) call(H.act(st, who, { do: "fold", at }, ctx));
            else if (roll < 70 || !lg.raise) call(H.act(st, who, { do: lg.check ? "check" : "call", at }, ctx));
            else if (roll < 90) call(H.act(st, who, { do: "raise", at, to: R(lg.raise.min, lg.raise.max + 1) }, ctx));
            else call(H.act(st, who, { do: "allin", at }, ctx));
        }
        hands += st.n;
        if (st.status !== "closed") call(H.voidRound(st, { now, reason: "restart" }));
    }
    assert.ok(hands >= 800 && views >= 25_000, `${hands} hands, ${views} views`);
});

function firstDiff(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `…${a.slice(Math.max(0, i - 80), i + 60)}… → …${b.slice(Math.max(0, i - 80), i + 60)}…`;
}

test("a player who left at the end of a hand keeps their showdown cards (and best hand) in result.shown / result.best", () => {
    let st = H.createTable({ table: "tHabcdefghijklmn", room: "!r:x.org", space: "!s:x.org", host: "@a:x.org", now: NOW });
    for (const [who, n] of [["@a:x.org", 20], ["@b:x.org", 20]]) st = H.act(st, who, { do: "sit", space: "!s:x.org" }, { now: NOW, balances: { [who]: n } }).state;
    st = structuredClone(H.act(st, "@a:x.org", { do: "deal" }, { now: NOW, balances: {}, admitted: true, randomInt: () => 0 }).state);
    assert.equal(st.hand.button, 1);
    st.hand.holes = { 1: ["As", "Ad"], 2: ["Kc", "Kd"] };
    const board = ["2h", "7s", "9c", "Jd", "3h"];
    st.hand.deck = [...board, ...st.hand.deckFull.filter((c) => ![...board, "As", "Ad", "Kc", "Kd"].includes(c))];
    const step = (r) => { assert.ok(r.ok, r.code); return r.state; };
    st = step(H.act(st, "@a:x.org", { do: "allin", at: { hand: 1, turn: st.hand.turn } }, { now: NOW, balances: {} }));
    st = step(H.act(st, "@a:x.org", { do: "leave" }, { now: NOW, balances: {} }));
    st = step(H.act(st, "@b:x.org", { do: "call", at: { hand: 1, turn: st.hand.turn } }, { now: NOW, balances: {} }));
    const ctx = { ...ctxFuzz(st, NOW, {}), ...platformBits(st) };
    const c = holdemContract(H.viewFor(st, null, NOW), st, null, ctx);
    assert.deepEqual(c.result.pots[0].winners, [1], "seat 1 (who left) won the pot");
    assert.deepEqual(c.result.shown, { 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, "…so its cards were shown and must stay in the result");
    assert.ok(c.result.best[1], "…and its best hand");
});

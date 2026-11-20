// games-rig's random-play harness through games-s1's Rig adapter (play/adapt.mjs rigContract) and its privacy check
// (play/privacy.mjs leaks, which includes the schema). For games-s1 to adopt or adapt; scratch run by games-rig.
import { test } from "node:test";
import assert from "node:assert/strict";
import { E, U, platform, skipSetup, spin, rng, pickOf, randomMove, scramble } from "./play-rig-harness.mjs";
import { rigContract } from "../play/adapt.mjs";
import { leaks } from "../play/privacy.mjs";

const TABLE = "tR7q2wE4rT6yU8iO";
const OUT = "@watch:lab.test";
const ctxFor = (H, st = H.st) => ({
    room: "!room:lab.test", owner: "lab.test", mx: (u) => u, connected: (u) => !(st.offline || []).includes(u),
    screens: () => ["web"], wallet: (u) => ({ holdings: H.bal[u] ?? 0, at_cap: false, cap: 100 }), spectators: 1,
    closedAt: H.now, now: H.now, hostMx: st.host,
});
const cv = (H, u, st = H.st) => rigContract(E.viewFor(st, u, H.now), st, u === OUT ? null : u, ctxFor(H, st));
function firstDiff(a, b, path = "$") {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === "object" && typeof b === "object") {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    }
    return `${path}: ${JSON.stringify(b)?.slice(0, 80)} → ${JSON.stringify(a)?.slice(0, 80)}`;
}
const strip = (v) => { const { vseq, now, ...rest } = v; if (rest.round?.paused) rest.round = { ...rest.round, paused: "clock" }; return JSON.stringify(rest); };

function play(t, each) {
    const r = rng(7000 + t);
    const n = 3 + (t % 6);
    const H = platform(n, (u) => [0, 1, 2, 3, 5, 9, 20][Math.floor(r() * 7)] + (u === U(0) ? 10 : 0), `a${t}`, { table: TABLE });
    const people = [...H.people, OUT];
    each(H, people, r);
    H.must(H.people[0], { do: "start", preset: r() < 0.5 ? "full" : "lite", bankroll: 3 + Math.floor(r() * 8), patch: r() < 0.7 });
    for (let step = 0; step < 3000 && H.st.status === "round"; step++) {
        if (r() < 0.25) H.advance(Math.floor(r() * 6000));
        else if (r() < 0.03) H.st = E.setOnline(H.st, pickOf(r, H.people), r() < 0.5, H.ctx()).state;
        else {
            const [who, a] = randomMove(H, r);
            if (H.R().phase !== "reveal" && a.do !== "dial") a.at = { round: H.R().r, spin: H.R().spin, phase: H.R().phase };
            H.do(who, a);
        }
        each(H, people, r);
    }
    if (H.st.status === "end") { H.must(H.st.host, { do: "close" }); each(H, people, r); }
}

test("s1 adapter: no leaks (schema + privacy.mjs) for every person at every step of 60 random tables", () => {
    const problems = new Map();
    for (let t = 0; t < 60; t++) play(t, (H, people) => {
        for (const u of people) for (const p of leaks("rig", cv(H, u), u === OUT ? null : u, null)) if (!problems.has(p.replace(/\[\d+\]/g, "[]"))) problems.set(p.replace(/\[\d+\]/g, "[]"), `table ${t} ${u} phase ${H.st.round?.phase}`);
    });
    assert.deepEqual([...problems.entries()], []);
});

test("s1 adapter: others' secrets never change your view (non-interference)", () => {
    const problems = [];
    for (let t = 0; t < 60 && problems.length < 5; t++) play(t, (H, people, r) => {
        if (!H.st.round || H.R().phase === "reveal") return;
        for (const u of people) {
            const a = JSON.stringify(cv(H, u)), s2 = scramble(H.st, u, r), b = JSON.stringify(cv(H, u, s2));
            if (a !== b && problems.length < 5) problems.push(`table ${t} ${u}: ${a.length} vs ${b.length}`);
        }
    });
    assert.deepEqual(problems, []);
});

test("s1 adapter: a person's vseq moves exactly when their contract view does", () => {
    const problems = new Map();
    for (let t = 0; t < 60; t++) {
        const prev = {};
        play(t, (H, people) => {
            for (const u of people) {
                const v = cv(H, u), p = prev[u];
                if (p) {
                    const changed = strip(v) !== strip(p), moved = v.vseq !== p.vseq;
                    if (changed !== moved) {
                        const k = changed ? "view changed, vseq didn't" : "vseq moved, view didn't";
                        if (!problems.has(k)) { const { vseq: _a, now: _b, ...x } = v; const { vseq: _c, now: _d, ...y } = p; problems.set(k, `table ${t} ${u} phase ${H.st.round?.phase}: ${firstDiff(x, y)}`); }
                    }
                    if (v.vseq < p.vseq) problems.set("vseq went back", `table ${t} ${u}`);
                }
                prev[u] = v;
            }
        });
    }
    assert.deepEqual([...problems.entries()], []);
});

test("s1 adapter vs the contract README: busted Mechanic keeps the role + gets the Patch; setup spin 0; spun; end.rounds; orders", () => {
    const issues = [];
    const H = platform(5, 20, "sem", { table: TABLE });
    H.must(H.people[0], { do: "start", preset: "full" });
    let v = cv(H, H.people[1]);
    if (v.round.spin !== 0) issues.push(`SETUP shows spin ${v.round.spin} (README/fixture 02: 0)`);
    if (v.players.find((p) => p.u === H.R().spinner).spun) issues.push("the current Spinner shows spun: true in their own round (fixture 04: false)");
    if (v.round.waiting_on === 0 && H.R().phase === "setup") issues.push("SETUP waiting_on is always 0 (fixture 02: 4)");
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline(); skipSetup(H);
    const S = H.R().spinner, slot = H.R().slots[0], M = slot.owner;
    H.must(S, { do: "call", card: slot.card });
    v = cv(H, M);
    if (v.players.find((p) => p.u === M).role !== "mechanic") issues.push(`a busted Mechanic shows role ${v.players.find((p) => p.u === M).role} (README: keeps mechanic)`);
    if (!v.you.busted || !("patch" in v.you)) issues.push(`a busted Mechanic's you = ${JSON.stringify(v.you)}: no busted/patch, so the UI can't offer the Patch`);
    for (let i = 0; i < 4; i++) { H.toDeadline(); if (H.st.status !== "round") break; if (H.R().phase === "setup") skipSetup(H); while (H.st.status === "round" && H.R().phase === "turn" && H.R().spin < 6) spin(H, 1); if (H.st.status === "round" && H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" }); }
    while (H.st.status === "round") H.toDeadline();
    v = cv(H, H.people[1]);
    if (v.status === "end" && v.end.rounds !== H.st.rounds_in_run) issues.push(`end.rounds ${v.end.rounds} vs ${H.st.rounds_in_run} rounds in this rotation`);
    assert.deepEqual(issues, []);
});

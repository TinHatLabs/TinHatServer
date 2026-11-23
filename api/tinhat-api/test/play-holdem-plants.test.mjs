// Planted-wrong-rule controls for the Hold'em engine (GAMES-V1-SPEC §8.1: every test shown able to fail). Each plant
// copies the engine and its tests to a temp dir, makes ONE exact source change (asserted to match exactly once, so a
// plant can't silently stop applying after a refactor), runs the real test files in a child `node --test`, and
// requires the named test(s) to FAIL. Plus: an empty engine fails every vector, and the vector files are the
// byte-identical spec copies (md5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failingCases } from "./play-holdem-vector-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, "..");
const vec = (f) => JSON.parse(readFileSync(join(HERE, "vectors/play", f), "utf8"));

const VECTOR_MD5 = {
    "holdem-betting.json": "aa2a21d2787a5cdbecfe136ce0db207b",
    "holdem-hand-ranking.json": "8b7623f5c04ab8a9e05312a2c65b5ad7",
    "holdem-side-pots.json": "7c8c8d6aa26e550d44a3259755ef0ad2",
};

test("the vector files are the spec's, byte for byte (md5); a lane never edits a vector to pass", () => {
    for (const [f, md5] of Object.entries(VECTOR_MD5))
        assert.equal(createHash("md5").update(readFileSync(join(HERE, "vectors/play", f))).digest("hex"), md5, f);
});

test("an empty engine fails every vector case (the vector test is red before the engine exists)", () => {
    const empty = {
        rank: { bestHand: () => ({}), showdown: () => ({}) },
        pots: { settlePots: () => ({}) },
        betting: { startBetting: () => ({}), act: () => {}, legal: () => null, BetError: class extends Error {} },
    };
    const R = vec("holdem-hand-ranking.json");
    const P = vec("holdem-side-pots.json");
    const B = vec("holdem-betting.json");
    const eq = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
    assert.equal(failingCases(empty, "seven", R.seven, eq).length, R.seven.length);
    assert.equal(failingCases(empty, "showdown", R.showdown, eq).length, R.showdown.length);
    assert.equal(failingCases(empty, "pots", P.cases, eq).length, P.cases.length);
    assert.equal(failingCases(empty, "betting", B.cases, eq).length, B.cases.length);
});

const V = "test/play-holdem-vectors.test.mjs";
const TBL = "test/play-holdem-table.test.mjs";
const FUZZ = "test/play-holdem-fuzz.test.mjs";
const FAC = "test/play-holdem-facade.test.mjs";

// { file (under play/), from, to, run: [test files], fails: [substrings of test names that must fail], why }
const PLANTS = [
    // hand ranking
    { file: "holdem-rank.mjs", from: "straightHigh = 5; //", to: "straightHigh = 14; //", run: [V], fails: ["seven-card", "showdown"], why: "the wheel counted ace-high" },
    { file: "holdem-rank.mjs", from: "if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];", to: "if (uniq[0] - uniq[4] === 4 || (uniq[0] === 14 && uniq[4] === 2)) straightHigh = uniq[0];", run: [V], fails: ["seven-card"], why: "Q-K-A-2-3 wraps into a straight" },
    { file: "holdem-rank.mjs", from: "if (flush) return [5, ...rs];", to: "if (flush) return [5, rs[0]];", run: [V], fails: ["seven-card", "showdown"], why: "flushes compared on the top card only" },
    { file: "holdem-rank.mjs", from: "return [2, g[0][0], g[1][0], g[2][0]];", to: "return [2, g[0][0], g[1][0]];", run: [V], fails: ["seven-card", "showdown"], why: "two pair without its kicker" },
    { file: "holdem-rank.mjs", from: "b[1] - a[1] || b[0] - a[0]", to: "b[1] - a[1] || a[0] - b[0]", run: [V], fails: ["seven-card"], why: "equal groups ordered low first (two trips, kickers)" },
    { file: "holdem-rank.mjs", from: "const n = parsed.length;", to: "const n = 5;", run: [V], fails: ["seven-card"], why: "only the first five of seven cards" },
    { file: "holdem-rank.mjs", from: "if (last && compareKeys(keys[last[0]], keys[s]) === 0) last.push(s);", to: "if (last && keys[last[0]][0] === keys[s][0]) last.push(s);", run: [V], fails: ["showdown"], why: "ties judged on the category alone (kickers ignored)" },
    // side pots
    { file: "holdem-pots.mjs", from: "if (top > second) {", to: "if (false) {", run: [V], fails: ["side pot"], why: "uncalled chips not returned" },
    { file: "holdem-pots.mjs", from: "for (const s of order) amount += Math.max(0, Math.min(put[String(s)], L) - prev);", to: "for (const s of live) amount += Math.max(0, Math.min(put[String(s)], L) - prev);", run: [V], fails: ["side pot"], why: "folded players' chips left out of the pots" },
    { file: "holdem-pots.mjs", from: "for (const s of clockwise) {", to: "for (const s of [...clockwise].reverse()) {", run: [V], fails: ["side pot"], why: "odd chips counter-clockwise" },
    { file: "holdem-pots.mjs", from: "if (total > inPots) {", to: "if (false) {", run: [V], fails: ["side pot"], why: "chips above the last live level left over" },
    // betting
    { file: "holdem-betting.mjs", from: "const sbSeat = n === 2 ? order[bi] : order[(bi + 1) % n];", to: "const sbSeat = order[(bi + 1) % n]; void bi;", run: [V], fails: ["betting"], why: "heads-up: the button doesn't post the small blind" },
    { file: "holdem-betting.mjs", from: "const min = h.current > 0 ? h.current + h.lastRaise : h.bb;", to: "const min = h.current > 0 ? h.current + h.bb : h.bb;", run: [V], fails: ["betting"], why: "min raise stuck at the big blind" },
    { file: "holdem-betting.mjs", from: "if (p.acted !== null && h.current - p.acted < h.lastRaise) raiseOk = false;", to: "", run: [V], fails: ["betting"], why: "a short all-in reopens the betting" },
    { file: "holdem-betting.mjs", from: "if (p.acted !== null && h.current - p.acted < h.lastRaise) raiseOk = false;", to: "if (p.acted !== null && h.current !== p.acted) raiseOk = false;", run: [V], fails: ["betting"], why: "short all-ins never add up to a full raise" },
    { file: "holdem-betting.mjs", from: "h.current = bb; // the full big blind", to: "h.current = Math.max(h.p[sbSeat].bet, h.p[bbSeat].bet); //", run: [V], fails: ["betting"], why: "a short big blind lowers the price to call" },
    { file: "holdem-betting.mjs", from: "const needsAction = (h, s) => h.p[s].acted === null || h.p[s].bet < h.current;", to: "const needsAction = (h, s) => h.p[s].bet < h.current;", run: [V], fails: ["betting"], why: "no big blind option" },
    { file: "holdem-betting.mjs", from: "if (able.length <= 1 || next === \"showdown\") {", to: "if (next === \"showdown\") {", run: [V], fails: ["betting"], why: "no run-out when nobody can bet" },
    { file: "holdem-betting.mjs", from: "if (!lg.check) throw new BetError(\"bad-action\");", to: "", run: [V], fails: ["betting"], why: "checking facing a bet" },
    { file: "holdem-betting.mjs", from: "to < lg.raise.min || ", to: "", run: [V], fails: ["betting"], why: "a raise under the minimum" },
    // the table: timers, leaving, void, privacy, the dealer
    { file: "holdem-table.mjs", from: "if (x.timeouts >= HOLDEM.AWAY_AFTER_TIMEOUTS && !x.away)", to: "if (x.timeouts >= 2 && !x.away)", run: [TBL], fails: ["timeouts:"], why: "v1.1: away after TWO timeouts (v1's rule) must fail" },
    { file: "holdem-table.mjs", from: ".filter((s) => T.seats[s].stack + T.seats[s].pending > 0 && !T.seats[s].away && !T.seats[s].leaving);", to: ".filter((s) => T.seats[s].stack + T.seats[s].pending > 0 && !T.seats[s].leaving);", run: [TBL], fails: ["timeouts:"], why: "v1.1: a blind taken from (dealing in) an away seat must fail" },
    { file: "holdem-table.mjs", from: "const rec = act(h.b, { do: lg.check ? \"check\" : \"fold\" });", to: "const rec = act(h.b, { do: \"fold\" }); void lg;", run: [TBL], fails: ["timeouts:"], why: "a timeout folds even when a check is free" },
    { file: "holdem-table.mjs", from: "if (!dealtIn(T, s)) return cashout(T, s, reason, c, fx);", to: "return cashout(T, s, reason, c, fx);", run: [TBL, FUZZ], fails: ["leaving mid-hand", "fuzz: 40"], why: "a leave mid-hand cashes out at once (chips still in the pot)" },
    { file: "holdem-table.mjs", from: "if (T.hand.b.toAct === s) progress(T, c, fx, false);", to: "if (T.hand.b.toAct === s) {}", run: [TBL], fails: ["leaving on one's own turn"], why: "a leaver whose turn it is waits for the timer" },
    { file: "holdem-table.mjs", from: "if (x) { x.stack = h.b.p[s].stack + h.b.p[s].total + x.pending; x.pending = 0; }", to: "if (x) { x.stack = h.b.p[s].stack + x.pending; x.pending = 0; }", run: [TBL, FUZZ], fails: ["void:", "fuzz: 40"], why: "a void doesn't give the pot back" },
    { file: "holdem-table.mjs", from: "cards: inHand && !p.folded ? 2 : 0,", to: "cards: inHand && !p.folded ? h.holes[s] : 0,", run: [TBL, FUZZ], fails: ["views:", "fuzz: 40"], why: "a view leaks hole cards" },
    { file: "holdem-table.mjs", from: "const inHandSeat = (T, s) => T.hand !== null && T.hand.order.includes(s) && !!T.seats[s] && T.hand.ids[s] === T.seats[s].id;", to: "const inHandSeat = (T, s) => T.hand !== null && T.hand.order.includes(s) && !!T.seats[s];", run: [FUZZ], fails: ["fuzz: 40"], why: "REVERTED FIX: a new player in a leaver's seat inherits that hand's cards" },
    { file: "holdem-table.mjs", from: "if (!m.at || m.at.hand !== h.n || m.at.turn !== h.turn) fail(\"stale\");", to: "", run: [TBL], fails: ["refusals"], why: "no stale-turn check (a double click lands on the next turn)" },
    { file: "holdem-table.mjs", from: "else button = eligible.find((s) => s > T.button) ?? eligible[0];", to: "else button = eligible[0];", run: [TBL], fails: ["heads-up"], why: "the button doesn't move" },
    { file: "holdem-table.mjs", from: "if (dealtIn(T, s)) x.pending += m.amount;", to: "if (false) x.pending += m.amount;", run: [TBL], fails: ["busted"], why: "chips earned mid-hand join the live stack" },
    { file: "holdem-table.mjs", from: "if (m.space !== T.space) fail(\"space-changed\");", to: "", run: [TBL], fails: ["space (rev 2): a sit naming another space"], why: "a sit for another space is debited" },
    { file: "holdem-table.mjs", from: "if (c.admitted === false) { closeTable(T, \"space-changed\", c, fx); return true; }", to: "if (c.admitted === false) {}", run: [TBL], fails: ["space (rev 2): the admission check fails"], why: "a failed admission check still deals" },
    { file: "holdem-table.mjs", from: "if (handOpen(T)) fail(\"phase\");\n                const s = seatOf(T, m.target);", to: "const s = seatOf(T, m.target);", run: [TBL], fails: ["kick is a leave, between hands only"], why: "REVIEW P1: a host kick mid-hand forces a fold" },
    { file: "holdem-betting.mjs", from: "h.p[s].bet >= Math.max(maxBet, h.current)) continue;", to: "h.p[s].bet >= maxBet) continue;", run: [TBL], fails: ["heads-up, a big blind all-in for less"], why: "REVIEW P2: a short big blind skips the small blind's call-or-fold" },
    { file: "holdem-table.mjs", from: "    closeTable(T, handWasOpen ? reason : T.closing || reason, c, fx);\n}", to: "    if (T.closing) closeTable(T, T.closing, c, fx); else T.status = \"lobby\";\n}", run: [TBL], fails: ["void:"], why: "REVIEW P2: a void leaves the table open" },
    { file: "holdem-table.mjs", from: "    if (c.admitted === false) { closeTable(T, \"space-changed\", c, fx); return true; }\n    markGone(T, c);\n    const eligible = eligibleSeats(T);\n    if (eligible.length < 2) return false;", to: "    markGone(T, c);\n    const eligible = eligibleSeats(T);\n    if (eligible.length < 2) return false;\n    if (c.admitted === false) { closeTable(T, \"space-changed\", c, fx); return true; }", run: [TBL], fails: ["even when no hand could start"], why: "REVIEW P2: a failed admission with too few players leaves the table open" },
    { file: "holdem-table.mjs", from: "if (h.deadline !== null && c.now >= h.deadline && h.instantTurn !== h.turn) fail(\"stale\");", to: "", run: [TBL], fails: ["once its turn's deadline has passed"], why: "a move after the deadline beats the timer" },
    // the platform surface (play/holdem.mjs)
    { file: "holdem.mjs", from: "if (a.space !== st.space) return refuse(st, \"space-changed\"); // before any debit (rev 2)", to: "", run: [FAC], fails: ["facade: sit takes the whole wallet"], why: "facade: a sit without the table's space goes through" },
    { file: "holdem.mjs", from: "const d = id === undefined ? { ...rest, space } : { ...rest, who: id, space };", to: "const d = id === undefined ? { ...rest } : { ...rest, who: id };", run: [FAC], fails: ["facade: sit takes the whole wallet", "facade fuzz"], why: "facade: effects without the table's space" },
    { file: "holdem.mjs", from: "        if (!amount) continue;", to: "        if (amount >= 0) continue;", run: [FAC], fails: ["facade: chips earned while seated"], why: "facade: earned chips never reach the stack" },
    { file: "holdem.mjs", from: "if (fx.length === 0 && JSON.stringify(out) === JSON.stringify(st)) return { ok: true, state: st, effects: [] };", to: "", run: [FAC], fails: ["facade: refused and no-op calls"], why: "facade: a no-op tick bumps rev (a needless write + view frame)" },
    { file: "holdem.mjs", from: "        if (e.t === \"cashout\") out.push({ t: \"left\", who: id, space });", to: "", run: [FAC], fails: ["facade: sit takes the whole wallet"], why: "facade: no left after a cash-out (no prestige check)" },
    { file: "holdem.mjs", from: "        if (core.wouldDeal(staged.state, m, ctx.now)) {", to: "        if (core.wouldDeal(st, m, ctx.now)) {", run: [FAC], fails: ["facade: a busted player whose wallet earned chips"], why: "REVIEW P2: wallet chips not counted when deciding to deal" },
    { file: "holdem-table.mjs", from: "st.pots.reduce((a, p) => a + p.amount, 0)); // uncalled chips aren't pot", to: "Object.values(from).reduce((a, n) => a + n, 0));", run: [TBL], fails: ["close: the host"], why: "REVIEW P3: the biggest pot counts uncalled chips" },
    { file: "holdem.mjs", from: "        if (!r.ok) continue; //", to: "        if (!r.ok) throw new Error(\"staging refused\"); //", run: [FAC], fails: ["never blocks a timer"], why: "REVIEW P2: a refused top-up blocks the tick" },
    // the engine view the platform's contract adapter reads
    { file: "holdem-table.mjs", from: "if (h.b.street !== h.street && h.b.street !== \"done\" && h.b.street !== \"showdown\") h.last = null;", to: "", run: [TBL], fails: ["heads-up: the button posts"], why: "engine view: last action kept into a new street" },
    { file: "holdem-rank.mjs", from: "|| rv(y) - rv(x) || x - y);", to: "|| x - y);", run: [TBL], fails: ["heads-up: the button posts"], why: "engine view: best five not in significance order" },
    { file: "holdem-table.mjs", from: "if (!inHand && row.state === \"active\" && T.status !== \"closed\") row.waiting = true;", to: "if (!inHand && T.status === \"hand\") row.waiting = true;", run: [TBL], fails: ["engine view: waiting"], why: "engine view: away/out seats marked waiting, the lobby not" },
    { file: "holdem-table.mjs", from: "hv.result = { returned: { ...h.result.returned }, shown: structuredClone(h.result.shown), best:", to: "hv.result = { returned: { ...h.result.returned }, best:", run: [TBL], fails: ["engine view: a leaver's showdown cards"], why: "engine view: a leaver's shown cards lost from the result" },
    { file: "holdem-table.mjs", from: "h.last = timeout ? { seat: rec.seat, a: \"timeout\" } :", to: "h.last = timeout ? { seat: rec.seat, a: rec.a, to: rec.to } :", run: [TBL], fails: ["engine view: last action"], why: "engine view: a timer's action not shown as timeout" },
    { file: "holdem-table.mjs", from: "closeTable(T, handWasOpen ? reason : T.closing || reason, c, fx);", to: "closeTable(T, T.closing || reason, c, fx);", run: [TBL], fails: ["a void after the host's close"], why: "REVIEW: a pending close masks a restart void" },
    { file: "holdem-cards.mjs", from: "const j = randomInt(0, i + 1);", to: "const j = randomInt(0, deck.length);", run: [TBL], fails: ["shuffle"], why: "the naive (biased) shuffle" },
];

function runPlant(p) {
    const dir = mkdtempSync(join(tmpdir(), "play-holdem-plant-"));
    try {
        cpSync(join(API, "play"), join(dir, "play"), { recursive: true });
        mkdirSync(join(dir, "test"));
        for (const f of readdirSync(HERE)) if (f.startsWith("play-holdem-") && f !== "play-holdem-plants.test.mjs") cpSync(join(HERE, f), join(dir, "test", f));
        cpSync(join(HERE, "vectors/play"), join(dir, "test/vectors/play"), { recursive: true });
        const src = join(dir, "play", p.file);
        const text = readFileSync(src, "utf8");
        const hits = text.split(p.from).length - 1;
        assert.equal(hits, 1, `plant "${p.why}": its source line matches ${hits} times in ${p.file} (must be exactly 1)`);
        writeFileSync(src, text.replace(p.from, p.to));
        // a nested `node --test` that inherits NODE_TEST_CONTEXT reports to the parent runner instead of failing itself
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...p.run], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
        const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
        const ran = Number((r.stdout.match(/^# tests (\d+)$/m) || [])[1] || 0);
        assert.ok(ran >= p.run.length, `the child ran no tests (status ${r.status}): ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
        return { status: r.status, failed, ran };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the unplanted copy passes (the harness itself doesn't fail everything)", () => {
    const r = runPlant({ file: "holdem-cards.mjs", from: "export const RANKS", to: "export const RANKS", run: [V, TBL], fails: [], why: "none" });
    assert.equal(r.status, 0, `failed: ${r.failed.join(" | ")}`);
});

for (const p of PLANTS) {
    test(`plant FAILS: ${p.why}`, () => {
        const r = runPlant(p);
        assert.notEqual(r.status, 0, "the suite passed with the plant in");
        for (const want of p.fails) assert.ok(r.failed.some((n) => n.includes(want)), `expected a failing test named "${want}", got: ${r.failed.join(" | ")}`);
    });
}

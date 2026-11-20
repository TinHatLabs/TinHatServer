// Failing-first controls for The Rig (GAMES-V1-SPEC §8.1: "a planted wrong rule must FAIL"). Each mutant copies the
// engine into a temp folder, plants ONE wrong rule by replacing an exact piece of source text (which must occur
// exactly once, so the mutant is real), and runs the vector or engine tests against that copy (RIG_ENGINE_DIR). Every
// mutant must make them fail; an unmutated copy must pass (the control that the harness itself works).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../play/", import.meta.url));
const FILES = ["rig-rng.mjs", "rig-rules.mjs", "rig.mjs"];
const VECTORS = fileURLToPath(new URL("./play-rig-vectors.test.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("./play-rig-engine.test.mjs", import.meta.url));

// [name, file, find, replace, test file, test-name pattern?]
const MUTANTS = [
    // the spin order (spec §7 rig-spins "designed to fail")
    ["Skim before the multipliers", "rig-rules.mjs", "for (const after of [false, true])", "for (const after of [true, false])", VECTORS],
    ["half rounds up", "rig-rules.mjs", 'case "big-bet-tax": return bet === 3 ? Math.floor(pay / 2) : pay;', 'case "big-bet-tax": return bet === 3 ? Math.ceil(pay / 2) : pay;', VECTORS],
    ["muted cards still apply", "rig-rules.mjs", "const live = (cards) => cards.filter((c) => !c.muted);", "const live = (cards) => cards;", VECTORS],
    ["re-roll among all six symbols", "rig-rules.mjs", "return SYMBOLS.filter((s) => s !== exclude)[d];", "return SYMBOLS[d];", VECTORS],
    ["reel cards don't chain (each sees the honest reels)", "rig-rules.mjs", "reels = reelStep(c.card, reels, bet, next);", "reels = reelStep(c.card, honest, bet, next);", VECTORS],
    ["reel-card bite judged against the honest reels", "rig-rules.mjs", "if (paytableOf(reels, bet) < paytableOf(before, bet)) bit.push(c.card);", "if (paytableOf(reels, bet) < paytableOf(honest, bet)) bit.push(c.card);", VECTORS],
    ["Nudge before the reel cards", "rig-rules.mjs", "const final = applyNudge(rp.after_cards, inp.nudge);", "const final = applyNudge(inp.honest, inp.nudge);", VECTORS],
    ["Nudge doesn't wrap", "rig-rules.mjs", "r[i] = SYMBOLS[(SYMBOLS.indexOf(r[i]) + nudge.step + SYMBOLS.length) % SYMBOLS.length];", "r[i] = SYMBOLS[Math.min(5, Math.max(0, SYMBOLS.indexOf(r[i]) + nudge.step))];", VECTORS],
    ["payout cards read the reels before the Nudge", "rig-rules.mjs", "const pp = payoutPhase({ bet, spin, final, cards, history });", "const pp = payoutPhase({ bet, spin, final: rp.after_cards, cards, history });", VECTORS],
    ["a push continues a losing streak", "rig-rules.mjs", 'for (let i = history.length - 1; i >= 0 && history[i].result === "loss"; i--) n++;', 'for (let i = history.length - 1; i >= 0 && history[i].result !== "win"; i--) n++;', VECTORS],
    ["shaved wins are raked", "rig-rules.mjs", "if (payout >= bet) return { rake, bank_delta: bet - payout }; // never -0", "if (payout >= bet && !bit.length) return { rake, bank_delta: bet - payout };", VECTORS],
    ["the rake remainder goes to the Mechanics", "rig-rules.mjs", "const share = Math.floor(lost / owners.length);", "const share = Math.ceil(lost / owners.length);", VECTORS],
    ["Moon Monday on every bet", "rig-rules.mjs", 'case "moon-monday": if (bet === 1 || bet === 3) r[1] = "moon"; break;', 'case "moon-monday": r[1] = "moon"; break;', VECTORS],
    ["Even Money halves only Hat pairs", "rig-rules.mjs", '(cat === "pair-hat" || cat === "trips" || cat === "trips-hat")', '(cat === "pair-hat")', VECTORS],
    ["Cold Streak also kills Hat pairs", "rig-rules.mjs", 'case "cold-streak": return prev && prev.result === "loss" && cat === "pair" ? 0 : pay;', 'case "cold-streak": return prev && prev.result === "loss" && (cat === "pair" || cat === "pair-hat") ? 0 : pay;', VECTORS],
    // the machine rules
    ["two Taxes allowed", "rig-rules.mjs", "if (cards.filter((c) => CARDS[c].tax).length > 1)", "if (cards.filter((c) => CARDS[c].tax).length > 2)", VECTORS],
    ["a bite of exactly 6 refused", "rig-rules.mjs", "> MONEY.max_bite) return { ok: false, why: \"bite\" };", ">= MONEY.max_bite) return { ok: false, why: \"bite\" };", VECTORS],
    // Market + Peek settlement
    ["Market rounds instead of flooring", "rig-rules.mjs", "const g = Math.floor((b.stake * pool) / stakes);", "const g = Math.round((b.stake * pool) / stakes);", VECTORS],
    ["wrong Peeks don't fund the bounty", "rig-rules.mjs", "snap[m] = (balances[m] || 0) + MONEY.peek * wrong;", "snap[m] = (balances[m] || 0);", VECTORS],
    ["the bounty isn't capped by the wallet", "rig-rules.mjs", "Math.min(MONEY.peek_bounty, Math.max(0, snap[m]))", "MONEY.peek_bounty", VECTORS],
    ["Peeks settle in order (refunds received fund later bounties)", "rig-rules.mjs", "Math.min(MONEY.peek_bounty, Math.max(0, snap[m]))", "Math.min(MONEY.peek_bounty, Math.max(0, (balances[m] || 0) + delta[m]))", VECTORS],
    // the RNG (spec §7 rig-rng "designed to fail")
    ["no rejection sampling", "rig-rng.mjs", "const limit = 256 - (256 % n);", "const limit = 256;", VECTORS],
    ["wrong HMAC message (no ':')", "rig-rng.mjs", "update(`${label}:${c}`, \"utf8\")", "update(`${label}${c}`, \"utf8\")", VECTORS],
    ["the second byte instead of the first", "rig-rng.mjs", ".digest()[0];", ".digest()[1];", VECTORS],
    ["shuffle runs upwards", "rig-rng.mjs", "for (let i = xs.length - 1; i >= 1; i--) {", "for (let i = 1; i < xs.length; i++) {", VECTORS],
    ["dead cards from the bottom of the deck", "rig.mjs", "const dead = deck.slice(0, preset.dead);", "const dead = deck.slice(deck.length - preset.dead);", VECTORS],
    // the engine (round flow, money, privacy)
    ["the Spinner sees the slots (a planted leak)", "rig.mjs", "        roster: [...R.mechanics],", "        roster: [...R.mechanics], slots: R.slots,", ENGINE, "random play"],
    ["Whisper authors reach the Spinner (a planted leak)", "rig.mjs", "you.whispers = R.whispers.map((w) => ({ spin: w.spin, template: w.template, person: w.person, text: w.text }));", "you.whispers = R.whispers.map((w) => ({ who: w.who, spin: w.spin, template: w.template, person: w.person, text: w.text }));", ENGINE, "Full round"],
    ["a Mute shows in other people's views (a planted leak)", "rig.mjs", "        you.nudge_left = R.nudge_left[who] || 0;", "        you.armed_any = Object.values(R.mutes).some((m) => m.armed);\n        you.nudge_left = R.nudge_left[who] || 0;", ENGINE, "random play"],
    ["a wrong Call costs nothing", "rig.mjs", "R.bankroll -= MONEY.wrong_call;", "R.bankroll -= 0;", ENGINE, "Calls"],
    ["Walk allowed before walk_from", "rig.mjs", "if (R.spin < P.walk_from) return no(st0, \"phase\");", "", ENGINE, "Walk only"],
    ["Peeks never lock", "rig.mjs", "if (R.spin > P.peek_lock_after) return no(st0, \"locked\");", "", ENGINE, "Full round"],
    ["one timeout walks", "rig.mjs", "export const TIMEOUTS_TO_WALK = 2;", "export const TIMEOUTS_TO_WALK = 1;", ENGINE, "Walk only"],
    ["the disconnect budget refills on reconnect", "rig.mjs", "            A.used += gone;\n", "", ENGINE, "disconnect"],
    ["stakes of busted Mechanics returned too", "rig.mjs", "for (const s of R.slots) if (s.busted_spin == null) pay(s.owner, s.stake, \"rig:stake\");", "for (const s of R.slots) pay(s.owner, s.stake, \"rig:stake\");", ENGINE, "random play|Calls|Full round"],
    ["Peek snapshot ignores the wallet", "rig.mjs", "snap[p.target] = b + (payouts[p.target] || 0);", "snap[p.target] = 3;", ENGINE, "Peek bounty"],
    ["round 1 isn't forced to Lite", "rig.mjs", "const preset = firstOfRun || st.seats.length === PLAYERS.min ? PRESETS.lite : PRESETS[st.opts.preset];", "const preset = st.seats.length === PLAYERS.min ? PRESETS.lite : PRESETS[st.opts.preset];", ENGINE, "lobby"],
    ["join ignores the table's space", "rig.mjs", 'if (a.space !== st.space) return no(st0, "space-changed");', "", ENGINE, "spec rev 2"],
    ["the admission check is ignored", "rig.mjs", 'if (st.closing || ctx.admitted === false) return closeTable(st, effects, st.closing || "space-changed", ctx.now);', "", ENGINE, "spec rev 2"],
    ["one shared version for everyone (a timing leak)", "rig.mjs", "vseq: st.vs[key].v, now", "vseq: st.rev, now", ENGINE, "versions are per person|random play"],
    ["a move after a due deadline is accepted", "rig.mjs", 'if (late) return no(st0, "stale");', "", ENGINE, "missed deadline"],
    ["a leaving Spinner's landing spin is dropped", "rig.mjs", 'if (R.pending) R.force = "left";', "if (false) R.force = 0;", ENGINE, "while the reels land"],
    ["a leaving Spinner skips the Nudge window", "rig.mjs", 'if (R.pending) R.force = "left";', 'if (R.pending) { R.force = "left"; doPayout(st, ctx, effects); }', ENGINE, "dodge the House"],
    ["an emptied table closes before its spin settles", "rig.mjs", 'if (st.status === "round" && R && R.phase !== "reveal") st.closing = "empty";', 'if (false) st.closing = "empty";', ENGINE, "dodge the House"],
    ["a new version starts above everyone's (a leak)", "rig.mjs", "v: u === SPECTATOR ? 1 : st.vs[SPECTATOR].v + 1", "v: Math.max(0, ...Object.values(st.vs).map((x) => x.v)) + 1", ENGINE, "newly seated"],
    ["a missing balance counts as 0", "rig.mjs", "if (!Number.isInteger(b) || b < 0) throw", "if (false) throw", ENGINE, "never guesses"],
    ["the roster cap ignores this round's leavers", "rig.mjs", 'if (!roster.has(who) && roster.size >= PLAYERS.max) return no(st0, "table-full");', "", ENGINE, "review 4"],
    ["a start nobody can fund", "rig.mjs", 'if (!st.seats.some((u) => (ctx.balances?.[u] ?? 0) >= MONEY.bankroll_min)) return no(st0, "no-chips");', "", ENGINE, "review 4"],
    ["a leaver keeps their private view", "rig.mjs", 'if (R.left.includes(who)) you.role = "left";', "if (false) {}", ENGINE, "review 4"],
    ["Railbirds can bet the Market", "rig.mjs", "if (spinner || !R.house.includes(who) || isRailbird(R, who)) return no(st0, \"not-your-turn\");", "if (spinner || !R.house.includes(who)) return no(st0, \"not-your-turn\");", ENGINE, "Railbirds"],
];

function run(testFile, mutate, pattern) {
    const dir = mkdtempSync(join(tmpdir(), "games-rig-mut-"));
    try {
        for (const f of FILES) writeFileSync(join(dir, f), readFileSync(join(SRC, f), "utf8"));
        if (mutate) {
            const [file, find, replace] = mutate;
            const text = readFileSync(join(dir, file), "utf8");
            const count = text.split(find).length - 1;
            assert.equal(count, 1, `the planted text must occur exactly once in ${file}: ${find}`);
            writeFileSync(join(dir, file), text.replace(find, () => replace));
        }
        const args = ["--test", "--test-reporter=tap"];
        if (pattern) args.push(`--test-name-pattern=${pattern}`);
        // NODE_TEST_CONTEXT must not leak in from this runner, or the child reports to it and runs nothing
        const env = { ...process.env, RIG_ENGINE_DIR: dir };
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, [...args, testFile], { env, encoding: "utf8", timeout: 120_000 });
        const num = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? NaN);
        return { status: r.status, pass: num("pass"), fail: num("fail") };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("control: an unmutated copy passes the vectors and the engine tests", () => {
    for (const f of [VECTORS, ENGINE]) {
        const r = run(f, null);
        assert.equal(r.status, 0, f);
        assert.ok(r.pass >= 6 && r.fail === 0, `${f}: ${r.pass} passed, ${r.fail} failed`);
    }
});

for (const [name, file, find, replace, testFile, pattern] of MUTANTS) {
    test(`planted wrong rule FAILS: ${name}`, () => {
        const r = run(testFile, [file, find, replace], pattern);
        assert.ok(r.fail >= 1 && r.status !== 0, `${name}: the tests still passed (${r.pass} passed, ${r.fail} failed)`);
    });
}

// The contract fixtures: one god state per phase of each game, projected for every viewer through views.mjs (the
// same code the server uses). build.mjs writes them to vectors/views/{holdem,rig}/NN-step.json; the mock server plays
// them as scenarios (moves + next). Numbers are consistent within a step and from step to step where a story runs,
// but these are VIEW SHAPES, not rule vectors: the rules' truth is vectors/holdem-*.json and vectors/rig-*.json.
import { holdemView, rigView } from "../views.mjs";

export const ROOM = "!games:example.org";
export const SPACE = "!hangout:example.org"; // the room's game space (§1.1)
export const OWNER = "example.org"; // the server that sent the space's m.room.create
export const HOLDEM_TABLE = "tH3k9aB2cD4eF6gH";
export const RIG_TABLE = "tR7q2wE4rT6yU8iO";
export const NOW = 1763600000000; // a fixed clock; the mock shifts every time field to its own clock
const P = { ana: "@ana:example.org", ben: "@ben:example.org", cy: "@cy:example.org", dee: "@dee:example.net", eli: "@eli:example.org", gus: "@gus:example.org", fay: "@fay:example.org" };
export const PEOPLE = P;
const S = (sec) => NOW + sec * 1000;

// ------------------------------------------------------------------------------------------------ Hold'em
const hBase = (over) => ({
    game: "holdem", table: HOLDEM_TABLE, room: ROOM, space: SPACE, owner: OWNER, now: NOW, host: P.ana, opts: { sb: 1, bb: 2, seats: 8, turn_s: 30 },
    spectators: 1, closed: null, result: null, hand: null, ...over,
});
// v1.1 (B3): every seat / Rig player carries the person's prestige rank in the table's space (ana is rank 1: cap 150)
const RANK = (u) => (u === P.ana ? 1 : 0);
const seat = (n, u, stack, bet, state, hole, extra = {}) => ({ seat: n, u, stack, bet, state, hole, connected: true, screens: ["desktop"], timeouts: 0, holdings: stack + bet, cap: 100, at_cap: false, rank: RANK(u), ...extra });
const HOLES = { ana: ["As", "Kd"], ben: ["9h", "9c"], dee: ["Qs", "Jc"] };

const BET = (to) => ({ fold: to, check: to, call: to, raise: to, allin: to });
function holdemSteps() {
    const steps = [];
    // perspectives: the three seated players and one spectator
    const persp = { seat1: P.ana, seat4: P.ben, seat6: P.dee, spectator: P.cy };
    const add = (id, about, g, moves, next) => steps.push({ id, about, g, persp, moves, next });

    add("01-lobby", "Table open, nobody dealt yet. The host (seat 1) sees Deal; cy is watching (spectator).",
        hBase({ status: "lobby", vseq: 1, can_deal: true, seats: [
            seat(1, P.ana, 40, 0, "waiting", [], { cap: 150, holdings: 40 }),
            seat(4, P.ben, 30, 0, "waiting", [], { screens: ["web"] }),
            seat(6, P.dee, 20, 0, "waiting", [], { screens: ["desktop", "pad"] }),
        ] }),
        { seat1: ["deal", "leave", "away", "kick", "close"], seat4: ["leave", "away"], seat6: ["leave", "away"], spectator: ["sit"] },
        { deal: "02-preflop", sit: "01-lobby" });

    add("02-preflop", "Hand 1. Button seat 6, small blind seat 1, big blind seat 4. Seat 6 is first to act (3-handed: the button).",
        hBase({ status: "hand", vseq: 2, seats: [
            seat(1, P.ana, 39, 1, "active", HOLES.ana, { cap: 150, holdings: 40 }),
            seat(4, P.ben, 28, 2, "active", HOLES.ben, { screens: ["web"], holdings: 30 }),
            seat(6, P.dee, 20, 0, "active", HOLES.dee, { screens: ["desktop", "pad"], holdings: 20 }),
        ], hand: { n: 1, button: 6, sb: 1, bb: 4, street: "preflop", board: [], pots: [], total: 3,
            to_act: { seat: 6, turn: 1, deadline: S(30) }, last: { seat: 4, a: "bb", to: 2 },
            legal: { fold: true, check: false, call: 2, raise: { min: 4, max: 20 } } } }),
        { seat6: ["fold", "call", "raise", "allin", "leave", "away"], seat1: ["leave", "away", "close"], seat4: ["leave", "away"], spectator: [] },
        BET("03-preflop-raised"));

    add("03-preflop-raised", "Seat 6 raised to 6. Seat 1 (small blind, 1 in) may call 5 or raise to 10..40.",
        hBase({ status: "hand", vseq: 3, seats: [
            seat(1, P.ana, 39, 1, "active", HOLES.ana, { cap: 150, holdings: 40 }),
            seat(4, P.ben, 28, 2, "active", HOLES.ben, { screens: ["web"], holdings: 30 }),
            seat(6, P.dee, 14, 6, "active", HOLES.dee, { screens: ["desktop", "pad"], holdings: 20 }),
        ], hand: { n: 1, button: 6, sb: 1, bb: 4, street: "preflop", board: [], pots: [], total: 9,
            to_act: { seat: 1, turn: 2, deadline: S(30) }, last: { seat: 6, a: "raise", to: 6 },
            legal: { fold: true, check: false, call: 5, raise: { min: 10, max: 40 } } } }),
        { seat1: ["fold", "call", "raise", "allin", "leave", "away", "close"], seat4: ["leave", "away"], seat6: ["leave", "away"], spectator: [] },
        BET("04-flop"));

    add("04-flop", "Everyone called 6. Flop dealt; the pot is 18; seat 1 acts first after the button and may check.",
        hBase({ status: "hand", vseq: 6, seats: [
            seat(1, P.ana, 34, 0, "active", HOLES.ana, { cap: 150, holdings: 40 }),
            seat(4, P.ben, 24, 0, "active", HOLES.ben, { screens: ["web"], holdings: 30 }),
            seat(6, P.dee, 14, 0, "active", HOLES.dee, { screens: ["desktop", "pad"], holdings: 20 }),
        ], hand: { n: 1, button: 6, sb: 1, bb: 4, street: "flop", board: ["2c", "9d", "Ts"], pots: [{ amount: 18, eligible: [1, 4, 6] }], total: 18,
            to_act: { seat: 1, turn: 5, deadline: S(30) }, last: null,
            legal: { fold: true, check: true, call: 0, raise: { min: 2, max: 34 } } } }),
        { seat1: ["fold", "check", "raise", "allin", "leave", "away", "close"], seat4: ["leave", "away"], seat6: ["leave", "away"], spectator: [] },
        BET("05-turn-short-allin"));

    add("05-turn-short-allin", "Flop checked round. Turn: seat 1 bet 10, seat 4 called. Seat 6 has 14: call 10, or all-in to 14 (short of a full raise: offered as raise min = max = 14).",
        hBase({ status: "hand", vseq: 11, seats: [
            seat(1, P.ana, 24, 10, "active", HOLES.ana, { cap: 150, holdings: 40 }),
            seat(4, P.ben, 14, 10, "active", HOLES.ben, { screens: ["web"], holdings: 30 }),
            seat(6, P.dee, 14, 0, "active", HOLES.dee, { screens: ["desktop", "pad"], holdings: 20 }),
        ], hand: { n: 1, button: 6, sb: 1, bb: 4, street: "turn", board: ["2c", "9d", "Ts", "Kh"], pots: [{ amount: 18, eligible: [1, 4, 6] }], total: 38,
            to_act: { seat: 6, turn: 10, deadline: S(30) }, last: { seat: 4, a: "call", to: 10 },
            legal: { fold: true, check: false, call: 10, raise: { min: 14, max: 14 } } } }),
        { seat6: ["fold", "call", "raise", "allin", "leave", "away"], seat1: ["leave", "away", "close"], seat4: ["leave", "away"], spectator: [] },
        BET("06-showdown"));

    add("06-showdown", "Seat 6 went all-in (14), both called; river checked. Showdown: every hand still in is shown; seat 6's straight takes the 60 pot. The next hand starts at result.next_at.",
        hBase({ status: "pause", vseq: 17, seats: [
            seat(1, P.ana, 20, 0, "active", HOLES.ana, { cap: 150, holdings: 20 }),
            seat(4, P.ben, 10, 0, "active", HOLES.ben, { screens: ["web"], holdings: 10 }),
            seat(6, P.dee, 60, 0, "allin", HOLES.dee, { screens: ["desktop", "pad"], holdings: 60 }),
        ], hand: { n: 1, button: 6, sb: 1, bb: 4, street: "showdown", board: ["2c", "9d", "Ts", "Kh", "5s"], pots: [], total: 0,
            to_act: null, last: { seat: 4, a: "check" }, legal: null, show: [1, 4, 6] },
        result: { n: 1, board: ["2c", "9d", "Ts", "Kh", "5s"],
            pots: [{ amount: 60, eligible: [1, 4, 6], winners: [6], paid: { 6: 60 } }], returned: {},
            shown: { 1: HOLES.ana, 4: HOLES.ben, 6: HOLES.dee },
            best: { 1: { category: "pair", five: ["Kd", "Kh", "As", "Ts", "9d"] }, 4: { category: "trips", five: ["9h", "9c", "9d", "Kh", "Ts"] }, 6: { category: "straight", five: ["Kh", "Qs", "Jc", "Ts", "9d"] } },
            net: { [P.ana]: -20, [P.ben]: -20, [P.dee]: 40 }, voided: false, next_at: S(5) } }),
        { seat1: ["leave", "away", "kick", "close"], seat4: ["leave", "away"], seat6: ["leave", "away"], spectator: ["sit"] },
        {});

    add("07-headsup-leaving", "Hand 2, heads-up: seat 4 timed out once and is away (dealt out; v1.1: stands up after 5 more dealt-out hands or at stand_at), eli (seat 8) is out of chips, seat 6 pressed Leave (their hand folds when the action reaches them). Seat 1 is the button = small blind and acts first preflop.",
        hBase({ status: "hand", vseq: 21, seats: [
            seat(1, P.ana, 19, 1, "active", ["7d", "7s"], { cap: 150, holdings: 20 }),
            seat(4, P.ben, 10, 0, "away", [], { screens: ["web"], holdings: 10, timeouts: 1, connected: false, away: { reason: "timeout", since: S(-40), stand_at: S(-40) + 600_000, hands_left: 5 } }),
            seat(6, P.dee, 58, 2, "leaving", ["Ah", "3h"], { screens: ["desktop", "pad"], holdings: 60 }),
            seat(8, P.eli, 0, 0, "out", [], { holdings: 0 }),
        ], hand: { n: 2, button: 1, sb: 1, bb: 6, street: "preflop", board: [], pots: [], total: 3,
            to_act: { seat: 1, turn: 1, deadline: S(30) }, last: { seat: 6, a: "bb", to: 2 },
            legal: { fold: true, check: false, call: 1, raise: { min: 4, max: 20 } } } }),
        { seat1: ["fold", "call", "raise", "allin", "leave", "away", "close"], seat4: ["away", "leave"], seat6: ["leave"], spectator: [] },
        BET("08-voided-restart"));

    add("08-voided-restart", "The API restarted mid-hand: hand 2 was called off (everyone's chips in it went back), the table closed and everyone was cashed out. Apps say: \"The dealer restarted: that hand was called off and everyone's chips went back.\"",
        hBase({ status: "closed", vseq: 22, seats: [], spectators: 0,
            result: { n: 2, board: [], pots: [], returned: {}, shown: {}, best: {}, net: {}, voided: true, next_at: null },
            closed: { reason: "restart", at: S(0) } }),
        { seat1: [], seat4: [], seat6: [], spectator: [] }, {});

    add("09-closed-host", "The host closed the table after a hand (also: idle 10 min, no call 5 min, games turned off). The summary card is drawn from GET /tables/{id}/summary.",
        hBase({ status: "closed", vseq: 30, seats: [], spectators: 0, closed: { reason: "host", at: S(0) } }),
        { seat1: [], seat4: [], seat6: [], spectator: [] }, {});
    return steps;
}

// ------------------------------------------------------------------------------------------------ The Rig
const FULL_DECK = ["moon-monday", "lizard-lane", "hat-thief", "twos-company", "big-bet-tax", "penny-pincher", "cold-streak", "skim", "moon-tax", "shy-hat", "lizard-tax", "underdog", "rebound", "hot-hat", "slow-start", "even-money"];
const LITE_DECK = ["moon-monday", "lizard-lane", "big-bet-tax", "penny-pincher", "cold-streak", "skim", "moon-tax", "lizard-tax", "underdog", "rebound"];
const COMMIT = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const board = (deck, states) => deck.map((card) => ({ card, state: "open", ...(states[card] || {}) }));
const pl = (u, order, role, extra = {}) => ({ u, order, role, connected: true, left: false, spun: false, holdings: 20, at_cap: false, screens: ["desktop"], timeouts: 0, rank: RANK(u), ...extra });
const rBase = (over) => ({
    game: "rig", table: RIG_TABLE, room: ROOM, space: SPACE, owner: OWNER, now: NOW, host: P.ana, opts: { preset: "lite", bankroll: 6, patch: true },
    spectators: 1, closed: null, end: null, round: null, ...over,
});
const roundBase = (over) => ({
    spin: 0, deadline: S(20), seed_commit: COMMIT, bankroll: { start: 6, now: 6 }, net: 0, dial: 1, bet: null, call_used_this_spin: false, audit_used: false,
    peeks_locked: false, refilled: [], history: [], reels: null, nudge: null, waiting_on: 0, paused: null, whispers: [], ...over,
});
const LITE = { preset: "lite", spins: 8, calls_left: 2, walk_from: 5, peek_lock_after: 3, features: { mutes: false, nudge: false, whisper: false, patch: false } };
const FULL = { preset: "full", spins: 10, calls_left: 3, walk_from: 6, peek_lock_after: 4, features: { mutes: true, nudge: true, whisper: true, patch: true } };
const peek0 = (n) => ({ placed: false, locks_after: n });

function rigSteps() {
    const steps = [];
    const persp = { ana: P.ana, ben: P.ben, cy: P.cy, dee: P.dee, eli: P.eli, gus: P.gus, spectator: P.fay };
    const add = (id, about, g, moves, next) => steps.push({ id, about, g, persp, moves, next });
    const lobbyPlayers = () => [pl(P.ana, 1, null, { holdings: 40 }), pl(P.ben, 2, null), pl(P.cy, 3, null, { screens: ["web"] }),
        pl(P.dee, 4, null, { screens: ["desktop", "pad"] }), pl(P.eli, 5, null), pl(P.gus, 6, null, { holdings: 0 })];

    add("01-lobby", "6 players joined (gus has 0 chips: he'll be a Railbird). The host picks the options and presses Start; fay is watching.",
        rBase({ status: "lobby", vseq: 1, players: lobbyPlayers() }),
        { ana: ["start", "leave", "kick", "close"], ben: ["leave"], cy: ["leave"], dee: ["leave"], eli: ["leave"], gus: ["leave"], spectator: ["join"] },
        { start: "02-setup-lite" });

    // Round 1, Lite (a table's first round): ana spins; 2 Mechanics (ben, cy); Sharps dee, eli; Railbird gus.
    const deadLite = ["lizard-lane", "big-bet-tax", "moon-tax", "lizard-tax"];
    const r1players = (extra = {}) => [
        pl(P.ana, 1, "spinner", { holdings: 40 }),
        pl(P.ben, 2, "mechanic", { holdings: 17, deal: ["moon-monday", "skim"], kept: false, card: null, busted: false, patch: null, mutes_left: 0, armed: false, rake: 0, nudge_left: 0, whisper_used: false, peek: peek0(3), market: null, market_done: false, ...(extra.ben || {}) }),
        pl(P.cy, 3, "mechanic", { holdings: 17, screens: ["web"], deal: ["penny-pincher", "rebound"], kept: false, card: null, busted: false, patch: null, mutes_left: 0, armed: false, rake: 0, nudge_left: 0, whisper_used: false, peek: peek0(3), market: null, market_done: false, ...(extra.cy || {}) }),
        pl(P.dee, 4, "sharp", { screens: ["desktop", "pad"], nudge_left: 0, whisper_used: false, peek: peek0(3), market: null, market_done: false, ...(extra.dee || {}) }),
        pl(P.eli, 5, "sharp", { nudge_left: 0, whisper_used: false, peek: peek0(3), market: null, market_done: false, ...(extra.eli || {}) }),
        pl(P.gus, 6, "railbird", { holdings: 0, nudge_left: 0, whisper_used: false }),
    ];
    add("02-setup-lite", "Round 1 (Lite). SETUP 20 s: dead cards shown, each Mechanic picks one of their two dealt cards, the House places Market bets. Ends early when everyone's done.",
        rBase({ status: "round", vseq: 2, players: r1players(), round: roundBase({
            r: 1, spinner: P.ana, phase: "setup", ...LITE, board: board(LITE_DECK, Object.fromEntries(deadLite.map((c) => [c, { state: "dead" }]))),
            dead: deadLite, mechanics: 2, waiting_on: 4 }) }),
        { ana: ["leave"], ben: ["keep", "market", "leave"], cy: ["keep", "market", "leave"], dee: ["market", "leave"], eli: ["market", "leave"], gus: ["leave"], spectator: [] },
        {});

    const r1after = { ben: { kept: true, card: { card: "skim", bite: 2 }, market: null, market_done: true, rake: 0 },
        cy: { kept: true, card: { card: "rebound", bite: 2 }, market: { side: "not-up", stake: 1 }, market_done: true },
        dee: { market: { side: "up", stake: 2 }, market_done: true }, eli: { market: null, market_done: true } };
    add("03-turn-lite", "Round 1, TURN spin 3: two spins done (a loss, then a pair doubled and skimmed). The Spinner dials 1-3 and spins, or Calls a card, or Audits.",
        rBase({ status: "round", vseq: 9, players: r1players(r1after), round: roundBase({
            r: 1, spinner: P.ana, phase: "turn", ...LITE, spin: 3, deadline: S(20), dial: 2, bankroll: { start: 6, now: 6 }, net: 0,
            board: board(LITE_DECK, Object.fromEntries(deadLite.map((c) => [c, { state: "dead" }]))), dead: deadLite, mechanics: 2,
            history: [
                { spin: 1, bet: 1, reels: ["eye", "moon", "dish"], payout: 0, result: "loss", stamps: [] },
                { spin: 2, bet: 2, reels: ["dish", "dish", "eye"], payout: 3, result: "win", stamps: [] },
            ] }) }),
        { ana: ["dial", "spin", "call", "audit", "leave"], ben: ["peek", "leave"], cy: ["peek", "leave"], dee: ["peek", "leave"], eli: ["peek", "leave"], gus: ["leave"], spectator: [] },
        { spin: "04-turn-full" });

    // Round 2, Full: ben spins; Mechanics cy, dee, eli (rotation); Sharp ana; Railbird gus. One consistent story,
    // worked through the normative rules (§5.0), slots 1 moon-monday (dee), 2 rebound → cold-streak (cy), 3 even-money (eli):
    //  spin 1 bet 1: honest eye-dish-dish (pair, 1) → Moon Monday makes reel 2 a Moon: 0, loss; rake 1 → dee. Bankroll 5.
    //  spin 2 bet 2: honest dish-dish-dish (trips, 16); cy nudged reel 3 dish → eye: a pair (2); Rebound (1 loss before) × 2 = 4;
    //               Even Money (bet 2, pair) × 2 = 8: a win paid by the bank. Bankroll 11.
    //  before spin 3: a right Call on rebound (cy's 3 stake → the bankroll: 14); cy Patches cold-streak into slot 2 (live from 3).
    //  spin 3 bet 2: hat-eye-hat (Hat pair, 8): 8, a win. Bankroll 20.
    //  before spin 4: a wrong Call on hot-hat (2 from the bankroll over 3 live Mechanics: 0 each, 2 to the bank). Bankroll 18.
    //  spin 4 bet 2: saucer-lizard-moon: 0, a loss, nothing bit (the bet to the bank). Bankroll 16.
    //  spin 5 bet 2 (dee's Mute spent): eye-eye-moon (pair, 2); ana nudged reel 3 moon → lizard (still a pair, 2);
    //               Cold Streak (after a loss, a pair) → 0: a loss, rake 2 → cy. Bankroll 14 = start 6 + 8: UP.
    //  spin 6: the Spinner Walks. Market: ana UP 1 (back 1 + 2 = 3), dee NOT UP 2 (lost). Peeks: ana on dee/moon-monday right
    //  (bounty 3), eli on cy/underdog wrong (2 → cy). Net: ben +8, ana +5, cy +1, dee −4, eli −2, gus 0, the bank −8 (Σ = 0).
    const deadFull = ["skim", "hat-thief", "lizard-tax"];
    const fullBoard = board(FULL_DECK, { ...Object.fromEntries(deadFull.map((c) => [c, { state: "dead" }])),
        "rebound": { state: "busted", by: P.cy, spin: 3 }, "hot-hat": { state: "wrong" } });
    const r2players = (extra = {}) => [
        pl(P.ana, 1, "sharp", { holdings: 38, spun: true, nudge_left: 1, whisper_used: true, peek: { placed: true, mechanic: P.dee, card: "moon-monday", locks_after: 4 }, market: { side: "up", stake: 1 }, market_done: true, ...(extra.ana || {}) }),
        pl(P.ben, 2, "spinner", { holdings: 17, ...(extra.ben || {}) }),
        pl(P.cy, 3, "mechanic", { holdings: 14, screens: ["web"], kept: true, card: { card: "cold-streak", bite: 2 }, busted: false, patch: null, mutes_left: 2, armed: false, rake: 0, call_shares: 0, nudge_left: 0, whisper_used: false, peek: peek0(4), market: null, market_done: true, ...(extra.cy || {}) }),
        pl(P.dee, 4, "mechanic", { holdings: 15, screens: ["desktop", "pad"], kept: true, card: { card: "moon-monday", bite: 2 }, busted: false, patch: null, mutes_left: 2, armed: true, rake: 1, call_shares: 0, nudge_left: 1, whisper_used: true, peek: peek0(4), market: { side: "not-up", stake: 2 }, market_done: true, ...(extra.dee || {}) }),
        pl(P.eli, 5, "mechanic", { holdings: 16, kept: true, card: { card: "even-money", bite: 2 }, busted: false, patch: null, mutes_left: 2, armed: false, rake: 0, call_shares: 0, nudge_left: 1, whisper_used: false, peek: { placed: true, mechanic: P.cy, card: "underdog", locks_after: 4 }, market: null, market_done: true, ...(extra.eli || {}) }),
        pl(P.gus, 6, "railbird", { holdings: 0, nudge_left: 1, whisper_used: false, ...(extra.gus || {}) }),
    ];
    const r2hist = [
        { spin: 1, bet: 1, reels: ["eye", "moon", "dish"], payout: 0, result: "loss", stamps: [] },
        { spin: 2, bet: 2, reels: ["dish", "dish", "eye"], payout: 8, result: "win", stamps: ["nudged"] },
        { spin: 3, bet: 2, reels: ["hat", "eye", "hat"], payout: 8, result: "win", stamps: ["called-right", "refilled"] },
        { spin: 4, bet: 2, reels: ["saucer", "lizard", "moon"], payout: 0, result: "loss", stamps: ["called-wrong"] },
    ];
    const spin5 = { spin: 5, bet: 2, reels: ["eye", "eye", "lizard"], payout: 0, result: "loss", stamps: ["nudged"] };
    const r2round = (over) => roundBase({
        r: 2, spinner: P.ben, ...FULL, calls_left: 1, spin: 5, deadline: S(20), dial: 2, bankroll: { start: 6, now: 16 }, net: 10,
        board: fullBoard, dead: deadFull, mechanics: 3, refilled: [{ spin: 3 }], history: r2hist, peeks_locked: true,
        whispers: [{ who: P.ana, spin: 2, template: "bet-size" }, { who: P.dee, spin: 4, text: "watch the lizard" }], ...over,
    });
    const afterSpin5 = { dee: { armed: false, mutes_left: 1 }, cy: { rake: 2 } };
    const TURN5 = { ben: ["dial", "spin", "call", "audit", "leave"], cy: ["mute", "whisper", "leave"], dee: ["mute", "leave"], eli: ["mute", "whisper", "leave"], ana: ["whisper", "leave"], gus: ["whisper", "leave"], spectator: [] };
    add("04-turn-full", "Round 2 (Full), TURN spin 5. Before spin 3 a right Call busted rebound (cy patched cold-streak into its slot: \"slot refilled on spin 3\"); before spin 4 a Call on hot-hat was wrong. Peeks are locked (after spin 4). The Spinner sees two anonymous Whispers; dee has a Mute armed.",
        rBase({ status: "round", vseq: 40, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players(), round: r2round({ phase: "turn", call_used_this_spin: false }) }),
        TURN5, { audit: "05-turn-audit", spin: "06-land" });

    add("05-turn-audit", "Same turn after the Spinner Audited spin 2: only the Spinner's view has round.audit (honest reels + payout beside the real ones, how many cards touched it); everyone sees the 'audited' stamp.",
        rBase({ status: "round", vseq: 41, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players(), round: r2round({ phase: "turn", audit_used: true,
            history: r2hist.map((h) => (h.spin === 2 ? { ...h, stamps: ["nudged", "audited"] } : h)),
            audit: { spin: 2, honest_reels: ["dish", "dish", "dish"], honest_payout: 16, touched: 2 } }) }),
        { ...TURN5, ben: ["dial", "spin", "call", "leave"] }, { spin: "06-land" });

    add("06-land", "SPIN taken at bet 2 (dee's armed Mute was spent, invisibly). LAND 2 s: the reels after the cards are shown.",
        rBase({ status: "round", vseq: 43, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players({ dee: afterSpin5.dee }), round: r2round({ phase: "land", deadline: S(2), bet: 2, bankroll: { start: 6, now: 14 }, net: 8, reels: ["eye", "eye", "moon"] }) }),
        { ben: ["leave"], cy: ["leave"], dee: ["leave"], eli: ["leave"], ana: ["leave"], gus: ["leave"], spectator: [] }, {});

    add("07-nudge-open", "NUDGE 4 s (Full): any House member with a Nudge left may bump one reel one step; the first tap the server receives wins, then the window closes.",
        rBase({ status: "round", vseq: 44, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players({ dee: afterSpin5.dee }), round: r2round({ phase: "nudge", deadline: S(4), bet: 2, bankroll: { start: 6, now: 14 }, net: 8, reels: ["eye", "eye", "moon"], nudge: { open: true, deadline: S(4) } }) }),
        { ana: ["nudge", "leave"], dee: ["nudge", "leave"], eli: ["nudge", "leave"], gus: ["nudge", "leave"], ben: ["leave"], cy: ["leave"], spectator: [] },
        { nudge: "08-payout" });

    add("08-payout", "PAYOUT: someone nudged reel 3 up one step (moon → lizard; still a pair), then Cold Streak (after a loss, a pair) paid 0: a loss, raked to its card. The spin joins the history stamped 'nudged' (never who).",
        rBase({ status: "round", vseq: 46, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players({ ...afterSpin5, ana: { nudge_left: 0 } }), round: r2round({ phase: "payout", deadline: null, bet: 2, bankroll: { start: 6, now: 14 }, net: 8,
            reels: ["eye", "eye", "lizard"], nudge: { open: false, deadline: null, reel: 3, step: 1 }, history: [...r2hist, spin5] }) }),
        { ben: ["leave"], cy: ["leave"], dee: ["leave"], eli: ["leave"], ana: ["leave"], gus: ["leave"], spectator: [] }, {});

    const hist6 = [...r2hist, spin5];
    add("09-paused", "TURN spin 6 with the Spinner disconnected: the clock is paused and spends the round's 45 s budget (budget_ms left); at 0 the round Walks.",
        rBase({ status: "round", vseq: 47, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players({ ...afterSpin5, ana: { nudge_left: 0 }, ben: { connected: false } }), round: r2round({ phase: "turn", spin: 6, deadline: null, bankroll: { start: 6, now: 14 }, net: 8, history: hist6, paused: { budget_ms: 31000 } }) }),
        { ben: ["dial", "spin", "call", "audit", "walk", "leave"], cy: ["mute", "whisper", "leave"], dee: ["mute", "leave"], eli: ["mute", "whisper", "leave"], ana: ["whisper", "leave"], gus: ["whisper", "leave"], spectator: [] },
        { walk: "10-reveal", spin: "10-reveal" });

    add("10-reveal", "The Spinner Walked at spin 6. REVEAL 20 s (sent only after the settlement committed): every card with its owner and slot, Mutes, Nudges, Calls, Peeks, Market, Whispers with authors, every spin's honest vs final reels, the seed, everyone's net (Σ net + the bank = 0).",
        rBase({ status: "round", vseq: 52, opts: { preset: "full", bankroll: 6, patch: true }, players: r2players({ ...afterSpin5, ana: { nudge_left: 0 }, ben: { spun: true, holdings: 25 } }), round: r2round({ phase: "reveal", spin: 6, deadline: S(20), bankroll: { start: 6, now: 14 }, net: 8, history: hist6,
            reveal: {
                seed: SEED,
                slots: [{ slot: 1, card: "moon-monday", owner: P.dee, from_spin: 1 }, { slot: 2, card: "rebound", owner: P.cy, from_spin: 1 }, { slot: 2, card: "cold-streak", owner: P.cy, from_spin: 3 }, { slot: 3, card: "even-money", owner: P.eli, from_spin: 1 }],
                mutes: [{ spin: 5, owner: P.dee }],
                nudges: [{ spin: 2, by: P.cy, reel: 3, step: 1 }, { spin: 5, by: P.ana, reel: 3, step: 1 }],
                calls: [{ spin: 3, card: "rebound", right: true, owner: P.cy }, { spin: 4, card: "hot-hat", right: false, owner: null }],
                peeks: [{ who: P.ana, target: P.dee, card: "moon-monday", right: true, delta: 3 }, { who: P.eli, target: P.cy, card: "underdog", right: false, delta: -2 }],
                market: [{ who: P.ana, side: "up", stake: 1, back: 3 }, { who: P.dee, side: "not-up", stake: 2, back: 0 }],
                whispers: [{ who: P.ana, spin: 2, template: "bet-size" }, { who: P.dee, spin: 4, text: "watch the lizard" }],
                spins: [
                    { spin: 1, bet: 1, honest: ["eye", "dish", "dish"], after_cards: ["eye", "moon", "dish"], final: ["eye", "moon", "dish"], honest_payout: 1, payout: 0, touched: ["moon-monday"], bit: ["moon-monday"], rake: { "moon-monday": 1 } },
                    { spin: 2, bet: 2, honest: ["dish", "dish", "dish"], after_cards: ["dish", "dish", "dish"], final: ["dish", "dish", "eye"], honest_payout: 16, payout: 8, touched: ["rebound", "even-money"], bit: [], rake: {} },
                    { spin: 3, bet: 2, honest: ["hat", "eye", "hat"], after_cards: ["hat", "eye", "hat"], final: ["hat", "eye", "hat"], honest_payout: 8, payout: 8, touched: [], bit: [], rake: {} },
                    { spin: 4, bet: 2, honest: ["saucer", "lizard", "moon"], after_cards: ["saucer", "lizard", "moon"], final: ["saucer", "lizard", "moon"], honest_payout: 0, payout: 0, touched: [], bit: [], rake: {} },
                    { spin: 5, bet: 2, honest: ["eye", "eye", "moon"], after_cards: ["eye", "eye", "moon"], final: ["eye", "eye", "lizard"], honest_payout: 2, payout: 0, touched: ["cold-streak"], bit: ["cold-streak"], rake: { "cold-streak": 2 } },
                ],
                up: true,
                net: { [P.ben]: 8, [P.ana]: 5, [P.cy]: 1, [P.dee]: -4, [P.eli]: -2, [P.gus]: 0 },
            } }) }),
        { ana: ["leave"], ben: ["leave"], cy: ["leave"], dee: ["leave"], eli: ["leave"], gus: ["leave"], spectator: [] }, {});

    add("11-end", "TABLE END: everyone with the chips to spin has spun once (gus was skipped: not enough chips). The House leaderboard (Spinner rounds excluded) and the Pit Boss (in-game badge only). The host opens another table or closes.",
        rBase({ status: "end", vseq: 90, opts: { preset: "full", bankroll: 6, patch: true }, players: lobbyPlayers().map((p) => ({ ...p, spun: p.u !== P.gus, skipped: p.u === P.gus })),
            end: { rounds: 5, leaderboard: [{ u: P.ana, net: 9 }, { u: P.eli, net: 4 }, { u: P.cy, net: -1 }, { u: P.dee, net: -5 }, { u: P.ben, net: -6 }, { u: P.gus, net: 0 }], pit_boss: P.ana } }),
        { ana: ["start", "close", "leave"], ben: ["leave"], cy: ["leave"], dee: ["leave"], eli: ["leave"], gus: ["leave"], spectator: [] },
        { start: "02-setup-lite", close: "12-closed" });

    add("12-closed", "The table closed (host, idle, no call, restart, games off). Rounds can still be replayed via GET /tables/{id}/rounds/{r} while the records exist.",
        rBase({ status: "closed", vseq: 91, opts: { preset: "full", bankroll: 6, patch: true }, players: [], spectators: 0, closed: { reason: "host", at: S(0) } }),
        {}, {});
    return steps;
}

/** [{ game, id, about, views: { perspective: view (or the public view for "spectator") }, people, moves, next }] */
export function allSteps() {
    const out = [];
    for (const [game, steps, project] of [["holdem", holdemSteps(), holdemView], ["rig", rigSteps(), rigView]]) {
        for (const s of steps) {
            const views = {};
            for (const [name, u] of Object.entries(s.persp)) views[name] = project(s.g, name === "spectator" ? null : u);
            out.push({ game, id: s.id, about: s.about, people: s.persp, views, moves: s.moves, next: s.next, god: s.g });
        }
    }
    return out;
}

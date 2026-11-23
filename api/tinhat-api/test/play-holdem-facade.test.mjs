// The Hold'em engine through its platform surface (play/holdem.mjs, the same shape as The Rig's): wallets are real
// (they may never go below 0), sit takes the whole wallet, chips earned while seated join the stack at the next deal,
// every effect carries the table's space, refused and no-op calls change nothing (same state, same rev).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as H from "../play/holdem.mjs";
import { seeded } from "./play-holdem-sim.mjs";

const NOW = 1_763_600_000_000;
const SP = "sid-9";
const ZERO = () => 0;

/** wallets + seats + pots, fed only by the effects; wallets must never go negative. */
function books(initial) {
    const B = { acc: new Map(Object.entries(initial).map(([w, n]) => [`w:${w}`, n])), minted: Object.values(initial).reduce((a, b) => a + b, 0) };
    const get = (k) => B.acc.get(k) || 0;
    const mv = (from, to, n) => {
        assert.ok(Number.isSafeInteger(n) && n >= 0);
        B.acc.set(from, get(from) - n);
        B.acc.set(to, get(to) + n);
        assert.ok(get(from) >= 0, `${from} below 0`);
    };
    B.get = get;
    B.earn = (w, n) => { B.acc.set(`w:${w}`, get(`w:${w}`) + n); B.minted += n; };
    B.balances = () => { const o = {}; for (const [k, v] of B.acc) if (k.startsWith("w:")) o[k.slice(2)] = v; return o; };
    B.apply = (fx) => {
        for (const e of fx) {
            assert.equal(e.space, SP, `${e.t} without the table's space`);
            assert.equal("id" in e, false);
            if (e.t === "sit" || e.t === "credit") mv(`w:${e.who}`, `seat:${e.who}`, e.amount);
            else if (e.t === "bet") mv(`seat:${e.who}`, `pot:${e.hand}:${e.who}`, e.amount);
            else if (e.t === "settle") {
                for (const [w, n] of Object.entries(e.from)) { assert.equal(get(`pot:${e.hand}:${w}`), n); mv(`pot:${e.hand}:${w}`, "x", n); }
                for (const [w, n] of Object.entries(e.to)) mv("x", `seat:${w}`, n);
                assert.equal(get("x"), 0);
            } else if (e.t === "void") for (const [w, n] of Object.entries(e.refunds)) mv(`pot:${e.hand}:${w}`, `seat:${w}`, n);
            else if (e.t === "cashout") { assert.equal(get(`seat:${e.who}`), e.amount); mv(`seat:${e.who}`, `w:${e.who}`, e.amount); }
        }
        let t = 0;
        for (const v of B.acc.values()) t += v;
        assert.equal(t, B.minted, "chips created or lost");
    };
    return B;
}

function table(wallets) {
    const B = books(wallets);
    const T = { st: H.createTable({ table: "tH1", room: "!r:x", space: SP, host: Object.keys(wallets)[0], now: NOW }), now: NOW, B, fx: [] };
    T.ctx = (extra = {}) => ({ now: T.now, balances: B.balances(), randomInt: ZERO, ...extra });
    T.call = (r) => { if (r.ok) { B.apply(r.effects); T.st = r.state; T.fx = r.effects; } return r; };
    // the simplest wiring: the admission check on every deal and tick
    T.act = (who, a, extra) => T.call(H.act(T.st, who, a, T.ctx({ admitted: a.do === "deal" ? true : undefined, ...extra })));
    T.tick = (now, admitted = true) => { T.now = now; return T.call(H.tick(T.st, T.ctx({ admitted }))); };
    T.at = () => ({ hand: T.st.hand.n, turn: T.st.hand.turn });
    return T;
}

test("facade: sit takes the whole wallet (space first, then chips); a hand; every effect names the space and who; cash-out then left", () => {
    const T = table({ "@a:x": 40, "@b:x": 25, "@c:x": 0 });
    assert.equal(H.act(T.st, "@a:x", { do: "sit" }, T.ctx()).code, "space-changed");
    assert.equal(H.act(T.st, "@a:x", { do: "sit", space: "sid-other" }, T.ctx()).code, "space-changed");
    assert.equal(H.act(T.st, "@c:x", { do: "sit", space: SP }, T.ctx()).code, "no-chips");
    assert.equal(H.act(T.st, "@c:x", { do: "sit", space: "sid-other" }, T.ctx()).code, "space-changed", "a stale space comes first (the app refreshes it), also with an empty wallet");
    assert.ok(T.act("@a:x", { do: "sit", space: SP }).ok);
    assert.deepEqual(T.fx, [{ t: "sit", seat: 1, amount: 40, who: "@a:x", space: SP }]);
    assert.equal(T.B.get("w:@a:x"), 0);
    assert.ok(T.act("@b:x", { do: "sit", space: SP, seat: 5 }).ok);
    assert.throws(() => H.act(T.st, "@a:x", { do: "deal" }, T.ctx()), /admission/);
    assert.ok(T.act("@a:x", { do: "deal" }).ok);
    assert.deepEqual(T.fx.map((e) => e.t), ["deal", "bet", "bet"]);
    const v = H.viewFor(T.st, "@a:x", T.now);
    assert.equal(v.table, "tH1");
    assert.equal(v.vseq, T.st.rev);
    assert.equal(v.now, T.now);
    assert.equal(v.seats[0].u, "@a:x");
    assert.ok(T.act("@a:x", { do: "fold", at: T.at() }).ok);
    assert.ok(T.act("@b:x", { do: "leave" }).ok);
    assert.deepEqual(T.fx, [
        { t: "cashout", seat: 5, amount: 26, reason: "leave", who: "@b:x", space: SP },
        { t: "left", who: "@b:x", space: SP },
    ]);
});

test("facade: chips earned while seated wait in the wallet and join the stack at the next deal", () => {
    const T = table({ "@a:x": 10, "@b:x": 10 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    T.act("@a:x", { do: "deal" });
    T.B.earn("@a:x", 1); // the sampler paid a chip during the hand
    T.act("@a:x", { do: "fold", at: T.at() });
    T.tick(T.now + H.HOLDEM.PAUSE_MS);
    assert.deepEqual(T.fx.slice(0, 2).map((e) => [e.t, e.who ?? "", e.amount ?? ""]), [["credit", "@a:x", 1], ["deal", "", ""]]);
    assert.equal(T.B.get("w:@a:x"), 0);
    const deal = T.fx.find((e) => e.t === "deal");
    assert.equal(deal.seats.find((s) => s.who === "@a:x").stack, 10, "the stack at the deal: 9 after the last hand's blind + the earned 1");
    assert.equal(JSON.stringify(T.fx).includes('"id"'), false, "no effect (nor nested seat) still says id");
});

test("facade: refused and no-op calls hand back the same state and rev; accepted ones bump rev", () => {
    const T = table({ "@a:x": 10, "@b:x": 10 });
    const st0 = T.st;
    const r = H.tick(T.st, T.ctx());
    assert.equal(r.state, st0);
    assert.deepEqual(r.effects, []);
    assert.equal(H.setOnline(T.st, "@a:x", false, T.ctx()).state, st0);
    T.act("@a:x", { do: "sit", space: SP });
    assert.equal(T.st.rev, 1);
    const bad = H.act(T.st, "@a:x", { do: "tick" }, T.ctx());
    assert.equal(bad.ok, false);
    assert.equal(bad.state, T.st);
    assert.equal(H.act(T.st, "@a:x", { do: "credit", target: "@a:x", amount: 5 }, T.ctx()).code, "bad", "system moves never from a player");
    const again = H.act(T.st, "@a:x", { do: "away", on: false }, T.ctx());
    assert.equal(again.state, T.st, "nothing changed: same state");
});

test("facade: spaceChanged mid-hand plays it out, then closes; voidRound calls it off and closes; both are no-ops once closed", () => {
    const T = table({ "@a:x": 10, "@b:x": 10 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    T.act("@a:x", { do: "deal" });
    T.call(H.spaceChanged(T.st, T.ctx()));
    assert.equal(T.st.status, "hand");
    T.act("@a:x", { do: "fold", at: T.at() });
    assert.equal(T.st.status, "closed");
    assert.deepEqual(T.fx.map((e) => e.t), ["settle", "cashout", "left", "cashout", "left", "table-end", "post", "closed"]);
    assert.equal(H.spaceChanged(T.st, T.ctx()).state, T.st);
    const G = table({ "@a:x": 10, "@b:x": 10 });
    G.act("@a:x", { do: "sit", space: SP });
    G.act("@b:x", { do: "sit", space: SP });
    G.act("@a:x", { do: "deal" });
    G.call(H.voidRound(G.st, G.ctx({ reason: "restart" })));
    assert.deepEqual(G.fx.map((e) => e.t), ["void", "cashout", "left", "cashout", "left", "table-end", "closed"]);
    assert.equal(G.B.get("w:@a:x") + G.B.get("w:@b:x"), 20);
    assert.equal(H.voidRound(G.st, G.ctx()).state, G.st);
});

test("facade: the admission check failing at the automatic deal closes the table", () => {
    const T = table({ "@a:x": 10, "@b:x": 10 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    T.act("@a:x", { do: "deal" });
    T.act("@a:x", { do: "fold", at: T.at() });
    assert.equal(H.nextDeadline(T.st), T.now + H.HOLDEM.PAUSE_MS);
    T.tick(T.now + H.HOLDEM.PAUSE_MS, false);
    assert.equal(T.st.status, "closed");
    assert.equal(T.st.closed.reason, "space-changed");
    assert.ok(!T.fx.some((e) => e.t === "credit" || e.t === "deal"));
});

test("facade fuzz: 30 seeded tables, earnings arriving any time, wallets never below 0 and the books always balance", () => {
    let hands = 0;
    for (let seed = 1; seed <= 30; seed++) {
        const R = seeded(seed);
        const people = Array.from({ length: R(2, 9) }, (_, i) => `@p${i}:x`);
        const T = table(Object.fromEntries(people.map((p) => [p, R(0, 60)])));
        T.st = H.createTable({ table: "t", room: "!r", space: SP, host: people[0], now: NOW, opts: { seats: 8 } });
        for (let step = 0; step < 2500 && T.st.status !== "closed"; step++) {
            const roll = R(0, 100);
            const p = people[R(0, people.length)];
            if (roll < 3) { T.B.earn(p, 1); continue; }
            if (T.st.status === "lobby") {
                if (roll < 60) T.act(p, { do: "sit", space: SP });
                else T.act(T.st.host ?? p, { do: "deal" });
                continue;
            }
            if (T.st.status === "pause") {
                if (roll < 10) T.act(p, { do: "leave" });
                else if (roll < 20) T.act(p, { do: "sit", space: SP });
                else T.tick(T.st.pauseUntil);
                continue;
            }
            const h = T.st.hand;
            const who = T.st.seats[h.b.toAct].id;
            if (roll < 8) { T.tick(h.deadline); continue; }
            if (roll < 10) { T.act(p, { do: "leave" }); continue; }
            const lg = H.viewFor(T.st, who).you.legal;
            const at = T.at();
            if (roll < 30) T.act(who, { do: "fold", at });
            else if (roll < 70 || !lg.raise) T.act(who, { do: lg.check ? "check" : "call", at });
            else if (roll < 90) T.act(who, { do: "raise", at, to: R(lg.raise.min, lg.raise.max + 1) });
            else T.act(who, { do: "allin", at });
        }
        hands += T.st.n;
        if (T.st.status !== "closed") T.call(H.voidRound(T.st, T.ctx()));
        for (const [k, v] of T.B.acc) if (!k.startsWith("w:")) assert.equal(v, 0, `${k} after the close`);
    }
    assert.ok(hands >= 1000, `only ${hands} hands`);
});

test("facade: a busted player whose wallet earned chips is dealt back in (the deal counts wallet chips), at the next deal or the host's Deal", () => {
    const T = table({ "@a:x": 2, "@b:x": 30 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    T.act("@a:x", { do: "deal" }); // @a button/SB 1, @b BB 2
    T.st.hand.holes = { 1: ["2c", "3d"], 2: ["As", "Ad"] };
    T.st.hand.deck = ["Kh", "Qs", "9c", "8d", "4h", ...T.st.hand.deck.filter((c) => !["Kh", "Qs", "9c", "8d", "4h", "2c", "3d", "As", "Ad"].includes(c))];
    T.act("@a:x", { do: "allin", at: T.at() });
    assert.equal(T.st.seats[1].stack, 0, "@a busted");
    T.B.earn("@a:x", 5);
    const ctx = T.ctx({ now: T.st.pauseUntil });
    assert.equal(H.wouldDeal(T.st, null, { do: "tick" }, ctx), true, "counted with the wallet's 5");
    assert.equal(H.wouldDeal(T.st, null, { do: "tick" }, T.ctx({ now: T.st.pauseUntil, balances: {} })), false);
    T.tick(T.st.pauseUntil);
    assert.equal(T.st.status, "hand");
    assert.deepEqual(T.fx.slice(0, 2).map((e) => e.t), ["credit", "deal"]);
    // and from the lobby through the host's Deal
    const G = table({ "@a:x": 2, "@b:x": 30 });
    G.act("@a:x", { do: "sit", space: SP });
    G.act("@b:x", { do: "sit", space: SP });
    G.st = structuredClone(G.st);
    G.B.acc.set("seat:@a:x", 0); G.B.acc.set("w:@a:x", 2); G.st.seats[1].stack = 0; // as if busted in an earlier hand
    G.st.status = "lobby";
    G.B.earn("@a:x", 3);
    assert.ok(G.act("@a:x", { do: "deal" }).ok);
    assert.equal(G.st.hand.n, 1);
    // no hand → no credit: wallet chips stay in the wallet
    const K = table({ "@a:x": 5, "@b:x": 5 });
    K.act("@a:x", { do: "sit", space: SP });
    K.B.earn("@a:x", 2);
    const r = H.act(K.st, "@a:x", { do: "deal" }, K.ctx({ admitted: true }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad-action");
});

test("facade: the admission check is required exactly when a call would deal, counting wallet chips; undefined throws", () => {
    const T = table({ "@a:x": 2, "@b:x": 30 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    assert.throws(() => H.act(T.st, "@a:x", { do: "deal" }, T.ctx()), /admission/);
    assert.doesNotThrow(() => H.tick(T.st, T.ctx()), "a tick with nothing to deal needs no check");
});

test("facade: a wallet balance the core won't take never blocks a timer or a deal (that player just isn't topped up)", () => {
    const T = table({ "@a:x": 10, "@b:x": 10 });
    T.act("@a:x", { do: "sit", space: SP });
    T.act("@b:x", { do: "sit", space: SP });
    T.act("@a:x", { do: "deal" });
    const huge = { "@a:x": 2 ** 40 + 1, "@b:x": 2 ** 40 + 1 };
    const r = H.tick(T.st, { now: T.st.hand.deadline, balances: huge, admitted: true });
    assert.ok(r.ok);
    assert.equal(r.state.hand.log.at(-1).timeout, true, "the turn timer acted");
    T.call(r);
    T.act("@a:x", { do: "away", on: false }); // v1.1: one timeout = away; back, so the next hand can deal
    const r2 = H.tick(T.st, { now: T.st.pauseUntil, balances: huge, admitted: true, randomInt: ZERO });
    assert.ok(r2.ok);
    assert.equal(r2.state.status, "hand", "the next hand is dealt without the bad top-up");
    assert.ok(!r2.effects.some((e) => e.t === "credit"));
});

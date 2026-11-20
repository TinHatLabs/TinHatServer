// Turns one vector case into the engine's answer, in the vector's own shape. Shared by the vector test and the
// planted-wrong-rule controls (which hand in a mutated copy of the engine), so both run exactly the same checks.
// `engine` = { rank, pots, betting } module namespaces.

export function runRanking(engine, c) {
    const b = engine.rank.bestHand(c.cards);
    return { category: b.category, key: b.key };
}

export function runShowdown(engine, c) {
    const r = engine.rank.showdown(c.board, c.hole);
    return { ranking: r.ranking, keys: r.keys };
}

export function runSidePots(engine, c) {
    return engine.pots.settlePots({
        order: c.seats, putIn: c.put_in, folded: c.folded, ranking: c.ranking, button: c.button,
    });
}

/** Applies the actions in turn order; the expect shape is { street, next, legal } or { error: { at, code } }. */
export function runBetting(engine, c) {
    const { startBetting, act, legal, BetError } = engine.betting;
    const h = startBetting({ seats: c.seats.map((s) => ({ seat: s.seat, stack: s.stack })), button: c.button, blinds: c.blinds });
    for (const [i, a] of c.actions.entries()) {
        const move = a[0] === "raise" ? { do: "raise", to: a[1] } : { do: a[0] };
        try {
            act(h, move);
        } catch (e) {
            if (!(e instanceof BetError)) throw e;
            return { error: { at: i, code: e.code } };
        }
    }
    const street = h.street;
    return { street, next: h.toAct ?? null, legal: legal(h) };
}

/** Every case of a vector file that fails under `engine` (ids), for the plants. */
export function failingCases(engine, kind, cases, isEqual) {
    const run = { seven: runRanking, showdown: runShowdown, pots: runSidePots, betting: runBetting }[kind];
    const bad = [];
    for (const c of cases) {
        let got;
        try { got = run(engine, c); } catch { bad.push(c.id); continue; }
        if (!isEqual(got, c.expect)) bad.push(c.id);
    }
    return bad;
}

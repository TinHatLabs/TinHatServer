// The running result of an open Rig round (§2.1: holdings include "the running result of an open Rig round"): what
// the round's settlement would add to / take from each person, from the engine's own round log. Hold'em has none (every
// chip is in a seat or pot account). After the reveal (settled) there is nothing provisional left.
//   Spinner: bankroll now − bankroll at the start (spins, stakes won by Calls, wrong-Call costs);
//   a Mechanic: their rake + their shares of wrong Calls − every stake of theirs that was busted.
// Market bets and Peeks settle only at the reveal (their escrows already count in holdings), so they add nothing here.
export function rigProvisional(st, wid) {
    const R = st && st.status === "round" ? st.round : null;
    if (!R || R.phase === "reveal" || R.settled) return 0;
    let v = 0;
    if (R.spinner === wid) v += (R.bankroll ?? 0) - (R.bank_start ?? 0);
    v += (R.rake_to?.[wid] || 0) + (R.call_to?.[wid] || 0);
    for (const s of R.slots || []) if (s.owner === wid && s.busted_spin != null) v -= s.stake ?? 0;
    return Number.isSafeInteger(v) ? v : 0;
}

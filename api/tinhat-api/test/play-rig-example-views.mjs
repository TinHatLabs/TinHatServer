// Prints example Rig views (every phase × role) from a scripted table, as a draft for the contract freeze.
// node test/play-rig-example-views.mjs play <out dir>   (from api/tinhat-api; not part of npm test)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, out] = process.argv.slice(2);
const E = await import(pathToFileURL(join(dir, "rig.mjs")).href);
mkdirSync(out, { recursive: true });
const P = ["@ana:example.org", "@bo:example.org", "@cy:example.org", "@di:example.org", "@ed:example.org"];
const bal = Object.fromEntries(P.map((u) => [u, 20]));
bal[P[4]] = 0; // a Railbird
let now = 1763600000000, n = 0, st;
const ctx = () => ({ now, balances: { ...bal }, admitted: true, newSeed: () => createHash("sha256").update(`example:${n++}`).digest() });
const apply = (r) => {
    for (const e of r.effects) {
        if (e.k === "escrow") bal[e.who] -= e.amount;
        if (e.k === "settle") for (const [u, v] of Object.entries(e.payouts)) bal[u] += v;
    }
    st = r.state;
};
const must = (who, a) => { const r = E.act(st, who, a, ctx()); if (!r.ok) throw new Error(`${who} ${JSON.stringify(a)} ${r.code}`); apply(r); return r; };
const tick = (ms) => { now += ms; apply(E.tick(st, ctx())); };
const dump = (name) => {
    const views = {};
    for (const u of [...P, "@watcher:example.org"]) views[u] = E.viewFor(st, u, now);
    writeFileSync(join(out, `${name}.json`), JSON.stringify(views, null, 1) + "\n");
};
st = E.createTable({ table: "tR7q2", room: "!room:example.org", space: "!space:example.org", host: P[0], now });
for (const u of P.slice(1)) must(u, { do: "join", space: "!space:example.org" });
dump("01-lobby");
must(P[0], { do: "start", preset: "full", bankroll: 6, patch: true });
// round 1 (Lite): walk at spin 5
tick(20_000);
while (st.round.phase === "turn" && st.round.spin < 5) { must(st.round.spinner, { do: "spin", bet: 1 }); while (st.round.phase === "land" || st.round.phase === "nudge") tick(4_000); }
if (st.round.phase === "turn") must(st.round.spinner, { do: "walk" });
dump("02-lite-reveal");
tick(20_000); // round 2 (Full)
dump("03-full-setup");
const R = () => st.round;
for (const m of R().mechanics) must(m, { do: "keep", card: R().deals[m][0] });
for (const u of R().house) if (!R().railbirds.includes(u)) must(u, { do: "market", side: "up", stake: 1 });
dump("04-full-turn-1");
const [m1, m2] = R().slots.map((s) => s.owner);
const sharp = R().house.find((u) => !R().mechanics.includes(u) && !R().railbirds.includes(u)) ?? m2; // the House member who Peeks
must(sharp, { do: "peek", mechanic: m1, card: R().slots[0].card });
must(sharp, { do: "whisper", template: "bluffing", person: m1 });
must(m1, { do: "mute", armed: true });
must(R().spinner, { do: "dial", bet: 3 });
must(R().spinner, { do: "spin", bet: 1 });
dump("05-full-land");
tick(2_000);
dump("06-full-nudge-window");
must(P[4], { do: "nudge", reel: 2, step: 1 });
must(R().spinner, { do: "audit", spin: 1 });
dump("07-full-turn-2-after-audit");
must(R().spinner, { do: "call", card: R().slots.find((s) => s.owner === m2).card });
dump("08-full-after-right-call");
const busted = R().slots.find((s) => s.busted_spin != null).owner;
const pr = E.act(st, busted, { do: "patch" }, ctx());
if (pr.ok) apply(pr);
dump("09-full-after-patch");
while (R().phase === "turn" && R().spin < 6) { must(R().spinner, { do: "spin", bet: 1 }); while (R().phase === "land" || R().phase === "nudge") tick(4_000); }
if (R().phase === "turn") must(R().spinner, { do: "walk" });
dump("10-full-reveal");
while (st.status === "round") { tick(20_000); if (st.status !== "round") break; tick(20_000); while (st.status === "round" && R().phase !== "reveal") tick(20_000); }
dump("11-table-end");
console.log("ok", out);

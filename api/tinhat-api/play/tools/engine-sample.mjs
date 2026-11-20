// games-s1 dev aid: print sample views of both engines (not shipped: play/tools is not in the image)
import * as H from "../holdem.mjs";
import * as R from "../rig.mjs";
import { randomBytes } from "node:crypto";
const now = 1763600000000;
let st = H.createTable({ table: "tHabcdefghijklmn", room: "!r:x", space: "!S:x", host: "wA", now, opts: { seats: 8 } });
const bal = { wA: 40, wB: 30, wC: 20 };
for (const w of ["wA", "wB", "wC"]) { const r = H.act(st, w, { do: "sit", space: "!S:x" }, { now, balances: bal, admitted: true }); st = r.state; }
let r = H.act(st, "wA", { do: "deal" }, { now, balances: { wA: 0, wB: 0, wC: 0 }, admitted: true });
console.log("HOLDEM deal ok", r.ok, r.code, JSON.stringify(r.effects).slice(0, 600));
st = r.state;
console.log("HOLDEM view wA", JSON.stringify(H.viewFor(st, "wA", now)));
console.log("HOLDEM view null", JSON.stringify(H.viewFor(st, null, now)));
console.log("HOLDEM nextDeadline", H.nextDeadline(st));
let g = R.createTable({ table: "tRabcdefghijklmn", room: "!r:x", space: "!S:x", host: "wA", now });
const rb = { wA: 40, wB: 30, wC: 20, wD: 15 };
for (const w of ["wA", "wB", "wC", "wD"]) { const x = R.act(g, w, { do: "join", space: "!S:x" }, { now, balances: rb, admitted: true, newSeed: () => randomBytes(32) }); g = x.state; if (!x.ok) console.log("join", w, x.code); }
let x = R.act(g, "wA", { do: "start", preset: "lite", bankroll: 6, patch: true }, { now, balances: rb, admitted: true, newSeed: () => randomBytes(32) });
console.log("RIG start", x.ok, x.code, JSON.stringify(x.effects).slice(0, 800));
g = x.state;
for (const w of ["wA", "wB", "wD", null]) console.log("RIG view", w, JSON.stringify(R.viewFor(g, w, now)));

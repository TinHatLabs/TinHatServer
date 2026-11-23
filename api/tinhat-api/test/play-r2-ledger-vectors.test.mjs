// vectors/ledger-v1.1.json (games-s2, reviewed by games-design2): the v1.1 economy as pure cases through the server's
// own functions (rules.configFromEnv / economyFor / tick, admin.adminDelta, side.sidePay / sideEarned).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rules from "../play/rules.mjs";
import { adminDelta } from "../play/admin.mjs";
import { sidePay, sideEarned } from "../play/side.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/play/ledger-v1.1.json", import.meta.url), "utf8"));
const base = (env = {}) => ({ ...rules.configFromEnv(env, () => {}), tz: "UTC" });

test("ledger-v1.1: the defaults are PLAY_DEFAULTS_V11", () => assert.deepEqual(V.defaults, { ...rules.PLAY_DEFAULTS_V11 }));
for (const c of V.economy) test(`ledger-v1.1 economy ${c.id}`, () => {
    const e = rules.economyFor(base(c.server), c.space);
    for (const [k, [v, src]] of Object.entries(c.want)) { assert.equal(e[k], v, `${k} value`); assert.equal(e.src[k], src, `${k} source`); }
    assert.equal(e.chip_s, c.chip_s);
});
for (const c of V.tick) test(`ledger-v1.1 tick ${c.id}`, () => {
    const r = rules.tick(c.w, { ...c.ev, at: Date.parse(c.ev.at) }, rules.economyFor(base(), c.space));
    assert.equal(r.chips, c.want.chips);
    if ("why" in c.want) assert.equal(r.why, c.want.why);
    for (const k of ["accrual_s", "earned_today"]) if (k in c.want) assert.equal(r.w[k], c.want[k], k);
});
for (const c of V.admin_delta) test(`ledger-v1.1 admin ${c.id}`, () => assert.equal(adminDelta(c.in), c.want));
for (const c of V.side_pay) test(`ledger-v1.1 side ${c.id}`, () => assert.equal(sidePay(c.in), c.want));
for (const c of V.side_tombstone) test(`ledger-v1.1 tombstone ${c.id}`, () => assert.equal(V.defaults.side_day_max - sideEarned(c.deleted, c.today), c.want.left_today));

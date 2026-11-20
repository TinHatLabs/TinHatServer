// The wallet rules (play/rules.mjs) against vectors/ledger.json, every case and every step, plus planted wrong rules
// that must each make the vectors FAIL (so the vector run is shown able to fail), and the config bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as rules from "../play/rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/play/ledger.json"), "utf8"));
const PICK = ["holdings", "rank", "accrual_s", "day", "earned_today", "topup_day"];
const pick = (w) => Object.fromEntries(PICK.map((k) => [k, w[k]]));

/** Run every case with a rules object; returns the list of mismatches (empty = all pass). */
function runAll(R) {
    const bad = [];
    for (const c of V.cases) {
        const cfg = { ...rules.FIXED, ...c.params };
        let w = { ...c.start };
        c.events.forEach((ev, i) => {
            const want = c.expect.after_each[i];
            let got = {};
            if (ev.do === "tick") { const r = R.tick(w, ev, cfg); w = r.w; got = { chips: r.chips, why: r.why }; }
            else if (ev.do === "topup") { const r = R.topup(w, ev.at, cfg); w = r.w; got = { chips: r.chips, why: r.why }; }
            else if (ev.do === "settle") { w = { ...w, holdings: w.holdings + ev.delta }; }
            else if (ev.do === "leave") { const r = R.leave(w, cfg); w = r.w; got = { burned: r.burned, why: r.why }; }
            else if (ev.do === "create") { const r = R.create(w, cfg); w = r.w; got = { chips: r.chips }; }
            else bad.push(`${c.id}[${i}]: unknown event ${ev.do}`);
            for (const k of ["chips", "why", "burned"]) if (k in want && JSON.stringify(got[k]) !== JSON.stringify(want[k])) bad.push(`${c.id}[${i}] ${k}: ${JSON.stringify(got[k])} != ${JSON.stringify(want[k])}`);
            if (want.state && JSON.stringify(pick(w)) !== JSON.stringify(pick(want.state))) bad.push(`${c.id}[${i}] state: ${JSON.stringify(pick(w))} != ${JSON.stringify(pick(want.state))}`);
        });
        if (c.expect.end && JSON.stringify(pick(w)) !== JSON.stringify(pick(c.expect.end))) bad.push(`${c.id} end`);
    }
    return bad;
}

test("ledger.json: every case, every step", () => {
    assert.equal(V.cases.length, 24);
    assert.deepEqual(runAll(rules), []);
});

test("planted wrong rules each FAIL the vectors", () => {
    const plants = {
        "no 90 s gap cap": { ...rules, tick: (w, ev, cfg) => rules.tick(w, { ...ev, gap_s: ev.gap_s }, { ...cfg, tick_max_s: 1e9 }) },
        "no carry-over": { ...rules, tick: (w, ev, cfg) => { const r = rules.tick(w, ev, cfg); if (r.chips) r.w.accrual_s = 0; return r; } },
        "earning at the cap": { ...rules, tick: (w, ev, cfg) => rules.tick(w, ev, { ...cfg, cap_base: 1e9 }) },
        "day max ignored": { ...rules, tick: (w, ev, cfg) => rules.tick(w, ev, { ...cfg, day_max: 1000 }) },
        "UTC day instead of the server's": { ...rules, tick: (w, ev, cfg) => rules.tick(w, ev, { ...cfg, tz: "UTC" }), topup: (w, at, cfg) => rules.topup(w, at, { ...cfg, tz: "UTC" }) },
        "top-up at 1": { ...rules, topup: (w, at, cfg) => (w.holdings === 1 ? { chips: 4, why: "", w: { ...w, holdings: 5, topup_day: rules.dayOf(at, cfg.tz) } } : rules.topup(w, at, cfg)) },
        "top-up twice a day": { ...rules, topup: (w, at, cfg) => rules.topup({ ...w, topup_day: null }, at, cfg) },
        "prestige one chip under the cap": { ...rules, leave: (w, cfg) => rules.leave(w, { ...cfg, cap_base: cfg.cap_base - 1 }) },
        "two ranks for a big leave": { ...rules, leave: (w, cfg) => { const r = rules.leave(w, cfg); if (r.why) r.w.rank += w.holdings >= 2 * rules.capOf(w.rank) ? 1 : 0; return r; } },
        "start ignores the config": { ...rules, create: (w) => ({ chips: 10, w: { ...w, holdings: w.holdings + 10 } }) },
    };
    for (const [name, R] of Object.entries(plants)) assert.notDeepEqual(runAll(R), [], `plant "${name}" passed the vectors`);
});

test("config from the environment: defaults, bounds, non-integers keep the default (never throw)", () => {
    const warns = [];
    const c = rules.configFromEnv({ PLAY_DAY_MAX: "3", PLAY_START: "0", PLAY_TZ: "America/Los_Angeles" }, (w) => warns.push(w));
    assert.equal(c.day_max, 3); assert.equal(c.start, 0); assert.equal(c.tz, "America/Los_Angeles"); assert.equal(warns.length, 0);
    for (const [k, v] of [["PLAY_DAY_MAX", "0"], ["PLAY_DAY_MAX", "25"], ["PLAY_DAY_MAX", "2.5"], ["PLAY_DAY_MAX", "-1"], ["PLAY_START", "51"], ["PLAY_START", "ten"], ["PLAY_START", "1e1"]]) {
        const w2 = [];
        const d = rules.configFromEnv({ [k]: v }, (w) => w2.push(w));
        assert.equal(d.day_max, 8, `${k}=${v}`); assert.equal(d.start, 10, `${k}=${v}`); assert.equal(w2.length, 1, `${k}=${v} warns once`);
    }
    assert.equal(rules.configFromEnv({ PLAY_TZ: "Not/AZone" }).tz, "UTC");
    assert.equal(rules.configFromEnv({}).chip_s, 3600);
    // the lab-only fast clock: only with TINHAT_LAB=1, only 10-3600; otherwise ignored (and said so)
    const w3 = [];
    assert.equal(rules.configFromEnv({ PLAY_CHIP_SECONDS: "60" }, (w) => w3.push(w)).chip_s, 3600);
    assert.equal(w3.length, 1);
    assert.equal(rules.configFromEnv({ PLAY_CHIP_SECONDS: "60", TINHAT_LAB: "1" }).chip_s, 60);
    assert.equal(rules.configFromEnv({ PLAY_CHIP_SECONDS: "5", TINHAT_LAB: "1" }).chip_s, 3600);
    assert.equal(rules.configFromEnv({ PLAY_CHIP_SECONDS: "60", TINHAT_LAB: "true" }).chip_s, 3600);
});

test("server day: local midnight in two zones", () => {
    assert.equal(rules.dayOf("2026-11-20T07:59:59Z", "America/Los_Angeles"), "2026-11-19");
    assert.equal(rules.dayOf("2026-11-20T08:00:00Z", "America/Los_Angeles"), "2026-11-20");
    assert.equal(rules.dayOf("2026-11-20T05:00:00Z", "America/New_York"), "2026-11-20");
    assert.equal(rules.nextDay("2026-12-31"), "2027-01-01");
});

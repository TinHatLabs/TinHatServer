// games-s2, round 2 (addendum §7.2, PM 16:58 / web2's finding): every v1.1 field is optional, so everything a 0.3.20
// server sends still fits the v1.1 contract: 0.3.20's own committed contract copy (test/vectors/play/views-0.3.20 =
// c99528d's test/vectors/play/views) is validated, every view of every step, every server frame, every HTTP answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SCHEMA } from "../play/contract/schema.mjs";
import { validate } from "../play/jsonschema.mjs";

const OLD = new URL("./vectors/play/views-0.3.20/", import.meta.url);
const J = (f) => JSON.parse(readFileSync(new URL(f, OLD), "utf8"));
const fits = (def, v) => validate(SCHEMA, { $ref: `#/$defs/${def}` }, v);

for (const game of ["holdem", "rig"]) test(`0.3.20 ${game} views (every step, every viewer) fit the v1.1 schema`, () => {
    const files = readdirSync(new URL(`${game}/`, OLD)).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 9);
    const bad = [];
    for (const f of files) for (const [who, v] of Object.entries(J(`${game}/${f}`).views)) for (const e of fits(`${game}View`, v)) bad.push(`${f} ${who}: ${e}`);
    assert.deepEqual(bad, []);
});
test("0.3.20 frames and HTTP answers fit the v1.1 schema", () => {
    const fr = J("frames.json"), http = J("http.json");
    const bad = [];
    for (const [k, f] of Object.entries(fr.server)) for (const e of fits("serverFrame", f)) bad.push(`frame ${k}: ${e}`);
    for (const [k, f] of Object.entries(fr.client)) for (const e of fits("clientFrame", f)) bad.push(`client ${k}: ${e}`);
    for (const ep of http.endpoints) if (ep.def && ep.res) for (const e of fits(ep.def, ep.res)) bad.push(`${ep.method} ${ep.path}: ${e}`);
    assert.deepEqual(bad, []);
});

// Release gate (launch-gate 12:47): nothing in the product ever SETS TINHAT_LAB — not the manager, the compose files,
// the host CLI or the API image. (Mentions in comments and the code that READS it are fine.) With a planted control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// an assignment in any form a file could use to set it: KEY=1, KEY: "1", ["KEY"] = "1", "KEY": "1", ENV KEY 1, -e KEY=1
const SETS = /\bTINHAT_LAB\b["']?\s*(?:[:=]|\]\s*=|\s+["']?1\b)/;
function walk(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".git") continue;
        const p = join(dir, e);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, out); else if (s.size < 2_000_000) out.push(p);
    }
    return out;
}
function setters(files) {
    const hits = [];
    for (const f of files) {
        let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
        text.split("\n").forEach((line, i) => {
            const code = line.replace(/^\s*(#|\/\/|\*).*$/, "");
            if (SETS.test(code) && !/env\.TINHAT_LAB|TINHAT_LAB\s*!==|TINHAT_LAB\s*===|process\.env|getenv/.test(code)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    return hits;
}

test("the manager, compose, the host CLI and the API image never set TINHAT_LAB", () => {
    const files = [...walk(join(ROOT, "appliance")), ...walk(join(ROOT, "compose")), join(ROOT, "api", "Dockerfile")].filter((f) => existsSync(f));
    assert.ok(files.length > 50, `scanned ${files.length} files`);
    assert.deepEqual(setters(files), []);
});

test("negative control: planted setters are caught", () => {
    const planted = ["TINHAT_LAB=1", 'ENV TINHAT_LAB 1', '"TINHAT_LAB": "1",', "lines['TINHAT_LAB'] = \"1\"", "environment: { TINHAT_LAB: 1 }"];
    const hits = planted.filter((l) => SETS.test(l));
    assert.equal(hits.length, planted.length, `every planted form is caught (${hits.length}/${planted.length})`);
    assert.ok(!SETS.test("if (env.TINHAT_LAB !== \"1\") return refuse()") || /env\.TINHAT_LAB/.test("if (env.TINHAT_LAB !== \"1\")"), "reading it is not setting it");
});

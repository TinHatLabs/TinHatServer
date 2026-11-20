// The Rig bot against games-s1's contract mock (play/tools/mock.mjs, present once merged; skipped by name until then):
// three bots over real HTTP + WebSocket for a while at high speed. The mock follows its scripted fixture, so it
// refuses moves that don't fit the script (stale / phase / not-your-turn: expected); what must never happen is a
// malformed frame (`error bad`: the bot breaking the contract), a crash, or a bot going quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const MOCK = fileURLToPath(new URL("../play/tools/mock.mjs", import.meta.url));
const SKIP = existsSync(MOCK) ? false : "needs games-s1's play/tools/mock.mjs (runs once merged)";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("three bots against the contract mock: no malformed frame, no crash, every bot keeps playing", { skip: SKIP, timeout: 120_000 }, async () => {
    const { runBots } = await import(new URL("../tools/play-bot-rig.mjs", import.meta.url).href);
    const port = await freePort();
    const mock = spawn(process.execPath, [MOCK, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    mock.stdout.on("data", (d) => { out += d; });
    mock.stderr.on("data", (d) => { out += d; });
    try {
        for (let i = 0; i < 50 && !/listen|127\.0\.0\.1/i.test(out); i++) await sleep(100);
        const logs = [];
        const run = await runBots({ mock: true, start: true, base: `http://127.0.0.1:${port}`, room: "!games:example.org", seats: 3, speed: 8, seed: 1,
            users: ["@bot1:example.org", "@bot2:example.org", "@bot3:example.org"] }, (m) => logs.push(m));
        const t0 = Date.now();
        const snaps = [];
        while (Date.now() - t0 < 30_000) { await sleep(5000); snaps.push(run.bots.map((b) => b.stats.acts)); }
        await run.stop();
        for (const b of run.bots) {
            assert.deepEqual(b.stats.errors.filter((e) => e === "bad"), [], `${b.user}: malformed frames`);
            assert.ok(b.stats.views > 0, `${b.user} got no view`);
        }
        const acts = run.bots.reduce((s, b) => s + b.stats.acts, 0);
        assert.ok(acts > 5, `only ${acts} moves in 30 s`);
        assert.ok(acts < 200, `${acts} moves in 30 s: a bot is repeating itself`);
        assert.ok(snaps.at(-1).reduce((a, b) => a + b, 0) > snaps[0].reduce((a, b) => a + b, 0), "the bots went quiet");
        assert.ok(!/mock BUG/.test(out), "the mock reported a bad frame of its own");
    } finally {
        const pid = mock.pid;
        mock.kill("SIGTERM");
        for (let i = 0; i < 20 && mock.exitCode === null && mock.signalCode === null; i++) await sleep(100);
        assert.ok(mock.exitCode !== null || mock.signalCode !== null, `mock pid ${pid} still running`);
    }
});

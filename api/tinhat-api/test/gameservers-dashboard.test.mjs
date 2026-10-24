// The dashboard's game-servers card (the manager's gameservers.py) writes gameservers.json; its test checks it still
// produces this fixture, and here the API's own parser must accept it as is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, KINDS } from "../gameservers.mjs";

const text = readFileSync(new URL("./fixtures/gameservers-dashboard.json", import.meta.url), "utf8");

test("the card's file parses, hand-written extras kept, another game allowed", () => {
    const c = parseConfig(text);
    assert.equal(c.joinHost, "games.example.org");
    assert.deepEqual(c.panel, { url: "https://panel.example.org", wings: "wss://node.example.org:8080", origin: "https://panel.example.org" });
    assert.equal(c.cap, 3);
    assert.equal(c.memoryBudgetMB, 20480);
    assert.equal(c.servers.length, 2);
    assert.equal(c.servers[0].steamAppId, 892970);
    assert.equal(c.servers[0].calendar, false);
    assert.equal(c.servers[0].outside, true);
    assert.equal(c.servers[1].kind, "other");
    assert.equal(c.servers[1].joinPasswordText, "sample-join-pw");
});

test("the kinds the card offers are the API's", () => {
    const py = readFileSync(new URL("../../../appliance/rootfs/opt/tinhat/manager/tinhat/gameservers.py", import.meta.url), "utf8");
    const offered = [...py.match(/^KINDS = \{([\s\S]*?)\}/m)[1].matchAll(/"([a-z]+)":/g)].map((m) => m[1]).sort();
    assert.deepEqual(offered, Object.keys(KINDS).sort());
    const pwVar = Object.entries(KINDS).filter(([, k]) => k.passwordVar).map(([k]) => k).sort();
    const pyPw = [...py.match(/^PASSWORD_VAR = \{([^}]*)\}/m)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(pyPw, pwVar);
});

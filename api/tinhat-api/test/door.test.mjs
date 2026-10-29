// The guest door page (api/guest/door.js, served at /call/): an old guest link is explained, a current one knocks.
// The page runs in a sandbox with a stub DOM, location and fetch (no browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "guest", "door.js"), "utf8");

async function page(href) {
    const els = {};
    const el = (id) => (els[id] ??= { id, hidden: false, textContent: "", value: "", disabled: false, focus() {}, addEventListener() {} });
    const fetched = [];
    const u = new URL(href);
    const ctx = {
        URL, URLSearchParams, encodeURIComponent, setTimeout: () => 0, clearTimeout() {},
        location: { search: u.search, pathname: u.pathname, origin: u.origin, replace(x) { ctx.went = x; } },
        document: { getElementById: el, title: "" },
        localStorage: { getItem: () => null, setItem() {} },
        fetch: async (url) => { fetched.push(url); return { status: 200, ok: true, json: async () => ({ server: "crew.test", open: true, web: u.origin + "/" }) }; },
    };
    runInNewContext(SRC, ctx);
    await new Promise((r) => setImmediate(r));
    return { els, fetched, ctx };
}

test("old_guest_links_are_explained_and_never_asked_about", async () => {
    for (const href of ["https://crew.test/call/?room=tinhat-guest-abc", "https://crew.test/call/?room=old-guest-xyz&name=Al",
        "https://crew.test/call/legacy.html?room=tinhat-guest-abc", "https://crew.test/?join=abc", "https://crew.test/guest/abc",
        "https://crew.test/guest", "https://crew.test/GUEST/abc"]) {
        const { els, fetched } = await page(href);
        assert.equal(els.doneTitle.textContent, "This is an old guest link", href);
        assert.match(els.doneText.textContent, /Guests room/);
        assert.equal(els.ask.hidden, true);
        assert.deepEqual(fetched, [], "the server isn't asked about an old link");
    }
});

test("a_current_link_still_knocks_and_a_bad_one_is_closed", async () => {
    const cur = await page(`https://crew.test/call/?g=${"A".repeat(24)}`);
    assert.deepEqual(cur.fetched, [`/api/guest/door?g=${"A".repeat(24)}`]);
    assert.equal(cur.els.title.textContent, "Guests · crew.test");
    const bad = await page("https://crew.test/call/?g=short");
    assert.equal(bad.els.doneTitle.textContent, "This guest link isn't open");
    const none = await page("https://crew.test/call/");
    assert.equal(none.els.doneTitle.textContent, "This guest link isn't open", "no key at all: as before");
    // a current link that also carries an old parameter is a current link
    const both = await page(`https://crew.test/call/?g=${"B".repeat(24)}&room=x`);
    assert.equal(both.fetched.length, 1);
});

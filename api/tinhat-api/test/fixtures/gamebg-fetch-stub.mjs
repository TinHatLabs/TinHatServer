// gamebg-fetch-stub.mjs — loaded with `node --import` by games-background.test.mjs: replaces fetch so the real games
// service runs with nothing on the network. Calls to 127.0.0.1 (the fake Synapse) pass through; every OTHER call is
// logged to $GAMEBG_STUB_LOG and answered here.
import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
globalThis.__tinhatGamesArtFetch = globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:")) return real(url, opts);
    appendFileSync(process.env.GAMEBG_STUB_LOG, `${u}\n`);
    const m = /\/steam\/apps\/(\d+)\/library_hero(_2x)?\.jpg$/.exec(u);
    if (m && m[1] === "1" && m[2]) return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    if (m && m[1] === "2") return new Response(Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), { status: 200 });
    return new Response("nope", { status: 404 });
};

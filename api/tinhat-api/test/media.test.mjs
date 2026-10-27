// media.mjs — /gif/fetch's checks (security review 2026-10-26, M5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { giphyMediaUrl, sniffImage, readCapped, MEDIA_HEADERS, sniffAudio, sniffClipAudio, SANDBOX_HEADERS } from "../media.mjs";

test("only Giphy's media hosts over plain https", () => {
    for (const u of ["https://media.giphy.com/media/abc/giphy.gif", "https://media2.giphy.com/media/abc/giphy.gif?cid=1&rid=giphy.gif",
        "https://i.giphy.com/abc.webp", "https://MEDIA0.GIPHY.COM/media/x/200.mp4"]) assert.ok(giphyMediaUrl(u), u);
    for (const u of ["https://giphy.com/gifs/abc", "https://developers.giphy.com/x", "https://api.giphy.com/v1/gifs/trending",
        "http://media.giphy.com/x.gif", "https://media.giphy.com:8443/x.gif", "https://a:b@media.giphy.com/x.gif",
        "https://media.giphy.com.evil.example/x.gif", "https://evilgiphy.com/x.gif", "https://media22.giphy.com/x.gif",
        "not a url", "", 7]) assert.equal(giphyMediaUrl(u), null, String(u));
});

test("the type comes from the bytes: gif, webp, png, jpeg, mp4 — never html or svg", () => {
    const pad = (s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(16)]);
    assert.equal(sniffImage(pad("GIF89a")), "image/gif");
    assert.equal(sniffImage(pad("GIF87a")), "image/gif");
    assert.equal(sniffImage(pad("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImage(pad("\x89PNG\r\n\x1a\n")), "image/png");
    assert.equal(sniffImage(pad("\xff\xd8\xff\xe0")), "image/jpeg");
    assert.equal(sniffImage(pad("\0\0\0\x18ftypmp42")), "video/mp4");
    for (const s of ["<!doctype html><script>", "<svg xmlns=", "RIFF\0\0\0\0WAVEfmt ", "GIF8"]) assert.equal(sniffImage(pad(s).subarray(0, Math.max(s.length, 12))), null, s);
    assert.equal(sniffImage(Buffer.from("GIF89a")), null, "too short to tell");
});

const resp = (chunks, headers = {}) => new Response(new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); },
}), { headers });

test("readCapped: whole bodies under the cap; refuses past it (declared or streamed), never truncates", async () => {
    assert.equal((await readCapped(resp([Buffer.alloc(5), Buffer.alloc(5)]), 10)).length, 10);
    await assert.rejects(readCapped(resp([Buffer.alloc(6), Buffer.alloc(5)]), 10), (e) => e.status === 413);
    await assert.rejects(readCapped(resp([Buffer.alloc(1)], { "content-length": "999" }), 10), (e) => e.status === 413);
});

test("the answer can't run anything on this origin", () => {
    assert.equal(MEDIA_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.equal(MEDIA_HEADERS["Content-Security-Policy"], "default-src 'none'; sandbox");
});

test("audio from the bytes: clips accept AAC (ADTS) too; html, svg and text never pass (round 3)", () => {
    const pad = (s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(64)]);
    const cases = [["ID3\x04", "audio/mpeg"], ["\xff\xfb\x90", "audio/mpeg"], ["OggS\0\x02", "audio/ogg"], ["RIFF\0\0\0\0WAVEfmt ", "audio/wav"],
        ["\0\0\0\x20ftypM4A ", "audio/mp4"], ["\x1a\x45\xdf\xa3", "audio/webm"]];
    for (const [head, type] of cases) {
        assert.equal(sniffAudio(pad(head)).type, type, head);
        assert.equal(sniffClipAudio(pad(head)).type, type, head);
    }
    const opus = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.alloc(32)]);
    assert.equal(sniffClipAudio(opus).ext, "opus");
    const adts = pad("\xff\xf1\x50\x80");
    assert.equal(sniffAudio(adts), null, "uploads keep their set");
    assert.deepEqual(sniffClipAudio(adts), { ext: "aac", type: "audio/aac" });
    for (const bad of ["<!doctype html><script>alert(1)</script>", "<html>", "<svg xmlns=\"http://www.w3.org/2000/svg\">",
        "GIF89a", "%PDF-1.7", "{\"json\": true}", "plain text here", "\xef\xbb\xbf<html>"]) {
        assert.equal(sniffClipAudio(pad(bad)), null, bad);
    }
    assert.equal(sniffClipAudio(Buffer.from("ID3")), null, "too short to tell");
    assert.equal(sniffClipAudio(undefined), null);
});

test("other same-origin bytes (Memories files, game art) are sandboxed and never sniffed", () => {
    assert.equal(SANDBOX_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.equal(SANDBOX_HEADERS["Content-Security-Policy"], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
});

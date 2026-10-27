// media.mjs — the GIF byte proxy's checks (server.mjs /gif/fetch; security review 2026-10-26, finding M5).
//
//   giphyMediaUrl  only Giphy's media hosts (i.giphy.com, media.giphy.com, media0-9.giphy.com), https, no port, no
//                  userinfo: giphy.com's own pages (HTML that could reflect text) are never fetched.
//   sniffImage     the type comes from the first bytes, never from the upstream Content-Type: GIF, WebP, PNG, JPEG, MP4.
//   readCapped     a fetch Response body, at most `max` bytes (a bigger one is refused, never truncated).
//   MEDIA_HEADERS  what the answer carries: the sniffed type, nosniff, and the same sandbox CSP as /clip, so even a
//                  mistaken type can't run anything on this origin.
//   sniffAudio     an uploaded sound's container from its first bytes (mp3, ogg/opus, wav, m4a, webm); sniffClipAudio
//                  the same plus AAC (ADTS) for the myinstants cache, whose stored type now comes from the bytes too.
//   SANDBOX_HEADERS for other same-origin bytes that aren't the app's: Memories recordings and thumbnails, the games
//                  catalogue's cover art and its SVG placeholder (security review, round 3).

const GIPHY_MEDIA_HOST = /^(?:i|media\d?)\.giphy\.com$/;

/** The URL to fetch (string) or null. */
export function giphyMediaUrl(raw) {
    if (typeof raw !== "string" || raw.length > 2048) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
    if (!GIPHY_MEDIA_HOST.test(u.hostname.toLowerCase())) return null;
    u.hash = "";
    return u.toString();
}

/** "image/gif" | "image/webp" | "image/png" | "image/jpeg" | "video/mp4" | null, from the first bytes. */
export function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    const tag = (at, s) => buf.subarray(at, at + s.length).toString("latin1") === s;
    if (tag(0, "GIF87a") || tag(0, "GIF89a")) return "image/gif";
    if (tag(0, "RIFF") && tag(8, "WEBP")) return "image/webp";
    if (buf[0] === 0x89 && tag(1, "PNG\r\n\x1a\n")) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (tag(4, "ftyp")) return "video/mp4";
    return null;
}

/** The body as a Buffer, or throws {status: 413} past `max` bytes (Content-Length first, then while reading). */
export async function readCapped(r, max) {
    const declared = Number(r.headers?.get?.("content-length") || 0);
    if (declared > max) {
        try { await r.body?.cancel(); } catch { /* gone */ }
        throw Object.assign(new Error("too big"), { status: 413 });
    }
    if (!r.body) return Buffer.alloc(0);
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > max) {
            try { await reader.cancel(); } catch { /* gone */ }
            throw Object.assign(new Error("too big"), { status: 413 });
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

export const MEDIA_HEADERS = Object.freeze({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600",
});

/**
 * Sniff the container from the first bytes; {ext, type} or null. The set is exactly what the soundboard players
 * (browser <audio>, Qt/FFmpeg) decode (uploads: server.mjs).
 */
export function sniffAudio(buf) {
    if (!buf || buf.length < 12) return null;
    const tag = (at, s) => buf.subarray(at, at + s.length).toString("latin1") === s;
    if (tag(0, "ID3")) return { ext: "mp3", type: "audio/mpeg" };
    // bare MPEG audio frame: 11-bit sync + a non-reserved layer (0xFFFB / FFFA / FFF3 / FFF2 …)
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0) return { ext: "mp3", type: "audio/mpeg" };
    if (tag(0, "OggS")) return { ext: buf.subarray(0, 64).includes("OpusHead") ? "opus" : "ogg", type: "audio/ogg" };
    if (tag(0, "RIFF") && tag(8, "WAVE")) return { ext: "wav", type: "audio/wav" };
    if (tag(4, "ftyp")) return { ext: "m4a", type: "audio/mp4" };
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: "webm", type: "audio/webm" }; // EBML
    return null;
}

/** A myinstants clip's type from its bytes (round 3: the stored type was whatever myinstants said): sniffAudio's set
 *  plus AAC in ADTS frames (sync 0xFFF, layer 00). null = not audio: refused and never stored. */
export function sniffClipAudio(buf) {
    const a = sniffAudio(buf);
    if (a) return a;
    if (buf && buf.length >= 12 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { ext: "aac", type: "audio/aac" };
    return null;
}

export const SANDBOX_HEADERS = Object.freeze({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
});

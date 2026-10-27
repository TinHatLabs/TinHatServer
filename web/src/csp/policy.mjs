// policy.mjs — Tin Hat Web's Content-Security-Policy (security review 2026-10-26, M3): the policy a Tin Hat Server sends
// with the web app (Caddy, the web root's `handle` block), one directive per entry with why it is there. The single
// source: vite.config.ts writes it into dist/csp-ready.json, docs/CSP.md describes it, the CSP gate (tools/csp/) serves a
// production build with exactly this header. In src/ because the build needs it and the public source export carries
// src/ (not tools/csp/).
//   node src/csp/policy.mjs            → the header value on one line
//   node src/csp/policy.mjs --explain  → each directive and its reason

/** [directive, sources, why] */
export const DIRECTIVES = [
  ["default-src", ["'self'"], "anything not listed below: this origin only (manifest, prefetch, …)"],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"],
    "the bundle, src/boot.js, the AudioWorklets (tap.worklet.js, rnnoise) — all files of this origin, no inline script, no eval; " +
    "'wasm-unsafe-eval' compiles WebAssembly only: the Rust crypto (matrix-sdk-crypto-wasm) and the rnnoise noise suppressor"],
  ["style-src", ["'self'", "'unsafe-inline'"],
    "the bundle's CSS + index.html's <style> (the static start card); 'unsafe-inline' for style attributes and <style> " +
    "elements the app writes at run time (message colours from the sanitiser, the theme engine, PiP / overlay windows, React)"],
  ["img-src", ["'self'", "data:", "blob:", "https:"],
    "blob: = decrypted / authenticated Matrix media (core/media.ts, typed by core/mediatype.ts); data: = the icon pack's SVGs; " +
    "https: = GIFs from any host (embeds, GIPHY), YouTube posters, Media Party art (member-chosen hosts: a design decision)"],
  ["media-src", ["'self'", "data:", "blob:", "https:"],
    "blob: = attachments / Memories (MediaSource); https: = direct video links, Media Party direct media, music URLs; " +
    "'self' = sounds and /api clip and VOD routes"],
  ["font-src", ["'self'", "data:"], "local() faces only today; bundled fonts if ever added"],
  ["connect-src", ["'self'", "https:", "wss:", "blob:", "data:"],
    "'self' = the homeserver + /api; https: = the call's focus (lk-jwt) and a moved server's well-known on another " +
    "host, CORS reads of GIF bytes (AnimatedImage) from any host; wss: = the LiveKit SFU (any host the focus names); " +
    "blob:/data: = reading our own object URLs back (upload echoes, GIF frames)"],
  ["worker-src", ["'self'"], "the sync worker, the LiveKit E2EE worker (AV1 patch), the service workers sw.js + push-sw.js — all files"],
  ["frame-src",
    ["https://www.youtube-nocookie.com", "https://player.vimeo.com", "https://streamable.com", "https://clips.twitch.tv",
      "https://player.twitch.tv", "https://open.spotify.com", "https://embed.music.apple.com", "https://w.soundcloud.com"],
    "click-to-play embeds (chat/lib/embeds.ts) and the Media Party's YouTube player (ytframe.ts) — exactly these hosts"],
  ["object-src", ["'none'"], "no plugins"],
  ["base-uri", ["'none'"], "a <base> could re-point every relative URL (the bundle is loaded with ./ paths)"],
  ["form-action", ["'none'"], "the app never submits a form by navigation (every <form> handles submit in script)"],
  ["frame-ancestors", ["'none'"], "nobody frames the app (the phone / Mac shells load it top-level): no clickjacking"],
];

export const CSP = DIRECTIVES.map(([d, s]) => `${d} ${s.join(" ")}`).join("; ");

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--explain")) for (const [d, s, why] of DIRECTIVES) console.log(`${d} ${s.join(" ")}\n    ${why}\n`);
  else console.log(CSP);
}

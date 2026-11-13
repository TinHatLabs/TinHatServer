import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CSP } from "./src/csp/policy.mjs";

// Tin Hat Web. `base: "./"` + hash routing (#/room/...) = the same bundle works at a server's root and under a staging
// path (/next/) without a rebuild.
// `vite` (dev) and `vite preview` proxy the same-origin Tin Hat API (/api/*) — and the homeserver's own paths, since the
// page's origin is the homeserver (src/core/bearer.ts) — to a real server, which you name in the environment:
// TH_DEV_SERVER=https://<your Tin Hat Server> (the older TW_API_ORIGIN still works). There is no built-in default;
// `vite build` needs neither. Signing in through the proxy works in `vite` dev only (plain http on the loopback
// address is allowed there and nowhere else: bearer.ts). The saved session lives in this origin's localStorage, so give
// each TH_DEV_SERVER its own port (or sign out first): a session saved against one server is not checked again when
// the same port proxies another.
const API = process.env.TH_DEV_SERVER || process.env.TW_API_ORIGIN || "";
const port = Number(process.env.TW_PORT ?? 5170);
// 10.8: ONE version number, package.json "version" (bumped with the desktop's Cargo version every release; it was
// stuck at 10.5.0 in five places). The bundle reads it as import.meta.env.VITE_TW_SEMVER (About, What's new, the update
// banner, bug reports, the call's client marker) and index.html as %VITE_TW_SEMVER%; twdeploy writes the same number
// into version.json. An explicit VITE_TW_SEMVER in the environment wins.
process.env.VITE_TW_SEMVER ??= (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

// The theme-before-first-paint script (src/boot.js) — a classic blocking <script> in <head>, NOT inline, so the app's
// Content-Security-Policy can be `script-src 'self'` (security review 2026-10-26, M3). A build emits it as
// assets/boot-<sha256/10>.js (cached as immutable like every other asset: a changed script is a new name) and points the
// `<!-- tinhat:boot … -->` marker in index.html at it; `vite` dev inlines it there (dev serves no CSP).
const BOOT_SRC = fileURLToPath(new URL("./src/boot.js", import.meta.url));
const BOOT_MARK = /<!-- tinhat:boot[^>]*-->/;
function bootScript(): Plugin {
  const read = () => {
    const code = readFileSync(BOOT_SRC, "utf8");
    return { code, file: `assets/boot-${createHash("sha256").update(code).digest("hex").slice(0, 10)}.js` };
  };
  let built: { code: string; file: string } | null = null;
  return {
    name: "tinhat-boot-script",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!BOOT_MARK.test(html)) throw new Error("index.html lost its <!-- tinhat:boot --> marker (src/boot.js)");
        if (ctx.server) return html.replace(BOOT_MARK, () => `<script>\n${read().code}</script>`);
        built = read();
        const { file } = built;
        return html.replace(BOOT_MARK, () => `<script src="./${file}"></script>`);
      },
    },
    generateBundle() {
      // transformIndexHtml runs inside the HTML plugin's generateBundle, after this one in some orders: read again here
      const b = built ?? read();
      this.emitFile({ type: "asset", fileName: b.file, source: b.code });
    },
  };
}

// dist/csp-ready.json = {"csp": 1, "policy": "<the header value>"} — the marker a Tin Hat Server's build reads: it turns
// the web root's Content-Security-Policy on only for a bundle that carries it (an older bundle has an inline boot script
// and a blob: worklet the policy would refuse), and copies the policy from here, so src/csp/policy.mjs stays the one
// place the string lives (security review 2026-10-26, M3; docs/CSP.md).
function cspMarker(): Plugin {
  return {
    name: "tinhat-csp-marker",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "csp-ready.json", source: `${JSON.stringify({ csp: 1, policy: CSP })}\n` });
    },
  };
}

// Start-up preloads (web-perf 2026-11-07, share claude/tinhat-web/WEB-PERF-20261107.md). Without them the encryption
// engine's three files (the rust-crypto chunk, the sync-store worker and the 7.8 MB crypto WebAssembly, ~2 MB
// compressed) are asked for only after the whole app script has downloaded AND run: on a phone over a slow link the line
// then sits idle for the ~2 s the script takes to run, and the WebAssembly alone takes ~10 s after that. Preloading them
// from index.html makes them share the line from the first moment. Each <link> matches the request the app makes later
// (fetch() of the .wasm = mode cors + same-origin credentials = `as="fetch" crossorigin`; the chunk = modulepreload; the
// worker script is fetched into the HTTP cache — immutable — that the Worker then reads), so nothing is fetched twice.
function startPreloads(): Plugin {
  return {
    name: "tinhat-start-preloads",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const out = Object.values(ctx.bundle ?? {});
        const wasm = out.find((o) => o.type === "asset" && /(^|\/)matrix_sdk_crypto_wasm_bg-[^/]*\.wasm$/.test(o.fileName));
        const crypto = out.find((o) => o.type === "chunk" && o.isDynamicEntry && /[\\/]matrix-js-sdk[\\/]lib[\\/]rust-crypto[\\/]index\.js$/.test(o.facadeModuleId ?? ""));
        const worker = out.find((o) => o.type === "asset" && /(^|\/)sync\.worker-[^/]*\.js$/.test(o.fileName));
        if (!wasm || !crypto || !worker) throw new Error("start preloads: the crypto WebAssembly, the rust-crypto chunk or the sync worker is missing from the bundle");
        return [
          { tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `./${crypto.fileName}` }, injectTo: "head" },
          { tag: "link", attrs: { rel: "preload", as: "fetch", crossorigin: true, href: `./${worker.fileName}` }, injectTo: "head" },
          { tag: "link", attrs: { rel: "preload", as: "fetch", crossorigin: true, href: `./${wasm.fileName}` }, injectTo: "head" },
        ];
      },
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === "serve" && !API) {
    throw new Error(
      "TH_DEV_SERVER is not set. The dev server and `vite preview` proxy /api to a Tin Hat Server: " +
        "run e.g. `TH_DEV_SERVER=https://chat.example.org pnpm dev` (see AGENTS.md, Running things).",
    );
  }
  const to = { target: API, changeOrigin: true, secure: true };
  const proxy = { "/api": to, "/_matrix": to, "/.well-known/matrix": to, "/livekit": { ...to, ws: true } };
  return {
    base: "./",
    plugins: [react(), bootScript(), cspMarker(), startPreloads()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    optimizeDeps: {
      // The Rust crypto WASM loads itself via new URL("…wasm", import.meta.url): never pre-bundle it.
      exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
      // Deep imports used by core (crypto-api, the sync-store worker) must be pre-bundled up front,
      // otherwise Vite discovers them at runtime and reloads the page mid-sign-in (FOUNDATION-CORE).
      include: [
        "matrix-js-sdk",
        "matrix-js-sdk/lib/crypto-api/index.js",
        "matrix-js-sdk/lib/indexeddb-worker.js",
      ],
    },
    worker: {
      format: "es" as const,
      // The sync-store worker needs only the SDK's IndexedDB backend, but sync-accumulator.js imports one constant from
      // models/event.js, and the SDK doesn't declare itself free of side effects: without this the worker carried the
      // whole SDK (client, WebRTC calls, MatrixRTC, sliding sync… 706 KB, 212 KB compressed, fetched on every cold
      // start). Inside worker bundles only, the SDK's modules count as side-effect free, so the worker keeps exactly
      // the code it runs (web-perf 2026-11-07).
      rolldownOptions: { treeshake: { moduleSideEffects: (id: string) => !/[\\/]matrix-js-sdk[\\/]lib[\\/]/.test(id) } },
    },
    build: {
      target: "es2022",
      sourcemap: true,
      chunkSizeWarningLimit: 4096,
      // Everything the start runs (the entry's whole static import graph, rolldown's "$initial" tag) stays ONE chunk +
      // ONE stylesheet, as before the lazy parts existed: left to itself rolldown cut the start into ~40 shared chunks
      // and ~10 stylesheets, and on a phone's slow link the render-blocking CSS then shares the line with all of them
      // (the "Starting up" card painted ~1 s later). Only the lazy parts (ui/lazy.tsx) and the existing dynamic
      // imports are separate files (web-perf 2026-11-07).
      rolldownOptions: { output: { codeSplitting: { groups: [{ name: "app", tags: ["$initial" as const] }] } } },
      // a script or WebAssembly asset imported with ?url (the AudioWorklets, the noise suppressor) is ALWAYS a file: Vite
      // inlines small assets as data: URLs, which the app's CSP (script-src 'self') refuses — the 3 KB level-tap worklet
      // was one (security review 2026-10-26, M3). Other small assets keep the default rule.
      assetsInlineLimit: (file: string) => (/\.(m?js|wasm)$/i.test(file) ? false : undefined),
    },
    server: { host: "127.0.0.1", port, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port, strictPort: true, proxy },
  };
});

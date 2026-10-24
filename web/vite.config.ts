import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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
    plugins: [react()],
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
    worker: { format: "es" as const },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 4096 },
    server: { host: "127.0.0.1", port, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port, strictPort: true, proxy },
  };
});

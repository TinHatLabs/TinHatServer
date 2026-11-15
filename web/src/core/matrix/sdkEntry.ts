// sdkEntry.ts — the app's `matrix-js-sdk` import (vite.config.ts aliases the bare name here; types still come from the
// package). The same as the SDK's own browser entry (lib/browser-index.js: the one-entrypoint guard and the IndexedDB
// crypto-store factory) WITHOUT its last line, `globalThis.matrixcs = sdk`: publishing the whole namespace as a global
// made the bundler keep every export of the SDK, among them its embedded-widget client and matrix-widget-api (~100 KB
// raw in the start chunk) that Tin Hat never uses (web-perf-2 #9). Nothing here reads `matrixcs`.
import { IndexedDBCryptoStore, setCryptoStoreFactory } from "matrix-js-sdk/lib/matrix.js";

const g = globalThis as unknown as { __js_sdk_entrypoint?: boolean };
if (g.__js_sdk_entrypoint) throw new Error("Multiple matrix-js-sdk entrypoints detected!");
g.__js_sdk_entrypoint = true;

// just *accessing* indexedDB throws in Firefox with IndexedDB disabled
let idb: IDBFactory | undefined;
try {
  idb = globalThis.indexedDB;
} catch {
  /* no IndexedDB */
}
if (idb) {
  const f = idb;
  setCryptoStoreFactory(() => new IndexedDBCryptoStore(f, "matrix-js-sdk:crypto"));
}

export * from "matrix-js-sdk/lib/matrix.js";

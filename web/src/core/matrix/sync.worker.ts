// Web worker that hosts the matrix-js-sdk IndexedDB sync store off the main thread (the same
// pattern Element Web uses). Created by client.ts via
//   new Worker(new URL("./sync.worker.ts", import.meta.url), { type: "module" })
// If the worker cannot start, client.ts falls back to the in-thread IndexedDB backend.
import { IndexedDBStoreWorker } from "matrix-js-sdk/lib/indexeddb-worker.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const remote = new IndexedDBStoreWorker(ctx.postMessage);
ctx.onmessage = remote.onMessage;

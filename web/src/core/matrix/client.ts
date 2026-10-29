// client.ts — the ONE MatrixClient of this tab: creation, stores, crypto, start/stop, wipe.
//
// Port of the native session.rs + bridge.rs build_client/start_sync, on matrix-js-sdk 42:
//   • sync store: IndexedDBStore "tinhat-web-sync" (IDB name "matrix-js-sdk:tinhat-web-sync" —
//     the SDK prefixes it) hosted in a web worker, falling back to the in-thread backend, then to
//     a MemoryStore if IndexedDB is unusable (private windows).
//   • crypto: Rust crypto (WASM) with cryptoDatabasePrefix "tinhat-web" → IDB
//     "tinhat-web::matrix-sdk-crypto" + "…-meta". The old Element fork on this origin uses the
//     default "matrix-js-sdk::…" / "matrix-js-sdk:riot-web-sync" names — never touched here.
//   • one tab at a time: an exclusive Web Lock ("tinhat-web-client") guards the crypto store —
//     two clients on one crypto DB corrupt it (the native app has the same rule: one sync loop).
//
// Feature code reads the client through getClient()/useClient() (or the hooks in hooks.ts);
// only session.ts creates and destroys it.
import { useSyncExternalStore } from "react";
import {
  ClientEvent,
  createClient,
  HttpApiEvent,
  IndexedDBStore,
  MemoryStore,
  PendingEventOrdering,
  type MatrixClient,
  type Store,
  type SyncState,
  type SyncStateData,
} from "matrix-js-sdk";
import { createLogger } from "@/core/log";
import { MATRIX_ORIGIN, homeserverAllowed, installBearerGuard, noteMatrixToken, setMatrixTokenSource } from "@/core/bearer";
import { matrixFetch } from "@/core/net";
import { guardUnsyncedSends } from "./sendGuard";
import { deviceDisplayName } from "./deviceName";

installBearerGuard();
// the guard polices THE Matrix token (lazy: `current` is read at request time)
setMatrixTokenSource(() => peekClient()?.getAccessToken() ?? null);

const log = createLogger("client");

export const CRYPTO_DB_PREFIX = "tinhat-web";
export const SYNC_DB_NAME = "tinhat-web-sync";
/** IndexedDB database names owned by Tin Hat Web (wiped on logout / fresh login). */
export const OWNED_IDB_NAMES = [
  `${CRYPTO_DB_PREFIX}::matrix-sdk-crypto`,
  `${CRYPTO_DB_PREFIX}::matrix-sdk-crypto-meta`,
  `matrix-js-sdk:${SYNC_DB_NAME}`,
];
/** initial_device_display_name for new logins (native: "Tin Hat (Linux)" / "Tin Hat (Windows)"; deviceName.ts). */
export const DEVICE_DISPLAY_NAME: string = typeof navigator === "undefined" ? "Tin Hat Web" : deviceDisplayName(navigator.userAgent);

export interface Credentials {
  hsUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
}

/**
 * Secret-storage (4S) keys the crypto callbacks may hand to the SDK. crypto.ts fills this only
 * for the duration of a recover / set-up-recovery operation and clears it afterwards — the
 * Security Key is never persisted.
 */
export const secretStorageKeyCache = new Map<string, Uint8Array<ArrayBuffer>>();

// ---- current client (observable) -------------------------------------------------------------

let current: MatrixClient | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

function publish(c: MatrixClient | null) {
  current = c;
  epoch++;
  for (const l of listeners) l();
}

/** The signed-in client. Throws before login / after logout. */
export function getClient(): MatrixClient {
  if (!current) throw new Error("Not signed in");
  return current;
}

/** The client if there is one (never throws). */
export function peekClient(): MatrixClient | null {
  return current;
}

/** Bumps every time the client is replaced (login / logout) — handy as a cache key. */
export function getClientEpoch(): number {
  return epoch;
}

export function onClientChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- session-end hooks (calls: end the call BEFORE the session goes; Astra calls finding 6) ----------

export type SessionEndReason = "logout" | "token" | "takeover";
type SessionEndHook = (why: SessionEndReason) => void | Promise<void>;
const endHooks = new Set<SessionEndHook>();

/** Register work that must run while the departing session can still talk to the server. */
export function onSessionEnding(h: SessionEndHook): () => void {
  endHooks.add(h);
  return () => endHooks.delete(h);
}

/** Run every session-end hook, bounded by `boundMs` (sign-out / takeover never hang on them). */
export async function runSessionEnding(why: SessionEndReason, boundMs = 4000): Promise<void> {
  const all = [...endHooks].map((h) => {
    try {
      return Promise.resolve(h(why)).catch((e: unknown) => log.warn("session-end hook", e));
    } catch (e) {
      log.warn("session-end hook", e);
      return Promise.resolve();
    }
  });
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, boundMs))]);
}

/** React: the current client or null (re-renders on login/logout). */
export function useClient(): MatrixClient | null {
  return useSyncExternalStore(onClientChanged, peekClient, peekClient);
}

// ---- one-tab lock ----------------------------------------------------------------------------

const LOCK_NAME = "tinhat-web-client";
let releaseLock: (() => void) | null = null;

/**
 * Take the exclusive tab lock. `steal` takes it from another tab (that tab's `onLost` fires and
 * it shuts its client down). Resolves false if another tab holds it and steal is false.
 * Browsers without the Web Locks API always get true (best effort).
 */
export async function acquireTabLock(opts: { steal?: boolean; onLost?: () => void } = {}): Promise<boolean> {
  if (releaseLock) return true;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const holder = new Promise<void>((res) => {
      releaseLock = () => {
        releaseLock = null;
        res();
      };
    });
    const cb = (lock: Lock | null) => {
      if (!lock) {
        releaseLock = null;
        settled = true;
        resolve(false);
        return undefined;
      }
      settled = true;
      resolve(true);
      return holder;
    };
    const p = opts.steal
      ? locks.request(LOCK_NAME, { steal: true }, cb)
      : locks.request(LOCK_NAME, { ifAvailable: true }, cb);
    p.catch((e: unknown) => {
      // AbortError = another tab stole the lock from us.
      const wasHeld = releaseLock !== null;
      releaseLock = null;
      if (!settled) resolve(false);
      if (wasHeld) {
        log.warn("tab lock taken by another tab", e);
        opts.onLost?.();
      }
    });
  });
}

export function releaseTabLock(): void {
  releaseLock?.();
}

/** Does this tab own the session (or the browser has no Web Locks, so it can't know)? */
export function holdsTabLock(): boolean {
  return releaseLock !== null || typeof navigator === "undefined" || !navigator.locks;
}

// ---- stores ----------------------------------------------------------------------------------

export type StoreKind = "worker" | "local" | "memory";

function makeStore(kind: StoreKind): Store {
  if (kind === "memory" || typeof indexedDB === "undefined") return new MemoryStore();
  return new IndexedDBStore({
    indexedDB,
    dbName: SYNC_DB_NAME,
    // Worker-backed keeps the big sync JSON (de)serialisation off the UI thread; the SDK itself
    // falls back to the in-thread backend if the worker can't connect.
    workerFactory:
      kind === "worker"
        ? () => new Worker(new URL("./sync.worker.ts", import.meta.url), { type: "module" })
        : undefined,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Delete one IndexedDB database; resolves even when blocked/failed (logs it). */
export function deleteIdb(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve();
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      if (why !== "ok") log.warn(`deleteDatabase ${name}: ${why}`);
      resolve();
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => finish("ok");
      req.onerror = () => finish(String(req.error));
      // Blocked = a connection is still open (the Rust crypto machine releases its store late — seen
      // ~17 s after a device-list change — or another tab). The delete stays queued and completes the
      // moment that connection closes (a later open waits behind it), so don't hold sign-out hostage.
      req.onblocked = () => {
        log.warn(`deleteDatabase ${name}: blocked (open elsewhere) — queued, finishing in the background`);
        setTimeout(() => finish("blocked (queued)"), 400);
      };
      // (a second delete queued behind a blocked one gets no "blocked" event — bound it too; it still
      // completes in the background)
      setTimeout(() => finish("timeout (queued)"), 3000);
    } catch (e) {
      finish(String(e));
    }
  });
}

/** Wipe every Tin Hat Web IndexedDB database (crypto + sync). The client must be stopped. */
export async function wipeLocalStores(): Promise<void> {
  await Promise.all(OWNED_IDB_NAMES.map(deleteIdb));
}

/** Which of our IndexedDB databases exist right now (diagnostics / tests). */
export async function listOwnedDatabases(): Promise<string[]> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return [];
  const all = await indexedDB.databases();
  return all.map((d) => d.name ?? "").filter((n) => OWNED_IDB_NAMES.includes(n));
}

// ---- lifecycle -------------------------------------------------------------------------------

export interface StartHooks {
  onSyncState(state: SyncState, prev: SyncState | null, data?: SyncStateData): void;
  /** The server rejected our token (M_UNKNOWN_TOKEN): the session is over. */
  onSessionLoggedOut(): void;
}

export interface StartedClient {
  client: MatrixClient;
  storeKind: StoreKind;
}

let detach: (() => void) | null = null;

/**
 * Build the client for `creds`, open the stores, initialise Rust crypto and start syncing.
 * Publishes the client (getClient/useClient) BEFORE the first sync so hooks see every event.
 * Throws a plain Error if crypto can't start (e.g. the crypto store belongs to another device).
 */
export async function createAndStartClient(creds: Credentials, hooks: StartHooks): Promise<StartedClient> {
  // Credentials only ever go to our homeserver (Astra calls finding 12) — checked before the client
  // (and its token) exists.
  if (!homeserverAllowed(creds.hsUrl)) throw new Error(`Tin Hat only signs in to ${MATRIX_ORIGIN} (this session points at ${creds.hsUrl})`);
  noteMatrixToken(creds.accessToken);
  if (current) await stopClient();

  // js-sdk 42: IndexedDBStore.startup() must run AFTER the store is handed to createClient.
  let built: MatrixClient | null = null;
  let kind: StoreKind = "memory";
  for (const k of ["worker", "local", "memory"] as StoreKind[]) {
    const store = makeStore(k);
    const c = createClient({
      baseUrl: creds.hsUrl,
      userId: creds.userId,
      deviceId: creds.deviceId,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      store,
      timelineSupport: true, // permalinks / jump-to-event
      useAuthorizationHeader: true,
      // every request bounded + cut when it outlived a page suspension (iOS app switch) — core/net.ts
      fetchFn: matrixFetch,
      verificationMethods: ["m.sas.v1"],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          for (const id of Object.keys(keys)) {
            const key = secretStorageKeyCache.get(id);
            if (key) return [id, key];
          }
          return null;
        },
        cacheSecretStorageKey: (keyId, _info, key) => {
          secretStorageKeyCache.set(keyId, key);
        },
      },
    });
    if (store instanceof IndexedDBStore) {
      try {
        await withTimeout(store.startup(), 20000, `${k} store startup`);
      } catch (e) {
        log.warn(`${k} IndexedDB sync store failed; trying the next option`, e);
        continue;
      }
    }
    built = c;
    kind = k;
    break;
  }
  if (!built) throw new Error("could not create the Matrix client");
  const client: MatrixClient = built;
  log.info(`sync store: ${kind}`);
  // 2026-10-23: never a timeline event into a room js-sdk hasn't synced (it would go out unencrypted) — sendGuard.ts
  guardUnsyncedSends(client);

  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX });
  } catch (e) {
    log.error("initRustCrypto failed", e);
    client.stopClient();
    throw e instanceof Error ? e : new Error(String(e));
  }

  const onSync = (state: SyncState, prev: SyncState | null, data?: SyncStateData) => hooks.onSyncState(state, prev, data);
  const onLoggedOut = () => hooks.onSessionLoggedOut();
  client.on(ClientEvent.Sync, onSync);
  client.on(HttpApiEvent.SessionLoggedOut, onLoggedOut);
  detach = () => {
    client.off(ClientEvent.Sync, onSync);
    client.off(HttpApiEvent.SessionLoggedOut, onLoggedOut);
  };

  publish(client);

  await client.startClient({
    // REACH A1: syncing never marks us online in Synapse's own presence (every /sync carries
    // set_presence=offline). Tin Hat's status is the opt-in service only (features/presence).
    disablePresence: true,
    lazyLoadMembers: true,
    initialSyncLimit: 20,
    threadSupport: false, // Tin Hat has no threads UI: replies stay in the main timeline (native parity)
    pendingEventOrdering: PendingEventOrdering.Detached,
  });
  return { client, storeKind: kind };
}

/** Stop syncing and drop the client. With `wipe`, delete this device's stores afterwards. */
export async function stopClient(opts: { wipe?: boolean } = {}): Promise<void> {
  const c = current;
  detach?.();
  detach = null;
  if (c) {
    try {
      c.stopClient();
    } catch (e) {
      log.warn("stopClient", e);
    }
  }
  publish(null);
  if (c && opts.wipe) {
    // Not c.clearStores(): it waits unbounded on a crypto-store delete that a late-released Rust
    // connection keeps "blocked" (seen ~17 s), issues the -meta delete only AFTER that one finishes (so
    // it can land after a quick re-login and wipe the NEW meta store). Instead: close + clear the sync
    // store (bounded), then queue every owned delete at once (deleteIdb) — a later open of any of them
    // waits behind its delete, so a re-login always starts from empty stores.
    const syncCleared = Promise.resolve()
      .then(() => c.store.deleteAllData())
      .then(
        () => true,
        (e) => (log.warn("store.deleteAllData", e), true),
      );
    if (!(await Promise.race([syncCleared, new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]))) log.warn("sync store still closing — continuing");
    await wipeLocalStores();
  }
  if (c) c.removeAllListeners();
  secretStorageKeyCache.clear();
}

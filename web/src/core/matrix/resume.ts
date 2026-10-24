// resume.ts — the Matrix side of "the page is back" (core/lifecycle.ts), for iOS app switches, frozen
// tabs, the back/forward cache and a sleeping laptop:
//   • cut requests that were in flight across the suspension (core/net.ts) and restart the sync at
//     once instead of waiting out the SDK's 2–7 s keepalive back-off (or a dead long-poll's 110 s);
//   • a watchdog: no completed sync 12 s after the return → cut the /sync in flight again (twice);
//   • re-kick the to-device queue (call keys) and the crypto request loop once the sync is back — the
//     SDK's queue gives up after a network failure until the sync state flips, and a key that never
//     leaves means nobody can hear us;
//   • iOS "Connection to Indexed Database server lost": the crypto store is gone for this page (every
//     key send / decrypt fails until a reload). Detected by a probe on return + the SDK's sync errors;
//     `onStorageLost` hooks run (the call engine stashes a rejoin), then ONE automatic reload (never
//     twice within 3 min — a second loss shows a "close and reopen" notice instead).
import { ClientEvent, SyncState, type MatrixClient } from "matrix-js-sdk";
import { onPageResume, type ResumeInfo } from "@/core/lifecycle";
import { abortPendingSync, onRequestCut, pendingSyncAgeMs, reapAfterSuspend, setNetLogger } from "@/core/net";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import { onClientChanged, peekClient } from "./client";

const log = createLogger("resume");

// WebKit's wording only ("UnknownError: Connection to Indexed Database server lost. Refresh the page to
// try again") — Chrome's "The database connection is closing" also happens on a normal sign-out wipe.
const IDB_LOST = /Connection to Indexed ?Database server lost/i;
export const RELOAD_MARK = "tinhat.resume.reloadAt";
const PROBE_DB = "tinhat-web-probe";

let installed = false;
let attached: MatrixClient | null = null;
let kickUntil = 0;
let lastGoodSync = 0;
let kickAfterSync = false;
const watchTimers: Array<ReturnType<typeof setTimeout>> = [];

function goodState(s: SyncState): boolean {
  return s === SyncState.Syncing || s === SyncState.Prepared;
}

function onSync(state: SyncState) {
  if (goodState(state)) {
    lastGoodSync = Date.now();
    if (kickAfterSync) {
      kickAfterSync = false;
      kickSenders("the sync is back");
    }
    return;
  }
  // Reconnecting / Error right after a return: skip the SDK's 2–7 s (then 5–10 s) keepalive back-off —
  // but at most one poke per RETRY_GAP_MS. Every failed keepalive emits Error again, so an unpaced retry
  // spins: back with no network (a phone in a lift, Wi-Fi not re-associated yet) a failed fetch returns
  // at once and the loop sent ~150 /versions requests a second for the whole window.
  if ((state === SyncState.Reconnecting || state === SyncState.Error) && Date.now() < kickUntil) retrySoon();
}

/** Minimum spacing of our immediate sync retries (the SDK's own back-off is 2–10 s). */
const RETRY_GAP_MS = 2000;
let lastRetry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function retryNow(c: MatrixClient | null = peekClient()): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  lastRetry = Date.now();
  c?.retryImmediately();
}

function retrySoon(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const c = peekClient();
    const s = c?.getSyncState();
    if (Date.now() < kickUntil && (s === SyncState.Reconnecting || s === SyncState.Error)) retryNow(c);
  }, Math.max(0, lastRetry + RETRY_GAP_MS - Date.now()));
}

function onSyncError(e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  if (IDB_LOST.test(msg)) void storageLost(`sync: ${msg}`);
}

function attach() {
  const c = peekClient();
  if (c === attached) return;
  attached?.off(ClientEvent.Sync, onSync);
  attached?.off(ClientEvent.SyncUnexpectedError, onSyncError);
  attached = c;
  c?.on(ClientEvent.Sync, onSync);
  c?.on(ClientEvent.SyncUnexpectedError, onSyncError);
}

/** Re-run the to-device queue (call keys) and the crypto request loop. Both are idempotent. */
export function kickSenders(why: string): void {
  const c = peekClient();
  if (!c) return;
  try {
    const q = Reflect.get(c, "toDeviceMessageQueue") as { sendQueue?: () => Promise<void> } | undefined;
    void q?.sendQueue?.().catch(() => undefined);
    const crypto = c.getCrypto();
    const orm = crypto ? (Reflect.get(crypto, "outgoingRequestsManager") as { doProcessOutgoingRequests?: () => Promise<void> } | undefined) : undefined;
    void orm?.doProcessOutgoingRequests?.().catch(() => undefined);
    log.info(`re-kicked the to-device queue + crypto requests (${why})`);
  } catch (e) {
    log.debug("kickSenders", e);
  }
}

function onResume(info: ResumeInfo) {
  const c = peekClient();
  if (!c) return;
  const cut = reapAfterSuspend(info);
  const state = c.getSyncState();
  if (info.suspect || state === SyncState.Error || state === SyncState.Reconnecting) {
    kickUntil = Date.now() + 15_000;
    kickAfterSync = true;
    if (state === SyncState.Error || state === SyncState.Reconnecting) retryNow(c);
    log.info(`sync after the return: state ${state ?? "?"}, ${cut} request(s) cut`);
  }
  if (!info.suspect) return;
  for (const t of watchTimers.splice(0)) clearTimeout(t);
  const since = info.at;
  for (const [delay, round] of [
    [12_000, 1],
    [30_000, 2],
  ] as const) {
    watchTimers.push(
      setTimeout(() => {
        const cc = peekClient();
        if (!cc || cc !== c || lastGoodSync >= since) return;
        const age = pendingSyncAgeMs();
        log.warn(`no completed sync ${delay / 1000} s after the return (state ${cc.getSyncState() ?? "?"}, sync request age ${age < 0 ? "none" : Math.round(age / 1000) + " s"}) — restart ${round}`);
        if (age >= 10_000) abortPendingSync("no sync answer since the page came back");
        kickUntil = Date.now() + 15_000;
        kickAfterSync = true;
        retryNow(cc);
      }, delay),
    );
  }
  void probeIdb().then((ok) => {
    if (ok === false) void storageLost("IndexedDB probe after the return failed");
  });
}

/** true = IndexedDB works, false = the iOS "server lost" failure, null = inconclusive. */
export function probeIdb(): Promise<boolean | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let done = false;
    const fin = (v: boolean | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => fin(null), 4000);
    const judge = (e: unknown) => fin(IDB_LOST.test(String((e as Error)?.message ?? e)) ? false : null);
    try {
      const req = indexedDB.open(PROBE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("p");
      req.onerror = () => judge(req.error);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction("p", "readwrite");
          tx.objectStore("p").put(Date.now(), "t");
          tx.oncomplete = () => (db.close(), fin(true));
          tx.onerror = () => (db.close(), judge(tx.error));
          tx.onabort = () => (db.close(), judge(tx.error));
        } catch (e) {
          db.close();
          judge(e);
        }
      };
    } catch (e) {
      judge(e);
    }
  });
}

// ---- storage lost -------------------------------------------------------------------------------------

type LostHook = (why: string) => void | Promise<void>;
const lostHooks = new Set<LostHook>();
let lostRun: Promise<void> | null = null;

/** Work to do before the page reloads after IndexedDB was lost (the call engine: remember the call). */
export function onStorageLost(h: LostHook): () => void {
  lostHooks.add(h);
  return () => lostHooks.delete(h);
}

export function storageLost(why: string): Promise<void> {
  if (lostRun) return lostRun;
  lostRun = (async () => {
    log.error(`local storage (IndexedDB) lost: ${why}`);
    // Decide first: reload only when the once-per-3-min guard can be read AND written (a guard that can't
    // be persisted would let every fresh page reload again). No reload → no hooks (nothing to rejoin).
    let reload = false;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_MARK) || 0);
      if (Date.now() - last >= 180_000) {
        const stamp = String(Date.now());
        sessionStorage.setItem(RELOAD_MARK, stamp);
        reload = sessionStorage.getItem(RELOAD_MARK) === stamp;
      }
    } catch {
      reload = false;
    }
    if (!reload) {
      toast("Tin Hat lost its local storage while it was in the background. Close the app completely and open it again.", { kind: "error", timeoutMs: 15000 });
      return;
    }
    const hooks = [...lostHooks].map((h) => Promise.resolve().then(() => h(why)).catch((e: unknown) => log.warn("storage-lost hook", e)));
    await Promise.race([Promise.all(hooks), new Promise((r) => setTimeout(r, 3000))]);
    toast("Reconnecting Tin Hat…", { timeoutMs: 3000 });
    setTimeout(() => location.reload(), 300);
  })();
  return lostRun;
}

export function installMatrixResume(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  setNetLogger(createLogger("net"));
  attach();
  onClientChanged(attach);
  onPageResume(onResume);
  onRequestCut((path) => {
    if (/\/sendToDevice\//.test(path)) setTimeout(() => kickSenders("a to-device request was cut"), 3000);
  });
  const lostIn = (v: unknown) => {
    const msg = String((v as Error)?.message ?? v ?? "");
    if (IDB_LOST.test(msg)) void storageLost(msg);
  };
  window.addEventListener("unhandledrejection", (e) => lostIn(e.reason));
  window.addEventListener("error", (e) => lostIn(e.error ?? e.message));
}

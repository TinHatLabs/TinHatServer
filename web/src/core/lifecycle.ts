// lifecycle.ts — "the page was away" signals: an iOS app switch (Safari or the home-screen app suspends
// the page), a frozen background tab, a restore from the back/forward cache, a laptop that slept with the
// tab open, or the network coming back. One coalesced `onPageResume(info)` per return, so the Matrix
// sync, the HTTP layer and the call engine can each check what died while the page wasn't running.
//
//   onPageHide(cb)    the page went away (hidden / pagehide / freeze) — do nothing expensive here
//   onPageResume(cb)  the page is back; `info.suspect` = long enough away that sockets may be dead
//   pageEpoch()       bumps at every hide: a request started in an older epoch outlived a hide
//
// Nothing here tears anything down: iOS may keep audio running in the background, and a desktop tab
// switch must stay free. The listeners decide what to check.
import { createLogger } from "@/core/log";

const log = createLogger("lifecycle");

export interface ResumeInfo {
  /** what brought us back first ("visible", "pageshow", "resume", "online", "gap") */
  via: string;
  /** how long the page was hidden (0 = it never was, e.g. online / timer gap) */
  hiddenMs: number;
  /** Chrome froze the page (freeze event) or restored it from the back/forward cache */
  frozen: boolean;
  /** restored from the back/forward cache (pageshow.persisted) */
  persisted: boolean;
  /** longest gap between two 1 s heartbeat ticks since the hide (a suspended page runs no timers) */
  gapMs: number;
  /** hard evidence the page did not run or had no network: a timer gap, frozen, the back/forward cache,
   *  offline meanwhile — sockets and everything in flight across it are probably dead */
  suspended: boolean;
  /** the network went away meanwhile (offline → online) — every socket from before is dead */
  offline: boolean;
  /** suspended, or hidden >= 30 s: a long-poll in flight may be dead */
  suspect: boolean;
  at: number;
}

type HideCb = (why: string) => void;
type ResumeCb = (info: ResumeInfo) => void;

const hideCbs = new Set<HideCb>();
const resumeCbs = new Set<ResumeCb>();

let installed = false;
let epoch = 0;
let hiddenAt = 0; // Date.now() of the hide (0 = visible)
let frozen = false;
let persisted = false;
let maxGap = 0;
let lastTick = 0;
let netBack = false; // the network came back while the page was hidden
let pending: ResumeInfo | null = null;
let lastResume: ResumeInfo | null = null;

/** Hidden this long → treat sockets / long-polls as suspect even if the page kept running. */
export const SUSPECT_HIDDEN_MS = 30000;
/** A heartbeat gap this long while hidden = the page was suspended (iOS app switch, frozen tab, sleep).
 *  (A desktop background tab keeps a 1 s heartbeat for its first 5 minutes: a short tab switch costs nothing.) */
export const SUSPECT_GAP_MS = 5000;
/** A gap this long while VISIBLE = the machine slept / the page was stopped (a busy main thread stays below). */
export const VISIBLE_GAP_MS = 10000;

export function pageEpoch(): number {
  return epoch;
}

export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** The last resume (tests / diagnostics). */
export function lastPageResume(): ResumeInfo | null {
  return lastResume;
}

export function onPageHide(cb: HideCb): () => void {
  install();
  hideCbs.add(cb);
  return () => hideCbs.delete(cb);
}

export function onPageResume(cb: ResumeCb): () => void {
  install();
  resumeCbs.add(cb);
  return () => resumeCbs.delete(cb);
}

/** Resolves once the page is visible (at once when it already is). */
export function whenVisible(): Promise<void> {
  if (!pageHidden()) return Promise.resolve();
  return new Promise((resolve) => {
    const f = () => {
      if (pageHidden()) return;
      document.removeEventListener("visibilitychange", f);
      resolve();
    };
    document.addEventListener("visibilitychange", f);
  });
}

function markHidden(why: string) {
  if (!hiddenAt) {
    hiddenAt = Date.now();
    epoch++;
    maxGap = 0;
    log.info(`page away (${why})`);
    for (const cb of hideCbs) {
      try {
        cb(why);
      } catch (e) {
        log.warn("hide hook", e);
      }
    }
  }
}

function markBack(via: string) {
  const now = Date.now();
  const hiddenMs = hiddenAt ? now - hiddenAt : 0;
  const gapMs = Math.max(maxGap, lastTick ? now - lastTick : 0);
  const info: ResumeInfo = {
    via,
    hiddenMs,
    frozen,
    persisted,
    gapMs,
    suspended: frozen || persisted || netBack || gapMs >= SUSPECT_GAP_MS || via === "online",
    offline: netBack || via === "online",
    suspect: false,
    at: now,
  };
  info.suspect = info.suspended || hiddenMs >= SUSPECT_HIDDEN_MS;
  hiddenAt = 0;
  netBack = false;
  frozen = false;
  persisted = false;
  maxGap = 0;
  lastTick = now;
  // Coalesce: iOS / Chrome fire several of these for one return (resume + visibilitychange + pageshow).
  if (pending) {
    pending.hiddenMs = Math.max(pending.hiddenMs, info.hiddenMs);
    pending.gapMs = Math.max(pending.gapMs, info.gapMs);
    pending.frozen ||= info.frozen;
    pending.persisted ||= info.persisted;
    pending.suspended ||= info.suspended;
    pending.offline ||= info.offline;
    pending.suspect ||= info.suspect;
    return;
  }
  pending = info;
  setTimeout(() => {
    const p = pending;
    pending = null;
    if (!p) return;
    lastResume = p;
    log.info(
      `page back via ${p.via}: away ${Math.round(p.hiddenMs / 1000)} s, longest timer gap ${Math.round(p.gapMs / 1000)} s${p.frozen ? ", was frozen" : ""}${p.persisted ? ", from the back/forward cache" : ""}${p.suspect ? " → checking connections" : ""}`,
    );
    for (const cb of resumeCbs) {
      try {
        cb(p);
      } catch (e) {
        log.warn("resume hook", e);
      }
    }
  }, 60);
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (pageHidden()) hiddenAt = Date.now();
  lastTick = Date.now();
  // Heartbeat: a suspended page (iOS) or a sleeping machine runs no timers — the gap shows it.
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (hiddenAt) {
      if (gap > maxGap) maxGap = gap;
    } else if (gap >= VISIBLE_GAP_MS) {
      // visible the whole time but not running (laptop lid, debugger, a frozen foreground page)
      maxGap = gap;
      lastTick = now - gap; // markBack measures the gap again
      markBack("gap");
    }
  }, 1000);
  document.addEventListener("visibilitychange", () => (pageHidden() ? markHidden("hidden") : markBack("visible")));
  window.addEventListener("pagehide", (e) => {
    if ((e as PageTransitionEvent).persisted) persisted = true;
    markHidden("pagehide");
  });
  window.addEventListener("pageshow", (e) => {
    if (!(e as PageTransitionEvent).persisted) return; // a normal load
    persisted = true;
    if (!hiddenAt) hiddenAt = Date.now();
    markBack("pageshow");
  });
  document.addEventListener("freeze", () => {
    frozen = true;
    markHidden("freeze");
  });
  document.addEventListener("resume", () => {
    frozen = true;
    if (!pageHidden()) markBack("resume");
  });
  window.addEventListener("online", () => {
    if (pageHidden()) netBack = true; // checked when the page comes back
    else markBack("online");
  });
  window.addEventListener("offline", () => log.info("browser says offline"));
}

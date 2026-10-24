// runtime.ts — REACH §2 web wiring: the presence store, the sender (machine.ts on the real clock, the page's
// input/visibility and the call store), the reader (GET /api/presence), and the user actions behind the
// switch, the one-time card and the status picker.
//
//   usePresenceStore            {users (GET map), share/asked/status (account data), sending, turningOff, …}
//   installPresence()           once (feature setup): follows sign-in / sign-out
//   turnSharingOn({answer?})    explicit user action → share:true + asked (parity item f)
//   turnSharingOff()            this device stops AT ONCE and its own entry leaves the map; share:false is PUT
//                               (unconditional, retried until the server answers), then DELETE until 204 —
//                               "Turning off…" meanwhile (A2.2 + web review #1)
//   answerQuestion(false)       "No thanks" → asked only
//   setMyStatus(s|null)         the picker / Clear status (A4.6); refresh beat + a re-read right after
//
// Sessions (web review #6/#10): every task — the off transaction, the DELETE retries, the reader, the status
// clean-up — belongs to the session generation that started it; a sign-out / account switch cancels it, and
// a late answer of an old session never lands in the next one.
// Logs never carry our own state or status (parity item i).
import { create } from "zustand";
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { apiFetch } from "@/core/api";
import { bus } from "@/core/bus";
import { getFormFactor } from "@/core/device";
import { createLogger } from "@/core/log";
import { getSession, onClientChanged, onSessionEnding, peekClient, useSessionStore } from "@/core/matrix";
import { onServerOffer, serverFeatureOn } from "@/core/server";
import { useCallStore } from "@/features/calls";
import { PresenceSender, type Beat, type BeatResult, type Clock } from "./machine";
import { MAP_KEEP_MS, READ_MIN_GAP_MS, beatOutcome, keepMap, nextBackoff, parseUsers, readInterval } from "./model";
import { PRESENCE_ASKED_TYPE, PRESENCE_STATUS_TYPE, PRESENCE_TYPE, readAsked, readShare, readStatus, readStatusRaw, writeAskedRaw, writeShareRaw, writeStatus } from "./pref";
import type { CustomStatus, PresenceState } from "./status";
import { zonesOf } from "@/widgets/clocks";
import { tzSharingNow } from "./tz";

const log = createLogger("presence");

// ---- store ----------------------------------------------------------------------------------------------

export interface PresenceRow {
  state: PresenceState;
  /** the call's room — only when the reader is joined to it */
  room?: string;
  /** A4.4: a valid, unexpired custom status */
  status?: { text: string; emoji?: string; color: string };
}

export interface PresenceStore {
  /** GET /api/presence: mxid → row (absent = no dot) */
  users: Record<string, PresenceRow>;
  /** REACH A7: mxid → IANA zone (GET ?tz=1, only while a Friends' clocks widget wants it) */
  zones: Record<string, string>;
  /** last successful read (ms) */
  okAt: number;
  /** the account data is known (first sync done) */
  known: boolean;
  /** the first NETWORK sync is done (the one-time card never trusts a cached copy) */
  live: boolean;
  share: boolean;
  asked: boolean;
  /** our own custom status (account data), when it shows now */
  status: CustomStatus | null;
  /** this device beats right now */
  sending: boolean;
  /** the server said not_sharing — waiting for the account data to say share: true again */
  blocked: boolean;
  /** A2.2: switched off here; share:false and/or the DELETE haven't been confirmed yet */
  turningOff: boolean;
  /** a switch write is in flight */
  busy: boolean;
  error: string;
}

const EMPTY: PresenceStore = {
  users: {},
  zones: {},
  okAt: 0,
  known: false,
  live: false,
  share: false,
  asked: false,
  status: null,
  sending: false,
  blocked: false,
  turningOff: false,
  busy: false,
  error: "",
};

export const usePresenceStore = create<PresenceStore>()(() => ({ ...EMPTY }));
const patch = (p: Partial<PresenceStore>) => usePresenceStore.setState(p);

// ---- sessions, cancellable tasks ---------------------------------------------------------------------------

/** Bumps on every client change (sign-in, sign-out, account switch). */
let clientGen = 0;

interface Task {
  gen: number;
  cancelled: boolean;
  /** ends a sleep early (cancel) */
  wake: () => void;
}

function newTask(): Task {
  return { gen: clientGen, cancelled: false, wake: () => undefined };
}

function cancelTask(t: Task | null): void {
  if (!t) return;
  t.cancelled = true;
  t.wake();
}

const alive = (t: Task) => !t.cancelled && t.gen === clientGen;

function sleepFor(t: Task, ms: number): Promise<void> {
  return new Promise((res) => {
    const id = window.setTimeout(res, ms);
    t.wake = () => {
      window.clearTimeout(id);
      res();
    };
  });
}

function errText(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e);
}

const me = () => getSession().userId ?? "";

// ---- consent written here, not yet echoed by /sync (the raw PUT doesn't touch the SDK's store) ---------------------

let pending: { gen: number; share?: boolean; asked?: boolean } = { gen: -1 };

function pendingNow(): typeof pending {
  if (pending.gen !== clientGen) pending = { gen: clientGen };
  return pending;
}

/** Sharing as this device knows it: a write of ours not yet echoed wins over the SDK's cached copy. */
export function sharingNow(c = peekClient()): boolean {
  const p = pendingNow();
  return p.share ?? readShare(c);
}

function askedNow(c = peekClient()): boolean {
  return pendingNow().asked === true || readAsked(c);
}

/** Consent writes go out one at a time, in the order the person flipped the switch. */
let consentChain: Promise<unknown> = Promise.resolve();
function consentWrite(c: MatrixClient, share: boolean): Promise<void> {
  const p = consentChain.then(() => writeShareRaw(c, share));
  consentChain = p.catch(() => undefined);
  return p;
}

/** Parity item f: every explicit choice also answers the one-time question. */
function markAsked(c: MatrixClient): void {
  if (askedNow(c)) return;
  const gen = clientGen;
  pendingNow().asked = true;
  patch({ asked: true });
  writeAskedRaw(c).catch((e) => {
    if (gen === clientGen) log.warn(`saving the answer failed: ${errText(e)}`);
  });
}

/** Item 2: the moment sharing is off here (switch or sync), our own row leaves the map — the footer, the member
 *  list and the profile card stop showing us without waiting for the next GET. */
function dropOwnEntry(): void {
  const id = me();
  const { users } = usePresenceStore.getState();
  if (!id || !users[id]) return;
  const next = { ...users };
  delete next[id];
  patch({ users: next });
}

// ---- HTTP (same-origin /api, the Matrix bearer) --------------------------------------------------------------

async function putBeat(b: Beat, keepalive: boolean): Promise<BeatResult> {
  try {
    const r = await apiFetch("/presence", { method: "PUT", auth: true, json: b, keepalive, timeoutMs: keepalive ? 0 : 12_000 });
    let body: unknown = null;
    if (r.status === 409) body = await r.json().catch(() => null);
    const o = beatOutcome(r.status, body);
    return o === "retry" ? "error" : o;
  } catch {
    return "error";
  }
}

async function deleteOnce(thisDevice: boolean, bearer?: string): Promise<boolean> {
  try {
    const r = await apiFetch(thisDevice ? "/presence?device=this" : "/presence", { method: "DELETE", auth: true, bearer, timeoutMs: 8_000 });
    return r.status === 204 || r.ok;
  } catch {
    return false;
  }
}

/** The off switch's DELETE /api/presence, retried with backoff (2 s, 4 s … 60 s) until it answers 204 (A2.2).
 *  One per session: a sign-out / account switch cancels it — an old session's retry never swallows the next
 *  session's request (web review #6). */
let removeTask: (Task & { promise: Promise<boolean> }) | null = null;
function removeWithRetry(): Promise<boolean> {
  if (removeTask && alive(removeTask)) return removeTask.promise;
  cancelTask(removeTask);
  const t = newTask() as Task & { promise: Promise<boolean> };
  const bearer = peekClient()?.getAccessToken() ?? undefined;
  t.promise = (async () => {
    let wait: number | null = null;
    for (;;) {
      if (!alive(t)) return false;
      if (await deleteOnce(false, bearer)) return true;
      if (!alive(t)) return false;
      wait = nextBackoff(wait);
      log.info(`presence off: the server didn't confirm — again in ${wait / 1000} s`);
      await sleepFor(t, wait);
    }
  })().finally(() => {
    if (removeTask === t) removeTask = null;
  });
  removeTask = t;
  return t.promise;
}

// ---- the sender ------------------------------------------------------------------------------------------

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

let beatsSent = false;
let lastAckKey = ""; // the last state|call the server acknowledged from this device
const sender = new PresenceSender(
  clock,
  {
    beat: (b, keepalive) => {
      beatsSent = true;
      return putBeat(b, keepalive).then((res) => {
        // our own state changed on the server: read the map now (the 5 s gap allowing) so the footer and
        // "Others see you as" follow within seconds instead of the next 20 s read
        const key = `${b.state}|${b.call ?? ""}`;
        if (res === "ok" && !keepalive && key !== lastAckKey) {
          lastAckKey = key;
          void readNow();
        }
        return res;
      });
    },
    // sharing went off on ANOTHER device (seen via sync): stop, and DELETE until the server confirms
    remove: async () => {
      patch({ turningOff: true });
      const gen = clientGen;
      const ok = await removeWithRetry();
      if (ok && gen === clientGen && !offTask) patch({ turningOff: false });
    },
  },
  () => (getFormFactor() === "mobile" ? "phone" : "desktop"),
  () => patch({ sending: sender.active, blocked: sender.isBlocked }),
);

/** The page's own input, visibility and call → the sender. Installed once. */
function installPageSignals(): void {
  const input = () => sender.input();
  for (const ev of ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"]) window.addEventListener(ev, input, { capture: true, passive: true });
  const vis = () => sender.setHidden(document.visibilityState === "hidden");
  document.addEventListener("visibilitychange", vis);
  window.addEventListener("pagehide", () => sender.setHidden(true));
  window.addEventListener("pageshow", vis);
  const callRoom = (st: { inCall: boolean; callRoomId: string }) => (st.inCall && st.callRoomId ? st.callRoomId : null);
  sender.setCall(callRoom(useCallStore.getState()));
  useCallStore.subscribe((st) => sender.setCall(callRoom(st)));
}

// ---- the reader (one per session — web review #10) ------------------------------------------------------------

interface Reader {
  gen: number;
  inflight: boolean;
  timer: number;
  expiry: number;
  lastReadAt: number;
}

let reader: Reader | null = null;

function scheduleRead(r: Reader, ms: number): void {
  window.clearTimeout(r.timer);
  if (reader !== r) return;
  r.timer = window.setTimeout(() => void readNow(), Math.max(0, ms));
}

/** §2.5: the last good map is kept on errors for at most a minute — checked on its own clock too, so a long
 *  Retry-After or a slow background request can't keep old dots on screen (web review #11). */
function expireIfStale(): void {
  const { okAt, users } = usePresenceStore.getState();
  const { zones } = usePresenceStore.getState();
  if ((Object.keys(users).length || Object.keys(zones).length) && !keepMap(okAt ? Date.now() - okAt : null)) patch({ users: {}, zones: {} });
}

function armExpiry(r: Reader): void {
  window.clearTimeout(r.expiry);
  r.expiry = window.setTimeout(() => {
    if (reader === r) expireIfStale();
  }, MAP_KEEP_MS + 50);
}

// ---- A7: who wants the zones (a shown Friends' clocks widget) ---------------------------------------------------------

let zonesWanted = 0;
/** A Friends' clocks widget is shown: the reader asks for the zones (`?tz=1`) until the returned release is called. */
export function wantZones(): () => void {
  zonesWanted++;
  if (zonesWanted === 1) void readNow();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    zonesWanted = Math.max(0, zonesWanted - 1);
    if (!zonesWanted) patch({ zones: {} });
  };
}

/** GET /api/presence now (or as soon as the 5 s gap allows). */
export async function readNow(): Promise<void> {
  const r = reader;
  if (!r || r.inflight) return;
  const gap = Date.now() - r.lastReadAt;
  if (gap < READ_MIN_GAP_MS) return scheduleRead(r, READ_MIN_GAP_MS - gap);
  r.inflight = true;
  r.lastReadAt = Date.now();
  let next = readInterval(document.visibilityState === "visible");
  try {
    const withTz = zonesWanted > 0;
    const res = await apiFetch(withTz ? "/presence?tz=1" : "/presence", { auth: true, timeoutMs: 12_000 });
    if (reader !== r) return;
    if (res.status === 429) {
      const ra = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(ra) && ra > 0) next = Math.max(next, ra * 1000);
      throw new Error("429");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (reader !== r) return; // an old session's answer never fills the new one
    const users: Record<string, PresenceRow> = {};
    for (const [mxid, seen] of parseUsers(body)) {
      const row: PresenceRow = { state: seen.state };
      if (seen.room) row.room = seen.room;
      if (seen.status) row.status = seen.status;
      users[mxid] = row;
    }
    // item 2: while this device says sharing is off, we never show ourselves (the server may lag its DELETE)
    if (!sharingNow()) delete users[me()];
    // A7: the zones ride on the same read (one GET per 5 s per token); mine goes at once when I switch it off here
    const zones = withTz ? zonesOf(body) : {};
    if (!tzSharingNow()) delete zones[me()];
    patch({ users, zones, okAt: Date.now() });
    armExpiry(r);
  } catch {
    if (reader === r) expireIfStale();
  } finally {
    r.inflight = false;
    if (reader === r) scheduleRead(r, next);
  }
}

function startReader(): void {
  stopReader();
  reader = { gen: clientGen, inflight: false, timer: 0, expiry: 0, lastReadAt: 0 };
  void readNow();
}

function stopReader(): void {
  if (!reader) return;
  window.clearTimeout(reader.timer);
  window.clearTimeout(reader.expiry);
  reader = null;
}

// visible again / focused → drop a stale map at once, then read (§2.5, web review #11)
if (typeof window !== "undefined") {
  const again = () => {
    if (!reader || document.visibilityState !== "visible") return;
    expireIfStale();
    void readNow();
  };
  document.addEventListener("visibilitychange", again);
  window.addEventListener("focus", again);
  window.addEventListener("pageshow", again);
}

// ---- account data → store + sender ----------------------------------------------------------------------------

let expiryTimer = 0;
let cleared = new Set<number>();

/** A4.6: when our status's `until` passes, write `{}` once (never from the cached copy of a cold start). */
function armStatusExpiry(): void {
  window.clearTimeout(expiryTimer);
  const raw = readStatusRaw();
  const until = raw && typeof raw.until === "number" ? raw.until : null;
  if (until === null) return;
  const due = until - Date.now();
  const gen = clientGen;
  expiryTimer = window.setTimeout(
    () => {
      if (gen !== clientGen) return;
      patch({ status: readStatus() });
      const now = readStatusRaw();
      if (!now || now.until !== until || cleared.has(until)) return;
      if (!getSession().liveSyncDone) return void window.setTimeout(armStatusExpiry, 5_000);
      cleared.add(until);
      void writeStatus(null).catch((e) => log.warn(`clearing the expired status failed: ${errText(e)}`));
    },
    Math.max(0, Math.min(due, 2 ** 31 - 1)),
  );
}

function syncFromAccountData(): void {
  patch({ share: sharingNow(), asked: askedNow(), status: readStatus() });
}

let detach: (() => void) | null = null;

function attach(c: MatrixClient): () => void {
  const onAccount = (ev: MatrixEvent) => {
    const t = ev.getType();
    if (t === PRESENCE_TYPE) {
      const share = readShare(c);
      const p = pendingNow();
      // switched off here and that write is still on its way: an older "on" (the echo of a quick on → off)
      // must not restart the beats — the echo of our "off" follows
      if (share && p.share === false && offTask) return;
      // the echo of our own write, or another device's choice: from here on the server's copy is the truth
      delete p.share;
      patch({ share });
      if (!share) dropOwnEntry();
      if (usePresenceStore.getState().known) sender.setShare(share);
      if (share && !offTask) patch({ turningOff: false });
    } else if (t === PRESENCE_ASKED_TYPE) {
      delete pendingNow().asked;
      patch({ asked: askedNow(c) });
    } else if (t === PRESENCE_STATUS_TYPE) {
      patch({ status: readStatus() });
      armStatusExpiry();
    }
  };
  c.on(ClientEvent.AccountData, onAccount);
  return () => c.off(ClientEvent.AccountData, onAccount);
}

function onReady(): void {
  const c = peekClient();
  if (!c) return;
  syncFromAccountData();
  patch({ known: true, live: getSession().liveSyncDone });
  // docs/SELFHOST.md: a server without the Reach presence service gets no beats and no reads (its UI is hidden)
  if (serverFeatureOn("presence")) {
    sender.start(sharingNow(c));
    startReader();
  }
  armStatusExpiry();
}

let installed = false;
export function installPresence(): void {
  if (installed) return;
  installed = true;
  installPageSignals();
  const rebind = () => {
    detach?.();
    detach = null;
    clientGen++;
    // everything the previous session started ends here (web review #6/#10)
    cancelTask(offTask);
    offTask = null;
    cancelTask(removeTask);
    removeTask = null;
    stopReader();
    window.clearTimeout(expiryTimer);
    const c = peekClient();
    if (c) detach = attach(c);
    else {
      sender.stop();
      cleared = new Set();
      beatsSent = false;
      usePresenceStore.setState({ ...EMPTY }, true);
    }
  };
  onClientChanged(rebind);
  rebind();
  bus.on("sessionReady", onReady);
  // the server's offer can arrive (or change) after sign-in: presence off → stop at once and show nobody; on → start
  onServerOffer(() => {
    if (serverFeatureOn("presence")) {
      if (getSession().state === "ready" && !reader) onReady();
    } else {
      sender.stop();
      stopReader();
      patch({ users: {}, zones: {} });
    }
  });
  // the one-time card waits for the first network sync
  useSessionStore.subscribe((s) => {
    if (s.liveSyncDone !== usePresenceStore.getState().live) {
      patch({ live: s.liveSyncDone });
      if (s.liveSyncDone) {
        syncFromAccountData();
        armStatusExpiry();
      }
    }
  });
  // sign-out: this device leaves at once, while the token still works (§2.4); a takeover keeps the device
  onSessionEnding(async (why) => {
    const was = sender.sharing || beatsSent;
    sender.stop();
    stopReader();
    cancelTask(offTask);
    cancelTask(removeTask);
    if (why === "logout" && was) await deleteOnce(true, peekClient()?.getAccessToken() ?? undefined);
  });
}

// ---- user actions ------------------------------------------------------------------------------------------------

/** The running off transaction of this session (share:false written until the server answers, then DELETE). */
let offTask: (Task & { promise: Promise<boolean> }) | null = null;

/** The switch / "Turn on" (explicit user actions only — A2.2). */
export async function turnSharingOn(_opts: { answer?: boolean } = {}): Promise<boolean> {
  const c = peekClient();
  if (!c) return false;
  const gen = clientGen;
  // this explicit choice supersedes a switch-off that is still retrying
  cancelTask(offTask);
  offTask = null;
  cancelTask(removeTask);
  patch({ busy: true, error: "", turningOff: false });
  try {
    await consentWrite(c, true); // after an off write still in flight: the server sees them in order
    if (gen !== clientGen) return false;
    pendingNow().share = true;
    patch({ share: true });
    sender.setShare(true);
    markAsked(c);
    window.setTimeout(() => void readNow(), 800); // "Others see you as" as soon as the server has us
    return true;
  } catch (e) {
    if (gen === clientGen) patch({ error: `Couldn't turn it on: ${errText(e)}` });
    return false;
  } finally {
    if (gen === clientGen) patch({ busy: false });
  }
}

/** A2.2 + web review #1: this device stops publishing NOW (no waiting for any echo) and our own entry leaves the
 *  map; share:false is PUT unconditionally and retried until the server answers; only after that answer the
 *  DELETE runs (until 204). "Turning off…" until both are confirmed; an error line while the server can't be
 *  reached. Resolves true once everything is confirmed. */
export function turnSharingOff(): Promise<boolean> {
  const c = peekClient();
  if (!c) return Promise.resolve(false);
  cancelTask(offTask);
  cancelTask(removeTask);
  pendingNow().share = false;
  sender.setShare(false, { remove: false });
  dropOwnEntry();
  patch({ share: false, turningOff: true, busy: true, error: "" });
  const t = newTask() as Task & { promise: Promise<boolean> };
  t.promise = (async () => {
    let wait: number | null = null;
    for (;;) {
      if (!alive(t)) return false;
      try {
        await consentWrite(c, false);
        break;
      } catch (e) {
        if (!alive(t)) return false;
        wait = nextBackoff(wait);
        patch({ busy: false, error: `Couldn't reach the server — still turning it off (${errText(e)})` });
        await sleepFor(t, wait);
      }
    }
    if (!alive(t)) return false;
    patch({ busy: false, error: "" });
    markAsked(c);
    const ok = await removeWithRetry(); // after the server's answer to share:false (A2.2)
    if (!alive(t)) return false;
    if (ok) patch({ turningOff: false });
    window.setTimeout(() => void readNow(), 800);
    return ok;
  })().finally(() => {
    if (offTask === t) offTask = null;
  });
  offTask = t;
  return t.promise;
}

/** The one-time card: "Turn on" / "No thanks". */
export async function answerQuestion(turnOn: boolean): Promise<void> {
  if (turnOn) {
    await turnSharingOn({ answer: true });
    return;
  }
  const c = peekClient();
  if (!c) return;
  const gen = clientGen;
  pendingNow().asked = true;
  patch({ asked: true });
  try {
    await writeAskedRaw(c);
  } catch (e) {
    if (gen !== clientGen) return;
    delete pendingNow().asked;
    patch({ asked: askedNow(c), error: `Couldn't save that: ${errText(e)}` });
  }
}

/** The status picker (A4.6): a status, or null = Clear status. */
export async function setMyStatus(s: CustomStatus | null): Promise<boolean> {
  const gen = clientGen;
  try {
    await writeStatus(s);
    if (gen !== clientGen) return false;
    patch({ status: s });
    sender.refresh();
    window.setTimeout(() => void readNow(), 800);
    return true;
  } catch (e) {
    if (gen === clientGen) patch({ error: `Couldn't set the status: ${errText(e)}` });
    return false;
  }
}

/** QA hook (webshot steps): the live sender's decision + the store. */
export function presenceDebug() {
  return { active: sender.active, blocked: sender.isBlocked, state: sender.state(), store: usePresenceStore.getState(), offPending: !!offTask, removing: !!removeTask };
}

/** QA hook: the last input was `ms` ago (the real 10-min rule then says away; no timer is shortened). */
export function presenceSimulateIdle(ms: number): void {
  sender.simulateIdle(ms);
}

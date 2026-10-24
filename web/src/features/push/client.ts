// client.ts — REACH §3.2 + A2.5/A2.6/A2.9/A2.10/A2.11: web push on this device.
//
//   usePushStore        {support, permission, phase, pushkey, quiet, error, note, worker}
//                       phase: off | turning-on | checking | on | repair | turning-off | stuck
//                         checking = the start-up check runs (push is NOT counted on until it passed — web review #9)
//                         stuck    = turning off didn't finish: notifications may still arrive (web review #5)
//   installPush()       once (feature setup): registers push-sw.js where Push exists, verifies an enabled
//                       device on every start, cleans up on sign-out, keeps the app badge
//   enablePush()        the switch's tap: Notification.requestPermission() is called SYNCHRONOUSLY in it (iOS),
//                       then the transaction subscribe → pushers/set → /api/push/register ("On" only when all
//                       three succeeded; every ATTEMPTED step is undone on a failure — web review #8)
//   disablePush()       pushers/set kind null, DELETE /api/push/register, unsubscribe — each independent; "off"
//                       only when all three are confirmed, else "stuck" with a retry (the record stays)
//   setQuiet(on)        "Only when I'm away from my computer" (quietWhileActive, re-registered)
//   sendTest()          /api/push/test
//
// Every mutation (turn on, the start-up check/repair, quiet, turn off, sign-out) runs one at a time through
// `enqueue`, with the session that started it (its Matrix client + token — web review #4); turning off and
// signing out bump `opGen`, so a turn-on or repair still running stops at its next step and undoes what it did.
import { create } from "zustand";
import type { MatrixClient } from "matrix-js-sdk";
import { apiFetch } from "@/core/api";
import { bus } from "@/core/bus";
import { createLogger } from "@/core/log";
import { DEVICE_DISPLAY_NAME, getClientEpoch, getSession, onSessionEnding, peekClient } from "@/core/matrix";
import { closeAllNotes, setNoteRegistration, setPushActiveHere } from "@/core/notes";
import { getPref, removePref, setPref } from "@/core/prefs";
import { serverFeatureOn } from "@/core/server";
import { APP_ID, b64urlToBytes, pushDeviceName, pushSupport, pusherBody, pusherRemoveBody, pushkeyFor, sameKey, type Env, type Support } from "./wire";

const log = createLogger("push");

export type PushPhase = "off" | "turning-on" | "checking" | "on" | "repair" | "turning-off" | "stuck";
export type Perm = NotificationPermission | "unsupported";

export interface PushStore {
  support: Support;
  permission: Perm;
  phase: PushPhase;
  /** this device's pushkey while on */
  pushkey: string;
  /** "Only when I'm away from my computer" (quietWhileActive), default on */
  quiet: boolean;
  error: string;
  /** the test button's answer */
  note: string;
  /** the worker is registered and active */
  worker: boolean;
  /** bumps whenever this device's server registration changed (active.ts re-checks the consent then) */
  regAt: number;
}

// ---- environment -----------------------------------------------------------------------------------------------

export function envNow(): Env {
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  let displayStandalone = false;
  try {
    displayStandalone = typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches;
  } catch {
    /* old browsers */
  }
  return {
    ua: nav.userAgent ?? "",
    touchPoints: nav.maxTouchPoints ?? 0,
    standalone: (nav as Navigator & { standalone?: boolean }).standalone,
    displayStandalone,
    serviceWorker: "serviceWorker" in nav,
    pushManager: typeof window !== "undefined" && "PushManager" in window,
    notification: typeof Notification !== "undefined",
    secure: typeof window !== "undefined" && window.isSecureContext === true,
  };
}

function permNow(): Perm {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

// ---- per-device record (the pushkey this browser registered, for which account, in which state) ---------------------

const DEVICE_PREF = "push.device";
const QUIET_PREF = "push.quiet";

interface Leftovers {
  pusher?: boolean;
  registration?: boolean;
  subscription?: boolean;
}

interface DeviceRec {
  pushkey: string;
  endpoint: string;
  user: string;
  /** "on" = all three set up; "setup" = a turn-on was running (the app may have died in it); "cleanup" = turning
   *  off didn't finish — `left` says what is still there (web review #5) */
  state?: "on" | "setup" | "cleanup";
  left?: Leftovers;
}

function readRec(): DeviceRec | null {
  const v = getPref(DEVICE_PREF, null as unknown as object) as Partial<DeviceRec> | null;
  return v && typeof v.pushkey === "string" && typeof v.endpoint === "string" && typeof v.user === "string" ? (v as DeviceRec) : null;
}

function writeRec(r: DeviceRec): void {
  setPref(DEVICE_PREF, r);
}

function quietPref(): boolean {
  return getPref(QUIET_PREF, "1") !== "0";
}

// ---- store -----------------------------------------------------------------------------------------------------

export const usePushStore = create<PushStore>()(() => ({
  support: pushSupport(envNow()),
  permission: permNow(),
  phase: "off",
  pushkey: "",
  quiet: quietPref(),
  error: "",
  note: "",
  worker: false,
  regAt: 0,
}));
const patch = (p: Partial<PushStore>) => usePushStore.setState(p);

// ---- the worker (web review #14: the registration we made, with push-sw.js ACTIVE at our scope) ------------------

let regPromise: Promise<ServiceWorkerRegistration | null> | null = null;

const SCRIPT = () => new URL(`${import.meta.env.BASE_URL}push-sw.js`, location.href).href;

/** Resolves once `reg.active` runs push-sw.js (an installing / waiting one of ours becomes active first). */
function ourWorkerActive(reg: ServiceWorkerRegistration, timeoutMs = 15_000): Promise<void> {
  const want = SCRIPT();
  const ours = (w: ServiceWorker | null | undefined) => !!w && w.scriptURL === want;
  if (ours(reg.active) && !ours(reg.installing) && !ours(reg.waiting)) return Promise.resolve();
  return new Promise<void>((res, rej) => {
    const timer = window.setTimeout(() => rej(new Error("the notification worker didn't start")), timeoutMs);
    const done = () => {
      window.clearTimeout(timer);
      res();
    };
    const watch = (w: ServiceWorker | null | undefined) => {
      if (!w || !ours(w)) return;
      if (w.state === "activated" && reg.active === w) return done();
      w.addEventListener("statechange", () => {
        if (w.state === "activated") done();
        else if (w.state === "redundant" && !ours(reg.active)) rej(new Error("the notification worker was replaced before it started"));
      });
    };
    watch(reg.installing);
    watch(reg.waiting);
    watch(reg.active);
    reg.addEventListener("updatefound", () => watch(reg.installing));
  });
}

/** Register push-sw.js at the app's own path (/ live, /next/ staging) — only where Push exists (§3.2). */
export function workerReady(): Promise<ServiceWorkerRegistration | null> {
  if (regPromise) return regPromise;
  const env = envNow();
  if (!env.serviceWorker || !env.pushManager || !env.secure) return (regPromise = Promise.resolve(null));
  const base = import.meta.env.BASE_URL;
  regPromise = (async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}push-sw.js`, { scope: base });
      await ourWorkerActive(reg);
      setNoteRegistration(reg);
      patch({ worker: true });
      return reg;
    } catch (e) {
      log.warn(`push worker: ${(e as Error)?.message ?? e}`);
      regPromise = null;
      return null;
    }
  })();
  return regPromise;
}

// ---- sessions + one mutation at a time (web review #4) --------------------------------------------------------------

/** The session an operation belongs to: its client, account and token (captured when it starts). */
interface Sess {
  c: MatrixClient;
  user: string;
  token: string;
  epoch: number;
}

function sessNow(): Sess | null {
  const c = peekClient();
  const user = getSession().userId ?? "";
  const token = c?.getAccessToken() ?? "";
  if (!c || !user || !token) return null;
  return { c, user, token, epoch: getClientEpoch() };
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

let chain: Promise<void> = Promise.resolve();
/** Bumped by turn-off and sign-out: every operation started before stops at its next step. */
let opGen = 0;

function enqueue(fn: (gen: number) => Promise<void>): Promise<void> {
  const gen = opGen;
  const p = chain.then(() => fn(gen));
  chain = p.catch(() => undefined);
  return p;
}

function live(gen: number, s: Sess): void {
  if (gen !== opGen || s.epoch !== getClientEpoch()) throw new Cancelled();
}

// ---- server calls (always with the operation's own session) ------------------------------------------------------------

interface PushConfig {
  vapid: string;
  gateway: string;
  app_id: string;
}
let config: PushConfig | null = null;

async function getConfig(): Promise<PushConfig> {
  if (config) return config;
  const r = await apiFetch("/push/config", { auth: false });
  if (!r.ok) throw new Error(r.status === 404 || r.status === 503 ? "push isn't set up on the server yet" : `the server said ${r.status}`);
  const j = (await r.json()) as Partial<PushConfig>;
  if (typeof j.vapid !== "string" || typeof j.gateway !== "string") throw new Error("the server's push setup is incomplete");
  config = { vapid: j.vapid, gateway: j.gateway, app_id: j.app_id ?? APP_ID };
  return config;
}

/** The server's refusal codes in plain words (the raw code goes to the log, never on screen). */
function plainServerError(code: string, reason: string): string {
  switch (code) {
    case "pushkey_owned":
      return "this browser is registered to another account — sign that one out here first";
    case "subscription_refused":
      return reason === "host_not_allowed" ? "the Tin Hat server doesn't work with this browser's push service" : "the Tin Hat server refused this browser's push subscription";
    case "rate_limited":
      return "too many tries — wait a minute and try again";
    case "not_registered":
      return "this device isn't registered on the server any more";
    default:
      return code;
  }
}

async function errOf(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: unknown; reason?: unknown };
    if (typeof j?.error === "string") {
      const reason = typeof j.reason === "string" ? j.reason : "";
      log.info(`push server: ${r.status} ${j.error}${reason ? ` (${reason})` : ""}`);
      return plainServerError(j.error, reason);
    }
  } catch {
    /* not json */
  }
  return `the server said ${r.status}`;
}

type Keys = { endpoint: string; p256dh: string; auth: string };

async function registerOwner(s: Sess, sub: Keys, quiet: boolean, pushkey: string): Promise<void> {
  const r = await apiFetch("/push/register", {
    method: "POST",
    auth: true,
    bearer: s.token,
    json: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, quietWhileActive: quiet },
  });
  if (!r.ok) throw new Error(await errOf(r));
  const j = (await r.json().catch(() => ({}))) as { pushkey?: unknown };
  if (typeof j.pushkey === "string" && j.pushkey !== pushkey) throw new Error("the server computed a different pushkey");
}

/** DELETE /api/push/register — 204 also for a pushkey the server doesn't know (idempotent). */
async function unregisterOwner(s: Sess, pushkey: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/push/register?pushkey=${encodeURIComponent(pushkey)}`, { method: "DELETE", auth: true, bearer: s.token, timeoutMs: 6_000 });
    return r.ok || r.status === 204;
  } catch {
    return false;
  }
}

/** pushers/set kind null — Synapse answers 200 for a pusher it doesn't have too (idempotent). */
async function removePusher(s: Sess, pushkey: string): Promise<boolean> {
  try {
    await s.c.setPusher(pusherRemoveBody(pushkey) as never);
    return true;
  } catch (e) {
    log.info(`pusher removal: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

async function setPusherFor(s: Sess, sub: Keys, pushkey: string, gateway: string): Promise<void> {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en";
  await s.c.setPusher(pusherBody({ pushkey, gateway, ...sub, deviceName: pushDeviceName(DEVICE_DISPLAY_NAME), lang }) as never);
}

function subKeys(sub: PushSubscription): Keys {
  const j = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  const p256dh = j.keys?.p256dh ?? "";
  const auth = j.keys?.auth ?? "";
  if (!p256dh || !auth) throw new Error("the browser returned a subscription without keys");
  return { endpoint: sub.endpoint, p256dh, auth };
}

/** An existing subscription for our VAPID key, else a new one (`made` = we created it). */
async function subscription(reg: ServiceWorkerRegistration, vapid: string): Promise<{ sub: PushSubscription; made: boolean }> {
  const key = b64urlToBytes(vapid);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey ?? null, key)) {
    await sub.unsubscribe().catch(() => undefined); // made with another server key: can't be reused
    sub = null;
  }
  if (sub) return { sub, made: false };
  return { sub: await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }), made: true };
}

/** Unsubscribe this browser. A lookup that FAILS is not "no subscription" (web review #5): false then. */
async function unsubscribeHere(): Promise<boolean> {
  const reg = await workerReady();
  if (!reg) return !envNow().pushManager; // no worker where Push exists = can't confirm
  let sub: PushSubscription | null;
  try {
    sub = await reg.pushManager.getSubscription();
  } catch {
    return false;
  }
  if (!sub) return true;
  return sub.unsubscribe().catch(() => false);
}

/** Undo / clean up: each step on its own (one failing never skips the next). Null = all done, else what is left. */
async function undo(s: Sess | null, pushkey: string, what: Leftovers): Promise<Leftovers | null> {
  const [p, r, u] = await Promise.all([
    what.pusher && pushkey ? (s ? removePusher(s, pushkey) : Promise.resolve(false)) : Promise.resolve(true),
    what.registration && pushkey ? (s ? unregisterOwner(s, pushkey) : Promise.resolve(false)) : Promise.resolve(true),
    what.subscription ? unsubscribeHere() : Promise.resolve(true),
  ]);
  const left: Leftovers = {};
  if (!p) left.pusher = true;
  if (!r) left.registration = true;
  if (!u) left.subscription = true;
  return left.pusher || left.registration || left.subscription ? left : null;
}

function errText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if ((e as { name?: string })?.name === "NotAllowedError") return "the browser refused the subscription";
  return m;
}

/** Keep what couldn't be removed for a retry (the record stays); the block says so (ThisDevice STUCK_LINE). */
function stuck(rec: DeviceRec, left: Leftovers, error = ""): void {
  writeRec({ ...rec, state: "cleanup", left });
  patch({ phase: "stuck", pushkey: "", error });
}

// ---- turning on (the transaction, A2.10 + web review #4/#8) ---------------------------------------------------------

/** The push service said this device's endpoint is gone (the test button): "Turn on again" must not reuse it. */
let renewSub = false;

async function setup(s: Sess, gen: number): Promise<void> {
  const cfg = await getConfig();
  live(gen, s);
  const reg = await workerReady();
  if (!reg) throw new Error("the notification worker isn't available in this browser");
  live(gen, s);
  if (renewSub) {
    renewSub = false;
    const old = await reg.pushManager.getSubscription().catch(() => null);
    if (old) {
      const oldKey = await pushkeyFor(old.endpoint).catch(() => "");
      await old.unsubscribe().catch(() => undefined);
      if (oldKey) await Promise.all([removePusher(s, oldKey), unregisterOwner(s, oldKey)]);
    }
    live(gen, s);
  }
  const { sub } = await subscription(reg, cfg.vapid);
  let keys: Keys;
  let pushkey: string;
  try {
    keys = subKeys(sub);
    pushkey = await pushkeyFor(keys.endpoint);
  } catch (e) {
    await sub.unsubscribe().catch(() => undefined);
    throw e;
  }
  const rec: DeviceRec = { pushkey, endpoint: keys.endpoint, user: s.user, state: "setup" };
  writeRec(rec); // from here a sign-out / turn-off can find it — and every attempted step is undone on failure
  const tried: Leftovers = { subscription: true };
  try {
    live(gen, s);
    tried.pusher = true; // attempted = maybe done (a lost answer still committed it)
    await setPusherFor(s, keys, pushkey, cfg.gateway);
    live(gen, s);
    tried.registration = true;
    await registerOwner(s, keys, quietPref(), pushkey);
    live(gen, s);
  } catch (e) {
    const left = await undo(s.epoch === getClientEpoch() ? s : null, pushkey, tried);
    if (left) writeRec({ ...rec, state: "cleanup", left });
    else removePref(DEVICE_PREF);
    throw e;
  }
  writeRec({ ...rec, state: "on" });
  patch({ phase: "on", pushkey, error: "" });
  bus.emit("toast", { message: "Notifications are on for this device", timeoutMs: 3000 });
}

/** The switch turning on. MUST run synchronously inside the tap: iOS only asks for permission there. */
export function enablePush(): void {
  if (typeof Notification === "undefined") return;
  let asked: Promise<NotificationPermission>;
  try {
    asked = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
  } catch {
    asked = new Promise((res) => void Notification.requestPermission(res)); // the old callback form
  }
  patch({ phase: "turning-on", error: "", note: "" });
  void enqueue(async (gen) => {
    const perm = await asked.catch(() => Notification.permission);
    patch({ permission: perm });
    if (gen !== opGen) return; // turned off (or signed out) before it began
    if (perm !== "granted") {
      patch({ phase: "off", error: perm === "denied" ? "" : "Notifications weren't allowed." });
      return;
    }
    const s = sessNow();
    if (!s) {
      patch({ phase: "off", error: "Couldn't turn it on: not signed in" });
      return;
    }
    try {
      await setup(s, gen);
    } catch (e) {
      if (e instanceof Cancelled) return; // the turn-off / sign-out that cancelled it sets the phase
      log.warn(`push setup: ${errText(e)}`);
      const rec = readRec();
      if (rec?.state === "cleanup" && rec.left) stuck(rec, rec.left, `Couldn't turn it on: ${errText(e)}`);
      else patch({ phase: "off", pushkey: "", error: `Couldn't turn it on: ${errText(e)}` });
    }
  });
}

// ---- turning off (web review #5: "off" only when confirmed) ----------------------------------------------------------

/** The switch turning off (also "Try again" while stuck): pusher, registration and subscription, each on its own. */
export function disablePush(): Promise<void> {
  opGen++; // a turn-on / repair still running stops at its next step (and undoes itself)
  const s = sessNow();
  patch({ phase: "turning-off", error: "", note: "" });
  return enqueue(async () => {
    const rec = readRec();
    const pk = rec?.pushkey || usePushStore.getState().pushkey;
    const who = s && s.epoch === getClientEpoch() ? s : null;
    const left = await undo(who, pk, { pusher: !!pk, registration: !!pk, subscription: true });
    if (left) {
      log.info(`push off: not confirmed (${Object.keys(left).join(", ")})`);
      stuck(rec ?? { pushkey: pk, endpoint: "", user: s?.user ?? "" }, left);
      return;
    }
    removePref(DEVICE_PREF);
    patch({ phase: "off", pushkey: "", error: "" });
  });
}

export function setQuiet(on: boolean): Promise<void> {
  setPref(QUIET_PREF, on ? "1" : "0");
  patch({ quiet: on });
  const s = sessNow();
  return enqueue(async (gen) => {
    const st = usePushStore.getState();
    if (st.phase !== "on" || !s) return;
    live(gen, s);
    const reg = await workerReady();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) throw new Error("the subscription is gone — turn notifications on again");
    live(gen, s);
    await registerOwner(s, subKeys(sub), on, st.pushkey);
    patch({ regAt: Date.now() }); // the consent (quiet-wanted) may have changed with it
  }).catch((e) => {
    if (!(e instanceof Cancelled)) patch({ error: `Couldn't save that: ${errText(e)}` });
  });
}

export async function sendTest(): Promise<void> {
  const st = usePushStore.getState();
  if (st.phase !== "on" || !st.pushkey) return;
  patch({ note: "Sending…" });
  try {
    const r = await apiFetch("/push/test", { method: "POST", auth: true, json: { pushkey: st.pushkey } });
    if (r.status === 429) return patch({ note: "Wait a few seconds before the next test." });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { gone?: boolean; error?: string; reason?: string };
      if (j.gone || r.status === 404) {
        if (j.gone) renewSub = true; // a dead endpoint: "Turn on again" subscribes afresh
        patch({ phase: "repair", note: "" });
        return;
      }
      return patch({ note: `The test didn't go out: ${typeof j.error === "string" ? plainServerError(j.error, j.reason ?? "") : `the server said ${r.status}`}` });
    }
    patch({ note: "Sent — it should arrive in a moment." });
  } catch (e) {
    patch({ note: `The test didn't go out: ${errText(e)}` });
  }
}

// ---- every start: verify the three parts, repair without a gesture where possible (A2.10 + web review #9) ---------------

async function verify(s: Sess, gen: number): Promise<void> {
  const rec = readRec();
  if (!rec) return;
  if (rec.user !== s.user) {
    // another account's leftover: its server side can't be touched with this token — end this browser's end of it
    await unsubscribeHere();
    removePref(DEVICE_PREF);
    return;
  }
  if (rec.state === "cleanup") {
    // turning off didn't finish last time: try again quietly
    patch({ phase: "turning-off" });
    const left = await undo(s, rec.pushkey, rec.left ?? { pusher: true, registration: true, subscription: true });
    if (left) return stuck(rec, left);
    removePref(DEVICE_PREF);
    patch({ phase: "off", pushkey: "", error: "" });
    return;
  }
  const perm = permNow();
  patch({ permission: perm });
  if (perm !== "granted") {
    patch({ phase: perm === "denied" ? "off" : "repair" });
    return;
  }
  // "checking": push is not counted on (the in-page engine keeps notifying) until all three are confirmed
  patch({ phase: "checking", pushkey: rec.pushkey });
  try {
    live(gen, s);
    const cfg = await getConfig();
    const reg = await workerReady();
    if (!reg) throw new Error("no worker");
    live(gen, s);
    const { sub } = await subscription(reg, cfg.vapid);
    const keys = subKeys(sub);
    const pushkey = await pushkeyFor(keys.endpoint);
    live(gen, s);
    if (pushkey !== rec.pushkey) {
      // the subscription was replaced (browser rotation / pushsubscriptionchange): the new one first — every
      // attempted step undone if it fails — then the old pusher + registration go (web review #8)
      log.info("push subscription changed — re-registering");
      const next: DeviceRec = { pushkey, endpoint: keys.endpoint, user: s.user, state: "setup" };
      const tried: Leftovers = {};
      try {
        tried.pusher = true;
        await setPusherFor(s, keys, pushkey, cfg.gateway);
        live(gen, s);
        tried.registration = true;
        await registerOwner(s, keys, quietPref(), pushkey);
        live(gen, s);
      } catch (e) {
        await undo(s.epoch === getClientEpoch() ? s : null, pushkey, tried);
        throw e;
      }
      await Promise.all([removePusher(s, rec.pushkey), unregisterOwner(s, rec.pushkey)]);
      writeRec({ ...next, state: "on" });
    } else {
      const list = ((await s.c.getPushers())?.pushers ?? []) as Array<{ app_id?: string; pushkey?: string; data?: { url?: string } }>;
      live(gen, s);
      const mine = list.find((p) => p.app_id === APP_ID && p.pushkey === pushkey);
      if (!mine || mine.data?.url !== cfg.gateway) await setPusherFor(s, keys, pushkey, cfg.gateway);
      live(gen, s);
      const r = await apiFetch(`/push/register?pushkey=${encodeURIComponent(pushkey)}`, { auth: true, bearer: s.token });
      const j = r.ok ? ((await r.json()) as { registered?: boolean; quietWhileActive?: boolean }) : null;
      live(gen, s);
      if (!j?.registered || j.quietWhileActive !== quietPref()) await registerOwner(s, keys, quietPref(), pushkey);
      live(gen, s);
      if (rec.state !== "on") writeRec({ ...rec, state: "on" });
    }
    patch({ phase: "on", pushkey, error: "" });
  } catch (e) {
    if (e instanceof Cancelled) return;
    log.warn(`push verify: ${errText(e)}`);
    patch({ phase: "repair", error: "" });
  }
}

// ---- the app badge (A5.10: rooms whose adjusted unread is > 0 + pending DM invites; spaces never) --------------------
//
// The page sets the badge exactly while it is visible, and keeps the set of unread room ids in Cache storage
// where push-sw.js reads it; on each push the worker sets the count of (rooms pushed since the page was last
// visible ∪ the page's last set). Web review #17/#18: instead of the page deleting the worker's "pushed" set (a
// race with a push being handled), every visible moment — the first one of a cold start included — starts a new
// EPOCH written with the page's set; the worker only counts pushed rooms recorded under the current epoch, and
// serialises its own updates.

const BADGE_CACHE = "tinhat-badge";
const badgeKey = (k: "unread" | "pushed") => new URL(`__tinhat/badge/${k}`, new URL(import.meta.env.BASE_URL, location.href)).href;

let lastIds: string[] = [];
let lastBadge = -1;
let lastWritten = "";

const newEpoch = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The epoch the unread set is written under. A cold start while visible = a visible moment: a new epoch. A cold
 *  start in the background keeps the stored one (rooms pushed while we were away still count). */
let epoch: Promise<string> = (async () => {
  if (typeof document === "undefined" || document.visibilityState === "visible" || typeof caches === "undefined") return newEpoch();
  try {
    const r = await (await caches.open(BADGE_CACHE)).match(badgeKey("unread"));
    const j = r ? ((await r.json()) as { epoch?: unknown }) : null;
    return typeof j?.epoch === "string" && j.epoch ? j.epoch : newEpoch();
  } catch {
    return newEpoch();
  }
})();

function applyBadge(n: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge || permNow() !== "granted") return;
  if (n === lastBadge) return;
  lastBadge = n;
  try {
    if (n > 0) void nav.setAppBadge(n).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

let writing: Promise<void> = Promise.resolve();

function writeUnreadSet(ids: string[]): Promise<void> {
  writing = writing.then(async () => {
    if (typeof caches === "undefined") return;
    const json = JSON.stringify({ rooms: ids, epoch: await epoch });
    if (json === lastWritten) return;
    lastWritten = json;
    try {
      const c = await caches.open(BADGE_CACHE);
      await c.put(badgeKey("unread"), new Response(json, { headers: { "Content-Type": "application/json" } }));
    } catch {
      /* storage refused (private window) */
    }
  });
  return writing;
}

/** The nav's unread room ids changed (or sign-out: []). */
export function updateBadge(ids: string[]): void {
  lastIds = ids;
  void writeUnreadSet(ids);
  if (typeof document === "undefined" || document.visibilityState === "visible") applyBadge(ids.length);
}

/** A visible moment: a new epoch (the worker's pushed set starts over), the exact badge again. */
function visibleReset(): void {
  epoch = Promise.resolve(newEpoch());
  lastBadge = -1; // the worker may have moved it meanwhile: set it exactly again
  void writeUnreadSet(lastIds);
  applyBadge(lastIds.length);
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") visibleReset();
  });

/** Kept for callers of the earlier API: a count without ids. */
export function setBadge(n: number): void {
  applyBadge(n);
}

// ---- install -------------------------------------------------------------------------------------------------------

let installed = false;
export function installPush(): void {
  if (installed) return;
  installed = true;
  const env = envNow();
  patch({ support: pushSupport(env), permission: permNow() });
  // push counts only when it is confirmed on (not while checking / repairing / stuck — web review #9)
  setPushActiveHere(() => usePushStore.getState().phase === "on");
  if (env.serviceWorker && env.pushManager && env.secure) void workerReady();
  bus.on("sessionReady", () => {
    // docs/SELFHOST.md: a server without web push — nothing to verify or repair (its switch is hidden)
    if (!serverFeatureOn("push")) return;
    const s = sessNow();
    if (s) void enqueue((gen) => verify(s, gen));
  });
  // the user can change the permission in the browser UI at any time
  if (typeof window !== "undefined")
    window.setInterval(() => {
      const p = permNow();
      if (p !== usePushStore.getState().permission) patch({ permission: p });
    }, 3_000);
  // sign-out (A2.9/A2.10 + web review #4): a turn-on / repair still running stops and undoes itself, then the
  // pusher, the registration and the subscription go — each on its own, with the departing session's token,
  // BEFORE it is revoked; what can't be removed stays recorded. Every shown notification closes. A takeover keeps
  // the device (another tab continues as it).
  onSessionEnding(async (why) => {
    if (why === "takeover") return;
    opGen++;
    const s = sessNow();
    await Promise.race([chain, new Promise((r) => setTimeout(r, 2_500))]);
    const rec = readRec();
    const steps: Array<Promise<unknown>> = [closeAllNotes()];
    if (rec && rec.user === s?.user && why === "logout") {
      steps.push(
        undo(s, rec.pushkey, { pusher: true, registration: true, subscription: true }).then((left) => {
          if (left) writeRec({ ...rec, state: "cleanup", left });
          else removePref(DEVICE_PREF);
        }),
      );
    } else {
      // the token is gone (or another account's record): only this browser's end can go now
      steps.push(
        unsubscribeHere().then((ok) => {
          if (rec && rec.user === s?.user) writeRec({ ...rec, state: "cleanup", left: { pusher: true, registration: true, ...(ok ? {} : { subscription: true }) } });
          else if (rec) removePref(DEVICE_PREF);
        }),
      );
    }
    await Promise.allSettled(steps);
    updateBadge([]);
    patch({ phase: "off", pushkey: "", error: "", note: "" });
  });
}

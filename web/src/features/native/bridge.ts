// bridge.ts — `window.tinhatNative`, the object the Tin Hat iOS / Android apps inject (bridge v2, docs/NATIVE-APPS.md).
// Absent in every browser and in the desktop app: then every function here answers "no" / does nothing, so the page
// behaves exactly as without this module. Pure (no imports): the unit tests run it in Node.
//
// Trust: the app is untrusted INPUT to the page (and the page is untrusted to the app — it only ever asks). Every value
// read from the object is checked for shape before it is used; nothing from it is rendered as markup; calls into it are
// wrapped (a broken or hostile object can't throw into a click handler). The page passes the app ids only: a room id,
// a room name, the signed-in mxid — never a token, key or password.

export type NativeCap = "calls" | "servers" | "haptics" | "notifications" | "trust";

export interface NativeInfo {
  platform: "ios" | "android";
  bridge: number;
  caps: readonly string[];
  /** the app's own version ("0.1.0"); "" when it doesn't say (About & help, bug reports) */
  app: string;
}

/** The raw object as the apps inject it (every member optional: validated before use). */
interface RawNative {
  info?: unknown;
  chooseServer?: unknown;
  joinCall?: unknown;
  leaveCall?: unknown;
  showCall?: unknown;
  callState?: unknown;
  webCall?: unknown;
  notifications?: unknown;
  signedOut?: unknown;
  trust?: unknown;
}

function raw(): RawNative | null {
  try {
    const n = (globalThis as { tinhatNative?: unknown }).tinhatNative;
    return n && typeof n === "object" ? (n as RawNative) : null;
  } catch {
    return null;
  }
}

/** One member of the app's object. Reads are guarded too: a frozen object can still carry a throwing getter. */
function member(name: keyof RawNative): unknown {
  try {
    const n = raw();
    return n ? n[name] : undefined;
  } catch {
    return undefined;
  }
}

/** The app's `info`, validated; null outside the apps (or for an object of the wrong shape). */
export function nativeInfo(): NativeInfo | null {
  const n = raw();
  if (!n) return null;
  try {
    const i = n.info as { platform?: unknown; bridge?: unknown; caps?: unknown; app?: unknown } | undefined;
    if (!i || typeof i !== "object") return null;
    if (i.platform !== "ios" && i.platform !== "android") return null;
    if (typeof i.bridge !== "number" || !Number.isFinite(i.bridge) || i.bridge < 1) return null;
    const caps = Array.isArray(i.caps) ? i.caps.filter((c): c is string => typeof c === "string").slice(0, 32) : [];
    const app = typeof i.app === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(i.app) ? i.app : "";
    return { platform: i.platform, bridge: i.bridge, caps, app };
  } catch {
    return null;
  }
}

/** The page runs inside a Tin Hat app (iOS or Android). The web-push / Home Screen rows key off this. */
export function inTinHatApp(): boolean {
  return nativeInfo() !== null;
}

/** The app CLAIMS the calls (bridge ≥ 2 and "calls"), whether or not its call functions work: then the page never
 *  joins with its own device (an unusable owner blocks the join; it doesn't hand it back to the web). */
export function nativeOwnsCalls(): boolean {
  const i = nativeInfo();
  return !!i && i.bridge >= 2 && i.caps.includes("calls");
}

/** The app offers `cap` AND can use it ("calls": every call function present). */
export function hasNativeCap(cap: NativeCap): boolean {
  const i = nativeInfo();
  if (!i || !i.caps.includes(cap)) return false;
  if (cap === "calls") {
    return nativeOwnsCalls() && (["joinCall", "leaveCall", "showCall", "callState"] as const).every((k) => typeof member(k) === "function");
  }
  if (cap === "servers") return typeof member("chooseServer") === "function";
  if (cap === "notifications") return (["state", "enable", "disable"] as const).every((k) => notifyFn(k) !== null);
  if (cap === "trust") return trustFn("pending") !== null && trustFn("result") !== null;
  return true;
}

/** The WEB owns the call but the app wants to follow it (Android today: no "calls" cap, a `webCall` function — its
 *  "In a call" service and notification controls). Never with "calls": there the app owns the call itself. */
export function webCallReportsOn(): boolean {
  const i = nativeInfo();
  return !!i && !i.caps.includes("calls") && typeof member("webCall") === "function";
}

/** The app takes commands for the WEB's call ("tinhatnative:command"): inside an app without the "calls" cap. */
export function webCallCommandsOn(): boolean {
  const i = nativeInfo();
  return !!i && !i.caps.includes("calls");
}

/** Call one of the app's functions; a missing / throwing member is a no-op. */
function invoke(name: "chooseServer" | "joinCall" | "leaveCall" | "showCall" | "webCall" | "signedOut", arg?: unknown): boolean {
  const n = raw();
  const f = member(name);
  if (typeof f !== "function") return false;
  try {
    if (arg === undefined) f.call(n);
    else f.call(n, arg);
    return true;
  } catch {
    return false;
  }
}

/** "Switch server" (sign-in screen + Settings → About): the app's own server chooser. */
export function chooseServer(): void {
  if (hasNativeCap("servers")) invoke("chooseServer");
}

/** The person signed `userId` out of this page: the app signs ITS native device of that account out too (calls,
 *  notifications). Optional, no cap (feature-detected); fire-and-forget. Only for a sign-out the person chose. */
export function nativeSignedOut(userId: string): boolean {
  return inTinHatApp() && userIdOk(userId) && invoke("signedOut", { userId });
}

/** A room id as the page knows it: "!" + opaque (room v12 ids have no ":server" part), no spaces, bounded. */
export function roomIdOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 1 && v.length <= 255 && v[0] === "!" && !/[\s\0]/.test(v);
}

/** A full mxid "@user:server". */
export function userIdOk(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 && /^@[^\s:]+:[^\s]+$/.test(v);
}

export interface NativeJoin {
  roomId: string;
  roomName: string;
  userId: string;
}

/** What the page tells an app that follows the WEB's call (`tinhatNative.webCall(…)`). */
export interface WebCallReport {
  state: "connecting" | "in-call" | "left";
  roomId: string;
  roomName: string;
  muted: boolean;
  camera: boolean;
}

/** Bridge 2 calls (only meaningful while hasNativeCap("calls"); webCall only while webCallReportsOn()). */
export const nativeCalls = {
  join: (o: NativeJoin) => invoke("joinCall", { roomId: o.roomId, roomName: o.roomName.slice(0, 255), userId: o.userId }),
  /** page → app: the WEB's own call changed (only while webCallReportsOn()) */
  webCall: (r: WebCallReport) => webCallReportsOn() && invoke("webCall", { ...r, roomName: r.roomName.slice(0, 255) }),
  leave: () => invoke("leaveCall"),
  show: () => invoke("showCall"),
  /** the app's `callState()` as it returned it (untrusted: parse with callState.ts parseNativeCall) */
  stateRaw(): unknown {
    const n = raw();
    const f = n?.callState;
    if (typeof f !== "function") return null;
    try {
      return f.call(n);
    } catch {
      return null;
    }
  },
};

// ---- notifications on this phone (caps "notifications"; BRIDGE.md) ----------------------------------------------------
// The app's native device owns this phone's pusher; the page only shows one switch. Each call answers a Promise of
// {state, error?}. state: "on" | "off" | "denied" (off in the phone's settings) | "needs-setup" (the app sets its
// native device up first, with its own sheet) | "unavailable" (the server doesn't send to phones).

export type PhoneNotifyState = "on" | "off" | "denied" | "needs-setup" | "unavailable";
export interface PhoneNotifyAnswer {
  state: PhoneNotifyState;
  /** a sentence for the person ("" = none; "cancelled" = they closed the app's setup sheet) */
  error: string;
}
const NOTIFY_STATES: readonly string[] = ["on", "off", "denied", "needs-setup", "unavailable"];

/** An app's answer, checked: an unknown state → null; `error` → one bounded line of plain text. */
export function parseNotifyAnswer(v: unknown): PhoneNotifyAnswer | null {
  try {
    if (!v || typeof v !== "object") return null;
    // each property read once (a getter could answer differently the second time)
    const { state, error: rawError } = v as { state?: unknown; error?: unknown };
    if (typeof state !== "string" || !NOTIFY_STATES.includes(state)) return null;
    const error = typeof rawError === "string" ? rawError.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) : "";
    return { state: state as PhoneNotifyState, error };
  } catch {
    return null;
  }
}

/** `tinhatNative.notifications[name]`, bound, or null (guarded reads: getters may throw). */
function notifyFn(name: "state" | "enable" | "disable" | "openSettings"): ((arg?: unknown) => unknown) | null {
  try {
    const o = member("notifications");
    if (!o || typeof o !== "object") return null;
    const f = (o as Record<string, unknown>)[name];
    return typeof f === "function" ? (arg?: unknown) => (f as (a?: unknown) => unknown).call(o, arg) : null;
  } catch {
    return null;
  }
}

export const nativeNotifications = {
  /** Ask the app (`ms` = give up after, for the state read; enable waits for the person). null = no usable answer. */
  async ask(op: "state" | "enable" | "disable", userId: string, ms = 0): Promise<PhoneNotifyAnswer | null> {
    if (!hasNativeCap("notifications") || !userIdOk(userId)) return null;
    const f = notifyFn(op);
    if (!f) return null;
    try {
      const p = Promise.resolve(f({ userId }));
      if (!ms) return parseNotifyAnswer(await p);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
      try {
        return parseNotifyAnswer(await Promise.race([p, late]));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  },
  /** The app can open the phone's own notification settings for Tin Hat (optional). */
  canOpenSettings: (): boolean => notifyFn("openSettings") !== null,
  openSettings(): boolean {
    const f = notifyFn("openSettings");
    if (!f) return false;
    try {
      const r = f();
      // an app may answer with a promise; a rejected one must not become an unhandled rejection
      if (r && typeof (r as { then?: unknown }).then === "function") void Promise.resolve(r).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  },
};

/** How long the row waits for the app: a state read briefly; enable / disable long enough for the app's setup sheet
 *  and the phone's own prompt, then it gives up, reads the state again and ignores a late answer. */
export const NOTIFY_READ_MS = 10_000;
export const NOTIFY_CHANGE_MS = 150_000;

/** The row's words for a state (Settings → Notifications → "Notifications on this phone"). */
export function phoneNotifyText(state: PhoneNotifyState): { description: string; line: string } {
  switch (state) {
    case "on":
      return { description: "DMs, mentions and invites, even when Tin Hat is closed.", line: "On — they reach this phone." };
    case "needs-setup":
      return { description: "DMs, mentions and invites, even when Tin Hat is closed. The first time, this phone asks for your password once to set itself up.", line: "" };
    case "denied":
      return { description: "DMs, mentions and invites, even when Tin Hat is closed.", line: "Allow notifications for Tin Hat in your phone's settings." };
    case "unavailable":
      return { description: "", line: "Your server doesn't send notifications to phones yet." };
    default:
      return { description: "DMs, mentions and invites, even when Tin Hat is closed.", line: "" };
  }
}

// ---- trust the phone's native device (caps "trust"; BRIDGE.md, docs/TRUST.md) ---------------------------------------
// The app names the device it set up (one id + one public ed25519 key); the page checks the server's copy and signs it
// with the account's self-signing key (trust.ts). Nothing secret crosses: ids, a public key and a result word.

/** `tinhatNative.trust[name]`, bound, or null (guarded reads: getters may throw). */
function trustFn(name: "pending" | "result"): ((arg: unknown) => unknown) | null {
  try {
    const o = member("trust");
    if (!o || typeof o !== "object") return null;
    const f = (o as Record<string, unknown>)[name];
    return typeof f === "function" ? (arg: unknown) => (f as (a: unknown) => unknown).call(o, arg) : null;
  } catch {
    return null;
  }
}

/** How long the page waits for the app's pending() / result() before it gives up (a late answer is ignored). */
export const TRUST_ASK_MS = 10_000;

async function askTrust(name: "pending" | "result", arg: unknown, ms: number): Promise<unknown> {
  const f = trustFn(name);
  if (!f) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Promise.resolve(f(arg));
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
    return await Promise.race([p, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const nativeTrust = {
  /** the app's pending() for `userId`, unchecked (parse with trust.ts parsePending); null outside the apps */
  async pendingRaw(userId: string, ms = TRUST_ASK_MS): Promise<unknown> {
    if (!hasNativeCap("trust") || !userIdOk(userId)) return null;
    return askTrust("pending", { userId }, ms);
  },
  /** tell the app what the page did; its answer unchecked (parse with trust.ts parseTrustAnswer) */
  async resultRaw(userId: string, deviceId: string, result: string, ms = TRUST_ASK_MS): Promise<unknown> {
    if (!hasNativeCap("trust") || !userIdOk(userId)) return null;
    return askTrust("result", { userId, deviceId, result }, ms);
  },
};

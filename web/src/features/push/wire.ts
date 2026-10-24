// wire.ts — REACH §3.2 + A2.6/A2.10 pure helpers for web push (no imports: wire.test.ts runs them under
// plain Node): the pushkey, VAPID key decoding, the pusher body, the device name, and "can this browser do
// it / what should the Settings block say" in the contract's detection order.

export const APP_ID = "dev.tinhat.web";

/** base64url without padding. */
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (padded or not) → bytes (the VAPID public key for applicationServerKey). */
export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A2.6: pushkey = base64url(sha256(endpoint)) — the server computes the same from the endpoint. */
export async function pushkeyFor(endpoint: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return b64url(d);
}

/** Same bytes? (an existing subscription made with another VAPID key must be replaced) */
export function sameKey(a: ArrayBuffer | Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

/** "Tin Hat Web (Chrome on Android)" (the session's device name) → "Tin Hat Web · Chrome on Android". */
export function pushDeviceName(sessionName: string): string {
  const m = /^Tin Hat Web \((.+)\)$/.exec(sessionName);
  return m ? `Tin Hat Web · ${m[1]}` : "Tin Hat Web";
}

export interface PusherData {
  url: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  v: 1;
}

/** The `POST /_matrix/client/v3/pushers/set` body that turns push on (§3.2 step 3; full format, A2.7). */
export function pusherBody(o: { pushkey: string; gateway: string; endpoint: string; p256dh: string; auth: string; deviceName: string; lang: string }) {
  return {
    kind: "http" as const,
    app_id: APP_ID,
    pushkey: o.pushkey,
    app_display_name: "Tin Hat",
    device_display_name: o.deviceName,
    lang: o.lang || "en",
    data: { url: o.gateway, endpoint: o.endpoint, p256dh: o.p256dh, auth: o.auth, v: 1 } as PusherData,
    append: false,
  };
}

/** The body that removes it (kind: null). */
export function pusherRemoveBody(pushkey: string) {
  return { kind: null, app_id: APP_ID, pushkey };
}

export interface Env {
  ua: string;
  /** navigator.maxTouchPoints */
  touchPoints: number;
  /** navigator.standalone (iOS) */
  standalone: boolean | undefined;
  /** matchMedia("(display-mode: standalone)").matches */
  displayStandalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  secure: boolean;
}

/** iPhone / iPad / iPod — incl. iPadOS, which says "Macintosh" but has a touch screen. */
export function isIos(env: Pick<Env, "ua" | "touchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.ua) || (/Macintosh/.test(env.ua) && env.touchPoints > 1);
}

export function isInstalled(env: Pick<Env, "standalone" | "displayStandalone">): boolean {
  return env.standalone === true || env.displayStandalone;
}

export type Support = { ok: true } | { ok: false; kind: "ios-install" | "unsupported"; text: string };

export const IOS_INSTALL_HINT = "On iPhone and iPad, add Tin Hat to your Home Screen first: Share ▸ Add to Home Screen, then open it from there.";

/** A2.10 detection order: the iPhone/iPad "add to Home Screen" guidance comes BEFORE "not supported". */
export function pushSupport(env: Env): Support {
  if (isIos(env) && !isInstalled(env)) return { ok: false, kind: "ios-install", text: IOS_INSTALL_HINT };
  if (!env.secure) return { ok: false, kind: "unsupported", text: "Notifications need a secure (https) connection — this page isn't one." };
  if (!env.serviceWorker) return { ok: false, kind: "unsupported", text: "This browser can't run the background worker notifications need (private windows often turn it off)." };
  if (!env.pushManager || !env.notification) return { ok: false, kind: "unsupported", text: "This browser can't receive notifications while Tin Hat is closed." };
  return { ok: true };
}

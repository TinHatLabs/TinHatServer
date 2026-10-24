// util.ts — small helpers shared by the call engine (identities, base64, timers, names).
import { MATRIX_ORIGIN } from "@/core/bearer";
import { peekClient } from "@/core/matrix";
import { isRecorder as isRecorderAccount } from "@/core/server";

export const MEMBER_TYPE = "org.matrix.msc3401.call.member";
export const LEGACY_MEMBER_TYPES = ["m.call.member", "m.rtc.member"] as const;
export const KEYS_TYPE = "io.element.call.encryption_keys";
export const AFK_TYPE = "dev.tinhat.afk";
export const MEMBERSHIP_EXPIRES_MS = 14_400_000;

/** The call JWT service when the server's well-known names none (focus.ts): the Tin Hat Server's own `/livekit/jwt`
 *  on the homeserver origin (= this page's). */
export function defaultFocusUrl(): string {
  return `${MATRIX_ORIGIN}/livekit/jwt`;
}

/** `@u:server:DEVICE` → `@u:server` (everything before the LAST ":", keeps a host:port). */
export function mxidOf(identity: string): string {
  const i = identity.lastIndexOf(":");
  if (i <= 0) return identity;
  const head = identity.slice(0, i);
  // A bare mxid has exactly one ":" after the localpart (or two with a port) — only strip when
  // what remains still looks like an mxid.
  return head.includes(":") ? head : identity;
}

/** Device part of a LiveKit identity (after the last ":"). */
export function deviceOf(identity: string): string {
  const m = mxidOf(identity);
  return m === identity ? "" : identity.slice(m.length + 1);
}

/** Is this LiveKit identity / Matrix id the Memories recorder? The account the server announces (core/server;
 *  none → nobody). */
export function isRecorder(identity: string): boolean {
  return isRecorderAccount(identity);
}

export function localpart(mxid: string): string {
  return mxid.replace(/^@/, "").split(":")[0] ?? mxid;
}

/** Display name of a user in a room (member name → profile → localpart). */
export function displayName(roomId: string | null | undefined, mxidOrIdentity: string): string {
  const mxid = mxidOf(mxidOrIdentity);
  const c = peekClient();
  const r = roomId ? c?.getRoom(roomId) : null;
  const m = r?.getMember(mxid);
  const n = m?.rawDisplayName || m?.name;
  if (n && n !== mxid) return n;
  const u = c?.getUser(mxid);
  if (u?.displayName) return u.displayName;
  return localpart(mxid);
}

/** Avatar mxc of a member ("" = none). */
export function avatarMxc(roomId: string | null | undefined, mxid: string): string {
  const c = peekClient();
  const r = roomId ? c?.getRoom(roomId) : null;
  const m = r?.getMember(mxidOf(mxid));
  const url = m?.getMxcAvatarUrl?.() ?? c?.getUser(mxidOf(mxid))?.avatarUrl ?? "";
  return url || "";
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---- base64 ------------------------------------------------------------------------------------

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64encodeNoPad(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/=+$/, "");
}

function tryDecode(s: string, urlSafe: boolean, padded: boolean): Uint8Array | null {
  try {
    if (urlSafe && /[+/]/.test(s)) return null;
    if (!urlSafe && /[-_]/.test(s)) return null;
    if (padded && s.length % 4 !== 0) return null;
    if (!padded && s.includes("=")) return null;
    let t = urlSafe ? s.replace(/-/g, "+").replace(/_/g, "/") : s;
    while (t.length % 4) t += "=";
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Decode a media key in any base64 flavour (url-nopad, standard, url, standard-nopad); must be 16 bytes. */
export function decodeKey(s: string): Uint8Array | null {
  const t = s.trim();
  for (const [u, p] of [
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ] as const) {
    const b = tryDecode(t, u, p);
    if (b && b.length === 16) return b;
  }
  return null;
}

export async function sha256b64NoPad(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64encodeNoPad(new Uint8Array(d));
}

// ---- timers --------------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reject after `ms` with `msg`. */
export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
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

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function dbfs(rms: number): number {
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

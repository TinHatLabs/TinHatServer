// callState.ts — the phone's NATIVE call as the app reports it (bridge 2): `tinhatNative.callState()` plus the window
// event "tinhatnative:call". Only while the app offers the "calls" cap; everywhere else nativeCall() is null and nothing
// is listened to. Pure (imports only ./bridge): the unit tests run it in Node.
//
// The event is a doorbell: its detail is ignored and callState() — the app's frozen getter — is read again, so the one
// source is the app's own object. Whatever it returns is validated (parseNativeCall) before the page uses it.
import { hasNativeCap, nativeCalls, roomIdOk } from "./bridge";

export type NativeCallPhase = "connecting" | "in-call" | "leaving";

export interface NativeCall {
  state: NativeCallPhase;
  roomId: string;
  muted: boolean;
  /** the phone's native device in that call (null until it has joined) — another device of the same account */
  nativeDeviceId: string | null;
}

export const NATIVE_CALL_EVENT = "tinhatnative:call";

/** Untrusted input → a NativeCall or null (unknown phase, bad room id, wrong types). */
export function parseNativeCall(v: unknown): NativeCall | null {
  if (!v || typeof v !== "object") return null;
  try {
    const o = v as Record<string, unknown>;
    const state = o.state;
    if (state !== "connecting" && state !== "in-call" && state !== "leaving") return null;
    const roomId = o.roomId;
    if (!roomIdOk(roomId)) return null;
    const d = o.nativeDeviceId;
    const nativeDeviceId = typeof d === "string" && d.length > 0 && d.length <= 255 && !/[\s\0]/.test(d) ? d : null;
    return { state, roomId, muted: o.muted === true, nativeDeviceId };
  } catch {
    return null;
  }
}

function same(a: NativeCall | null, b: NativeCall | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && a.roomId === b.roomId && a.muted === b.muted && a.nativeDeviceId === b.nativeDeviceId;
}

let current: NativeCall | null = null;
let installed = false;
const listeners = new Set<(c: NativeCall | null) => void>();

function refresh(): void {
  const next = parseNativeCall(nativeCalls.stateRaw());
  if (same(next, current)) return;
  current = next;
  for (const l of [...listeners]) {
    try {
      l(current);
    } catch {
      /* one listener's failure never stops the others */
    }
  }
}

/** Start listening (once) — only inside an app that runs calls. */
function install(): boolean {
  if (installed) return true;
  if (!hasNativeCap("calls")) return false;
  installed = true;
  const w = globalThis as { addEventListener?: (t: string, f: () => void) => void };
  w.addEventListener?.(NATIVE_CALL_EVENT, refresh);
  current = parseNativeCall(nativeCalls.stateRaw());
  return true;
}

/** The native call right now (null: none, or not in an app with calls). A stable object until it changes. */
export function nativeCall(): NativeCall | null {
  return install() ? current : null;
}

/** The native call is on (connecting / in the call / leaving) in `roomId`. */
export function nativeCallIn(roomId: string | null | undefined): boolean {
  const c = nativeCall();
  return !!c && !!roomId && c.roomId === roomId;
}

/** The phone's native call device id while it is in a call (Pad leaves it out of its targets). */
export function nativeDeviceId(): string | null {
  return nativeCall()?.nativeDeviceId ?? null;
}

/** What a room's Join entry point shows instead while the native call is on in THAT room (OnThisPhone.tsx); null =
 *  the entry point as it is. */
export function phoneBanner(c: NativeCall | null, roomId: string): { text: string; canLeave: boolean } | null {
  if (!c || c.roomId !== roomId) return null;
  if (c.state === "connecting") return { text: "Joining this call on this phone…", canLeave: true };
  if (c.state === "leaving") return { text: "Leaving the call on this phone…", canLeave: false };
  return { text: c.muted ? "You're in this call on this phone · muted" : "You're in this call on this phone", canLeave: true };
}

/** Subscribe to changes; returns the unsubscribe. A no-op outside an app with calls. */
export function onNativeCall(cb: (c: NativeCall | null) => void): () => void {
  if (!install()) return () => undefined;
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** tests only: forget the installed state (a fresh "page") */
export function _resetNativeCallForTests(): void {
  const w = globalThis as { removeEventListener?: (t: string, f: () => void) => void };
  if (installed) w.removeEventListener?.(NATIVE_CALL_EVENT, refresh);
  installed = false;
  current = null;
  listeners.clear();
}

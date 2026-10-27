// shared/call.ts — the media area's view of the call engine (features/calls, typed by contract.ts).
//
// Read through `useCallAny(sel)` (React) or `getCall()` (imperative — kept fresh by <CallBridge/>,
// an always-mounted overlay). Every field is optional at runtime: until integration the calls
// feature is a stub without the engine fields/actions, and the media area must degrade (sounds
// still play locally; nothing is published).
import { useEffect } from "react";
import * as calls from "@/features/calls";
import type { CallStore } from "@/features/calls/contract";
import { clipUrlFor } from "./clip";

export type AnyCall = Partial<CallStore>;

type UseCall = <T>(sel: (s: AnyCall) => T) => T;
/** React: select from the call store (contract shape, fields optional). */
export const useCallAny: UseCall = (sel) => (calls.useCall as unknown as UseCall)(sel);

let latest: AnyCall = {};
const listeners = new Set<(c: AnyCall, prev: AnyCall) => void>();

/**
 * Latest call state for imperative code (soundboard/watch-party engines). Reads the calls store
 * directly when it exposes `useCallStore.getState()` (the bridge mirror lags one React render —
 * e.g. `soundPlaying` right after `playSound()` resolves), else the mirror.
 */
export function getCall(): AnyCall {
  const store = Reflect.get(calls as object, "useCallStore") as { getState?: () => AnyCall } | undefined;
  const now = typeof store?.getState === "function" ? store.getState() : null;
  return now ?? latest;
}

/** Subscribe to every call-store change (prev → next). */
export function onCallChange(cb: (c: AnyCall, prev: AnyCall) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Subscribe to the calls store directly when it exposes zustand's subscribe (no React lag). */
export function subscribeCall(cb: (c: AnyCall) => void): () => void {
  const store = Reflect.get(calls as object, "useCallStore") as { subscribe?: (f: (s: AnyCall) => void) => () => void } | undefined;
  if (typeof store?.subscribe === "function") return store.subscribe(cb);
  return onCallChange((c) => cb(c));
}

/**
 * Keep one of our local media elements on the call's Speaker. The browser's echo canceller only hears what plays
 * on that device (features/calls/AEC-WEB.md), so a clip played elsewhere would come back through the mic.
 */
export function followCallOutput(el: HTMLMediaElement): void {
  const f = Reflect.get(calls as object, "followCallOutput") as ((el: HTMLMediaElement) => void) | undefined;
  if (typeof f === "function") f(el);
}

export const isInCall = (c: AnyCall): boolean => !!(c.inCall ?? c.joined);
export const callRoomOf = (c: AnyCall): string => (isInCall(c) ? c.callRoomId || c.roomId || "" : "");

/** Always-mounted (r.overlays): mirrors the store into `latest` and fans out changes. */
export function CallBridge() {
  const s = useCallAny((x) => x);
  useEffect(() => {
    const prev = latest;
    latest = s;
    if (prev !== s) for (const l of [...listeners]) l(s, prev);
  }, [s]);
  return null;
}

/**
 * The URL handed to the engine's playSound: the calls engine runs its own clip-cache mapping (it
 * wraps relative paths and anything containing "myinstants.com" in /api/soundboard/clip?url=), so
 * myinstants URLs go in RAW and everything else (uploads) as an absolute same-origin URL.
 */
export function engineSoundUrl(url: string): string {
  const u = (url ?? "").trim();
  if (!u || /myinstants\.com/i.test(u) || /^(blob:|data:|mxc:)/.test(u)) return u;
  // M9: a foreign link maps to "" (the engine refuses it with FOREIGN_SOUND_NOTE) — never to the page's own URL
  const mapped = clipUrlFor(u);
  if (!mapped) return "";
  try {
    return new URL(mapped, location.href).href;
  } catch {
    return "";
  }
}

/**
 * Publish a sound into the call via the engine ("sound" track, Unknown source — receivers'
 * Soundboard dial). Resolves true once the engine was asked (false outside a call / before
 * integration). `maxMs` = hard cap (join sounds: 3000).
 */
export async function enginePlaySound(url: string, maxMs = 0): Promise<boolean> {
  const c = getCall();
  if (!isInCall(c) || typeof c.playSound !== "function") return false;
  const play = c.playSound as unknown as (u: string, maxMs?: number) => unknown;
  try {
    await Promise.resolve(maxMs > 0 ? play(engineSoundUrl(url), maxMs) : play(engineSoundUrl(url)));
  } catch {
    return true;
  }
  return true;
}

export function engineStopSound(): void {
  const c = getCall();
  if (typeof c.stopSound === "function") void Promise.resolve(c.stopSound()).catch(() => {});
}

/**
 * Join sounds are published by the calls engine (features/calls runs joinsound.rs on join). The
 * media fallback trigger only runs when the engine explicitly says it does NOT
 * (`export const joinSoundHandledByEngine = false`).
 */
export function engineHandlesJoinSound(): boolean {
  // read dynamically: the flag is optional (a static named access warns when it isn't exported)
  return Reflect.get(calls as object, ["joinSound", "HandledByEngine"].join("")) !== false;
}

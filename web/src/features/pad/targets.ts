// targets.ts — Pad's targets inside the Tin Hat iOS / Android apps (pure; the unit tests run it in Node).
//
// In an app with the "calls" cap the phone joins calls with its OWN native device (features/native, bridge 2:
// `tinhatNative.callState().nativeDeviceId`). That device is another device of the same account, so Pad's discovery
// (padTargets, docs/PAD.md) would list it like a PC — but it is the phone the page runs on: never a Pad target. Its
// room's join entry points show "You're in this call on this phone" instead (OnThisPhone).
//
// The app names the device only while its call is on (null until the device has joined, null again once the call is
// over), and the device's call membership can arrive before that or stay after it (a slow leave, an app that died: up
// to the membership's 4 h expiry). So the page remembers every id the app has reported (`known`, runtime.ts keeps it
// per account), and while the native call's room has no id yet, that room offers no target at all.
// App-only: outside the apps there is no native call and nothing is known, so the targets pass through unchanged
// (desktop parity: the desktop has no web view).
import type { PadTarget } from "../calls/pad/rules";

/** What Pad reads of the app's native call (features/native NativeCall). */
export interface NativeCallView {
  roomId: string;
  nativeDeviceId: string | null;
}

/** How many reported native device ids are kept (a reinstalled app gets a new device; the old ones are dead anyway). */
export const NATIVE_KEEP = 8;

/** `known` with `id` added (newest last, no duplicates, at most NATIVE_KEEP); null = unchanged. Always a new array. */
export function rememberNativeDevice(known: readonly string[], id: string | null): string[] {
  if (!id) return [...known];
  const out = known.filter((d) => d !== id);
  out.push(id);
  return out.slice(-NATIVE_KEEP);
}

/** True: `device` is the app's native call device (the current one, or one it reported before). */
export function isNativeDeviceOf(device: string, call: NativeCallView | null, known: readonly string[]): boolean {
  return !!device && (device === call?.nativeDeviceId || known.includes(device));
}

/** `targets` (in `roomId`'s call) without the app's native call device(s); none at all in the room of a native call
 *  that hasn't said which device it is yet. Order kept (padTargets sorts newest first); always a new array. */
export function withoutNativeDevices(targets: readonly PadTarget[], roomId: string, call: NativeCallView | null, known: readonly string[]): PadTarget[] {
  if (call && call.roomId === roomId && !call.nativeDeviceId) return [];
  if (!call?.nativeDeviceId && known.length === 0) return [...targets];
  return targets.filter((t) => !isNativeDeviceOf(t.device, call, known));
}

/** openPad's guard: `device` in `room` is refused when targetsIn would leave it out for being (maybe) the native device
 *  — a native call in that room that hasn't named its device yet, or a native device it named (now or before). */
export function nativeRefusesOpen(device: string, room: string, call: NativeCallView | null, known: readonly string[]): boolean {
  if (call && call.roomId === room && !call.nativeDeviceId) return true;
  return isNativeDeviceOf(device, call, known);
}

/** The storage the memory keeps its list in (runtime.ts: localStorage); null = this page's memory only. */
export interface NativeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Account data (`tinhat.user.*` goes with the session on sign-out, core/matrix/session.ts). */
export const NATIVE_KEY = "tinhat.user.pad-native-devices";

/** The ids the app reported, per account: `{me, list}` in the store under NATIVE_KEY, cached for the account last read.
 *  A store that throws (private mode, blocked storage, quota) degrades to this page's memory, never to an error. */
export class NativeDeviceMemory {
  private cache: { me: string; list: string[] } | null = null;
  private readonly store: NativeStore | null;

  // (no parameter property: Node's type stripping, which the unit tests run on, refuses them)
  constructor(store: NativeStore | null) {
    this.store = store;
  }

  /** A session boundary (sign-in / sign-out / account switch): the next read goes to the store again. */
  reset(): void {
    this.cache = null;
  }

  known(me: string): string[] {
    if (!me) return [];
    if (this.cache?.me === me) return this.cache.list;
    let list: string[] = [];
    try {
      const v = JSON.parse(this.store?.get(NATIVE_KEY) ?? "null") as { me?: unknown; list?: unknown } | null;
      if (v && typeof v === "object" && v.me === me && Array.isArray(v.list)) {
        list = (v.list as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 255 && !/[\s\0]/.test(x)).slice(-NATIVE_KEEP);
      }
    } catch {
      /* nothing usable stored */
    }
    this.cache = { me, list };
    return list;
  }

  /** Remember `id` for `me`; true when the list changed (then it is written to the store). */
  note(me: string, id: string | null): boolean {
    if (!me || !id) return false;
    const cur = this.known(me);
    if (cur[cur.length - 1] === id) return false;
    const list = rememberNativeDevice(cur, id);
    this.cache = { me, list };
    try {
      this.store?.set(NATIVE_KEY, JSON.stringify({ me, list }));
    } catch {
      /* kept for this page only */
    }
    return true;
  }
}

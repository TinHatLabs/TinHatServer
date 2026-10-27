// trust.ts — "trust the phone's native device" (caps "trust"; BRIDGE.md in the iOS repo, docs/TRUST.md here): the page
// cross-signs exactly the device the Tin Hat app set up on this phone, one id + one public ed25519 key, and only after
// the server's copy of that device's key matches it. Pure (no imports): the crypto lookups are injected (trustGlue.ts =
// the real matrix-js-sdk 42 calls; the unit tests stub them). The desktop's trust_device.rs reads the same rule and
// says the same sentences (its tests mirror trust.test.ts case for case).
//
//   1 pending({userId})           → {deviceId, ed25519} | null             (the app; null = nothing to do)
//   2 the server's copy            getUserDeviceInfo([me], true) lists it, getFingerprint() === ed25519 exactly
//                                   missing → wait for the next device-list update (≤ WAIT_MS), look once more,
//                                   then "not-published"; different → "mismatch" (never signed)
//   3 already signed               getDeviceVerificationStatus(me, id).crossSigningVerified → "already"
//   4 the self-signing key here    no identity → "no-cross-signing"; not cached here → "keys-locked"
//   5 crossSignDevice(id)          → "signed"; any error → "failed"
//   6 result({userId, deviceId, result})

export type TrustResult = "signed" | "already" | "not-published" | "mismatch" | "no-cross-signing" | "keys-locked" | "failed";
export const TRUST_RESULTS: readonly TrustResult[] = ["signed", "already", "not-published", "mismatch", "no-cross-signing", "keys-locked", "failed"];

/** What the app's `result()` answers (it decides for itself; the page only logs it). */
export type TrustAppState = "trusted" | "pending" | "failed";

/** Step 2's wait for the next device-list update after a miss (the app fires its event right after publishing). */
export const WAIT_MS = 5_000;

export interface PendingDevice {
  deviceId: string;
  /** unpadded base64 of the device's public ed25519 key, as getFingerprint() prints it */
  ed25519: string;
}

/** A device id as Synapse and the Rust SDK make them (and any sane server): printable, no spaces, bounded. */
export function deviceIdOk(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 255 && /^[\x21-\x7e]+$/.test(v);
}

/** An ed25519 public key as getFingerprint() prints it: 32 bytes, unpadded standard base64 = 43 characters. */
export function ed25519Ok(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(v);
}

/** The app's `pending()` answer, checked: anything else than {deviceId, ed25519} of the right shape → null. */
export function parsePending(v: unknown): PendingDevice | null {
  try {
    if (!v || typeof v !== "object") return null;
    // each property read once (a getter could answer differently the second time)
    const { deviceId, ed25519 } = v as { deviceId?: unknown; ed25519?: unknown };
    if (!deviceIdOk(deviceId) || !ed25519Ok(ed25519)) return null;
    return { deviceId, ed25519 };
  } catch {
    return null;
  }
}

/** The app's `result()` answer, checked (null = no usable answer). */
export function parseTrustAnswer(v: unknown): TrustAppState | null {
  try {
    if (!v || typeof v !== "object") return null;
    const { state } = v as { state?: unknown };
    return state === "trusted" || state === "pending" || state === "failed" ? state : null;
  } catch {
    return null;
  }
}

/** The crypto facts the rule needs (trustGlue.ts: matrix-js-sdk 42; desktop: the Rust SDK). */
export interface TrustLookup {
  /** this page's own device id (never signed through this path: it isn't the phone's) */
  ownDeviceId(): string;
  /** the server's copy of my device `deviceId`: its ed25519 fingerprint, "" when it has none, null when not listed */
  deviceKey(deviceId: string): Promise<string | null>;
  /** resolves at the next update of my device list (or once `deviceId` is listed), at the latest after `ms` */
  nextDeviceUpdate(deviceId: string, ms: number): Promise<void>;
  /** my self-signing key has signed `deviceId` (crossSigningVerified) */
  crossSigned(deviceId: string): Promise<boolean>;
  /** the account has a cross-signing identity; the private self-signing key is cached on this device */
  signing(): Promise<{ identity: boolean; selfSigningKeyHere: boolean }>;
  /** crossSignDevice(deviceId) — the adapter checks once more, right at the signature, that the device it signs has
   *  exactly `ed25519` and that the session is still the one that started (throws otherwise) */
  sign(deviceId: string, ed25519: string): Promise<void>;
}

/**
 * Steps 2–5 for one device the app (or, on the Devices fallback, the person) named with its key. Never throws; never
 * signs anything but `deviceId`, and that only when the server's key for it is exactly `ed25519`.
 */
export async function trustDevice(look: TrustLookup, deviceId: string, ed25519: string, waitMs = WAIT_MS): Promise<TrustResult> {
  try {
    if (!deviceIdOk(deviceId) || !ed25519Ok(ed25519) || deviceId === look.ownDeviceId()) return "mismatch";
    // 2: the server's copy
    let key = await look.deviceKey(deviceId);
    if (key === null) {
      await look.nextDeviceUpdate(deviceId, waitMs);
      key = await look.deviceKey(deviceId);
    }
    if (key === null) return "not-published";
    if (key !== ed25519) return "mismatch";
    // 3: already signed
    if (await look.crossSigned(deviceId)) return "already";
    // 4: the self-signing key here
    const s = await look.signing();
    if (!s.identity) return "no-cross-signing";
    if (!s.selfSigningKeyHere) return "keys-locked";
    // 5: sign — the key is checked once more right before (a device list update may have landed meanwhile)
    if ((await look.deviceKey(deviceId)) !== ed25519) return "mismatch";
    await look.sign(deviceId, ed25519);
    return "signed";
  } catch {
    return "failed";
  }
}

// ---- when the page tries (contract: "at most one attempt per device per page load, plus one per event") -------------

export type TrustTrigger = "load" | "event" | "verified";

/**
 * The attempt bookkeeping for one signed-in account on one page load. `load`: once per device. `event`: one per
 * event. `verified`: this device just became verified — one more try for a device whose last answer was "keys-locked"
 * (the contract's "once verified, it tries again"). A device that answered "mismatch" is never tried again on this
 * page load. Runs never overlap: a trigger during a run is kept (one) and runs after it.
 */
export class TrustAttempts {
  private loadTried = new Set<string>();
  private refused = new Set<string>();
  private locked = new Set<string>();

  /** May this trigger run for `deviceId`? (marks the load attempt as used) */
  allow(trigger: TrustTrigger, deviceId: string): boolean {
    if (this.refused.has(deviceId)) return false;
    if (trigger === "load") {
      if (this.loadTried.has(deviceId)) return false;
      this.loadTried.add(deviceId);
      return true;
    }
    if (trigger === "verified") {
      if (!this.locked.has(deviceId)) return false;
      this.locked.delete(deviceId);
      return true;
    }
    return true;
  }

  /** What the run answered. */
  note(deviceId: string, r: TrustResult): void {
    if (r === "mismatch") this.refused.add(deviceId);
    if (r === "keys-locked") this.locked.add(deviceId);
    else this.locked.delete(deviceId);
  }
}

// ---- the Devices fallback (desktop + web, same words) -----------------------------------------------------------------

/** The phone's native device as the apps name it ("Tin Hat · iPhone (calls and notifications)"; iOS NativeCore.swift,
 *  Android NativeCore.kt). Only these rows get "Trust…": the name is the server's text, so it only picks the row — the
 *  person checks the fingerprint, and the steps above check the key. */
export function isNativePhoneDevice(name: string): boolean {
  return /^Tin Hat · .{1,80} \(calls and notifications\)$/.test(name);
}

/** The fingerprint as the dialog shows it: groups of four, like every Matrix client's "session key". */
/**
 * The Devices fallback is OFF in 12.0.4 (launch-gate, 2026-10-27, assembly-035 review). The row is picked by the
 * device's NAME (the server's text, any device of the account can set it), and the phone apps don't show their own
 * fingerprint, so the person has nothing to compare the sheet's key with. Someone with the password could name a device
 * "Tin Hat · iPhone (calls and notifications)" and get it cross-signed with one tap, and with that the room keys and the
 * secrets a verified own device is given. Only the bridge path signs (the app names its own device to the page on the
 * same phone). Back on with (b) the phone showing its fingerprint + the sheet asking to compare, or (c) SAS/QR against
 * the native device. The code below stays; this switch and the desktop's trust_device::DEVICES_FALLBACK move together.
 */
export const DEVICES_FALLBACK = false;

/** Does a row of Settings → Devices get "Trust…"? Never while DEVICES_FALLBACK is off, whatever the name. */
export function fallbackOffersTrust(name: string): boolean {
  return DEVICES_FALLBACK && isNativePhoneDevice(name);
}

export function fingerprintText(ed25519: string): string {
  return (ed25519.match(/.{1,4}/g) ?? []).join(" ");
}

export const TRUST_WORDS = {
  action: "Trust…",
  title: "Trust this phone?",
  body: (name: string) =>
    `${name} is the device the Tin Hat app on your phone set up for calls and notifications. Trust it only if you set it up yourself. Its fingerprint:`,
  button: "Trust",
  cancel: "Cancel",
  working: "Trusting…",
  verify: "Verify this device…",
} as const;

/** The sentence the Devices fallback shows for a result ("" = close the dialog: done). */
export function trustResultText(r: TrustResult, name: string): string {
  switch (r) {
    case "signed":
    case "already":
      return "";
    case "not-published":
      return `${name} hasn't published its keys yet. Open Tin Hat on the phone, then try again.`;
    case "mismatch":
      return `The key your server has for ${name} doesn't match. Nothing was trusted. Set the phone up again in the Tin Hat app.`;
    case "no-cross-signing":
      return "Your account has no encryption set up yet, so nothing can vouch for this phone. Verify this device first.";
    case "keys-locked":
      return "Verify this device first: only a verified device can vouch for your phone.";
    default:
      return "Couldn't trust it. Try again in a moment.";
  }
}

/** The toast after a done result. */
export function trustDoneText(r: "signed" | "already", name: string): string {
  return r === "signed" ? `Trusted ${name}` : `${name} is already trusted`;
}

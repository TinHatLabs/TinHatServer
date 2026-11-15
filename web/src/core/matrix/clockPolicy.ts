// clockPolicy.ts — device clocks vs verification requests, and the verify dialog's plain notes around them
// (fix/verify-request, 2026-11-12). Desktop twin, word for word: crates/app/src/clock_policy.rs (same vectors in both
// test suites: clockPolicy.test.ts here).
//
// Why: matrix-sdk-crypto (both apps; the web through its WASM build) silently DROPS an incoming
// m.key.verification.request whose `timestamp` (the SENDER's clock) is more than 10 minutes older or 5 minutes newer
// than the receiver's clock (VerificationMachine::is_timestamp_valid). Nothing goes back to the sender, so a device
// with a wrong clock waits forever in both directions. A PC that dual-boots Linux and Windows is the usual way there.

/** The SDK ignores a request older than this (seconds)… */
export const SDK_TOO_OLD_S = 600;
/** …or this far ahead (seconds). */
export const SDK_TOO_NEW_S = 300;
/** Our clock vs the server's: warn at two minutes either way (well inside both SDK limits; launch-gate 2026-11-12).
 * The warning never blocks anything. */
export const WARN_SKEW_S = 120;
/** An outgoing request with no answer after this long gets the "what to check" note. */
export const NO_ANSWER_MS = 30_000;

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** Would matrix-sdk-crypto drop a request stamped `requestTsMs` (sender's clock) arriving at `nowMs`? Whole seconds. */
export function requestDroppedForTime(requestTsMs: number, nowMs: number): boolean {
  const ts = floorDiv(requestTsMs, 1000);
  const now = floorDiv(nowMs, 1000);
  return now - ts > SDK_TOO_OLD_S || ts - now > SDK_TOO_NEW_S;
}

/** Is this device's clock (skewS = ours minus the server's) far enough off to break verification? */
export function clockOff(skewS: number): boolean {
  return Math.abs(skewS) >= WARN_SKEW_S;
}

function unitOf(s: number, minMinutes: number): [number, string] {
  if (s >= 36 * 3600) return [floorDiv(s + 43_200, 86_400), "day"];
  if (s >= 90 * 60) return [floorDiv(s + 1800, 3600), "hour"];
  return [Math.max(minMinutes, floorDiv(s + 30, 60)), "minute"];
}

/** "about 5 hours", "about 1 hour", "about 12 minutes", "about 2 days" (rounded, never "0"). */
export function about(secs: number): string {
  const [n, unit] = unitOf(Math.abs(Math.trunc(secs)), 1);
  return `about ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(secs: number): string {
  const s = Math.max(0, Math.trunc(secs));
  if (s < 90) return "just now";
  const [n, unit] = unitOf(s, 0);
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

const WINDOWS_TIME_HINT = " On Windows: Settings → Time & language → Date & time → Sync now.";

/** This device's own clock is off (checked against the server before a request goes out). */
export function ownClockNote(skewS: number, windows: boolean): string {
  return `This device's clock is ${about(skewS)} off, so verifying with your other devices may not work. Set the time automatically (date, time and time zone), then try again.${windows ? WINDOWS_TIME_HINT : ""}`;
}

/** An own device asked to verify, but the SDK dropped it for its timestamp. gapS = its stamp minus our clock;
 * ownSkewS = our clock minus the server's when known. Then the sender's own skew is gap + own, so the note can say
 * WHICH clock is off — or, for an old request with our clock right, that it was late or its clock is behind. */
export function peerClockNote(peer: string, gapS: number, ownSkewS: number | null, windows: boolean): string {
  const who = peer.trim() || "Another of your devices";
  const hint = windows ? WINDOWS_TIME_HINT : "";
  if (ownSkewS === null)
    return `${who} asked to verify, but its clock and this device's are ${about(gapS)} apart, so the request can't be used. Set the time automatically on both, then try again.`;
  // the sender's skew vs the server, IF the request came straight through (an old request may just be late)
  const theirs = gapS + ownSkewS;
  if (clockOff(ownSkewS)) {
    // "both off" only when it is AHEAD: a late delivery could explain a sender that only looks behind
    return clockOff(theirs) && theirs > 0
      ? `${who} asked to verify, but both clocks are off (this device's by ${about(ownSkewS)}, that one's by ${about(theirs)}), so the request can't be used. Set the time automatically on both, then try again.${hint}`
      : `${who} asked to verify, but this device's clock is ${about(ownSkewS)} off, so the request can't be used. Set the time automatically here, then try again.${hint}`;
  }
  // stamped in our future: only its clock can explain that
  if (gapS > 0)
    return `${who} asked to verify, but its clock is ${about(theirs)} off, so the request can't be used. Set the time automatically on that device (date, time and time zone), then try again.`;
  // too old: sent while this device was offline, or that device's clock is behind — say both
  return `${who} asked to verify, but the request is ${about(gapS)} old, so it can't be used: it was sent while this device was offline, or that device's clock is behind. Ask again from ${who} while both devices are open, and check its clock.`;
}

/** An own device asked to verify, but this device doesn't have that device's keys yet (the SDK drops it too). */
export function peerUnknownNote(peer: string): string {
  const who = peer.trim() || "Another of your devices";
  return `${who} asked to verify, but this device hasn't caught up with it yet. Try again in a moment, or start from here: Settings → Security → that session → Verify this session.`;
}

/** While an outgoing request waits. */
export const NOTE_WAITING_OUT =
  "Open Tin Hat on another of your signed-in devices and accept there. Or start it from Tin Hat on a phone or in a browser: Settings → Security → this session → Verify this session.";

/** "A", "A or B", "A, B or C" (at most three; blanks skipped). */
export function deviceList(names: readonly string[]): string {
  const n = names.map((s) => s.trim()).filter((s) => s !== "").slice(0, 3);
  if (n.length === 0) return "";
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}`;
}

/** One device's label: its name (else its id) and when it was last active (null = unknown). */
export function deviceLabel(name: string, id: string, seenAgoS: number | null): string {
  const base = name.trim() || id.trim();
  return seenAgoS === null ? base : `${base} (active ${ago(seenAgoS)})`;
}

/** The outgoing request got no answer in NO_ANSWER_MS. */
export function noAnswerNote(names: readonly string[]): string {
  const list = deviceList(names);
  const open = list ? `Open Tin Hat on ${list} and accept there` : "Open Tin Hat on another of your signed-in devices and accept there";
  return `No answer yet. ${open}, or start it from Tin Hat on a phone or in a browser: Settings → Security → this session → Verify this session. If nothing shows up there, check that the date, time and time zone are right on both devices.`;
}

export const NOTE_WRONG_KEY = "That Security Key doesn't match your account. Check it for typos, or use the newest one you saved.";
export const NOTE_NOT_A_KEY = "That doesn't look like a Security Key. Check it for typos: it's 48 letters and numbers in groups of four.";

/** The verify-with-Security-Key failure line for a raw error. Unknown errors keep the raw text after "Verification failed:". */
export function keyErrorNote(raw: string): string {
  const r = raw.trim();
  const l = r.toLowerCase();
  if (l.includes("mac check") || l.includes("invalid mac") || l.includes("doesn't match this account")) return NOTE_WRONG_KEY;
  const notAKey = ["doesn't look like a security key", "parity", "invalid prefix", "incorrect prefix", "key has an invalid length", "incorrect length", "base58"];
  if (notAKey.some((w) => l.includes(w))) return NOTE_NOT_A_KEY;
  if (r === "") return "Verification failed.";
  return `Verification failed: ${r}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** HTTP Date header (IMF-fixdate) → ms since the epoch; null = not that. Same strict rules as the desktop. */
export function parseHttpDate(s: string): number | null {
  const p = s.trim().split(/\s+/);
  if (p.length !== 6 || p[5] !== "GMT" || !p[0].endsWith(",")) return null;
  const num = (x: string) => (/^\d{1,4}$/.test(x) ? Number(x) : NaN);
  const day = num(p[1]);
  const month = MONTHS.indexOf(p[2]);
  const year = num(p[3]);
  const t = p[4].split(":").map(num);
  if (month < 0 || t.length !== 3 || t.some(Number.isNaN) || Number.isNaN(day) || Number.isNaN(year)) return null;
  if (day < 1 || day > 31 || t[0] > 23 || t[1] > 59 || t[2] > 60 || year < 1970 || year > 9999) return null;
  const ms = Date.UTC(year, month, day, t[0], t[1], t[2]);
  return Number.isFinite(ms) ? ms : null;
}

/** Our clock minus the server's, whole seconds (nearest, halves away from zero, so +119.5 and -119.5 treat alike),
 * from a Date header and the local send/answer times. null = no usable header. */
export function skewFromDate(dateHeader: string, sentMs: number, gotMs: number): number | null {
  const server = parseHttpDate(dateHeader);
  if (server === null) return null;
  const mid = sentMs + Math.trunc((gotMs - sentMs) / 2);
  const d = mid - (server + 500);
  return d >= 0 ? floorDiv(d + 500, 1000) : -floorDiv(-d + 500, 1000);
}

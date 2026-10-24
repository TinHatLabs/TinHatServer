// model.ts — REACH §2, §3.4 + A2.2/A2.12/A2.13/A2.15: the pure presence rules, mirrored one-to-one by the
// desktop's crates/app/src/presence_model.rs (same function names in camelCase, same test names in
// model.test.ts). No imports and no clock: runtime.ts / push/active.ts feed the facts and act on the answers.
// (The timer-driven senders live in machine.ts; the custom status in status.ts.)

export const PREF_TYPE = "dev.tinhat.presence";
export const ASKED_TYPE = "dev.tinhat.presence_asked";

/** §2.4: away after this much idle. */
export const AWAY_AFTER_MS = 10 * 60_000;
/** §3.4: the computer counts as in use while idle is below this. */
export const ACTIVE_IDLE_MS = 3 * 60_000;
/** §2.5 cadence; the server allows one GET per 5 s per token (A2.4). */
export const READ_VISIBLE_MS = 20_000;
export const READ_HIDDEN_MS = 60_000;
export const READ_MIN_GAP_MS = 5_500;
/** §2.5: keep the last good map this long on errors, then clear it. */
export const MAP_KEEP_MS = 60_000;
/** §3.4 / A2.12 cadence. */
export const ACTIVE_EVERY_MS = 15_000;
export const QUIET_WANTED_EVERY_MS = 10 * 60_000;
/** A failed quiet-wanted check = no consent until a check succeeds; it is retried after this long. */
export const QUIET_WANTED_RETRY_MS = 60_000;
/** A2.12: pings only while the last good sync is younger than this. */
export const SYNC_HEALTHY_MS = 60_000;
/** A2.2: the off switch's DELETE retries 2 s, 4 s, 8 s … capped at a minute. */
export const DELETE_BACKOFF_FIRST_MS = 2_000;
export const DELETE_BACKOFF_MAX_MS = 60_000;

/** What the idle probe saw. On the web, `locked` = a phone page that went into the background. */
export interface IdleSample {
  idleMs: number;
  locked: boolean;
}

/** §2.4: `away` when idle ≥ 10 min or locked, else `online` (the server turns any call into `call`). */
export function beatState(s: IdleSample): "online" | "away" {
  return s.locked || s.idleMs >= AWAY_AFTER_MS ? "away" : "online";
}

/** The `PUT /api/presence` body (§2.3). */
export function beatBody(state: "online" | "away", call: string | null): { state: "online" | "away"; call: string | null; client: "web" } {
  return { state, call, client: "web" };
}

export type BeatOutcome = "ok" | "not_sharing" | "retry";

/** 2xx ok; 409 not_sharing stops the beats; anything else keeps the cadence (no storm, no silent stop). */
export function beatOutcome(status: number, body: unknown): BeatOutcome {
  if (status >= 200 && status <= 299) return "ok";
  if (status === 409 && (body as { error?: unknown } | null)?.error === "not_sharing") return "not_sharing";
  return "retry";
}

export type ShareChange = "start" | "stop_and_delete" | "same";

/** `before` = null while the preference isn't known yet. Learning "not sharing" at start sends nothing. */
export function shareChange(before: boolean | null, now: boolean): ShareChange {
  if (before === true && !now) return "stop_and_delete";
  if (now && before !== true) return "start";
  return "same";
}

/** `dev.tinhat.presence` → sharing? Absent, malformed or anything but `share === true` = no. */
export function parseShare(content: unknown): boolean {
  return !!content && typeof content === "object" && (content as { share?: unknown }).share === true;
}

/** `dev.tinhat.presence_asked` → answered? */
export function parseAsked(content: unknown): boolean {
  return !!content && typeof content === "object" && (content as { asked?: unknown }).asked === true;
}

/** The whole consent object, as the switch / the card write it (A2.2). */
export function prefContent(share: boolean): { share: boolean; v: 1 } {
  return { share, v: 1 };
}

export function askedContent(): { asked: true } {
  return { asked: true };
}

export interface Seen {
  state: "online" | "away" | "call";
  /** the call's room ("" unless state is call and we may see it) */
  room: string;
  /** A4.4: {text, emoji, color} when the person has a valid custom status (web reads it already) */
  status?: { text: string; emoji: string; color: string };
}

/** §2.5: the GET body → mxid → Seen. Unknown states and malformed rows are dropped (no dot beats a wrong dot);
 *  `room` is kept only for `call`. */
export function parseUsers(body: unknown): Map<string, Seen> {
  const out = new Map<string, Seen>();
  const users = body && typeof body === "object" ? (body as { users?: unknown }).users : undefined;
  if (!users || typeof users !== "object" || Array.isArray(users)) return out;
  for (const [mxid, v] of Object.entries(users as Record<string, unknown>)) {
    if (!mxid.startsWith("@") || !mxid.includes(":")) continue;
    const o = v as { state?: unknown; room?: unknown; status?: unknown } | null;
    const state = o && typeof o === "object" ? o.state : undefined;
    if (state !== "online" && state !== "away" && state !== "call") continue;
    const room = state === "call" && typeof o!.room === "string" && o!.room.startsWith("!") ? o!.room : "";
    const seen: Seen = { state, room };
    const st = o!.status as { text?: unknown; emoji?: unknown; color?: unknown } | undefined;
    if (st && typeof st === "object" && typeof st.text === "string" && st.text.trim() && typeof st.color === "string")
      seen.status = { text: st.text.trim(), emoji: typeof st.emoji === "string" ? st.emoji : "", color: st.color };
    out.set(mxid, seen);
  }
  return out;
}

/** A2.15: "Others see you as …" comes from the server's view of you — your own entry. */
export function myView(map: ReadonlyMap<string, Seen>, me: string): Seen | null {
  return map.get(me) ?? null;
}

/** §2.5: keep the last good map on errors, but not longer than a minute. */
export function keepMap(sinceLastGoodMs: number | null): boolean {
  return sinceLastGoodMs !== null && sinceLastGoodMs <= MAP_KEEP_MS;
}

export function readInterval(visible: boolean): number {
  return visible ? READ_VISIBLE_MS : READ_HIDDEN_MS;
}

/** §3.4 / A2.12: at the computer — in a call, or unlocked (visible) with input within 3 minutes. */
export function computerActive(s: IdleSample, inCall: boolean): boolean {
  return inCall || (!s.locked && s.idleMs < ACTIVE_IDLE_MS);
}

/** A2.12: pings at all only while signed in, the sync is healthy (< 60 s), notifications are on here and
 *  the account asked for them (a push registration with quietWhileActive). */
export function mayPing(signedIn: boolean, sinceSyncMs: number | null, notificationsOn: boolean, quietWanted: boolean): boolean {
  return signedIn && notificationsOn && quietWanted && sinceSyncMs !== null && sinceSyncMs < SYNC_HEALTHY_MS;
}

/** What the web's activity decision looks at (push/active.ts feeds it). */
export interface PingFacts {
  signedIn: boolean;
  /** phone form factor (never "a computer") */
  phone: boolean;
  /** this device's pushkey while its push is on ("" = push off here) */
  pushkey: string;
  /** consent for user-level pings: the account has a push registration with quietWhileActive (GET /api/push/quiet-wanted) */
  quietWanted: boolean;
  sinceSyncMs: number | null;
  /** a computer's eligibility for user-level pings: in-page notifications on and allowed */
  canNotify: boolean;
}

/** The key an activity ping carries — or undefined = no ping at all. Nothing while signed out or while the sync
 *  is unhealthy. A6: push ON here → this device's own pushkey (its foreground report while its page is on screen;
 *  turning on its push is the consent — no quiet registration needed, phone or computer). Push off here → a
 *  user-level "at a computer" ping (null) — a computer only, and only with quietWhileActive consent + its
 *  notifications on (A2.12, web review #2). */
export function pingKeyFor(f: PingFacts): string | null | undefined {
  if (!f.signedIn) return undefined;
  if (f.sinceSyncMs === null || f.sinceSyncMs >= SYNC_HEALTHY_MS) return undefined;
  if (f.pushkey) return f.pushkey;
  if (f.phone || !f.quietWanted || !f.canNotify) return undefined;
  return null;
}

export type Ping = "active" | "inactive" | "none";

/** `activeSent` = the server was last told visible: true; `due` = ≥ 15 s since the last visible: true attempt. */
export function pingStep(allowedAndActive: boolean, activeSent: boolean, due: boolean): Ping {
  if (allowedAndActive) return due ? "active" : "none";
  return activeSent ? "inactive" : "none";
}

/** The `POST /api/push/active` body (§3.4, A2.12 identity). A phone sends its own pushkey; a computer null. */
export function pingBody(visible: boolean, instance: string, pushkey: string | null = null): { pushkey: string | null; visible: boolean; instance: string } {
  return { pushkey, visible, instance };
}

/** `GET /api/push/quiet-wanted` → wanted? Anything but an explicit true is no (consent first). */
export function parseQuietWanted(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { wanted?: unknown }).wanted === true;
}

export function nextBackoff(prevMs: number | null): number {
  return prevMs === null ? DELETE_BACKOFF_FIRST_MS : Math.min(prevMs * 2, DELETE_BACKOFF_MAX_MS);
}

/** §2.7: the one-time question — never answered, not sharing, preference known, not in a call. */
export function showQuestion(known: boolean, asked: boolean, sharing: boolean, inCall: boolean): boolean {
  return known && !asked && !sharing && !inCall;
}

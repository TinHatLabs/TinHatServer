// callrules.ts — the pure call rules of the calls round (security review 2026-10-26, M1 + M2; contract: share
// claude/tinhat-security-review/fixes/calls-round/DESIGN.md). No imports beyond keyrules.ts / focus.ts: unit-tested
// under Node (`callrules.test.ts` replays every section of testvectors/calls.json, byte-identical to the desktop's
// crates/app/src/testvectors/calls.json and the mobile core's src/testvectors/calls.json).
//
//   Live sessions   the 12.0.x liveness / schema / state-key ownership rule (moved here from rtc.ts unchanged).
//   M1 (focus)      normalizeFocusUrl · hostOf · ownFoci · focusDecision (own | trusted | ask | refuse) · sfuUrlOk.
//   M2 (keys)       keyRecipientsV2 (the web rule + device still exists + not gone from the call server) · the
//                   rotate-on-leave planner (3 s debounce, 3 s use delay, one pending key) · noteIndex (receivers).
//   Send boundary   dispatchChecked: the to-device batches go out one by one, each re-checked right before its send.
import { keyRecipients, stateKeyOwned } from "./keyrules";
import { focusFromWellKnown } from "./focus";

export const MEMBERSHIP_EXPIRES_MS = 14_400_000;
export const DEBOUNCE_MS = 3000;
export const USE_DELAY_MS = 3000;
export const RING = 255;
export const MAX_FOCUS_URL = 2048;
/** account data holding the call hosts the user chose "Always trust" for: {"v":1,"allow":["b.test","c.test:8448"]} */
export const CALL_HOSTS_TYPE = "dev.tinhat.call_hosts";

type Content = Record<string, unknown>;

/** A call membership state event as raw fields (what MatrixEvent / the vectors give). */
export interface RawMemberEvent {
  sender: string;
  state_key: string;
  origin_server_ts: number;
  content: Content;
}

export interface Focus {
  serviceUrl: string;
  alias: string;
}

export interface LiveSession {
  sender: string;
  deviceId: string;
  stateKey: string;
  createdTs: number;
  focus: Focus | null;
  kind: string; // dev.tinhat.client.kind ("" = not Tin Hat)
  recordOptout: boolean;
  /** `membershipID` of the session ("" = none) — the only non-derived member.id a key may carry */
  membershipId: string;
  /** strict schema (application m.call, scope m.room, call_id "", finite expires > 0): required for keys */
  wellFormed: boolean;
}

// ---- live sessions (12.0.x rule, unchanged) -----------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Liveness of one session-shaped object (spec §4.2 "Liveness rule"). */
function entryLive(c: Content, originTs: number, now: number): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  const created = num(c.created_ts) ?? (originTs > 0 ? originTs : null);
  if (created === null) return true;
  const expires = num(c.expires) ?? MEMBERSHIP_EXPIRES_MS;
  return now <= created + expires;
}

// ---- roster rule (guest-leave, 12.1) ------------------------------------------------------------------------------

/** Who shows "in the call" (rosters, the nav strip, the join banner, "a call is going on"): a call membership counts
 *  only while its sender's room membership is `join`. Someone kicked (a guest when the guest room is turned off) can't
 *  withdraw their own membership any more, so it would show them in the call until it expires (up to 4 h). Unknown
 *  (a lazily-loaded room whose member event isn't here yet) counts: better a stray bubble than a hidden peer.
 *  NOT for keys (keyrules: a joined member only, unknown = no key) and not for the focus rule. Native: rtc.rs
 *  roster_counts. */
export function rosterCounts(membership: string | null | undefined): boolean {
  return membership === undefined || membership === null || membership === "" || membership === "join";
}

/** A membership event's content is live (session form or legacy memberships[]). */
export function contentLive(c: Content | undefined, originTs: number, now = Date.now()): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  if (Array.isArray(c.memberships)) {
    return (c.memberships as Content[]).some((m) => m && typeof m === "object" && entryLive(m, originTs, now));
  }
  return entryLive(c, originTs, now);
}

/** The first livekit focus with a non-empty URL in foci_preferred (when an array), else in foci_active. An empty or
 *  missing alias means the room itself. */
export function focusOf(c: Content, roomId: string): Focus | null {
  const list = (Array.isArray(c.foci_preferred) ? c.foci_preferred : Array.isArray(c.foci_active) ? c.foci_active : []) as Content[];
  for (const f of list) {
    if (f && f.type === "livekit" && typeof f.livekit_service_url === "string" && f.livekit_service_url) {
      return { serviceUrl: f.livekit_service_url, alias: typeof f.livekit_alias === "string" && f.livekit_alias ? f.livekit_alias : roomId };
    }
  }
  return null;
}

/** Live msc3401 sessions among `events` (typed session format + legacy array), one per (user, device), first seen
 *  wins. Room membership of the sender is NOT checked here (keys check it; the focus rule must not). */
export function sessionsFrom(events: readonly RawMemberEvent[], roomId: string, now: number): LiveSession[] {
  const out: LiveSession[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const c = (ev.content ?? {}) as Content;
    const origin = ev.origin_server_ts;
    const sender = ev.sender ?? "";
    if (!sender || !contentLive(c, origin, now)) continue;
    const arrayForm = Array.isArray(c.memberships);
    const entries: Content[] = arrayForm
      ? (c.memberships as Content[]).filter((m) => m && typeof m === "object" && entryLive(m, origin, now))
      : [c];
    const stateKey = ev.state_key ?? "";
    for (const e of entries) {
      if (e.application !== undefined && e.application !== "m.call") continue;
      if (e.scope !== undefined && e.scope !== "m.room") continue;
      const dev = typeof e.device_id === "string" ? e.device_id : "";
      // Schema + ownership (Astra finding 3): a device id is required, and the state key must belong
      // to the sender and that device — a membership someone else's key claims is not a member.
      if (!dev || !stateKeyOwned(stateKey, sender, dev, arrayForm)) continue;
      const k = `${sender}|${dev}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const marker = (e["dev.tinhat.client"] ?? c["dev.tinhat.client"]) as Content | undefined;
      out.push({
        sender,
        deviceId: dev,
        stateKey,
        createdTs: num(e.created_ts) ?? origin,
        focus: focusOf(e, roomId),
        kind: marker && typeof marker.kind === "string" ? marker.kind : "",
        recordOptout: !!marker && marker.record_optout === true,
        membershipId: typeof e.membershipID === "string" ? e.membershipID : "",
        wellFormed: e.application === "m.call" && e.scope === "m.room" && e.call_id === "" && (num(e.expires) ?? 0) > 0,
      });
    }
  }
  return out;
}

// ---- ordering -----------------------------------------------------------------------------------------------------

/** Byte order of the UTF-8 forms (= code point order; JS `<` compares UTF-16 units, which differs above the BMP). */
export function cmpBytes(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length < 0 ? -1 : a.length === b.length ? 0 : 1;
}

export function sortIds(ids: Iterable<string>): string[] {
  return [...ids].sort(cmpBytes);
}

/** The oldest session: a TOTAL order on (created_ts, sender, device_id) — a tie on created_ts must not let two clients
 *  pick different services (launch-gate's 12.0.5 review). */
export function oldestSession<T extends { createdTs: number; sender: string; deviceId: string }>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const s of list) {
    if (!best) {
      best = s;
      continue;
    }
    const d = s.createdTs - best.createdTs || cmpBytes(s.sender, best.sender) || cmpBytes(s.deviceId, best.deviceId);
    if (d < 0) best = s;
  }
  return best;
}

// ---- M1: addresses ------------------------------------------------------------------------------------------------

// any character ≤ 0x20 or 0x7F (WHATWG strips tabs/newlines silently — so this runs before parsing)
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000- \u007f]/;

export type FocusUrlReason = "bad-url" | "insecure-scheme";
export type FocusUrlResult = { url: string } | { reason: FocusUrlReason };

/** DESIGN §2.3: `https://` + host (lower-case, punycode) + `:port` unless 443 + the path without trailing `/`. */
export function normalizeFocusUrl(s: unknown): FocusUrlResult {
  const bad: FocusUrlResult = { reason: "bad-url" };
  if (typeof s !== "string" || !s || s.length > MAX_FOCUS_URL || CTRL.test(s) || s.includes("?") || s.includes("#")) return bad;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad;
  }
  if (u.protocol === "http:") return { reason: "insecure-scheme" };
  if (u.protocol !== "https:") return bad;
  if (u.username || u.password || !u.hostname) return bad;
  return { url: `https://${u.host}${u.pathname.replace(/\/+$/, "")}` };
}

/** `host[:port]` of a normalised focus URL ("" when it doesn't parse) — shown on the sheet, kept in the allow-list. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The LiveKit address a call service answered with: wss or https, a host, no user-info, no control characters. */
export function sfuUrlOk(s: unknown): boolean {
  if (typeof s !== "string" || !s || CTRL.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "wss:" && u.protocol !== "https:") return false;
  return !!u.hostname && !u.username && !u.password;
}

/** Own foci: the well-known's first livekit focus (normalised, https only) and `<homeserver>/livekit/jwt`. A new call
 *  always starts on `start`: the well-known focus when valid, else the homeserver's; "" when neither is a valid https
 *  address (focusDecision then refuses: no OpenID request for an http or broken own service). */
export function ownFoci(wellKnown: unknown, hsOrigin: string): { start: string; set: Set<string> } {
  const set = new Set<string>();
  const wk = focusFromWellKnown(wellKnown);
  const w = wk ? normalizeFocusUrl(wk) : null;
  const hsRaw = `${String(hsOrigin).replace(/\/+$/, "")}/livekit/jwt`;
  const h = normalizeFocusUrl(hsRaw);
  if (w && "url" in w) set.add(w.url);
  if ("url" in h) set.add(h.url);
  const start = w && "url" in w ? w.url : "url" in h ? h.url : "";
  return { start, set };
}

// ---- M1: the token request (no redirects, ever) ----------------------------------------------------------------------

export const REDIRECT_REFUSED_TEXT = "The call service tried to redirect the sign-in proof, so Tin Hat didn't follow it";

/** The fetch options of the OpenID → `{service}/sfu/get` POST. `redirect: "error"`: the browser refuses a 3xx BEFORE
 *  following it — a 307/308 would re-send the sign-in proof to a host nobody approved (security coordinator MUST-FIX
 *  for 12.1.0; the mobile core's calls.rs no_redirect_client is the same rule). */
export function sfuGetInit(body: string, signal?: AbortSignal): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error", signal };
}

/** Any redirect answer is a failure, never followed: an `opaqueredirect` response or a 3xx status (a fetch that
 *  hands one back anyway — a polyfill, a test double, `redirect: "manual"` somewhere). */
export function isRedirectAnswer(res: { status: number; type?: string }): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

/**
 * POST the OpenID proof to `{serviceUrl}/sfu/get` exactly once, with `fetchFn` (the page's fetch; a mock in the unit
 * test). Throws on a redirect (any 3xx, never followed), a non-2xx answer, a missing url/jwt, or an unsafe LiveKit
 * address (sfuUrlOk). Network / timeout errors propagate as the fetch rejection.
 */
export async function postSfuGet(
  fetchFn: (url: string, init: RequestInit) => Promise<{ status: number; ok: boolean; type?: string; text(): Promise<string> }>,
  serviceUrl: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ url: string; jwt: string }> {
  const res = await fetchFn(`${serviceUrl.replace(/\/+$/, "")}/sfu/get`, sfuGetInit(body, signal));
  if (isRedirectAnswer(res)) throw new Error(REDIRECT_REFUSED_TEXT);
  const text = await res.text();
  if (!res.ok) throw new Error(`lk-jwt-service HTTP ${res.status}: ${text.slice(0, 300)}`);
  let j: { url?: unknown; jwt?: unknown };
  try {
    j = JSON.parse(text) as { url?: unknown; jwt?: unknown };
  } catch {
    throw new Error("lk-jwt-service answered with something that isn't JSON");
  }
  if (typeof j.url !== "string" || typeof j.jwt !== "string" || !j.url || !j.jwt) throw new Error("lk-jwt-service answered without url/jwt");
  if (!sfuUrlOk(j.url)) throw new Error(UNSAFE_SFU_TEXT);
  return { url: j.url, jwt: j.jwt };
}

// ---- M1: the decision ---------------------------------------------------------------------------------------------

export type FocusVerdict = "own" | "trusted" | "ask" | "refuse";
export type RefuseReason = FocusUrlReason | "alias-mismatch" | "foreign-host";

export interface FocusDecision {
  decision: FocusVerdict;
  /** a call is already running (false: we start one on `start`) */
  call: boolean;
  serviceUrl?: string;
  alias?: string;
  host?: string;
  advertiser?: string;
  reason?: RefuseReason;
}

export interface FocusInput {
  roomId: string;
  now: number;
  events: readonly RawMemberEvent[];
  ownSet: ReadonlySet<string>;
  start: string;
  allow: readonly string[];
}

/** DESIGN §2.2. Never falls back: a refused / declined running call is never replaced by one on the own service. */
export function focusDecision(o: FocusInput): FocusDecision {
  const live = sessionsFrom(o.events, o.roomId, o.now).filter((s) => s.focus);
  const sel = oldestSession(live);
  if (!sel?.focus) {
    const n = normalizeFocusUrl(o.start);
    if ("reason" in n) return { decision: "refuse", call: false, reason: n.reason };
    return { decision: "own", call: false, serviceUrl: n.url, alias: o.roomId };
  }
  const advertiser = sel.sender;
  const n = normalizeFocusUrl(sel.focus.serviceUrl);
  if ("reason" in n) return { decision: "refuse", call: true, reason: n.reason, advertiser };
  if (sel.focus.alias !== o.roomId) return { decision: "refuse", call: true, reason: "alias-mismatch", advertiser };
  if (o.ownSet.has(n.url)) return { decision: "own", call: true, serviceUrl: n.url, alias: o.roomId, advertiser };
  const host = hostOf(n.url);
  const trusted = o.allow.some((h) => typeof h === "string" && h.toLowerCase() === host);
  return { decision: trusted ? "trusted" : "ask", call: true, serviceUrl: n.url, alias: o.roomId, host, advertiser };
}

/** What the app does with a decision: ASK_FOREIGN_HOSTS false turns every foreign host (trusted or not) into a refusal. */
export function applyHostPolicy(d: FocusDecision, askForeign: boolean = ASK_FOREIGN_HOSTS): FocusDecision {
  if (askForeign || (d.decision !== "ask" && d.decision !== "trusted")) return d;
  return { decision: "refuse", call: d.call, reason: "foreign-host", advertiser: d.advertiser, host: d.host };
}

// ---- M1: the words (DESIGN §2.4 — the same on web, desktop and phone) ---------------------------------------------

export const HOST_SHEET_TITLE = "Join a call hosted elsewhere?";
export const HOST_SHEET_JOIN = "Join";
export const HOST_SHEET_CANCEL = "Cancel";
export const hostSheetAlways = (host: string) => `Always trust ${host}`;
/** The body text (the sheet shows `host` in bold). */
export function hostSheetBody(host: string, me: string, advertiserName: string, advertiser: string): string {
  return (
    `This call runs on ${host}, not on your server. Joining gives ${host} your IP address and a sign-in proof that says ` +
    `you are ${me} (valid for up to an hour). What you say and show stays end-to-end encrypted. ` +
    `Started by ${advertiserName} (${advertiser}).`
  );
}
export const REFUSE_TEXT: Readonly<Record<RefuseReason, string>> = {
  "insecure-scheme": "This call runs on an unencrypted address, so Tin Hat won't join it.",
  "bad-url": "This call's address isn't valid, so Tin Hat won't join it.",
  "alias-mismatch": "This call points at a different room, so Tin Hat won't join it.",
  "foreign-host": "This call runs on another server, so Tin Hat won't join it.",
};
export const UNSAFE_SFU_TEXT = "The call service answered with an unsafe address";
/** Q1 (the maintainer's decision): calls hosted by another server are asked about (true) — flip to false to refuse them outright. */
export const ASK_FOREIGN_HOSTS = true;

// ---- M1: the allow-list (account data dev.tinhat.call_hosts) ------------------------------------------------------

/** The hosts in a dev.tinhat.call_hosts content (v 1 only; lower-case, deduped, each a valid host[:port]). */
export function callHostsOf(content: unknown): string[] {
  const c = content && typeof content === "object" ? (content as Content) : null;
  if (!c || c.v !== 1 || !Array.isArray(c.allow)) return [];
  const out: string[] = [];
  for (const h of c.allow) {
    if (typeof h !== "string") continue;
    const n = normalizeFocusUrl(`https://${h}`);
    const host = "url" in n ? hostOf(n.url) : "";
    if (host && host === h.toLowerCase() && !out.includes(host)) out.push(host);
  }
  return out;
}

export function withCallHost(content: unknown, host: string): { v: 1; allow: string[] } {
  const list = callHostsOf(content);
  const h = host.toLowerCase();
  return { v: 1, allow: list.includes(h) ? list : [...list, h] };
}

export function withoutCallHost(content: unknown, host: string): { v: 1; allow: string[] } {
  const h = host.toLowerCase();
  return { v: 1, allow: callHostsOf(content).filter((x) => x !== h) };
}

// ---- M2: recipients -----------------------------------------------------------------------------------------------

export interface RecipientSession {
  sender: string;
  deviceId: string;
  createdTs: number;
  wellFormed?: boolean;
}

/**
 * Recipient rule v2 (DESIGN §3.1): the web rule (live, well-formed, joined — an unknown member (null) is NOT joined —,
 * not our own device, deduped) + the device is in the user's device list when that list is known (null = unknown,
 * excludes no one) + no `sfuGone` entry for `user:device` with this session's created_ts. Sorted by `user|device`.
 */
export function keyRecipientsV2(
  sessions: readonly RecipientSession[],
  membershipOf: (userId: string) => string | null,
  ownUserId: string,
  ownDeviceId: string,
  devicesOf: (userId: string) => ReadonlySet<string> | null,
  sfuGone: ReadonlyMap<string, number>,
): Array<{ userId: string; deviceId: string }> {
  const created = new Map<string, number>();
  for (const s of sessions) {
    const k = `${s.sender}|${s.deviceId}`;
    if (!created.has(k)) created.set(k, s.createdTs);
  }
  return keyRecipients(sessions, membershipOf, ownUserId, ownDeviceId)
    .filter((r) => {
      const devs = devicesOf(r.userId);
      if (devs && !devs.has(r.deviceId)) return false;
      const gone = sfuGone.get(`${r.userId}:${r.deviceId}`);
      return gone === undefined || gone !== created.get(`${r.userId}|${r.deviceId}`);
    })
    .sort((a, b) => cmpBytes(`${a.userId}|${a.deviceId}`, `${b.userId}|${b.deviceId}`));
}

/**
 * Device lists for rule v2, failing CLOSED per user (coordinator, 2026-10-27): a user whose device-list read failed
 * this round has NO devices (never a stale list — it could hold a device that has since been removed); the caller
 * retries the read shortly. A user never read (not in `lists`, not failed) is unknown → null → excludes no one; so is an
 * empty list of a user whose devices were never `seen` non-empty.
 */
export function deviceLookup(
  lists: ReadonlyMap<string, ReadonlySet<string>>,
  failed: ReadonlySet<string>,
  seen: ReadonlySet<string> = new Set(),
): (userId: string) => ReadonlySet<string> | null {
  const none: ReadonlySet<string> = new Set<string>();
  return (u) => {
    if (failed.has(u)) return none;
    const l = lists.get(u);
    // an EMPTY list is authoritative ("every device removed") only once this user's devices were seen non-empty:
    // before that it means "not downloaded yet" (desktop Astra round 3 — a new joiner must not go unkeyed)
    if (!l || (l.size === 0 && !seen.has(u))) return null;
    return l;
  };
}

/** After our sender switches, recipients whose send of the new key failed get it again on this short ladder (ms after
 *  the switch) instead of waiting for the 60 s steady copy; the switch itself never waits (the leaver must not keep
 *  decrypting). */
export const RESEND_AFTER_USE_MS: readonly number[] = [2000, 5000, 10000];

/** The resend ladder for `failed` (`user|device` ids) after a switch at `usedAt`: one rung per delay, sorted ids. */
export function resendPlan(failed: Iterable<string>, usedAt: number): Array<{ at: number; to: string[] }> {
  const to = sortIds(new Set(failed));
  return to.length ? RESEND_AFTER_USE_MS.map((d) => ({ at: usedAt + d, to })) : [];
}

/** Members whose room membership the client doesn't know yet (lazy-loaded list) among live, well-formed sessions —
 *  they get no key now; the caller re-announces once the member list is loaded (launch-gate's 12.0.5 review). */
export function unknownMembers(sessions: readonly RecipientSession[], membershipOf: (userId: string) => string | null, ownUserId: string): string[] {
  const out = new Set<string>();
  for (const s of sessions) if (s.sender && s.sender !== ownUserId && s.wellFormed !== false && membershipOf(s.sender) === null) out.add(s.sender);
  return sortIds(out);
}

// ---- M2: receivers' index book (unchanged rule, shared with installSlot) ------------------------------------------

/** Hold `index` for one device: a new index is appended (arrival order), a resent one keeps its place, and past `cap`
 *  the oldest-inserted is evicted. Returns the new list and what was evicted. */
export function noteIndex(held: readonly number[], index: number, cap: number): { held: number[]; evicted: number[] } {
  const out = [...held];
  const evicted: number[] = [];
  if (!out.includes(index)) {
    out.push(index);
    while (out.length > cap) evicted.push(out.shift()!);
  }
  return { held: out, evicted };
}

// ---- M2: the rotate-on-leave planner (DESIGN §3.3) ----------------------------------------------------------------

export type PlanAction = { announce: { keys: number[]; to: string[] } } | { mint: { index: number; to: string[] } } | { use: number };

export interface PlannerConfig {
  debounceMs: number;
  useDelayMs: number;
  ring: number;
}

const DEFAULT_PLAN: PlannerConfig = { debounceMs: DEBOUNCE_MS, useDelayMs: USE_DELAY_MS, ring: RING };

export interface Planner {
  /** the index our media is encrypted with */
  readonly inUse: number;
  /** the minted, not yet used index (null = none) */
  readonly pending: number | null;
  /** a holder of the upcoming key has left and the debounce runs */
  readonly departing: boolean;
  /** when the pending key goes into use (null = nothing pending); desktop `use_at` */
  readonly useAt: number | null;
  /** when a step mints for the current departure (its debounce ends; null = no departure, a key already pending, or
   *  rotation off); desktop `mint_at`. The driver wakes at min(useAt, mintAt) instead of waiting for its 1 s tick. */
  readonly mintAt: number | null;
  /** what every ladder / steady / refresh / resume announce sends: [current, pending?] */
  announceKeys(): number[];
  step(now: number, R: Iterable<string>): PlanAction[];
  /** A key went (or may have gone) to `ids` outside the planner's own actions (join / ladder / steady / refresh
   *  announces): they hold it from now on, so their departure rotates (call right BEFORE the send). */
  noteHolders(ids: Iterable<string>, indices: readonly number[]): void;
  /** Only step 1 of `step`: a pending key whose use time has come becomes the key in use (→ [{use}] or []). Driven
   *  by a timer on its own, so a slow recipient read never delays the switch away from a leaver's key. */
  tick(now: number): PlanAction[];
}

/** Start the planner at the join: `index` is in use and R (ids `user|device`) gets it. */
export function createPlanner(index: number, now: number, R: Iterable<string>, cfg: PlannerConfig = DEFAULT_PLAN): { planner: Planner; out: PlanAction[] } {
  let cur = index;
  let curHolders = new Set(R);
  let pending: { index: number; useAt: number; holders: Set<string> } | null = null;
  let departAt: number | null = null;
  void now;

  const announceKeys = () => (pending ? [cur, pending.index] : [cur]);
  const useIfDue = (t: number, out: PlanAction[]) => {
    if (pending && t >= pending.useAt) {
      cur = pending.index;
      curHolders = pending.holders;
      pending = null;
      out.push({ use: cur });
    }
  };

  const planner: Planner = {
    get inUse() {
      return cur;
    },
    get pending() {
      return pending ? pending.index : null;
    },
    get departing() {
      return departAt !== null;
    },
    get useAt() {
      return pending ? pending.useAt : null;
    },
    get mintAt() {
      const at = departAt !== null && !pending ? departAt + cfg.debounceMs : null;
      return at !== null && Number.isFinite(at) ? at : null;
    },
    announceKeys,
    tick(t: number): PlanAction[] {
      const out: PlanAction[] = [];
      useIfDue(t, out);
      return out;
    },
    noteHolders(ids: Iterable<string>, indices: readonly number[]) {
      const list = [...ids];
      if (indices.includes(cur)) for (const x of list) curHolders.add(x);
      if (pending && indices.includes(pending.index)) for (const x of list) pending.holders.add(x);
    },
    step(t: number, Rin: Iterable<string>): PlanAction[] {
      const R = new Set(Rin);
      const out: PlanAction[] = [];
      useIfDue(t, out); // 1
      const holders = pending ? pending.holders : curHolders;
      const newcomers = sortIds([...R].filter((x) => !holders.has(x)));
      if (newcomers.length) out.push({ announce: { keys: announceKeys(), to: newcomers } }); // 2
      for (const x of R) {
        curHolders.add(x); // 3
        pending?.holders.add(x);
      }
      const h = pending ? pending.holders : curHolders;
      const gone = [...h].some((x) => !R.has(x)); // 4
      departAt = gone ? (departAt ?? t) : null;
      if (departAt !== null && !pending && t - departAt >= cfg.debounceMs) {
        // 5
        const idx = (cur + 1) % cfg.ring;
        pending = { index: idx, useAt: t + (R.size ? cfg.useDelayMs : 0), holders: new Set(R) };
        departAt = null;
        out.push({ mint: { index: idx, to: sortIds(R) } });
      }
      useIfDue(t, out); // 6
      return out;
    },
  };
  const R0 = sortIds(curHolders);
  return { planner, out: R0.length ? [{ announce: { keys: [index], to: R0 } }] : [] };
}

/**
 * Step-time minting (assembly-037 review W1; the desktop mints inside its planner lock the same way): every `mint` a
 * step returns gets its key in `ring` NOW, before the caller awaits anything. The planner's own timer (`tick`) can make
 * that index current while the step's earlier actions (a switch, a newcomer announce) are still being sent; with the
 * key already in the ring the sender's switch and the mint's announce use the SAME key (minting it later let a
 * recovery mint one key for the sender and the announce another for the peers, at the same index). A key already at
 * that index is from an earlier lap of the ring and is replaced. Returns the indices minted, in order.
 */
export function mintAtStep<K>(acts: readonly PlanAction[], ring: Map<number, K>, mint: () => K): number[] {
  const out: number[] = [];
  for (const a of acts) {
    if (!("mint" in a)) continue;
    ring.set(a.mint.index, mint());
    out.push(a.mint.index);
  }
  return out;
}

// ---- kill switch (DESIGN §3.10) -----------------------------------------------------------------------------------

/** The own well-known turns key rotation off: dev.tinhat.server.features.call_key_rotation === false. */
export function rotationOff(wellKnown: unknown): boolean {
  const t = wellKnown && typeof wellKnown === "object" ? (wellKnown as Content)["dev.tinhat.server"] : undefined;
  const f = t && typeof t === "object" ? (t as Content).features : undefined;
  return !!f && typeof f === "object" && (f as Content).call_key_rotation === false;
}

// ---- the send boundary (launch-gate's 12.0.5 review) --------------------------------------------------------------

export interface ToDeviceMsg {
  userId: string;
  deviceId: string;
}

export interface DispatchDeps<M extends ToDeviceMsg> {
  /** the `user|device` ids eligible RIGHT NOW (null = the whole send is void: call left, generation superseded) */
  eligible: () => ReadonlySet<string> | null;
  /** refresh what `eligible` reads (device lists) right before each request's check */
  refresh?: () => Promise<void>;
  /** called with a chunk's ids right before it is sent (the planner registers them as holders) */
  beforeSend?: (ids: string[]) => void;
  send: (chunk: M[], txnId: string) => Promise<void>;
  txnId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** messages per request (matrix-js-sdk's queue uses 20) */
  size?: number;
  /** attempts per chunk (a retry re-checks first) */
  attempts?: number;
  backoffMs?: number;
}

/**
 * Send encrypted to-device messages in chunks, re-checking eligibility immediately before EVERY request (and every
 * retry): a recipient who left / was kicked while earlier chunks were in flight is dropped from the later ones. What
 * this can't close: a change that lands while a request is already on the wire (one HTTP round trip). Resolves to the
 * ids actually handed to the server.
 */
export async function dispatchChecked<M extends ToDeviceMsg>(msgs: readonly M[], d: DispatchDeps<M>): Promise<{ sent: string[]; dropped: string[]; failed: string[] }> {
  const size = d.size ?? 20;
  const attempts = d.attempts ?? 3;
  const sent: string[] = [];
  const dropped: string[] = [];
  const failed: string[] = [];
  const id = (m: M) => `${m.userId}|${m.deviceId}`;
  for (let i = 0; i < msgs.length; i += size) {
    let chunk = msgs.slice(i, i + size);
    let txn = "";
    let lastIds = "";
    let done = false;
    for (let a = 0; a < attempts && !done; a++) {
      if (a) await d.sleep((d.backoffMs ?? 500) * a);
      if (d.refresh) await d.refresh();
      const ok = d.eligible();
      const keep = ok ? chunk.filter((m) => ok.has(id(m))) : [];
      for (const m of chunk) if (!keep.includes(m)) dropped.push(id(m));
      chunk = keep;
      if (!chunk.length) {
        done = true;
        break;
      }
      const ids = chunk.map(id).join(",");
      if (ids !== lastIds) {
        txn = d.txnId(); // same content → same txn id (an idempotent retry); changed content → a new one
        lastIds = ids;
      }
      d.beforeSend?.(chunk.map(id));
      try {
        await d.send(chunk, txn);
        sent.push(...chunk.map(id));
        done = true;
      } catch {
        /* retry (re-checked first) */
      }
    }
    if (!done) failed.push(...chunk.map(id));
    if (!d.eligible()) {
      for (const m of msgs.slice(i + size)) dropped.push(id(m));
      break;
    }
  }
  return { sent, dropped, failed };
}

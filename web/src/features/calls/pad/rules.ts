// rules.ts — Pad (your phone as a remote for your call): the PURE rules. No DOM, no store, no network and no clock
// (every time is passed in): discovery (padTargets), the trust + schema + session checks every Pad message passes
// (checkPadMessage on the receiver, acceptState on the controller), the receiver's session table (PadSessions), the
// sound rule (soundAllowed), the state snapshot and its caps (buildState), the rate bucket (RateBucket), the stale
// maths (staleCheck / openStale) and the words (whyText). The desktop runs the same rules
// (crates/app/src/padrules.rs) and both replay the shared vectors.json (byte-identical in the desktop repo:
// crates/app/src/testvectors/pad.json). The normative contract is docs/PAD.md (same text in both repos).
//
// Wire (v1, Olm-encrypted to-device between my own cross-signing-verified devices, never a room event):
//   dev.tinhat.pad.cmd   controller → receiver  {v:1, sid, seq, ts, room, gen (not on open), op, …op fields}
//   dev.tinhat.pad.state receiver → controller  {v:1, sid, rseq, rt, re, ok, why, ops, call}
// Every op is a SET (never a toggle), so a duplicate can't flip anything twice. The trust facts (decrypted? Olm
// sender, bound device, verified both ways) come from the glue; everything decided from them lives here.

import { stateKeyOwned } from "../keyrules";

export const PAD = {
  v: 1,
  leaseMs: 45_000,
  maxSessions: 4,
  staleMs: 8_000,
  openSkewMs: 300_000,
  ratePerSec: 8,
  rateBurst: 16,
  busyEveryMs: 1_000,
  pushEveryMs: 250,
  talkPushEveryMs: 500,
  maxPeople: 64,
  maxRecent: 8,
  maxStateBytes: 16_384,
  maxUrl: 2_048,
  maxName: 64,
  maxEmoji: 16,
  maxHint: 200,
  /** a Media Party title (call.party.title, next[].title) */
  maxTitle: 200,
  /** call.party.next */
  maxNext: 5,
  /** a Media Party position / duration in seconds (24 h) */
  maxPos: 86_400,
  maxBuckets: 16,
  /** a bucket idle this long is full again (16 tokens at 8/s, busy allowed): forgetting it changes nothing */
  bucketIdleMs: 2_000,
  /** a sid that left the table is remembered this long (2 × openSkewMs: no replay of its open can be fresh enough) */
  spentMs: 600_000,
  /** spent sids + sessions stay at most this many: when full, new opens wait (`busy`) — nothing unexpired is forgotten */
  maxSpent: 64,
  /** nesting depth of a wire content (the content itself = 1) */
  maxDepth: 32,
  membershipExpiresMs: 14_400_000,
} as const;

export const PAD_CAP = "pad1";
export const PAD_CMD = "dev.tinhat.pad.cmd";
export const PAD_STATE = "dev.tinhat.pad.state";
/** The ops a v1 receiver runs (the state's `ops`; the controller shows only listed controls). */
export const PAD_OPS = [
  "sound.play",
  "sound.stop",
  "mic",
  "deafen",
  "brb",
  "vol",
  "vol.reset",
  "leave",
  // 2026-10-31 (QOL, additive): a search result played on the receiver, and its Media Party
  "sound.play.web",
  "party.join",
  "party.play",
  "party.seek",
  "party.next",
  "party.add",
] as const;
export const PAD_CATS = ["mic", "screenshare", "music"] as const;
export type PadCat = (typeof PAD_CATS)[number];
export const PAD_MIC = ["on", "muted", "server", "ptt"] as const;

type Obj = Record<string, unknown>;

// ---- shapes ------------------------------------------------------------------------------------------------

const PROTO_KEYS = ["__proto__", "constructor", "prototype"];

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
/** An OWN field of a wire object (never one inherited from Object.prototype). */
function own(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
function has(o: Obj, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
/** A JSON number that is an integer of at most 2^53 − 1 in size (1.0 counts; "1", 1.5 and NaN don't). */
function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x);
}
function isUint(x: unknown): x is number {
  return isInt(x) && x >= 0;
}
function isLevel(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 2;
}
/** Length in Unicode code points (the same count as Rust's `chars()`). */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function cpTrunc(s: string, max: number): string {
  let n = 0;
  let out = "";
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}
function strOf(x: unknown): string {
  return typeof x === "string" ? x : "";
}
/** No lone UTF-16 surrogates (the desktop's JSON parser refuses them, so a string with one can't cross over). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return false;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** The wire hygiene both apps share: objects / arrays nested at most 32 deep (the content itself = 1) and no key or
 *  string with a lone surrogate (Rust strings can't hold one: the desktop's parser drops such a message first). */
export function wireOk(x: unknown): boolean {
  const stack: Array<[unknown, number]> = [[x, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (typeof v === "string") {
      if (!wellFormed(v)) return false;
      continue;
    }
    if (v === null || typeof v !== "object") continue;
    if (d > PAD.maxDepth) return false;
    if (Array.isArray(v)) for (const e of v) stack.push([e, d + 1]);
    else
      for (const k of Object.keys(v)) {
        if (!wellFormed(k)) return false;
        stack.push([(v as Obj)[k], d + 1]);
      }
  }
  return true;
}

/** A short wire id (`gen`): 1–64 of [A-Za-z0-9_-], never `__proto__` & co (as `validCornerId`). */
export function validId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s) && !PROTO_KEYS.includes(s);
}
/** A session id: exactly 16 base64url characters. */
export function validSid(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{16}$/.test(s);
}
/** A room id: "!" + 1–254 printable ASCII characters. */
export function validRoom(s: unknown): s is string {
  return typeof s === "string" && /^![\x21-\x7E]{1,254}$/.test(s);
}
/** A refusal code: 0–32 of [a-z-]. */
export function validWhy(s: unknown): s is string {
  return typeof s === "string" && /^[a-z-]{0,32}$/.test(s);
}
/** A user id: "@local:server", printable ASCII, no ":" in the localpart, at most 255 characters. */
export function validUser(s: unknown): s is string {
  return typeof s === "string" && s.length <= 255 && /^@[\x21-\x39\x3B-\x7E]+:[\x21-\x7E]+$/.test(s);
}

const WEB_SOUND = /^https:\/\/(?:www\.)?myinstants\.com\/media\/sounds\/([A-Za-z0-9_.-]{1,200})$/;
/** A search result the receiver may play (`sound.play.web`): exactly a myinstants sound file,
 *  `https://[www.]myinstants.com/media/sounds/<file>` with `<file>` = 1–200 of [A-Za-z0-9_.-] ending in .mp3 / .ogg /
 *  .wav / .m4a / .opus, never a `..`; nothing after it (no query, no fragment). That is what both apps' search returns
 *  (`MYINSTANTS_BASE` + `mp3Path`); the receiver still plays it through its own server's clip cache. */
export function webSoundOk(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const m = WEB_SOUND.exec(url);
  return !!m && !m[1]!.includes("..") && /\.(?:mp3|ogg|wav|m4a|opus)$/.test(m[1]!);
}

const PARTY_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "open.spotify.com", "music.apple.com"];
/** A link a Pad may add to the receiver's Media Party (`party.add`): `https://` + exactly one of PARTY_HOSTS (ASCII,
 *  case-insensitive), then nothing or a path / query starting with `/` or `?`; no user info, no port, no backslash,
 *  white space or control character; 1–2048 code points. Direct media files and other sites are not accepted from a
 *  Pad (the receiver's player would fetch them); the receiver's own link rules (`parseMediaLink`) still decide after. */
export function partyLinkOk(url: unknown): url is string {
  if (typeof url !== "string" || url === "" || cpLen(url) > PAD.maxUrl) return false;
  if (/[\s\\\u0000-\u001f\u007f-\u009f]/.test(url) || !/^[\x21-\x7E]+$/.test(url)) return false;
  const m = /^https:\/\/([^/?#]+)(?:[/?].*)?$/i.exec(url);
  if (!m) return false;
  return PARTY_HOSTS.includes(m[1]!.toLowerCase());
}

// ---- trust (security rules 1–4) ----------------------------------------------------------------------------

/** What the glue knows about one received Pad message (looked up per message, cached ≤ 60 s, dropped on any
 *  device-list / trust change). */
export interface PadFacts {
  /** rule 1: arrived as an Olm-decrypted to-device event (not plaintext, not UTD, not a room event) */
  decrypted: boolean;
  /** the user the Olm session authenticates */
  olmSender: string;
  /** the to-device event's `sender` */
  eventSender: string;
  /** the device the Olm sender key belongs to ("" = not bound to a known device) */
  senderDevice: string;
  /** rule 3: the Olm Curve25519 key equals the device record of `senderDevice` */
  curveMatches: boolean;
  myUserId: string;
  myDeviceId: string;
  /** rule 4a: THIS device is verified (all three cross-signing private keys cached) */
  selfVerified: boolean;
  /** rule 4b: `senderDevice` is cross-signing trusted (not merely signed by the listed self-signing key) */
  peerTrusted: boolean;
}

/** Rules 1–4, in this order. Every failure is a SILENT drop (no reply: no oracle, no state to an untrusted device). */
export function checkTrust(f: PadFacts): { ok: boolean; reason: string } {
  const no = (reason: string) => ({ ok: false, reason });
  if (f.decrypted !== true) return no("not-olm");
  if (!f.olmSender || f.olmSender !== f.eventSender) return no("sender-mismatch");
  if (!f.myUserId || f.olmSender !== f.myUserId) return no("other-user");
  if (!f.senderDevice || f.curveMatches !== true) return no("unbound");
  if (f.senderDevice === f.myDeviceId) return no("own-device");
  if (f.selfVerified !== true) return no("self-unverified");
  if (f.peerTrusted !== true) return no("peer-untrusted");
  return { ok: true, reason: "" };
}

// ---- rate bucket + stale maths -----------------------------------------------------------------------------

export type Hit = "ok" | "busy" | "drop";

/** Per controller device: 8 commands/s, burst 16; over budget → at most one `busy` reply per second, the rest are
 *  dropped (no amplification). Pure on the timestamps it is handed; a clock that goes back refills nothing. */
export class RateBucket {
  tokens: number = PAD.rateBurst;
  last: number | null = null;
  lastBusy: number | null = null;
  hit(now: number): Hit {
    if (this.last === null) this.last = now;
    else if (now > this.last) {
      this.tokens = Math.min(PAD.rateBurst, this.tokens + ((now - this.last) * PAD.ratePerSec) / 1000);
      this.last = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return "ok";
    }
    if (this.lastBusy === null || now - this.lastBusy >= PAD.busyEveryMs) {
      this.lastBusy = now;
      return "busy";
    }
    return "drop";
  }
}

/** An `open` whose `ts` is more than 5 min off the receiver's clock is refused (`stale`). */
export function openStale(ts: number, now: number): boolean {
  return Math.abs(now - ts) > PAD.openSkewMs;
}
/** A later command is stale when it arrived more than 8 s after it was sent, measured with the clock offset
 *  recorded at `open` (offset = receiver now − controller ts): 8.000 s is fine, 8.001 s is stale. */
export function staleCheck(offset: number, ts: number, now: number): boolean {
  return now - (ts + offset) > PAD.staleMs;
}

// ---- the receiver's session table --------------------------------------------------------------------------

export interface PadSession {
  sid: string;
  /** the controller device that opened it — only that device may use the sid */
  device: string;
  lastSeq: number;
  /** receiver now − controller ts, at open */
  offset: number;
  /** the last accepted command (the lease runs 45 s from here) */
  lastAt: number;
  openedAt: number;
  /** false after `ping {vis:false}`: no unsolicited state pushes */
  vis: boolean;
  /** the controller asked for talking rings (`open {want:["talk"]}`) */
  talk: boolean;
  /** the last state sent to it (reply or push), null = none yet */
  pushedAt: number | null;
}

export class PadSessions {
  /** in open order (oldest first) */
  sessions: PadSession[] = [];
  /** devices whose Pad was ended with × on the receiver: refused (`closed`) until the call changes */
  refused = new Set<string>();
  private buckets = new Map<string, RateBucket>();
  /** sids that left the table (closed, replaced, lapsed, refused, cleared) → when: never opened again for spentMs */
  private spentAt = new Map<string, number>();

  private purgeSpent(now: number): void {
    for (const [sid, at] of [...this.spentAt]) if (now - at > PAD.spentMs) this.spentAt.delete(sid);
  }
  private spend(sids: string[], now: number): void {
    this.purgeSpent(now);
    for (const sid of sids) {
      this.spentAt.delete(sid);
      this.spentAt.set(sid, now);
    }
  }
  /** Room for one more session: spent sids (unexpired) + sessions < 64. A spent sid is never forgotten early (that
   *  would make its replay possible again), so when full a new open waits (`busy`) until the oldest expire. */
  roomToOpen(now: number): boolean {
    this.purgeSpent(now);
    return this.spentAt.size + this.sessions.length < PAD.maxSpent;
  }
  spentCount(): number {
    return this.spentAt.size;
  }
  /** A sid that left the table within the last spentMs (a lapsed one counts at once). */
  isSpent(sid: string, now: number): boolean {
    if (this.sessions.some((s) => s.sid === sid && !this.alive(s, now))) return true;
    const at = this.spentAt.get(sid);
    return at !== undefined && now - at <= PAD.spentMs;
  }

  private alive(s: PadSession, now: number): boolean {
    return now - s.lastAt <= PAD.leaseMs;
  }
  /** The live session with this sid (a lapsed one is gone even before `sweep`). */
  get(sid: string, now: number): PadSession | undefined {
    return this.sessions.find((s) => s.sid === sid && this.alive(s, now));
  }
  live(now: number): PadSession[] {
    return this.sessions.filter((s) => this.alive(s, now));
  }
  /** Forget lapsed sessions; returns their sids (their controllers are gone: no final state). */
  sweep(now: number): string[] {
    const gone = this.sessions.filter((s) => !this.alive(s, now)).map((s) => s.sid);
    this.sessions = this.sessions.filter((s) => this.alive(s, now));
    this.spend(gone, now);
    return gone;
  }
  /** A new session (the sid is neither live nor spent). One per controller device (its older one is replaced) and at
   *  most four (the oldest is evicted). Returns the replaced sids: each gets a final state `why: "replaced"`. */
  open(sid: string, device: string, seq: number, ts: number, talk: boolean, now: number): string[] {
    this.sweep(now);
    const evicted: string[] = [];
    for (const s of this.sessions) if (s.device === device || s.sid === sid) evicted.push(s.sid);
    this.sessions = this.sessions.filter((s) => s.device !== device && s.sid !== sid);
    while (this.sessions.length >= PAD.maxSessions) evicted.push(this.sessions.shift()!.sid);
    this.spend(evicted, now);
    this.sessions.push({ sid, device, lastSeq: seq, offset: now - ts, lastAt: now, openedAt: now, vis: true, talk, pushedAt: null });
    return evicted;
  }
  close(sid: string, now: number): boolean {
    const n = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.sid !== sid);
    if (this.sessions.length === n) return false;
    this.spend([sid], now);
    return true;
  }
  /** × on the receiver: end that device's sessions and refuse it until `clearRefused` (the call changed). */
  refuse(device: string, now: number): string[] {
    const gone = this.sessions.filter((s) => s.device === device).map((s) => s.sid);
    this.sessions = this.sessions.filter((s) => s.device !== device);
    this.refused.add(device);
    this.spend(gone, now);
    return gone;
  }
  clearRefused(): void {
    this.refused.clear();
  }
  /** Pad switched off: every session ends (each gets a final state `why: "off"`). */
  clear(now: number): string[] {
    const gone = this.sessions.map((s) => s.sid);
    this.sessions = [];
    this.spend(gone, now);
    return gone;
  }
  /** The rate bucket of one controller device. At most 16 are kept; to make room only buckets idle for ≥ 2 s are
   *  forgotten (they are full again, so nothing is lost). null = no room: the message is dropped (`rate`). */
  bucket(device: string, now: number): RateBucket | null {
    let b = this.buckets.get(device);
    if (b) return b;
    if (this.buckets.size >= PAD.maxBuckets) {
      for (const [d, x] of [...this.buckets]) if (x.last !== null && now - x.last >= PAD.bucketIdleMs) this.buckets.delete(d);
      if (this.buckets.size >= PAD.maxBuckets) return null;
    }
    b = new RateBucket();
    this.buckets.set(device, b);
    return b;
  }
  bucketCount(): number {
    return this.buckets.size;
  }
  /** How long an unsolicited state push to `sid` must wait: 0 = now, n = ms, −1 = not at all (no session,
   *  `vis:false`, or a talking-only change nobody asked for). Pushes ≤ 4/s, talking-only changes ≤ 2/s. */
  pushWait(sid: string, now: number, talkOnly: boolean): number {
    const s = this.get(sid, now);
    if (!s || !s.vis || (talkOnly && !s.talk)) return -1;
    if (s.pushedAt === null) return 0;
    const gap = talkOnly ? PAD.talkPushEveryMs : PAD.pushEveryMs;
    const since = now - s.pushedAt;
    return since >= gap ? 0 : gap - since;
  }
  /** A state (reply or push) went to `sid`. */
  markPushed(sid: string, now: number): void {
    const s = this.sessions.find((x) => x.sid === sid);
    if (s) s.pushedAt = now;
  }
}

// ---- commands ----------------------------------------------------------------------------------------------

export type PadCmd =
  | { op: "open"; talk: boolean }
  | { op: "ping"; vis: boolean }
  | { op: "close" }
  | { op: "sound.play"; url: string }
  | { op: "sound.stop" }
  | { op: "mic"; muted: boolean }
  | { op: "deafen"; on: boolean }
  | { op: "brb"; on: boolean }
  | { op: "vol"; user: string; cat: PadCat; level?: number; muted?: boolean; live: boolean }
  | { op: "vol.reset"; user: string }
  | { op: "leave" }
  | { op: "sound.play.web"; url: string; name: string; emoji: string }
  | { op: "party.join" }
  | { op: "party.play"; url: string; playing: boolean }
  | { op: "party.seek"; url: string; pos: number }
  | { op: "party.next"; url: string }
  | { op: "party.add"; url: string; now: boolean };

/** `url` of a party op: the playing url the controller saw ("" = nothing playing): 0–2048 printable ASCII
 *  characters, the same shape as `call.party.url`. */
function partyUrlOf(c: Obj): string | null {
  const u = own(c, "url");
  return typeof u === "string" && /^[\x21-\x7E]{0,2048}$/.test(u) ? u : null;
}

/** Rule 6 for one command (after its sid/seq/v): `ts`, `room`, `gen` (not on open), a known op and its fields with
 *  their exact types. Unknown fields are ignored. null = `bad`. */
function parseCmd(c: Obj): PadCmd | null {
  if (!isUint(own(c, "ts"))) return null;
  if (!validRoom(own(c, "room"))) return null;
  const op = own(c, "op");
  if (typeof op !== "string") return null;
  if (op !== "open" && !validId(own(c, "gen"))) return null;
  switch (op) {
    case "open": {
      if (!has(c, "want")) return { op, talk: false };
      const w = own(c, "want");
      if (!Array.isArray(w) || !w.every((x) => typeof x === "string")) return null;
      return { op, talk: w.includes("talk") };
    }
    case "ping": {
      const vis = own(c, "vis");
      return typeof vis === "boolean" ? { op, vis } : null;
    }
    case "close":
    case "sound.stop":
    case "leave":
      return { op };
    case "sound.play": {
      const url = own(c, "url");
      return typeof url === "string" && url !== "" && cpLen(url) <= PAD.maxUrl ? { op, url } : null;
    }
    case "mic": {
      const muted = own(c, "muted");
      return typeof muted === "boolean" ? { op, muted } : null;
    }
    case "deafen":
    case "brb": {
      const on = own(c, "on");
      return typeof on === "boolean" ? { op, on } : null;
    }
    case "vol": {
      const user = own(c, "user");
      const cat = own(c, "cat");
      if (!validUser(user)) return null;
      if (typeof cat !== "string" || !(PAD_CATS as readonly string[]).includes(cat)) return null;
      const hasLevel = has(c, "level");
      const hasMuted = has(c, "muted");
      if (!hasLevel && !hasMuted) return null;
      const level = own(c, "level");
      const muted = own(c, "muted");
      const liveIn = own(c, "live");
      if (hasLevel && !isLevel(level)) return null;
      if (hasMuted && typeof muted !== "boolean") return null;
      if (has(c, "live") && typeof liveIn !== "boolean") return null;
      const live = liveIn === true;
      // a live slider push carries only the level (no disk write); mute changes are never "live"
      if (live && (!hasLevel || hasMuted)) return null;
      // key order op, user, cat, level?, muted?, live (the desktop's to_json)
      return { op, user, cat: cat as PadCat, ...(hasLevel ? { level: level as number } : {}), ...(hasMuted ? { muted: muted as boolean } : {}), live };
    }
    case "vol.reset": {
      const user = own(c, "user");
      return validUser(user) ? { op, user } : null;
    }
    case "sound.play.web": {
      const url = own(c, "url");
      const name = has(c, "name") ? own(c, "name") : "";
      const emoji = has(c, "emoji") ? own(c, "emoji") : "";
      if (!webSoundOk(url) || typeof name !== "string" || typeof emoji !== "string") return null;
      if (cpLen(name) > PAD.maxName || cpLen(emoji) > PAD.maxEmoji) return null;
      return { op, url, name, emoji };
    }
    case "party.join":
      return { op };
    case "party.play": {
      const url = partyUrlOf(c);
      const playing = own(c, "playing");
      return url !== null && typeof playing === "boolean" ? { op, url, playing } : null;
    }
    case "party.seek": {
      const url = partyUrlOf(c);
      const pos = own(c, "pos");
      return url !== null && isUint(pos) && pos <= PAD.maxPos ? { op, url, pos } : null;
    }
    case "party.next": {
      const url = partyUrlOf(c);
      return url !== null ? { op, url } : null;
    }
    case "party.add": {
      const url = own(c, "url");
      const now = own(c, "now");
      return partyLinkOk(url) && typeof now === "boolean" ? { op, url, now } : null;
    }
    default:
      return null;
  }
}

/** The receiver's own state the gates read (the same flags its own buttons see). */
export interface PadMe {
  micMuted: boolean;
  ptt: boolean;
  /** a moderator's server mute lock */
  serverMuted: boolean;
  deaf: boolean;
  brb: boolean;
  /** `padGate` / `use_soundboard`: this call's roles let me play sounds */
  soundRole: boolean;
}
export interface PadSounds {
  /** my favourites (account data dev.tinhat.soundboard_personal) */
  favourites: string[];
  /** room id → that room's sounds (dev.tinhat.soundboard state); only the call room's count */
  roomSounds: Record<string, string[]>;
  /** this device's Recent list */
  recent: string[];
}
/** The receiver's Media Party in its CALL room (its own engine's flags; null = no party in that room). */
export interface PadParty {
  /** this device joined the party */
  in: boolean;
  /** its own `canControl` (in the party and no host, or the host is me) */
  host: boolean;
  /** the playing url ("" = nothing playing) */
  url: string;
  playing: boolean;
}
export interface PadCtx {
  /** Settings → Calls → Pad on this receiver */
  padOn: boolean;
  /** the call room's Media Party (absent / null = none; 12.1.x glue never sets it) */
  party?: PadParty | null;
  /** the call this device is in (gen = its call generation), null = not in a call */
  call: { room: string; gen: string } | null;
  /** bare user ids of the people in the call with me (not me) */
  participants: string[];
  me: PadMe;
  sounds: PadSounds;
}

export interface PadVerdict {
  /** run it (when `run`) and reply ok */
  ok: boolean;
  /** the refusal code to reply with ("" with ok:false = a silent drop) */
  why: string;
  /** for the log: "" when ok, the refusal code, or the drop reason */
  reason: string;
  /** answer with one state `re: <seq>` (never for a `vol` with `live: true`, never for a drop) */
  reply: boolean;
  re: number;
  sid: string;
  /** call the receiver's own command for this op (false: nothing to change — every op is a set) */
  run: boolean;
  cmd: PadCmd | null;
  /** sids an `open` replaced (send each a final state `why: "replaced"`) */
  evicted: string[];
}

/** A sound the receiver plays: in its favourites, the CALL room's sounds or its Recent list (exact url). */
export function soundAllowed(url: string, room: string, s: PadSounds): boolean {
  if (!url) return false;
  if (s.favourites.includes(url) || s.recent.includes(url)) return true;
  const list = Object.prototype.hasOwnProperty.call(s.roomSounds, room) ? s.roomSounds[room] : undefined;
  return Array.isArray(list) && list.includes(url);
}

/**
 * The receiver's whole decision about one `dev.tinhat.pad.cmd` (docs/PAD.md "Receiving a command" — the order is
 * normative). Commits to the session table and rate bucket it is handed (opening / renewing / closing a session,
 * accepting a seq); deterministic: the same table + message + facts + now give the same verdict.
 */
export function checkPadMessage(t: PadSessions, type: string, content: unknown, f: PadFacts, ctx: PadCtx, now: number): PadVerdict {
  const drop = (reason: string): PadVerdict => ({ ok: false, why: "", reason, reply: false, re: 0, sid: "", run: false, cmd: null, evicted: [] });
  if (type !== PAD_CMD) return drop("wrong-type");
  const tr = checkTrust(f);
  if (!tr.ok) return drop(tr.reason);
  if (!isObj(content) || !wireOk(content)) return drop("bad-envelope");
  const c = content;
  const sid = own(c, "sid");
  const seq = own(c, "seq");
  if (!validSid(sid) || !isInt(seq) || seq < 1) return drop("bad-envelope");
  // a message that says it is a live slider push is never answered (ok or refused)
  const reply = !(own(c, "op") === "vol" && own(c, "live") === true);
  const refuse = (why: string): PadVerdict => ({ ok: false, why, reason: why, reply, re: seq, sid, run: false, cmd: null, evicted: [] });

  const bucket = t.bucket(f.senderDevice, now);
  if (!bucket) return drop("rate");
  const hit = bucket.hit(now);
  if (hit === "busy") return refuse("busy");
  if (hit === "drop") return drop("rate");
  const v = own(c, "v");
  if (!isInt(v) || v < 1) return refuse("bad");
  if (v > PAD.v) return refuse("version");
  if (ctx.padOn !== true) return refuse("off");
  if (t.refused.has(f.senderDevice)) return refuse("closed");
  const cmd = parseCmd(c);
  if (!cmd) return refuse("bad");
  const ts = own(c, "ts") as number;
  const room = own(c, "room") as string;
  const ok = (run: boolean, evicted: string[] = []): PadVerdict => ({ ok: true, why: "", reason: "", reply, re: seq, sid, run, cmd, evicted });

  if (cmd.op === "open") {
    const cur = t.get(sid, now);
    if (cur && cur.device !== f.senderDevice) return refuse("no-session");
    if (cur && seq <= cur.lastSeq) return drop("old-seq");
    if (cur) {
      cur.lastSeq = seq;
      cur.lastAt = now;
    } else if (t.isSpent(sid, now)) return refuse("no-session"); // a session that ended is never opened again
    if (openStale(ts, now)) return refuse("stale");
    if (!ctx.call) return refuse("not-in-call");
    if (room !== ctx.call.room) return refuse("other-call");
    if (cur) {
      // re-open of a live session: the clock offset can only tighten (a held re-open must not widen it)
      cur.offset = Math.min(cur.offset, now - ts);
      cur.vis = true;
      cur.talk = cmd.talk;
      return ok(false);
    }
    if (!t.roomToOpen(now)) return refuse("busy");
    return ok(false, t.open(sid, f.senderDevice, seq, ts, cmd.talk, now));
  }

  const s = t.get(sid, now);
  if (!s || s.device !== f.senderDevice) return refuse("no-session");
  if (seq <= s.lastSeq) return drop("old-seq");
  s.lastSeq = seq;
  s.lastAt = now;
  if (staleCheck(s.offset, ts, now)) return refuse("stale");
  if (cmd.op === "ping") {
    s.vis = cmd.vis;
    return ok(false);
  }
  if (cmd.op === "close") {
    t.close(sid, now);
    return ok(false);
  }
  if (!ctx.call) return refuse("not-in-call");
  if (room !== ctx.call.room || own(c, "gen") !== ctx.call.gen) return refuse("other-call");
  const me = ctx.me;
  switch (cmd.op) {
    case "sound.play":
      if (!me.soundRole) return refuse("off-role");
      if (me.serverMuted) return refuse("server-muted");
      if (!soundAllowed(cmd.url, ctx.call.room, ctx.sounds)) return refuse("unknown-sound");
      return ok(true);
    case "sound.stop":
      return ok(true);
    case "mic":
      if (cmd.muted) return ok(!me.micMuted); // muting is always allowed
      if (me.serverMuted) return refuse("server-muted");
      if (me.ptt) return refuse("ptt");
      return ok(me.micMuted);
    case "deafen":
      return ok(cmd.on !== me.deaf);
    case "brb":
      return ok(cmd.on !== me.brb);
    case "vol":
    case "vol.reset":
      if (!ctx.participants.includes(cmd.user)) return refuse("not-here");
      return ok(true);
    case "leave":
      return ok(true);
    case "sound.play.web":
      if (!me.soundRole) return refuse("off-role");
      if (me.serverMuted) return refuse("server-muted");
      return ok(true);
    case "party.join": {
      const pt = ctx.party ?? null;
      if (!pt) return refuse("no-party");
      return ok(!pt.in);
    }
    case "party.add": {
      const pt = ctx.party ?? null;
      if (!pt || !pt.in) return refuse("no-party");
      if (cmd.now && !pt.host) return refuse("not-host");
      return ok(true);
    }
    case "party.play":
    case "party.seek":
    case "party.next": {
      const pt = ctx.party ?? null;
      if (!pt || !pt.in) return refuse("no-party");
      if (!pt.host) return refuse("not-host");
      if (cmd.url !== pt.url) return refuse("party-changed");
      if (cmd.op === "party.play") return ok(cmd.playing !== pt.playing);
      return ok(true);
    }
  }
}

// ---- the state --------------------------------------------------------------------------------------------

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** What the receiver puts in a state (from its own stores; buildState applies the caps and drops defaults).
 *  `vol` / `muted` per person = that person's full prefs on this device; `me.sound` = the playing url or "". */
export interface PadStateIn {
  sid: string;
  rseq: number;
  rt: number;
  re: number;
  ok: boolean;
  why: string;
  call: null | {
    room: string;
    gen: string;
    since: number;
    me: { mic: string; deaf: boolean; brb: boolean; talk: boolean; sound: string; gate: { allowed: boolean; hint: string } };
    people: Array<{ u: string; talk: boolean; micOff: boolean; away: boolean; share?: boolean; vol?: Partial<Record<PadCat, number>>; muted?: Partial<Record<PadCat, boolean>> }>;
    recent: Array<{ name: string; url: string; emoji: string }>;
    /** the call room's Media Party (absent / null = none) */
    party?: null | { in: boolean; host: boolean; url: string; title: string; playing: boolean; pos: number; at: number; dur: number; next: Array<{ title: string }>; add?: { sid: string; re: number; ok: boolean } | null };
  };
}

/**
 * The `dev.tinhat.pad.state` content: a full snapshot. Per person only non-default volumes (≠ 1 after rounding to
 * 0.01, clamped to 0–2) and the muted categories; `vol` / `mute` are left out when empty. `people` ≤ 64 (the rest
 * counted in `more`), `recent` ≤ 8, and the whole content ≤ 16 KiB of UTF-8 JSON (if not: recent entries are
 * dropped from the end, then people, counted in `more`). `sid` / `why` / `room` / `gen` that aren't valid ids are sent
 * as "" (the controller then drops the state), so what is left without people and recent is bounded (the worst case,
 * a 2048-character sound url and a 200-character hint of control characters, is under 15 KiB). Returns the content and
 * its size in bytes.
 */
export function buildState(input: PadStateIn): { state: Obj; bytes: number } {
  const inp = (isObj(input) ? input : {}) as Obj;
  const out: Obj = {
    v: PAD.v,
    sid: validSid(own(inp, "sid")) ? own(inp, "sid") : "",
    rseq: isUint(own(inp, "rseq")) ? own(inp, "rseq") : 0,
    rt: isUint(own(inp, "rt")) ? own(inp, "rt") : 0,
    re: isUint(own(inp, "re")) ? own(inp, "re") : 0,
    ok: own(inp, "ok") === true,
    why: validWhy(own(inp, "why")) ? own(inp, "why") : "",
    ops: [...PAD_OPS],
    call: null,
  };
  const ci = own(inp, "call");
  if (isObj(ci)) {
    const mi = isObj(own(ci, "me")) ? (own(ci, "me") as Obj) : {};
    const mic = strOf(own(mi, "mic"));
    const sound0 = strOf(own(mi, "sound"));
    const sound = wellFormed(sound0) ? sound0 : "";
    const gi = isObj(own(mi, "gate")) ? (own(mi, "gate") as Obj) : {};
    const people: Obj[] = [];
    const seen = new Set<string>();
    let valid = 0;
    const pin = own(ci, "people");
    for (const p of Array.isArray(pin) ? pin : []) {
      if (!isObj(p)) continue;
      const u = own(p, "u");
      if (!validUser(u) || seen.has(u)) continue;
      seen.add(u);
      valid++;
      if (people.length >= PAD.maxPeople) continue;
      const e: Obj = { u, talk: own(p, "talk") === true, micOff: own(p, "micOff") === true, away: own(p, "away") === true };
      if (own(p, "share") === true) e.share = true; // additive (2026-10-31): only when sharing, so older states are unchanged
      const vi = isObj(own(p, "vol")) ? (own(p, "vol") as Obj) : {};
      const mu = isObj(own(p, "muted")) ? (own(p, "muted") as Obj) : {};
      const vol: Obj = {};
      const mute: string[] = [];
      for (const cat of PAD_CATS) {
        const x = own(vi, cat);
        if (typeof x === "number" && Number.isFinite(x)) {
          const r = round2(Math.min(2, Math.max(0, x)));
          if (r !== 1) vol[cat] = r;
        }
        if (own(mu, cat) === true) mute.push(cat);
      }
      if (Object.keys(vol).length) e.vol = vol;
      if (mute.length) e.mute = mute;
      people.push(e);
    }
    const recent: Obj[] = [];
    const rin = own(ci, "recent");
    for (const r of Array.isArray(rin) ? rin : []) {
      if (recent.length >= PAD.maxRecent) break;
      if (!isObj(r)) continue;
      const url = strOf(own(r, "url"));
      const name = strOf(own(r, "name"));
      const emoji = strOf(own(r, "emoji"));
      if (!url || cpLen(url) > PAD.maxUrl || !wellFormed(url) || !wellFormed(name) || !wellFormed(emoji)) continue;
      recent.push({ name: cpTrunc(name, PAD.maxName), url, emoji: cpTrunc(emoji, PAD.maxEmoji) });
    }
    const call: Obj = {
      room: validRoom(own(ci, "room")) ? own(ci, "room") : "",
      gen: validId(own(ci, "gen")) ? own(ci, "gen") : "",
      since: isUint(own(ci, "since")) ? own(ci, "since") : 0,
      me: {
        mic: (PAD_MIC as readonly string[]).includes(mic) ? mic : "on",
        deaf: own(mi, "deaf") === true,
        brb: own(mi, "brb") === true,
        talk: own(mi, "talk") === true,
        sound: sound && cpLen(sound) <= PAD.maxUrl ? { url: sound } : null,
        gate: { allowed: own(gi, "allowed") === true, hint: wellFormed(strOf(own(gi, "hint"))) ? cpTrunc(strOf(own(gi, "hint")), PAD.maxHint) : "" },
      },
      people,
      more: valid - people.length,
      recent,
    };
    const party = partyOut(own(ci, "party"));
    if (party) call.party = party;
    out.call = call;
    let bytes = utf8Len(JSON.stringify(out));
    while (bytes > PAD.maxStateBytes && recent.length) {
      recent.pop();
      bytes = utf8Len(JSON.stringify(out));
    }
    const next = party ? (party.next as Obj[]) : [];
    while (bytes > PAD.maxStateBytes && next.length) {
      next.pop();
      bytes = utf8Len(JSON.stringify(out));
    }
    while (bytes > PAD.maxStateBytes && people.length) {
      people.pop();
      call.more = (call.more as number) + 1;
      bytes = utf8Len(JSON.stringify(out));
    }
    // still over (only a pathological sound url / hint can get here): the party block always stays — the playing sound's
    // url goes first, then the hint (with both gone the rest is bounded well under 16 KiB)
    const me = call.me as Obj;
    if (bytes > PAD.maxStateBytes && me.sound !== null) {
      me.sound = null;
      bytes = utf8Len(JSON.stringify(out));
    }
    if (bytes > PAD.maxStateBytes) {
      (me.gate as Obj).hint = "";
      bytes = utf8Len(JSON.stringify(out));
    }
    return { state: out, bytes };
  }
  return { state: out, bytes: utf8Len(JSON.stringify(out)) };
}

/** A wire-clean string cut to `max` code points ("" when it isn't a string or holds a lone surrogate). */
function cleanCut(x: unknown, max: number): string {
  const v = strOf(x);
  return wellFormed(v) ? cpTrunc(v, max) : "";
}
function boundedInt(x: unknown, max: number): number {
  return isUint(x) ? Math.min(x, max) : 0;
}
/** call.party of a state (null = no party): fixed key order in, host, url, title, playing, pos, at, dur, next. A url
 *  over 2048 code points (or with a lone surrogate) is sent as "" (nothing the controller could bind a command to). */
function partyOut(pi: unknown): Obj | null {
  if (!isObj(pi)) return null;
  const url0 = strOf(own(pi, "url"));
  const next: Obj[] = [];
  const nin = own(pi, "next");
  for (const n of Array.isArray(nin) ? nin : []) {
    if (next.length >= PAD.maxNext) break;
    if (!isObj(n)) continue;
    next.push({ title: cleanCut(own(n, "title"), PAD.maxTitle) });
  }
  return {
    in: own(pi, "in") === true,
    host: own(pi, "host") === true,
    url: /^[\x21-\x7E]{0,2048}$/.test(url0) ? url0 : "",
    title: cleanCut(own(pi, "title"), PAD.maxTitle),
    playing: own(pi, "playing") === true,
    pos: boundedInt(own(pi, "pos"), PAD.maxPos),
    at: isUint(own(pi, "at")) ? (own(pi, "at") as number) : 0,
    dur: boundedInt(own(pi, "dur"), PAD.maxPos),
    next,
    ...addOut(own(pi, "add")),
  };
}
/** call.party.add: the outcome of the latest `party.add` of one session (`ok:false` = the link couldn't be added),
 *  left out unless well-formed. */
function addOut(a: unknown): Obj {
  if (!isObj(a) || !validSid(own(a, "sid")) || !isUint(own(a, "re")) || typeof own(a, "ok") !== "boolean") return {};
  return { add: { sid: own(a, "sid"), re: own(a, "re"), ok: own(a, "ok") } };
}
function validParty(pt: unknown): boolean {
  if (pt === null) return true;
  if (!isObj(pt)) return false;
  for (const k of ["in", "host", "playing"]) if (typeof own(pt, k) !== "boolean") return false;
  const url = own(pt, "url");
  const title = own(pt, "title");
  if (typeof url !== "string" || !/^[\x21-\x7E]{0,2048}$/.test(url)) return false;
  if (typeof title !== "string" || cpLen(title) > PAD.maxTitle) return false;
  const pos = own(pt, "pos");
  const dur = own(pt, "dur");
  if (!isUint(pos) || pos > PAD.maxPos || !isUint(dur) || dur > PAD.maxPos || !isUint(own(pt, "at"))) return false;
  const next = own(pt, "next");
  if (!Array.isArray(next) || next.length > PAD.maxNext) return false;
  for (const n of next) {
    if (!isObj(n)) return false;
    const t = own(n, "title");
    if (typeof t !== "string" || cpLen(t) > PAD.maxTitle) return false;
  }
  if (has(pt, "add")) {
    const a = own(pt, "add");
    if (a !== null && (!isObj(a) || !validSid(own(a, "sid")) || !isUint(own(a, "re")) || typeof own(a, "ok") !== "boolean")) return false;
  }
  return true;
}

/** The controller's side of one session: the receiver device it opened, and the newest state it accepted. */
export interface PadCtrlSession {
  sid: string;
  device: string;
  lastRseq: number;
}

function validStateBody(c: Obj): boolean {
  if (!isUint(own(c, "rt")) || !isUint(own(c, "re"))) return false;
  if (typeof own(c, "ok") !== "boolean") return false;
  if (!validWhy(own(c, "why"))) return false;
  const ops = own(c, "ops");
  if (!Array.isArray(ops) || ops.length > 64 || !ops.every((o) => typeof o === "string" && cpLen(o) <= 64)) return false;
  if (!has(c, "call")) return false;
  const call = own(c, "call");
  if (call === null) return true;
  if (!isObj(call)) return false;
  if (!validRoom(own(call, "room")) || !validId(own(call, "gen")) || !isUint(own(call, "since")) || !isUint(own(call, "more"))) return false;
  const me = own(call, "me");
  if (!isObj(me)) return false;
  const mic = own(me, "mic");
  if (typeof mic !== "string" || !(PAD_MIC as readonly string[]).includes(mic)) return false;
  for (const k of ["deaf", "brb", "talk"]) if (typeof own(me, k) !== "boolean") return false;
  const sound = own(me, "sound");
  if (sound !== null) {
    if (!isObj(sound)) return false;
    const url = own(sound, "url");
    if (typeof url !== "string" || url === "" || cpLen(url) > PAD.maxUrl) return false;
  }
  const gate = own(me, "gate");
  if (!isObj(gate) || typeof own(gate, "allowed") !== "boolean") return false;
  const hint = own(gate, "hint");
  if (typeof hint !== "string" || cpLen(hint) > PAD.maxHint) return false;
  const people = own(call, "people");
  if (!Array.isArray(people) || people.length > PAD.maxPeople) return false;
  for (const p of people) {
    if (!isObj(p) || !validUser(own(p, "u"))) return false;
    for (const k of ["talk", "micOff", "away"]) if (typeof own(p, k) !== "boolean") return false;
    if (has(p, "share") && typeof own(p, "share") !== "boolean") return false;
    if (has(p, "vol")) {
      const vol = own(p, "vol");
      if (!isObj(vol)) return false;
      for (const k of Object.keys(vol)) if (!(PAD_CATS as readonly string[]).includes(k) || !isLevel(vol[k])) return false;
    }
    if (has(p, "mute")) {
      const mute = own(p, "mute");
      if (!Array.isArray(mute) || !mute.every((m) => typeof m === "string" && (PAD_CATS as readonly string[]).includes(m))) return false;
    }
  }
  const recent = own(call, "recent");
  if (!Array.isArray(recent) || recent.length > PAD.maxRecent) return false;
  for (const r of recent) {
    if (!isObj(r)) return false;
    const name = own(r, "name");
    const url = own(r, "url");
    const emoji = own(r, "emoji");
    if (typeof name !== "string" || cpLen(name) > PAD.maxName) return false;
    if (typeof url !== "string" || url === "" || cpLen(url) > PAD.maxUrl) return false;
    if (typeof emoji !== "string" || cpLen(emoji) > PAD.maxEmoji) return false;
  }
  if (has(call, "party") && !validParty(own(call, "party"))) return false;
  return true;
}

/**
 * The controller's decision about one `dev.tinhat.pad.state`: trust rules 1–4, from the device this session was
 * opened with, our sid, a newer `rseq` than the last accepted one (highest wins; older or equal ones are ignored)
 * and a well-formed body (unknown fields ignored). Accepting updates `s.lastRseq`. Every refusal is silent.
 */
export function acceptState(s: PadCtrlSession, type: string, content: unknown, f: PadFacts): { ok: boolean; reason: string; state: Obj | null } {
  const no = (reason: string) => ({ ok: false, reason, state: null });
  if (type !== PAD_STATE) return no("wrong-type");
  const tr = checkTrust(f);
  if (!tr.ok) return no(tr.reason);
  if (f.senderDevice !== s.device) return no("other-device");
  if (!isObj(content) || !wireOk(content)) return no("bad");
  const v = own(content, "v");
  if (!isInt(v) || v < 1) return no("bad");
  if (v > PAD.v) return no("version");
  if (own(content, "sid") !== s.sid) return no("other-session");
  const rseq = own(content, "rseq");
  if (!isInt(rseq) || rseq < 1) return no("bad");
  if (rseq <= s.lastRseq) return no("old-rseq");
  if (!validStateBody(content)) return no("bad");
  s.lastRseq = rseq;
  return { ok: true, reason: "", state: content };
}

// ---- discovery ---------------------------------------------------------------------------------------------

/** One of my other devices in the call. `why`: "" (ready), "unverified" (THIS device isn't verified),
 *  "untrusted" (that device isn't cross-signing trusted) or "version" (its membership has no `pad1` cap: an
 *  older Tin Hat, another client, or Pad turned off there). */
export interface PadTarget {
  device: string;
  createdTs: number;
  ready: boolean;
  why: string;
}

function finiteNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function entryLive(c: Obj, originTs: number, now: number): boolean {
  if (Object.keys(c).length === 0) return false;
  const created = finiteNum(own(c, "created_ts")) ?? (originTs > 0 ? originTs : null);
  if (created === null) return true;
  const expires = finiteNum(own(c, "expires")) ?? PAD.membershipExpiresMs;
  return now <= created + expires;
}

/**
 * Pad targets in one call room, newest membership (`created_ts`) first (ties: device id): every live, well-formed
 * MatrixRTC session (the same liveness / schema / state-key ownership as `liveSessions`) whose sender is me and whose
 * device isn't this one. `events` = the room's raw `org.matrix.msc3401.call.member` state events
 * (`{sender, state_key, origin_server_ts, content}`, session form or the legacy `memberships[]` form); `trusted` =
 * my device ids that are cross-signing trusted. The default target is the first ready one.
 */
export function padTargets(me: string, myDevice: string, now: number, selfVerified: boolean, trusted: readonly string[], events: readonly unknown[]): PadTarget[] {
  const out: PadTarget[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (!isObj(ev)) continue;
    const sender = strOf(own(ev, "sender"));
    const c = own(ev, "content");
    if (!sender || sender !== me || !isObj(c) || Object.keys(c).length === 0) continue;
    const o = own(ev, "origin_server_ts");
    const origin = isUint(o) ? o : 0;
    const arr = own(c, "memberships");
    const arrayForm = Array.isArray(arr);
    const entries: Obj[] = arrayForm ? (arr as unknown[]).filter((m): m is Obj => isObj(m) && entryLive(m, origin, now)) : entryLive(c, origin, now) ? [c] : [];
    const stateKey = strOf(own(ev, "state_key"));
    for (const e of entries) {
      if (has(e, "application") && own(e, "application") !== "m.call") continue;
      if (has(e, "scope") && own(e, "scope") !== "m.room") continue;
      const dev = strOf(own(e, "device_id"));
      if (!dev || !stateKeyOwned(stateKey, sender, dev, arrayForm)) continue;
      const wf = own(e, "application") === "m.call" && own(e, "scope") === "m.room" && own(e, "call_id") === "" && (finiteNum(own(e, "expires")) ?? 0) > 0;
      // only a well-formed entry claims its device (a malformed one can't hide a good one)
      if (!wf || seen.has(dev)) continue;
      seen.add(dev);
      if (dev === myDevice) continue;
      const mk = isObj(own(e, "dev.tinhat.client")) ? own(e, "dev.tinhat.client") : own(c, "dev.tinhat.client");
      const caps = isObj(mk) ? own(mk, "caps") : undefined;
      const capped = Array.isArray(caps) && caps.some((x) => x === PAD_CAP);
      const why = !selfVerified ? "unverified" : !trusted.includes(dev) ? "untrusted" : !capped ? "version" : "";
      out.push({ device: dev, createdTs: finiteNum(own(e, "created_ts")) ?? origin, ready: why === "", why });
    }
  }
  return out.sort((a, b) => (a.createdTs !== b.createdTs ? b.createdTs - a.createdTs : cmpCodePoints(a.device, b.device)));
}

/** Code-point order (= Rust's byte order of UTF-8), not JavaScript's UTF-16 code-unit order. */
function cmpCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const d = (p.value.codePointAt(0) as number) - (q.value.codePointAt(0) as number);
    if (d !== 0) return d;
  }
}

// ---- the words ---------------------------------------------------------------------------------------------

const WHY_TEXT: Record<string, string> = {
  off: "Pad is turned off on {device} (Settings → Calls).",
  "not-in-call": "{device} isn't in a call any more.",
  "other-call": "{device} switched calls.",
  "unknown-sound": "{device} doesn't have that sound yet — try again.",
  "off-role": "The soundboard is off for your role in this call.",
  "server-muted": "A moderator muted you for everyone — sounds are off until you're unmuted",
  ptt: "Push to talk is on at {device} — use the key there.",
  stale: "That took too long to reach {device} — try again.",
  busy: "Slow down a little.",
  version: "Update Tin Hat on {device} to use Pad.",
  ended: "{device} left the call.",
  replaced: "Another of your devices took over Pad on {device}.",
  closed: "Pad was closed on {device} for this call.",
  unverified: "Verify this device to use Pad.",
  untrusted: "Verify {device} to use Pad.",
  unreachable: "Not reaching {device}",
  "no-party": "There's no Media Party in this call's room on {device}.",
  "not-host": "Only the Media Party host can do that.",
  "party-changed": "What's playing on {device} changed — try again.",
  "bad-link": "{device} couldn't add that link.",
  "old-op": "Update Tin Hat on {device} to use that.",
};
/** For `mic`, `server-muted` is the call's existing lock notice. */
const MIC_SERVER_MUTED = "A moderator muted your mic for everyone — ask them to unmute you";

/** The one text per code (both apps). `device` = the receiver's name (Settings → Devices & security); `op` = the
 *  refused command's op. `bad` / `not-here` / `no-session` and unknown codes have no text (""). */
export function whyText(code: string, device: string, op = ""): string {
  if (code === "server-muted" && op === "mic") return MIC_SERVER_MUTED;
  const t = Object.prototype.hasOwnProperty.call(WHY_TEXT, code) ? WHY_TEXT[code] : "";
  return t.split("{device}").join(device);
}

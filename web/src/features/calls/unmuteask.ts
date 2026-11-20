// unmuteask.ts — "Ask to be unmuted" (12.1.17, D04.6): the pure rules, no LiveKit / React / Matrix imports.
// Desktop crates/app/src/unmuteask.rs has the same rules; the shared vectors (unmuteask.vectors.json = desktop
// crates/app/src/testvectors/unmuteask.json) are byte-identical. The vectors' _about is the spec.
//
// Wire: a reliable LiveKit data packet on its OWN topic (12.1.15 and older have no branch for it and drop it), payload
// exactly askPayload(), sent by a server-muted person to everyone. The asker is the packet's SFU sender identity.
// A receiver never unmutes anyone because of an ask: it only shows a hand + a toast whose "Unmute" is the
// moderator's own click through the normal moderation path (the server checks rank again).

export const UNMUTE_ASK_TOPIC = "tinhat.unmute_ask";
export const ASK_COOLDOWN_MS = 30000;
export const TOAST_GAP_MS = 30000;
export const HAND_MS = 60000;
export const UNDO_MS = 5000;
export const MAX_PAYLOAD_BYTES = 256;
/** 12.1.17 Stage B (#3): how long an ask that beat the mute's announcement is held (the vectors' _aboutHold). */
export const ASK_HOLD_MS = 10000;

export const WORDS = {
  askButton: "Ask to be unmuted",
  askSent: "Asked to be unmuted",
  askToast: "{name} asks to be unmuted",
  askToastAction: "Unmute",
  handTip: "{name} asks to be unmuted",
  muteToast: "Muted {name} for everyone",
  muteToastAction: "Undo",
  toastStaleCall: "That call is over",
  toastStaleRev: "{name} was muted again in the meantime, so nothing changed",
  toastStaleUnmuted: "{name} isn't muted any more",
} as const;

/** `{name}` → the name (the one placeholder the wording uses). */
export function words(key: keyof typeof WORDS, name = ""): string {
  return WORDS[key].replace("{name}", name);
}

/** The payload, byte for byte. */
export function askPayload(): string {
  return JSON.stringify({ v: 1 });
}

/** The object rule: `v` is a finite whole number >= 1 (other keys ignored). */
export function isAskObject(o: unknown): boolean {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const v = (o as Record<string, unknown>).v;
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1;
}

/** Is this packet text an ask? (one leading byte-order mark dropped, at most MAX_PAYLOAD_BYTES of UTF-8, the object rule) */
export function parseAsk(text: string): boolean {
  if (typeof text !== "string") return false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) return false;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return false;
  }
  return isAskObject(o);
}

/** ms until the asker may ask again (0 = now). A clock that went backwards never locks the button. */
export function cooldownLeft(lastAskMs: number | null, nowMs: number): number {
  if (lastAskMs === null) return 0;
  const d = nowMs - lastAskMs;
  if (d < 0 || d >= ASK_COOLDOWN_MS) return 0;
  return ASK_COOLDOWN_MS - d;
}

export interface VerdictIn {
  /** the asker is my own account (another device of mine) */
  senderIsMe: boolean;
  /** the asker is server-muted right now (as far as I know) */
  senderServerMuted: boolean;
  /** I hold moderate_calls here */
  iModerate: boolean;
  /** ranks in the call room; null = unknown (fail closed) */
  myRank: number | null;
  senderRank: number | null;
  /** when I last toasted this asker's ask (null = never) */
  lastToastMs: number | null;
  nowMs: number;
}
export type Verdict = "toast" | "hand" | "ignore:self" | "ignore:not-moderator" | "ignore:unknown-rank" | "ignore:rank" | "ignore:not-muted";

/** What a receiver does with an ask (the vectors' order). Never "unmute". */
export function askVerdict(i: VerdictIn): Verdict {
  if (i.senderIsMe) return "ignore:self";
  if (!i.iModerate) return "ignore:not-moderator";
  if (i.myRank === null || i.senderRank === null || !Number.isFinite(i.myRank) || !Number.isFinite(i.senderRank)) return "ignore:unknown-rank";
  if (!(i.myRank > i.senderRank)) return "ignore:rank";
  if (!i.senderServerMuted) return "ignore:not-muted";
  if (i.lastToastMs !== null) {
    const d = i.nowMs - i.lastToastMs;
    if (d >= 0 && d < TOAST_GAP_MS) return "hand";
  }
  return "toast";
}

/** Is the hand still up? (while they're muted, for HAND_MS) */
export function handShown(askedAtMs: number, nowMs: number, stillMuted: boolean): boolean {
  return stillMuted && nowMs - askedAtMs < HAND_MS;
}

/** The asker's button text for the time left on the cooldown. */
export function askLabel(leftMs: number): string {
  if (leftMs <= 0) return WORDS.askButton;
  return `Asked — ask again in ${Math.ceil(leftMs / 1000)} s`;
}

// ---- 12.1.17 Stage B: a toast acts only on the mute it was made for (the vectors' _aboutToast) ------------------

/** One identity's server mute as this app knows it: who muted them, and its revision (never handed out twice). */
export interface MuteEpisode {
  by: string;
  rev: number;
}

/** The record after a mute / unmute of one identity: an unmute ends it (null); a mute keeps the record when the same
 *  moderator's mute is already on it (a repeat / re-announce), else starts a NEW revision (`fresh`, never used before). */
export function nextMuteEpisode(prev: MuteEpisode | null, action: string, by: string, fresh: number): MuteEpisode | null {
  if (action !== "mute") return null;
  if (prev && prev.by === by) return prev;
  return { by, rev: fresh };
}

export type ToastVerdict = "act" | "stale:call" | "stale:rev" | "stale:not-muted";

/** May an Undo / ask toast's button act? `revs`: every identity the toast kept (`at` = its kept revision) plus every
 *  identity the press would act on now that it didn't keep (`at` = null); `now` = its revision now (null = not muted).
 *  Only "act" unmutes. */
export function toastMayAct(sameCall: boolean, revs: ReadonlyArray<{ at: number | null; now: number | null }>): ToastVerdict {
  if (!sameCall) return "stale:call";
  if (revs.some((r) => r.now !== null && r.now !== r.at)) return "stale:rev";
  if (!revs.some((r) => r.at !== null && r.now === r.at)) return "stale:not-muted";
  return "act";
}

/** What a stale press says (the toast closes; nothing else happens). */
export function staleText(v: Exclude<ToastVerdict, "act">, name: string): string {
  return v === "stale:call" ? WORDS.toastStaleCall : words(v === "stale:rev" ? "toastStaleRev" : "toastStaleUnmuted", name);
}

/** 12.1.17 Stage B (#3): is a held ask still live? (0 <= now - heldAt < ASK_HOLD_MS; a clock that went backwards drops it) */
export function heldAskLive(heldAtMs: number, nowMs: number): boolean {
  const d = nowMs - heldAtMs;
  return d >= 0 && d < ASK_HOLD_MS;
}

/** Stage B (#3): hold `id`'s ask at `nowMs` (drops every entry no longer live first; refuses a NEW asker when `max` are
 *  held; an asker already held gets the new time). true = held. */
export function holdPut(held: Map<string, number>, id: string, nowMs: number, max: number): boolean {
  for (const [k, at] of held) if (!heldAskLive(at, nowMs)) held.delete(k);
  if (!held.has(id) && held.size >= max) return false;
  held.set(id, nowMs);
  return true;
}

/** Stage B (#3): `id`'s mute record arrived: take its held ask (removed either way). true = still live: decide it now. */
export function holdTake(held: Map<string, number>, id: string, nowMs: number): boolean {
  const at = held.get(id);
  if (at === undefined) return false;
  held.delete(id);
  return heldAskLive(at, nowMs);
}

/** Round 2: offer the Undo for one identity my late mute answer records? prevRev = the record it replaces (null =
 *  none), since = the highest revision when my request went out. A newer mute (prevRev > since) gets no Undo. */
export function undoOffered(prevRev: number | null, since: number): boolean {
  return prevRev === null || prevRev <= since;
}

/** A call tile as far as scopes go: its participant and the devices folded into it (a person tile). */
export interface ScopeTile {
  participant: string;
  members?: string[];
}

/** The person tile `id` belongs to (the first tile naming it, if that tile has more than one device), else null. */
export function personTileIn(tiles: ReadonlyArray<ScopeTile>, id: string): ScopeTile | null {
  const t = tiles.find((x) => x.participant === id || (x.members ?? []).includes(id));
  return t && (t.members?.length ?? 0) > 1 ? t : null;
}

const tileIdsOf = (t: ScopeTile) => [...new Set([t.participant, ...(t.members ?? [])])];

/** Who an Undo's unmute of `target` reaches (run(): a person tile's participant = every device; runPerson = the
 *  target's person). */
export function undoScopeIn(tiles: ReadonlyArray<ScopeTile>, target: string, person: boolean): string[] {
  const t = tiles.find((x) => x.participant === target && (x.members?.length ?? 0) > 1) ?? (person ? personTileIn(tiles, target) : null);
  return t ? tileIdsOf(t) : [target];
}

/** Who an ask's Unmute reaches (the asker's whole person). */
export function askScopeIn(tiles: ReadonlyArray<ScopeTile>, from: string): string[] {
  const t = personTileIn(tiles, from);
  return t ? tileIdsOf(t) : [from];
}

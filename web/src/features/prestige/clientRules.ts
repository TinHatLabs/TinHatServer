// clientRules.ts — the mini games' pure client rules (GAMES-V1-SPEC rev 2: §1.1, §3.1, §3.3, §6.5), replayed against
// testvectors/client-rules.json. The desktop's crates/app/src/play_rules.rs replays a byte copy of the same file.
//
//   prestigeTier(rank)       rank → the token's look (rank 0 / anything that isn't a JSON integer ≥ 1: no token)
//   gameVisible(game, ctx)   is a game offered here (the space owner's features.play + the phone-app switch)
//   gameSpace(ctx)           which space's chips a room uses (both links, canonical first, unknown blocks; the owner =
//                            the server of the space's create-event sender, never a via)
//   rankContext(surface)     which space's rank a token shows: a room = its game space, a space's own surfaces = that
//                            space, anything else = none
//   whisperAlone(ctx)        The Rig: warn before a Whisper when the whisperer is the only connected House member
//
// No React, no I/O: the games UI (gameVisible, gameSpace) and the token (prestigeTier, rankContext) import from here.

export type PrestigeGlyph = "none" | "outline" | "filled";
export type PrestigeColour = "none" | "muted" | "text" | "accent";

export interface PrestigeLook {
  /** 0 = no token; 1 outline; 2 filled; 3 accent; 4 + ring; 5 + star; 6 + the one-time shine */
  tier: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  glyph: PrestigeGlyph;
  colour: PrestigeColour;
  ring: boolean;
  star: boolean;
  shine: boolean;
}

export const NO_PRESTIGE: PrestigeLook = Object.freeze({ tier: 0, glyph: "none", colour: "none", ring: false, star: false, shine: false });

/** The tier ladder (§3.1). Each row starts at its rank; the last row whose start ≤ rank wins. */
const LADDER: ReadonlyArray<readonly [number, PrestigeLook]> = [
  [1, { tier: 1, glyph: "outline", colour: "muted", ring: false, star: false, shine: false }],
  [2, { tier: 2, glyph: "filled", colour: "text", ring: false, star: false, shine: false }],
  [3, { tier: 3, glyph: "filled", colour: "accent", ring: false, star: false, shine: false }],
  [5, { tier: 4, glyph: "filled", colour: "accent", ring: true, star: false, shine: false }],
  [8, { tier: 5, glyph: "filled", colour: "accent", ring: true, star: true, shine: false }],
  [13, { tier: 6, glyph: "filled", colour: "accent", ring: true, star: true, shine: true }],
];

/** A rank as it travels (JSON): only an integer ≥ 1 is a rank; 2.5, "3", true, null, negatives are none. */
export function validRank(rank: unknown): number {
  return typeof rank === "number" && Number.isSafeInteger(rank) && rank >= 1 ? rank : 0;
}

export function prestigeTier(rank: unknown): PrestigeLook {
  const r = validRank(rank);
  let look = NO_PRESTIGE;
  for (const [from, l] of LADDER) if (r >= from) look = l;
  return look;
}

/** What the token says to a screen reader and in its tooltip ("Prestige 4"); "" for no token. */
export function prestigeLabel(rank: unknown): string {
  const r = validRank(rank);
  return r > 0 ? `Prestige ${r}` : "";
}

export interface GameVisibleCtx {
  /** the room's server's well-known `features.play` (must be exactly true) */
  play?: unknown;
  /** inside the iPhone / Android shell app (window.tinhatNative.info.platform is ios or android) */
  phone_app?: unknown;
  /** the room's server's well-known `features.play_rig_phone_apps` (must be exactly true) */
  rig_phone_apps?: unknown;
}

export const GAMES = ["holdem", "rig"] as const;
export type GameId = (typeof GAMES)[number];

export function gameVisible(game: string, ctx: GameVisibleCtx): boolean {
  if (ctx.play !== true) return false;
  if (game === "holdem") return true;
  if (game === "rig") return ctx.phone_app !== true || ctx.rig_phone_apps === true;
  return false;
}

/** The server part of a Matrix user id: everything after the first ':' (a port is kept); null when malformed. */
export function serverOfUserId(mxid: unknown): string | null {
  if (typeof mxid !== "string" || mxid.length > 255 || mxid[0] !== "@") return null;
  const i = mxid.indexOf(":");
  if (i < 2) return null;
  const server = mxid.slice(i + 1);
  return server.length > 0 && !/\s/.test(server) ? server : null;
}

// ---- game_space (§1.1) -----------------------------------------------------------------------------------------------

export interface SpaceLink {
  /** the space id (the m.space.parent state key) */
  space: string;
  content: unknown;
}

export interface ChildLink {
  /** the room id (the m.space.child state key) */
  room: string;
  content: unknown;
}

export interface HeldSpace {
  create_sender?: unknown;
  create_type?: unknown;
  /** the state is still incomplete (a fresh federated join): unknown, not invalid */
  partial?: unknown;
  children?: ChildLink[];
}

export interface GameSpaceCtx {
  /** "app": any owner is fine; "server": an owner other than `decider` → wrong-server */
  mode: "app" | "server";
  decider?: string;
  room: { id: string; create_type?: unknown; parents?: SpaceLink[] };
  /** only the spaces whose CURRENT, full state the caller holds */
  spaces: Record<string, HeldSpace>;
}

export type GameSpaceWhy = "" | "is-space" | "no-space" | "unavailable" | "wrong-server";

export interface GameSpace {
  space: string | null;
  server: string | null;
  why: GameSpaceWhy;
}

const NONE = (why: GameSpaceWhy): GameSpace => ({ space: null, server: null, why });

/** A link's `via`: a list of 1–20 strings of 1–255 characters (an empty list = a removed link). Characters = code points. */
export function viaOk(content: unknown): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  const v = (content as { via?: unknown }).via;
  // lengths in characters (code points), as the reference and the desktop count them — not UTF-16 units
  return Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((x) => typeof x === "string" && x.length >= 1 && [...x].length <= 255);
}

/** Code-point order (not UTF-16 unit order): what the server and the desktop compare by. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

const canonical = (l: SpaceLink): boolean => (l.content as { canonical?: unknown }).canonical === true;

export function gameSpace(ctx: GameSpaceCtx): GameSpace {
  const room = ctx.room;
  if (room.create_type === "m.space") return NONE("is-space");
  const cands = (room.parents ?? []).filter((p) => typeof p.space === "string" && p.space.startsWith("!") && viaOk(p.content));
  cands.sort((a, b) => (canonical(a) === canonical(b) ? compareCodePoints(a.space, b.space) : canonical(a) ? -1 : 1));
  for (const p of cands) {
    const sp = Object.prototype.hasOwnProperty.call(ctx.spaces, p.space) ? ctx.spaces[p.space] : undefined;
    if (!sp || sp.partial) return NONE("unavailable"); // unknown blocks: never fall through it
    if (sp.create_type !== "m.space") continue; // an ordinary room's m.space.child means nothing
    if ((sp.children ?? []).some((c) => c.room === room.id && viaOk(c.content))) {
      const server = serverOfUserId(sp.create_sender);
      if (server === null) return NONE("unavailable");
      if (ctx.mode === "server" && server !== ctx.decider) return { space: p.space, server, why: "wrong-server" };
      return { space: p.space, server, why: "" };
    }
    // a known space that doesn't list the room back: skip
  }
  return NONE("no-space");
}

// ---- rank_context (§3.3) ---------------------------------------------------------------------------------------------

export type RankSurface = { kind: "room"; room: string; game_space: string | null } | { kind: "space"; space: string } | { kind: "global" };

/** Which space's rank a token on this surface shows; null = no token. */
export function rankContext(surface: RankSurface): string | null {
  if (surface.kind === "space") return surface.space;
  if (surface.kind === "room") return surface.game_space;
  return null;
}

// ---- whisper_alone (launch-gate 11-19: never promise anonymity when it isn't true) ----------------------------------

/** The House roles (the Spinner is not House). */
export const HOUSE_ROLES: readonly string[] = ["mechanic", "sharp", "railbird"];

export interface WhisperRosterEntry {
  u: string;
  role: string;
  /** connected to the table now (only a JSON true counts) */
  connected?: unknown;
  /** left the round (doesn't count, even if still connected) */
  left?: unknown;
}

/** Warn when no OTHER House member is connected (and still in the round): the Spinner would know who wrote it. The words
 *  (both apps): "You're the only House member here, so the Spinner will know this is from you." */
export function whisperAlone(ctx: { roster: readonly WhisperRosterEntry[]; whisperer: string }): { warn: boolean } {
  const others = (ctx.roster ?? []).filter((m) => m && m.u !== ctx.whisperer && HOUSE_ROLES.includes(m.role) && m.connected === true && m.left !== true);
  return { warn: others.length === 0 };
}

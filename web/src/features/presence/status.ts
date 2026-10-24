// status.ts — REACH §2.6 + A4 (custom status): colours, presets, the palette and the pure
// `statusView(state, status, nowMs) → {dot, label}` both apps share (same test names as the desktop:
// sv_online_preset, sv_call_preset, sv_away_preset, sv_none_online, sv_expired, sv_bad_color, sv_no_emoji).
// No imports: status.test.ts runs it under plain Node type stripping.

export type PresenceState = "online" | "away" | "call";

/** §2.6 — the dots are the ACTIVE theme's presence tokens, as CSS colours (the desktop's presence_model.rs reads the
 *  same tokens since desktop C1): every built-in paints #3BA55C online and in a call, #FAA81A away (REACH §2.6);
 *  a palette theme its presence.online / .away / .incall roles. */
export const PRESENCE_ONLINE = "var(--th-presence-online-dot)";
export const PRESENCE_AWAY = "var(--th-presence-away-dot)";
export const PRESENCE_INCALL = "var(--th-presence-incall-dot)";

/** A4.3 — the only colours a status can have (fixed hex, every theme). Order = the picker's swatches. */
export const STATUS_PALETTE: ReadonlyArray<readonly [key: string, hex: string]> = [
  ["blurple", "#5865F2"],
  ["teal", "#1ABC9C"],
  ["purple", "#9B59B6"],
  ["orange", "#E67E22"],
  ["red", "#ED4245"],
  ["blue", "#3498DB"],
  ["grey", "#95A5A6"],
  ["pink", "#FF4FA3"],
  ["yellow", "#F1C40F"],
  ["lime", "#A3E635"],
  ["cyan", "#22D3EE"],
  ["white", "#F2F3F5"],
];
const PALETTE = new Map(STATUS_PALETTE);

export interface StatusPreset {
  id: string;
  emoji: string;
  text: string;
  color: string;
}

/** A4.2 — the same order everywhere. */
export const STATUS_PRESETS: readonly StatusPreset[] = [
  { id: "lfg", emoji: "🎯", text: "Looking for group", color: "blurple" },
  { id: "down", emoji: "🎮", text: "Down to play", color: "teal" },
  { id: "queue", emoji: "⏳", text: "In queue", color: "purple" },
  { id: "grind", emoji: "⚔️", text: "Grinding", color: "orange" },
  { id: "ranked", emoji: "🔥", text: "Sweating ranked", color: "red" },
  { id: "chill", emoji: "🛋️", text: "Just chilling", color: "blue" },
  { id: "brb", emoji: "🍕", text: "BRB", color: "grey" },
  { id: "tilted", emoji: "😤", text: "Tilted", color: "pink" },
];

export const STATUS_TEXT_MAX = 40;

/** A custom status (account data `dev.tinhat.presence_status`, or the `status` of a GET /api/presence row). */
export interface CustomStatus {
  id?: string;
  text: string;
  emoji?: string;
  /** palette key */
  color: string;
  /** epoch ms, null = don't clear (the server strips it from GET rows) */
  until?: number | null;
}

/** A palette key → hex; an unknown key renders grey (A4.3). */
export function statusColor(key: string | undefined | null): string {
  return PALETTE.get(key ?? "") ?? PALETTE.get("grey")!;
}

export const codePoints = (s: string) => Array.from(s).length;

/** The status if it can be shown at `nowMs` (text 1–40 after trim, not expired), else null. */
export function liveStatus(s: unknown, nowMs: number): CustomStatus | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text || codePoints(text) > STATUS_TEXT_MAX) return null;
  const until = typeof o.until === "number" ? o.until : null;
  if (until !== null && until <= nowMs) return null;
  return {
    id: typeof o.id === "string" ? o.id : undefined,
    text,
    emoji: typeof o.emoji === "string" ? o.emoji.trim() : "",
    color: typeof o.color === "string" ? o.color : "grey",
    until,
  };
}

export function stateWord(state: PresenceState): "Online" | "Away" | "In a call" {
  return state === "away" ? "Away" : state === "call" ? "In a call" : "Online";
}

/** "<emoji> <text>", or "<text>" without an emoji. */
export function statusText(s: Pick<CustomStatus, "text" | "emoji">): string {
  return s.emoji ? `${s.emoji} ${s.text}` : s.text;
}

export interface StatusView {
  /** the dot's colour: a status colour (hex) or a presence token (CSS var) */
  dot: string;
  label: string;
  /** the status part of the label (chip text) + its colour, when a live status shows */
  chip: { text: string; color: string } | null;
}

/** A4.5 — what a person's dot and label read. Away wins the dot; a call keeps the status colour. */
export function statusView(state: PresenceState, status: unknown, nowMs: number): StatusView {
  const s = liveStatus(status, nowMs);
  if (!s) return { dot: state === "away" ? PRESENCE_AWAY : state === "call" ? PRESENCE_INCALL : PRESENCE_ONLINE, label: stateWord(state), chip: null };
  const color = statusColor(s.color);
  const text = statusText(s);
  const chip = { text, color };
  if (state === "away") return { dot: PRESENCE_AWAY, label: `${text} · Away`, chip };
  if (state === "call") return { dot: color, label: `${text} · In a call`, chip };
  return { dot: color, label: text, chip };
}

/** A4.1: the `dev.tinhat.presence_status` content for a status, or `{}` (Clear status / an expired one's
 *  clean-up) — the desktop's `status_content`. */
export function statusContent(s: CustomStatus | null): Record<string, unknown> {
  if (!s) return {};
  return { id: s.id ?? "custom", text: s.text.trim(), emoji: s.emoji ?? "", color: s.color, until: s.until ?? null, v: 1 };
}

/** "Tonight" = the next 04:00 local (the Game Reel's night rollover). */
export function tonightUntil(nowMs: number): number {
  const d = new Date(nowMs);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0);
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
  return at.getTime();
}

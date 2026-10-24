// hear.ts — "Can they hear me?" (10.5) texts: the heard-by summary (AppCore.qml:596-612), per-peer
// reasons (AppCore.qml:578-593) and the pill set (Main.qml:5407-5514). The engine measures; this
// file only turns its `hear` snapshot into words.
import type { CallStore, HearSnapshot, Tile } from "@/features/calls/contract";
import { joinNames, localpartOf, tileMxid } from "./store";

export function snap(h: CallStore["hear"]): HearSnapshot | null {
  return h && (h as HearSnapshot).v === 1 ? (h as HearSnapshot) : null;
}

export function hearName(identity: string, tiles: Tile[]): string {
  const mx = tileMxid(identity);
  const t = tiles.find((x) => x.participant === identity) ?? tiles.find((x) => tileMxid(x.participant) === mx);
  return t?.name || localpartOf(mx) || identity;
}

export function hearNames(ids: string[], tiles: Tile[]): string {
  return joinNames(ids.map((i) => (i.startsWith("@") ? hearName(i, tiles) : i)));
}

/** "Heard by 2 of 3 · X isn't receiving you · …" */
export function heardSummary(c: CallStore): string {
  const h = snap(c.hear);
  if (!c.inCall || !h || !h.heard || h.heard.total === 0) return "";
  if (c.micMuted) return "You're muted — nobody hears your mic";
  const hd = h.heard;
  const parts: string[] = [];
  const reporting = hd.total - hd.unconf.length - hd.pending.length;
  if (reporting > 0) parts.push(`Heard by ${hd.ok} of ${reporting}`);
  if (hd.not.length) parts.push(`${hearNames(hd.not, c.tiles)} ${hd.not.length === 1 ? "isn't" : "aren't"} receiving you`);
  if (hd.deaf.length) parts.push(`${hearNames(hd.deaf, c.tiles)} ${hd.deaf.length === 1 ? "has" : "have"} deafened or stepped away`);
  if (hd.unconf.length) parts.push(`${hearNames(hd.unconf, c.tiles)}'s ${hd.unconf.length === 1 ? "app doesn't" : "apps don't"} report what it hears`);
  return parts.join(" · ");
}

export const REASON_ABOUT_ME: Record<string, string> = {
  silent: "your audio reaches them silent",
  noaudio: "no audio from you is arriving there",
  nokey: "they can't decrypt you — the key is missing",
  stalled: "their speakers stalled — their app is repairing it",
  nosub: "their app isn't subscribed to your mic",
  muted: "they still see you as muted",
  other: "their app reports a problem",
};
export const REASON_ABOUT_THEM: Record<string, string> = {
  silent: "they're talking, but their audio arrives silent",
  noaudio: "no audio from them is arriving",
  nokey: "their encryption key is missing",
  stalled: "your output for them stalled — repairing",
};

export interface PillModel {
  id: string;
  tone: "info" | "warn" | "danger";
  icon?: string;
  text: string;
  shortText?: string;
  action?: string;
  shortAction?: string;
  tip?: string;
  run?: () => void;
}

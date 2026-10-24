// memories/model.ts — Memories sessions (GET /api/vods/sessions?room=…, bearer) + the derived
// helpers MemoriesWindow.qml computes (tracks, offsets, POV groups, posters, rail order, slots).
import { apiJson } from "@/core/api";
import { sameOrigin } from "../shared/clip";
import { shortName, userIdOf } from "../shared/format";

export interface VodTrack {
  file: string;
  identity: string;
  kind: "cam" | "share" | "audio" | string;
  start_ms: number;
  end_ms?: number | null;
  url: string;
  combined_url?: string;
}
export interface VodSession {
  id: string;
  room: string;
  room_name?: string;
  started_by?: string;
  start_ms: number;
  end_ms?: number | null;
  tracks: VodTrack[];
  mixed_url?: string;
  live?: boolean;
  ready?: boolean;
  bytes?: number;
  people?: string[];
  empty?: boolean;
}

export async function fetchSessions(roomId: string): Promise<VodSession[]> {
  const r = await apiJson<{ sessions?: VodSession[] }>(`/vods/sessions?room=${encodeURIComponent(roomId)}`, { timeoutMs: 15000 });
  const list = Array.isArray(r?.sessions) ? r.sessions : [];
  return list.map((s) => ({ ...s, id: String(s.id), tracks: Array.isArray(s.tracks) ? s.tracks : [] }));
}

export const isVideo = (t: VodTrack) => t.kind === "share" || t.kind === "cam";

/** Video tracks: shares first, then by file (deterministic). */
export function videoTracksOf(s: VodSession | null): VodTrack[] {
  if (!s) return [];
  return s.tracks.filter(isVideo).sort((a, b) => {
    const k = (a.kind === "share" ? 0 : 1) - (b.kind === "share" ? 0 : 1);
    if (k) return k;
    return a.file < b.file ? -1 : 1;
  });
}

/** The earliest-starting video (a share wins ties within 500 ms). */
export function earliestVideo(tracks: VodTrack[]): VodTrack | null {
  let best: VodTrack | null = null;
  // iterate in videoTracks order (shares first, then by file) like the native — it decides ties
  for (const t of videoTracksOf({ tracks } as VodSession)) {
    if (!isVideo(t)) continue;
    if (!best) {
      best = t;
      continue;
    }
    const d = Number(t.start_ms) - Number(best.start_ms);
    if (d < -500) best = t;
    else if (Math.abs(d) <= 500 && t.kind === "share" && best.kind !== "share") best = t;
  }
  return best;
}

export function trackOffset(s: VodSession | null, t: VodTrack | null): number {
  return t && s && s.start_ms ? Math.max(0, (Number(t.start_ms) - Number(s.start_ms)) / 1000) : 0;
}
/** Seconds (session clock) at which a track ended, or −1 when unknown. */
export function trackEnd(s: VodSession | null, t: VodTrack | null): number {
  return t && t.end_ms && s && s.start_ms ? Math.max(0, (Number(t.end_ms) - Number(s.start_ms)) / 1000) : -1;
}

export function durSecsOf(s: VodSession | null, audioDur = 0, audioOffset = 0): number {
  if (!s) return 0;
  if (s.end_ms && s.start_ms) return Math.max(1, (Number(s.end_ms) - Number(s.start_ms)) / 1000);
  return Math.max(1, audioDur + audioOffset);
}

export function peopleOf(s: VodSession): string[] {
  if (Array.isArray(s.people)) return s.people.map(String);
  const out: string[] = [];
  for (const t of s.tracks) {
    const u = userIdOf(t.identity);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

export function countKinds(s: VodSession): { voices: number; streams: number; cams: number } {
  let voices = 0, streams = 0, cams = 0;
  for (const t of s.tracks) {
    if (t.kind === "audio") voices++;
    else if (t.kind === "share") streams++;
    else cams++;
  }
  return { voices, streams, cams };
}

export const kindGlyph = (k: string) => (k === "share" ? "🖥" : k === "cam" ? "📷" : "🎙");
export const kindWord = (k: string) => (k === "share" ? "stream" : k === "cam" ? "camera" : "voice");

export function thumbUrl(trackUrl: string, t: number, retry = 0): string {
  const base = sameOrigin(String(trackUrl)).replace("/api/vods/file/", "/api/vods/thumb/");
  return `${base}&t=${Math.max(0, Math.floor(t))}${retry > 0 ? `&r=${retry}` : ""}`;
}

/** A representative frame for the library card (MemoriesWindow.qml posterUrl). */
export function posterUrl(s: VodSession, retry = 0): string {
  if (!s.end_ms) return "";
  const best = earliestVideo(s.tracks);
  if (!best || !best.url) return "";
  const dur = Math.max(1, (Number(s.end_ms) - Number(s.start_ms)) / 1000);
  const off = Math.max(0, (Number(best.start_ms) - Number(s.start_ms)) / 1000);
  const t0 = Math.floor(Math.min(dur - 1, Math.max(off + 1, Math.min(off + 8, dur / 3))));
  return thumbUrl(best.url, Math.max(0, t0 - Math.floor(off)), retry);
}

export interface Pov {
  file: string;
  kind: string;
  label: string;
  off: number;
  end: number;
  key: number;
}
export interface PovGroup {
  user: string;
  name: string;
  povs: Pov[];
}

/** Points of view grouped by person, cameras first then streams; keys 1-9. */
export function povGroupsOf(s: VodSession | null): PovGroup[] {
  const vts = videoTracksOf(s).slice().sort((a, b) => Number(a.start_ms) - Number(b.start_ms) || (a.file < b.file ? -1 : 1));
  const groups: Array<{ user: string; name: string; cams: VodTrack[]; shares: VodTrack[] }> = [];
  const byUser = new Map<string, number>();
  for (const t of vts) {
    const u = userIdOf(t.identity);
    if (!byUser.has(u)) {
      byUser.set(u, groups.length);
      groups.push({ user: u, name: shortName(t.identity), cams: [], shares: [] });
    }
    const g = groups[byUser.get(u)!];
    (t.kind === "cam" ? g.cams : g.shares).push(t);
  }
  let key = 1;
  return groups.map((g) => {
    const povs: Pov[] = [];
    g.cams.forEach((t, i) => povs.push({ file: t.file, kind: "cam", off: trackOffset(s, t), end: trackEnd(s, t), label: `Camera${g.cams.length > 1 ? ` ${i + 1}` : ""}`, key: key++ }));
    g.shares.forEach((t, i) =>
      povs.push({ file: t.file, kind: "share", off: trackOffset(s, t), end: trackEnd(s, t), label: `Stream${g.shares.length > 1 ? ` ${i + 1}` : ""}`, key: key++ }),
    );
    return { user: g.user, name: g.name, povs };
  });
}

export function povOfFile(groups: PovGroup[], file: string): { group: PovGroup; pov: Pov } | null {
  for (const g of groups) for (const p of g.povs) if (p.file === file) return { group: g, pov: p };
  return null;
}

/** "sam's camera" / "alex's stream 2" */
export function povDescr(groups: PovGroup[], t: VodTrack | null): string {
  if (!t) return "";
  const hit = povOfFile(groups, t.file);
  if (hit) return `${hit.group.name}'s ${hit.pov.label.toLowerCase()}`;
  return `${shortName(t.identity)}'s ${kindWord(t.kind)}`;
}

/** 0 = playing now, 1 = not yet joined, 2 = left. */
export function railRank(s: VodSession | null, t: VodTrack | null, g: number): number {
  if (!t) return 3;
  const off = trackOffset(s, t), end = trackEnd(s, t);
  if (g < off - 0.5) return 1;
  if (end > 0 && g > end + 0.5) return 2;
  return 0;
}

export function railOrderedFiles(s: VodSession | null, side: VodTrack[], g: number): string[] {
  const arr = side.slice();
  arr.sort((a, b) => {
    const ra = railRank(s, a, g), rb = railRank(s, b, g);
    if (ra !== rb) return ra - rb;
    if (ra === 1) {
      const d = trackOffset(s, a) - trackOffset(s, b);
      if (Math.abs(d) > 0.01) return d;
    }
    if (ra === 2) {
      const d = trackEnd(s, b) - trackEnd(s, a);
      if (Math.abs(d) > 0.01) return d;
    }
    const pa = shortName(a.identity).toLowerCase(), pb = shortName(b.identity).toLowerCase();
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ka = a.kind === "cam" ? 0 : 1, kb = b.kind === "cam" ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const d3 = Number(a.start_ms) - Number(b.start_ms);
    if (d3) return d3;
    return a.file < b.file ? -1 : 1;
  });
  return arr.map((t) => t.file);
}

/**
 * Sticky slot assignment (MemoriesWindow.qml assignSlots): 8 slots, 0-4 live video, 5-7 snapshot-only.
 * Files keep their slot while in the rail; newcomers take the swap-hint slot, a just-freed slot, a free
 * live slot (playing now) / overflow slot (not playing), any free slot; then one rebalance pass.
 */
export function assignSlots(prev: string[], order: string[], hint: Record<string, number>, rankOf: (f: string) => number): string[] {
  const want = new Set(order);
  const slots = prev.slice();
  while (slots.length < 8) slots.push("");
  const freed: number[] = [];
  for (let k = 0; k < slots.length; k++) {
    if (slots[k] && !want.has(slots[k])) {
      freed.push(k);
      slots[k] = "";
    }
  }
  const placed = new Set(slots.filter(Boolean));
  const pending: string[] = [];
  for (const f of order) {
    if (placed.has(f)) continue;
    const h = hint[f];
    if (h !== undefined && slots[h] === "") {
      slots[h] = f;
      placed.add(f);
    } else pending.push(f);
  }
  const pick = (live: boolean) => {
    for (const fs of freed) if (slots[fs] === "" && fs < 5 === live) return fs;
    for (let q = 0; q < slots.length; q++) if (slots[q] === "" && q < 5 === live) return q;
    for (const fs of freed) if (slots[fs] === "") return fs;
    for (let q = 0; q < slots.length; q++) if (slots[q] === "") return q;
    return -1;
  };
  for (const f of pending) {
    const s = pick(rankOf(f) === 0);
    if (s >= 0) slots[s] = f;
  }
  for (let a = 5; a < slots.length; a++) {
    if (!slots[a] || rankOf(slots[a]) !== 0) continue;
    let moved = false;
    for (let e = 0; e < 5; e++)
      if (slots[e] === "") {
        slots[e] = slots[a];
        slots[a] = "";
        moved = true;
        break;
      }
    if (moved) continue;
    for (let b = 0; b < 5; b++) {
      if (slots[b] && rankOf(slots[b]) !== 0) {
        const tmp = slots[a];
        slots[a] = slots[b];
        slots[b] = tmp;
        break;
      }
    }
  }
  return slots;
}

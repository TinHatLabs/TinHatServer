// dmstrip.ts — REACH §1.1 + A2.14: which DMs sit in the rail's DM strip (desktop twin: `nav::dm_strip` in
// nav.rs; the two share the same 10 unit-test cases, dmstrip.test.ts ↔ nav.rs #[cfg(test)]).
//
//   dmStrip(rooms) → { entries (≤ 5), overflow }
//
// A room qualifies when it is a DM and either joined with a non-zero badge or an invite. Newest first
// (recency ms, descending); ties → the lowercased names by Unicode code point, then id. At most 5 bubbles,
// of which at most 2 invites (A2.14); every other qualifying room counts toward the "+N" overflow. Pure:
// no imports, so the test runs under plain Node type stripping and nothing here can drift from the
// desktop's rule.

export interface DmStripRoom {
  id: string;
  dm: boolean;
  membership: "join" | "invite";
  /** the room list's badge number (already 0 for a muted room, the highlight count in mentions mode) */
  unread: number;
  highlight: boolean;
  /** newest activity in ms (0 = unknown); for an invite, the invite time */
  recency: number;
  name: string;
  avatar: string;
  /** the other person's mxid ("" = unknown) */
  peer: string;
}

/** One strip bubble — the same fields as the desktop's `dmStripJson` entries. */
export interface DmStripEntry {
  id: string;
  name: string;
  avatar: string;
  peer: string;
  unread: number;
  highlight: boolean;
  invite: boolean;
  recency: number;
}

export interface DmStrip {
  entries: DmStripEntry[];
  /** qualifying rooms without a bubble (beyond 5, or invites beyond 2) — the "+N" bubble */
  overflow: number;
}

export const DM_STRIP_MAX = 5;
/** A2.14: at most this many invites take a bubble; the rest count toward the overflow. */
export const DM_STRIP_MAX_INVITES = 2;

export const EMPTY_DM_STRIP: DmStrip = { entries: [], overflow: 0 };

/** Plain order (ids). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unicode code point order — Rust's `str` comparison (A2.14); never UTF-16 units, never localeCompare. */
export function cmpCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function dmStrip(rooms: readonly DmStripRoom[]): DmStrip {
  const q = rooms.filter((r) => r.dm && ((r.membership === "join" && r.unread > 0) || r.membership === "invite"));
  q.sort((a, b) => (b.recency || 0) - (a.recency || 0) || cmpCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id));
  const picked: DmStripRoom[] = [];
  let invites = 0;
  for (const r of q) {
    if (picked.length >= DM_STRIP_MAX) break;
    if (r.membership === "invite") {
      if (invites >= DM_STRIP_MAX_INVITES) continue;
      invites++;
    }
    picked.push(r);
  }
  return {
    entries: picked.map((r) => ({
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      peer: r.peer,
      unread: r.unread,
      highlight: r.highlight,
      invite: r.membership === "invite",
      recency: r.recency || 0,
    })),
    overflow: q.length - picked.length,
  };
}

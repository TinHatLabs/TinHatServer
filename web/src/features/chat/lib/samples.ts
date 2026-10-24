// samples.ts — the gates' sample conversation rows (widgets W3): with the debug flag, `?chatsamples=dice` appends the shared
// sample dice messages (src/widgets/dice.ts DICE_CHAT_SAMPLES; the desktop's TINHAT_CHAT_SAMPLES=dice shows the same rows),
// `?chatsamples=polls` the shared sample polls (src/widgets/polls.ts POLL_CHAT_SAMPLES: starts, responses, ends)
// to the open conversation as LOCAL events — rendered like any message, never sent, never stored. Nothing else ever sets
// it, so normal use never sees them.
import { MatrixEvent } from "matrix-js-sdk";
import { DICE_CHAT_SAMPLES, diceContent, evaluateDice, parseDice } from "@/widgets/dice";
import { POLL_CHAT_SAMPLES, START_TYPES, sampleEvents as pollSampleEvents, type PollEvent } from "@/widgets/polls";

const KINDS: string[] = (() => {
  try {
    const w = window as unknown as { __TW_DEBUG__?: boolean };
    if (!(import.meta.env.DEV || w.__TW_DEBUG__)) return [];
    const q = location.search + "&" + (location.hash.split("?")[1] ?? "");
    const m = q.match(/[?&]chatsamples=([a-z,]+)/);
    return m ? m[1]!.split(",") : [];
  } catch {
    return [];
  }
})();

export const HAS_CHAT_SAMPLES = KINDS.length > 0;

function todayAt(h: number, m: number): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

let cache: { key: string; events: MatrixEvent[] } | null = null;

/** The sample events for this room (stable objects per room, so rows keep their identity). */
export function sampleEvents(roomId: string, me: string): MatrixEvent[] {
  if (!HAS_CHAT_SAMPLES) return [];
  const key = `${roomId}\u0000${me}`;
  if (cache?.key === key) return cache.events;
  const out: MatrixEvent[] = [];
  if (KINDS.includes("dice"))
    for (const s of DICE_CHAT_SAMPLES) {
      const p = parseDice(s.expr);
      if (!p.ok) continue;
      const r = evaluateDice(p, s.rolls);
      if (!r) continue;
      out.push(new MatrixEvent({ type: "m.room.message", event_id: s.id, room_id: roomId, sender: s.mine ? me : s.sender, origin_server_ts: todayAt(s.at[0], s.at[1]), content: diceContent(r) }));
    }
  if (KINDS.includes("polls"))
    for (const s of POLL_CHAT_SAMPLES)
      for (const e of pollSampleEvents(s, me, todayAt(0, 0)))
        out.push(new MatrixEvent({ type: e.type, event_id: e.id, room_id: roomId, sender: e.sender, origin_server_ts: e.ts, content: e.content as never }));
  cache = { key, events: out };
  return out;
}

/** The sample polls' responses and ends (the poll card tallies them with the room's own); [] without the samples. */
export function sampleRelations(roomId: string, me: string): PollEvent[] {
  if (!KINDS.includes("polls") || !roomId) return [];
  return POLL_CHAT_SAMPLES.flatMap((s) => pollSampleEvents(s, me, todayAt(0, 0))).filter((e) => !(START_TYPES as readonly string[]).includes(e.type));
}

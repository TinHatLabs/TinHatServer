// polls/store.ts — Polls' device side (contract WIDGETS.md §17; the desktop's RoomController poll invokables): the room's
// polls from its loaded timeline (the starts, their responses and ends — decrypted; js-sdk's local echo makes my own
// vote count at once), who may end a poll (its creator, or someone who may redact it: Element's rule), and the three
// writes — a new poll, a vote, an end — in the shapes Element sends (the shared startContent / responseContent /
// endContent). No timer: everything follows the room's timeline.
import { withCurrentRelation } from "@/core/matrix/moved";
import { EventStatus, type MatrixEvent, type Room } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import {
  END_TYPE,
  END_TYPES,
  RESPONSE_TYPE,
  RESPONSE_TYPES,
  START_TYPE,
  START_TYPES,
  endContent,
  endText,
  readStart,
  responseContent,
  startContent,
  tally,
  type Poll,
  type PollEvent,
  type PollKind,
  type Tally,
} from "@/widgets/polls";

export interface PollView {
  /** the start event's id (a "~" id while my new poll is still being sent) */
  id: string;
  creator: string;
  ts: number;
  poll: Poll;
  t: Tally;
  /** I may end it (open, and I'm the creator or may redact it) */
  canEnd: boolean;
  /** my new poll, not on the server yet */
  pending: boolean;
}

const isStart = (t: string) => (START_TYPES as readonly string[]).includes(t);
const isRel = (t: string) => (RESPONSE_TYPES as readonly string[]).includes(t) || (END_TYPES as readonly string[]).includes(t);

/** The responses and ends of a loaded timeline as the shared tally reads them (my unsent echoes included; failed or
 *  cancelled sends and redacted events left out). */
export function relationsOf(events: readonly MatrixEvent[]): PollEvent[] {
  const out: PollEvent[] = [];
  for (const ev of events) {
    const type = ev.getType();
    if (!isRel(type) || ev.isRedacted() || ev.status === EventStatus.NOT_SENT || ev.status === EventStatus.CANCELLED) continue;
    const id = ev.getId() ?? ev.getTxnId() ?? "";
    if (!id) continue;
    out.push({ id, type, sender: ev.getSender() ?? "", ts: ev.getTs(), content: withCurrentRelation(ev.getOriginalContent(), ev.getUnsigned()) }); // a moved server: today's ids
  }
  return out;
}

/** The people besides the creator whose ends count: the senders of this timeline's ends who may redact the start. */
function endersOf(room: Room | null, start: MatrixEvent, rels: readonly PollEvent[]): string[] {
  if (!room) return [];
  const out: string[] = [];
  for (const r of rels) {
    if (!(END_TYPES as readonly string[]).includes(r.type) || out.includes(r.sender)) continue;
    try {
      if (room.currentState.maySendRedactionForEvent(start, r.sender)) out.push(r.sender);
    } catch {
      /* unknown member: not permitted */
    }
  }
  return out;
}

/** May I end polls of others here (the redact power)? My own I may always end. */
function mayRedactOthers(room: Room | null, me: string): boolean {
  if (!room) return false;
  const member = room.getMember(me);
  if (!member) return false;
  try {
    return room.currentState.hasSufficientPowerLevelFor("redact", member.powerLevel);
  } catch {
    return false;
  }
}

/** One poll start → its view (null: not a poll this app can show). */
export function viewOf(room: Room | null, start: MatrixEvent, rels: readonly PollEvent[], me: string): PollView | null {
  if (start.isRedacted()) return null;
  const poll = readStart(start.getType(), start.getOriginalContent());
  if (!poll) return null;
  const id = start.getId() ?? start.getTxnId() ?? "";
  const creator = start.getSender() ?? "";
  const t = tally(poll, id, creator, rels, endersOf(room, start, rels), me);
  const pending = start.status != null;
  return { id, creator, ts: start.getTs(), poll, t, canEnd: !t.ended && !pending && (creator === me || mayRedactOthers(room, me)), pending };
}

/** The open polls of a loaded timeline, newest first. */
export function openPolls(room: Room | null, events: readonly MatrixEvent[], me: string): PollView[] {
  const rels = relationsOf(events);
  const out: PollView[] = [];
  for (const ev of events) {
    if (!isStart(ev.getType()) || ev.status === EventStatus.NOT_SENT || ev.status === EventStatus.CANCELLED) continue;
    const v = viewOf(room, ev, rels, me);
    if (v && !v.t.ended) out.push(v);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** A fresh answer id: 12 characters [a-z0-9] from the CSPRNG (unbiased: 36 × 7 = 252 of every 256 byte values used). */
export function answerId(): string {
  const A = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const buf = new Uint8Array(32);
  while (s.length < 12) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 252 && s.length < 12) s += A[b % 36];
  }
  return s;
}

/** May I start a poll in this room (joined, and the power to send the start event)? */
export function canCreateIn(roomId: string): boolean {
  const c = peekClient();
  const room = roomId ? c?.getRoom(roomId) : null;
  if (!c || !room || room.getMyMembership() !== "join") return false;
  return room.currentState.maySendEvent(START_TYPE, c.getUserId() ?? "");
}

/** The New poll dialog's Create: "" = sent (js-sdk's local echo shows it at once), else the friendly error. */
export function createPoll(roomId: string, question: string, answers: string[], kind: PollKind): string {
  const c = peekClient();
  if (!c) return "Not signed in";
  const r = startContent(question, answers, kind, answers.map(() => answerId()));
  if (!r.ok) return r.message;
  c.sendEvent(roomId, START_TYPE as never, r.content as never).catch(() => {
    /* the chat shows the failed row */
  });
  return "";
}

/** A vote (the shared nextChoice decided what): js-sdk's local echo makes it count at once. */
export function vote(roomId: string, startId: string, answers: string[]): void {
  peekClient()
    ?.sendEvent(roomId, RESPONSE_TYPE as never, responseContent(startId, answers) as never)
    .catch(() => {
      /* a failed vote simply doesn't count; the card shows the server's tally */
    });
}

/** End a poll (the creator's or a moderator's): the end message is the shared endText of the tally so far. */
export function endPoll(roomId: string, v: PollView): void {
  peekClient()
    ?.sendEvent(roomId, END_TYPE as never, endContent(v.id, endText(v.poll, v.t)) as never)
    .catch(() => {
      /* nothing changes: the poll stays open */
    });
}

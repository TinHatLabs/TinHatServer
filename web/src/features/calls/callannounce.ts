// callannounce.ts — what a screen reader hears about calls (accessibility round 2, M3). Pure rules, no I/O: the text
// for an incoming call, for the call's own state changes (joining, in, reconnecting, failed, left) and for people
// joining / leaving it, and whether it interrupts (assertive) or waits (polite). The desktop's
// crates/app/src/callannounce.rs has the same rules; the shared vectors (callannounce.vectors.json = desktop
// testvectors/callannounce.json, byte-identical) pin both. The web speaks them through the live regions of
// src/ui/announce.tsx, the desktop through Accessible.announce.

/** The call flags both apps keep (contract.ts CallState / AppCore mInCall, mConnecting, …). */
export interface CallFlags {
  inCall: boolean;
  connecting: boolean;
  reconnecting: boolean;
  callFailed: boolean;
  failReason: string;
  removedBy: string;
}

export type CallPhase = "idle" | "connecting" | "in" | "reconnecting" | "failed";

export interface Announcement {
  text: string;
  /** true = assertive (interrupts what the screen reader is saying); false = polite. */
  urgent: boolean;
}

/** People joining / leaving in the first ROSTER_ARM_MS after you got in are the people already there (the call
 *  server reports each of them as a join): not announced — the same window as the join chime. */
export const ROSTER_ARM_MS = 2500;
/** Joins and leaves within this window are read as one sentence ("Ana and Ben joined the call"). */
export const ROSTER_BATCH_MS = 1200;

/** One phase from the flags: failed > reconnecting > in > connecting > idle. */
export function callPhase(f: CallFlags): CallPhase {
  if (f.callFailed) return "failed";
  if (f.reconnecting) return "reconnecting";
  if (f.inCall) return "in";
  if (f.connecting) return "connecting";
  return "idle";
}

function inRoom(room: string): string {
  const r = room.trim();
  return r.length > 0 ? ` in ${r}` : "";
}

/** The failure banner's own words (CallIsland.qml / CallStage.tsx), with the reason when a join failed. */
export function failText(f: CallFlags): string {
  if (f.removedBy.trim().length > 0) return `${f.removedBy.trim()} disconnected you from the call`;
  const r = f.failReason.trim();
  if (r.length > 0) return `Couldn't join the call: ${r.charAt(0).toUpperCase()}${r.slice(1)}`;
  return "Call ended — connection lost";
}

/** What to say when the call's state goes from `prev` to `next` (null = nothing to say). */
export function phaseAnnouncement(prev: CallFlags, next: CallFlags, room: string): Announcement | null {
  const a = callPhase(prev);
  const b = callPhase(next);
  if (b === "failed") {
    // a new failure, or the same banner with other words (a join failure after a drop)
    if (a === "failed" && failText(prev) === failText(next)) return null;
    return { text: failText(next), urgent: true };
  }
  if (a === b) return null;
  switch (b) {
    case "connecting":
      return { text: `Joining the call${inRoom(room)}…`, urgent: false };
    case "in":
      return a === "reconnecting" ? { text: "Reconnected to the call", urgent: false } : { text: `You're in the call${inRoom(room)}`, urgent: false };
    case "reconnecting":
      return { text: "Reconnecting to the call…", urgent: true };
    case "idle":
      if (a === "failed") return null; // the banner was dismissed
      if (a === "connecting") return { text: "Stopped joining the call", urgent: false };
      return { text: "You left the call", urgent: false };
  }
  return null;
}

/** An incoming call card appeared. */
export function incomingAnnouncement(room: string, who: string, inOtherCall: boolean): Announcement {
  const w = who.trim().length > 0 ? `${who.trim()} started a call` : "Someone started a call";
  return { text: `Incoming call${inRoom(room)}: ${w}${inOtherCall ? ". You're in another call" : ""}`, urgent: true };
}

/** A15.2/A15.6 (2026-11-13; desktop callannounce.rs incoming_card): the incoming card's two lines. A DM names the caller
 *  ("Ana is calling"); a group names the room and who is in the call now (`inCall`, me left out), else who started it. */
export function incomingCard(dm: boolean, room: string, who: string, inCall: string[], inOtherCall: boolean): { title: string; sub: string } {
  const other = inOtherCall ? " — you're in another call" : "";
  const w = who.trim();
  if (dm) {
    const n = w || room.trim() || "Someone";
    return { title: `${n} is calling`, sub: `Incoming call${other}` };
  }
  const list = nameList(inCall);
  const count = inCall.filter((x) => x.trim().length > 0).length;
  const sub = list ? `${list} ${count === 1 ? "is" : "are"} in the call` : w ? `${w} started a call` : "Someone started a call";
  return { title: `Incoming call · ${room.trim()}`, sub: `${sub}${other}` };
}

/** D09.5 (2026-11-13; desktop callannounce.rs start_note): after I START a call (`alone`) in a room with members on other
 *  servers, they will meet "Join a call hosted elsewhere?" — say so to the caller. "" = nothing to say. */
export const START_NOTE = "People here from other servers will be asked to trust your server's call host before they can join.";
export function startNote(me: string, members: string[], alone: boolean): string {
  const server = (m: string) => {
    if (!m.startsWith("@")) return null;
    const i = m.indexOf(":");
    return i > 1 && i < m.length - 1 ? m.slice(i + 1) : null;
  };
  const mine = server(me);
  if (!mine || !alone) return "";
  return members.some((m) => {
    const s = server(m);
    return s !== null && s !== mine;
  })
    ? START_NOTE
    : "";
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy", "Ana, Ben and 2 others" (the join banner's way of counting). */
export function nameList(names: string[]): string {
  const n = names.map((x) => x.trim()).filter((x) => x.length > 0);
  if (n.length === 0) return "";
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`;
}

/** People joined / left the call I am in (one batch). Someone who joined and left inside one batch is said once each. */
export function rosterAnnouncement(joined: string[], left: string[]): Announcement | null {
  const parts: string[] = [];
  const j = nameList(joined);
  const l = nameList(left);
  if (j.length > 0) parts.push(`${j} joined the call`);
  if (l.length > 0) parts.push(`${l} left the call`);
  if (parts.length === 0) return null;
  return { text: parts.join(". "), urgent: false };
}

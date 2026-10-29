// callwatch.ts — incoming calls (native callwatch.rs + IncomingCallToast.qml + AppCore.qml chimes):
// the rising edge of a room's msc3401 membership set rings (first pass only seeds), the falling
// edge ends the card; join/leave chimes; the desktop notification; the per-room call view the nav
// strip / join banner / header button read (useRoomCall), refreshed on membership changes, on SFU
// joins/leaves and 3 × 2.5 s after hanging up. DM ringing glue (RINGING.md §4 / §5, ringglue.ts): inside a Tin Hat app
// with caps "rings" the page rings only while visible, a ring answered on the phone opens / joins its room, and a
// `dev.tinhat.call.decline` shows "<name> declined" to the caller (or drops the card on the callee's other devices).
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent, RoomStateEvent, type IRoomTimelineData, type MatrixClient, type MatrixEvent, type Room, type RoomMember } from "matrix-js-sdk";
import { create } from "zustand";
import { getSession, onClientChanged, peekClient } from "@/core/matrix";
import { openRoom, toast } from "@/core/bus";
import { closeNotes, showNote } from "@/core/notes";
import { getPref } from "@/core/prefs";
import { playCallChime, playUiSound, setCallAudioSession, startRing, stopRing } from "@/core/sounds";
import { createLogger } from "@/core/log";
import type { IncomingCall } from "./contract";
import { getCall, patch, useCallStore } from "./store";
import { sess } from "./session";
import { claimsRoom, hooks, setChimeHook, switchCall } from "./engine";
import { callActive, rosterSessions, roomCallParticipants, type CallParticipant } from "./rtc";
import { onMemberProbe } from "./memberprobe";
import { LEGACY_MEMBER_TYPES, MEMBER_TYPE, avatarMxc, displayName, isRecorder, mxidOf } from "./util";
import { answeredElsewhere, pruneAnnounced, shouldAnnounce } from "./alertrules";
import { appRings, nativeCall, nativeCallIn, onNativeCall, onRingAnswer, ringInApp } from "@/features/native";
import { CALL_DECLINE_TYPE, DECLINED_SHOWN_MS, declineOutcome, declinedText, ringSets } from "./ringglue";

const log = createLogger("callwatch");

/** Bumps whenever any room's call membership may have changed (hooks re-derive from it). */
export const useCallRev = create<{ rev: number }>()(() => ({ rev: 0 }));
function bump() {
  useCallRev.setState((s) => ({ rev: s.rev + 1 }));
}

// ---- muted rooms ------------------------------------------------------------------------------------

/** REACH A5.5 (audit finding 12): a room rings unless its EFFECTIVE mode is Mute — an override rule for
 *  the room without "notify" (notify.rs / nav model.ts). "Mentions only" (a room rule without "notify")
 *  still rings, as on the desktop (callwatch.rs:164-168). */
function roomMuted(c: MatrixClient, roomId: string): boolean {
  try {
    const rules = (c.getAccountData("m.push_rules" as never)?.getContent()?.global ?? c.pushRules?.global ?? {}) as {
      override?: Array<{ rule_id: string; enabled?: boolean; actions?: unknown[]; conditions?: Array<{ kind?: string; key?: string; pattern?: string }> }>;
    };
    for (const r of rules.override ?? []) {
      if (r.enabled === false) continue;
      const hit = r.rule_id === roomId || (r.conditions ?? []).some((cd) => cd.kind === "event_match" && cd.key === "room_id" && cd.pattern === roomId);
      if (hit && !(r.actions ?? []).some((a) => a === "notify")) return true;
    }
  } catch {
    /* no push rules yet */
  }
  return false;
}

/** Room listed in m.direct (native `room.is_direct()`): DM calls always ring (alertrules.ts). */
function isDirectRoom(c: MatrixClient, roomId: string): boolean {
  try {
    const m = (c.getAccountData("m.direct" as never)?.getContent() ?? {}) as Record<string, string[] | undefined>;
    return Object.values(m).some((ids) => Array.isArray(ids) && ids.includes(roomId));
  } catch {
    return false;
  }
}

// ---- incoming ------------------------------------------------------------------------------------------

const activeRooms = new Map<string, boolean>();
/** room -> when it last raised an incoming-call alert (10.5.1: once per REANNOUNCE_MS, see alertrules.ts). */
const announced = new Map<string, number>();
let seeded = false;
let ringLimit: ReturnType<typeof setTimeout> | null = null;
let ringing = false;

function stopRinging() {
  if (ringing) stopRing();
  ringing = false;
  if (ringLimit) clearTimeout(ringLimit);
  ringLimit = null;
  useIncomingRing.setState({ ringing: false });
}

/** callui reads `ringing` to pulse the card only while the 25 s ring timer runs. */
export const useIncomingRing = create<{ ringing: boolean }>()(() => ({ ringing: false }));

function present(call: IncomingCall) {
  const cur = getCall().incomingCalls;
  if (cur.some((c) => c.roomId === call.roomId)) return;
  patch({ incomingCalls: [...cur, call] });
  const st = getCall();
  // caps "rings": the app rings for us while the page is hidden (no double ring, no second notification)
  const here = ringInApp(appRings(), pageVisible());
  // (a Tin Hat app's native call counts as being in a call: the short blip, not the ring — features/native)
  if (!here) log.info(`incoming call in ${call.roomId}: the app rings while the page is hidden`);
  else if (st.inCall || st.connecting || nativeCall()) playUiSound("notify");
  else {
    if (getPref("snd.ring", "") !== "0") {
      startRing();
      ringing = true;
    }
  }
  useIncomingRing.setState({ ringing: true });
  if (ringLimit) clearTimeout(ringLimit);
  ringLimit = setTimeout(stopRinging, 25000);
  if (here) notify(call);
  log.info(`incoming call in ${call.roomId} (${call.who || "someone"})`);
}

// The ONE incoming-call desktop notification (INTEGRATION item 8: callui and settings used to post their
// own too). Tag `incoming-call:<roomId>` so a re-post replaces rather than stacks; silent (the ring / notify
// blip are ours, snd.*); closed as soon as the card goes (answered, dismissed, the call ended, room left).
// REACH §3.2: posted through core/notes (the push worker's registration when there is one — Android Chrome
// and installed iOS web apps have no `new Notification`); a click opens the room.
const notes = new Set<string>();

function notify(call: IncomingCall) {
  if (getPref("notify.calls", "") === "0") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const posted = showNote({
    title: `Incoming call · ${call.roomName}`,
    body: call.who ? `${call.who} started a call` : "Someone started a call",
    tag: `incoming-call:${call.roomId}`,
    silent: true,
    room: call.roomId,
  });
  if (posted) notes.add(call.roomId);
}

function closeNote(roomId: string) {
  if (!notes.delete(roomId)) return;
  void closeNotes(`incoming-call:${roomId}`);
}

export function dismissIncoming(roomId: string): void {
  closeNote(roomId);
  const cur = getCall().incomingCalls.filter((c) => c.roomId !== roomId);
  patch({ incomingCalls: cur });
  if (cur.length === 0) stopRinging();
}

/** The card's Join / Switch: stop the ring, drop the card, open the room, switchCall. */
export function answerIncoming(roomId: string): void {
  closeNote(roomId);
  stopRinging();
  patch({ incomingCalls: getCall().incomingCalls.filter((c) => c.roomId !== roomId) });
  openRoom(roomId);
  switchCall(roomId);
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

// ---- a ring answered on the phone (caps "rings": `tinhatnative:call {action: "answer", roomId}`) ----------------------

/** The answer waits (≤ 30 s) for the live sync and the room: a cold start sends it right after the page loads. */
let pendingAnswer: { roomId: string; until: number } | null = null;

function answerFromApp(roomId: string) {
  pendingAnswer = { roomId, until: Date.now() + 30_000 };
  log.info(`ring answered on the phone for ${roomId}`);
  tryAnswer();
}

function tryAnswer() {
  const p = pendingAnswer;
  if (!p) return;
  if (Date.now() > p.until) {
    pendingAnswer = null;
    log.info(`answer for ${p.roomId}: room or live sync not there in 30 s — dropped`);
    return;
  }
  const c = peekClient();
  if (!c || !getSession().liveSyncDone || c.getRoom(p.roomId)?.getMyMembership() !== "join") return;
  pendingAnswer = null;
  const st = getCall();
  if (st.callRoomId === p.roomId && (st.inCall || st.connecting)) openRoom(p.roomId);
  else if (callActive(p.roomId)) answerIncoming(p.roomId); // the room + its call (switches from another call)
  else openRoom(p.roomId); // the call is over: just the room
}

// ---- dev.tinhat.call.decline (RINGING.md §5) ------------------------------------------------------------------------------
// A decline is judged again on every scan until it matters or goes stale (60 s): one that arrives before its incoming
// card (the phone declined while this page was still syncing) still takes the card down once it shows. Only live
// timeline events count, decrypted later or not (an encrypted one is remembered live until it decrypts). Join-only
// (fix/left-member's rule): a decliner who has left is ignored, and a ring names only a live call.member of a joined
// member (a departed caller's ring names nobody).

const declinesDone = new Set<string>();
const pendingDeclines = new Map<string, MatrixEvent>();
const liveEncrypted = new Set<string>();

function bounded(set: Set<string> | Map<string, unknown>, max: number) {
  while (set.size > max) set.delete(set.keys().next().value as string);
}

/** The room's ring sets now (ringglue.ts ringSets: live call.member events of joined senders only). */
function ringIds(room: Room, me: string): { own: string[]; live: string[] } {
  const events = room.currentState.getStateEvents(MEMBER_TYPE).map((ev) => ({
    event_id: ev.getId() ?? "",
    sender: ev.getSender() ?? "",
    state_key: ev.getStateKey() ?? "",
    origin_server_ts: ev.getTs(),
    content: ev.getContent(),
  }));
  return ringSets(events, (u) => room.getMember(u)?.membership, me, Date.now());
}

function judgeDeclines() {
  if (!pendingDeclines.size) return;
  const c = peekClient();
  const me = c?.getUserId() ?? "";
  if (!c || !me) return;
  const now = Date.now();
  for (const [id, ev] of [...pendingDeclines]) {
    const roomId = ev.getRoomId() ?? "";
    const room = c.getRoom(roomId);
    if (!room || Math.abs(now - ev.getTs()) > 60_000) {
      pendingDeclines.delete(id);
      continue;
    }
    const content = ev.getContent();
    const ids = ringIds(room, me);
    const st = getCall();
    const raw = { type: ev.getType(), sender: ev.getSender(), origin_server_ts: ev.getTs(), content };
    const out = declineOutcome(raw, {
      me,
      now,
      dm: room.getJoinedMemberCount() === 2,
      senderJoined: room.getMember(ev.getSender() ?? "")?.membership === "join",
      inCallHere: st.callRoomId === roomId && (st.inCall || st.connecting),
      cardUp: st.incomingCalls.some((x) => x.roomId === roomId),
      ownRings: ids.own,
      liveRings: ids.live,
    });
    if (out === "none") continue;
    pendingDeclines.delete(id);
    declinesDone.add(id);
    bounded(declinesDone, 200);
    if (out === "declined") {
      // gates: this log line + <html data-th-declined="<room> <sender> <ring> <ms>"> stay (the toast is requested for
      // DECLINED_SHOWN_MS; tools/README-gates.md "Declined rings")
      const ring = typeof content.ring === "string" ? content.ring : "";
      log.info(`ring in ${roomId} declined by ${ev.getSender()} (ring ${ring})`);
      try {
        document.documentElement.dataset.thDeclined = `${roomId} ${ev.getSender() ?? ""} ${ring} ${now}`;
      } catch {
        /* no DOM (tests) */
      }
      toast(declinedText(displayName(roomId, ev.getSender() ?? "")), { timeoutMs: DECLINED_SHOWN_MS });
      playCallChime("leave");
    } else {
      log.info(`ring in ${roomId} declined on another of my devices — card dismissed`);
      dismissIncoming(roomId);
    }
  }
}

function takeDecline(ev: MatrixEvent) {
  const id = ev.getId();
  if (!id || ev.getType() !== CALL_DECLINE_TYPE || ev.isDecryptionFailure() || declinesDone.has(id)) return;
  pendingDeclines.set(id, ev);
  bounded(pendingDeclines, 50);
  judgeDeclines();
}
function onTimelineEv(ev: MatrixEvent, _room: Room | undefined, toStart: boolean | undefined, removed: boolean, data: IRoomTimelineData) {
  if (toStart || removed || !data?.liveEvent) return;
  const id = ev.getId();
  if (id && ev.isEncrypted() && (ev.getType() === "m.room.encrypted" || ev.isDecryptionFailure())) {
    liveEncrypted.add(id); // not readable yet: Decrypted brings it
    bounded(liveEncrypted, 200);
    return;
  }
  takeDecline(ev);
}
function onDecrypted(ev: MatrixEvent) {
  const id = ev.getId();
  if (!id || !liveEncrypted.has(id) || ev.isDecryptionFailure()) return; // history, or still unreadable (a retry comes)
  liveEncrypted.delete(id);
  takeDecline(ev);
}

/** A room's call-membership state events in the raw shape Pad's discovery reads ({sender, state_key, origin_server_ts, content}). */
function memberRaw(c: MatrixClient, roomId: string): unknown[] {
  return (c.getRoom(roomId)?.currentState.getStateEvents(MEMBER_TYPE) ?? []).map((ev) => ({ sender: ev.getSender() ?? "", state_key: ev.getStateKey() ?? "", origin_server_ts: ev.getTs(), content: ev.getContent() }));
}

function scan() {
  const c = peekClient();
  if (!c) return;
  const now = Date.now();
  // Rooms we left (or that vanished): forget them, and drop a card that was ringing for one.
  for (const id of [...activeRooms.keys()]) {
    if (c.getRoom(id)?.getMyMembership() === "join") continue;
    activeRooms.delete(id);
    if (getCall().incomingCalls.some((x) => x.roomId === id)) dismissIncoming(id);
  }
  for (const r of c.getRooms()) {
    if (r.getMyMembership() !== "join") continue;
    const active = callActive(r.roomId);
    const was = activeRooms.get(r.roomId) ?? false;
    activeRooms.set(r.roomId, active);
    if (!seeded) continue;
    if (active && !was) {
      if (claimsRoom(r.roomId) || nativeCallIn(r.roomId) || roomMuted(c, r.roomId)) continue;
      const me = c.getUserId();
      const first = rosterSessions(r.roomId, now)
        .filter((s) => s.sender !== me && !isRecorder(`${s.sender}:x`))
        .sort((a, b) => a.createdTs - b.createdTs)[0];
      if (!first) continue; // our own membership (another device of ours) — natives ring anyway; skip our own
      // already taken on another of my devices (both arrived together): no card, no ring (callwatch.rs does the same)
      if (answeredElsewhere(me ?? "", c.getDeviceId() ?? "", now, memberRaw(c, r.roomId))) {
        log.info(`call in ${r.roomId} already answered on another of my devices — not announced`);
        continue;
      }
      // A flapping group call (test rig, reconnecting client, recorder retry) alerts once per window; DMs always ring.
      if (!shouldAnnounce(announced.get(r.roomId), now, isDirectRoom(c, r.roomId))) {
        log.info(`call in ${r.roomId} restarted within the re-announce window — not alerting again`);
        continue;
      }
      pruneAnnounced(announced, now);
      announced.set(r.roomId, now);
      present({ roomId: r.roomId, roomName: r.name || r.roomId, who: first ? displayName(r.roomId, first.sender) : "" });
    } else if (!active && was) {
      dismissIncoming(r.roomId);
    }
  }
  // Answered elsewhere: a card whose call one of MY OTHER devices is now in goes, and the ring with it (callwatch.rs
  // does the same) — otherwise the phone keeps "Incoming call · Join" over the Pad after the PC took the call.
  const meId = c.getUserId() ?? "";
  const myDev = c.getDeviceId() ?? "";
  for (const call of getCall().incomingCalls) {
    if (answeredElsewhere(meId, myDev, now, memberRaw(c, call.roomId))) {
      log.info(`call in ${call.roomId} answered on another of my devices — card dismissed`);
      dismissIncoming(call.roomId);
    }
  }
  tryAnswer();
  judgeDeclines();
  // Seed on the first NETWORK sync (native: its first sync_once) — the IndexedDB cache can predate
  // calls that started while we were away; those still ring once the live sync shows them live.
  if (getSession().liveSyncDone) seeded = true;
}

// ---- chimes -----------------------------------------------------------------------------------------------

setChimeHook((kind) => playCallChime(kind));

// ---- React hooks ------------------------------------------------------------------------------------------

export interface RoomCall {
  active: boolean;
  participants: CallParticipant[];
}

const EMPTY: RoomCall = { active: false, participants: [] };
const cache = new Map<string, { rev: number; tilesKey: string; v: RoomCall }>();

/** Per-room call view: `active` (live msc3401) + participants (all spellings; our call = SFU truth). */
export function roomCall(roomId: string | null | undefined): RoomCall {
  if (!roomId) return EMPTY;
  const rev = useCallRev.getState().rev;
  const st = getCall();
  const ours = st.inCall && st.callRoomId === roomId;
  const tilesKey = ours ? st.tiles.map((t) => t.participant).join("|") : "";
  const hit = cache.get(roomId);
  if (hit && hit.rev === rev && hit.tilesKey === tilesKey) return hit.v;
  let v: RoomCall;
  if (ours) {
    const s = sess();
    const ids = new Set<string>();
    if (s) {
      ids.add(s.me);
      for (const i of s.room.remoteParticipants.keys()) if (!isRecorder(i)) ids.add(mxidOf(i));
    }
    v = { active: true, participants: [...ids].map((m) => ({ mxid: m, name: displayName(roomId, m), avatar: avatarMxc(roomId, m) })) };
  } else {
    const parts = roomCallParticipants(roomId).filter((p) => !isRecorder(p.mxid));
    v = { active: callActive(roomId), participants: parts };
  }
  cache.set(roomId, { rev, tilesKey, v });
  return v;
}

export function useRoomCall(roomId: string | null | undefined): RoomCall {
  useCallRev((s) => s.rev);
  useCallStore((s) => (s.inCall && s.callRoomId === roomId ? s.tiles : null));
  return roomCall(roomId);
}

export function useIncomingCalls(): IncomingCall[] {
  return useCallStore((s) => s.incomingCalls);
}

// ---- install --------------------------------------------------------------------------------------------------

let attached: MatrixClient | null = null;
function onStateEv(ev: MatrixEvent) {
  const t = ev.getType();
  if (t === MEMBER_TYPE || (LEGACY_MEMBER_TYPES as readonly string[]).includes(t)) {
    bump();
    scan();
  }
}
// a member stopped (or started) being joined: a call member who was kicked / left drops out of the roster
// (callrules.rosterCounts). RoomMemberEvent.Membership, not the state event: that fires before the member is updated.
function onMembership(_ev: MatrixEvent, m: RoomMember, old?: string) {
  // unknown before (lazy loading): only a non-join answer changes a roster (unknown counted); a loaded join doesn't
  if (old === undefined ? m.membership === "join" : (old === "join") === (m.membership === "join")) return;
  bump();
  scan();
}
// a probed call member's membership arrived (memberprobe.ts, via rtc.membershipIn): rosters rebuild
onMemberProbe(() => {
  bump();
  scan();
});
function onSync(state: string) {
  if (state === "PREPARED" || state === "SYNCING") scan();
}

export function installCallWatch(): void {
  const attach = () => {
    const c = peekClient();
    if (c === attached) return;
    if (attached) {
      // another account (or none): nothing of the previous one acts for the next (an answer that came before the
      // first client still waits for it)
      pendingAnswer = null;
      pendingDeclines.clear();
      liveEncrypted.clear();
      attached.off(RoomStateEvent.Events, onStateEv);
      attached.off(RoomMemberEvent.Membership, onMembership);
      attached.off(ClientEvent.Sync, onSync);
      attached.off(RoomEvent.Timeline, onTimelineEv);
      attached.off(MatrixEventEvent.Decrypted, onDecrypted);
    }
    attached = c;
    activeRooms.clear();
    announced.clear();
    seeded = false;
    cache.clear();
    // A different account/client: the previous one's cards and ring are gone with it.
    stopRinging();
    if (getCall().incomingCalls.length) patch({ incomingCalls: [] });
    if (c) {
      c.on(RoomStateEvent.Events, onStateEv);
      c.on(RoomMemberEvent.Membership, onMembership);
      c.on(ClientEvent.Sync, onSync);
      c.on(RoomEvent.Timeline, onTimelineEv);
      c.on(MatrixEventEvent.Decrypted, onDecrypted);
      scan();
    } else {
      stopRinging();
      patch({ incomingCalls: [] });
    }
  };
  attach();
  onClientChanged(attach);
  // Memberships expire without an event: re-evaluate every 30 s.
  setInterval(() => {
    bump();
    scan();
  }, 30000);
  // A card that goes by ANY path (callui's own Join/Dismiss, sign-out, fall edge) closes its notification.
  useCallStore.subscribe((st, prev) => {
    if (st.incomingCalls === prev.incomingCalls || !notes.size) return;
    for (const id of [...notes.keys()]) if (!st.incomingCalls.some((c) => c.roomId === id)) closeNote(id);
  });
  // GPU.md §2.3: a card goes as soon as ITS call is joined by any route — the card's Join/Switch, the join banner,
  // the header's call button, the nav's call strip, a switch that never drops `inCall` (the stale "Switch" card).
  useCallStore.subscribe((st) => {
    if (!(st.inCall || st.connecting) || !st.callRoomId) return;
    if (st.incomingCalls.some((c) => c.roomId === st.callRoomId)) dismissIncoming(st.callRoomId);
  });
  // Own join/leave chimes + answering stops the ring.
  useCallStore.subscribe((st, prev) => {
    if (st.inCall && !prev.inCall) {
      playCallChime("join");
      dismissIncoming(st.callRoomId);
      stopRinging(); // joining any call answers the ring; other rooms' cards stay (with "Switch")
    }
    if (!st.inCall && prev.inCall) playCallChime("leave");
    if (st.hangingUp && !prev.hangingUp) for (const d of [2500, 5000, 7500]) setTimeout(bump, d);
    // REACH §4 / A2.16: once the call is fully over (hang-up, drop, refused join, failure — every path ends
    // here with all four flags down) Safari's audio session is "ambient" again for the UI chimes
    const busy = st.inCall || st.connecting || st.hangingUp || st.reconnecting;
    const wasBusy = prev.inCall || prev.connecting || prev.hangingUp || prev.reconnecting;
    if (!busy && wasBusy) setCallAudioSession(false);
    else if (busy && !wasBusy) setCallAudioSession(true); // a join that didn't come through the click (auto-rejoin, guest hand-off)
  });
  // A Tin Hat app's native call (bridge 2) answers like a join of ours: its room's card goes, the ring stops.
  onNativeCall((n) => {
    if (!n || n.state === "leaving") return;
    dismissIncoming(n.roomId);
    stopRinging();
  });
  // caps "rings": the page hidden mid-ring hands the ringing to the app (the card stays); answers from the app's ring.
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (ringing && !ringInApp(appRings(), pageVisible())) {
        stopRing();
        ringing = false;
      }
    });
  onRingAnswer(answerFromApp);
  hooks.onParticipantJoined.push(() => bump());
  hooks.onParticipantLeft.push(() => bump());
}

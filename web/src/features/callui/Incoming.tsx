// Incoming.tsx — IncomingCallToast.qml (cards over everything, top centre) + the join banner
// (Main.qml:5245-5291, exported as CallHeaderChips) + the room's live-call roster read from
// MatrixRTC membership state (used by the join banner and the nav call strip).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GlowButton, Icon, OverlayPortal, RING_OPACITY, RING_STEP_MS, ToolButton, ringHigh, ringOn, useIsMobile, useReducedMotion } from "@/ui";
import { useRealWinState } from "@/core/winstate";
import { openRoom } from "@/core/bus";
import { OnThisPhone } from "@/features/native";
import { playUiSound, startRing, stopRing } from "@/core/sounds";
import { RoomMemberEvent, type MatrixClient, type RoomMember } from "matrix-js-sdk";
import { peekClient, useRoomStateEvents } from "@/core/matrix";
import { callerMembership, onMemberProbe } from "@/features/calls/memberprobe";
import { rosterCounts } from "@/features/calls/callrules";
import { isRecorder } from "@/core/server";
import { act, getC, useC } from "./store";
import { PadButton, padCallText, pickTarget, useDeviceName, usePadTargets } from "@/features/pad";
import s from "./Incoming.module.css";

// ---- live call roster (org.matrix.msc3401.call.member / m.call.member / m.rtc.member) ---------

const MEMBER_TYPES = ["org.matrix.msc3401.call.member", "m.call.member", "m.rtc.member"] as const;

interface MemberContent {
  [k: string]: unknown;
  created_ts?: number;
  expires?: number;
  expires_ts?: number;
  application?: string;
  device_id?: string;
  memberships?: Array<{ created_ts?: number; expires?: number; expires_ts?: number }>;
}

function live(c: MemberContent, ts: number, now: number): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  if (Array.isArray(c.memberships)) return c.memberships.some((m) => live(m as MemberContent, ts, now));
  if (typeof c.expires_ts === "number") return c.expires_ts > now;
  const created = typeof c.created_ts === "number" ? c.created_ts : ts;
  const exp = typeof c.expires === "number" ? c.expires : 14400000;
  return created + exp > now;
}

// A room's "who's joined" revision: bumps when someone joins it or stops being joined (kicked, left), so a roster whose
// call memberships didn't change still drops a member who left (callrules.rosterCounts). One client listener for all.
const joinRevs = new Map<string, number>();
const joinSubs = new Set<() => void>();
let joinClient: MatrixClient | null = null;
function bumpJoins(roomId: string, notify = true) {
  joinRevs.set(roomId, (joinRevs.get(roomId) ?? 0) + 1);
  if (notify) for (const f of joinSubs) f();
}
function onJoinChange(_ev: unknown, m: RoomMember, old?: string) {
  // old undefined = a member just loaded (lazy loading): its membership is known now
  if (old !== undefined && (old === "join") === (m.membership === "join")) return;
  bumpJoins(m.roomId);
}
function watchJoins(): void {
  const c = peekClient();
  if (c === joinClient) return;
  joinClient?.off(RoomMemberEvent.Membership, onJoinChange);
  joinClient = c;
  joinRevs.clear();
  probeRooms.clear();
  c?.on(RoomMemberEvent.Membership, onJoinChange);
}
// a probed membership arrived (memberprobe.ts): every roster re-reads (rare: once per unknown caller), one notify
onMemberProbe(() => {
  for (const id of new Set([...joinRevs.keys(), ...probeRooms])) bumpJoins(id, false);
  for (const f of joinSubs) f();
});
const probeRooms = new Set<string>();
const subscribeJoins = (f: () => void) => {
  joinSubs.add(f);
  return () => void joinSubs.delete(f);
};

/** Bare mxids with a live call membership in the room (arrival order), minus the recorder and anyone no longer joined
 *  to the room (callrules.rosterCounts). */
export function useCallParticipants(roomId: string | null | undefined): string[] {
  watchJoins();
  const joinRev = useSyncExternalStore(subscribeJoins, () => joinRevs.get(roomId ?? "") ?? 0);
  const a = useRoomStateEvents<MemberContent>(roomId, MEMBER_TYPES[0]);
  const b = useRoomStateEvents<MemberContent>(roomId, MEMBER_TYPES[1]);
  const c = useRoomStateEvents<MemberContent>(roomId, MEMBER_TYPES[2]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(iv);
  }, []);
  // GPU.md §2.8 (D6): the same array while nobody joined / left / expired, so the 30 s expiry re-read re-renders nothing
  const prev = useRef<string[]>([]);
  return useMemo(() => {
    if (roomId) probeRooms.add(roomId);
    // a caller with no member event here (lazy loading) is probed once (memberprobe.ts) and counts until the answer
    const all = [...a, ...b, ...c].filter((e) => live(e.content, e.ts, now) && rosterCounts(roomId ? callerMembership(roomId, e.sender) : undefined)).sort((x, y) => (x.content.created_ts ?? x.ts) - (y.content.created_ts ?? y.ts));
    const out: string[] = [];
    for (const e of all) if (!out.includes(e.sender) && !isRecorder(e.sender)) out.push(e.sender);
    if (out.length === prev.current.length && out.every((x, i) => x === prev.current[i])) return prev.current;
    prev.current = out;
    return out;
  }, [a, b, c, now, joinRev, roomId]);
}

function displayName(roomId: string, mxid: string): string {
  const r = peekClient()?.getRoom(roomId);
  const m = r?.getMember(mxid);
  return m?.name || mxid.replace(/^@/, "").split(":")[0];
}

export function joinBannerText(roomId: string, parts: string[]): string {
  const n = parts.map((p) => displayName(roomId, p));
  if (n.length === 0) return "There's a call going on in this room";
  if (n.length === 1) return `${n[0]} is in a call`;
  if (n.length === 2) return `${n[0]} and ${n[1]} are in a call`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]} are in a call`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others are in a call`;
}

// The join banner is rendered by chat's RoomPage via CallHeaderChips; CallStage falls back to
// drawing it itself when no CallHeaderChips is mounted for the room (count per room id).
const mounted = new Map<string, number>();
const listeners = new Set<() => void>();
export function headerChipsMounted(roomId: string): boolean {
  return (mounted.get(roomId) ?? 0) > 0;
}
function subscribeChips(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export function useHeaderChipsMounted(roomId: string): boolean {
  return useSyncExternalStore(subscribeChips, () => headerChipsMounted(roomId));
}

/** CallHeaderChips — "<a> is in a call · Join" (CUI-149). */
export function CallHeaderChips({ roomId }: { roomId: string }) {
  useEffect(() => {
    mounted.set(roomId, (mounted.get(roomId) ?? 0) + 1);
    listeners.forEach((f) => f());
    return () => {
      mounted.set(roomId, Math.max(0, (mounted.get(roomId) ?? 1) - 1));
      listeners.forEach((f) => f());
    };
  }, [roomId]);
  // a Tin Hat app's native call in this room: "You're in this call on this phone" instead (features/native)
  return (
    <OnThisPhone roomId={roomId}>
      <JoinBanner roomId={roomId} />
    </OnThisPhone>
  );
}

export function JoinBanner({ roomId }: { roomId: string }) {
  const parts = useCallParticipants(roomId);
  const inCall = useC("inCall");
  const connecting = useC("connecting");
  const callRoom = useC("callRoomId");
  const fake = useC("fake");
  const me = peekClient()?.getUserId() ?? "";
  const others = parts.filter((p) => p !== me || callRoom !== roomId);
  const joining = connecting && callRoom === roomId;
  // Pad (features/pad): one of my other devices is in this call → "You're in this call on <device>" + Pad beside Join
  const pad = usePadTargets(roomId);
  const padT = pickTarget(pad);
  const padDev = useDeviceName(padT?.device ?? "");
  // Main.qml:5249 — hidden while we're in (or joining) any call; the incoming card offers Switch.
  if (fake || inCall || (connecting && !joining) || parts.length === 0) return null;
  const text = padT ? padCallText(padDev, parts.filter((p) => p !== me).map((p) => displayName(roomId, p))) : joinBannerText(roomId, others);
  return (
    <div className={s.banner} data-testid="join-banner">
      <span className={s.bannerText}>{text}</span>
      {padT && <PadButton roomId={roomId} targets={pad} />}
      <GlowButton text={joining ? "Joining…" : "Join"} busy={joining} disabled={connecting} onClick={() => act("joinCall")(roomId)} />
    </div>
  );
}

// ---- incoming call cards (r.overlays) ----------------------------------------------------------

export function IncomingCallCards() {
  const calls = useC("incomingCalls");
  const inCall = useC("inCall");
  const mobile = useIsMobile();
  // the ring follows REAL focus (10.8.1): it rings while another window has the focus, whatever the render state
  const win = useRealWinState();
  const reduced = useReducedMotion();
  const arrived = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  // CUI-145/147: each new card rings (a single notify blip when already in a call) for at most 25 s.
  // The desktop notification is posted by the calls engine only (callwatch.ts, tag incoming-call:<roomId>,
  // INTEGRATION item 8 — one notification per call). The ring stops on Join/Switch, when the last card goes, or when its call ends. The shared
  // core ring element makes a second start (engine CALL-119) a harmless restart.
  useEffect(() => {
    const now = Date.now();
    let fresh = false;
    for (const c of calls)
      if (!arrived.current.has(c.roomId)) {
        arrived.current.set(c.roomId, now);
        fresh = true;
      }
    for (const k of [...arrived.current.keys()]) if (!calls.some((c) => c.roomId === k)) arrived.current.delete(k);
    if (!calls.length) {
      stopRing();
      return;
    }
    if (fresh) {
      if (getC().inCall) playUiSound("notify");
      else startRing();
      tick((n) => n + 1); // the visual ring below reads `arrived`
    }
    // the ring ends 25 s after the NEWEST card arrived (not re-armed by unrelated list updates)
    const newest = Math.max(...[...arrived.current.values()]);
    const t = window.setTimeout(() => {
      stopRing();
      tick((n) => n + 1);
    }, Math.max(0, newest + 25000 - Date.now()));
    return () => window.clearTimeout(t);
  }, [calls]);
  useEffect(() => () => stopRing(), []);
  // GPU.md §2.3 — the visual ring: while `ring` (the window is unfocused, no reduce motion, < 25 s since the card
  // arrived) the pulse layer blinks in two states at 2 Hz (4 steps/s) from ONE 250 ms timer for all cards (it was a
  // refresh-rate 1.8 s fade). Focused: static (the card's entrance is a normal transition); hidden: nothing runs,
  // not even this timer — the OS notification and the ring sound carry the alert; reduce motion: the static glow.
  const now = Date.now();
  const ringing = (roomId: string) => ringOn(arrived.current.get(roomId) ?? null, now, win, reduced);
  const anyRing = calls.some((c) => ringing(c.roomId));
  useEffect(() => {
    if (!anyRing) return;
    const iv = window.setInterval(() => tick((n) => n + 1), RING_STEP_MS);
    return () => window.clearInterval(iv);
  }, [anyRing]);
  if (!calls.length) return null;
  // Portalled into the overlay layer: the shell is its own stacking context, so a card rendered inside it
  // sat under every modal sheet's scrim (unclickable Join). Native: Overlay z 1000, above every page and window.
  return (
    <OverlayPortal>
    <div className={`${s.host} ${mobile ? s.hostMobile : ""}`} role="region" aria-label="Incoming calls">
      {calls.map((c) => {
        const since = arrived.current.get(c.roomId) ?? now;
        const glow = ringing(c.roomId) ? (ringHigh(since, now) ? RING_OPACITY.high : RING_OPACITY.low) : RING_OPACITY.rest;
        return (
          <div key={c.roomId} className={s.card} data-testid="incoming-card">
            <div className={s.pulse} style={{ opacity: glow }} data-ring={ringing(c.roomId) ? "on" : "off"} />
            <Icon name="call-start-symbolic" size={32} color="var(--th-call-incoming-icon)" />
            <div className={s.texts}>
              <div className={s.title}>Incoming call · {c.roomName}</div>
              <div className={s.sub}>
                {c.who ? `${c.who} started a call` : "Someone started a call"}
                {inCall ? " — you're in another call" : ""}
              </div>
            </div>
            <GlowButton
              icon="call-start-symbolic"
              text={inCall ? "Switch" : "Join"}
              onClick={() => {
                stopRing();
                act("dismissIncoming")(c.roomId);
                openRoom(c.roomId);
                act("switchCall")(c.roomId);
              }}
            />
            <ToolButton iconName="window-close-symbolic" tip="Dismiss" aria-label="Dismiss" onClick={() => act("dismissIncoming")(c.roomId)} />
          </div>
        );
      })}
    </div>
    </OverlayPortal>
  );
}

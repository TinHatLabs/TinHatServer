// callinfo.ts — what the nav reads from the calls engine (spec §4 end, §7.1): the live SFU roster of
// the call we are IN (the in-call row shows it instead of membership state), game-chat and
// corner ("aside") state, server mutes, and the local per-person mutes (AudioPrefs.mutedFor).
// Read through `useCall` from "@/features/calls" against the CallStore contract
// (src/features/calls/contract.ts). Every field is optional-chained: the phase-1 stub store has
// only the UI block, so the nav degrades to membership-state rosters until integration.
import { useEffect, useRef } from "react";
import { getClient, peekClient } from "@/core/matrix";
import { usePref } from "@/core/prefs";
import { useCall } from "@/features/calls";
import type { CallStore as ContractStore } from "@/features/calls/contract";
import { scheduleRefresh, setLiveRoster, type Participant } from "./model";

const AUDIO_PREFS_DEF: Record<string, never> = {};

type Partial2 = Partial<ContractStore>;

/** identity "@u:server:DEVICE" → "@u:server" */
export const mxidOf = (identity: string) => {
  if (!identity.startsWith("@")) return identity;
  const parts = identity.split(":");
  return parts.length > 2 ? `${parts[0]}:${parts[1]}` : identity;
};

/** Pushes the live roster of the call we are in to the nav model (always mounted via r.overlays). */
export function CallRosterBridge() {
  const inCall = useCall((c) => !!(c as Partial2).inCall || !!c.joined);
  const roomId = useCall((c) => (c as Partial2).callRoomId || c.roomId || "");
  const tiles = useCall((c) => (c as Partial2).tiles);
  // after you leave a call, 3 more full refreshes 2.5 s apart — the membership withdrawal needs a
  // sync round-trip to clear your own bubble (qml/AppCore.qml, spec §3.1)
  const wasIn = useRef(false);
  useEffect(() => {
    if (wasIn.current && !inCall) {
      const ts = [1, 2, 3].map((i) => window.setTimeout(() => scheduleRefresh(), 2500 * i));
      wasIn.current = false;
      return () => ts.forEach((x) => window.clearTimeout(x));
    }
    wasIn.current = inCall;
  }, [inCall]);
  useEffect(() => {
    if (!inCall || !roomId || !tiles || tiles.length === 0) {
      setLiveRoster(null);
      return;
    }
    const me = peekClient()?.getUserId() ?? "";
    const room = peekClient()?.getRoom(roomId);
    const seen = new Set<string>();
    const users: Participant[] = [];
    const push = (mxid: string, name: string, avatar: string) => {
      if (!mxid || seen.has(mxid)) return;
      seen.add(mxid);
      users.push({ mxid, name: name || room?.getMember(mxid)?.name || mxid, avatar: avatar || room?.getMember(mxid)?.getMxcAvatarUrl() || "" });
    };
    // yourself first
    push(me, room?.getMember(me)?.name ?? "", room?.getMember(me)?.getMxcAvatarUrl() ?? "");
    for (const t of tiles) {
      // the self tile ("You" / vid_selfview + our own screen share) is added by hand above. The Memories
      // recorder STAYS when it has a tile, like native AppCore.liveCallParts ("its visible membership +
      // call tile are the consent story", room.rs VOD_BOT_MXID)
      if (t.participant === "You" || t.id === "vid_selfview" || t.id === "vid_selfshare") continue;
      const id = mxidOf(t.participant);
      if (id === me) continue;
      push(id, t.kind === "screenshare" ? "" : t.name, "");
    }
    setLiveRoster({ roomId, users });
  }, [inCall, roomId, tiles]);
  return null;
}

export interface PartGlyphs {
  mutedByMe: boolean;
  serverMutedBy: string;
  gameChat: boolean;
  /** I am in the game chat too (tooltip wording) */
  gameChatMe: boolean;
  aside: "" | "with-you" | "pulled";
}

/** Per-participant glyph state for the strip (NAV-42). */
export function usePartGlyphs(roomId: string, mxid: string): PartGlyphs {
  // the per-person mutes live in the calls engine's `audio_prefs` pref, not in the call store — a
  // local mute from the volume menu must re-render the glyph (the store's `mutedFor` never changes)
  usePref("audio_prefs", AUDIO_PREFS_DEF);
  const inThisCall = useCall((c) => ((c as Partial2).inCall || c.joined) && ((c as Partial2).callRoomId || c.roomId) === roomId);
  const mutedByMe = useCall((c) => {
    const f = (c as Partial2).mutedFor;
    if (!inThisCall || typeof f !== "function") return false;
    // the contract keys per-person audio by LiveKit identity ("@u:server:DEVICE"); native AudioPrefs
    // by mxid — ask for both
    const ids = [mxid, ...((c as Partial2).tiles ?? []).filter((x) => mxidOf(x.participant) === mxid).map((x) => x.participant)];
    try {
      return ids.some((id) => f(id, "mic") || f(id, "screenshare") || f(id, "music"));
    } catch {
      return false;
    }
  });
  const serverMutedBy = useCall((c) => {
    if (!inThisCall) return "";
    const t = (c as Partial2).tiles?.find((x) => mxidOf(x.participant) === mxid && x.serverMuted);
    return t ? t.serverMutedBy || "a moderator" : "";
  });
  const gameChat = useCall((c) => !!inThisCall && !!(c as Partial2).gameChatPeers?.peers?.some((p) => mxidOf(p) === mxid));
  const gameChatMe = useCall((c) => !!(c as Partial2).gameChatPeers?.me || !!(c as Partial2).gameChat);
  const aside = useCall((c) => {
    const k = (c as Partial2).corner;
    if (!inThisCall || !k || !k.active) return "" as const;
    const me = peekClient()?.getUserId() ?? "";
    if (mxid === me) return "" as const;
    const inMine = (k.members ?? []).some((m) => mxidOf(m) === mxid);
    if (inMine && k.mine) return "with-you" as const;
    const elsewhere = Object.entries(k.corners ?? {}).some(([cid, mem]) => cid !== k.mine && (mem ?? []).some((m) => mxidOf(m) === mxid));
    return elsewhere ? ("pulled" as const) : ("" as const);
  });
  return { mutedByMe, serverMutedBy: serverMutedBy ? displayName(roomId, serverMutedBy) : "", gameChat, gameChatMe, aside };
}

function displayName(roomId: string, who: string): string {
  if (!who.startsWith("@")) return who;
  try {
    return getClient().getRoom(roomId)?.getMember(mxidOf(who))?.name ?? who;
  } catch {
    return who;
  }
}

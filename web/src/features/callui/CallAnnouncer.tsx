// CallAnnouncer.tsx — accessibility round 2 (M3): the call says what happens to a screen reader (the desktop's
// AppCore.qml callAnnouncer, same rules: features/calls/callannounce.ts). Rendered once (r.overlays), draws nothing:
//   - the call's own state: joining, in, reconnecting (urgent), failed (urgent, the banner's words), left
//   - people joining / leaving the call I am in (polite, batched over ROSTER_BATCH_MS; nothing in the first
//     ROSTER_ARM_MS after I got in — those are the people already there, as for the join chime; a second device of
//     the same person neither joins nor leaves them)
// The incoming-call card says itself (Incoming.tsx). The words go through @/ui announce (LiveRegions in App.tsx).
import { useEffect } from "react";
import { announce } from "@/ui/announce";
import { peekClient } from "@/core/matrix";
import { onCallRoster } from "@/features/calls";
import { ROSTER_ARM_MS, ROSTER_BATCH_MS, callPhase, phaseAnnouncement, rosterAnnouncement, type CallFlags } from "@/features/calls/callannounce";
import { callStore, getC } from "./store";

function flags(): CallFlags {
  const c = getC();
  return { inCall: !!c.inCall, connecting: !!c.connecting, reconnecting: !!c.reconnecting, callFailed: !!c.callFailed, failReason: c.failReason ?? "", removedBy: c.removedBy ?? "" };
}

function roomName(roomId: string): string {
  return (roomId && peekClient()?.getRoom(roomId)?.name) || "";
}

function personName(roomId: string, mxid: string): string {
  const m = peekClient()?.getRoom(roomId)?.getMember(mxid);
  return m?.name || mxid.replace(/^@/, "").split(":")[0];
}

export function CallAnnouncer() {
  useEffect(() => {
    let prev = flags();
    let inSince = callPhase(prev) === "in" ? Date.now() : 0;
    // one entry per PERSON (mxid; two people with the same name are two), named when the batch is read
    let joined: Array<[string, string]> = [];
    let left: Array<[string, string]> = [];
    let batch = 0;
    const flush = () => {
      batch = 0;
      const a = rosterAnnouncement(joined.map(([r, m]) => personName(r, m)), left.map(([r, m]) => personName(r, m)));
      joined = [];
      left = [];
      if (a) announce(a.text, { urgent: a.urgent });
    };
    const offStore = callStore.subscribe(() => {
      const next = flags();
      const a = phaseAnnouncement(prev, next, roomName(getC().callRoomId ?? ""));
      const was = callPhase(prev);
      const now = callPhase(next);
      prev = next;
      if (now === "in" && was !== "in" && was !== "reconnecting") inSince = Date.now();
      if (now !== "in" && now !== "reconnecting") {
        inSince = 0;
        joined = [];
        left = [];
        window.clearTimeout(batch);
        batch = 0;
      }
      if (a) announce(a.text, { urgent: a.urgent });
    });
    const offRoster = onCallRoster((kind, mxid, roomId, stillHere) => {
      if (stillHere || inSince === 0 || Date.now() < inSince + ROSTER_ARM_MS) return;
      const me = peekClient()?.getUserId();
      if (mxid === me) return; // my own other device (Pad) is not "someone joined"
      const list = kind === "join" ? joined : left;
      if (!list.some(([, m]) => m === mxid)) list.push([roomId, mxid]);
      if (!batch) batch = window.setTimeout(flush, ROSTER_BATCH_MS);
    });
    return () => {
      offStore();
      offRoster();
      window.clearTimeout(batch);
    };
  }, []);
  return null;
}

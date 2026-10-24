// afk.ts — BRB / away (native afk_ctl.rs, AppCore.qml:1757-1800).
//   setAfk(on): intent first (localAfk), then `dev.tinhat.afk {away, ts}` (state_key = my mxid)
//   rising edge: mute the mic if live (remember that we did), camera off, incoming audio cut, remote
//   video paused; falling edge: cut off, unmute only if BRB muted it, camera stays off.
//   awayUsers = users with away:true ∩ people in the call (reacting to state events, not polling).
import { RoomStateEvent, type MatrixEvent } from "matrix-js-sdk";
import { ensureWritable, getStateAll, onClientChanged, peekClient, sendState } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { getCall, patch, useCallStore } from "./store";
import { sess } from "./session";
import { forceMicMuted, hooks, reconcileVideo, toggleCamera } from "./engine";
import * as audio from "./audio";
import { AFK_TYPE, errText, isRecorder, mxidOf } from "./util";

const log = createLogger("call-afk");

let afkMutedMic = false;

let writeChain: Promise<unknown> = Promise.resolve(); // BRB on/off writes land in order

export function setAfk(on: boolean): void {
  const st = getCall();
  const roomId = st.callRoomId;
  // In a call only: a join clears BRB intent when it goes live, so BRB while connecting would be lost.
  if (!roomId || !st.inCall) return;
  if (st.localAfk === on) return;
  patch({ localAfk: on });
  if (on) {
    afkMutedMic = !st.micMuted;
    if (afkMutedMic) forceMicMuted(true);
    if (st.cameraOn) toggleCamera();
  } else {
    if (afkMutedMic) forceMicMuted(false);
    afkMutedMic = false;
  }
  audio.reapply();
  reconcileVideo();
  const me = peekClient()?.getUserId();
  if (!me) return;
  const ts = Date.now();
  writeChain = writeChain.then(async () => {
    try {
      await ensureWritable(roomId, [AFK_TYPE]);
      await sendState(roomId, AFK_TYPE, me, { away: on, ts });
    } catch (e) {
      log.warn(`BRB state write failed (room not provisioned?): ${errText(e)}`);
    }
  });
}

function recomputeAway() {
  const s = sess();
  const st = getCall();
  if (!s || !st.callRoomId) {
    if (st.awayUsers.length) patch({ awayUsers: [] });
    return;
  }
  const inCall = new Set([...s.room.remoteParticipants.keys()].filter((i) => !isRecorder(i)).map(mxidOf));
  const away: string[] = [];
  for (const e of getStateAll<{ away?: boolean }>(st.callRoomId, AFK_TYPE)) {
    if (e.content?.away === true && e.stateKey === e.sender && inCall.has(e.stateKey)) away.push(e.stateKey);
  }
  away.sort();
  if (away.join("|") !== st.awayUsers.join("|")) patch({ awayUsers: away });
}

let attached: ReturnType<typeof peekClient> = null;
function onState(ev: MatrixEvent) {
  if (ev.getType() !== AFK_TYPE) return;
  if (ev.getRoomId() !== getCall().callRoomId) return;
  recomputeAway();
}

export function installAfk(): void {
  const attach = () => {
    const c = peekClient();
    if (c === attached) return;
    attached?.off(RoomStateEvent.Events, onState);
    attached = c;
    c?.on(RoomStateEvent.Events, onState);
  };
  attach();
  onClientChanged(attach);
  // The user toggling the mic while away owns it from then on: coming back must not unmute it.
  hooks.onUserMicToggle.push(() => {
    if (getCall().localAfk) afkMutedMic = false;
  });
  hooks.onParticipantJoined.push(() => recomputeAway());
  hooks.onParticipantLeft.push(() => recomputeAway());
  hooks.onConnected.push(() => {
    afkMutedMic = false;
    recomputeAway();
  });
  hooks.onTeardown.push(() => {
    afkMutedMic = false;
    patch({ localAfk: false, awayUsers: [] });
  });
  // Deafen / BRB composition is read by the audio policy on every change.
  useCallStore.subscribe((st, prev) => {
    if (st.deafened !== prev.deafened || st.localAfk !== prev.localAfk) audio.reapply();
  });
}

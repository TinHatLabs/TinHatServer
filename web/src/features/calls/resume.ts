// resume.ts — the call side of "the page is back" (core/lifecycle.ts): an iOS app switch (Safari or the
// home-screen app), a frozen background tab, the back/forward cache, a laptop that slept.
//
// On every return:
//   • sound: resume the call's AudioContext + the "Strong" noise-suppression context + the helper
//     elements; check the context really renders (its clock moves — iOS can say "running" and play
//     nothing); if not, build a fresh one; if the browser still wants a tap → `needsTap: "audio"` (the
//     call UI shows "Tap to resume sound"; any tap anywhere does it too)
//   • the call (engine.afterPageResume): LiveKit handles its own dead socket (reconnect / rejoin /
//     Disconnected → auto-rejoin or "Call ended" + Rejoin); we re-acquire a mic / camera capture iOS ended
//     or left muted (a refusal → `needsTap: "mic"`), refresh the membership + re-send our key after a long
//     absence, and clear flags a frozen page left behind (engine.sweepStuckFlags)
//   • devices: re-list (headphones may have been connected meanwhile)
// Every 3 s while a call runs: the same sound check (cheap: state only) + the stuck-flag sweep.
//
// iOS losing IndexedDB in the background (core/matrix/resume.ts) reloads the page: the call is ended
// first and rejoined after the reload (same room, same mute) if the reload happens within 3 minutes.
import { onPageResume, type ResumeInfo } from "@/core/lifecycle";
import { getSession, onStorageLost, useSessionStore } from "@/core/matrix";
import { createLogger } from "@/core/log";
import * as audio from "./audio";
import * as engine from "./engine";
import { freshNsContext, nsContextState, resumeNsContext } from "./mic";
import { getCall, patch, setStatus } from "./store";
import { sess } from "./session";
import { errText, isRecorder, sleep } from "./util";
import { liveSessions } from "./rtc";

const log = createLogger("call-resume");

const REJOIN_MARK = "tinhat.resume.rejoin";

let checking: Promise<void> | null = null;
let badTicks = 0;
let tapGen = 0; // bumped by every tap: a sound check that started before it has nothing left to say

function callLive(): boolean {
  const st = getCall();
  return st.inCall || st.connecting;
}

async function onResume(info: ResumeInfo) {
  audio.kickPlayback();
  resumeNsContext();
  engine.sweepStuckFlags();
  if (!callLive()) {
    if (getCall().needsTap) patch({ needsTap: "" });
    // A leave whose tombstone couldn't land (offline / suspended longer than the membership watch keeps
    // retrying) would leave a ghost of us in that call for hours: once the sync has caught up, sweep our
    // own live memberships (idle only, and never one another tab of this device is in a call with).
    if (info.suspect) setTimeout(() => engine.sweepGhosts(), 8000);
    return;
  }
  void engine.refreshInputs();
  void engine.refreshOutputs();
  await Promise.all([engine.afterPageResume(info).catch((e: unknown) => log.warn(`afterPageResume: ${errText(e)}`)), checkSound("after the return")]);
}

/** Is the call's sound actually playing? Resume → rebuild → ask for a tap, in that order. */
function checkSound(why: string): Promise<void> {
  if (checking) return checking;
  const gen = tapGen;
  checking = (async () => {
    try {
      if (!callLive()) return;
      let ok = await audio.contextRendering();
      if (ok === false) {
        audio.kickPlayback();
        await sleep(600);
        ok = await audio.contextRendering();
      }
      if (gen !== tapGen) return;
      if (ok === false && callLive()) {
        // A fresh context starts without a tap where the browser remembers an earlier one (desktop
        // browsers); where it doesn't (iOS), it waits for the tap like the old one did.
        audio.recreateContext(`${why}: the old one stopped rendering`); // (the engine re-taps the mic)
        ok = await audio.contextRendering();
      }
      if (gen !== tapGen) return;
      const nsStuck = getCall().micNsMode === "strong" && nsContextState() !== "running" && nsContextState() !== "none";
      const want = ok === false || nsStuck ? "audio" : "";
      const cur = getCall().needsTap;
      if (want && cur !== "mic" && cur !== want) {
        log.warn(`[sound] ${ok === false ? `the call's audio context isn't playing (${audio.contextState()})` : "the noise-suppression context isn't running"} — asking for a tap`);
        patch({ needsTap: "audio" });
      } else if (!want && cur === "audio") patch({ needsTap: "" });
    } finally {
      checking = null;
    }
  })();
  return checking;
}

let lastTap = 0;

/** The tap: runs INSIDE the click / touch (iOS starts audio and capture only there). */
export function resumeFromTap(): void {
  if (Date.now() - lastTap < 1500) {
    // A later event of the same tap (touchend → click, the pill's own onClick): if the first one — which
    // did the work below — didn't count as a user gesture to the browser, these may. Resuming is
    // idempotent, so let each of them try to start what the first one created.
    audio.kickPlayback();
    resumeNsContext();
    return;
  }
  lastTap = Date.now();
  tapGen++;
  const need = getCall().needsTap;
  if (need === "audio" || (audio.contextState() !== "running" && audio.contextState() !== "none")) {
    audio.recreateContext("tap to resume"); // made inside the tap: allowed to play (the engine re-taps the mic)
  } else audio.kickPlayback();
  let reacquire = need === "mic" || engine.micNeedsReacquire();
  const ns = nsContextState();
  if (getCall().micNsMode === "strong" && ns !== "running" && ns !== "none") {
    // "Strong" sends the mic through its own context: a new one inside the tap, then a capture built in it
    freshNsContext();
    reacquire = true;
  } else resumeNsContext();
  // The pill stays until the mic really is back: a refused capture asks again.
  patch({ needsTap: reacquire ? "mic" : "" });
  if (reacquire) {
    const s0 = sess();
    void engine.reconnectMic().then((ok) => {
      const st = getCall();
      if (!(st.inCall || st.connecting) || sess() !== s0) return; // (another call by now: not ours to judge)
      if (ok) {
        if (st.needsTap === "mic") patch({ needsTap: "" });
      } else if (!st.needsTap) patch({ needsTap: "mic" });
    });
  }
  log.info(`tap to resume (${need || "no request"}) — context ${audio.contextState()}${reacquire ? ", re-acquiring the mic" : ""}`);
  setTimeout(() => void checkSound("after the tap"), 1000);
}

function onGesture() {
  if (getCall().needsTap) resumeFromTap();
  // (the tap's first event already cleared the request: its later events still get their try — see above)
  else if (Date.now() - lastTap < 1500) resumeFromTap();
}

function tick() {
  engine.sweepStuckFlags();
  if (!callLive()) {
    badTicks = 0;
    if (getCall().needsTap) patch({ needsTap: "" });
    return;
  }
  // the mic came back by itself (livekit's own re-acquire, a later automatic retry): no tap needed
  if (getCall().needsTap === "mic" && !engine.micNeedsReacquire()) patch({ needsTap: "" });
  const st = audio.contextState();
  if (st === "running" || st === "none") {
    badTicks = 0;
    if (getCall().needsTap === "audio" && !(getCall().micNsMode === "strong" && nsContextState() !== "running" && nsContextState() !== "none")) patch({ needsTap: "" });
    return;
  }
  audio.kickPlayback();
  if (++badTicks >= 2) void checkSound("sound check");
}

// ---- reload after IndexedDB was lost (core/matrix/resume.ts) ------------------------------------------------

async function beforeReload() {
  const st = getCall();
  if (!(st.inCall || st.connecting || st.reconnecting) || !st.callRoomId) return;
  // (were other people in it? if they all leave during the reload, the rejoin must not restart the call)
  const withOthers = othersInCall(st.callRoomId).length > 0;
  try {
    sessionStorage.setItem(REJOIN_MARK, JSON.stringify({ roomId: st.callRoomId, muted: st.micMuted, at: Date.now(), user: getSession().userId ?? "", withOthers }));
  } catch {
    /* no sessionStorage: no rejoin */
  }
  await engine.endCallForSessionLoss("storage-lost");
}

function maybeRejoinAfterReload() {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(REJOIN_MARK);
    sessionStorage.removeItem(REJOIN_MARK);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const m = JSON.parse(raw) as { roomId?: string; muted?: boolean; at?: number; user?: string; withOthers?: boolean };
    if (!m.roomId || !m.at || Date.now() - m.at > 180_000 || m.user !== getSession().userId) return;
    // Everyone we were with left while the page reloaded: joining now would START a new call in that room
    // (and ring everyone in it) that nobody asked for. (Alone in it before — waiting for people — we go back.)
    const others = othersInCall(m.roomId);
    log.info(`after the reload: ${m.roomId} had others in its call: ${!!m.withOthers}; now: ${others.map((x) => `${x.sender}/${x.deviceId}`).join(", ") || "nobody"}`);
    if (m.withOthers && others.length === 0) {
      log.info(`not rejoining ${m.roomId} after the reload: everyone left its call meanwhile`);
      setStatus("Your call ended while Tin Hat was reconnecting");
      return;
    }
    setStatus("Rejoining your call after reconnecting…");
    engine.rejoinAfterReload(m.roomId, !!m.muted);
  } catch {
    /* ignore */
  }
}

/** Other people's live memberships in a room's call (not this device, not the recorder). */
function othersInCall(roomId: string) {
  const me = getSession().userId;
  const dev = getSession().deviceId;
  return liveSessions(roomId).filter((x) => !(x.sender === me && x.deviceId === dev) && !isRecorder(`${x.sender}:${x.deviceId}`));
}

let installed = false;
export function installCallResume(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  onPageResume((info) => void onResume(info));
  // Only events that are a user gesture in every engine (WebKit: touchend / click / keydown). pointerup comes
  // FIRST in a tap: if it did the work outside a gesture, the pill it cleared was gone before the click —
  // no event of that tap started the sound (reproduced with tools/ios-resume-e2e.mjs --strict-gesture).
  for (const ev of ["touchend", "click", "keydown"]) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  setInterval(tick, 3000);
  onStorageLost(beforeReload);
  const s0 = useSessionStore.getState();
  if (s0.liveSyncDone) maybeRejoinAfterReload();
  else {
    const off = useSessionStore.subscribe((s) => {
      if (!s.liveSyncDone) return;
      off();
      maybeRejoinAfterReload();
    });
  }
}

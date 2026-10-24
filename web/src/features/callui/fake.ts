// fake.ts — the fake call (native TINHAT_GUI_FAKECALL, AppCore.qml:66-81): fills the call store with
// placeholder tiles so the call UI can be captured / compared without joining a live call.
// Activated ONLY by `?fakecall=1` in the URL (search or hash query) — never otherwise.
// Extra demo states for QA: `&fakedemo=a,b,…` with any of
//   gamechat corner sound afk reconnecting failed removed connecting servermuted hear rec share
//   muted deafened speaking cam many portrait incoming health pip twoshares reconly video
import type { CallActions, CallCategory, CallState, CallStore, Tile } from "@/features/calls/contract";
import { callStore, DEFAULTS } from "./store";
import { openPip } from "./Pip";

function urlParam(name: string): string | null {
  const s = new URLSearchParams(location.search).get(name);
  if (s !== null) return s;
  const h = location.hash;
  const q = h.indexOf("?");
  if (q >= 0) return new URLSearchParams(h.slice(q + 1)).get(name);
  return null;
}

export function fakeCallRequested(): boolean {
  const v = urlParam("fakecall");
  return v === "1" || v === "true";
}

export function fakeDemos(): Set<string> {
  return new Set((urlParam("fakedemo") || "").split(",").map((s) => s.trim()).filter(Boolean));
}

const tile = (p: Partial<Tile> & { id: string; participant: string }): Tile =>
  ({ kind: "video", name: "", screenshare: false, muted: false, avatar: "", serverMuted: false, serverMutedBy: "", ...p }) as Tile;

let installed = false;

const FAKE_INCOMING = { roomId: "!fake:example.com", roomName: "Game night", who: "morgan" };
let fakeIncomingDismissed = false;

export function installFakeCall(): void {
  if (installed || !fakeCallRequested()) return;
  installed = true;
  const demo = fakeDemos();
  const tiles: Tile[] = [
    tile({ id: "vid_selfview", participant: "You", kind: demo.has("cam") ? "video" : "video" }),
    tile({ id: "fake_morgan", participant: "@morgan:example.com", ...({ vidW: 640, vidH: 480 } as object) }),
    tile({ id: "fake_sam", participant: "@sam:example.com", ...({ vidW: 1280, vidH: 720 } as object) }),
  ];
  if (!demo.has("noshare"))
    tiles.push(tile({ id: "fake_share", participant: "@morgan:example.com", kind: "screenshare", screenshare: true }));
  if (demo.has("twoshares") || demo.has("reconly")) {
    // a second share: sam's (unwatched → "not listening" pill); with reconly it is a tuned-in
    // recording-only share (→ "● recording-only · tuned in · Leave")
    tiles.push(tile({ id: "fake_share2", participant: "@sam:example.com", kind: "screenshare", screenshare: true, recordingOnly: demo.has("reconly"), tunedIn: demo.has("reconly") }));
  }
  if (demo.has("many")) {
    for (const n of ["alex", "jordan", "riley", "casey", "kai", "noa"])
      tiles.push(tile({ id: `avatar_@${n}:example.com:DEV`, participant: `@${n}:example.com:DEV`, kind: "avatar", muted: n === "jordan" }));
  }
  if (demo.has("servermuted")) {
    tiles[2] = { ...tiles[2], serverMuted: true, serverMutedBy: "morgan", muted: true };
  }
  const vols = new Map<string, { v: number; m: boolean }>();
  const volKey = (id: string, c: CallCategory) => `${c}_${id.replace(/:[^:]*$/, "") || id}`;

  const set = (p: Partial<CallState>) => callStore.setState(p as Partial<CallStore>);
  const get = () => callStore.getState() as CallStore;
  const status = (s: string) => set({ status: s, statusRev: (get().statusRev ?? 0) + 1 });

  // `fakedemo=video`: canvas streams on the camera tiles (a moving test card at the tile's natural size) so
  // real frames exercise the video geometry, zoom pill and fill/fit modes.
  const streams = new Map<string, MediaStream>();
  const fakeStream = (id: string, w: number, h: number, hue: number): MediaStream => {
    const have = streams.get(id);
    if (have) return have;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d")!;
    let f = 0;
    window.setInterval(() => {
      f++;
      g.fillStyle = `hsl(${hue},45%,22%)`;
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#fff";
      g.lineWidth = Math.max(2, w / 160);
      g.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
      g.fillStyle = "#fff";
      g.font = `bold ${Math.round(h / 8)}px sans-serif`;
      g.textAlign = "center";
      g.fillText(`${w}×${h}`, w / 2, h / 2);
      g.beginPath();
      g.arc(w / 2 + Math.cos(f / 10) * w * 0.3, h * 0.75, h / 20, 0, Math.PI * 2);
      g.fill();
    }, 66);
    const ms = cv.captureStream(15);
    streams.set(id, ms);
    return ms;
  };
  const actions: Partial<CallActions> = {
    attachVideo: demo.has("video")
      ? (id, el) => {
          if (!el) return;
          const t = get().tiles.find((x) => x.id === id) as (Tile & { vidW?: number; vidH?: number }) | undefined;
          if (!t?.vidW || !t.vidH) return;
          el.srcObject = fakeStream(id, t.vidW, t.vidH, id.length * 47);
          void el.play().catch(() => undefined);
        }
      : undefined,
    joinCall: () => set({ inCall: true, connecting: false, callFailed: false, reconnecting: false }),
    switchCall: () => undefined,
    leaveCall: () => {
      set({ hangingUp: true });
      setTimeout(() => {
        set({ inCall: false, hangingUp: false });
        callStore.setState({ shown: false, fake: false, joined: false, maximized: false } as Partial<CallStore>);
        status("Left call");
      }, 600);
    },
    toggleMic: () => set({ micMuted: !get().micMuted }),
    forceMicMuted: (m) => set({ micMuted: m }),
    applyPushToTalk: (on) => set({ pushToTalk: on }),
    pttHold: (d) => set({ pttSpeaking: d && get().pushToTalk }),
    applyDeafen: (on) => set({ deafened: on }),
    toggleCamera: () => {
      const on = !get().cameraOn;
      set({ cameraOn: on });
      status(on ? "Camera on" : "Camera off");
    },
    shareScreen: (o) => {
      set({ sharing: true, shareRecOnly: !!o?.recordingOnly });
      status("Sharing screen");
    },
    stopScreen: () => set({ sharing: false, shareRecOnly: false }),
    startMusicSource: () => set({ musicPlaying: true }),
    startMusic: () => set({ musicPlaying: true }),
    stopMusic: () => set({ musicPlaying: false }),
    stopSound: () => set({ soundPlaying: false }),
    applyMicAec: (on) => set({ micAec: on }),
    applyMicAgc: (on) => set({ micAgc: on }),
    applyMicNsMode: (m) => set({ micNsMode: m }),
    applyGameChat: (on) => set({ gameChat: on, gameChatPeers: { me: on, peers: on ? ["@morgan:example.com:FAKE"] : [], muted: [] } }),
    leaveCorner: () => set({ corner: { mine: "", active: false, members: [], corners: {} } }),
    pullAside: (id) => {
      set({ corner: { mine: "c1", active: true, members: [id], corners: { c1: ["You", id] } } });
      return "";
    },
    joinCorner: () => "",
    setAfk: (on) => set({ localAfk: on, micMuted: on ? true : get().micMuted, cameraOn: on ? false : get().cameraOn }),
    applyShareRecordingOnly: (on) => set({ shareRecOnly: on }),
    tileQuality: () => "auto",
    volumeFor: (id, c) => vols.get(volKey(id, c))?.v ?? 1,
    mutedFor: (id, c) => vols.get(volKey(id, c))?.m ?? false,
    setVolume: (id, c, v) => vols.set(volKey(id, c), { v, m: vols.get(volKey(id, c))?.m ?? false }),
    pushVolume: () => undefined,
    setMuted: (id, c, m) => vols.set(volKey(id, c), { v: vols.get(volKey(id, c))?.v ?? 1, m }),
    serverMute: async () => "",
    serverUnmute: async () => "",
    disconnectParticipant: async () => "",
    dismissIncoming: (roomId) => {
      if (roomId === FAKE_INCOMING.roomId) fakeIncomingDismissed = true;
      set({ incomingCalls: get().incomingCalls.filter((c) => c.roomId !== roomId) });
    },
  };

  const hear = demo.has("hear")
    ? {
        v: 1,
        on: true,
        me: "@you:example.com:WEB",
        mic: { check: "dead", dev: "Built-in mic" },
        out: { check: "ok", dev: "" },
        mutedTalk: demo.has("mutedtalk"),
        tx: { state: "quiet", why: "" },
        peers: {
          "@sam:example.com:FAKE": { deaf: true, away: false, hearsMe: "ok", notMe: "", iHear: "ok", echo: null },
          "@morgan:example.com:FAKE": { deaf: false, away: false, hearsMe: "waiting", notMe: "nokey", iHear: "stalled", echo: { lag: 180, db: -30 } },
        },
        heard: { ok: 1, total: 2, not: ["morgan"], unconf: [], deaf: ["sam"], pending: [] },
        echoMe: { by: ["morgan"], room: [], lag: 180, db: -30 },
        localEcho: null,
        ecFix: { kind: "turn_on", out: "", label: "" },
      }
    : {};

  const state: Partial<CallStore> = {
    ...DEFAULTS,
    ...(actions as object),
    fake: true,
    shown: true,
    joined: !demo.has("connecting"),
    roomId: null,
    // the room the page was opened on (so the pill / status bar name a real room, like native's fake call)
    callRoomId: decodeURIComponent(/#\/room\/([^/?]+)/.exec(location.hash)?.[1] ?? ""),
    inCall: !demo.has("connecting") && !demo.has("failed") && !demo.has("removed"),
    connecting: demo.has("connecting"),
    reconnecting: demo.has("reconnecting"),
    callFailed: demo.has("failed") || demo.has("removed"),
    failReason: demo.has("failed") ? "couldn't reach the call server. Check your connection and try again." : "",
    removedBy: demo.has("removed") ? "morgan" : "",
    tiles: demo.has("connecting") ? [] : tiles,
    gameChat: demo.has("gamechat"),
    gameChatPeers: demo.has("gamechat") ? { me: true, peers: ["@morgan:example.com"], muted: ["@morgan:example.com"] } : DEFAULTS.gameChatPeers,
    corner: demo.has("corner") ? { mine: "c1", active: true, members: ["@morgan:example.com"], corners: { c1: ["You", "@morgan:example.com"] } } : DEFAULTS.corner,
    soundPlaying: demo.has("sound"),
    localAfk: demo.has("afk"),
    awayUsers: demo.has("afk") ? ["You"] : [],
    serverMuted: demo.has("servermuted"),
    serverMutedBy: demo.has("servermuted") ? "morgan" : "",
    micMuted: demo.has("muted") || demo.has("servermuted") || demo.has("afk"),
    deafened: demo.has("deafened"),
    recActive: demo.has("rec"),
    sharing: demo.has("share"),
    cameraOn: demo.has("cam"),
    hear: hear as CallState["hear"],
    canModerateCall: demo.has("mod"),
    callPerms: { kick: true, ban: true, manage_roles: true, moderate_calls: true },
    inputs: [
      { id: "default", name: "System default" },
      { id: "mic1", name: "Built-in Audio Analog Stereo" },
    ],
    outputs: [
      { id: "default", name: "System default" },
      { id: "spk1", name: "Built-in Audio Analog Stereo" },
    ],
    cameras: [{ id: "cam1", name: "Integrated Camera" }],
    incomingCalls: demo.has("incoming") ? [FAKE_INCOMING] : [],
    publishStats: demo.has("health")
      ? [
          { kind: "mic", enc: "opus", encPick: "opus", rid: "", w: 0, h: 0, fps: 0, targetKbps: 64, sendKbps: 38, qlim: "none", lossPct: 0.2, rttMs: 22, jitterMs: 2, key: 0, nack: 0, pli: 0, active: true, sendKnown: true },
          { kind: "screen", enc: "libvpx", encPick: "vp9", rid: "", w: 1920, h: 1080, fps: 30, targetKbps: 8000, sendKbps: 6100, qlim: "bandwidth", lossPct: 1.4, rttMs: 41, jitterMs: 4, key: 3, nack: 12, pli: 1, active: true, sendKnown: true },
        ]
      : [],
  };
  callStore.setState(state);
  if (demo.has("incoming")) {
    // The real engine's callwatch shares this store and rewrites incomingCalls on every sync, which
    // wiped the demo card; keep it until it is dismissed.
    callStore.subscribe((st) => {
      const cur = ((st as Partial<CallState>).incomingCalls ?? []) as CallState["incomingCalls"];
      if (!fakeIncomingDismissed && !cur.some((c) => c.roomId === FAKE_INCOMING.roomId)) set({ incomingCalls: [...cur, FAKE_INCOMING] });
    });
  }
  if (demo.has("pip")) {
    // the in-app pop-out (Document PiP needs a user gesture, so this shows the fallback panel)
    const t = tiles.find((x) => x.id === "fake_morgan");
    if (t) window.setTimeout(() => openPip(t), 0);
  }

  // levels: morgan talks in bursts; self follows when unmuted (speaking demo)
  let t = 0;
  window.setInterval(() => {
    t += 1;
    const st = get();
    if (!st.fake) return;
    const talk = demo.has("speaking") ? Math.max(0, Math.sin(t / 6)) * 0.35 : 0;
    const lv: Record<string, number> = {};
    lv["@morgan:example.com|mic"] = +talk.toFixed(3);
    lv["@sam:example.com|mic"] = 0;
    set({
      speakers: { me: "@you:example.com:FAKE", active: talk > 0.02 ? ["@morgan:example.com"] : [] },
      audioLevels: lv,
      micLevel: st.micMuted ? 0 : demo.has("speaking") ? +(Math.abs(Math.sin(t / 3)) * 0.3).toFixed(3) : 0,
      outputLevel: demo.has("speaking") ? +(Math.abs(Math.sin(t / 4)) * 0.2).toFixed(3) : 0,
    });
  }, 100);
}

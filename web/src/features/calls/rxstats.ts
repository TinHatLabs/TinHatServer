// rxstats.ts — what we RECEIVE from each person in the call and how THEY receive us (contract WIDGETS.md §5, §6,
// §10.2): receiver stats per subscribed track (inbound-rtp + the transport's round trip), LiveKit ConnectionQuality,
// and the `tinhat.rxq` report — sent every 5 s to each remote participant about their tracks, received from them about
// ours. Feeds the Call stats widget (useRxStats) — display only.
//
// Cadence (GPU.md §2.8/§2.11, WIDGETS.md §5): the sampler runs every 5 s while in a call (the rxq report must go out
// even when this window is hidden); while a Call stats widget is shown it samples every 1 s when the window is focused
// (5 s otherwise) and the store is patched only when the window is not hidden (and at once on focus).
import { create } from "zustand";
import { ConnectionQuality, RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { createLogger } from "@/core/log";
import { onWinState, winState } from "@/core/winstate";
import { rxNumbers, SPARK_SAMPLES, type RxSample, type TrackKind, type TrackNumbers } from "@/widgets/quality";
import { decodeRxq, encodeRxq, RxqGate, RXQ_MAX_BYTES, RXQ_SEND_MS, RXQ_TOPIC, type Rxq } from "@/widgets/rxq";
import { hooks } from "./engine";
import { sess, type Sess } from "./session";
import { isRecorder, mxidOf } from "./util";

const log = createLogger("rxstats");

export interface RxPerson {
  identity: string;
  mxid: string;
  /** LiveKit ConnectionQuality ("excellent" | "good" | "poor" | "lost" | "unknown") */
  cq: string;
  /** what we receive from them, one entry per kind (the last display interval) */
  incoming: TrackNumbers[];
  /** their incoming kbps (all tracks), the last ≤ 60 display samples */
  spark: number[];
  /** display samples taken so far (the sparkline's step key) */
  samples: number;
  /** their last accepted `tinhat.rxq` about us, and when (performance.now()) */
  outgoing: Rxq | null;
  outAt: number;
}

export interface RxState {
  roomId: string | null;
  people: Record<string, RxPerson>;
  /** bumps on every patch (the widget's re-render key) */
  rev: number;
}

export const useRxStore = create<RxState>()(() => ({ roomId: null, people: {}, rev: 0 }));

let watchers = 0;
let kick: (() => void) | null = null;
/** A Call stats widget is on screen: sample for display (1 s focused / 5 s otherwise). Returns the release. */
export function watchRxStats(): () => void {
  watchers++;
  kick?.();
  return () => {
    watchers = Math.max(0, watchers - 1);
  };
}

const KIND_OF: Array<[TrackKind, Track.Source]> = [
  ["a", Track.Source.Microphone],
  ["v", Track.Source.Camera],
  ["s", Track.Source.ScreenShare],
];

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One subscribed track's inbound-rtp sample (+ codec mimeType + the transport's current round trip). */
async function sampleTrack(p: RemoteParticipant, kind: TrackKind, source: Track.Source): Promise<{ key: string; s: RxSample } | null> {
  const pub = p.getTrackPublication(source);
  const track = pub?.isSubscribed ? pub.track : undefined;
  const recv = track?.receiver;
  if (!pub || !track || !recv) return null;
  let report: RTCStatsReport;
  try {
    report = await recv.getStats();
  } catch {
    return null;
  }
  const byId = new Map<string, Record<string, unknown>>();
  report.forEach((v) => byId.set((v as { id: string }).id, v as Record<string, unknown>));
  let inbound: Record<string, unknown> | null = null;
  let rtt: number | undefined;
  for (const v of byId.values()) {
    if (v.type === "inbound-rtp" && !inbound) inbound = v;
    if (v.type === "candidate-pair" && (v.nominated === true || v.state === "succeeded") && rtt === undefined) rtt = num(v.currentRoundTripTime);
    if (v.type === "transport" && typeof v.selectedCandidatePairId === "string") {
      const pair = byId.get(v.selectedCandidatePairId);
      const t = num(pair?.currentRoundTripTime);
      if (t !== undefined) rtt = t;
    }
  }
  if (!inbound) return null;
  const codec = byId.get(String(inbound.codecId ?? ""));
  return {
    key: `${p.identity}|${kind}|${pub.trackSid}`,
    s: {
      k: kind,
      at: num(inbound.timestamp) ?? performance.now(),
      bytes: num(inbound.bytesReceived) ?? 0,
      packets: num(inbound.packetsReceived) ?? 0,
      lost: num(inbound.packetsLost) ?? 0,
      jitter: num(inbound.jitter),
      rtt,
      fps: num(inbound.framesPerSecond),
      w: num(inbound.frameWidth),
      h: num(inbound.frameHeight),
      codec: typeof codec?.mimeType === "string" ? codec.mimeType : undefined,
    },
  };
}

hooks.onConnected.push((s: Sess) => {
  const gate = new RxqGate();
  const dispPrev = new Map<string, RxSample>();
  const rxqPrev = new Map<string, RxSample>();
  let lastDisplay = 0;
  // the first rxq tick 1 s in takes the baseline samples; the first report goes out 5 s later
  let lastRxq = performance.now() - RXQ_SEND_MS + 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const alive = () => !stopped && sess() === s;
  useRxStore.setState({ roomId: s.roomId, people: {}, rev: 0 });

  const person = (st: RxState, p: RemoteParticipant): RxPerson =>
    st.people[p.identity] ?? { identity: p.identity, mxid: mxidOf(p.identity), cq: String(p.connectionQuality ?? ConnectionQuality.Unknown), incoming: [], spark: [], samples: 0, outgoing: null, outAt: 0 };

  const displayPeriod = () => (watchers > 0 && winState() === "focused" ? 1000 : 5000);

  async function tick() {
    timer = 0;
    if (!alive()) return;
    const now = performance.now();
    const doDisplay = watchers > 0 && winState() !== "hidden" && now - lastDisplay >= displayPeriod() - 50;
    const doRxq = now - lastRxq >= RXQ_SEND_MS - 50;
    if (doDisplay || doRxq) {
      const people = [...s.room.remoteParticipants.values()].filter((p) => !isRecorder(p.identity));
      const perPerson = new Map<string, { incoming: TrackNumbers[]; rxq: TrackNumbers[] }>();
      for (const p of people) {
        const entry = { incoming: [] as TrackNumbers[], rxq: [] as TrackNumbers[] };
        for (const [kind, source] of KIND_OF) {
          const got = await sampleTrack(p, kind, source);
          if (!got || !alive()) continue;
          if (doDisplay) {
            const n = rxNumbers(dispPrev.get(got.key), got.s);
            dispPrev.set(got.key, got.s);
            if (n) entry.incoming.push(n);
          }
          if (doRxq) {
            const n = rxNumbers(rxqPrev.get(got.key), got.s);
            rxqPrev.set(got.key, got.s);
            if (n) entry.rxq.push(n);
          }
        }
        perPerson.set(p.identity, entry);
      }
      if (!alive()) return;
      if (doRxq) {
        lastRxq = now;
        for (const p of people) {
          const text = encodeRxq(perPerson.get(p.identity)?.rxq ?? []);
          if (!text) continue;
          void s.room.localParticipant
            .publishData(new TextEncoder().encode(text), { reliable: false, topic: RXQ_TOPIC, destinationIdentities: [p.identity] })
            .catch((e) => log.debug(`rxq → ${p.identity}: ${(e as Error)?.message ?? e}`));
        }
      }
      if (doDisplay) {
        lastDisplay = now;
        useRxStore.setState((st) => {
          const next: Record<string, RxPerson> = {};
          for (const p of people) {
            const cur = person(st, p);
            const inc = perPerson.get(p.identity)?.incoming ?? [];
            const kbps = inc.reduce((a, n) => a + (n.kbps ?? 0), 0);
            next[p.identity] = { ...cur, incoming: inc, spark: [...cur.spark, kbps].slice(-SPARK_SAMPLES), samples: cur.samples + 1 };
          }
          return { people: next, rev: st.rev + 1 };
        });
      }
    }
    schedule();
  }
  function schedule() {
    if (!alive() || timer) return;
    const now = performance.now();
    const nextRxq = lastRxq + RXQ_SEND_MS - now;
    const nextDisp = watchers > 0 && winState() !== "hidden" ? lastDisplay + displayPeriod() - now : Infinity;
    timer = setTimeout(() => void tick(), Math.max(250, Math.min(nextRxq, nextDisp)));
  }
  kick = () => {
    if (!alive()) return;
    if (timer) clearTimeout(timer);
    timer = 0;
    void tick();
  };
  s.cleanups.push(onWinState((now, prev) => now === "focused" && prev !== "focused" && kick?.()));

  // ---- receive ----
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (topic !== RXQ_TOPIC || !participant || !alive()) return;
    const id = participant.identity;
    if (isRecorder(id) || !s.room.remoteParticipants.has(id) || payload.byteLength > RXQ_MAX_BYTES) return;
    const at = performance.now();
    if (!gate.read(id, at)) return;
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch {
      return; // malformed UTF-8
    }
    const d = decodeRxq(text);
    if (!d.ok) return;
    gate.accepted(id, at);
    useRxStore.setState((st) => {
      const p = s.room.remoteParticipants.get(id);
      if (!p) return {};
      const cur = person(st, p);
      return { people: { ...st.people, [id]: { ...cur, outgoing: { q: d.q, t: d.t }, outAt: at } }, rev: st.rev + 1 };
    });
  };
  const onQuality = (q: ConnectionQuality, p: { identity: string }) => {
    if (!alive() || p.identity === s.myIdentity || isRecorder(p.identity)) return;
    useRxStore.setState((st) => {
      const rp = s.room.remoteParticipants.get(p.identity);
      if (!rp) return {};
      const cur = person(st, rp);
      return { people: { ...st.people, [p.identity]: { ...cur, cq: String(q) } }, rev: st.rev + 1 };
    });
  };
  s.room.on(RoomEvent.DataReceived, onData);
  s.room.on(RoomEvent.ConnectionQualityChanged, onQuality);
  s.cleanups.push(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
    s.room.off(RoomEvent.DataReceived, onData);
    s.room.off(RoomEvent.ConnectionQualityChanged, onQuality);
  });
  schedule();
});

hooks.onParticipantLeft.push((s, p) => {
  if (sess() !== s) return;
  useRxStore.setState((st) => {
    if (!st.people[p.identity]) return {};
    const people = { ...st.people };
    delete people[p.identity];
    return { people, rev: st.rev + 1 };
  });
});

hooks.onTeardown.push(() => {
  kick = null;
  useRxStore.setState({ roomId: null, people: {}, rev: 0 });
});

/** React: the call's receive view (Call stats widget). */
export function useRxStats(): RxState {
  return useRxStore();
}

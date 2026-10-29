// callstats/CallStats.tsx — the Call stats widget (contract WIDGETS-UI.md §5). In a call: one row per person with the
// incoming lane (what you get from them — receiver stats) and the outgoing lane (how they get you — their `tinhat.rxq`),
// the connection dot (LiveKit ConnectionQuality), a 60-sample sparkline and codec / resolution chips; click a row for
// the per-track details; L adds the You row (Stream health). Outside a call: the last call and this week per friend
// from the call history (src/widgets/history.ts over historyCache.ts). Row order, bands and the summary: the shared
// callPeople (src/widgets/people.ts, WIDGETS.md §10.6).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { openRoom } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { Avatar, BusyIndicator, Popover, cx } from "@/ui";
import { callCompanions, foldPeers, useCall, useRxStats, watchRxStats, type FoldedPeer, type PublishStat, type RxPerson } from "@/features/calls";
import { messageUser } from "@/features/nav";
import { bandOf, cqBand, fmtLoss, fmtRate, rateFillPm, resChip, sparkPoints, worstBand, type Band, type TrackNumbers } from "@/widgets/quality";
import { callPeople, fmtRatePair, type CallSummary } from "@/widgets/people";
import { rxqStale } from "@/widgets/rxq";
import { fmtAgo, fmtDur } from "@/widgets/time";
import type { Call, History, LastCall } from "@/widgets/history";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useRisingEdge } from "../motion";
import { nameNow, usePerson, useRoomLabel } from "../names";
import { NO_HISTORY, retryHistory, useCallHistory, type HistoryView } from "./historyCache";
import { friendsByCalls } from "./order";
import s from "./CallStats.module.css";

// ---- the model ---------------------------------------------------------------------------------------------------

export interface Lane {
  kbps: number;
  band: Band | null;
  /** no numbers (incoming: nothing received yet; outgoing: stale or never received) */
  none: boolean;
  /** outgoing: never received a report from them (older app / not yet) */
  never: boolean;
}
export interface PersonView {
  identity: string;
  mxid: string;
  name: string;
  /** the connection dot: cqBand(ConnectionQuality) */
  cq: Band | null;
  cqRaw: string;
  inc: Lane;
  out: Lane;
  spark: number[];
  samples: number;
  chips: string[];
  incTracks: TrackNumbers[];
  outTracks: TrackNumbers[];
  /** worstBand(cq, incoming, outgoing) — callPeople's band */
  band: Band | null;
  /** screen share P3: their phone's share (a companion, foldPeers) — one row per person, the share as a sub-line */
  share?: PersonView;
  /** a companion of OUR OWN device: its row reads "Your screen" */
  ownShare?: boolean;
}
export interface YouTrack {
  label: string;
  kbps: number;
  codec: string;
  res: string;
  limit: string;
}
export interface CallStatsModel {
  inCall: boolean;
  roomId: string | null;
  /** row order (callPeople) */
  people: PersonView[];
  summary: CallSummary;
  totalIn: number;
  totalOut: number;
  you: YouTrack[];
  hist: HistoryView;
  /** wall clock for the "… ago" labels */
  now: number;
}

const sum = (l: readonly TrackNumbers[]) => l.reduce((a, n) => a + (n.kbps ?? 0), 0);

/** Codec + resolution chips of the main received track: the screen share, else the camera, else the voice. */
function mainChips(tracks: readonly TrackNumbers[]): string[] {
  const main = tracks.find((t) => t.k === "s") ?? tracks.find((t) => t.k === "v") ?? tracks.find((t) => t.k === "a");
  if (!main) return [];
  const out: string[] = [];
  if (main.c) out.push(main.c);
  const r = main.k !== "a" ? resChip(main.w, main.h, main.fps) : "";
  if (r) out.push(r);
  return out;
}

function foldedView(p: FoldedPeer<RxPerson>, name: string, nowMono: number): PersonView {
  const v = personView(p, p.ownShare ? "Your screen" : name, nowMono);
  if (p.ownShare) v.ownShare = true;
  if (p.share) v.share = personView(p.share, name, nowMono);
  return v;
}

function personView(p: RxPerson, name: string, nowMono: number): PersonView {
  const incBand = worstBand(p.incoming.map(bandOf));
  const never = !p.outgoing;
  const stale = rxqStale(p.outgoing ? p.outAt : null, nowMono);
  const out: Lane = { kbps: p.outgoing && !stale ? sum(p.outgoing.t) : 0, band: p.outgoing && !stale ? p.outgoing.q : null, none: stale, never };
  const inc: Lane = { kbps: sum(p.incoming), band: incBand, none: p.incoming.length === 0, never: false };
  return {
    identity: p.identity,
    mxid: p.mxid,
    name,
    cq: cqBand(p.cq),
    cqRaw: p.cq,
    inc,
    out,
    spark: p.spark,
    samples: p.samples,
    chips: mainChips(p.incoming),
    incTracks: p.incoming,
    outTracks: p.outgoing && !stale ? p.outgoing.t : [],
    band: null,
  };
}

/** Order + bands + summary from the shared callPeople. */
function arrange(views: PersonView[]): { people: PersonView[]; summary: CallSummary } {
  // (a folded share counts for its person's band: its connection, incoming and outgoing — a poor phone share isn't hidden)
  const cp = callPeople(
    views.map((v) => ({ id: v.identity, name: v.name, cq: v.cqRaw, inBand: v.share ? worstBand([v.inc.band, v.share.inc.band, v.share.cq, v.share.out.band]) : v.inc.band, outBand: v.out.band })),
  );
  const by = new Map(views.map((v) => [v.identity, v]));
  const people = cp.order.map((id, i) => ({ ...by.get(id)!, band: cp.bands[i] ?? null }));
  return { people, summary: cp.summary };
}

const YOU_LABEL: Record<string, string> = { mic: "Mic", camera: "Camera", screen: "Screen", music: "Music", sound: "Sounds" };
const YOU_ORDER = ["mic", "camera", "screen", "music", "sound"];

function youTracks(stats: readonly PublishStat[]): YouTrack[] {
  const groups = new Map<string, PublishStat[]>();
  for (const st of stats) {
    const k = st.kind.startsWith("camera/") ? "camera" : st.kind;
    groups.set(k, [...(groups.get(k) ?? []), st]);
  }
  return [...groups]
    .sort((a, b) => (YOU_ORDER.indexOf(a[0]) + 99) % 100 - ((YOU_ORDER.indexOf(b[0]) + 99) % 100))
    .map(([k, l]) => {
      const top = [...l].sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
      const lim = l.find((x) => x.qlim === "bandwidth") ? "bandwidth" : l.find((x) => x.qlim === "cpu") ? "CPU" : "";
      return {
        label: YOU_LABEL[k] ?? k,
        kbps: l.reduce((a, x) => a + (x.sendKnown ? x.sendKbps : 0), 0),
        codec: top.encPick.replace(/ \(browser\)$/, ""),
        res: k === "camera" || k === "screen" ? resChip(top.w, top.h, top.fps) : "",
        limit: lim,
      };
    });
}

function useCallStatsModel(ctx: WidgetCtx): CallStatsModel {
  const inCall = useCall((st) => st.inCall);
  const roomId = useCall((st) => (st.inCall ? st.callRoomId : null));
  const publish = useCall((st) => st.publishStats);
  const rx = useRxStats();
  useEffect(() => (inCall && !ctx.preview ? watchRxStats() : undefined), [inCall, ctx.preview]);
  const hist = useCallHistory(!inCall || ctx.preview);
  const nowMono = performance.now();
  const session = useSession();
  const own = `${session.userId ?? ""}:${session.deviceId ?? ""}`;
  // screen share P3: a phone's share-only companion is its person's sub-line, not a second person (foldPeers)
  const peers = inCall ? foldPeers(Object.values(rx.people), (p) => p.identity, callCompanions(roomId), own) : [];
  const views = peers.map((p) => foldedView(p, nameNow(p.mxid, roomId), nowMono));
  const { people, summary } = arrange(views);
  const you = inCall ? youTracks(publish) : [];
  return {
    inCall,
    roomId,
    people,
    summary,
    totalIn: people.reduce((a, p) => a + p.inc.kbps + (p.share?.inc.kbps ?? 0), 0),
    totalOut: you.reduce((a, t) => a + t.kbps, 0),
    you,
    hist,
    now: hist.at || Date.now(),
  };
}

// ---- parts ----------------------------------------------------------------------------------------------------------

const BAND_VAR: Record<Band | "unknown", string> = {
  good: "var(--th-widget-quality-good-fill)",
  ok: "var(--th-widget-quality-ok-fill)",
  poor: "var(--th-widget-quality-poor-fill)",
  unknown: "var(--th-widget-quality-unknown-fill)",
};

/** One lane: arrow, bar (length = rateFillPm, colour = the band), value. `laneEase` = the width transition (snaps
 *  while the motion switch is off); `lossFlash` = the track flashes once when the band turns poor. */
function LaneBar({ arrow, lane, title }: { arrow: string; lane: Lane; title: string }) {
  const flash = useRisingEdge(lane.band === "poor");
  const fill = lane.none ? 0 : rateFillPm(lane.kbps) / 10;
  return (
    <span className={s.lane} title={title}>
      <span className={s.arrow}>{arrow}</span>
      <span className={s.track}>
        <span className={s.fill} style={{ width: `${fill}%`, background: BAND_VAR[lane.band ?? "unknown"] }} />
        {flash > 0 && <span key={flash} className={s.flash} />}
      </span>
      <span className={s.value} data-none={lane.none ? "" : undefined}>
        {lane.none ? "—" : fmtRate(lane.kbps)}
      </span>
    </span>
  );
}

const SPARK_W = 48;
const SPARK_H = 26;
/** The last 60 samples of incoming kb/s (sparkPoints); `sparkStep` = the line slides one step left per new sample. */
function Spark({ values, samples }: { values: readonly number[]; samples: number }) {
  const pts = sparkPoints(values, SPARK_W, SPARK_H);
  if (pts.length < 2) return <svg className={s.spark} width={SPARK_W} height={SPARK_H} aria-hidden="true" />;
  const line = pts.map(([x, y]) => `${x / 100},${y / 100}`).join(" ");
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${first[0] / 100},${SPARK_H - 1} ${line} ${last[0] / 100},${SPARK_H - 1}`;
  const step = (SPARK_W - 2) / 59;
  return (
    <svg className={s.spark} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
      <g key={samples} className={s.slide} style={{ "--step": `${step}px` } as CSSProperties}>
        <polygon points={area} fill="var(--th-widget-stats-spark-fill)" />
        <polyline points={line} fill="none" stroke="var(--th-widget-stats-spark-edge)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Dot({ band, size = 8, className }: { band: Band | null; size?: number; className?: string }) {
  return <span className={cx(s.dot, className)} style={{ width: size, height: size, background: BAND_VAR[band ?? "unknown"] }} />;
}

const CQ_WORD: Record<string, string> = { excellent: "excellent", good: "good", poor: "poor", lost: "lost" };

function PersonRow({ p, roomId, ctx }: { p: PersonView; roomId: string | null; ctx: WidgetCtx }) {
  const who = usePerson(p.mxid, roomId);
  const name = p.ownShare ? p.name : who.name || p.name;
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const outTitle = p.out.never ? "No report from their app yet" : p.out.none ? "No report for a while" : `How ${name} gets you`;
  return (
    <>
      <div
        ref={ref}
        className={s.person}
        role="button"
        tabIndex={ctx.preview ? -1 : 0}
        aria-expanded={open}
        aria-label={`${name}: details`}
        onClick={() => !ctx.preview && setOpen((o) => !o)}
        onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && !ctx.preview && setOpen((o) => !o)}
      >
        <span className={s.avatar}>
          <Avatar size={ctx.mobile ? 32 : 24} name={name} seed={p.mxid} imageSource={who.avatar} />
          <Dot band={p.cq} className={s.cqDot} />
        </span>
        <span className={s.pmain}>
          <span className={s.line1}>
            <span className={s.name}>{name}</span>
            {p.chips.map((c) => (
              <span key={c} className={s.chip}>
                {c}
              </span>
            ))}
          </span>
          <span className={s.lanes}>
            <span className={s.laneCol}>
              <LaneBar arrow="↓" lane={p.inc} title={`What you get from ${name}`} />
              <LaneBar arrow="↑" lane={p.out} title={outTitle} />
            </span>
            <Spark values={p.spark} samples={p.samples} />
          </span>
          {p.share && (
            <span className={s.shareLine} data-callstats-share={p.share.identity}>
              <span className={s.chip}>Screen</span>
              {p.share.chips.map((c) => (
                <span key={c} className={s.chip}>
                  {c}
                </span>
              ))}
              <span className={s.laneCol}>
                <LaneBar arrow="↓" lane={p.share.inc} title={`${name}'s screen, shared from their phone`} />
              </span>
            </span>
          )}
        </span>
      </div>
      {open && (
        <Popover open onClose={() => setOpen(false)} anchor={ref.current} placement="right" gap={8} title={name} className={s.details}>
          <Details p={p} name={name} avatar={who.avatar} />
        </Popover>
      )}
    </>
  );
}

const KIND_LABEL: Record<string, string> = { a: "Voice", v: "Camera", s: "Screen" };

function Grid({ tracks, kinds }: { tracks: readonly TrackNumbers[]; kinds: string[] }) {
  const by = new Map(tracks.map((t) => [t.k, t]));
  const cell = (k: string, label: string, f: (t: TrackNumbers) => string) => {
    const t = by.get(k as TrackNumbers["k"]);
    const v = t ? f(t) : "";
    return (
      <span key={`${label}-${k}`} className={s.gridValue} data-none={v ? undefined : ""}>
        {v || "—"}
      </span>
    );
  };
  const rows: Array<[string, (t: TrackNumbers) => string]> = [
    ["Bitrate", (t) => (t.kbps !== undefined ? fmtRate(t.kbps) : "")],
    ["Loss", (t) => (t.loss !== undefined ? fmtLoss(t.loss) : "")],
    ["Jitter", (t) => (t.jit !== undefined ? `${t.jit} ms` : "")],
    ["Round trip", (t) => (t.rtt !== undefined ? `${t.rtt} ms` : "")],
    ["Codec", (t) => t.c ?? ""],
    ["Video", (t) => (t.k !== "a" ? resChip(t.w, t.h, t.fps) : "")],
  ];
  return (
    <div className={s.grid} style={{ gridTemplateColumns: `auto repeat(${kinds.length}, 1fr)` }}>
      <span />
      {kinds.map((k) => (
        <span key={k} className={s.gridHead}>
          {KIND_LABEL[k]}
        </span>
      ))}
      {rows.map(([label, f]) => [
        <span key={label} className={s.gridLabel}>
          {label}
        </span>,
        ...kinds.map((k) => cell(k, label, f)),
      ])}
    </div>
  );
}

function Details({ p, name, avatar }: { p: PersonView; name: string; avatar: string | null }) {
  const kinds = ["a", "v", "s"].filter((k) => p.incTracks.some((t) => t.k === k) || p.outTracks.some((t) => t.k === k));
  if (!kinds.length) kinds.push("a");
  return (
    <div className={s.detailBody} data-call-details="">
      <div className={s.detailHead}>
        <Avatar size={20} name={name} seed={p.mxid} imageSource={avatar} />
        <span className={s.detailName}>{name}</span>
        <span className={s.detailCq}>
          <Dot band={p.cq} size={6} /> Connection: {CQ_WORD[p.cqRaw] ?? "unknown"}
        </span>
      </div>
      <div className={s.section}>
        <Dot band={p.inc.band} size={6} /> You get from {name}
      </div>
      <Grid tracks={p.incTracks} kinds={kinds} />
      <div className={s.section}>
        <Dot band={p.out.band} size={6} /> {name} gets from you
      </div>
      {p.out.never ? <div className={s.hint}>Needs Tin Hat 11 on their side</div> : p.out.none ? <div className={s.hint}>No report from their app for a while</div> : <Grid tracks={p.outTracks} kinds={kinds} />}
      <div className={s.foot}>Updates every second while Tin Hat is focused, every 5 seconds otherwise.</div>
    </div>
  );
}

function YouRow({ you, ctx }: { you: YouTrack[]; ctx: WidgetCtx }) {
  const session = useSession();
  const me = session.userId ?? "";
  const who = usePerson(me);
  return (
    <div className={s.you} data-you="">
      <span className={s.avatar}>
        <Avatar size={ctx.mobile ? 32 : 24} name={who.name} seed={me} imageSource={who.avatar} />
      </span>
      <span className={s.pmain}>
        <span className={s.line1}>
          <span className={s.name}>You</span>
        </span>
        {you.length === 0 && <span className={s.youLine}>Nothing published</span>}
        {you.map((t) => [
          <span key={t.label} className={s.youLine}>
            <span className={s.youKind}>{t.label}</span> {fmtRate(t.kbps)}
            {t.codec ? ` · ${t.codec}` : ""}
            {t.res ? ` · ${t.res}` : ""}
          </span>,
          t.limit ? (
            <span key={`${t.label}-limit`} className={cx(s.youLine, s.limit)}>
              limited by {t.limit}
            </span>
          ) : null,
        ])}
      </span>
    </div>
  );
}

// ---- outside a call ----------------------------------------------------------------------------------------------

function namesLine(ids: string[], roomId: string): string {
  const names = ids.map((m) => nameNow(m, roomId));
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function Face({ mxid, room, size = 18 }: { mxid: string; room?: string; size?: number }) {
  const who = usePerson(mxid, room);
  return (
    <span className={s.face}>
      <Avatar size={size} name={who.name} seed={mxid} imageSource={who.avatar} />
    </span>
  );
}

function LastCall({ h, now, ctx }: { h: NonNullable<History["last"]>; now: number; ctx: WidgetCtx }) {
  const room = useRoomLabel(h.room);
  const ids = h.with.map((w) => w.user);
  const open = () => !ctx.preview && openRoom(h.room);
  return (
    <>
      <div className={s.label}>
        <span>Last call</span>
        <span className={s.labelRight}>{h.ongoing ? "still going" : fmtAgo(now - h.myEnd)}</span>
      </div>
      <div className={s.lastRow} role="button" tabIndex={ctx.preview ? -1 : 0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
        <span className={s.faces}>
          {ids.slice(0, 3).map((m) => (
            <Face key={m} mxid={m} room={h.room} size={ctx.mobile ? 22 : 18} />
          ))}
        </span>
        <span className={s.lastText}>
          {namesLine(ids, h.room)} · {fmtDur(h.myMs)}
          {room ? ` · ${room}` : ""}
        </span>
      </div>
    </>
  );
}

function FriendRow({ f, ctx }: { f: History["week"]["friends"][number]; ctx: WidgetCtx }) {
  const who = usePerson(f.user);
  const calls = `${f.calls} call${f.calls === 1 ? "" : "s"}${f.started > 0 ? ` · you started ${f.started}` : ""}`;
  const open = () => !ctx.preview && void messageUser(f.user);
  return (
    <div className={s.friend} role="button" tabIndex={ctx.preview ? -1 : 0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()} title={`${who.name}: you started ${f.started}, joined ${f.joined}`}>
      <span className={s.friendAv}>
        <Avatar size={ctx.mobile ? 28 : 20} name={who.name} seed={f.user} imageSource={who.avatar} />
      </span>
      <span className={s.friendName}>{who.name}</span>
      <span className={s.friendSub}>{calls}</span>
    </div>
  );
}

function OutsideBody({ m, ctx }: { m: CallStatsModel; ctx: WidgetCtx }) {
  const h = m.hist.history;
  if (!m.hist.loaded && m.hist.read === 0) {
    return (
      <div className={s.status}>
        <BusyIndicator size={16} progress={m.hist.read} />
        <span>Looking back through your calls…</span>
      </div>
    );
  }
  const friends = friendsByCalls(h?.week.friends ?? [], (u) => nameNow(u));
  const shown = friends.slice(0, ctx.size === "L" ? 10 : 3);
  const week = h?.week;
  return (
    <div className={s.outside} data-mobile={ctx.mobile ? "" : undefined}>
      {h?.last && <LastCall h={h.last} now={m.now} ctx={ctx} />}
      {week && week.myCalls > 0 ? (
        <>
          <div className={s.label}>
            <span>This week</span>
            <span className={s.labelRight}>
              {week.myCalls} call{week.myCalls === 1 ? "" : "s"}
            </span>
          </div>
          {shown.map((f) => (
            <FriendRow key={f.user} f={f} ctx={ctx} />
          ))}
        </>
      ) : (
        <div className={s.empty}>No calls yet this week</div>
      )}
      {m.hist.pending > 0 && (
        <div className={s.hint}>
          <BusyIndicator size={12} progress={m.hist.read} /> Reading {m.hist.pending} more room{m.hist.pending === 1 ? "" : "s"}…
        </div>
      )}
      {m.hist.loaded && !m.hist.pending && m.hist.failed > 0 && (
        <div className={s.hint}>
          Couldn't read some rooms ·{" "}
          <button type="button" className={s.link} disabled={ctx.preview} onClick={() => void retryHistory()}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ---- the widget ---------------------------------------------------------------------------------------------------

function Body({ model, ctx }: PartProps<CallStatsModel>) {
  if (!model.inCall) return <OutsideBody m={model} ctx={ctx} />;
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {ctx.size === "L" && <YouRow you={model.you} ctx={ctx} />}
      {model.people.length === 0 && <div className={s.empty}>Nobody else is here yet</div>}
      {model.people.map((p) => (
        <PersonRow key={p.identity} p={p} roomId={model.roomId} ctx={ctx} />
      ))}
    </div>
  );
}

function Totals({ model }: PartProps<CallStatsModel>) {
  if (!model.inCall) return null;
  return (
    <span className={s.totals}>
      <span className={s.arrowT}>↓</span> {fmtRate(model.totalIn)} <span className={s.arrowT}>↑</span> {fmtRate(model.totalOut)}
    </span>
  );
}

function SummaryTail({ model }: { model: CallStatsModel }) {
  const sm = model.summary;
  const p = sm.kind === "worst" ? model.people.find((x) => x.identity === sm.id) : undefined;
  const who = usePerson(p?.mxid ?? "", model.roomId);
  if (sm.kind === "alone") return <>just you</>;
  if (sm.kind === "measuring") return <>measuring…</>;
  if (sm.kind === "good" || !p) return <>all good</>;
  return (
    <>
      <Dot band={sm.band ?? null} size={6} className={s.sumDot} /> {who.name || p.name}
    </>
  );
}

function Summary({ model }: PartProps<CallStatsModel>) {
  // alone: nobody to receive from, so only what you send ("↑ 1.3 Mb/s · just you")
  if (model.inCall && model.summary.kind === "alone") return <span className={s.summary}>↑ {fmtRate(model.totalOut)} · just you</span>;
  if (model.inCall)
    return (
      <span className={s.summary}>
        {fmtRatePair(model.totalIn, model.totalOut)} · <SummaryTail model={model} />
      </span>
    );
  const last = model.hist.history?.last;
  return <span className={s.summary}>{last ? `Last call ${last.ongoing ? "still going" : fmtAgo(model.now - last.myEnd)} · ${fmtDur(last.myMs)}` : model.hist.loaded ? "No calls yet this week" : "Looking back…"}</span>;
}

// ---- samples ---------------------------------------------------------------------------------------------------------

const SP = (id: string) => `@${id}:sample.invalid`;
function wave(base: number, phase: number, dip = -1): number[] {
  return Array.from({ length: 60 }, (_, i) => Math.round(base * (0.86 + 0.1 * Math.sin((i + phase) / 4.5) + 0.04 * Math.cos((i + phase) * 1.7)) * (dip >= 0 && i >= dip && i < dip + 6 ? 0.35 : 1)));
}
function sp(id: string, name: string, cq: string, inc: TrackNumbers[], out: TrackNumbers[] | null, spark: number[], outNone = false): PersonView {
  const incBand = worstBand(inc.map(bandOf));
  const outBand = out ? worstBand(out.map(bandOf)) : null;
  return {
    identity: `${SP(id)}:DEVICE`,
    mxid: SP(id),
    name,
    cq: cqBand(cq),
    cqRaw: cq,
    inc: { kbps: sum(inc), band: incBand, none: inc.length === 0, never: false },
    out: { kbps: out && !outNone ? sum(out) : 0, band: out && !outNone ? outBand : null, none: !out || outNone, never: !out },
    spark,
    samples: 60,
    chips: mainChips(inc),
    incTracks: inc,
    outTracks: out && !outNone ? out : [],
    band: null,
  };
}
const A = (kbps: number, loss = 0, jit = 8, rtt = 42): TrackNumbers => ({ k: "a", kbps, loss, jit, rtt, c: "Opus" });
const V = (kbps: number, w: number, h: number, fps: number, c = "AV1", loss = 0, jit = 6, rtt = 42): TrackNumbers => ({ k: "v", kbps, loss, jit, rtt, w, h, fps, c });
const Sh = (kbps: number, w: number, h: number, fps: number, c = "AV1"): TrackNumbers => ({ k: "s", kbps, loss: 0, jit: 4, rtt: 42, w, h, fps, c });

function inCallSample(opts: { poor?: boolean; alone?: boolean } = {}): CallStatsModel {
  const views = opts.alone
    ? []
    : [
        sp("ana", "Ana", "excellent", [A(46), V(1420, 1280, 720, 30)], [A(44), V(1380, 1280, 720, 30)], wave(1466, 0)),
        sp("bo", "Bo", opts.poor ? "poor" : "good", opts.poor ? [A(38, 96, 64, 212)] : [A(48, 4, 12, 88)], opts.poor ? [A(40, 30, 40, 210)] : [A(47, 2, 10, 90)], wave(opts.poor ? 38 : 48, 9, opts.poor ? 50 : -1)),
        sp("cy", "Cy", "excellent", [A(44), Sh(5840, 2560, 1440, 60)], null, wave(5884, 23)),
      ];
  const { people, summary } = arrange(views);
  const you: YouTrack[] = [
    { label: "Mic", kbps: 44, codec: "Opus", res: "", limit: "" },
    { label: "Camera", kbps: 1210, codec: "AV1", res: "720p30", limit: opts.poor ? "bandwidth" : "" },
  ];
  return {
    inCall: true,
    roomId: "!lounge:sample.invalid",
    people,
    summary,
    totalIn: people.reduce((a, p) => a + p.inc.kbps, 0),
    totalOut: you.reduce((a, t) => a + t.kbps, 0),
    you,
    hist: NO_HISTORY,
    now: Date.now(),
  };
}

function historySample(opts: { friends?: number; empty?: boolean; failed?: boolean; loading?: boolean } = {}): CallStatsModel {
  const now = Date.now();
  const MIN = 60_000;
  const names = ["ana", "bo", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo"];
  const n = opts.friends ?? 3;
  // the samples' calls tie on purpose (5, 5 · 3, 3 · 1, 1 …): the rows show them by calls, then name — never by time
  const CALLS = [6, 5, 5, 3, 3, 2, 1, 1, 1, 1];
  const friends = names.slice(0, n).map((id, i) => ({ user: SP(id), togetherMs: Math.round((160 - i * 17) * MIN * (1 - i * 0.04)), calls: CALLS[i], started: Math.min(CALLS[i], Math.max(0, 3 - i)), joined: CALLS[i] - Math.min(CALLS[i], Math.max(0, 3 - i)) }));
  const week = { from: now - 7 * 86_400_000, to: now, myMs: opts.empty ? 0 : 250 * MIN, myCalls: opts.empty ? 0 : 6, friends: opts.empty ? [] : friends };
  const last: LastCall = {
    room: "!lounge:sample.invalid",
    start: now - 3 * 3_600_000,
    end: now - 2 * 3_600_000 + 5 * MIN,
    myStart: now - 3 * 3_600_000,
    myEnd: now - 2 * 3_600_000 + 5 * MIN,
    ongoing: false,
    startedBy: SP("ana"),
    myMs: 80 * MIN,
    with: [
      { user: SP("ana"), ms: 80 * MIN },
      { user: SP("bo"), ms: 64 * MIN },
      { user: SP("cy"), ms: 20 * MIN },
    ],
  };
  const call: Call = { room: last.room, start: last.start, end: last.end, ongoing: false, startedBy: last.startedBy, members: last.with, myMs: last.myMs };
  const history: History = { calls: opts.empty ? [] : [call], week, last: opts.empty ? null : last };
  const hist: HistoryView = opts.loading
    ? { history: null, pending: 12, read: 0, failed: 0, loaded: false, at: now }
    : { history, pending: 0, read: 14, failed: opts.failed ? 2 : 0, loaded: true, at: now };
  return { inCall: false, roomId: null, people: [], summary: { kind: "alone" }, totalIn: 0, totalOut: 0, you: [], hist, now };
}

export const callStats = defineWidget<CallStatsModel>({
  id: "callStats",
  useModel: useCallStatsModel,
  live: (m) => m.inCall,
  Summary,
  HeaderExtra: Totals,
  Body,
  hasData: (m) => m.inCall || !!m.hist.history?.calls.length,
  samples: {
    preview: () => inCallSample(),
    call: () => inCallSample(),
    poor: () => inCallSample({ poor: true }),
    alone: () => inCallSample({ alone: true }),
    history: () => historySample(),
    week: () => historySample({ friends: 8 }),
    empty: () => historySample({ empty: true }),
    failed: () => historySample({ failed: true }),
    loading: () => historySample({ loading: true }),
  },
});

// justme/JustMe.tsx — "Is it just me?" (widget `justMe`, contract WIDGETS.md §20, WIDGETS-UI.md §20; the desktop's
// JustMeWidget.qml): is the server down, or is it your connection? A green / amber / red light per service measured from
// THIS device — Chat (the homeserver + whether sync is flowing), Calls (the call JWT service), Media (the media repo),
// the Tin Hat server — plus your ping (the median of 3 requests to the homeserver). M = a row per service ("Calls ·
// reachable · 84 ms") + the friendly sentence when something is red + "Checked 2:41 PM · Check again"; L adds the last
// 10 minutes as a small bar sparkline per row (redrawn only when a check lands); S / collapsed = "All good · 42 ms" /
// "Calls look down". Checks: every 60 s focused, 5 min unfocused, never while hidden (store.ts). Motion: stateFade (a
// dot's colour eases when its band changes). No timer of its own.
import { useMemo } from "react";
import { cx } from "@/ui";
import { fmtClock, useClockMode } from "@/features/settings";
import { SERVICES, SERVICE_NAME, checkOf, sparkSlots, type Band, type Check, type Probe, type Row, type Sample } from "@/widgets/justme";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { checkNow, useJustMe, type SeriesId } from "./store";
import s from "./JustMe.module.css";

export interface JustMeModel {
  check: Check | null;
  at: number | null;
  running: boolean;
  history: Record<SeriesId, Sample[]>;
}

function useModel(ctx: WidgetCtx): JustMeModel {
  void ctx;
  const st = useJustMe(true);
  return useMemo(() => ({ check: st.check, at: st.at, running: st.running, history: st.history }), [st.rev]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The rows before the first check: every light grey, "checking…". */
const WAITING: Row[] = [...SERVICES.map((id) => ({ id, name: SERVICE_NAME[id], band: "ok" as Band, cause: "ok" as const, ms: null, reason: "checking…" })), { id: "ping" as const, name: "Your ping", band: "ok" as Band, cause: "ok" as const, ms: null, reason: "checking…" }];

function Dot({ band, size = 8, className }: { band: Band | null; size?: number; className?: string }) {
  return <span className={cx(s.dot, className)} data-band={band ?? "unknown"} style={{ width: size, height: size }} aria-hidden />;
}

function Spark({ samples, at }: { samples: Sample[]; at: number | null }) {
  const slots = useMemo(() => (at === null ? new Array(10).fill(null) : sparkSlots(samples, at)), [samples, at]);
  return (
    <span className={s.spark} aria-hidden>
      {slots.map((x, i) => (x ? <span key={i} className={s.bar} data-band={x.band} style={{ height: `${3 + Math.round((x.h / 1000) * 11)}px` }} /> : <span key={i} className={s.gap} />))}
    </span>
  );
}

function RowView({ r, m, large, waiting }: { r: Row; m: JustMeModel; large: boolean; waiting: boolean }) {
  return (
    <div className={s.row} data-row={r.id} data-band={waiting ? "unknown" : r.band} title={waiting ? undefined : `${r.name} · ${r.reason}`}>
      <Dot band={waiting ? null : r.band} />
      <span className={s.line}>
        <span className={s.name}>{r.name}</span>
        <span className={s.reason}> · {r.reason}</span>
      </span>
      {large && <Spark samples={m.history[r.id as SeriesId] ?? []} at={m.at} />}
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<JustMeModel>) {
  const mode = useClockMode();
  const waiting = !m.check;
  const rows = m.check ? [...m.check.rows, m.check.ping] : WAITING;
  const large = ctx.size === "L";
  const note = m.check?.note ?? "";
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined} data-size={ctx.size}>
      {rows.map((r) => (
        <RowView key={r.id} r={r} m={m} large={large} waiting={waiting} />
      ))}
      {note && (
        <div className={s.note} data-tone={m.check?.verdict.tone ?? "ok"}>
          {note}
        </div>
      )}
      <div className={s.foot}>
        <span className={s.when}>{m.running ? "Checking…" : m.at !== null ? `Checked ${fmtClock(m.at, mode)}` : ""}</span>
        <button
          type="button"
          className={s.linkBtn}
          disabled={ctx.preview || m.running}
          data-no-drag=""
          onClick={(e) => {
            e.stopPropagation();
            void checkNow();
          }}
        >
          Check again
        </button>
      </div>
    </div>
  );
}

function Verdict({ model: m }: PartProps<JustMeModel>) {
  if (!m.check) return <span className={s.summary}>Checking…</span>;
  return (
    <span className={s.summary}>
      <Dot band={m.check.verdict.tone} size={6} className={s.sumDot} />
      {m.check.verdict.text}
    </span>
  );
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's JustMeWidget.qml holds the same)

/** Local time today at h:m — a sample reads the same all day ("Checked 6:00 PM"). */
function todayAt(h: number, min: number): number {
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}
const P = (status: number | null, ms: number | null): Probe => ({ status, ms });
const GOOD = { pings: [P(200, 40), P(200, 42), P(200, 45)], syncAgoMs: 5000, calls: P(200, 84), media: P(200, 51), tinhat: P(401, 30) };
/** Ten one-minute samples ending at `at`: `bands` oldest first (g ok p), ms per sample. */
function series(at: number, bands: string, ms: number[]): Sample[] {
  return [...bands].map((c, i) => ({ at: at - (bands.length - 1 - i) * 60_000, band: (c === "g" ? "good" : c === "o" ? "ok" : "poor") as Band, ms: c === "p" ? null : (ms[i] ?? 40) }));
}
function sample(input: typeof GOOD | null, hist: Partial<Record<SeriesId, [string, number[]]>> = {}, running = false): JustMeModel {
  const at = todayAt(18, 0);
  const check = input ? checkOf(input) : null;
  const h: Record<SeriesId, Sample[]> = { chat: [], calls: [], media: [], tinhat: [], ping: [] };
  if (check) {
    const base: Record<SeriesId, [string, number[]]> = {
      chat: ["gggggggggg", [38, 41, 40, 44, 39, 42, 40, 43, 41, 42]],
      calls: ["gggggggggg", [80, 90, 84, 86, 82, 88, 85, 83, 87, 84]],
      media: ["gggggggggg", [50, 48, 55, 52, 49, 51, 53, 50, 52, 51]],
      tinhat: ["gggggggggg", [30, 28, 32, 31, 29, 30, 33, 30, 31, 30]],
      ping: ["gggggggggg", [38, 41, 40, 44, 39, 42, 40, 43, 41, 42]],
      ...hist,
    };
    for (const k of Object.keys(base) as SeriesId[]) h[k] = series(at, base[k][0], base[k][1]);
  }
  return { check, at: check ? at : null, running, history: h };
}

export const justMe = defineWidget<JustMeModel>({
  id: "justMe",
  useModel,
  live: () => false,
  Summary: Verdict,
  HeaderExtra: Verdict,
  Body,
  hasData: (m) => m.check !== null,
  samples: {
    preview: () => sample(GOOD),
    good: () => sample(GOOD),
    slow: () => sample({ ...GOOD, pings: [P(200, 210), P(200, 230), P(200, 250)], calls: P(200, 1300) }, { ping: ["gggggooooo", [42, 44, 40, 41, 43, 210, 220, 240, 230, 230]], calls: ["gggggggooo", [84, 86, 90, 88, 85, 87, 90, 1100, 1250, 1300]] }),
    callsdown: () => sample({ ...GOOD, calls: P(null, null) }, { calls: ["gggggggppp", [84, 86, 90, 88, 85, 87, 90, 0, 0, 0]] }),
    error: () => sample({ ...GOOD, tinhat: P(502, 20) }, { tinhat: ["ggggggggpp", [30, 28, 32, 31, 29, 30, 33, 30, 0, 0]] }),
    stuck: () => sample({ ...GOOD, syncAgoMs: 180_000 }, { chat: ["gggggggopp", [38, 41, 40, 44, 39, 42, 40, 43, 0, 0]] }),
    alldown: () => sample({ pings: [P(null, null), P(null, null), P(null, null)], syncAgoMs: 200_000, calls: P(null, null), media: P(null, null), tinhat: P(null, null) }, { chat: ["ggggggpppp", []], calls: ["ggggggpppp", []], media: ["ggggggpppp", []], tinhat: ["ggggggpppp", []], ping: ["ggggggpppp", []] }),
    checking: () => sample(null, {}, true),
  },
});

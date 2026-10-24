// clocks/Clocks.tsx — Friends' clocks (contract WIDGETS.md §15, WIDGETS-UI.md §15; widgets W1, 2026-09-28): the local
// time of everyone who shares a room with you and shares their time zone (REACH A7: opt-out, on by default), sorted west
// to east, your own row highlighted, a sun by day and a moon at night (22:00–07:00). Header (M / L): the spread — your
// zone, then the furthest one ("PT · ET +3 h"). S / collapsed: faces and times on one line, one group per zone. L adds
// the weekday ("Tue") when a friend is already / still on another day. The times tick once a minute, only while the
// window is in view. The zones come with the presence read (`?tz=1` while this widget shows — runtime.ts wantZones);
// the offsets are the browser's (Intl), the rules shared (src/widgets/clocks.ts). You switched it off → "You're hidden ·
// Share again".
import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/core/matrix";
import { onWinState, winState } from "@/core/winstate";
import { Avatar, cx } from "@/ui";
import { messageUser } from "@/features/nav";
import { deviceZone, setTzShare, usePresenceStore, useTzStore, wantZones } from "@/features/presence";
import { fmtClock, useClockMode, type ClockMode } from "@/features/settings";
import { clockRows, spreadLabel, type ClockPerson, type ClockRow } from "@/widgets/clocks";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { nameNow, usePerson } from "../names";
import s from "./Clocks.module.css";

export const CLOCK_ROWS = { M: 5, L: 12 } as const;

export interface ClocksModel {
  /** the first read with zones is in */
  ready: boolean;
  me: string;
  myTz: string;
  rows: ClockRow[];
  spread: string;
  /** I switched sharing my zone off (the account data says share: false) */
  hidden: boolean;
  busy: boolean;
}

// ---- the offsets (the browser's time-zone data) ---------------------------------------------------------------------

const fmts = new Map<string, Intl.DateTimeFormat | null>();
/** A zone's offset from UTC in minutes at `now` (null = the browser doesn't know the zone). */
export function offsetOf(tz: string, now: number): number | null {
  let f = fmts.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    } catch {
      f = null;
    }
    fmts.set(tz, f);
  }
  if (!f) return null;
  const t = Math.floor(now / 60_000) * 60_000;
  const parts = f.formatToParts(t);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
  return Number.isFinite(asUtc) ? Math.round((asUtc - t) / 60_000) : null;
}

/** HH:MM of a row in the clock mode (12 h / 24 h / the system's). */
export const fmtMinutes = (minutes: number, mode: ClockMode) => fmtClock(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).getTime(), mode);

// ---- the model -------------------------------------------------------------------------------------------------------

/** `now`, stepped at every minute boundary while the window is in view (never while hidden). */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t = 0;
    const arm = () => {
      window.clearTimeout(t);
      if (winState() === "hidden") return;
      t = window.setTimeout(() => {
        setNow(Date.now());
        arm();
      }, 60_000 - (Date.now() % 60_000) + 20);
    };
    arm();
    const off = onWinState((st) => {
      if (st === "hidden") return window.clearTimeout(t);
      setNow(Date.now());
      arm();
    });
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, []);
  return now;
}

function useClocks(ctx: WidgetCtx): ClocksModel {
  const me = useSession().userId ?? "";
  const zones = usePresenceStore((st) => st.zones);
  const okAt = usePresenceStore((st) => st.okAt);
  const pref = useTzStore((st) => st.pref);
  const busy = useTzStore((st) => st.busy);
  const device = useTzStore((st) => st.device);
  useEffect(() => (ctx.preview ? undefined : wantZones()), [ctx.preview]);
  const now = useMinute();
  return useMemo(() => {
    const myTz = pref?.share && pref.tz ? pref.tz : device || deviceZone();
    const myOffset = offsetOf(myTz, now) ?? -new Date(now).getTimezoneOffset();
    const people: ClockPerson[] = Object.entries(zones).map(([id, tz]) => ({ id, name: nameNow(id), tz, offsetMin: offsetOf(tz, now) }));
    const rows = clockRows(people, me, myOffset, now);
    return { ready: okAt > 0, me, myTz, rows, spread: spreadLabel(rows, myTz, myOffset), hidden: pref?.share === false, busy };
  }, [zones, okAt, pref, device, me, now, busy]);
}

// ---- the parts ---------------------------------------------------------------------------------------------------------

/** Sun (day) / moon (night), 12 px — the same paths as the desktop's ClocksWidget.qml. */
export function DayNight({ night }: { night: boolean }) {
  return night ? (
    <svg className={s.icon} viewBox="0 0 12 12" aria-label="night" data-night="">
      <path d="M 7.5 1.2 A 5 5 0 1 0 10.8 8.2 A 4 4 0 0 1 7.5 1.2 Z" fill="var(--th-widget-clocks-night-icon)" />
    </svg>
  ) : (
    <svg className={s.icon} viewBox="0 0 12 12" aria-label="day" data-day="">
      <circle cx="6" cy="6" r="2.5" fill="var(--th-widget-clocks-day-icon)" />
      <path
        d="M 6 0.5 L 6 2 M 6 10 L 6 11.5 M 0.5 6 L 2 6 M 10 6 L 11.5 6 M 2.1 2.1 L 3.2 3.2 M 8.8 8.8 L 9.9 9.9 M 2.1 9.9 L 3.2 8.8 M 8.8 3.2 L 9.9 2.1"
        stroke="var(--th-widget-clocks-day-icon)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Row({ r, L, mode, enter, ctx }: { r: ClockRow; L: boolean; mode: ClockMode; enter: boolean; ctx: WidgetCtx }) {
  const who = usePerson(r.id);
  const time = fmtMinutes(r.minutes, mode);
  const zone = r.me ? r.label : `${r.label} ${r.diff}`;
  const open = () => !ctx.preview && !r.me && void messageUser(r.id);
  return (
    <div
      className={cx(s.row, enter && "tw-enter-down")}
      data-me={r.me ? "" : undefined}
      data-clock-row={r.id}
      role={r.me ? undefined : "button"}
      tabIndex={r.me || ctx.preview ? -1 : 0}
      title={`${who.name} · ${zone} · ${r.day ? `${r.day} ` : ""}${time}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <Avatar size={ctx.mobile ? 24 : 20} name={who.name} seed={r.id} imageSource={who.avatar} />
      <span className={s.name}>{who.name}</span>
      <span className={s.zone}>{zone}</span>
      <DayNight night={r.night} />
      {L && r.day && <span className={s.day}>{r.day}</span>}
      <span className={s.time}>{time}</span>
    </div>
  );
}

function HiddenLine({ m, ctx }: { m: ClocksModel; ctx: WidgetCtx }) {
  if (!m.hidden) return null;
  return (
    <div className={s.hidden} data-clocks-hidden="">
      <span className={s.hiddenDot} />
      <span>You're hidden ·</span>
      <button
        type="button"
        className={s.link}
        disabled={m.busy || ctx.preview}
        onClick={(e) => {
          e.stopPropagation();
          void setTzShare(true);
        }}
      >
        Share again
      </button>
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<ClocksModel>) {
  const L = ctx.size === "L";
  const mode = useClockMode();
  const max = L ? CLOCK_ROWS.L : CLOCK_ROWS.M;
  const shown = m.rows.slice(0, max);
  const fresh = useFreshIds(shown.map((r) => r.id));
  if (!m.ready) return <div className={s.empty}>Checking…</div>;
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {m.rows.length === 0 ? (
        <div className={s.empty}>No clocks yet</div>
      ) : (
        shown.map((r) => <Row key={r.id} r={r} L={L} mode={mode} enter={fresh.has(r.id)} ctx={ctx} />)
      )}
      {m.rows.length > shown.length && <div className={s.moreLine}>+{m.rows.length - shown.length} more</div>}
      <HiddenLine m={m} ctx={ctx} />
    </div>
  );
}

function Face({ id, size }: { id: string; size: number }) {
  const who = usePerson(id);
  return (
    <span className={s.face} title={who.name}>
      <Avatar size={size} name={who.name} seed={id} imageSource={who.avatar} />
    </span>
  );
}

/** The Small line's groups: one per zone in row order (people with the same offset together), your own zone left out
 *  while anyone else is listed (you know your own time). */
export function summaryGroups(rows: readonly ClockRow[]): { key: number; minutes: number; ids: string[] }[] {
  const groups: { key: number; minutes: number; ids: string[]; mine: boolean }[] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g.key === r.offsetMin) {
      g.ids.push(r.id);
      g.mine ||= r.me;
    } else groups.push({ key: r.offsetMin, minutes: r.minutes, ids: [r.id], mine: r.me });
  }
  const others = groups.filter((g) => !(g.mine && g.ids.length === 1));
  return (others.length ? others : groups).map(({ key, minutes, ids }) => ({ key, minutes, ids }));
}

/** Small / collapsed: the groups (up to 2 faces and the time each) on one line — a group that doesn't fit whole is
 *  left out (the line wraps into a clipped second line; the desktop: a clipped Flow). */
function Summary({ model: m, ctx }: PartProps<ClocksModel>) {
  const mode = useClockMode();
  if (!m.ready) return <span className={s.summaryText}>Checking…</span>;
  if (!m.rows.length) return <span className={s.summaryText}>{m.hidden ? "You're hidden" : "No clocks yet"}</span>;
  const groups = summaryGroups(m.rows);
  const size = ctx.mobile ? 18 : 16;
  return (
    <span className={s.summary}>
      {groups.map((g) => (
        <span key={g.key} className={s.group}>
          <span className={s.faces}>
            {g.ids.slice(0, 2).map((id) => (
              <Face key={id} id={id} size={size} />
            ))}
          </span>
          <span className={s.gtime}>{fmtMinutes(g.minutes, mode)}</span>
        </span>
      ))}
    </span>
  );
}

function Spread({ model: m }: PartProps<ClocksModel>) {
  if (!m.ready || !m.rows.length) return null;
  return (
    <span className={s.spread} data-clocks-spread="">
      {m.spread}
    </span>
  );
}

// ---- samples (a fixed moment and fixed offsets: every capture is the same, whatever the clock / zone) ----------------

const SP = (id: string) => `@${id}:sample.invalid`;
const SAMPLE_NOW = Date.UTC(2026, 8, 28, 20, 30); // 14:30 in Denver
function sample(opts: { many?: boolean; empty?: boolean; hidden?: boolean; loading?: boolean; alone?: boolean } = {}): ClocksModel {
  const me = SP("me");
  const P = (id: string, tz: string, off: number): ClockPerson => ({ id, name: nameNow(id), tz, offsetMin: off });
  let people: ClockPerson[] = opts.empty
    ? []
    : [P(opts.hidden ? "" : me, "America/Denver", -360), P(SP("ana"), "America/New_York", -240), P(SP("bo"), "America/Los_Angeles", -420), P(SP("cy"), "Europe/London", 60), P(SP("dee"), "America/New_York", -240)];
  if (opts.alone) people = [P(me, "America/Denver", -360)];
  if (opts.many)
    people.push(P(SP("eli"), "Asia/Tokyo", 540), P(SP("fay"), "Australia/Sydney", 600), P(SP("gus"), "America/Chicago", -300), P(SP("hal"), "Europe/Berlin", 120), P(SP("ivy"), "Asia/Kolkata", 330));
  people = people.filter((p) => p.id);
  const rows = clockRows(people, me, -360, SAMPLE_NOW);
  return { ready: !opts.loading, me, myTz: "America/Denver", rows, spread: spreadLabel(rows, "America/Denver", -360), hidden: !!opts.hidden, busy: false };
}

export const clocks = defineWidget<ClocksModel>({
  id: "clocks",
  useModel: useClocks,
  live: () => false,
  Summary,
  HeaderExtra: Spread,
  Body,
  hasData: (m) => m.ready && m.rows.length > 0,
  samples: {
    preview: () => sample(),
    data: () => sample(),
    many: () => sample({ many: true }),
    alone: () => sample({ alone: true }),
    hidden: () => sample({ hidden: true }),
    empty: () => sample({ empty: true }),
    loading: () => sample({ loading: true }),
  },
});

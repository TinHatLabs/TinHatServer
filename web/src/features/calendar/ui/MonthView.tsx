// MonthView.tsx — CalendarWindow.qml "MONTH" (CAL-24..31): nav row, weekday row, 6×7 grid with
// chips, main-game backdrops, today pill, selection / draft-day outlines. Phones get a compact grid
// with dots (the day agenda sits under it — agenda-first).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, useIsMobile, cx, useContentInk } from "@/ui";
import { useTipRef } from "./util";
import {
  DOW_SHORT,
  chipColor,
  chipTime,
  dayKey,
  dayKeyOf,
  fmtMonthYear,
  keyToDate,
  tint,
  weekStart,
  type CalEvent,
} from "../model/calendar";
import { goToday, isDirty, setDraft, shiftMonth, startNew, useCal } from "../calendarStore";
import s from "./Calendar.module.css";

export function useByDay(events: CalEvent[]) {
  return useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const ev of events) {
      if (!ev.effStart || ev.kind === "focus") continue;
      const k = dayKeyOf(ev.effStart);
      let l = m.get(k);
      if (!l) m.set(k, (l = []));
      l.push(ev);
    }
    return m;
  }, [events]);
}

export function useFocusRanges(events: CalEvent[]) {
  return useMemo(() => events.filter((e) => e.kind === "focus" && e.effStart && !e.canceled), [events]);
}

export function focusOn(ranges: CalEvent[], key: string): CalEvent | null {
  const d0 = keyToDate(key).getTime();
  const d1 = d0 + 86400000 - 1;
  for (const f of ranges) if (f.effStart <= d1 && (f.end || f.effStart) >= d0) return f;
  return null;
}

function NavButton({ icon, text, tip, onClick }: { icon?: string; text?: string; tip: string; onClick: () => void }) {
  const ref = useTipRef<HTMLButtonElement>(tip);
  return (
    <button ref={ref} type="button" className={cx(s.navBtn, text && s.todayBtn)} onClick={onClick} aria-label={tip}>
      {icon ? <Icon name={icon} size={24} staticOnly /> : text}
    </button>
  );
}

export function MonthView() {
  const mobile = useIsMobile();
  const events = useCal((x) => x.events);
  const viewYear = useCal((x) => x.viewYear);
  const viewMonth = useCal((x) => x.viewMonth);
  const selectedDay = useCal((x) => x.selectedDay);
  const selectedId = useCal((x) => x.selectedId);
  const editing = useCal((x) => x.editing);
  const draftDate = useCal((x) => x.draft.dDate);
  const canEdit = useCal((x) => x.canEdit);
  const byDay = useByDay(events);
  const ranges = useFocusRanges(events);
  const undated = events.filter((e) => !e.effStart).length;
  const first = weekStart();
  const days = useMemo(() => {
    const d1 = new Date(viewYear, viewMonth, 1);
    const off = (d1.getDay() - first + 7) % 7;
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) out.push(new Date(viewYear, viewMonth, 1 - off + i));
    return out;
  }, [viewYear, viewMonth, first]);
  const todayKey = dayKey(new Date());
  const gridRef = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [cellH, setCellH] = useState(120);
  const [cellW, setCellW] = useState(157);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = el.firstElementChild as HTMLElement | null;
      if (c) {
        setCellH(c.clientHeight);
        setCellW(c.clientWidth);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const chipCap = Math.max(1, Math.floor((cellH - 14 - 20 - 16) / 21));

  const clickDay = (key: string) => {
    useCal.setState({ selectedDay: key });
    if (useCal.getState().editing) setDraft({ dDate: key });
    else useCal.setState({ selectedId: "" });
  };

  return (
    <>
      <div className={s.monthTop}>
        <NavButton icon="go-previous-symbolic" tip="Previous month" onClick={() => shiftMonth(-1)} />
        <div className={s.monthTitle}>{fmtMonthYear(viewYear, viewMonth)}</div>
        <NavButton icon="go-next-symbolic" tip="Next month" onClick={() => shiftMonth(1)} />
        <NavButton text="Today" tip="Today" onClick={goToday} />
        <div className={s.fill} />
        {!mobile && undated > 0 && <span className={s.hint}>{undated + (undated === 1 ? " proposal" : " proposals") + " awaiting a time — see Upcoming"}</span>}
        {!mobile && canEdit && <span className={s.hint}>Double-click a day to schedule</span>}
      </div>
      {mobile && undated > 0 && <span className={cx(s.small, s.dim)}>{undated + (undated === 1 ? " proposal" : " proposals") + " awaiting a time — see Upcoming"}</span>}
      <div className={s.dow}>
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i}>{DOW_SHORT[(first + i) % 7]}</span>
        ))}
      </div>
      <div
        className={s.grid}
        ref={gridRef}
        role="grid"
        aria-label={fmtMonthYear(viewYear, viewMonth)}
        // phones: a horizontal swipe on the grid flips the month (← / → stay for everyone)
        onTouchStart={(e) => {
          if (!mobile || e.touches.length !== 1) return;
          swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          const s0 = swipe.current;
          swipe.current = null;
          if (!mobile || !s0 || e.changedTouches.length !== 1) return;
          const dx = e.changedTouches[0].clientX - s0.x;
          const dy = e.changedTouches[0].clientY - s0.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) shiftMonth(dx < 0 ? 1 : -1);
        }}
      >
        {days.map((d) => {
          const key = dayKey(d);
          const inMonth = d.getMonth() === viewMonth;
          const evs = byDay.get(key) ?? [];
          const sel = selectedDay === key;
          const draftDay = editing && draftDate === key;
          const main = focusOn(ranges, key);
          const isToday = key === todayKey;
          const mainStart = !!main && (d.getDay() === first || dayKeyOf(main.effStart) === key || d.getDate() === 1);
          return (
            <DayCell
              key={key}
              dayKey={key}
              day={d.getDate()}
              inMonth={inMonth}
              isToday={isToday}
              sel={sel}
              draftDay={draftDay}
              main={main}
              mainStart={mainStart}
              evs={evs}
              chipCap={chipCap}
              showTime={cellW > 96}
              selectedId={selectedId}
              mobile={mobile}
              onClick={() => clickDay(key)}
              onDouble={() => {
                if (!useCal.getState().editing && useCal.getState().canEdit) startNew(key);
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function DayCell(p: {
  dayKey: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  sel: boolean;
  draftDay: boolean;
  main: CalEvent | null;
  mainStart: boolean;
  evs: CalEvent[];
  chipCap: number;
  showTime: boolean;
  selectedId: string;
  mobile: boolean;
  onClick: () => void;
  onDouble: () => void;
}) {
  const ink = useContentInk();
  const [hover, setHover] = useState(false);
  const bg = p.sel
    ? hover
      ? "var(--th-calendar-day-selected-bg-hover)"
      : "var(--th-calendar-day-bg-selected)"
    : hover
      ? "var(--th-calendar-day-bg-hover)"
      : p.main
        ? tint(chipColor(p.main), p.inMonth ? 0.13 : 0.06)
        : undefined;
  const border = p.draftDay ? "2px solid var(--th-calendar-day-draft-border)" : p.sel ? "2px solid var(--th-calendar-day-border-selected)" : undefined;
  const shown = p.evs.slice(0, p.chipCap);
  return (
    <div
      className={cx(s.cell, !p.inMonth && s.cellOut)}
      role="gridcell"
      aria-selected={p.sel}
      data-day={p.dayKey}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      onClick={p.onClick}
      onDoubleClick={p.onDouble}
    >
      <div className={s.cellBg} style={{ background: bg, border }} />
      <div className={s.cellCol}>
        <span className={cx(s.dayNum, (p.isToday || p.sel) && s.bold, p.isToday && s.dayNumToday)}>{p.day}</span>
        {p.mobile ? (
          <div className={s.dots}>
            {p.evs.slice(0, 4).map((ev) => (
              <span key={ev.id} className={s.chipDot} style={{ background: chipColor(ev), opacity: ev.canceled ? 0.4 : 1 }} />
            ))}
          </div>
        ) : (
          <>
            {shown.map((ev) => (
              <div
                key={ev.id}
                className={s.chip}
                style={{ background: tint(chipColor(ev), ev.canceled ? 0.1 : 0.26), borderColor: p.selectedId === ev.id ? chipColor(ev) : "transparent" }}
                onClick={(e) => {
                  e.stopPropagation();
                  // Native closes the editor here without asking (a typed draft is lost — logged);
                  // with unsaved changes the web treats the click as a day click (sets the draft date).
                  if (isDirty()) return p.onClick();
                  useCal.setState({ selectedDay: p.dayKey, selectedId: ev.id, editing: false });
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <span className={s.chipDot} style={{ background: chipColor(ev) }} />
                <span className={s.chipText} style={{ textDecoration: ev.canceled ? "line-through" : undefined }}>
                  {ev.game ? ev.game : ev.title}
                </span>
                {!!ev.effStart && p.showTime && <span className={s.chipTime}>{chipTime(ev.effStart)}</span>}
              </div>
            ))}
            {p.evs.length > p.chipCap && <span className={s.more}>{"+" + (p.evs.length - p.chipCap) + " more" + (hover ? " — click the day" : "")}</span>}
          </>
        )}
      </div>
      {!p.mobile && p.mainStart && p.inMonth && p.main && (
        <span className={s.mainLabel} style={{ color: ink(chipColor(p.main)) }}>
          {p.main.game ? p.main.game : p.main.title}
        </span>
      )}
    </div>
  );
}

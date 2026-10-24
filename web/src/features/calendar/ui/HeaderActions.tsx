// HeaderActions.tsx — the calendar's pieces of RoomHeaderBar.qml (rendered by the chat area's
// header through r.roomHeaderActions): the next-up chip (CAL-02, RoomHeaderBar.qml:49-69,153-197),
// the Game Reel button (CAL-03) and the Calendar button (CAL-01). Order right-to-left in the
// native header: … Memories, Calendar, Game Reel, [chip] → registry orders 5 / 10 / 20.
import { useEffect, useRef, useState } from "react";
import { HeaderIconButton, Icon, cx, useIsMobile } from "@/ui";
import type { RoomScopedComponentProps } from "@/core/registry";
import { useTipRef } from "./util";
import { fmtTime, fmtDayLongMonShort, type CalEvent } from "../model/calendar";
import { useCal } from "../calendarStore";
import { useGames } from "../gamesStore";
import { openCalendar, openGameReel } from "../entry";
import s from "./Card.module.css";

const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RoomHeaderBar.qml relWhen: "now" / "today 7:00 PM" / "tomorrow 7:00 PM" / "Fri 7:00 PM" / "Oct 3". */
export function headerRelWhen(ms: number, nowMs = Date.now()): string {
  const now = new Date(nowMs);
  const d = new Date(ms);
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((t1 - t0) / 86400000);
  const time = fmtTime(ms);
  if (ms <= nowMs) return "now";
  if (diff === 0) return "today " + time;
  if (diff === 1) return "tomorrow " + time;
  if (diff < 7) return DOW3[d.getDay()] + " " + time;
  return MON3[d.getMonth()] + " " + d.getDate();
}

export function nextUpText(ev: CalEvent): string {
  const when = ev.effStart ? headerRelWhen(ev.effStart) : "vote";
  return (ev.game ? ev.game : ev.title) + " · " + when + (ev.rsvp.yes.length > 0 ? " · " + ev.rsvp.yes.length + " in" : "");
}

export function nextUpLong(ev: CalEvent): string {
  return ev.effStart ? fmtDayLongMonShort(ev.effStart) + " · " + fmtTime(ev.effStart) : "Time to be decided — vote on the calendar";
}

/** Hide the chip when the room header is ≤ 34 gridUnit (612 px) wide (TH-NAV-23). */
function useHeaderWide(ref: React.RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // the header = the closest element marked as the room header, else the actions row's parent
    const host = (el.closest("[data-room-header]") as HTMLElement | null) ?? el.parentElement?.parentElement ?? el.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(() => setWide(host.getBoundingClientRect().width > 612));
    ro.observe(host);
    setWide(host.getBoundingClientRect().width > 612);
    return () => ro.disconnect();
  }, [ref]);
  return wide;
}

export function NextUpChip(p: RoomScopedComponentProps) {
  const mobile = useIsMobile();
  return mobile ? <NextUpRow {...p} /> : <NextUpChipDesktop {...p} />;
}

/** Phones: the header has no room for the chip — the room header's ⋮ sheet lists it as a two-line row
 *  (game/title, "Next up · today 7:00 PM · N in"), tap → the calendar. */
function NextUpRow(_: RoomScopedComponentProps) {
  const ev = useCal((x) => (x.upcoming.length > 0 ? x.upcoming[0] : null));
  if (!ev) return null;
  return (
    <button type="button" className={s.nextUpRow} onClick={() => openCalendar()} aria-label={"Next up: " + nextUpText(ev)} data-calendar-chip="row">
      <Icon name="view-calendar-symbolic" size={22} color="var(--th-header-next-up-icon)" />
      {/* divs, not spans: the sheet's generic rules target the header buttons' span children */}
      <div className={s.nextUpRowText}>
        <div className={s.nextUpRowTitle}>{ev.game ? ev.game : ev.title}</div>
        <div className={s.nextUpRowSub}>{"Next up · " + (ev.effStart ? headerRelWhen(ev.effStart) : "time to be voted") + (ev.rsvp.yes.length > 0 ? " · " + ev.rsvp.yes.length + " in" : "")}</div>
      </div>
    </button>
  );
}

function NextUpChipDesktop(_: RoomScopedComponentProps) {
  const ev = useCal((x) => (x.upcoming.length > 0 ? x.upcoming[0] : null));
  const probe = useRef<HTMLSpanElement>(null);
  const wide = useHeaderWide(probe);
  return (
    <span ref={probe} className={s.chipHost} data-calendar-chip>
      {ev && wide && <NextUpButton ev={ev} />}
    </span>
  );
}

/** The chip itself — its own component so the tooltip hook binds to the button when it mounts (it
 *  appears only once an event is known and the header is wide enough; bound in the parent, the hook
 *  ran before the button existed and the "<title>\n<dddd, MMM d · h:mm AP>" tooltip never showed). */
function NextUpButton({ ev }: { ev: CalEvent }) {
  const [hover, setHover] = useState(false);
  const tipRef = useTipRef<HTMLButtonElement>(ev.title + "\n" + nextUpLong(ev), { delay: 400 });
  return (
    <button
      ref={tipRef}
      type="button"
      className={cx(s.nextUp, hover && s.nextUpHover)}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      onClick={() => openCalendar()}
      aria-label={"Next up: " + nextUpText(ev)}
    >
      <Icon name="view-calendar-symbolic" size={14} color="var(--th-header-next-up-icon)" hovered={hover} />
      <span className={s.nextUpText}>{nextUpText(ev)}</span>
    </button>
  );
}

export function GameReelButton(_: RoomScopedComponentProps) {
  const open = useGames((x) => x.windowOpen);
  return <HeaderIconButton iconName="applications-games-symbolic" accent={open} tip="What do we play tonight? — the game reel" onClick={toggleGameReelOrOpen} aria-label="Game reel" />;
}

export function CalendarButton(_: RoomScopedComponentProps) {
  const open = useCal((x) => x.windowOpen);
  return <HeaderIconButton iconName="view-calendar-symbolic" accent={open} tip="Calendar — what we're playing and when, who's in" onClick={toggleCalendarOrOpen} aria-label="Calendar" />;
}

// Native: the header buttons "open/raise" (Main.qml openCalendar / openGameReel); they never
// close an open window — a second click raises it.
function toggleCalendarOrOpen() {
  openCalendar();
}
function toggleGameReelOrOpen() {
  openGameReel();
}

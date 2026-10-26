// CalendarWindow.tsx — CalendarWindow.qml as an in-app AppWindow (CAL-10..23): header (icon,
// title | space picker, pill tabs, reminders bell, busy spinner, New event), the four banners,
// the Month / Upcoming / Games stack and the 400 px side pane. Phones: header wraps, the grid is
// compact with the day agenda under it, the event detail and the editor are full-screen sheets.
import { useEffect, useRef, useState } from "react";
import { BusyIndicator, Button, ComboBox, ConfirmDialog, GlowButton, Icon, cx, useIsMobile } from "@/ui";
import { useAppWindow } from "@/app/WindowHost";
import { useBackToClose } from "@/ui/backStack";
import { useTipRef } from "./util";
import { whenTextFor, type CalEvent } from "../model/calendar";
import { applyReminders, clearError, deleteEvent, inviteMissing, isDirty, openContainer, openEvent, refresh, setWindowOpen, startNew, useCal, type Tab } from "../calendarStore";
import { openWindow } from "@/core/bus";
import { MonthView } from "./MonthView";
import { GamesView, UpcomingView } from "./ListViews";
import { EditorFooter, SidePaneContent, SideScroll, setCanceled, useEditorRefs, type PaneActions } from "./SidePane";
import { requestNotifyPermission } from "../reminders";
import s from "./Calendar.module.css";

/** When the sheet effect last called history.back() (the traversal is async). */

const TABS: Array<{ k: Tab; l: string; i: string }> = [
  { k: "month", l: "Month", i: "view-calendar-month-symbolic" },
  { k: "upcoming", l: "Upcoming", i: "view-calendar-list-symbolic" },
  { k: "games", l: "Games & rules", i: "applications-games-symbolic" },
];

function TabButton({ t, on }: { t: (typeof TABS)[number]; on: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      className={cx(s.tab, on && s.tabOn)}
      onClick={() => useCal.setState({ tab: t.k })}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      aria-pressed={on}
    >
      <Icon name={t.i} size={16} color={on ? "var(--th-calendar-tab-icon-active)" : "var(--th-calendar-tab-icon)"} hovered={hover} active={on} />
      {t.l}
    </button>
  );
}

function Bell() {
  const on = useCal((x) => x.remindersOn);
  const ref = useTipRef<HTMLButtonElement>(on ? "Reminders on — 30 min before events you're going to" : "Reminders off");
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.bell, on && s.bellOn)}
      aria-pressed={on}
      aria-label="Reminders"
      onClick={() => {
        applyReminders(!on);
        if (!on) void requestNotifyPermission();
      }}
    >
      <Icon name={on ? "notifications" : "notifications-disabled-symbolic"} size={24} staticOnly />
    </button>
  );
}

function SpacePicker() {
  const containers = useCal((x) => x.containers);
  const cid = useCal((x) => x.containerId);
  const ref = useTipRef<HTMLSpanElement>("Which space's calendar to show");
  const mobile = useIsMobile();
  return (
    <span ref={ref} style={{ width: mobile ? "auto" : 220, flex: mobile ? "1 1 auto" : "none", minWidth: 0 }}>
      <ComboBox
        style={{ width: "100%", height: 34 }}
        model={containers.map((c) => c.label)}
        currentIndex={containers.findIndex((c) => c.id === cid)}
        onActivated={(i) => containers[i] && openContainer(containers[i].id)}
        aria-label="Which space's calendar to show"
      />
    </span>
  );
}

/** Props from openWindow("calendar", {...}) — other features may open it through the bus directly. */
export interface CalendarWindowProps {
  label?: string;
  containerId?: string;
  eventId?: string;
}

export function CalendarWindow(props: CalendarWindowProps) {
  const win = useAppWindow();
  // openWindow("calendar", {containerId, eventId}) from anywhere = entry.openCalendar(...)
  useEffect(() => {
    if (!props.containerId && !props.eventId) return;
    if (props.containerId && props.eventId) openEvent(props.containerId, props.eventId);
    else if (props.containerId) openContainer(props.containerId);
    else if (props.eventId) openEvent(useCal.getState().containerId, props.eventId);
    // keep the title's container label (the props replaced the ones entry.ts set)
    openWindow("calendar", { label: useCal.getState().label });
  }, [props.containerId, props.eventId]);
  const mobile = useIsMobile();
  const cid = useCal((x) => x.containerId);
  const label = useCal((x) => x.label);
  const containers = useCal((x) => x.containers);
  const tab = useCal((x) => x.tab);
  const busy = useCal((x) => x.busy);
  const editing = useCal((x) => x.editing);
  const selectedId = useCal((x) => x.selectedId);
  const roomId = useCal((x) => x.roomId);
  const unjoined = useCal((x) => x.unjoinedParent);
  const missing = useCal((x) => x.missing);
  const canInvite = useCal((x) => x.canInvite);
  const sourceLabel = useCal((x) => x.sourceLabel);
  const canEdit = useCal((x) => x.canEdit);
  const lastError = useCal((x) => x.lastError);
  const refs = useEditorRefs();
  const [callOff, setCallOff] = useState<CalEvent | null>(null);
  const [del, setDel] = useState<CalEvent | null>(null);
  const [discard, setDiscard] = useState(false);

  // open/close bookkeeping + refresh on show, every 30 s while visible (CAL-23)
  useEffect(() => {
    setWindowOpen(true);
    const t = setInterval(() => useCal.getState().windowOpen && refresh(), 30000);
    return () => {
      clearInterval(t);
      setWindowOpen(false);
    };
  }, []);

  // busy spinner only after 700 ms (TH-CAL-20)
  const [busyLong, setBusyLong] = useState(false);
  useEffect(() => {
    if (!busy) return setBusyLong(false);
    const t = setTimeout(() => setBusyLong(true), 700);
    return () => clearTimeout(t);
  }, [busy]);

  const actions: PaneActions = {
    askCallOff: (ev) => setCallOff(ev),
    askDelete: (ev) => setDel(ev),
    askDiscard: () => setDiscard(true),
  };

  // Escape order (CAL-22): editor → close (confirm if dirty); game form; deselect; close. Scoped
  // to this window (the root takes focus on mount / pointer-down) so Escape in the reel stays there.
  const dialogs = !!callOff || !!del || discard;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  // When the focused control goes away with the pane it lived in (editor Cancel / Save / Escape, a
  // deselect, the game form closing) focus falls to <body> and the next Escape would never reach this
  // window — take it back so the Escape chain keeps working (native: the window keeps key focus).
  const gameEditing = useCal((x) => x.gameEditing);
  useEffect(() => {
    const t = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) rootRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(t);
  }, [editing, selectedId, gameEditing, tab]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || dialogs) return;
    const st = useCal.getState();
    if (st.editing) {
      if (isDirty()) setDiscard(true);
      else useCal.setState({ editing: false });
    } else if (st.gameEditing) useCal.setState({ gameEditing: false });
    else if (st.selectedId) useCal.setState({ selectedId: "" });
    else win.close();
    e.preventDefault();
    e.stopPropagation();
  };

  const multi = containers.length > 1;
  const showSide = tab !== "games";
  const paneOpenMobile = mobile && (editing || !!selectedId);

  // Phones: the event / editor sheet is a level of the shared back stack (ui/backStack, level 1 — above
  // the calendar's own AppWindow sheet): the browser / Android back button closes it; a dirty editor
  // asks "Discard this event?" instead and keeps its entry.
  useBackToClose(
    paneOpenMobile,
    () => {
      const st = useCal.getState();
      if (st.editing && isDirty()) {
        setDiscard(true);
        return false;
      }
      if (st.editing) useCal.setState({ editing: false, selectedId: "" });
      else useCal.setState({ selectedId: "" });
    },
    1,
  );

  const sidePane = (
    <div className={s.side}>
      {mobile ? (
        <SidePaneContent actions={actions} fieldRefs={refs} />
      ) : (
        <>
          <SideScroll>
            <SidePaneContent actions={actions} fieldRefs={refs} />
          </SideScroll>
          {editing && <EditorFooter refs={refs} actions={actions} />}
        </>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || !(e.target as HTMLElement).closest("input,textarea,button,[tabindex]")) rootRef.current?.focus({ preventScroll: true });
      }}
      className={cx(s.win, mobile && s.mobile)}
      style={{ outline: "none" }}
      data-testid="calendar-window"
    >
      <div className={s.header}>
        {/* native: width/height 26 are ignored inside the RowLayout → the icon lays out at its 22 px implicit size */}
        <Icon name="view-calendar-symbolic" size={22} color="var(--th-calendar-header-icon)" active />
        {!multi && <span className={s.headerTitle}>{label || "Calendar"}</span>}
        {multi && <SpacePicker />}
        {!mobile && <div className={s.fill} />}
        <div className={s.tabs}>
          {TABS.map((t) => (
            <TabButton key={t.k} t={t} on={tab === t.k} />
          ))}
        </div>
        {!mobile && <div className={s.fill} />}
        <Bell />
        {busy && busyLong && <BusyIndicator size={22} color="var(--th-loader-spinner-fg)" />}
        {mobile ? (
          <GlowButton icon="appointment-new-symbolic" text="New" disabled={!cid} onClick={() => startNew(useCal.getState().selectedDay)} />
        ) : (
          <GlowButton icon="appointment-new-symbolic" text="New event" disabled={!cid} onClick={() => startNew(useCal.getState().selectedDay)} />
        )}
      </div>
      <div className={s.sep} />
      {unjoined && cid === roomId && (
        <div className={cx(s.banner, s.bannerUnjoined)}>
          This room belongs to a space you haven't joined, so this is the room's own calendar. The squad calendar lives in the space — ask an admin to invite you (right-click the space → Invite
          people).
        </div>
      )}
      {missing.length > 0 && cid !== roomId && cid && (
        <div className={cx(s.banner, s.bannerMissing)}>
          <span>
            {missing.length +
              (missing.length === 1 ? " person" : " people") +
              " in " +
              sourceLabel +
              (missing.length === 1 ? " isn't" : " aren't") +
              " in " +
              label +
              " yet, so they can't see this calendar: " +
              missing.map((p) => p.name).join(", ") +
              (canInvite ? "" : ". A space admin can invite them.")}
          </span>
          {canInvite && <Button text={"Invite them to " + label} icon="list-add-user" onClick={() => void inviteMissing()} />}
        </div>
      )}
      {!canEdit && cid && !busy && (
        <div className={cx(s.banner, s.bannerHint)}>Scheduling here unlocks the first time a space admin opens this space in Tin Hat 10 — ask an admin to open it once.</div>
      )}
      {lastError && (
        <div className={cx(s.banner, s.bannerError)} role="alert">
          <span>{lastError}</span>
          <button type="button" className={s.clearTool} style={{ width: 24, height: 24 }} onClick={clearError} aria-label="Dismiss">
            <Icon name="window-close-symbolic" size={14} staticOnly />
          </button>
        </div>
      )}
      <div className={s.body}>
        <div className={s.stack} data-tab={tab} style={tab === "month" && !mobile ? undefined : undefined}>
          {tab === "month" && <MonthView />}
          {tab === "upcoming" && <UpcomingView />}
          {tab === "games" && <GamesView />}
        </div>
        {showSide && !paneOpenMobile && sidePane}
      </div>
      {paneOpenMobile && (
        <div className={s.sheet} role="dialog" aria-label={editing ? "Event editor" : "Event"}>
          <div className={s.sheetHead}>
            <button
              type="button"
              className={s.navBtn}
              style={{ background: "transparent" }}
              aria-label="Back"
              onClick={() => {
                if (editing) (isDirty() ? setDiscard(true) : useCal.setState({ editing: false }));
                else useCal.setState({ selectedId: "" });
              }}
            >
              <Icon name="go-previous-symbolic" size={24} staticOnly />
            </button>
            <span className={cx(s.h3, s.elide)}>{editing ? (useCal.getState().draft.dId ? "Edit event" : "New event") : "Event"}</span>
          </div>
          <div className={s.sheetBody}>
            <SidePaneContent actions={actions} fieldRefs={refs} />
          </div>
          {editing && <EditorFooter refs={refs} actions={actions} />}
        </div>
      )}
      <ConfirmDialog
        className={mobile ? s.bottomSheet : undefined}
        open={!!del}
        onClose={() => setDel(null)}
        dialogTitle="Remove this event?"
        message="It disappears from everyone's calendar. RSVPs go with it."
        confirmText="Remove"
        destructive
        onConfirmed={() => {
          if (del) void deleteEvent(del.id, whenTextFor(del));
          useCal.setState({ selectedId: "" });
        }}
      />
      <ConfirmDialog
        className={mobile ? s.bottomSheet : undefined}
        open={!!callOff}
        onClose={() => setCallOff(null)}
        dialogTitle="Call it off?"
        message="It stays on the calendar, struck through, with everyone's RSVPs kept — so it can go back on. The chat card will say CANCELLED."
        confirmText="Call it off"
        destructive
        onConfirmed={() => callOff && setCanceled(callOff, true)}
      />
      <ConfirmDialog
        className={mobile ? s.bottomSheet : undefined}
        open={discard}
        onClose={() => setDiscard(false)}
        dialogTitle="Discard this event?"
        message="You have unsaved changes. Keep editing, or throw them away?"
        confirmText="Discard"
        cancelText="Keep editing"
        destructive
        onConfirmed={() => useCal.setState({ editing: false })}
      />
    </div>
  );
}

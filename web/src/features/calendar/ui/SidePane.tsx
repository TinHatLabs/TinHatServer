// SidePane.tsx — CalendarWindow.qml side pane: EDITOR (CAL-50..58), EVENT DETAIL (CAL-41..49)
// and DAY AGENDA (CAL-40), plus the fixed editor footer (TH-CAL-15). DECISIONS D3/D6 applied:
// the pill row wraps and the Edit / Call off / Remove buttons always stay visible; RSVP thirds are
// equal; "Schedule it" stays disabled for a proposal without a time (native loses the draft).
import { useEffect, useRef, type ReactNode } from "react";
import { Avatar, Button, CheckBox, ComboBox, EmptyState, GlowButton, Icon, ScrollArea, TextArea, TextField, cx, useIsMobile, useContentInk } from "@/ui";
import { useRoomName } from "@/core/matrix";
import { useTipRef } from "./util";
import {
  DURATIONS,
  KINDS,
  chipColor,
  durationIndex,
  fmtDay,
  fmtDayLong,
  fmtMinutes,
  fmtTime,
  keyToDate,
  kindColor,
  kindHint,
  kindLabel,
  relDay,
  tint,
  tz,
  validKey,
  whenLine,
  whenTextFor,
  type CalEvent,
} from "../model/calendar";
import { getDraftContainer, getEditorGen, isDirty, lockOption, mineOf, rsvp, saveEvent, setDraft, startEdit, startNew, useCal, useMine, type SavePayload } from "../calendarStore";
import { focusOn, useByDay, useFocusRanges } from "./MonthView";
import { openGameReel } from "../entry";
import s from "./Calendar.module.css";

const TIME_SLOTS = Array.from({ length: 96 }, (_, i) => fmtMinutes(i * 15));
const myStatus = (ev: CalEvent | null) => (ev ? ev.my.status || "" : "");

export interface PaneActions {
  askCallOff: (ev: CalEvent) => void;
  askDelete: (ev: CalEvent) => void;
  askDiscard: () => void;
}

// ---- commit (CalendarWindow.qml commitDraft / setCanceled / setRsvp / toggleVote) ------------------

export function commitDraft(focus: { title?: () => void; date?: () => void; endDate?: () => void }): void {
  const { draft: d, roomId } = useCal.getState();
  if (!d.dTitle.trim()) return focus.title?.();
  if (!validKey(d.dDate) && d.dKind !== "proposal") return focus.date?.();
  let start = 0;
  let end = 0;
  if (d.dKind === "focus") {
    if (!validKey(d.dEndDate)) return focus.endDate?.();
    start = keyToDate(d.dDate, 0).getTime();
    end = keyToDate(d.dEndDate, 0).getTime() + 86400000 - 1;
    if (end < start) return focus.endDate?.();
  } else if (d.dKind !== "proposal") {
    start = keyToDate(d.dDate, d.dTime).getTime();
    end = d.dDuration > 0 ? start + d.dDuration * 60000 : 0;
  }
  const opts = d.dOptions.map((o) => {
    const os = keyToDate(o.date, o.time).getTime();
    return { start: os, end: d.dDuration > 0 ? os + d.dDuration * 60000 : 0 };
  });
  if (d.dKind === "proposal" && d.dChosen >= 0 && opts[d.dChosen]) {
    start = opts[d.dChosen].start;
    end = opts[d.dChosen].end;
  }
  const obj: SavePayload = {
    id: d.dId,
    title: d.dTitle.trim(),
    game: d.dGame.trim(),
    kind: d.dKind,
    start,
    end,
    allDay: false,
    notes: d.dNotes,
    rules: d.dRules,
    freePlay: d.dFreePlay,
    joinIfYouCan: d.dJoin,
    options: opts,
    chosen: d.dKind === "proposal" ? d.dChosen : -1,
    announceWhen:
      d.dKind === "focus"
        ? fmtDay(start) + " – " + fmtDay(end)
        : start > 0
          ? fmtDay(start) + " · " + fmtTime(start) + (end > start ? " – " + fmtTime(end) : "") + " " + tz(start)
          : "vote for a time: " + opts.map((o) => fmtDay(o.start) + " " + fmtTime(o.start)).join(" / ") + " " + tz(),
  };
  if (d.dAnnounce && roomId) obj.announceRoom = roomId;
  if (roomId) obj.announceHint = roomId;
  // The editor closes at once like native — but a failed write no longer LOSES the draft (native
  // bug, docs/native-bugs/calendar.md): it re-opens with what was typed, the error banner above it.
  const kept = d;
  const cid = getDraftContainer();
  const gen = getEditorGen();
  void saveEvent(obj, cid).then((id) => {
    const st = useCal.getState();
    // only while nothing moved on: same window session, same container, no newer editor opened
    if (!id && !st.editing && st.windowOpen && st.containerId === cid && getEditorGen() === gen) useCal.setState({ editing: true, draft: kept, draftBase: "" });
  });
  useCal.setState({ editing: false });
}

export function setCanceled(ev: CalEvent, on: boolean): void {
  const roomId = useCal.getState().roomId;
  const obj: SavePayload = {
    id: ev.id,
    title: ev.title || "",
    game: ev.game || "",
    kind: ev.kind || "session",
    start: ev.start || 0,
    end: ev.end || 0,
    allDay: !!ev.allDay,
    notes: ev.notes || "",
    rules: ev.rules || "",
    freePlay: !!ev.freePlay,
    joinIfYouCan: !!ev.joinIfYouCan,
    options: (ev.options || []).map((o) => ({ start: o.start || 0, end: o.end || 0 })),
    chosen: ev.chosen ?? -1,
    canceled: on,
    announceWhen: whenTextFor(ev),
  };
  if (roomId) obj.announceHint = roomId;
  void saveEvent(obj);
}

export function setRsvp(ev: CalEvent, status: string): void {
  const m = mineOf(ev); // a still-pending answer counts (quick vote → Maybe keeps the vote)
  const st = (m.status || "") === status ? "" : status;
  void rsvp(ev.id, st, m.options);
}

function toggleVote(ev: CalEvent, idx: number): void {
  const m = mineOf(ev);
  const arr = [...m.options];
  const i = arr.indexOf(idx);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(idx);
  void rsvp(ev.id, m.status || "", arr);
}

export const canSchedule = () => {
  const d = useCal.getState().draft;
  if (!d.dTitle.trim()) return false;
  // D6: a proposal needs a proposed time (native enables it with only a valid date, then Rust
  // refuses and the draft is lost — calendar-games-error-banner).
  if (d.dKind === "proposal") return d.dOptions.length > 0;
  if (d.dKind === "focus") return validKey(d.dDate) && validKey(d.dEndDate);
  return validKey(d.dDate);
};

// ---- the pane ----------------------------------------------------------------------------------

export function SidePaneContent({ actions, fieldRefs }: { actions: PaneActions; fieldRefs: EditorRefs }) {
  const editing = useCal((x) => x.editing);
  const selected = useCal((x) => (x.selectedId ? x.events.find((e) => e.id === x.selectedId) ?? null : null));
  if (editing) return <Editor refs={fieldRefs} />;
  if (selected) return <Detail ev={selected} actions={actions} />;
  return <DayAgenda />;
}

export interface EditorRefs {
  title: React.RefObject<HTMLInputElement | null>;
  date: React.RefObject<HTMLInputElement | null>;
  endDate: React.RefObject<HTMLInputElement | null>;
}

export function useEditorRefs(): EditorRefs {
  return { title: useRef<HTMLInputElement>(null), date: useRef<HTMLInputElement>(null), endDate: useRef<HTMLInputElement>(null) };
}

export function EditorFooter({ refs, actions }: { refs: EditorRefs; actions: PaneActions }) {
  const d = useCal((x) => x.draft);
  void d;
  const ok = canSchedule();
  return (
    <div className={s.footer}>
      <div className={s.fill} />
      <Button text="Cancel" onClick={() => (isDirty() ? actions.askDiscard() : useCal.setState({ editing: false }))} />
      <GlowButton
        text={d.dId ? "Save changes" : "Schedule it"}
        disabled={!ok}
        onClick={() => commitDraft({ title: () => refs.title.current?.focus(), date: () => refs.date.current?.focus(), endDate: () => refs.endDate.current?.focus() })}
      />
    </div>
  );
}

function TipSpan({ tip, children, style, className }: { tip: string; children: ReactNode; style?: React.CSSProperties; className?: string }) {
  const ref = useTipRef<HTMLSpanElement>(tip);
  return (
    <span ref={ref} style={style} className={className}>
      {children}
    </span>
  );
}

function KindButton({ k, label, on }: { k: string; label: string; on: boolean }) {
  const ref = useTipRef<HTMLSpanElement>(kindHint(k), { delay: 300 });
  return (
    <span ref={ref}>
      <Button text={label} aria-pressed={on} className={s.kindBtn} onClick={() => setDraft({ dKind: k })} />
    </span>
  );
}

function Editor({ refs }: { refs: EditorRefs }) {
  const d = useCal((x) => x.draft);
  const games = useCal((x) => x.games);
  const roomId = useCal((x) => x.roomId);
  const focusSeq = useCal((x) => x.focusTitleSeq);
  const roomName = useRoomLabel(roomId);
  const gameNames = games.map((g) => g.name);
  // phones: the grid is behind the editor sheet, so "click a day in the grid" can't work there — the date
  // fields become the OS date picker instead (its value is the same YYYY-MM-DD the draft keeps)
  const mobile = useIsMobile();
  const dateType = mobile ? "date" : "text";
  const dateW = mobile ? { flex: "1 1 0", minWidth: 0 } : { width: 120, flex: "none" };
  useEffect(() => {
    refs.title.current?.focus();
  }, [focusSeq, refs.title]);
  const submit = () => commitDraft({ title: () => refs.title.current?.focus(), date: () => refs.date.current?.focus(), endDate: () => refs.endDate.current?.focus() });
  const gi = d.dGame ? gameNames.findIndex((n) => n.toLowerCase() === d.dGame.toLowerCase()) : -1;
  return (
    <div className={s.section}>
      <h3 className={cx(s.h3, s.hideOnMobile)}>{d.dId ? "Edit event" : "New event"}</h3>
      <TextField ref={refs.title} placeholder="Title — e.g. Valheim 1.0 launch night" value={d.dTitle} onChange={(e) => setDraft({ dTitle: e.target.value })} onAccepted={submit} />
      <TipSpan tip="Which game — pick one or type a new one" style={{ display: "block" }}>
        <ComboBox
          style={{ width: "100%" }}
          editable
          model={gameNames}
          currentIndex={gi}
          editText={d.dGame}
          onEditTextChanged={(t) => setDraft({ dGame: t })}
          onActivated={(i) => setDraft({ dGame: gameNames[i] || "" })}
          aria-label="Game"
        />
      </TipSpan>
      <span className={cx(s.small, s.dim)}>What kind of night</span>
      <div className={s.kindFlow}>
        {KINDS.map((k) => (
          <KindButton key={k.k} k={k.k} label={k.label} on={d.dKind === k.k} />
        ))}
      </div>
      <span className={cx(s.small, s.dim, s.wrap)}>{kindHint(d.dKind)}</span>
      {d.dKind === "focus" ? (
        <div className={s.row}>
          <TextField type={dateType} aria-label="First day" style={dateW} className={cx(!validKey(d.dDate) && s.invalid)} placeholder="first day" value={d.dDate} onChange={(e) => setDraft({ dDate: e.target.value })} />
          <span className={s.dim}>to</span>
          <TextField
            ref={refs.endDate}
            type={dateType}
            aria-label="Last day"
            style={dateW}
            className={cx(!validKey(d.dEndDate) && s.invalid)}
            placeholder="last day"
            value={d.dEndDate}
            onChange={(e) => setDraft({ dEndDate: e.target.value })}
          />
          {!mobile && <span className={cx(s.small, s.dim, s.elide)}>Click days in the grid to set the first day</span>}
        </div>
      ) : (
        <>
          <div className={s.row}>
            <TipSpan tip="Or click a day in the grid" style={{ flex: "none" }}>
              <TextField ref={refs.date} type={dateType} aria-label="Date" style={{ width: mobile ? 132 : 120 }} className={cx(!validKey(d.dDate) && s.invalid)} placeholder="YYYY-MM-DD" value={d.dDate} onChange={(e) => setDraft({ dDate: e.target.value })} />
            </TipSpan>
            <ComboBox style={{ flex: "1 1 auto", minWidth: 0 }} model={TIME_SLOTS} currentIndex={Math.floor(d.dTime / 15)} onActivated={(i) => setDraft({ dTime: i * 15 })} aria-label="Time" />
            <ComboBox style={{ width: 120, flex: "none" }} model={DURATIONS.map((x) => x.label)} currentIndex={durationIndex(d.dDuration)} onActivated={(i) => setDraft({ dDuration: DURATIONS[i].m })} aria-label="Duration" />
          </div>
          <span className={cx(s.small, s.dim)}>
            {validKey(d.dDate) ? fmtDayLong(keyToDate(d.dDate).getTime()) + " · " + TIME_SLOTS[Math.floor(d.dTime / 15)] + " " + tz() : "Pick a valid date"}
          </span>
        </>
      )}
      {d.dKind === "proposal" && (
        <div className={s.section} style={{ padding: 0, gap: 4 }}>
          <span className={cx(s.small, s.dim)}>Proposed times (people vote, you lock one in)</span>
          {d.dOptions.map((o, i) => (
            <div key={i} className={s.row}>
              <span className={s.fill}>{i + 1 + ".  " + fmtDay(keyToDate(o.date, o.time).getTime()) + " · " + TIME_SLOTS[Math.floor(o.time / 15)]}</span>
              <RemoveOption voted={(o.voted ?? 0) > 0} onClick={() => removeOption(i)} />
            </div>
          ))}
          <div>
            <Button text="Add the date + time above as an option" icon="list-add-symbolic" disabled={!validKey(d.dDate)} onClick={addOption} />
          </div>
        </div>
      )}
      {d.dKind !== "freeplay" && d.dKind !== "focus" && <CheckBox text="Free play is allowed outside this" checked={d.dFreePlay} onToggled={(v) => setDraft({ dFreePlay: v })} />}
      {d.dKind !== "focus" && <CheckBox text="Join if you can (no pressure)" checked={d.dJoin} onToggled={(v) => setDraft({ dJoin: v })} />}
      <TextArea style={{ minHeight: 90 }} autoGrow={false} placeholder="Notes — what we're doing, what to bring, voice channel…" value={d.dNotes} onChange={(e) => setDraft({ dNotes: e.target.value })} />
      <TextArea style={{ minHeight: 70 }} autoGrow={false} placeholder="Rules for this one (the game's standing rules apply anyway)" value={d.dRules} onChange={(e) => setDraft({ dRules: e.target.value })} />
      {roomId && <CheckBox text={(d.dId ? "Post a fresh card in " : "Post it in ") + (roomName || "this room")} checked={d.dAnnounce} onToggled={(v) => setDraft({ dAnnounce: v })} />}
    </div>
  );
}

function RemoveOption({ voted, onClick }: { voted: boolean; onClick: () => void }) {
  const ref = useTipRef<HTMLButtonElement>(voted ? "People have voted on this time — add a new one instead" : "Remove this option");
  return (
    <button ref={ref} type="button" className={s.squareTool} disabled={voted} onClick={onClick} aria-label="Remove this option">
      <Icon name="list-remove-symbolic" size={24} staticOnly />
    </button>
  );
}

function addOption() {
  const d = useCal.getState().draft;
  if (!validKey(d.dDate)) return;
  setDraft({ dOptions: d.dOptions.concat([{ date: d.dDate, time: d.dTime }]) });
}
function removeOption(i: number) {
  const d = useCal.getState().draft;
  const a = d.dOptions.slice();
  a.splice(i, 1);
  setDraft({ dOptions: a, dChosen: d.dChosen === i ? -1 : d.dChosen > i ? d.dChosen - 1 : d.dChosen });
}

function useRoomLabel(roomId: string) {
  return useRoomName(roomId || null);
}

// ---- detail --------------------------------------------------------------------------------------

function DetailTool({ icon, tip, onClick }: { icon: string; tip: string; onClick: () => void }) {
  const ref = useTipRef<HTMLButtonElement>(tip);
  return (
    <button ref={ref} type="button" className={s.clearTool} onClick={onClick} aria-label={tip}>
      <Icon name={icon} size={24} staticOnly />
    </button>
  );
}

function Detail({ ev, actions }: { ev: CalEvent; actions: PaneActions }) {
  const canEdit = useCal((x) => x.canEdit);
  const games = useCal((x) => x.games);
  const g = ev.game ? games.find((x) => x.name.toLowerCase() === ev.game.toLowerCase()) ?? null : null;
  const mine = useMine(ev); // my answer incl. one still on its way
  const my = mine.status || "";
  const showRules = !!ev.rules || !!g?.rules;
  return (
    <div className={s.section}>
      <div className={s.detailHead}>
      <div className={s.pillRow} style={{ flex: "1 1 auto", minWidth: 0 }}>
        <span className={cx(s.pill, s.pillKind)} style={{ background: tint(kindColor(ev.kind), 0.22), borderColor: kindColor(ev.kind) }}>
          {kindLabel(ev.kind)}
        </span>
        {ev.game && (
          <span className={s.pill} style={{ background: tint(chipColor(ev), 0.22) }}>
            {ev.game}
          </span>
        )}
        {!ev.game && ev.kind !== "focus" && !ev.canceled && (
          <button type="button" className={cx(s.pill, s.pickPill)} onClick={() => openGameReel({ sessionId: ev.id })}>
            🎲 Game TBD · pick tonight's game
          </button>
        )}
        {ev.canceled && (
          <span className={s.pill} style={{ background: "var(--th-calendar-canceled-bg)" }}>
            Canceled
          </span>
        )}
      </div>
        {ev.canEdit && (
          <span className={s.detailTools}>
            <DetailTool icon="document-edit-symbolic" tip="Edit" onClick={() => startEdit(ev)} />
            {ev.kind !== "focus" && (
              <DetailTool
                icon={ev.canceled ? "edit-undo-symbolic" : "dialog-cancel-symbolic"}
                tip={ev.canceled ? "Put it back on" : "Call it off — keeps the event and everyone's RSVPs"}
                onClick={() => (ev.canceled ? setCanceled(ev, false) : actions.askCallOff(ev))}
              />
            )}
            <DetailTool icon="edit-delete-symbolic" tip="Remove for good" onClick={() => actions.askDelete(ev)} />
          </span>
        )}
      </div>
      <h2 className={s.h2}>{ev.title}</h2>
      <div className={s.row} style={{ gap: 8, alignItems: "flex-start" }}>
        <Icon name="view-calendar-upcoming-events-symbolic" size={18} color="var(--th-calendar-detail-when-icon)" />
        <span className={cx(s.bold, s.wrap)} style={{ flex: "1 1 auto" }}>
          {/* native quirk kept (§3.1): the detail's zone is tz() of NOW */}
          {whenLine(ev) + (ev.effStart ? "  " + tz() : "")}
        </span>
      </div>
      {(ev.freePlay && ev.kind !== "freeplay") || ev.joinIfYouCan ? (
        <div className={s.pillRow} style={{ gap: 6 }}>
          {ev.freePlay && ev.kind !== "freeplay" && (
            <span className={s.small} style={{ color: "var(--th-calendar-detail-free-play-fg)" }}>
              ✓ free play allowed
            </span>
          )}
          {ev.joinIfYouCan && (
            <span className={s.small} style={{ color: "var(--th-calendar-detail-join-if-you-can-fg)" }}>
              ✓ join if you can
            </span>
          )}
        </div>
      ) : null}
      <div className={s.row}>
        <Avatar size={20} name={ev.creator.name} seed={ev.createdBy} imageSource={ev.creator.avatar || null} />
        <span className={cx(s.small, s.dim)}>{"Organised by " + ev.creator.name}</span>
      </div>
      {ev.notes && <span className={s.wrap}>{ev.notes}</span>}
      {showRules && (
        <div className={s.section} style={{ padding: 0, gap: 2 }}>
          <span className={cx(s.small, s.dim, s.bold)}>Rules</span>
          {ev.rules && <span className={s.wrap}>{ev.rules}</span>}
          {g?.rules && <span className={cx(s.wrap, s.dim)}>{g.name + " standing rules: " + g.rules}</span>}
          {g?.server && <span className={cx(s.mono, s.accent)}>{"Join: " + g.server}</span>}
        </div>
      )}
      <div className={s.hsep} />
      {ev.kind === "proposal" && ev.options.length > 0 && (
        <div className={s.section} style={{ padding: 0, gap: 6 }}>
          <span className={cx(s.small, s.dim, s.bold, s.wrap)}>{ev.chosen >= 0 ? "Time locked in" : "When can you make it? (tick every time that works)"}</span>
          {ev.options.map((o, i) => (
            <div key={i} className={cx(s.option, ev.chosen === i && s.optionLocked)}>
              <CheckBox disabled={!canEdit || ev.chosen >= 0} checked={mine.options.includes(i)} onToggled={() => toggleVote(ev, i)} aria-label={"Vote " + fmtDay(o.start)} />
              <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span className={s.bold}>{fmtDay(o.start) + " · " + fmtTime(o.start)}</span>
                {o.votes.length > 0 && (
                  <div className={cx(s.avatars, s.avatarsTight)}>
                    {o.votes.slice(0, 8).map((p) => (
                      <Avatar key={p.mxid} size={18} name={p.name} seed={p.mxid} imageSource={p.avatar || null} />
                    ))}
                  </div>
                )}
              </div>
              <span className={cx(s.small, s.dim)} style={{ whiteSpace: "nowrap" }}>
                {o.votes.length + " can"}
              </span>
              {ev.canEdit && ev.chosen < 0 && <Button text="Lock in" onClick={() => void lockOption(ev.id, i, whenTextFor(ev, i))} />}
              {ev.chosen === i && <span className={s.bold} style={{ color: "var(--th-calendar-option-locked-fg)" }}>✓ locked</span>}
            </div>
          ))}
          {ev.canEdit && ev.chosen >= 0 && (
            <div>
              <Button text="Unlock — vote again" onClick={() => void lockOption(ev.id, -1, whenTextFor(ev, -1))} />
            </div>
          )}
        </div>
      )}
      <span className={cx(s.small, s.dim, s.bold)}>{ev.past ? "This one already happened" : "Are you in?"}</span>
      <div className={s.rsvpRow}>
        {(
          [
            { st: "yes", l: "Going", c: "var(--th-calendar-rsvp-yes-fill)" },
            { st: "maybe", l: "Maybe", c: "var(--th-calendar-rsvp-maybe-fill)" },
            { st: "no", l: "Can't", c: "var(--th-calendar-rsvp-no-fill)" },
          ] as const
        ).map((b) => {
          const on = my === b.st;
          const n = ev.rsvp[b.st].length;
          return (
            <button
              key={b.st}
              type="button"
              className={s.rsvpBtn}
              disabled={!canEdit}
              aria-pressed={on}
              style={on ? { background: tint(b.c, 0.35), border: `2px solid ${b.c}`, fontWeight: "bold" } : undefined}
              onClick={() => setRsvp(ev, b.st)}
            >
              {b.l + "  " + n}
            </button>
          );
        })}
      </div>
      {!canEdit && <span className={cx(s.small, s.dim)}>RSVPs open once a space admin has opened this calendar.</span>}
      <div className={s.section} style={{ padding: 0, gap: 4 }}>
        <span className={cx(s.small, s.dim, s.bold)}>Who's in</span>
        {ev.rsvp.yes.length === 0 && ev.rsvp.maybe.length === 0 && <span className={s.dim}>Nobody yet — be the first.</span>}
        <div className={s.whoFlow}>
          {ev.rsvp.yes.map((p) => (
            <span key={p.mxid} className={s.whoChip} style={{ background: "var(--th-calendar-who-yes-bg)" }}>
              <Avatar size={20} name={p.name} seed={p.mxid} imageSource={p.avatar || null} />
              {p.name}
            </span>
          ))}
          {ev.rsvp.maybe.map((p) => (
            <span key={p.mxid} className={s.whoChip} style={{ background: "var(--th-calendar-who-maybe-bg)" }}>
              <Avatar size={20} name={p.name} seed={p.mxid} imageSource={p.avatar || null} />
              {p.name + " (maybe)"}
            </span>
          ))}
        </div>
        {ev.rsvp.no.length > 0 && <span className={cx(s.small, s.dim, s.wrap)}>{"Can't make it: " + ev.rsvp.no.map((p) => p.name).join(", ")}</span>}
      </div>
    </div>
  );
}

// ---- day agenda -----------------------------------------------------------------------------------

function DayAgenda() {
  const ink = useContentInk();
  const selectedDay = useCal((x) => x.selectedDay);
  const events = useCal((x) => x.events);
  const canEdit = useCal((x) => x.canEdit);
  const reminders = useCal((x) => x.remindersOn);
  const byDay = useByDay(events);
  const ranges = useFocusRanges(events);
  const dayEvents = byDay.get(selectedDay) ?? [];
  const valid = validKey(selectedDay);
  const ms = valid ? keyToDate(selectedDay).getTime() : 0;
  const rel = valid ? relDay(ms) : "";
  const main = valid ? focusOn(ranges, selectedDay) : null;
  const mobile = useIsMobile();
  return (
    <div className={s.section}>
      <h3 className={s.h3}>{valid ? fmtDayLong(ms) : ""}</h3>
      {rel && <span className={cx(s.bold, s.accent)}>{rel}</span>}
      {main && (
        <span className={cx(s.bold, s.wrap)} style={{ color: ink(chipColor(main)) }}>
          {"Main game: " + (main.game ? main.game : main.title) + "  ·  " + whenLine(main)}
        </span>
      )}
      {dayEvents.length === 0 && (
        <EmptyState iconName="view-calendar-symbolic" title="Nothing on this day" explanation={canEdit ? "Pick another day, or add something below." : "Pick another day."} />
      )}
      {dayEvents.map((ev) => (
        <div key={ev.id} className={s.agendaRow} style={{ border: `1px solid ${tint(chipColor(ev), 0.6)}` }} onClick={() => useCal.setState({ selectedId: ev.id })} role="button">
          <span className={s.stripe} style={{ background: chipColor(ev) }} />
          <div className={s.agendaCol}>
            <span className={cx(s.bold, s.elide)} style={{ textDecoration: ev.canceled ? "line-through" : undefined }}>
              {ev.title}
            </span>
            <span className={cx(s.small, s.dim, s.elide)}>
              {fmtTime(ev.effStart) + (ev.end > ev.effStart ? " – " + fmtTime(ev.end) : "") + (ev.game ? "  ·  " + ev.game : "") + "  ·  " + kindLabel(ev.kind)}
            </span>
            <span className={cx(s.small, s.dim, s.elide)}>
              {ev.rsvp.yes.length + " going" + (ev.rsvp.maybe.length > 0 ? " · " + ev.rsvp.maybe.length + " maybe" : "") + (myStatus(ev) === "yes" ? "  ·  you're in" : "")}
            </span>
          </div>
        </div>
      ))}
      {canEdit && (
        <div>
          <Button text="New event on this day" icon="appointment-new-symbolic" onClick={() => startNew(selectedDay)} style={mobile ? { minHeight: 44 } : undefined} />
        </div>
      )}
      <span className={cx(s.small, s.dim, s.wrap)} style={{ marginTop: 8 }}>
        {reminders
          ? "You get a desktop reminder 30 minutes before anything you're going to, and a heads-up when someone schedules something new."
          : "Reminders are off (bell in the header)."}
      </span>
    </div>
  );
}

export function SideScroll({ children }: { children: ReactNode }) {
  return <ScrollArea className={s.sideScroll}>{children}</ScrollArea>;
}

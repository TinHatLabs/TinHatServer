// ListViews.tsx — CalendarWindow.qml "UPCOMING" (CAL-32..34) and "GAMES & RULES" (CAL-35..39).
// DECISIONS D3: the native collapses Upcoming rows to ~264 px (titles invisible) and lets the
// EmptyState overlap the next item; the web renders the intended full-width layout (logged).
import { useState } from "react";
import { Avatar, Button, ComboBox, ConfirmDialog, EmptyState, GlowButton, Icon, ScrollArea, TextArea, TextField, cx, useIsMobile, useContentInk } from "@/ui";
import { toast } from "@/core/bus";
import { useTipRef, copyText } from "./util";
import { COLOR_CHOICES, chipColor, fmtDay, fmtDow, fmtTime, kindLabel, relDay, startOfDay, tint, whenLine, type CalEvent, type CalGame } from "../model/calendar";
import { deleteGame, saveGame, useCal } from "../calendarStore";
import { useFocusRanges } from "./MonthView";
import s from "./Calendar.module.css";

const select = (id: string) => useCal.setState({ selectedId: id, editing: false });

export function UpcomingView() {
  const ink = useContentInk();
  const mobile = useIsMobile();
  const events = useCal((x) => x.events);
  const selectedId = useCal((x) => x.selectedId);
  const canEdit = useCal((x) => x.canEdit);
  const ranges = useFocusRanges(events);
  const t0 = startOfDay(new Date());
  const undated = events.filter((e) => !e.effStart);
  const upcoming = events.filter((e) => e.effStart && (e.effEnd || e.effStart) >= t0 && !e.canceled && e.kind !== "focus").concat(undated);
  const upFocus = ranges.filter((f) => (f.end || f.effStart) >= t0);
  const past = events.filter((e) => e.effStart && (e.effEnd || e.effStart) < t0).reverse();
  return (
    <>
      <h3 className={s.h3}>Coming up</h3>
      <ScrollArea style={{ flex: "1 1 auto", minHeight: 0 }}>
        <div className={s.scrollCol}>
          {upFocus.map((f) => (
            <div
              key={f.id}
              className={s.mainRow}
              style={{ background: tint(chipColor(f), 0.18), border: `1px solid ${tint(chipColor(f), 0.6)}` }}
              onClick={() => select(f.id)}
            >
              <span className={s.bold} style={{ color: ink(chipColor(f)) }}>
                Main game
              </span>
              <span className={cx(s.elide, s.fill)}>{(f.game ? f.game : f.title) + "  ·  " + whenLine(f)}</span>
            </div>
          ))}
          {upcoming.length === 0 && upFocus.length === 0 && (
            <EmptyState
              iconName="view-calendar-upcoming-events-symbolic"
              title="Nothing scheduled yet"
              explanation={canEdit ? "Hit New event — a game night, a boss run, or a proposal to find a time." : "Nothing on the calendar right now."}
            />
          )}
          {upcoming.map((ev) => (
            <UpRow key={ev.id} ev={ev} sel={selectedId === ev.id} mobile={mobile} />
          ))}
          {past.length > 0 && (
            <h4 className={cx(s.h4, s.dim)} style={{ marginTop: 12 }}>
              Past
            </h4>
          )}
          {past.slice(0, 12).map((ev) => (
            <div key={ev.id} className={cx(s.pastRow, s.elide)} onClick={() => select(ev.id)} role="button">
              {fmtDay(ev.effStart) + "  ·  " + ev.title + (ev.game ? "  ·  " + ev.game : "")}
            </div>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function UpRow({ ev, sel, mobile }: { ev: CalEvent; sel: boolean; mobile: boolean }) {
  const my = ev.my.status;
  const going = ev.rsvp.yes.length;
  const maybe = ev.rsvp.maybe.length;
  return (
    <div className={cx(s.upRow, sel && s.upRowSel)} onClick={() => select(ev.id)} role="button" aria-pressed={sel}>
      <span className={s.stripe} style={{ background: chipColor(ev) }} />
      <div className={s.upWhen}>
        <span className={cx(s.bold, s.accent)}>{ev.effStart ? relDay(ev.effStart) || fmtDow(ev.effStart) : "Vote"}</span>
        <span className={cx(s.small, s.dim, s.wrap)}>{ev.effStart ? fmtDay(ev.effStart) + "\n" + fmtTime(ev.effStart) : "time to be decided"}</span>
      </div>
      <div className={s.upMain} style={mobile ? { flexBasis: "100%", order: 5 } : undefined}>
        <span className={cx(s.bold, s.elide)}>{ev.title}</span>
        <span className={cx(s.small, s.dim, s.elide)}>
          {(ev.game ? ev.game + "  ·  " : "") +
            kindLabel(ev.kind) +
            (ev.freePlay && ev.kind !== "freeplay" ? "  ·  free play allowed" : "") +
            (ev.joinIfYouCan ? "  ·  join if you can" : "")}
        </span>
      </div>
      <div className={s.avatars} style={{ alignSelf: "center" }}>
        {ev.rsvp.yes.slice(0, 6).map((p) => (
          <Avatar key={p.mxid} size={26} name={p.name} seed={p.mxid} imageSource={p.avatar || null} />
        ))}
      </div>
      <span className={cx(s.small, s.dim)} style={{ alignSelf: "center", whiteSpace: "nowrap" }}>
        {going + " going" + (maybe > 0 ? " · " + maybe + " maybe" : "")}
      </span>
      {my && (
        <span className={s.statusPill} style={{ background: my === "yes" ? "var(--th-calendar-status-yes-bg)" : my === "maybe" ? "var(--th-calendar-status-maybe-bg)" : "var(--th-calendar-status-no-bg)" }}>
          {my === "yes" ? "you're in" : my === "maybe" ? "maybe" : "can't"}
        </span>
      )}
    </div>
  );
}

// ---- Games & rules ------------------------------------------------------------------------------

function ToolSquare({ icon, tip, onClick, clear }: { icon: string; tip: string; onClick: () => void; clear?: boolean }) {
  const ref = useTipRef<HTMLButtonElement>(tip);
  return (
    <button ref={ref} type="button" className={clear ? s.clearTool : s.squareTool} onClick={onClick} aria-label={tip}>
      <Icon name={icon} size={24} staticOnly />
    </button>
  );
}

export function GamesView() {
  const games = useCal((x) => x.games);
  const canEdit = useCal((x) => x.canEdit);
  const isMod = useCal((x) => x.isMod);
  const gameEditing = useCal((x) => x.gameEditing);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [rules, setRules] = useState("");
  const [color, setColor] = useState(0);
  const [confirmSlug, setConfirmSlug] = useState("");

  const startGameEdit = (g: CalGame | null) => {
    setSlug(g ? g.slug : "");
    setName(g ? g.name : "");
    setServer(g ? g.server || "" : "");
    setRules(g ? g.rules || "" : "");
    setColor(g ? Math.max(0, COLOR_CHOICES.indexOf(String(g.color || "").toLowerCase())) : 0);
    useCal.setState({ gameEditing: true });
  };
  const commit = () => {
    if (!name.trim()) return;
    void saveGame({ slug, name: name.trim(), color: COLOR_CHOICES[color], server: server.trim(), rules });
    useCal.setState({ gameEditing: false });
  };

  return (
    <>
      <div className={cx(s.row, s.gamesHead)} style={{ flex: "none" }}>
        <h3 className={s.h3}>Games &amp; standing rules</h3>
        <div className={s.fill} />
        {canEdit && !gameEditing && <Button text="Add game" icon="list-add-symbolic" onClick={() => startGameEdit(null)} />}
      </div>
      <span className={cx(s.dim, s.wrap)} style={{ flex: "none" }}>
        House rules that apply every time a game comes up (free play, progression etiquette, join address). Sessions can add their own notes on top.
      </span>
      {gameEditing && (
        <div className={s.gameForm}>
          <div className={s.row}>
            <TextField style={{ flex: "1 1 auto" }} placeholder="Game name" value={name} onChange={(e) => setName(e.target.value)} onAccepted={commit} autoFocus />
            <ComboBox
              style={{ width: 120, flex: "none" }}
              model={COLOR_CHOICES.map((_, i) => `● Colour ${i + 1}`)}
              currentIndex={color}
              displayText="Colour"
              onActivated={(i) => setColor(i)}
              aria-label="Colour"
            />
            <span className={s.disc} style={{ width: 14, height: 14, background: COLOR_CHOICES[color], marginLeft: -2 }} />
          </div>
          <TextField placeholder="Join address (e.g. play.example.com:2456) — optional" value={server} onChange={(e) => setServer(e.target.value)} />
          <TextArea
            style={{ height: 120 }}
            placeholder="Standing rules — free play allowed? boss progression only as a group? what to bring…"
            value={rules}
            onChange={(e) => setRules(e.target.value)}
          />
          <div className={s.row}>
            <div className={s.fill} />
            <Button text="Cancel" onClick={() => useCal.setState({ gameEditing: false })} />
            <GlowButton text="Save game" disabled={!name.trim()} onClick={commit} />
          </div>
        </div>
      )}
      <ScrollArea style={{ flex: "1 1 auto", minHeight: 0 }}>
        <div className={s.scrollCol} style={{ gap: 8 }}>
          {games.length === 0 ? (
            <EmptyState
              iconName="applications-games-symbolic"
              title="No games yet"
              explanation="Games are added here automatically the first time an event mentions them, or add one now to write down its standing rules (free play OK? boss progression only as a group? the join address)."
            />
          ) : (
            games.map((g) => (
              <div key={g.slug} className={s.gameCard}>
                <div className={cx(s.row, s.gameHead)}>
                  <span className={s.disc} style={{ width: 12, height: 12, background: g.color }} />
                  <h4 className={s.h4}>{g.name}</h4>
                  {g.server && (
                    <>
                      <span className={cx(s.mono, s.accent)}>{g.server}</span>
                      <ToolSquare icon="edit-copy-symbolic" tip="Copy the join address" onClick={() => void copyText(g.server).then(() => toast("Copied " + g.server))} />
                    </>
                  )}
                  <div className={s.fill} />
                  <span className={s.gameTools}>
                    {canEdit && <ToolSquare icon="document-edit-symbolic" tip="Edit" onClick={() => startGameEdit(g)} />}
                    {isMod && <ToolSquare icon="edit-delete-symbolic" tip="Remove" onClick={() => setConfirmSlug(g.slug)} />}
                  </span>
                </div>
                <span className={cx(s.wrap, !g.rules && s.dim)}>{g.rules ? g.rules : "No standing rules yet."}</span>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      <ConfirmHost
        open={!!confirmSlug}
        onClose={() => setConfirmSlug("")}
        title="Remove this game?"
        message="Its rules go too. Events that mention it stay."
        confirm="Remove"
        onConfirmed={() => void deleteGame(confirmSlug)}
      />
    </>
  );
}

export function ConfirmHost(p: { open: boolean; onClose: () => void; title: string; message: string; confirm: string; cancel?: string; onConfirmed: () => void }) {
  const mobile = useIsMobile();
  return (
    <ConfirmDialog className={mobile ? s.bottomSheet : undefined} open={p.open} onClose={p.onClose} dialogTitle={p.title} message={p.message} confirmText={p.confirm} cancelText={p.cancel} destructive onConfirmed={() => p.onConfirmed()} />
  );
}

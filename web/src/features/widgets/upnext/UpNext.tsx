// upnext/UpNext.tsx — the Up next widget (contract WIDGETS-UI.md §4): the next event as a hero (countdown ring around
// the date, time, who's going, the game's cover or "Game TBD · Pick", RSVP, and Join when it starts), then compact rows;
// L = the `days`-long agenda in day sections; S / collapsed = "<title> · <when>". Renders from the model only.
import type { ReactNode } from "react";
import { startCall, toast } from "@/core/bus";
import { Avatar, Button, Icon, cx } from "@/ui";
import { CATALOG_BASE, artUrl, openCalendar, openGameReelFor, rsvp, startNew, useCal, type Person } from "@/features/calendar";
import { fmtClock, useClockMode, type ClockMode } from "@/features/settings";
import { fmtUntil, ringOf, RING_MINUTES } from "@/widgets/time";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { CrossFade, useFreshIds } from "../motion";
import { useUpNext, type UpEvent, type UpJoin, type UpNextModel } from "./model";
import { linkServer, type GameServer } from "@/widgets/gameservers";
import { useGameServers } from "../gameservers/store";
import { ServerLine, StateDot, usePower } from "../gameservers/parts";
import s from "./UpNext.module.css";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** Local calendar days from `now`'s day to `ms`'s day. */
const dayDiff = (ms: number, now: number) => Math.round((dayStart(ms) - dayStart(now)) / 86_400_000);

/** "Today", "Tomorrow", the weekday within 6 days ("Sat"), else "Sat 3 Oct". Compact rows: "Today", "Tmrw", "Sun 28". */
export function dayWord(ms: number, now: number, short = false): string {
  const days = dayDiff(ms, now);
  const d = new Date(ms);
  if (days === 0) return "Today";
  if (days === 1) return short ? "Tmrw" : "Tomorrow";
  if (short) return `${DOW[d.getDay()]} ${d.getDate()}`;
  if (days > 1 && days < 7) return DOW[d.getDay()]!;
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}

/** L's day sections: "TODAY", "TOMORROW", "SAT 27". */
function sectionWord(ms: number, now: number): string {
  const days = dayDiff(ms, now);
  const d = new Date(ms);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : `${DOW[d.getDay()]} ${d.getDate()}`;
}

export function whenLine(e: UpEvent, now: number, mode: ClockMode): string {
  if (e.ring.phase === "live") return `Now · until ${fmtClock(e.end, mode)}`;
  const base = `${dayWord(e.start, now)} ${fmtClock(e.start, mode)}`;
  return e.start - now < RING_MINUTES * 60_000 ? `${base} · ${fmtUntil(e.start - now)}` : base;
}

function summaryOf(e: UpEvent | undefined, now: number, mode: ClockMode): string {
  if (!e) return "Nothing planned";
  if (e.ring.phase === "live") return `${e.title} · now`;
  if (e.start - now < RING_MINUTES * 60_000) return `${e.title} · ${fmtUntil(e.start - now)}`;
  return `${e.title} · ${dayWord(e.start, now)} ${fmtClock(e.start, mode)}`;
}

// ---- the countdown ring ----------------------------------------------------------------------------------------------

/** The ring (WIDGETS-UI.md §4): track + a sweep of fill / 1440 from 12 o'clock clockwise; the sweep eases to a new
 *  minute (`ringStep`) through the stroke-dashoffset transition, which snaps while the motion switch is off. */
export function Ring({ size, stroke, fill, live, children, className }: { size: number; stroke: number; fill: number; live: boolean; children?: ReactNode; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, fill / RING_MINUTES));
  const mid = size / 2;
  return (
    <span className={cx(s.ringBox, className)} style={{ width: size, height: size }}>
      <svg className={s.ring} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--th-widget-up-next-ring-track)" strokeWidth={stroke} />
        {frac > 0 && (
          <circle
            className={s.sweep}
            cx={mid}
            cy={mid}
            r={r}
            fill="none"
            stroke={live ? "var(--th-widget-up-next-ring-fill-live)" : "var(--th-widget-up-next-ring-fill)"}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - frac)}
            transform={`rotate(-90 ${mid} ${mid})`}
          />
        )}
      </svg>
      {children}
    </span>
  );
}

// ---- RSVP -------------------------------------------------------------------------------------------------------------

/** The calendar's own words (both apps' calendar: Going / Maybe / Can't); icon-only forms: ✓ ? ✕. */
const ANSWERS = [
  { v: "yes", label: "Going", icon: "checkmark-symbolic" },
  { v: "maybe", label: "Maybe", icon: "" },
  { v: "no", label: "Can't", icon: "window-close-symbolic" },
] as const;

function AnswerMark({ a, size }: { a: (typeof ANSWERS)[number]; size: number }) {
  if (!a.icon)
    return (
      <span className={s.q} style={{ fontSize: size + 1, lineHeight: `${size}px` }} aria-hidden="true">
        ?
      </span>
    );
  return <Icon name={a.icon} size={size} color="currentColor" staticOnly />;
}

async function answer(e: UpEvent, v: string) {
  const clear = e.my === v;
  await rsvp(e.id, clear ? "" : v, clear ? [] : e.myOptions, e.container);
  const err = useCal.getState().lastError;
  if (err) toast(err);
}

export function Rsvp({ e, iconOnly, mini, preview }: { e: UpEvent; iconOnly?: boolean; mini?: boolean; preview?: boolean }) {
  const readOnly = !e.canWrite;
  return (
    <span className={cx(s.rsvp, mini && s.rsvpMini, iconOnly && s.rsvpIcons)} data-no-drag="" data-readonly={readOnly && !preview ? "" : undefined}>
      {ANSWERS.map((a) => (
        <button
          key={a.v}
          type="button"
          className={s.seg}
          data-answer={a.v}
          data-checked={e.my === a.v ? "" : undefined}
          aria-pressed={e.my === a.v}
          aria-label={a.label}
          title={iconOnly || mini ? a.label : undefined}
          disabled={readOnly || preview}
          onClick={(ev) => {
            ev.stopPropagation();
            void answer(e, a.v);
          }}
        >
          {iconOnly || mini ? <AnswerMark a={a} size={mini ? 11 : 12} /> : <span>{a.label}</span>}
        </button>
      ))}
    </span>
  );
}

export function AnswerGlyph({ my }: { my: string }) {
  const a = ANSWERS.find((x) => x.v === my);
  if (!a) return <span className={s.glyph} />;
  return (
    <span className={s.glyph} data-answer={my} aria-label={a.label} title={a.label}>
      <AnswerMark a={a} size={12} />
    </span>
  );
}

// ---- rows -------------------------------------------------------------------------------------------------------------

/** Going (then maybe, at 60 %) faces: at most 5, or 3 while the "Game TBD · Pick" pill shares the line; then "+n". */
export function People({ e, mobile, max }: { e: UpEvent; mobile: boolean; max: number }) {
  const people: Array<Person & { maybe?: boolean }> = [...e.going, ...e.maybe.map((p) => ({ ...p, maybe: true }))];
  const fresh = useFreshIds(people.map((p) => p.mxid));
  if (!people.length) return <span className={s.noReplies}>No replies yet</span>;
  const shown = people.slice(0, max);
  const size = mobile ? 22 : 18;
  return (
    <span className={s.people} title={people.map((p) => (p.maybe ? `${p.name} (maybe)` : p.name)).join(", ")}>
      {shown.map((p) => (
        <span key={p.mxid} className={cx(s.face, fresh.has(p.mxid) && "tw-enter-side")} data-maybe={p.maybe ? "" : undefined}>
          <Avatar size={size} name={p.name} seed={p.mxid} imageSource={p.avatar || null} />
        </span>
      ))}
      {people.length > shown.length && <span className={s.more}>+{people.length - shown.length}</span>}
    </span>
  );
}

/** A game server linked to an event (docs/GAMESERVERS.md §5): its line, and "Start server" for admins while it is soon. */
interface Linked {
  sv: GameServer;
  canManage: boolean;
  start: () => void;
}

function Hero({ e, join, now, mode, ctx, linked }: { e: UpEvent; join: UpJoin | null; now: number; mode: ClockMode; ctx: WidgetCtx; linked: Linked | null }) {
  const soon = e.ring.phase === "soon" || e.ring.phase === "live";
  const startServer = soon && !!linked && linked.canManage && linked.sv.state === "offline" && !linked.sv.pending;
  const d = new Date(e.start);
  const open = () => !ctx.preview && openCalendar({ containerId: e.container, eventId: e.id });
  const canJoin = soon && !!join?.active && !join.inIt;
  return (
    <div
      className={s.hero}
      data-soon={soon ? "" : undefined}
      data-phase={e.ring.phase}
      onClick={open}
      role="button"
      tabIndex={ctx.preview ? -1 : 0}
      aria-label={`${e.title}, ${whenLine(e, now, mode)}`}
      onKeyDown={(k) => k.target === k.currentTarget && k.key === "Enter" && open()}
    >
      <span className={s.edge} />
      <Ring size={ctx.mobile ? 48 : 40} stroke={3} fill={e.ring.fill} live={e.ring.phase === "live"} className={s.chip}>
        <span className={s.dow}>{DOW[d.getDay()]}</span>
        <span className={s.dom}>{d.getDate()}</span>
      </Ring>
      <span className={s.heroText}>
        <span className={s.title} title={e.game ? `${e.title} · ${e.game}` : e.title}>
          {e.title}
        </span>
        <span className={s.when} data-live={e.ring.phase === "live" ? "" : undefined}>
          {whenLine(e, now, mode)}
        </span>
        {linked && <ServerLine sv={linked.sv} preview={ctx.preview} />}
        <span className={s.line3}>
          <People e={e} mobile={ctx.mobile} max={e.tbd ? 3 : 5} />
          {e.tbd && (
            <button
              type="button"
              className={s.tbd}
              data-no-drag=""
              disabled={ctx.preview}
              onClick={(ev) => {
                ev.stopPropagation();
                openGameReelFor(e.container, e.id);
              }}
            >
              Game TBD · Pick
            </button>
          )}
        </span>
        <span className={s.line4}>
          {startServer ? (
            <>
              <Button
                highlighted
                className={s.join}
                text="Start server"
                icon="media-playback-start-symbolic"
                disabled={ctx.preview}
                onClick={(ev) => {
                  ev.stopPropagation();
                  linked!.start();
                }}
              />
              <Rsvp e={e} iconOnly preview={ctx.preview} />
            </>
          ) : canJoin ? (
            <>
              <Button
                highlighted
                className={s.join}
                text="Join call"
                icon="call-start-symbolic"
                disabled={ctx.preview}
                onClick={(ev) => {
                  ev.stopPropagation();
                  startCall(join!.room);
                }}
              />
              <Rsvp e={e} iconOnly preview={ctx.preview} />
            </>
          ) : soon && join?.inIt ? (
            <span className={s.inCall}>You're in the call</span>
          ) : (
            <Rsvp e={e} preview={ctx.preview} />
          )}
        </span>
      </span>
      {e.cover && <CrossFade className={s.cover} src={e.cover} fallback={<span className={s.coverBlank} />} />}
    </div>
  );
}

function Compact({ e, now, mode, ctx, agenda, linked }: { e: UpEvent; now: number; mode: ClockMode; ctx: WidgetCtx; agenda: boolean; linked: GameServer | null }) {
  const soon = e.ring.phase === "soon" || e.ring.phase === "live";
  const open = () => !ctx.preview && openCalendar({ containerId: e.container, eventId: e.id });
  const time = e.ring.phase === "live" ? "Now" : fmtClock(e.start, mode);
  const always = agenda || ctx.mobile;
  return (
    <div
      className={cx(s.compact, always && s.showButtons, agenda && s.agenda)}
      data-soon={soon ? "" : undefined}
      onClick={open}
      role="button"
      tabIndex={ctx.preview ? -1 : 0}
      aria-label={`${e.title}, ${dayWord(e.start, now)} ${time}`}
      onKeyDown={(k) => k.target === k.currentTarget && k.key === "Enter" && open()}
    >
      <span className={s.edge} />
      {/* the mini ring once the event is within 24 h (it has a sweep); before that a quiet dot, not an empty circle
          that reads like a radio button */}
      {e.ring.fill > 0 ? <Ring size={16} stroke={2} fill={e.ring.fill} live={e.ring.phase === "live"} /> : <span className={s.far} aria-hidden="true" />}
      {ctx.mobile ? (
        // phones: two lines — the title, then "Tmrw · 8:00 PM" (L: the time; the section says the day)
        <span className={s.cstack}>
          <span className={s.ctitle}>{e.title}</span>
          <span className={s.csub}>{agenda ? time : `${dayWord(e.start, now, true)} · ${time}`}</span>
        </span>
      ) : (
        <>
          {/* L: the day is the section's label, so the column shows the time */}
          <span className={s.day}>{agenda ? time : dayWord(e.start, now, true)}</span>
          {linked && <StateDot sv={linked} className={s.cdot} />}
          <span className={s.ctitle} title={e.game ? `${e.title} · ${e.game}` : e.title}>
            {e.title}
          </span>
          {!agenda && <span className={s.ctime}>{time}</span>}
        </>
      )}
      {!always && <AnswerGlyph my={e.my} />}
      <Rsvp e={e} mini preview={ctx.preview} />
    </div>
  );
}

// ---- the widget -------------------------------------------------------------------------------------------------------

function Body({ model, ctx }: PartProps<UpNextModel>) {
  const mode = useClockMode();
  const fresh = useFreshIds(model.events.map((e) => e.key));
  // the Game servers link: poll only while a shown event names a game (a non-member's 403 rests the poller)
  const shown = ctx.size === "L" ? model.events : model.events.slice(0, 3);
  const gs = useGameServers(!ctx.preview && shown.some((e) => !!e.game || !!e.gameId));
  const power = usePower(gs.status);
  const linkOf = (e: UpEvent): GameServer | null => (gs.status ? linkServer(e, gs.status) : null);
  if (!model.ready) return <div className={s.status}>Catching up…</div>;
  if (!model.events.length)
    return (
      <div className={s.empty}>
        <Icon name="view-calendar-symbolic" size={20} color="var(--th-widget-muted-fg)" staticOnly />
        <span className={s.emptyText}>Nothing planned</span>
        <button
          type="button"
          className={s.newEvent}
          disabled={ctx.preview}
          onClick={() => {
            openCalendar();
            startNew();
          }}
        >
          + New event
        </button>
      </div>
    );
  const [hero, ...rest] = model.events;
  const L = ctx.size === "L";
  const list = L ? rest : rest.slice(0, 2);
  let lastDay = "";
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {power.dialogs}
      <div className={fresh.has(hero!.key) ? "tw-enter-up" : undefined}>
        <Hero
          e={hero!}
          join={model.join}
          now={model.now}
          mode={mode}
          ctx={ctx}
          linked={(() => {
            const sv = linkOf(hero!);
            return sv && gs.status ? { sv, canManage: gs.status.canManage, start: () => power.run("start", sv.id) } : null;
          })()}
        />
      </div>
      {list.length > 0 && <div className={s.divider} />}
      {list.map((e) => {
        const day = sectionWord(e.start, model.now);
        const label = L && day !== lastDay ? day : "";
        lastDay = day;
        return (
          <div key={e.key} className={fresh.has(e.key) ? "tw-enter-up" : undefined}>
            {label && <div className={s.section}>{label}</div>}
            <Compact e={e} now={model.now} mode={mode} ctx={ctx} agenda={L} linked={linkOf(e)} />
          </div>
        );
      })}
    </div>
  );
}

function Summary({ model }: PartProps<UpNextModel>) {
  const mode = useClockMode();
  return <span className={s.summary}>{model.ready ? summaryOf(model.events[0], model.now, mode) : "Catching up…"}</span>;
}

// ---- samples (the gallery preview + the review screenshots' states) ------------------------------------------------

const P = (id: string, name: string): Person => ({ mxid: `@${id}:sample.invalid`, name, avatar: "" });
const TEAM = [P("ana", "Ana"), P("bo", "Bo"), P("cy", "Cy"), P("dee", "Dee"), P("eli", "Eli"), P("fay", "Fay"), P("gus", "Gus")];
const VALHEIM_ART = () => artUrl(CATALOG_BASE, "steam:892970", "portrait");

function ev(now: number, i: number, title: string, start: number, over: Partial<UpEvent> = {}): UpEvent {
  const end = over.end ?? start + 3 * 3_600_000;
  return {
    key: `!lounge:sample.invalid/ev-${i}`,
    container: "!lounge:sample.invalid",
    id: `ev-${i}`,
    title,
    kind: "session",
    start,
    end,
    game: "",
    cover: "",
    gameId: "",
    tbd: true,
    going: [],
    maybe: [],
    my: "",
    myOptions: [],
    canWrite: true,
    callRoom: "!lounge:sample.invalid",
    containerIsSpace: false,
    ...over,
    ring: ringOf(start, end, now),
  };
}
/** Today at hh:mm, at least `min` minutes from now (rounded to 5 min). */
function todayAt(now: number, h: number, m: number, minAhead: number): number {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  const t = Math.max(d.getTime(), now + minAhead * 60_000);
  return Math.ceil(t / 300_000) * 300_000;
}
const DAY = 86_400_000;

function sampleM(opts: { cover?: boolean; lead?: number; live?: boolean; readOnly?: boolean; join?: "join" | "in" } = {}): UpNextModel {
  const now = Date.now();
  const lead = opts.live ? -45 : (opts.lead ?? 130);
  const start = opts.live || lead < 60 ? Math.floor((now + lead * 60_000) / 60_000) * 60_000 : todayAt(now, 19, 30, lead);
  const events = [
    ev(now, 1, "Game night", start, {
      going: TEAM.slice(0, 4),
      maybe: TEAM.slice(4, 6),
      my: "yes",
      canWrite: !opts.readOnly,
      ...(opts.cover ? { game: "Valheim", cover: VALHEIM_ART(), tbd: false } : {}),
    }),
    ev(now, 2, "Boss run", todayAt(now + DAY, 20, 0, 0), { going: TEAM.slice(1, 3), my: "maybe", game: "Valheim", tbd: false, canWrite: !opts.readOnly }),
    ev(now, 3, "Valheim night", todayAt(now + 3 * DAY, 19, 0, 0), { my: "", game: "Valheim", tbd: false, canWrite: !opts.readOnly }),
  ];
  const join = opts.join ? { room: "!lounge:sample.invalid", active: true, inIt: opts.join === "in" } : null;
  return { ready: true, now, events, join };
}

function sampleL(): UpNextModel {
  const m = sampleM({ cover: true });
  const now = m.now;
  const more = [
    ev(now, 4, "Raid prep", todayAt(now + 3 * DAY, 21, 30, 0), { my: "no", canWrite: true }),
    ev(now, 5, "Movie night", todayAt(now + 5 * DAY, 20, 0, 0), { going: TEAM.slice(0, 2), my: "yes", game: "Media Party", tbd: false }),
    ev(now, 6, "Minecraft build", todayAt(now + 6 * DAY, 18, 0, 0), { my: "" }),
  ];
  return { ...m, events: [...m.events, ...more].sort((a, b) => a.start - b.start) };
}

export const upNext = defineWidget<UpNextModel>({
  id: "upNext",
  useModel: (ctx: WidgetCtx) => useUpNext(Number(ctx.settings.days ?? 7)),
  live: (m) => m.events.length > 0 && (m.events[0]!.ring.phase === "soon" || m.events[0]!.ring.phase === "live"),
  Summary,
  Body,
  hasData: (m) => m.ready && m.events.length > 0,
  samples: {
    preview: () => sampleM({ cover: false }),
    tbd: () => sampleM(),
    cover: () => sampleM({ cover: true }),
    soon: () => sampleM({ lead: 6, join: "join" }),
    live: () => sampleM({ live: true, cover: true, join: "in" }),
    readonly: () => sampleM({ readOnly: true, cover: true }),
    agenda: sampleL,
    empty: () => ({ ready: true, now: Date.now(), events: [], join: null }),
    loading: () => ({ ready: false, now: Date.now(), events: [], join: null }),
  },
});

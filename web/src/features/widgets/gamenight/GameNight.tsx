// gamenight/GameNight.tsx — the Game night widget (widget `gameNight`, contract WIDGETS.md §23, WIDGETS-UI.md §23; the
// desktop's GameNightWidget.qml): the next game night as the hero — the Game Reel's sessions (calendar kind "session") of
// every joined space, read by Up next's own model: the game's cover (or "Game TBD" + Pick / Spin → the Game Reel for
// that night), the countdown (Up next's minute timer), who's going (Up next's RSVP faces; a new one slides in), your RSVP
// (Up next's buttons, the calendar's write), your Reel credit (the Reel's own computation, read-only) and — when the
// picked game has a game server — its state dot and join address (the Game servers line). L adds the next two nights;
// S / collapsed = "Game night · Valheim · in 2 h". Up next lists every event; this is the game-night hero.
import { useEffect, useMemo, useState } from "react";
import { cx } from "@/ui";
import { CATALOG_BASE, artUrl, myCredit, openCalendar, openGameReelFor, startNew } from "@/features/calendar";
import { fmtClock, useClockMode } from "@/features/settings";
import { onWinState, winState } from "@/core/winstate";
import { NIGHTS, creditText, nightSummary, nightWhen, selectNights } from "@/widgets/gamenight";
import { linkServer } from "@/widgets/gameservers";
import { ringOf } from "@/widgets/time";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { CrossFade, useFreshIds } from "../motion";
import { SAMPLE_SERVER } from "../names";
import { AnswerGlyph, People, Rsvp, dayWord, whenLine } from "../upnext/UpNext";
import { useUpNext, type UpEvent } from "../upnext/model";
import { useGameServers } from "../gameservers/store";
import { ServerLine } from "../gameservers/parts";
import s from "./GameNight.module.css";

export interface GameNightModel {
  ready: boolean;
  now: number;
  /** the game nights to show, soonest first (the hero first) */
  nights: UpEvent[];
  /** my Reel credit in the hero's space (null = not read yet) */
  credit: { credit: number | null; mode: string } | null;
}

const CREDIT_MS = 10 * 60_000;

/** My Reel credit for the hero: read when the hero changes, then every 10 minutes while the window is not hidden. */
function useCredit(container: string, id: string, active: boolean): GameNightModel["credit"] {
  const [v, setV] = useState<{ key: string; val: GameNightModel["credit"] } | null>(null);
  const key = `${container}/${id}`;
  useEffect(() => {
    if (!active || !container || !id || container.endsWith(`:${SAMPLE_SERVER}`)) return;
    let alive = true;
    let timer = 0;
    const read = () => {
      window.clearTimeout(timer);
      if (winState() === "hidden") return;
      void myCredit(container, id)
        .then((val) => alive && setV({ key, val }))
        .catch(() => undefined)
        .finally(() => {
          if (alive) timer = window.setTimeout(read, CREDIT_MS);
        });
    };
    read();
    const off = onWinState((now, prev) => {
      if (now !== "hidden" && prev === "hidden") read();
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      off();
    };
  }, [container, id, active, key]);
  return v && v.key === key ? v.val : null;
}

function useModel(ctx: WidgetCtx): GameNightModel {
  const up = useUpNext(14);
  const nights = useMemo(() => {
    const byKey = new Map(up.events.map((e) => [`${e.container}/${e.id}`, e]));
    const picked = selectNights(
      up.events.map((e) => ({ container: e.container, id: e.id, kind: e.kind, start: e.start, end: e.end, canceled: false })),
      up.now,
      NIGHTS.L,
    );
    return picked.map((n) => byKey.get(`${n.container}/${n.id}`)!).filter(Boolean);
  }, [up.events, up.now]);
  const hero = nights[0];
  const credit = useCredit(hero?.container ?? "", hero?.id ?? "", !ctx.preview);
  return { ready: up.ready, now: up.now, nights, credit };
}

function Cover({ e, ctx }: { e: UpEvent; ctx: WidgetCtx }) {
  if (e.cover) return <CrossFade className={s.cover} src={e.cover} fallback={<span className={s.coverBlank} />} />;
  // a named game without cover art (the calendar's game name, no Reel pick): the plain cover box — never "Game TBD"
  if (!e.tbd)
    return (
      <span className={s.cover} aria-hidden>
        <span className={s.coverBlank} />
      </span>
    );
  return (
    <button
      type="button"
      className={cx(s.cover, s.tbdTile)}
      data-no-drag=""
      disabled={ctx.preview}
      title="Pick tonight's game — spin the Game Reel"
      onClick={(ev) => {
        ev.stopPropagation();
        openGameReelFor(e.container, e.id);
      }}
    >
      <span className={s.tbdGlyph} aria-hidden>
        🎲
      </span>
      <span className={s.tbdText}>Game TBD</span>
    </button>
  );
}

function Hero({ m, ctx }: { m: GameNightModel; ctx: WidgetCtx }) {
  const e = m.nights[0]!;
  const mode = useClockMode();
  const gs = useGameServers(!ctx.preview && (!!e.game || !!e.gameId));
  const linked = gs.status && !e.container.endsWith(`:${SAMPLE_SERVER}`) ? linkServer(e, gs.status) : null;
  const credit = m.credit ? creditText(m.credit.credit, m.credit.mode) : "";
  const open = () => !ctx.preview && openCalendar({ containerId: e.container, eventId: e.id });
  return (
    <div className={s.heroBox}>
      <div
        className={s.hero}
        role="button"
        tabIndex={ctx.preview ? -1 : 0}
        data-phase={e.ring.phase}
        onClick={open}
        onKeyDown={(k) => k.target === k.currentTarget && k.key === "Enter" && open()}
        aria-label={`${e.title}, ${whenLine(e, m.now, mode)}`}
      >
        <Cover e={e} ctx={ctx} />
        <span className={s.text}>
          <span className={s.title} title={e.game ? `${e.title} · ${e.game}` : e.title}>
            {e.title}
          </span>
          <span className={s.game}>{e.game || "Game TBD"}</span>
          <span className={s.when} data-live={e.ring.phase === "live" ? "" : undefined}>
            {whenLine(e, m.now, mode)}
          </span>
          <span className={s.people}>
            <People e={e} mobile={ctx.mobile} max={5} />
            {e.tbd && (
              <button
                type="button"
                className={s.pick}
                data-no-drag=""
                disabled={ctx.preview}
                onClick={(ev) => {
                  ev.stopPropagation();
                  openGameReelFor(e.container, e.id);
                }}
              >
                Pick / Spin
              </button>
            )}
          </span>
          {linked && <ServerLine sv={linked} preview={ctx.preview} className={s.server} />}
        </span>
      </div>
      <div className={s.rsvp}>
        <Rsvp e={e} preview={ctx.preview} />
      </div>
      {credit && (
        <div className={s.credit} title="Credit raises your favourite's odds on the Game Reel after it loses.">
          {credit}
        </div>
      )}
    </div>
  );
}

function NextRow({ e, m, enter }: { e: UpEvent; m: GameNightModel; enter: boolean }) {
  const mode = useClockMode();
  return (
    <div
      className={cx(s.row, enter && "tw-enter-up")}
      role="button"
      tabIndex={0}
      onClick={() => !e.container.endsWith(`:${SAMPLE_SERVER}`) && openCalendar({ containerId: e.container, eventId: e.id })}
      title={`${e.title} · ${e.game || "Game TBD"}`}
    >
      <span className={s.day}>{dayWord(e.start, m.now, true)}</span>
      <span className={s.rowTitle}>{e.title}</span>
      <span className={s.rowGame}>{e.game || "TBD"}</span>
      <span className={s.rowTime}>{fmtClock(e.start, mode)}</span>
      <AnswerGlyph my={e.my} />
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<GameNightModel>) {
  const rest = ctx.size === "L" && !ctx.preview ? m.nights.slice(1, NIGHTS.L) : [];
  const fresh = useFreshIds(rest.map((e) => e.key));
  if (!m.ready) return <div className={s.status}>Catching up…</div>;
  if (!m.nights.length)
    return (
      <div className={s.empty}>
        <span>No game night planned</span>
        <button
          type="button"
          className={s.linkBtn}
          data-no-drag=""
          disabled={ctx.preview}
          onClick={(ev) => {
            ev.stopPropagation();
            openCalendar();
            startNew();
          }}
        >
          New game night
        </button>
      </div>
    );
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      <Hero m={m} ctx={ctx} />
      {rest.length > 0 && <div className={s.divider} />}
      {rest.map((e) => (
        <NextRow key={e.key} e={e} m={m} enter={fresh.has(e.key)} />
      ))}
    </div>
  );
}

function whenOf(m: GameNightModel, mode: ReturnType<typeof useClockMode>): string {
  const e = m.nights[0];
  if (!e) return "";
  return nightWhen(e.start, e.end, m.now, `${dayWord(e.start, m.now)} ${fmtClock(e.start, mode)}`);
}

function Summary({ model: m }: PartProps<GameNightModel>) {
  const mode = useClockMode();
  if (!m.ready) return <span className={s.summary}>Catching up…</span>;
  const e = m.nights[0];
  return <span className={s.summary}>{nightSummary(!!e, e?.game ?? "", whenOf(m, mode))}</span>;
}

/** M / L header: the countdown. */
function Countdown({ model: m }: PartProps<GameNightModel>) {
  const mode = useClockMode();
  const w = whenOf(m, mode);
  return w ? <span className={s.summary}>{w}</span> : null;
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's GameNightWidget.qml holds the same)

const P = (id: string, name: string) => ({ mxid: `@${id}:${SAMPLE_SERVER}`, name, avatar: "" });
const TEAM = [P("ana", "Ana"), P("bo", "Bo"), P("cy", "Cy"), P("dee", "Dee"), P("eli", "Eli"), P("fay", "Fay"), P("gus", "Gus")];
/** Local time today + `days` at h:m; the samples' clock is today 5:20 PM (so "in 2 h 10 m" reads the same all day). */
function at(days: number, h: number, m: number): number {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function night(i: number, title: string, start: number, now: number, over: Partial<UpEvent> = {}): UpEvent {
  const end = start + 3 * 3_600_000;
  return {
    key: `!squad:${SAMPLE_SERVER}/gn${i}`,
    container: `!squad:${SAMPLE_SERVER}`,
    id: `gn${i}`,
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
    callRoom: "",
    containerIsSpace: true,
    ring: ringOf(start, end, now),
    ...over,
  };
}
function sample(kind: "picked" | "tbd" | "soon" | "empty"): GameNightModel {
  const now = at(0, 17, 20);
  const valheim = { game: "Valheim", gameId: "steam:892970", cover: artUrl(CATALOG_BASE, "steam:892970", "portrait"), tbd: false };
  const first =
    kind === "tbd"
      ? night(1, "Friday game night", at(0, 19, 30), now, { going: TEAM.slice(0, 3), maybe: TEAM.slice(3, 4), my: "maybe" })
      : kind === "soon"
        ? night(1, "Valheim night", at(0, 17, 26), now, { ...valheim, going: TEAM.slice(0, 5), my: "yes" })
        : night(1, "Valheim night", at(0, 19, 30), now, { ...valheim, going: TEAM.slice(0, 4), maybe: TEAM.slice(4, 5), my: "yes" });
  const nights =
    kind === "empty"
      ? []
      : [
          first,
          night(2, "Zomboid Sunday", at(2, 20, 0), now, { game: "Project Zomboid", gameId: "steam:108600", cover: artUrl(CATALOG_BASE, "steam:108600", "portrait"), tbd: false, going: TEAM.slice(0, 2), my: "yes" }),
          night(3, "Game night", at(5, 19, 30), now, { going: TEAM.slice(1, 3), my: "" }),
        ];
  return { ready: true, now, nights, credit: kind === "empty" ? null : { credit: kind === "tbd" ? 0 : 2, mode: "earn" } };
}

export const gameNight = defineWidget<GameNightModel>({
  id: "gameNight",
  useModel,
  live: (m) => !!m.nights[0] && (m.nights[0].ring.phase === "soon" || m.nights[0].ring.phase === "live"),
  Summary,
  HeaderExtra: Countdown,
  Body,
  hasData: (m) => m.nights.length > 0,
  samples: {
    preview: () => sample("picked"),
    picked: () => sample("picked"),
    tbd: () => sample("tbd"),
    soon: () => sample("soon"),
    empty: () => sample("empty"),
  },
});

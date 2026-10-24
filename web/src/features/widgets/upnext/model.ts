// upnext/model.ts — Up next's data (contract WIDGETS.md §4, §10.4): every joined room that holds calendar events (a
// space, or a room outside any space) is a container; its snapshot comes from the calendar's own buildSnapshot, the
// shared selectUpNext picks and orders what shows, and ONE timer wakes at the earliest ring boundary (§10.4 nextAt).
// The hero's call (WIDGETS-UI.md §4 "Call room") is resolved here too, so the view renders from the model alone.
import { useEffect, useMemo, useState } from "react";
import { ClientEvent, RoomEvent, RoomStateEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { peekClient, useDerived } from "@/core/matrix";
import { onWinState } from "@/core/winstate";
import { roomCall, useCall, useRoomCall } from "@/features/calls";
import { CATALOG_BASE, EVENT_TYPE, GAME_TYPE, RSVP_TYPE, artUrl, buildSnapshot, mineOf, useCal, type CalEvent, type Person } from "@/features/calendar";
import { ringOf, selectUpNext, type Ring } from "@/widgets/time";
import type { CalItem } from "@/widgets/gameservers";

export interface UpEvent {
  key: string;
  container: string;
  id: string;
  title: string;
  kind: string;
  start: number;
  end: number;
  /** the game's name ("" = none) and its portrait art when the Reel picked a catalogue game */
  game: string;
  cover: string;
  /** the Reel's catalogue id ("steam:892970", "" = none): the Game servers link (docs/GAMESERVERS.md §5) */
  gameId: string;
  /** "Game TBD · Pick": no game yet (the calendar's rule) */
  tbd: boolean;
  going: Person[];
  maybe: Person[];
  /** my answer (pending writes included): "yes" | "maybe" | "no" | "" */
  my: string;
  myOptions: number[];
  /** I may write the container's calendar state (RSVP) */
  canWrite: boolean;
  /** where its call happens (WIDGETS-UI.md §4 "Call room"): the room its card was posted in, else the container when
   *  it is a room ("" = the container is a space: its child room with a call, resolved for the hero) */
  callRoom: string;
  containerIsSpace: boolean;
  ring: Ring;
}

/** The hero's call while it starts soon or runs: the room, whether a call is active there, whether I am in it. */
export interface UpJoin {
  room: string;
  active: boolean;
  inIt: boolean;
}

export interface UpNextModel {
  ready: boolean;
  now: number;
  events: UpEvent[];
  join: UpJoin | null;
}

interface Row {
  container: string;
  space: boolean;
  canWrite: boolean;
  ev: CalEvent;
}
interface CalData {
  rows: Row[];
  fp: string;
}
const EMPTY: CalData = { rows: [], fp: "" };
const WATCH = new Set<string>([EVENT_TYPE, RSVP_TYPE, GAME_TYPE, "m.room.member", "m.room.power_levels"]);

function compute(c: MatrixClient | null): CalData {
  if (!c) return EMPTY;
  const rows: Row[] = [];
  for (const r of c.getRooms()) {
    if (r.getMyMembership() !== "join") continue;
    if (!r.currentState.getStateEvents(EVENT_TYPE).length) continue;
    const snap = buildSnapshot(r.roomId, r.roomId, c);
    for (const ev of snap.events) rows.push({ container: r.roomId, space: r.isSpaceRoom(), canWrite: snap.canEdit, ev });
  }
  const fp = JSON.stringify(
    rows.map((x) => [
      x.container,
      x.ev.id,
      x.ev.updatedAt,
      x.ev.title,
      x.ev.effStart,
      x.ev.effEnd,
      x.ev.canceled,
      x.ev.kind,
      x.ev.game,
      x.ev.gameId,
      x.ev.rsvp.yes.map((p) => p.mxid + p.name + p.avatar),
      x.ev.rsvp.maybe.map((p) => p.mxid + p.name + p.avatar),
      x.ev.rsvp.no.length,
      x.ev.my.status,
      x.canWrite,
      x.ev.announce?.room ?? "",
    ]),
  );
  return { rows, fp };
}

const spec = () => ({
  attach(c: MatrixClient, changed: () => void) {
    const onState = (ev: MatrixEvent) => {
      if (WATCH.has(ev.getType())) changed();
    };
    c.on(RoomStateEvent.Events, onState);
    c.on(ClientEvent.Room, changed);
    c.on(RoomEvent.MyMembership, changed);
    return () => {
      c.off(RoomStateEvent.Events, onState);
      c.off(ClientEvent.Room, changed);
      c.off(RoomEvent.MyMembership, changed);
    };
  },
  compute,
  equal: (a: CalData, b: CalData) => a.fp === b.fp,
});

/** Every calendar event of every joined container, as the Game servers link reads them (docs/GAMESERVERS.md §3.7). */
export function useCalendarItems(): CalItem[] {
  const data = useDerived("widgets.upnext.v1", spec);
  return useMemo(
    () =>
      data.rows.map((r) => ({
        container: r.container,
        id: r.ev.id,
        title: r.ev.title,
        kind: String(r.ev.kind),
        start: r.ev.effStart,
        end: r.ev.effEnd,
        canceled: r.ev.canceled === true,
        game: r.ev.game || "",
        gameId: r.ev.gameId || "",
      })),
    [data],
  );
}

/** A space event without a card room: the space's child room with the most people in a call (ties: room id). */
function spaceCallRoom(spaceId: string): string {
  const space = peekClient()?.getRoom(spaceId);
  if (!space) return "";
  let best = "";
  let n = 0;
  for (const ev of space.currentState.getStateEvents("m.space.child")) {
    const id = ev.getStateKey() ?? "";
    const via = (ev.getContent() as { via?: unknown }).via;
    if (!id || !Array.isArray(via) || !via.length) continue;
    const rc = roomCall(id);
    if (!rc.active) continue;
    const k = rc.participants.length;
    if (k > n || (k === n && id < best)) {
      best = id;
      n = k;
    }
  }
  return best;
}

/** The events Up next shows for `days` of look-ahead (all of them; the widget decides how many per size). */
export function useUpNext(days: number): UpNextModel {
  const data = useDerived("widgets.upnext.v1", spec);
  const pending = useCal((x) => x.myPending);
  const [now, setNow] = useState(() => Date.now());
  const events = useMemo(() => {
    const byKey = new Map<string, Row>();
    for (const r of data.rows) byKey.set(`${r.container}/${r.ev.id}`, r);
    const items = data.rows.map((r) => ({ container: r.container, id: r.ev.id, kind: r.ev.kind, start: r.ev.effStart, end: r.ev.effEnd, canceled: r.ev.canceled }));
    return selectUpNext(items, now, days, 0).map((it) => {
      const r = byKey.get(`${it.container}/${it.id}`)!;
      const ev = r.ev;
      const mine = mineOf(ev, pending);
      return {
        key: `${r.container}/${ev.id}`,
        container: r.container,
        id: ev.id,
        title: ev.title,
        kind: String(ev.kind),
        start: ev.effStart,
        end: ev.effEnd,
        game: ev.game,
        cover: ev.gameId ? artUrl(CATALOG_BASE, ev.gameId, "portrait") : "",
        gameId: ev.gameId || "",
        tbd: !ev.game && ev.kind !== "focus" && !ev.canceled,
        going: ev.rsvp.yes,
        maybe: ev.rsvp.maybe,
        my: mine.status,
        myOptions: mine.options,
        canWrite: r.canWrite,
        callRoom: ev.announce?.room || (r.space ? "" : r.container),
        containerIsSpace: r.space,
        ring: ringOf(ev.effStart, ev.effEnd, now),
      } satisfies UpEvent;
    });
  }, [data, pending, now, days]);

  // the hero's call, while it starts soon or runs
  const hero = events[0];
  const soon = !!hero && (hero.ring.phase === "soon" || hero.ring.phase === "live");
  const room = !soon ? "" : hero!.callRoom || (hero!.containerIsSpace ? spaceCallRoom(hero!.container) : "");
  const call = useRoomCall(room || null);
  const inIt = useCall((st) => !!room && st.inCall && st.callRoomId === room);
  const join = soon && room ? { room, active: call.active, inIt } : null;

  // ONE timer: the earliest moment a shown ring / phase / label changes (§10.4), ≥ 1 s away
  const nextAt = events.reduce<number | null>((m, e) => (e.ring.nextAt !== null && (m === null || e.ring.nextAt < m) ? e.ring.nextAt : m), null);
  useEffect(() => {
    if (nextAt === null) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(1000, nextAt - Date.now() + 20));
    return () => window.clearTimeout(t);
  }, [nextAt]);
  // back from the background (throttled timers): catch up at once
  useEffect(() => onWinState((st) => st !== "hidden" && setNow(Date.now())), []);
  return useMemo(() => ({ ready: data !== EMPTY, now, events, join }), [data, now, events, join?.room, join?.active, join?.inIt]); // eslint-disable-line react-hooks/exhaustive-deps
}

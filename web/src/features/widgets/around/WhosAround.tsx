// around/WhosAround.tsx — the Who's around widget (contract WIDGETS-UI.md §6, WIDGETS.md §8 + its amendments): friends
// who SHARE their status (the Reach presence service — never Synapse presence), grouped Playing (a call room with a
// now-playing game), In a call, Online, Away by the shared groupAround (src/widgets/people.ts, WIDGETS.md §10.6).
// Click → DM, hover → profile card, right-click → Message / Call / View profile. Viewing is non-reciprocal (REACH
// §2.5): after "No thanks" a footer line offers "Turn on"; before the question is answered the room list's card asks.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ClientEvent, RoomStateEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { openRoom, openUserProfile, startCall } from "@/core/bus";
import { useDerived, useSession } from "@/core/matrix";
import { Avatar, Button, ContextMenu, Icon, MenuItem, Popover, cx, useIsTouch } from "@/ui";
import { useCall } from "@/features/calls";
import { PadButton, usePadTargets } from "@/features/pad";
import { recorderRule } from "@/core/server";
import { messageUser } from "@/features/nav";
import { PresenceLine, StatusChip, avatarDot, readNow, turnSharingOn, usePresenceStore, viewOf, type PresenceRow } from "@/features/presence";
import { groupAround, type AroundGroups, type AroundRoom } from "@/widgets/people";
import { OnThisPhone } from "@/features/native";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { CrossFade, Roll, useFreshIds } from "../motion";
import { nameNow, usePerson, useRoomLabel } from "../names";
import { useGameCover } from "./covers";
import s from "./WhosAround.module.css";
import { PersonMenuItems } from "@/features/safety";

const ACTIVITY_TYPE = "dev.tinhat.activity";

export interface AroundModel {
  /** the first read of the status service is in (or a last map is known) */
  ready: boolean;
  sharing: boolean;
  /** the one-time question was answered (No thanks / Turn on) — until then the room list's card asks it */
  asked: boolean;
  busy: boolean;
  /** the service is unreachable and there is no last map */
  error: boolean;
  groups: AroundGroups;
  /** each listed person's Reach row (dot, custom status) */
  rows: Record<string, PresenceRow>;
  /** the room of the call I am in (Join → "You're here") */
  myCallRoom: string | null;
}

/** The now-playing activity of every joined room (`dev.tinhat.activity`, key ""), as written. */
interface Activities {
  map: Record<string, { game?: unknown; emoji?: unknown }>;
  fp: string;
}
const activitySpec = () => ({
  attach(c: MatrixClient, changed: () => void) {
    const onState = (ev: MatrixEvent) => {
      if (ev.getType() === ACTIVITY_TYPE) changed();
    };
    c.on(RoomStateEvent.Events, onState);
    c.on(ClientEvent.Room, changed);
    return () => {
      c.off(RoomStateEvent.Events, onState);
      c.off(ClientEvent.Room, changed);
    };
  },
  compute(c: MatrixClient | null): Activities {
    const map: Record<string, { game?: unknown; emoji?: unknown }> = {};
    for (const r of c?.getRooms() ?? []) {
      const cont = r.currentState.getStateEvents(ACTIVITY_TYPE, "")?.getContent() as Record<string, unknown> | undefined;
      if (cont && (cont.game !== undefined || cont.emoji !== undefined)) map[r.roomId] = { game: cont.game, emoji: cont.emoji };
    }
    return { map, fp: JSON.stringify(map) };
  },
  equal: (a: Activities, b: Activities) => a.fp === b.fp,
});

function useAround(ctx: WidgetCtx): AroundModel {
  const me = useSession().userId ?? "";
  const users = usePresenceStore((st) => st.users);
  const known = usePresenceStore((st) => st.known && st.live);
  const share = usePresenceStore((st) => st.share && !st.turningOff);
  const asked = usePresenceStore((st) => st.asked);
  const busy = usePresenceStore((st) => st.busy);
  const error = usePresenceStore((st) => st.error);
  const okAt = usePresenceStore((st) => st.okAt);
  const myCallRoom = useCall((st) => (st.inCall ? st.callRoomId : null));
  const acts = useDerived("widgets.activities.v2", activitySpec);
  const showAway = ctx.settings.away !== false;
  return useMemo(() => {
    const people = Object.entries(users).map(([id, row]) => ({ id, name: nameNow(id, row.room ?? null), state: row.state, room: row.room ?? null }));
    const groups = groupAround({ me, people, activities: acts.map, showAway, recorder: recorderRule() });
    return { ready: known || okAt > 0, sharing: share, asked, busy, error: !okAt && !!error, groups, rows: users, myCallRoom };
  }, [users, me, known, share, asked, busy, error, okAt, acts, showAway, myCallRoom]);
}

// ---- rows ---------------------------------------------------------------------------------------------------------

function Face({ mxid, room, size, enter }: { mxid: string; room?: string; size: number; enter?: boolean }) {
  const who = usePerson(mxid, room);
  return (
    <span className={cx(s.face, enter && "tw-enter-side")} title={who.name}>
      <Avatar size={size} name={who.name} seed={mxid} imageSource={who.avatar} />
    </span>
  );
}

function Faces({ ids, room, size = 16, max = 4 }: { ids: string[]; room?: string; size?: number; max?: number }) {
  const fresh = useFreshIds(ids);
  return (
    <span className={s.faces}>
      {ids.slice(0, max).map((m) => (
        <Face key={m} mxid={m} room={room} size={size} enter={fresh.has(m)} />
      ))}
      {ids.length > max && <span className={s.more}>+{ids.length - max}</span>}
    </span>
  );
}

function JoinOrHere({ room, here, preview }: { room: string; here: boolean; preview: boolean }) {
  // Pad (features/pad): one of my other devices is in that call → Pad beside Join
  const pad = usePadTargets(preview ? null : room);
  if (here) return <span className={s.here}>You're here</span>;
  return (
    <>
      {pad.length > 0 && <PadButton roomId={room} targets={pad} compact className={s.join} />}
      <Button
        highlighted
        className={s.join}
        text="Join"
        disabled={preview}
        onClick={(e) => {
          e.stopPropagation();
          startCall(room);
        }}
      />
    </>
  );
}

function RoomRow({ g, playing, enter, myCallRoom, ctx }: { g: AroundRoom; playing: boolean; enter: boolean; myCallRoom: string | null; ctx: WidgetCtx }) {
  const name = useRoomLabel(g.room) || "a room";
  const cover = useGameCover(playing ? g.game : "");
  const open = () => !ctx.preview && openRoom(g.room);
  return (
    <div className={cx(s.roomRow, enter && "tw-enter-down")} role="button" tabIndex={ctx.preview ? -1 : 0} onClick={open} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && open()} data-room-row="">
      {playing ? (
        <CrossFade className={s.cover} src={cover} fallback={<span className={s.emojiTile}>{g.emoji || "🎮"}</span>} />
      ) : (
        <span className={s.callTile}>
          <Icon name="headphones-symbolic" size={14} color="var(--th-widget-around-call-icon)" staticOnly />
        </span>
      )}
      <span className={s.roomText}>
        <span className={s.roomTitle}>{playing ? g.game : name}</span>
        <span className={s.roomSub}>
          {playing && <span className={s.inRoom}>in {name}</span>}
          <Faces ids={g.people} room={g.room} size={ctx.mobile ? 20 : 16} />
        </span>
      </span>
      <OnThisPhone roomId={g.room} inline buttonClass={s.join}>
        <JoinOrHere room={g.room} here={myCallRoom === g.room} preview={ctx.preview} />
      </OnThisPhone>
    </div>
  );
}

function PersonMenu({ mxid, close }: { mxid: string; close: () => void }) {
  return (
    <>
      <MenuItem text="Message" icon="dialog-messages-symbolic" onTriggered={() => (close(), void messageUser(mxid))} />
      <MenuItem
        text="Call"
        icon="call-start-symbolic"
        onTriggered={() => {
          close();
          void messageUser(mxid).then((room) => room && startCall(room));
        }}
      />
      <MenuItem text="View profile" icon="user-symbolic" onTriggered={() => (close(), openUserProfile(mxid))} />
      <PersonMenuItems mxid={mxid} />
    </>
  );
}

function HoverCard({ mxid, anchor, onClose }: { mxid: string; anchor: HTMLElement; onClose: () => void }) {
  const who = usePerson(mxid);
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="right" gap={8} closeOnOutside sheetOnMobile={false} className={s.card}>
      <div className={s.cardBody}>
        <Avatar size={48} name={who.name} seed={mxid} imageSource={who.avatar} />
        <div className={s.cardText}>
          <div className={s.cardName}>{who.name}</div>
          <div className={s.cardId}>{mxid}</div>
          <PresenceLine mxid={mxid} />
        </div>
      </div>
    </Popover>
  );
}

function PersonRowView({ id, row, away, enter, full, ctx }: { id: string; row: PresenceRow; away?: boolean; enter: boolean; full?: boolean; ctx: WidgetCtx }) {
  const who = usePerson(id);
  const v = viewOf(row);
  const ref = useRef<HTMLDivElement>(null);
  const touch = useIsTouch();
  const [hover, setHover] = useState(false);
  const timer = useRef(0);
  const inCall = row.state === "call";
  const open = () => !ctx.preview && void messageUser(id);
  return (
    <ContextMenu menu={(close) => <PersonMenu mxid={id} close={close} />} disabled={ctx.preview}>
      <div
        ref={ref}
        className={cx(s.person, enter && "tw-enter-down", full && s.personFull)}
        role="button"
        tabIndex={ctx.preview ? -1 : 0}
        onClick={open}
        onKeyDown={(e) => e.key === "Enter" && open()}
        onPointerEnter={() => {
          if (touch || ctx.preview) return;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setHover(true), 500);
        }}
        onPointerLeave={() => {
          window.clearTimeout(timer.current);
          setHover(false);
        }}
      >
        <Avatar size={ctx.mobile ? 28 : 20} name={who.name} seed={id} imageSource={who.avatar} {...avatarDot(row, "var(--th-widget-bg)")} />
        <span className={s.name} data-away={away ? "" : undefined}>
          {who.name}
        </span>
        {v.chip ? <StatusChip text={v.chip.text} color={v.chip.color} className={s.chip} title={v.chip.text} /> : inCall ? <span className={s.state}>In a call</span> : null}
      </div>
      {hover && ref.current && <HoverCard mxid={id} anchor={ref.current} onClose={() => setHover(false)} />}
    </ContextMenu>
  );
}

function StripFace({ id, row, ctx, size = 26 }: { id: string; row: PresenceRow | undefined; ctx: WidgetCtx; size?: number }) {
  const who = usePerson(id);
  const v = row ? viewOf(row) : null;
  const ring = v ? v.dot : "var(--th-widget-quality-unknown-fill)";
  return (
    <button
      type="button"
      className={s.stripFace}
      style={{ boxShadow: `0 0 0 1px var(--th-widget-bg), 0 0 0 3px ${ring}` }}
      title={v?.chip ? `${who.name} · ${v.chip.text}` : v ? `${who.name} · ${v.label}` : who.name}
      aria-label={who.name}
      disabled={ctx.preview}
      onClick={(e) => {
        e.stopPropagation();
        void messageUser(id);
      }}
    >
      <Avatar size={size} name={who.name} seed={id} imageSource={who.avatar} />
    </button>
  );
}

function Strip({ ids, rows, ctx }: { ids: string[]; rows: Record<string, PresenceRow>; ctx: WidgetCtx }) {
  const fresh = useFreshIds(ids);
  const shown = ids.slice(0, 14);
  return (
    <div className={s.strip}>
      {shown.map((id) => (
        <span key={id} className={fresh.has(id) ? "tw-enter-down" : undefined}>
          <StripFace id={id} row={rows[id]} ctx={ctx} />
        </span>
      ))}
      {ids.length > shown.length && <span className={s.more}>+{ids.length - shown.length}</span>}
    </div>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <div className={s.group}>
      <div className={s.label}>
        {label} · <Roll value={count} />
      </div>
      {children}
    </div>
  );
}

// ---- the widget -------------------------------------------------------------------------------------------------------

function Body({ model: m, ctx }: PartProps<AroundModel>) {
  const L = ctx.size === "L";
  const g = m.groups;
  const keys = [...g.playing.map((r) => `r:${r.room}`), ...g.inCall.map((r) => `r:${r.room}`), ...g.callElsewhere, ...g.online, ...g.away];
  const fresh = useFreshIds(keys);
  if (!m.ready) return <div className={s.status}>Checking who's around…</div>;
  if (m.error && !g.total)
    return (
      <div className={s.status}>
        Can't reach the status service ·{" "}
        <button type="button" className={s.link} disabled={ctx.preview} onClick={() => void readNow()}>
          Retry
        </button>
      </div>
    );
  const people = (ids: string[], away?: boolean) =>
    !L && ids.length > 3 ? (
      <Strip ids={ids} rows={m.rows} ctx={ctx} />
    ) : (
      ids.map((id) => <PersonRowView key={id} id={id} row={m.rows[id] ?? { state: away ? "away" : "online" }} away={away} enter={fresh.has(id)} full={L} ctx={ctx} />)
    );
  const inCallCount = g.inCall.reduce((n, r) => n + r.people.length, 0) + g.callElsewhere.length;
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {g.total === 0 && (
        <div className={s.empty}>
          <span>Nobody's around right now</span>
          <span className={s.emptyHint}>Friends who share their status show up here.</span>
        </div>
      )}
      {g.playing.length > 0 && (
        <Group label="Playing" count={g.playing.reduce((n, r) => n + r.people.length, 0)}>
          {g.playing.map((r) => (
            <RoomRow key={r.room} g={r} playing enter={fresh.has(`r:${r.room}`)} myCallRoom={m.myCallRoom} ctx={ctx} />
          ))}
        </Group>
      )}
      {inCallCount > 0 && (
        <Group label="In a call" count={inCallCount}>
          {g.inCall.map((r) => (
            <RoomRow key={r.room} g={r} playing={false} enter={fresh.has(`r:${r.room}`)} myCallRoom={m.myCallRoom} ctx={ctx} />
          ))}
          {g.callElsewhere.map((id) => (
            <PersonRowView key={id} id={id} row={m.rows[id] ?? { state: "call" }} enter={fresh.has(id)} full={L} ctx={ctx} />
          ))}
        </Group>
      )}
      {g.online.length > 0 && (
        <Group label="Online" count={g.online.length}>
          {people(g.online)}
        </Group>
      )}
      {g.away.length > 0 && (
        <Group label="Away" count={g.away.length}>
          {people(g.away, true)}
        </Group>
      )}
    </div>
  );
}

/** Small / collapsed: up to 6 overlapping faces (the Small row's order), each in a ring of its presence colour. */
function SmallFace({ id, row, ctx }: { id: string; row: PresenceRow | undefined; ctx: WidgetCtx }) {
  const who = usePerson(id);
  const v = row ? viewOf(row) : null;
  const size = ctx.mobile ? 24 : 20;
  return (
    <span className={s.sface} style={{ width: size, height: size, borderColor: v?.dot ?? "var(--th-widget-quality-unknown-fill)" }} title={v?.chip ? `${who.name} · ${v.chip.text}` : v ? `${who.name} · ${v.label}` : who.name}>
      <Avatar size={size - 4} name={who.name} seed={id} imageSource={who.avatar} />
    </span>
  );
}

function Summary({ model: m, ctx }: PartProps<AroundModel>) {
  const list = m.groups.summary;
  if (!m.ready) return <span className={s.summaryText}>Checking…</span>;
  if (!list.length) return <span className={s.summaryText}>Nobody around</span>;
  const shown = list.slice(0, 6);
  return (
    <span className={s.summaryFaces} aria-label={`${list.length} around`}>
      {shown.map((id) => (
        <SmallFace key={id} id={id} row={m.rows[id]} ctx={ctx} />
      ))}
      {list.length > shown.length && <span className={s.more}>+{list.length - shown.length}</span>}
    </span>
  );
}

/** M / L header: after "No thanks" (asked, not sharing) — "● Hidden · Turn on" (REACH §2.5: you still see others). */
function HiddenNote({ model: m, ctx }: PartProps<AroundModel>) {
  if (m.sharing || !m.asked) return null;
  return (
    <span className={s.hiddenNote} title="You're hidden from others" data-hidden-note="">
      <span className={s.hiddenDot} />
      <span>Hidden ·</span>
      <button
        type="button"
        className={s.link}
        disabled={m.busy || ctx.preview}
        onClick={(e) => {
          e.stopPropagation();
          void turnSharingOn();
        }}
      >
        {m.busy ? "Turning on…" : "Turn on"}
      </button>
    </span>
  );
}

// ---- samples ----------------------------------------------------------------------------------------------------------

const SP = (id: string) => `@${id}:sample.invalid`;
function sample(opts: { many?: boolean; empty?: boolean; hidden?: boolean; loading?: boolean; error?: boolean; inCall?: boolean } = {}): AroundModel {
  const lounge = "!lounge:sample.invalid";
  const squad = "!squad:sample.invalid";
  const rows: Record<string, PresenceRow> = opts.empty
    ? {}
    : {
        [SP("ana")]: { state: "call", room: lounge },
        [SP("bo")]: { state: "call", room: lounge, status: { text: "Carrying", emoji: "🛡️", color: "#5865F2" } },
        [SP("cy")]: { state: "call", room: lounge },
        [SP("dee")]: { state: "call", room: squad },
        [SP("eli")]: { state: "call" },
        [SP("fay")]: { state: "online", status: { text: "Looking for group", emoji: "🎯", color: "#3BA55C" } },
        [SP("gus")]: { state: "online" },
        [SP("hal")]: { state: "away", status: { text: "BRB · pizza", emoji: "🍕", color: "#FAA81A" } },
        ...(opts.many
          ? { [SP("ivy")]: { state: "online" }, [SP("jo")]: { state: "online" }, [SP("kit")]: { state: "online", status: { text: "Streaming", emoji: "📺", color: "#EB459E" } } }
          : {}),
      };
  const names: Record<string, string> = { ana: "Ana", bo: "Bo", cy: "Cy", dee: "Dee", eli: "Eli", fay: "Fay", gus: "Gus", hal: "Hal", ivy: "Ivy", jo: "Jo", kit: "Kit" };
  const people = Object.entries(rows).map(([id, row]) => ({ id, name: names[id.slice(1, id.indexOf(":"))] ?? id, state: row.state, room: row.room ?? null }));
  const groups = groupAround({ me: "@me:sample.invalid", people, activities: { [lounge]: { game: "Valheim", emoji: "⚔️" } }, showAway: true });
  return {
    ready: !opts.loading,
    sharing: !opts.hidden,
    asked: true,
    busy: false,
    error: !!opts.error,
    groups: opts.error ? groupAround({ me: "", people: [], activities: {}, showAway: true }) : groups,
    rows,
    myCallRoom: opts.inCall ? lounge : null,
  };
}

export const whosAround = defineWidget<AroundModel>({
  id: "whosAround",
  useModel: useAround,
  live: (m) => m.groups.playing.length > 0 || m.groups.inCall.length > 0 || m.groups.callElsewhere.length > 0,
  Summary,
  HeaderExtra: HiddenNote,
  Body,
  hasData: (m) => m.ready && m.groups.total > 0,
  samples: {
    preview: () => sample(),
    groups: () => sample(),
    many: () => sample({ many: true }),
    here: () => sample({ inCall: true }),
    hidden: () => sample({ hidden: true }),
    empty: () => sample({ empty: true }),
    loading: () => sample({ loading: true }),
    error: () => sample({ error: true, empty: true }),
  },
});

// pinned/Pinned.tsx — the Pinned widget (contract WIDGETS.md §11, WIDGETS-UI.md §11; widgets W1, 2026-09-28): the open
// room's pins (`m.room.pinned_events`), newest pin first — M the first 3, L the first 8, S / collapsed "3 pins · latest:
// …". A row = the sender's avatar and name, the time, and the message's one-line snippet (or an attachment icon + its
// name), decrypted the way the timeline decrypts it (resolve.ts). Click → the message in the timeline, the same jump the
// chat's pinned popover uses (the main view's jumpTo; a room that isn't on screen opens at the event). ⋯ (hover) /
// right-click / long-press → Jump to message · Unpin (when you may edit the room's pins, the message menu's rule).
// "The open room" = the room the main view shows; with none on screen (the phone's room list) the last room you opened
// (the shell's `last-room`). No timer: it redraws only when the pins, their events or the room change.
import { useMemo, useRef, useState } from "react";
import { jumpToEvent, openRoom } from "@/core/bus";
import { usePowerLevels, useRoomState } from "@/core/matrix";
import { usePref } from "@/core/prefs";
import { Avatar, ContextMenu, Icon, Menu, MenuItem, cx, useTip } from "@/ui";
import { canPin, setPinned, showsRoom } from "@/features/chat";
import { fmtClock, useClockMode, type ClockMode } from "@/features/settings";
import { pinOrder, pinSummary, whenLabel, whenOf, type SnippetKind } from "@/widgets/recent";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { SAMPLE_SERVER, usePerson, useRoomLabel } from "../names";
import { usePinRows, type PinRow } from "./resolve";
import s from "./Pinned.module.css";

export interface PinnedModel {
  /** the room whose pins show ("" = none) */
  room: string;
  /** every pinned id (pinOrder) — the S line's count */
  count: number;
  /** the rows of the first 3 (M) / 8 (L) pins that resolved, newest pin first */
  rows: PinRow[];
  /** some of those are still being fetched */
  loading: boolean;
  /** may I edit the room's pins (Unpin) */
  canUnpin: boolean;
}

/** How many rows each size shows (S / collapsed read the first for their line). */
export const PIN_ROWS = { S: 1, M: 3, L: 8 } as const;

/** The snippet kinds that lead with an icon (the attachment's). */
const KIND_ICON: Partial<Record<SnippetKind, string>> = {
  image: "image-x-generic",
  video: "video-x-generic",
  audio: "audio-x-generic",
  voice: "audio-input-microphone-symbolic",
  file: "text-x-generic",
  sticker: "face-smile-symbolic",
  encrypted: "channel-secure-symbolic",
};

function usePinned(ctx: WidgetCtx): PinnedModel {
  const room = String(usePref("last-room", "")) || "";
  const content = useRoomState(room || null, "m.room.pinned_events", "");
  const ids = useMemo(() => pinOrder(content), [content]);
  const n = ctx.size === "L" && !ctx.preview ? PIN_ROWS.L : PIN_ROWS.M;
  const { rows, loading } = usePinRows(room || null, ids, n);
  const pl = usePowerLevels(room || null);
  const may = useMemo(() => (room ? canPin(room) : false), [room, pl]); // eslint-disable-line react-hooks/exhaustive-deps
  return { room, count: ids.length, rows, loading, canUnpin: may };
}

/** Click → the message: the main view's own jump when it shows the room (the pinned popover's path), else the room
 *  opens at the event (the permalink path — the same jumpTo once it is on screen). */
function jumpToPin(room: string, id: string): void {
  if (showsRoom(room)) jumpToEvent(room, id);
  else openRoom(room, { eventId: id });
}

function whenText(ts: number, mode: ClockMode): string {
  const now = Date.now();
  return whenLabel(whenOf(ts, now, -new Date(now).getTimezoneOffset()), fmtClock(ts, mode));
}

function RowMenu({ r, m, close }: { r: PinRow; m: PinnedModel; close: () => void }) {
  return (
    <>
      <MenuItem text="Jump to message" icon="go-next-symbolic" onTriggered={() => (close(), jumpToPin(m.room, r.id))} />
      {m.canUnpin && <MenuItem text="Unpin" icon="window-pin-symbolic" onTriggered={() => (close(), void setPinned(m.room, r.id, false))} />}
    </>
  );
}

function PinRowView({ r, m, ctx, enter }: { r: PinRow; m: PinnedModel; ctx: WidgetCtx; enter: boolean }) {
  const who = usePerson(r.sender, m.room);
  const mode = useClockMode();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useTip(moreBtn, menu ? "" : "More");
  const icon = KIND_ICON[r.kind];
  const open = () => !ctx.preview && jumpToPin(m.room, r.id);
  const quiet = r.kind === "deleted" || r.kind === "encrypted";
  return (
    <ContextMenu menu={(close) => <RowMenu r={r} m={m} close={close} />} disabled={ctx.preview} title="Pinned message">
      <div
        className={cx(s.row, enter && "tw-enter-up", menu && s.rowOpen)}
        role="button"
        tabIndex={ctx.preview ? -1 : 0}
        onClick={open}
        onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
        data-pin-row={r.id}
      >
        <Avatar size={ctx.mobile ? 28 : 20} name={who.name} seed={r.sender} imageSource={who.avatar} />
        <span className={s.text}>
          <span className={s.line1}>
            <span className={s.name}>{who.name}</span>
            <span className={s.when}>{whenText(r.ts, mode)}</span>
          </span>
          <span className={s.line2} data-quiet={quiet ? "" : undefined}>
            {icon && <Icon name={icon} size={ctx.mobile ? 14 : 12} color={quiet ? "var(--th-widget-muted-fg)" : "var(--th-widget-meta-fg)"} className={s.kindIcon} staticOnly />}
            <span className={s.snip}>{r.text}</span>
          </span>
        </span>
        {!ctx.mobile && !ctx.preview && (
          <button
            ref={moreBtn}
            type="button"
            className={s.moreBtn}
            aria-label="Pinned message options"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu ? null : e.currentTarget);
            }}
          >
            <Icon name="overflow-menu-symbolic" size={16} color="var(--th-widget-menu-icon)" staticOnly />
          </button>
        )}
      </div>
      {menu && (
        <Menu open onClose={() => setMenu(null)} anchor={menu} placement="below" title="Pinned message" width={190}>
          <RowMenu r={r} m={m} close={() => setMenu(null)} />
        </Menu>
      )}
    </ContextMenu>
  );
}

function Body({ model: m, ctx }: PartProps<PinnedModel>) {
  const limit = ctx.size === "L" && !ctx.preview ? PIN_ROWS.L : PIN_ROWS.M;
  const shown = m.rows.slice(0, limit);
  const fresh = useFreshIds(shown.map((r) => r.id));
  if (!m.room) return <div className={s.status}>Open a room to see its pins</div>;
  if (!m.count)
    return (
      <div className={s.empty}>
        <span>No pins in this room</span>
        <span className={s.emptyHint}>Pin a message from its menu to keep it here.</span>
      </div>
    );
  if (!shown.length) return <div className={s.status}>{m.loading ? "Loading pins…" : "Can't show these pins"}</div>;
  const more = m.count - limit;
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {shown.map((r) => (
        <PinRowView key={r.id} r={r} m={m} ctx={ctx} enter={fresh.has(r.id)} />
      ))}
      {more > 0 && <div className={s.moreLine}>+ {more} more</div>}
    </div>
  );
}

function Summary({ model: m }: PartProps<PinnedModel>) {
  if (!m.room) return <span className={s.summaryText}>No room open</span>;
  return <span className={s.summaryText}>{pinSummary(m.count, m.rows[0]?.text ?? "")}</span>;
}

/** M / L header: the room the pins are from. */
function RoomName({ model: m }: PartProps<PinnedModel>) {
  const name = useRoomLabel(m.room || null);
  if (!m.room || !name) return null;
  return (
    <span className={s.roomName} title={name}>
      {name}
    </span>
  );
}

// ---- samples (the gallery's preview, the review screenshots, the gates) ------------------------------------------------

const SP = (id: string) => `@${id}:${SAMPLE_SERVER}`;
const LOUNGE = `!lounge:${SAMPLE_SERVER}`;
/** Local time `daysAgo` days back at h:m — the samples' times read the same all day (today 6:00 PM, Yesterday, a
 *  weekday, a date), so two captures of a sample state never differ by the clock. */
function localAt(daysAgo: number, h: number, m: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
/** Sample pins, newest first — the desktop's PinnedWidget.qml sample holds the same rows. */
function samplePins(): PinRow[] {
  return [
    { id: "$p1", sender: SP("ana"), ts: localAt(0, 18, 0), kind: "text", text: "Tonight: bring potions and the good snacks" },
    { id: "$p2", sender: SP("bo"), ts: localAt(1, 20, 15), kind: "image", text: "boss-route.png" },
    { id: "$p3", sender: SP("cy"), ts: localAt(3, 12, 0), kind: "text", text: "Raid starts 9 PM sharp — meet at the portal" },
    { id: "$p4", sender: SP("dee"), ts: localAt(4, 12, 0), kind: "voice", text: "Voice message" },
    { id: "$p5", sender: SP("eli"), ts: localAt(9, 12, 0), kind: "file", text: "patch-notes.pdf" },
    { id: "$p6", sender: SP("fay"), ts: localAt(12, 12, 0), kind: "encrypted", text: "Encrypted message" },
    { id: "$p7", sender: SP("gus"), ts: localAt(20, 12, 0), kind: "video", text: "clutch-1v4.mp4" },
    { id: "$p8", sender: SP("hal"), ts: localAt(40, 12, 0), kind: "text", text: "House rules: no spoilers in #general" },
  ];
}
function sample(opts: { count?: number; room?: boolean; loading?: boolean } = {}): PinnedModel {
  const all = samplePins();
  const count = opts.count ?? 5;
  return { room: opts.room === false ? "" : LOUNGE, count, rows: opts.loading ? [] : all.slice(0, Math.min(count, 8)), loading: !!opts.loading, canUnpin: true };
}

export const pinned = defineWidget<PinnedModel>({
  id: "pinned",
  useModel: usePinned,
  live: () => false,
  Summary,
  HeaderExtra: RoomName,
  Body,
  hasData: (m) => !!m.room && m.count > 0 && m.rows.length > 0,
  samples: {
    preview: () => sample(),
    data: () => sample(),
    many: () => sample({ count: 12 }),
    one: () => sample({ count: 1 }),
    empty: () => sample({ count: 0 }),
    noroom: () => sample({ room: false, count: 0 }),
    loading: () => sample({ loading: true }),
  },
});

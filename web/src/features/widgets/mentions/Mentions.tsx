// mentions/Mentions.tsx — the Mentions widget (contract WIDGETS.md §13, WIDGETS-UI.md §13; widgets W1, 2026-09-28): your
// recent mentions and replies across rooms, newest first — M the last 5, L the last 12, S / collapsed "2 new mentions ·
// Gaming Central". The list is this device's (tracker.ts: the events js-sdk's push-rule evaluation highlights after
// decryption, kept as ids — store.ts); a row's text is resolved when it shows (../eventRows.ts, memory only). A mention
// you haven't opened carries the mention wash + edge; the header counts them (live dot). Click → the message (the main
// view's jump when it shows the room, else the room opens at the event) and it counts as seen; a room shown in the app
// marks its mentions seen. ⋯ / right-click / long-press → Jump to message · Mark as seen · Mark all as seen.
import { useMemo, useRef, useState } from "react";
import { jumpToEvent, openRoom } from "@/core/bus";
import { Avatar, ContextMenu, Icon, Menu, MenuItem, cx, useTip } from "@/ui";
import { showsRoom } from "@/features/chat";
import { fmtClock, useClockMode, type ClockMode } from "@/features/settings";
import { mentionSummary, unseenCount, type Mention } from "@/widgets/mentions";
import { whenLabel, whenOf, type SnippetKind } from "@/widgets/recent";
import { useEventRows } from "../eventRows";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { SAMPLE_SERVER, roomNameNow, usePerson, useRoomLabel } from "../names";
import { markMentionsSeen, useMentions } from "./store";
import s from "./Mentions.module.css";

export interface MentionRow extends Mention {
  /** resolved (false while its event is being fetched) */
  ready: boolean;
  kind: SnippetKind;
  text: string;
}

export interface MentionsModel {
  rows: MentionRow[];
  total: number;
  unseen: number;
  summary: string;
  /** a sample (the gallery, the gates): the room names come from the sample table */
  sample?: boolean;
}

export const MENTION_ROWS = { S: 1, M: 5, L: 12 } as const;

const KIND_ICON: Partial<Record<SnippetKind, string>> = {
  image: "image-x-generic",
  video: "video-x-generic",
  audio: "audio-x-generic",
  voice: "audio-input-microphone-symbolic",
  file: "text-x-generic",
  sticker: "face-smile-symbolic",
  encrypted: "channel-secure-symbolic",
};

function useMentionsModel(ctx: WidgetCtx): MentionsModel {
  const list = useMentions();
  const n = ctx.size === "L" && !ctx.preview ? MENTION_ROWS.L : MENTION_ROWS.M;
  const refs = useMemo(() => list.slice(0, n).map((m) => ({ room: m.r, id: m.e })), [list, n]);
  const { rows } = useEventRows(refs);
  return useMemo(() => {
    const out: MentionRow[] = list.slice(0, n).map((m) => {
      const k = `${m.r}\u0000${m.e}`;
      if (!rows.has(k)) return { ...m, ready: false, kind: "text", text: "" };
      const row = rows.get(k);
      return row ? { ...m, ready: true, kind: row.kind, text: row.text } : { ...m, ready: true, kind: "other", text: "Message not available" };
    });
    return { rows: out, total: list.length, unseen: unseenCount(list), summary: mentionSummary(list, roomNameNow) };
  }, [list, rows, n]);
}

/** Click → the message: the main view's own jump when it shows the room, else the room opens at the event. */
function jump(m: Mention): void {
  markMentionsSeen({ e: m.e });
  if (showsRoom(m.r)) jumpToEvent(m.r, m.e);
  else openRoom(m.r, { eventId: m.e });
}

function whenText(ts: number, mode: ClockMode): string {
  const now = Date.now();
  return whenLabel(whenOf(ts, now, -new Date(now).getTimezoneOffset()), fmtClock(ts, mode));
}

function RowMenu({ r, m, close, sample }: { r: MentionRow; m: MentionsModel; close: () => void; sample: boolean }) {
  return (
    <>
      <MenuItem text="Jump to message" icon="go-next-symbolic" onTriggered={() => (close(), !sample && jump(r))} />
      {r.seen !== true && <MenuItem text="Mark as seen" icon="object-select-symbolic" onTriggered={() => (close(), !sample && markMentionsSeen({ e: r.e }))} />}
      {m.unseen > 0 && <MenuItem text="Mark all as seen" icon="checkmark-symbolic" onTriggered={() => (close(), !sample && markMentionsSeen({}))} />}
    </>
  );
}

function Row({ r, m, ctx, enter }: { r: MentionRow; m: MentionsModel; ctx: WidgetCtx; enter: boolean }) {
  const who = usePerson(r.s, r.r);
  const room = useRoomLabel(r.r);
  const mode = useClockMode();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useTip(moreBtn, menu ? "" : "More");
  const unseen = r.seen !== true;
  const icon = r.ready ? KIND_ICON[r.kind] : undefined;
  const quiet = !r.ready || r.kind === "deleted" || r.kind === "encrypted";
  const sample = !!m.sample;
  const open = () => !ctx.preview && !sample && jump(r);
  return (
    <ContextMenu menu={(close) => <RowMenu r={r} m={m} close={close} sample={sample} />} disabled={ctx.preview} title="Mention">
      <div
        className={cx(s.row, enter && "tw-enter-up", menu && s.rowOpen)}
        data-unseen={unseen ? "" : undefined}
        role="button"
        tabIndex={ctx.preview ? -1 : 0}
        aria-label={`${who.name} in ${room}: ${r.text}${unseen ? " (new)" : ""}`}
        onClick={open}
        onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
        data-mention-row={r.e}
      >
        <Avatar size={ctx.mobile ? 28 : 20} name={who.name} seed={r.s} imageSource={who.avatar} />
        <span className={s.text}>
          <span className={s.line1}>
            <span className={cx(s.name, unseen && s.nameUnseen)}>{who.name}</span>
            {room && <span className={s.room}> · {room}</span>}
            <span className={s.when}>{whenText(r.t, mode)}</span>
          </span>
          <span className={s.line2} data-quiet={quiet ? "" : undefined}>
            {icon && <Icon name={icon} size={ctx.mobile ? 14 : 12} color={quiet ? "var(--th-widget-muted-fg)" : "var(--th-widget-meta-fg)"} className={s.kindIcon} staticOnly />}
            <span className={s.snip}>{r.ready ? r.text : "…"}</span>
          </span>
        </span>
        {!ctx.mobile && !ctx.preview && (
          <button
            ref={moreBtn}
            type="button"
            className={s.moreBtn}
            aria-label="Mention options"
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
        <Menu open onClose={() => setMenu(null)} anchor={menu} placement="below" title="Mention" width={190}>
          <RowMenu r={r} m={m} close={() => setMenu(null)} sample={sample} />
        </Menu>
      )}
    </ContextMenu>
  );
}

function Body({ model: m, ctx }: PartProps<MentionsModel>) {
  const limit = ctx.size === "L" && !ctx.preview ? MENTION_ROWS.L : MENTION_ROWS.M;
  const shown = m.rows.slice(0, limit);
  const fresh = useFreshIds(shown.map((r) => r.e));
  if (!m.total)
    return (
      <div className={s.empty}>
        <span>No mentions</span>
        <span className={s.emptyHint}>When someone mentions you or replies to you, it shows up here.</span>
      </div>
    );
  const more = m.total - limit;
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {shown.map((r) => (
        <Row key={r.e} r={r} m={m} ctx={ctx} enter={fresh.has(r.e)} />
      ))}
      {more > 0 && <div className={s.moreLine}>+ {more} more</div>}
    </div>
  );
}

function Summary({ model: m }: PartProps<MentionsModel>) {
  return <span className={s.headerText}>{m.summary}</span>;
}

/** M / L header: "2 new". */
function NewCount({ model: m }: PartProps<MentionsModel>) {
  if (m.unseen <= 0) return null;
  return <span className={s.headerText}>{m.unseen} new</span>;
}

// ---- samples (the gallery's preview, the review screenshots, the gates) — the desktop's MentionsWidget.qml sample ------

const SP = (id: string) => `@${id}:${SAMPLE_SERVER}`;
const LOUNGE = `!lounge:${SAMPLE_SERVER}`;
const SQUAD = `!squad:${SAMPLE_SERVER}`;
const RAID = `!raid:${SAMPLE_SERVER}`;
/** Local time `daysAgo` days back at h:m (Pinned's localAt: a capture reads the same all day). */
function localAt(daysAgo: number, h: number, m: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function sampleRows(): MentionRow[] {
  const row = (e: string, who: string, r: string, t: number, seen: boolean, kind: SnippetKind, text: string): MentionRow => ({
    r,
    e,
    s: SP(who),
    t,
    ...(seen ? { seen: true } : {}),
    ready: true,
    kind,
    text,
  });
  return [
    row("$m1", "ana", LOUNGE, localAt(0, 18, 40), false, "text", "are you on tonight? we need a healer"),
    row("$m2", "bo", SQUAD, localAt(0, 12, 5), false, "text", "that clip of yours was insane 😂"),
    row("$m3", "cy", LOUNGE, localAt(1, 21, 30), true, "image", "loadout.png"),
    row("$m4", "dee", RAID, localAt(2, 12, 0), true, "text", "can you bring the fire resist potions?"),
    row("$m5", "eli", SQUAD, localAt(5, 12, 0), true, "encrypted", "Encrypted message"),
    row("$m6", "fay", RAID, localAt(8, 12, 0), true, "text", "you're tank on Thursday"),
    row("$m7", "gus", LOUNGE, localAt(9, 12, 0), true, "voice", "Voice message"),
    row("$m8", "hal", SQUAD, localAt(11, 12, 0), true, "text", "gg, see you next week"),
    row("$m9", "ivy", RAID, localAt(13, 12, 0), true, "file", "raid-roster.pdf"),
    row("$m10", "jo", LOUNGE, localAt(16, 12, 0), true, "text", "who's hosting?"),
    row("$m11", "kit", SQUAD, localAt(20, 12, 0), true, "text", "thanks for carrying lol"),
    row("$m12", "ana", RAID, localAt(25, 12, 0), true, "text", "first raid night is set"),
    row("$m13", "bo", LOUNGE, localAt(30, 12, 0), true, "text", "welcome to the lounge"),
    row("$m14", "cy", SQUAD, localAt(40, 12, 0), true, "text", "hi!"),
  ];
}
function sample(key: "data" | "many" | "allseen" | "empty" | "loading"): MentionsModel {
  const count = key === "many" ? 14 : key === "empty" ? 0 : 5;
  let rows = sampleRows().slice(0, count);
  if (key === "allseen") rows = rows.map((r) => ({ ...r, seen: true }));
  if (key === "loading") rows = rows.map((r) => ({ ...r, ready: false, kind: "text", text: "" }));
  return { rows, total: count, unseen: unseenCount(rows), summary: mentionSummary(rows, roomNameNow), sample: true };
}

export const mentions = defineWidget<MentionsModel>({
  id: "mentions",
  useModel: useMentionsModel,
  live: (m) => m.unseen > 0,
  Summary,
  HeaderExtra: NewCount,
  Body,
  hasData: (m) => m.total > 0,
  samples: {
    preview: () => sample("data"),
    data: () => sample("data"),
    many: () => sample("many"),
    allseen: () => sample("allseen"),
    empty: () => sample("empty"),
    loading: () => sample("loading"),
  },
});

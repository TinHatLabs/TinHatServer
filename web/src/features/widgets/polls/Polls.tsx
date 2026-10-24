// polls/Polls.tsx — the Polls widget (contract WIDGETS.md §17, WIDGETS-UI.md §17; widgets W3, 2026-09-28; the desktop's
// PollsWidget.qml). The open polls of the room on screen (else the last room opened), from its loaded timeline, newest
// first: M 3, L 8, then "+ n more"; each row = the question over the shared rowLine ("3 votes · you voted"); a click jumps
// to the poll in the chat (the pinned widget's jump), where the card votes and ends. "New poll" (the header's button,
// the empty state's link) opens the New poll dialog for that room. S / collapsed: the shared pollsSummary. No timer: it
// redraws on the room's timeline.
import { useMemo, useRef, useState } from "react";
import { jumpToEvent, openRoom } from "@/core/bus";
import { useClient, useMyMembership, usePowerLevels } from "@/core/matrix";
import { usePref } from "@/core/prefs";
import { Icon, cx, useTip } from "@/ui";
import { showsRoom, useRoomTimeline } from "@/features/chat";
import { POLL_CHAT_SAMPLES, POLL_WIDGET_SAMPLES, pollsSummary, readStart, rowLine, sampleEvents, tally, type PollSample } from "@/widgets/polls";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { SAMPLE_SERVER } from "../names";
import { NewPollDialog } from "./NewPoll";
import { canCreateIn, openPolls } from "./store";
import s from "./Polls.module.css";

/** How many rows each size shows before "+ n more". */
export const POLL_ROWS = { M: 3, L: 8 } as const;

export interface PollRow {
  id: string;
  question: string;
  line: string;
}
export interface PollsModel {
  /** the room ("" = none) */
  room: string;
  canNew: boolean;
  /** the open polls, newest first */
  rows: PollRow[];
  sample?: boolean;
}

function usePollsModel(_ctx: WidgetCtx): PollsModel {
  const room = String(usePref("last-room", "")) || "";
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const tl = useRoomTimeline(room || null);
  const pl = usePowerLevels(room || null);
  const membership = useMyMembership(room || null);
  const canNew = useMemo(() => (room ? canCreateIn(room) : false), [room, pl, membership]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const r = room ? (client?.getRoom(room) ?? null) : null;
    const rows = openPolls(r, tl.events, me).map((v) => ({ id: v.id, question: v.poll.question, line: rowLine(v.poll, v.t) }));
    return { room, canNew, rows };
  }, [tl.version, tl.events, room, me, canNew, client]); // eslint-disable-line react-hooks/exhaustive-deps
}

function open(room: string, id: string) {
  if (!room || id.startsWith("~")) return;
  if (showsRoom(room)) jumpToEvent(room, id);
  else openRoom(room, { eventId: id });
}

// ---- parts ------------------------------------------------------------------------------------------------------------

function Row({ r, m, enter, mobile }: { r: PollRow; m: PollsModel; enter: boolean; mobile: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, "Open the poll");
  const go = () => !m.sample && open(m.room, r.id);
  return (
    <div
      ref={ref}
      className={cx(s.row, enter && "tw-enter-up", mobile && s.rowMobile)}
      role="button"
      tabIndex={m.sample ? -1 : 0}
      aria-label={`${r.question} — ${r.line}. Open the poll`}
      onClick={go}
      onKeyDown={(k) => k.target === k.currentTarget && (k.key === "Enter" || k.key === " ") && (k.preventDefault(), go())}
      data-poll-row={r.id}
    >
      <span className={s.icon} aria-hidden="true">
        <Icon name="view-statistics-symbolic" size={mobile ? 16 : 14} color="var(--th-widget-polls-meta-fg)" staticOnly />
      </span>
      <span className={s.lines}>
        <span className={s.q}>{r.question}</span>
        <span className={s.line}>{r.line}</span>
      </span>
    </div>
  );
}

function NewButton({ m, onOpen, label, mobile }: { m: PollsModel; onOpen: () => void; label: boolean; mobile?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, !m.room ? "Open a room to start a poll" : !m.canNew ? "You can't start polls in this room" : "Start a poll in this room");
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.newBtn, label && s.newLabel, mobile && s.newMobile)}
      disabled={!m.room || !m.canNew}
      aria-label="New poll"
      data-no-drag=""
      onClick={(e) => {
        e.stopPropagation();
        if (!m.sample) onOpen();
      }}
    >
      <Icon name="list-add-symbolic" size={12} color="currentColor" staticOnly />
      {label ? "New poll" : "New"}
    </button>
  );
}

function Body({ model: m, ctx }: PartProps<PollsModel>) {
  const [dialog, setDialog] = useState(false);
  const n = ctx.size === "L" && !ctx.preview ? POLL_ROWS.L : POLL_ROWS.M;
  const shown = m.rows.slice(0, n);
  const more = m.rows.length - shown.length;
  const fresh = useFreshIds(shown.map((r) => r.id));
  const mobile = ctx.mobile;
  if (!m.room)
    return (
      <div className={s.body}>
        <div className={s.noroom}>Open a room to see its polls</div>
      </div>
    );
  return (
    <div className={s.body} data-mobile={mobile ? "" : undefined}>
      {shown.length === 0 ? (
        <div className={s.empty}>
          <span>No open polls</span>
          <span className={s.emptyHint}>Ask the room something — everyone votes right in the chat.</span>
          {!ctx.preview && <NewButton m={m} onOpen={() => setDialog(true)} label mobile={mobile} />}
        </div>
      ) : (
        <div className={s.rows}>
          {shown.map((r) => (
            <Row key={r.id} r={r} m={m} enter={fresh.has(r.id)} mobile={mobile} />
          ))}
          {more > 0 && <div className={s.more}>+ {more} more</div>}
        </div>
      )}
      {dialog && <NewPollDialog roomId={m.room} onClose={() => setDialog(false)} mobile={mobile} />}
    </div>
  );
}

/** The header's "New" (M / L). */
function HeaderExtra({ model: m, ctx }: PartProps<PollsModel>) {
  const [dialog, setDialog] = useState(false);
  if (ctx.preview) return null;
  return (
    <>
      <NewButton m={m} onOpen={() => setDialog(true)} label={false} mobile={ctx.mobile} />
      {dialog && <NewPollDialog roomId={m.room} onClose={() => setDialog(false)} mobile={ctx.mobile} />}
    </>
  );
}

function Summary({ model: m }: PartProps<PollsModel>) {
  return <span className={s.summary}>{!m.room ? "No room open" : pollsSummary(m.rows.length, m.rows[0]?.question ?? "")}</span>;
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's PollsWidget.qml builds the same) --

const YOU = `@you:${SAMPLE_SERVER}`;
function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function sampleRows(list: readonly PollSample[]): PollRow[] {
  const out: { ts: number; row: PollRow }[] = [];
  for (const smp of list) {
    const ev = sampleEvents(smp, YOU, dayStart());
    const poll = readStart(ev[0]!.type, ev[0]!.content);
    if (!poll) continue;
    const t = tally(poll, smp.id, ev[0]!.sender, ev, [], YOU);
    if (!t.ended) out.push({ ts: ev[0]!.ts, row: { id: smp.id, question: poll.question, line: rowLine(poll, t) } });
  }
  return out.sort((a, b) => b.ts - a.ts).map((x) => x.row);
}
function sample(kind: "data" | "many" | "empty" | "noroom"): PollsModel {
  const rows = kind === "data" ? sampleRows([...POLL_CHAT_SAMPLES, ...POLL_WIDGET_SAMPLES.slice(0, 2)]) : kind === "many" ? sampleRows([...POLL_CHAT_SAMPLES, ...POLL_WIDGET_SAMPLES]) : [];
  return { room: kind === "noroom" ? "" : `!lounge:${SAMPLE_SERVER}`, canNew: kind !== "noroom", rows, sample: true };
}

export const polls = defineWidget<PollsModel>({
  id: "polls",
  useModel: usePollsModel,
  live: () => false,
  Summary,
  HeaderExtra,
  Body,
  hasData: (m) => m.rows.length > 0,
  samples: {
    preview: () => sample("data"),
    data: () => sample("data"),
    many: () => sample("many"),
    empty: () => sample("empty"),
    noroom: () => sample("noroom"),
  },
});

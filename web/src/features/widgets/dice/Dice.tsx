// dice/Dice.tsx — the Dice widget (contract WIDGETS.md §16, WIDGETS-UI.md §16; widgets W3, 2026-09-28; the desktop's
// DiceWidget.qml). Roll for the open room or just for you: d4…d100 buttons (M / L), an expression field with Enter to roll
// and the Advantage / Disadvantage chips (L), the last roll as a card with the total big (it lands once when it is
// a roll you just made), and the history — the room's rolls from its loaded timeline (the dice messages, decrypted) plus
// your private rolls (this device only, marked Private), newest first: M the last 5, L 15; click one to roll it again.
// S / collapsed: "Ana · 2d6+3 → 9" + a d20 button. The header's Room | Private switch is the widget setting `private`;
// Room is off when no room is open or you may not send messages there (then rolls are private). Rolls go into the room
// as the shared diceContent (store.ts). No timer: it redraws on the room's timeline, the private list and the setting.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EventStatus, type MatrixEvent } from "matrix-js-sdk";
import { usePowerLevels, useMyMembership, useClient } from "@/core/matrix";
import { usePref } from "@/core/prefs";
import { Icon, TextField, cx, useTip } from "@/ui";
import { useRoomTimeline } from "@/features/chat";
import { fmtClock, useClockMode, type ClockMode } from "@/features/settings";
import { diceHistory, diceSummary, evaluateDice, parseDice, withAdvantage, type DiceEntry } from "@/widgets/dice";
import { whenLabel, whenOf } from "@/widgets/recent";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { SAMPLE_SERVER, usePerson } from "../names";
import { setSetting } from "../store";
import { DiceCard, diceLabel } from "./DiceCard";
import { canRollIn, clearPrivateRolls, rollTo, useJustRolled, usePrivateRolls, type JustRolled } from "./store";
import s from "./Dice.module.css";

/** How many rolls each size shows in all (the card + the rows under it). */
export const DICE_ROLLS = { S: 1, M: 5, L: 15 } as const;
/** The quick dice. */
export const QUICK_DICE = [4, 6, 8, 10, 12, 20, 100] as const;

export interface DiceView extends DiceEntry {
  /** a room roll of mine still being sent / refused by the server */
  pending?: boolean;
  failed?: boolean;
}

export interface DiceModel {
  /** the open room ("" = none) */
  room: string;
  me: string;
  /** may roll into the room (open, joined, allowed to send messages) */
  canRoom: boolean;
  /** the widget setting `private` */
  wantPrivate: boolean;
  /** newest first, at most 15 */
  entries: DiceView[];
  /** private rolls exist (the "Clear private rolls" link) */
  hasPrivate: boolean;
  /** a sample (the gallery, the gates): nothing is rolled or sent */
  sample?: boolean;
}

const isEdit = (ev: MatrixEvent) => (ev.getOriginalContent() as { "m.relates_to"?: { rel_type?: unknown } })["m.relates_to"]?.rel_type === "m.replace";

function useDiceModel(ctx: WidgetCtx): DiceModel {
  const room = String(usePref("last-room", "")) || "";
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const tl = useRoomTimeline(room || null);
  const priv = usePrivateRolls();
  const pl = usePowerLevels(room || null);
  const membership = useMyMembership(room || null);
  const canRoom = useMemo(() => (room ? canRollIn(room) : false), [room, pl, membership]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const events: { id: string; sender: string; ts: number; content: unknown }[] = [];
    const state = new Map<string, "pending" | "failed">();
    for (const ev of tl.events) {
      if (ev.getType() !== "m.room.message" || ev.isRedacted() || isEdit(ev) || ev.status === EventStatus.CANCELLED) continue;
      const id = ev.getId() ?? ev.getTxnId() ?? "";
      if (!id) continue;
      events.push({ id, sender: ev.getSender() ?? "", ts: ev.getTs(), content: ev.getOriginalContent() });
      if (ev.status === EventStatus.NOT_SENT) state.set(id, "failed");
      else if (ev.status != null) state.set(id, "pending");
    }
    const entries: DiceView[] = diceHistory(events, priv, DICE_ROLLS.L).map((e) => {
      const st = state.get(e.id);
      return st ? { ...e, pending: st === "pending", failed: st === "failed" } : e;
    });
    return { room, me, canRoom, wantPrivate: ctx.settings.private === true, entries, hasPrivate: priv.length > 0 };
  }, [tl.version, tl.events, priv, room, me, canRoom, ctx.settings.private]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Where a roll goes now: the room when one is open, allowed and not switched to Private. */
function roomTarget(m: DiceModel): boolean {
  return !m.wantPrivate && m.canRoom && !!m.room;
}

function roll(m: DiceModel, expr: string): string {
  if (m.sample) return "";
  return rollTo(expr, roomTarget(m) ? { room: m.room } : { private: true });
}

function whenText(ts: number, mode: ClockMode): string {
  const now = Date.now();
  return whenLabel(whenOf(ts, now, -new Date(now).getTimezoneOffset()), fmtClock(ts, mode));
}

/** "Private" (a private roll), "You" (mine in the room), else the roller's name. */
function Who({ e, m }: { e: DiceView; m: DiceModel }) {
  const p = usePerson(e.private || e.sender === m.me ? "" : e.sender, m.room);
  if (e.private)
    return (
      <span className={s.whoPrivate}>
        <Icon name="lock-symbolic" size={12} color="var(--th-widget-muted-fg)" staticOnly />
        Private
      </span>
    );
  return <>{e.sender === m.me ? "You" : p.name}</>;
}

function When({ e }: { e: DiceView }) {
  const mode = useClockMode();
  if (e.failed) return <span className={s.failed}>Not sent</span>;
  if (e.pending) return <>Sending…</>;
  return <>{whenText(e.ts, mode)}</>;
}

/** The card lands when its roll is the one I just made here (same expression + dice, within a minute). */
function playKeyOf(e: DiceView | undefined, just: JustRolled | null, m: DiceModel): number | null {
  if (!e || !just || m.sample) return null;
  const mine = e.private || e.sender === m.me;
  const same = e.result.expr === just.expr && e.result.rolls.length === just.rolls.length && e.result.rolls.every((v, i) => v === just.rolls[i]);
  return mine && same && Date.now() - just.at < 60_000 ? just.key : null;
}

// ---- parts ------------------------------------------------------------------------------------------------------------

function DieButton({ sides, m, mobile }: { sides: number; m: DiceModel; mobile: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, `Roll 1d${sides}${roomTarget(m) ? "" : " privately"}`);
  return (
    <button ref={ref} type="button" className={cx(s.die, mobile && s.dieMobile)} aria-label={`Roll a d${sides}`} onClick={() => roll(m, `1d${sides}`)} data-die={sides}>
      d{sides}
    </button>
  );
}

function Chip({ kind, field, m, onRolled }: { kind: "adv" | "dis"; field: string; m: DiceModel; onRolled: (expr: string) => void }) {
  const expr = withAdvantage(field, kind);
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, `Roll ${expr}`);
  return (
    <button
      ref={ref}
      type="button"
      className={s.chip}
      onClick={() => {
        onRolled(expr);
        roll(m, expr);
      }}
    >
      {kind === "adv" ? "Advantage" : "Disadvantage"}
    </button>
  );
}

function ExprRow({ m, mobile }: { m: DiceModel; mobile: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  useTip(btn, roomTarget(m) ? "Roll to the room" : "Roll privately");
  const go = () => {
    const err = roll(m, text);
    setError(err);
    if (!err && !m.sample) {
      const p = parseDice(text);
      if (p.ok) setText(p.expr);
    }
  };
  return (
    <div className={s.exprBlock}>
      <div className={s.exprRow}>
        <TextField
          className={cx(s.field, mobile && s.fieldMobile)}
          value={text}
          placeholder="2d6+3 · 4d6kh3 · 2d20kh1"
          aria-label="Dice to roll"
          aria-invalid={error ? true : undefined}
          maxLength={100}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
          onAccepted={go}
          onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
          data-dice-field=""
        />
        <button ref={btn} type="button" className={s.rollBtn} onClick={go}>
          Roll
        </button>
      </div>
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
      <div className={s.chips}>
        <Chip kind="adv" field={text} m={m} onRolled={setText} />
        <Chip kind="dis" field={text} m={m} onRolled={setText} />
      </div>
    </div>
  );
}

function HistoryRow({ e, m, enter, mobile }: { e: DiceView; m: DiceModel; enter: boolean; mobile: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, `Roll ${e.result.expr} again`);
  const again = () => roll(m, e.result.expr);
  return (
    <div
      ref={ref}
      className={cx(s.row, enter && "tw-enter-up", mobile && s.rowMobile)}
      role="button"
      tabIndex={m.sample ? -1 : 0}
      aria-label={`${e.private ? "Private" : ""} roll ${diceLabel(e.result)}. Roll it again`}
      onClick={again}
      onKeyDown={(k) => k.target === k.currentTarget && (k.key === "Enter" || k.key === " ") && (k.preventDefault(), again())}
      data-dice-row={e.id}
    >
      <span className={s.rowWho}>
        <Who e={e} m={m} />
      </span>
      <span className={s.rowExpr}>{e.result.expr}</span>
      <span className={cx(s.rowTotal, e.result.natural === "nat20" && s.nat20, e.result.natural === "nat1" && s.nat1)}>{e.result.total}</span>
      <span className={s.rowWhen}>
        <When e={e} />
      </span>
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<DiceModel>) {
  const just = useJustRolled();
  const n = ctx.size === "L" && !ctx.preview ? DICE_ROLLS.L : DICE_ROLLS.M;
  const shown = m.entries.slice(0, n);
  const rest = shown.slice(1);
  const fresh = useFreshIds(rest.map((e) => e.id));
  const first = shown[0];
  const mobile = ctx.mobile;
  return (
    <div className={s.body} data-mobile={mobile ? "" : undefined} data-size={ctx.size}>
      <div className={s.dice} role="group" aria-label="Quick dice">
        {QUICK_DICE.map((d) => (
          <DieButton key={d} sides={d} m={m} mobile={mobile} />
        ))}
      </div>
      {ctx.size === "L" && !ctx.preview && <ExprRow m={m} mobile={mobile} />}
      {first ? (
        <DiceCard
          r={first.result}
          variant="widget"
          mobile={mobile}
          playKey={playKeyOf(first, just, m)}
          head={
            <div className={s.cardHead}>
              <span className={s.cardWho}>
                <Who e={first} m={m} />
              </span>
              <span className={s.cardWhen}>
                · <When e={first} />
              </span>
            </div>
          }
        />
      ) : (
        <div className={s.empty}>
          <span>No rolls yet</span>
          <span className={s.emptyHint}>{m.room && m.canRoom && !m.wantPrivate ? "Pick a die — everyone here sees the roll." : "Pick a die — only you see the roll."}</span>
        </div>
      )}
      {rest.length > 0 && (
        <div className={s.rows}>
          {rest.map((e) => (
            <HistoryRow key={e.id} e={e} m={m} enter={fresh.has(e.id)} mobile={mobile} />
          ))}
        </div>
      )}
      {m.hasPrivate && !ctx.preview && (
        <div className={s.footer}>
          <button type="button" className={s.clear} onClick={() => !m.sample && clearPrivateRolls()}>
            Clear private rolls
          </button>
        </div>
      )}
    </div>
  );
}

/** The header's Room | Private switch (the widget setting `private`). */
function TargetSwitch({ model: m, ctx }: PartProps<DiceModel>) {
  const roomBtn = useRef<HTMLButtonElement>(null);
  const privBtn = useRef<HTMLButtonElement>(null);
  const noRoom = !m.room || !m.canRoom;
  useTip(roomBtn, !m.room ? "Open a room to roll there" : !m.canRoom ? "You can't send messages in this room" : "Everyone in the room sees your rolls");
  useTip(privBtn, "Only you see your rolls (kept on this device)");
  const isPrivate = m.wantPrivate || noRoom;
  const set = (v: boolean) => !m.sample && !ctx.preview && setSetting("dice", "private", v);
  return (
    <span className={s.switch} role="group" aria-label="Where your rolls go" data-no-drag="">
      <button ref={roomBtn} type="button" className={cx(s.seg, !isPrivate && s.segOn)} aria-pressed={!isPrivate} disabled={noRoom} onClick={(e) => (e.stopPropagation(), set(false))}>
        Room
      </button>
      <button ref={privBtn} type="button" className={cx(s.seg, isPrivate && s.segOn)} aria-pressed={isPrivate} onClick={(e) => (e.stopPropagation(), set(true))}>
        Private
      </button>
    </span>
  );
}

function SummaryWho({ e, m }: { e: DiceView; m: DiceModel }) {
  const p = usePerson(e.private || e.sender === m.me ? "" : e.sender, m.room);
  return <>{diceSummary(e, e.sender === m.me ? "You" : p.name)}</>;
}

function Summary({ model: m, ctx }: PartProps<DiceModel>) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, `Roll a d20${roomTarget(m) ? "" : " privately"}`);
  const e = m.entries[0];
  return (
    <span className={s.summary}>
      <span className={s.summaryText}>{e ? <SummaryWho e={e} m={m} /> : diceSummary(null, "")}</span>
      {!ctx.preview && (
        <button
          ref={ref}
          type="button"
          className={s.d20}
          aria-label="Roll a d20"
          onClick={(ev) => {
            ev.stopPropagation();
            roll(m, "1d20");
          }}
        >
          d20
        </button>
      )}
    </span>
  );
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's DiceWidget.qml holds the same) ----

const SP = (id: string) => `@${id}:${SAMPLE_SERVER}`;
const LOUNGE = `!lounge:${SAMPLE_SERVER}`;
const YOU = SP("you");
function localAt(daysAgo: number, h: number, mi: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, mi, 0, 0);
  return d.getTime();
}
function entry(id: string, sender: string, ts: number, expr: string, rolls: number[], priv = false): DiceView {
  const p = parseDice(expr);
  if (!p.ok) throw new Error(`sample ${expr}`);
  return { id, ts, sender: priv ? "" : sender, private: priv, result: evaluateDice(p, rolls)! };
}
function sampleEntries(): DiceView[] {
  return [
    entry("$d1", SP("ana"), localAt(0, 20, 42), "2d20kh1+5", [7, 20]),
    entry("$d2", YOU, localAt(0, 20, 40), "4d6kh3", [3, 6, 3, 2]),
    entry("p1", "", localAt(0, 20, 38), "1d100", [42], true),
    entry("$d3", SP("bo"), localAt(0, 20, 35), "2d6+3", [4, 2]),
    entry("$d4", SP("cy"), localAt(0, 20, 31), "1d20-1", [1]),
    entry("$d5", SP("ana"), localAt(0, 20, 30), "1d8+1d4+2", [6, 3]),
    entry("$d6", SP("dee"), localAt(0, 20, 12), "3d6", [5, 5, 1]),
    entry("$d7", YOU, localAt(0, 19, 58), "1d12", [9]),
    entry("$d8", SP("bo"), localAt(1, 21, 15), "2d20kl1+2", [14, 3]),
    entry("$d9", SP("eli"), localAt(1, 21, 5), "1d20+7", [13]),
    entry("p2", "", localAt(1, 20, 50), "1d4", [3], true),
    entry("$d10", SP("fay"), localAt(1, 20, 44), "8d6", [1, 2, 3, 4, 5, 6, 6, 6]),
    entry("$d11", SP("gus"), localAt(2, 19, 30), "1d10", [10]),
    entry("$d12", SP("hal"), localAt(3, 22, 0), "1d6", [4]),
    entry("$d13", SP("ana"), localAt(4, 18, 0), "2d10+4", [7, 7]),
    entry("$d14", SP("bo"), localAt(5, 18, 0), "1d20", [11]),
  ];
}
function sample(opts: { count?: number; room?: boolean; priv?: boolean; nat1?: boolean } = {}): DiceModel {
  let all = sampleEntries();
  if (opts.nat1) all = [entry("$n1", SP("cy"), localAt(0, 20, 45), "2d20kl1+4", [1, 12]), ...all];
  const count = opts.count ?? 6;
  const entries = all.slice(0, count);
  return {
    room: opts.room === false ? "" : LOUNGE,
    me: YOU,
    canRoom: opts.room !== false,
    wantPrivate: !!opts.priv,
    entries,
    hasPrivate: entries.some((e) => e.private),
    sample: true,
  };
}

export const dice = defineWidget<DiceModel>({
  id: "dice",
  useModel: useDiceModel,
  live: () => false,
  Summary,
  HeaderExtra: TargetSwitch,
  Body,
  hasData: (m) => m.entries.length > 0,
  samples: {
    preview: () => sample(),
    data: () => sample(),
    many: () => sample({ count: 16 }),
    nat1: () => sample({ nat1: true }),
    private: () => sample({ priv: true }),
    empty: () => sample({ count: 0 }),
    noroom: () => sample({ room: false, count: 0 }),
  },
});

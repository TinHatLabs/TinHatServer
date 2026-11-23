// Stage.tsx — B4 + B10 on the web (GAMES-V1.1-ADDENDUM §1.1, §8.3, §8.4):
//   StagePill      the two-segment "Table | Call" switch (the panel's head on Table, the compact table on Call; `G`)
//   CompactHost    the compact table (280 × 64; phones full width × 56) docked bottom-right of the call stage while the
//                  stage is on Call: game glyph, my two cards (by cardsFace), the board, the pot, whose turn + the
//                  countdown ring, and on my turn Check / Call N / Fold (raising opens the table)
//   TurnWatch      while I sit at a Hold'em table of my call's room: keeps that table's view live and posts the opt-in
//                  "your turn" notice (turnNotice.ts) + the tab title, never cards, odds or amounts
// Desktop twin: the call island's StagePill / CompactTable.qml (games-desktop2).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCallStore } from "@/features/calls";
import { closeNotes } from "@/core/notes";
import { usePref } from "@/core/prefs";
import { peekClient } from "@/core/matrix";
import { notifyDesktop } from "@/features/settings/notify";
import { OverlayPortal, cx, useIsMobile } from "@/ui";
import { artVars } from "./art";
import { Chips, TurnRing, myId, useNow } from "./bits";
import { cardsFace } from "./cardsFace";
import { GAME_WORDS, R2_WORDS, cardFace, secondsLeft, w } from "./rules";
import { actOn, flipStage, toCallStage, toTableStage, usePlay, useRoomTables, useTableView, validFor, type OpenView } from "./store";
import { useRoomGame } from "./space";
import { TURN_NOTIFY_PREF, turnNotice } from "./turnNotice";
import type { HoldemView } from "./wire";
import s from "./Stage.module.css";

// ---- the switch -----------------------------------------------------------------------------------------------------
export function StagePill({ on, className }: { on: "table" | "call"; className?: string }) {
  return (
    <span className={cx(s.pill, className)} role="radiogroup" aria-label="Stage" data-testid="stage-pill">
      <button type="button" role="radio" aria-checked={on === "table"} className={cx(s.seg, on === "table" && s.segOn)} onClick={() => on !== "table" && toTableStage()} data-testid="stage-table" title="Table (G)">
        {R2_WORDS.stage_table}
      </button>
      <button type="button" role="radio" aria-checked={on === "call"} className={cx(s.seg, on === "call" && s.segOn)} onClick={() => on !== "call" && toCallStage()} data-testid="stage-call" title="Call (G)">
        {R2_WORDS.stage_call}
      </button>
    </span>
  );
}

/** `G` flips the stage while the focus is in the call island, the game panel or the compact table (never while typing). */
const STAGE_AREA = '[data-island^="call"], [data-testid="game-panel"], [data-testid="compact-table"]';
export function useStageKey(): void {
  useEffect(() => {
    // a click on the felt (nothing focusable) leaves the focus on the page: then the last press says where I am
    let lastPress: Element | null = null;
    const onDown = (e: PointerEvent) => {
      lastPress = e.target instanceof Element ? e.target : null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "g" && e.key !== "G") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const at = t && t !== document.body && t !== document.documentElement ? t : lastPress;
      if (!at?.isConnected || !at.closest?.(STAGE_AREA)) return;
      e.preventDefault();
      flipStage();
    };
    window.addEventListener("pointerdown", onDown, true);
    // capture: the overlay portals (the panel, the compact table) stop key events from bubbling
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
}

// ---- the compact table ----------------------------------------------------------------------------------------------
interface Box {
  right: number;
  bottom: number;
}
/** bottom-right of the call island's stage (desktop); null = no call island on screen (then the window's corner) */
function callCorner(): Box | null {
  const el = [...document.querySelectorAll<HTMLElement>('[data-island^="call"]')].find((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // above the call's control row when it is inside the island
  const bar = el.querySelector<HTMLElement>('[data-testid="call-bar"]')?.getBoundingClientRect();
  const floor = bar && bar.height > 0 && bar.top > r.top ? bar.top : r.bottom;
  return { right: Math.max(8, window.innerWidth - r.right + 12), bottom: Math.max(8, window.innerHeight - floor + 12) };
}

export function CompactHost() {
  useStageKey();
  const k = usePlay((x) => x.compact);
  const panel = usePlay((x) => x.panel);
  if (!k || panel) return null;
  return <CompactTable roomId={k.roomId} table={k.table} />;
}

function CompactTable({ roomId, table }: { roomId: string; table: string }) {
  const mobile = useIsMobile();
  const g = useRoomGame(roomId);
  const ov = validFor(useTableView(g.owner, table), roomId, g);
  const [box, setBox] = useState<Box | null>(() => (mobile ? null : callCorner()));
  useLayoutEffect(() => {
    if (mobile) return;
    const measure = () => setBox((cur) => {
      const b = callCorner();
      return cur && b && cur.right === b.right && cur.bottom === b.bottom ? cur : b;
    });
    measure();
    const t = window.setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", measure);
    };
  }, [mobile]);
  const style: CSSProperties = { ...artVars(), ...(mobile ? {} : box ? { right: box.right, bottom: box.bottom } : { right: 16, bottom: 16 }) };
  return (
    <OverlayPortal>
      <div className={cx(s.compact, mobile && s.compactPhone)} style={style} data-testid="compact-table" tabIndex={-1}>
        {ov && ov.view.game === "holdem" ? (
          <CompactHoldem ov={ov as OpenView & { view: HoldemView }} />
        ) : (
          <div className={s.foot}>
            <CompactOther game={ov?.view.game ?? null} />
            <StagePill on="call" className={s.compactPill} />
          </div>
        )}
      </div>
    </OverlayPortal>
  );
}

function CompactOther({ game }: { game: "holdem" | "rig" | null }) {
  return (
    <button type="button" className={s.open} onClick={toTableStage}>
      <span className={s.glyph} aria-hidden>
        {game === "rig" ? "★" : "♠"}
      </span>
      {game ? GAME_WORDS[game] : w("lobby.opening")}
    </button>
  );
}

/** a 16 × 22 card: rank + suit only (the compact table's size; a face-down back when `card` is null) */
function Mini({ card, ghost }: { card: string | null; ghost?: boolean }) {
  if (ghost) return <span className={cx(s.mini, s.miniGhost)} aria-hidden />;
  const f = card ? cardFace(card) : null;
  if (!f) return <span className={cx(s.mini, s.miniBack)} role="img" aria-label="A face-down card" />;
  return (
    <span className={cx(s.mini, f.red ? s.miniRed : s.miniBlack)} role="img" aria-label={f.label} data-card={card}>
      {f.rank}
      <span className={s.miniSuit}>{f.glyph}</span>
    </span>
  );
}

function CompactHoldem({ ov }: { ov: OpenView & { view: HoldemView } }) {
  const v = ov.view;
  const me = myId();
  const now = useNow(1000);
  const sharing = useCallStore((x) => x.sharing);
  const y = v.you;
  const h = v.hand;
  const toAct = h?.to_act ?? null;
  const left = toAct ? secondsLeft(toAct.deadline, v.now, ov.seenAt, now) : 0;
  const face = cardsFace({ hasCards: (y?.cards ?? []).length > 0, sharing, onPad: false, here: false, screens: y?.screens ?? [] });
  const legal = y?.legal ?? null;
  const myTurn = !!legal && !!y && toAct?.seat === y.seat;
  const who = toAct ? (v.seats.find((x) => x.seat === toAct.seat)?.u ?? "") : "";
  const whoName = who === me ? R2_WORDS.turn_title : peekClient()?.getRoom(v.room)?.getMember(who)?.name || who.replace(/^@([^:]+):.*$/, "$1");
  const pot = h ? h.total : 0;
  return (
    <>
      <div className={s.row} data-my-turn={myTurn ? "1" : undefined}>
        <button type="button" className={s.glyphBtn} onClick={toTableStage} aria-label="Open the table" title={GAME_WORDS.holdem}>
          ♠
        </button>
        {(y?.cards ?? []).length > 0 && (
          <span className={s.cards} data-testid="compact-mycards" data-face={face}>
            {y!.cards.map((c, i) => (
              <Mini key={i} card={face === "up" ? c : null} />
            ))}
          </span>
        )}
        {myTurn && legal ? (
          <span className={s.quick} data-testid="compact-actions">
            {legal.check && (
              <button type="button" className={s.q} onClick={() => void actOn(v, { do: "check" })} data-testid="compact-check">
                {w("table.check")}
              </button>
            )}
            {!!legal.call && legal.call > 0 && (
              <button type="button" className={cx(s.q, s.qHi)} onClick={() => void actOn(v, { do: "call" })} data-testid="compact-call">{`Call ${legal.call}`}</button>
            )}
            {legal.fold && (
              <button type="button" className={s.q} onClick={() => void actOn(v, { do: "fold" })} data-testid="compact-fold">
                {w("table.fold")}
              </button>
            )}
          </span>
        ) : (
          <span className={s.cards} aria-label="Board">
            {[0, 1, 2, 3, 4].map((i) => (h?.board[i] ? <Mini key={i} card={h.board[i]!} /> : <Mini key={i} card={null} ghost />))}
          </span>
        )}
        <span className={s.grow} />
        {toAct && (
          <span className={s.ringBox} aria-hidden>
            <TurnRing left={left} total={v.opts.turn_s} size={22} />
          </span>
        )}
      </div>
      <div className={s.foot}>
        <span className={s.footText} data-testid="compact-turn">
          {toAct ? `${whoName} · ${left}s` : v.status === "pause" ? w("table.next_hand") : w("table.wait_turn")}
          {pot > 0 && <Chips n={pot} className={s.pot} />}
        </span>
        <StagePill on="call" className={s.compactPill} />
      </div>
    </>
  );
}

// ---- the "your turn" notice -------------------------------------------------------------------------------------------
/** Mounted once: for my call's room, every Hold'em table where I sit. */
export function TurnWatch() {
  const room = useCallStore((x) => (x.inCall ? x.callRoomId : "")) ?? "";
  const pref = usePref(TURN_NOTIFY_PREF, "");
  if (!room || pref !== "1") return null;
  return <TurnWatchRoom roomId={room} />;
}
function TurnWatchRoom({ roomId }: { roomId: string }) {
  const { tables } = useRoomTables(roomId);
  const me = myId();
  const mine = tables.filter((t) => t.game === "holdem" && t.status !== "closed" && t.players.includes(me));
  return (
    <>
      {mine.map((t) => (
        <TurnWatchTable key={t.table} roomId={roomId} table={t.table} />
      ))}
    </>
  );
}
/** ONE owner of the tab title (astra): "(Your turn) " while any watched table has my turn unseen. */
const unseenTurns = new Set<string>();
function turnTitle(table: string, on: boolean): void {
  if (on) unseenTurns.add(table);
  else unseenTurns.delete(table);
  const p = R2_WORDS.turn_title_prefix;
  const has = document.title.startsWith(p);
  if (unseenTurns.size && !has) document.title = `${p}${document.title}`;
  else if (!unseenTurns.size && has) document.title = document.title.slice(p.length);
}
function TurnWatchTable({ roomId, table }: { roomId: string; table: string }) {
  const g = useRoomGame(roomId);
  const ov = validFor(useTableView(g.owner, table), roomId, g);
  const panelOn = usePlay((x) => x.panel?.table === table);
  const now = useNow(1000);
  const sent = useRef<{ key: string; what: "" | "first" | "last" }>({ key: "", what: "" });
  const v = ov?.view.game === "holdem" ? (ov.view as HoldemView) : null;
  const toAct = v?.hand?.to_act ?? null;
  const mySeat = v?.you?.seat ?? null;
  const left = v && toAct ? secondsLeft(toAct.deadline, v.now, ov!.seenAt, now) : 0;
  const turnKey = v && toAct ? `${v.hand!.n}:${toAct.turn}` : "";
  const watching = panelOn && document.visibilityState === "visible" && document.hasFocus();
  const tag = `tinhat-turn-${table}`;
  useEffect(() => {
    const out = turnNotice({ toAct: toAct?.seat ?? null, mine: mySeat, turnKey, left, watching, sent: sent.current });
    const myTurn = mySeat !== null && toAct?.seat === mySeat;
    if (out.withdraw) void closeNotes(tag);
    // the per-turn history is kept across a look at the table (astra: focus/blur must not re-arm the first notice);
    // it starts again only when the turn passes
    if (!myTurn) sent.current = { key: "", what: "" };
    // the tab title (no permission needed) while it's my turn and I'm not looking
    turnTitle(table, myTurn && !watching);
    if (out.post && v) {
      const roomName = peekClient()?.getRoom(roomId)?.name ?? "";
      notifyDesktop({
        title: R2_WORDS.turn_title,
        body: out.post === "last" ? R2_WORDS.turn_last.replace("{s}", String(left)) : R2_WORDS.turn_body.replace("{game}", GAME_WORDS.holdem).replace("{room}", roomName),
        tag,
        room: roomId,
        onClick: () => {
          window.focus();
          usePlay.setState({ panel: { roomId, table }, compact: null });
        },
      });
      sent.current = { key: turnKey, what: out.post };
    }
  }, [toAct?.seat, mySeat, turnKey, left, watching, tag, v, roomId, table]);
  useEffect(
    () => () => {
      void closeNotes(tag);
      turnTitle(table, false);
    },
    [tag, table],
  );
  return null;
}

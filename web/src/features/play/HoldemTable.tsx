// HoldemTable.tsx — Texas Hold'em at one table (GAMES-V1-SPEC.md §4): the felt with up to 8 seats (mine at the bottom
// centre), the board and pots, every seat's stack / bet / state / turn ring, the dealer button, shown cards at the
// showdown, my two cards (face down with hold-to-peek while my Pad has the table, and always while I share my screen),
// the action bar (Fold · Check / Call N · Raise to N with ½ pot / pot / all-in · All-in) and the host's Deal / Close.
// The server's `legal` is the only word on what I may do. Phones: the same pieces stacked (seats strip, felt, my
// cards, a big action bar).
import { useEffect, useMemo, useState } from "react";
import { useCallStore } from "@/features/calls";
import { Button, ConfirmDialog, Icon, Slider, cx, useIsMobile } from "@/ui";
import { Chips, PlayerAvatar, PlayerName, PlayingCard, TableNote, TurnRing, myId, useNow } from "./bits";
import { actionWords, canDeal, CLOSED_WORDS, HAND_WORDS, winLine, potTotal, raisePresets, SEAT_STATE_WORDS, seatLayout, secondsLeft, w } from "./rules";
import { actOn, type OpenView } from "./store";
import type { HoldemSeat, HoldemView } from "./wire";
import s from "./Holdem.module.css";

/** `titled` = false when the game panel's header already names the game. */
export function HoldemTable({ ov, roomId, titled = true }: { ov: OpenView & { view: HoldemView }; roomId: string; titled?: boolean }) {
  const v = ov.view;
  const me = myId();
  const mobile = useIsMobile();
  const now = useNow(1000);
  const sharing = useCallStore((x) => x.sharing);
  const mine = v.seats.find((x) => x.u === me) ?? null;
  const h = v.hand;
  const toAct = h?.to_act ?? null;
  const left = toAct ? secondsLeft(toAct.deadline, v.now, ov.seenAt, now) : 0;
  const layout = useMemo(() => seatLayout(v.opts.seats, mine?.seat ?? null), [v.opts.seats, mine?.seat]);
  const bySeat = new Map(v.seats.map((x) => [x.seat, x]));
  const isHost = v.host === me;
  const pot = potTotal(v);
  // at the pause: who won what (result.pots[].paid by seat), with their made hand (result.best)
  const won = new Map<number, number>();
  for (const p of v.result?.pots ?? []) for (const [k, n] of Object.entries(p.paid)) won.set(Number(k), (won.get(Number(k)) ?? 0) + n);
  const winners = v.status === "pause" && v.result && !v.result.voided ? [...won.entries()].map(([seat, n]) => ({ seat, n, u: bySeatU(v, seat), made: v.result!.best[String(seat)]?.category })) : [];
  const [closeAsk, setCloseAsk] = useState(false);
  const sit = (seat?: number) => void actOn(v, seat ? { do: "sit", seat } : { do: "sit" });

  const header = (
    <div className={s.bar}>
      <div className={s.title}>
        {titled && <span className={s.game}>{w("games.holdem")}</span>}
        <span className={s.meta}>
          {h ? `Hand ${h.n} · ` : ""}blinds {v.opts.sb}/{v.opts.bb}
        </span>
      </div>
      <div className={s.barActions}>
        {isHost && v.status === "lobby" && canDeal(v) && (
          <Button highlighted text={w("table.deal")} onClick={() => void actOn(v, { do: "deal" })} data-testid="holdem-deal" />
        )}
        {mine && (mine.state === "away" ? <Button text={w("table.back")} onClick={() => void actOn(v, { do: "away", on: false })} /> : <Button flat text={w("table.sit_out")} onClick={() => void actOn(v, { do: "away", on: true })} />)}
        {mine ? (
          <Button flat text={mine.state === "leaving" ? w("table.leaving") : w("table.leave_table")} disabled={mine.state === "leaving"} onClick={() => void actOn(v, { do: "leave" })} data-testid="holdem-leave" />
        ) : (
          v.seats.length < v.opts.seats && <Button highlighted text={w("table.sit")} onClick={() => sit()} data-testid="holdem-sit" />
        )}
        {isHost && <Button flat text={w("table.close")} onClick={() => setCloseAsk(true)} data-testid="holdem-close" />}
      </div>
      <ConfirmDialog
        open={closeAsk}
        onClose={() => setCloseAsk(false)}
        dialogTitle={w("table.close_title")}
        message={h && v.status === "hand" ? w("table.close_body_hand") : w("table.close_body")}
        confirmText={w("table.close")}
        destructive
        onConfirmed={() => void actOn(v, { do: "close" })}
      />
    </div>
  );

  const board = (
    <div className={s.middle}>
      <div className={s.board} data-testid="holdem-board">
        {[0, 1, 2, 3, 4].map((i) => (h?.board[i] ? <PlayingCard key={i} card={h.board[i]!} size={mobile ? "md" : "lg"} className={s.boardCard} /> : <PlayingCard key={i} card={null} ghost size={mobile ? "md" : "lg"} />))}
      </div>
      <div className={s.pot} data-testid="holdem-pot">
        {pot > 0 ? (
          <>
            <span className={s.potWord}>{w("table.pot")}</span>
            <Chips n={pot} big />
            {h && h.pots.length > 1 && <span className={s.side}>{h.pots.map((p, i) => `${i ? w("table.side") : w("table.main")} ${p.amount}`).join(" · ")}</span>}
          </>
        ) : v.status === "pause" && v.result?.voided ? (
          <span className={s.result}>{CLOSED_WORDS.restart}</span>
        ) : winners.length ? (
          <span className={s.result} data-testid="holdem-result">
            {winners.map((w, i) => (
              <span key={w.seat}>
                {i > 0 && " · "}
                {w.u === me ? (
                  winLine(true, w.n, w.made)[1]
                ) : (
                  <>
                    {winLine(false, w.n, w.made)[0]}
                    <PlayerName mxid={w.u} roomId={roomId} />
                    {winLine(false, w.n, w.made)[1]}
                  </>
                )}
              </span>
            ))}
          </span>
        ) : (
          v.status === "lobby" && <span className={s.wait}>{isHost ? w("table.deal_hint") : w("table.wait_host")}</span>
        )}
      </div>
    </div>
  );

  return (
    <div className={cx(s.root, mobile && s.mobile)} data-testid="holdem-table" data-status={v.status} data-table={v.table} data-step-hand={v.hand?.street ?? ""}>
      {header}
      <div className={s.stage}>
        <TableNote table={v.table} />
        {mobile ? (
          <>
            <div className={s.strip}>
              {v.seats
                .filter((x) => x.u !== me)
                .map((x) => (
                  <Seat key={x.seat} seat={x} v={v} roomId={roomId} left={toAct?.seat === x.seat ? left : 0} compact />
                ))}
              {!v.seats.some((x) => x.u !== me) && <span className={s.wait}>{w("table.no_one_else")}</span>}
            </div>
            <div className={s.feltPhone}>{board}</div>
          </>
        ) : (
          <div className={s.feltWrap}>
            <div className={s.felt}>
              <div className={s.feltLine} />
              {board}
            </div>
            {layout.map((p) =>
              bySeat.get(p.seat)?.bet ? (
                <span key={`b${p.seat}`} className={s.bet} style={{ left: `${p.x + (50 - p.x) * 0.42}%`, top: `${p.y + (50 - p.y) * 0.5}%` }} data-testid={`holdem-bet-${p.seat}`}>
                  <Chips n={bySeat.get(p.seat)!.bet} />
                </span>
              ) : null,
            )}
            {layout.map((p) => {
              const st = bySeat.get(p.seat);
              return (
                <div key={p.seat} className={s.seatPos} style={{ left: `${p.x}%`, top: `${p.y}%` }} data-seat={p.seat}>
                  {st ? (
                    <Seat seat={st} v={v} roomId={roomId} left={toAct?.seat === st.seat ? left : 0} self={st.u === me} side={p.x < 22 ? "l" : p.x > 78 ? "r" : undefined} />
                  ) : !mine && v.seats.length < v.opts.seats ? (
                    <button type="button" className={s.empty} onClick={() => sit(p.seat)} data-testid={`holdem-sit-${p.seat}`}>
                      {w("table.sit_here")}
                    </button>
                  ) : (
                    <span className={s.emptyQuiet} aria-hidden title="Empty seat" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {mine ? <MyArea v={v} mine={mine} roomId={roomId} left={toAct?.seat === mine.seat ? left : 0} sharing={sharing} mobile={mobile} /> : <div className={s.watching}>{v.seats.length < v.opts.seats ? w("table.watching_sit") : w("table.watching_full")}</div>}
    </div>
  );
}

function bySeatU(v: HoldemView, seat: number): string {
  return v.seats.find((x) => x.seat === seat)?.u ?? "";
}

/** `side`: a seat at the oval's left / right end puts its name plate OUTSIDE, beside the avatar (never on the rail). */
function Seat({ seat, v, roomId, left, compact, self, side }: { seat: HoldemSeat; v: HoldemView; roomId: string; left: number; compact?: boolean; self?: boolean; side?: "l" | "r" }) {
  const h = v.hand;
  const turn = h?.to_act?.seat === seat.seat;
  const last = h?.last?.seat === seat.seat ? actionWords(h.last.a, h.last.to) : "";
  const stateWord = SEAT_STATE_WORDS[seat.state] ?? "";
  const res = v.status === "pause" ? v.result : null;
  // the host removes a player between hands (a leave: cash-out + the prestige check)
  const kickable = !compact && !self && v.host === myId() && (v.status === "lobby" || v.status === "pause");
  const wonN = res && !res.voided ? res.pots.reduce((a, p) => a + (p.paid[String(seat.seat)] ?? 0), 0) : 0;
  const winner = wonN > 0;
  const made = res?.best[String(seat.seat)]?.category;
  const shown = seat.shown ?? res?.shown[String(seat.seat)];
  const cards: (string | null)[] = shown ?? (seat.cards > 0 && !self ? [null, null] : []);
  const av = compact ? 30 : 44;
  return (
    <div className={cx(s.seat, compact && s.seatCompact, side === "l" && s.sideL, side === "r" && s.sideR, turn && s.turn, seat.state === "folded" && s.folded, winner && s.winner, self && s.self)} data-testid={`holdem-seat-${seat.seat}`} data-state={seat.state}>
      {kickable && (
        <button type="button" className={s.kick} onClick={() => void actOn(v, { do: "kick", u: seat.u })} aria-label="Remove from the table" data-testid={`holdem-kick-${seat.seat}`}>
          <Icon name="window-close-symbolic" size={10} color="var(--th-text-secondary)" />
        </button>
      )}
      {!compact && cards.length > 0 && (
        <div className={cx(s.holes, shown && s.holesShown)}>
          {cards.map((c, i) => (
            <PlayingCard key={i} card={c} size="sm" dim={seat.state === "folded"} />
          ))}
        </div>
      )}
      <div className={s.avatarWrap} style={{ width: av + 6, height: av + 6 }}>
        <PlayerAvatar mxid={seat.u} roomId={roomId} size={av} />
        {turn && <TurnRing left={left} total={v.opts.turn_s} size={av + 6} />}
        {h?.button === seat.seat && <span className={s.dealer} title="Dealer button">D</span>}
      </div>
      <div className={s.seatText}>
        <PlayerName mxid={seat.u} roomId={roomId} className={s.seatName} />
        <span className={s.seatSub}>
          <Chips n={seat.stack} />
          {(stateWord || last || turn || winner || !seat.connected) && <span className={cx(s.tag, winner && s.tagWin)}>{winner ? `Won ${wonN}` : turn ? `${left}s` : !seat.connected ? w("table.offline") : stateWord || last}</span>}
        </span>
        {made && <span className={s.made}>{HAND_WORDS[made]}</span>}
        {compact && shown && (
          <span className={s.holesInline}>
            {shown.map((c, i) => (
              <PlayingCard key={i} card={c} size="sm" />
            ))}
          </span>
        )}
      </div>
      {compact && seat.bet > 0 && (
        <span className={s.betCompact}>
          <Chips n={seat.bet} />
        </span>
      )}
    </div>
  );
}

function MyArea({ v, mine, roomId, left, sharing, mobile }: { v: HoldemView; mine: HoldemSeat; roomId: string; left: number; sharing: boolean; mobile: boolean }) {
  const y = v.you;
  const legal = y?.legal ?? null;
  const myTurn = !!legal && v.hand?.to_act?.seat === mine.seat;
  // while my Pad has the table (and this isn't the Pad), or while I share my screen: face down, hold to peek (§4.4)
  const padHas = !!y?.screens.includes("pad") && !mobile;
  const hidden = sharing || padHas;
  // a peek is valid only for the privacy context it started in (checked while rendering: a change of context never
  // paints a frame with the faces)
  const ctxKey = `${sharing ? 1 : 0}|${padHas ? 1 : 0}`;
  const [peekAt, setPeekAt] = useState<string | null>(null);
  const peek = peekAt === ctxKey;
  const setPeek = (on: boolean) => setPeekAt(on ? ctxKey : null);
  useEffect(() => {
    // a privacy change always ends a peek (it never carries over to the next time the cards are hidden)
    setPeek(false);
  }, [hidden, sharing, padHas]);
  const r = legal?.raise ?? null;
  const [raiseTo, setRaiseTo] = useState(r?.min ?? 0);
  const turnKey = `${v.hand?.n}:${v.hand?.to_act?.turn}`;
  useEffect(() => {
    setRaiseTo(r?.min ?? 0);
  }, [turnKey, r?.min]);
  const presets = raisePresets(v);
  const call = legal?.call;
  const cards = y?.cards ?? [];
  const showFaces = !hidden || peek;
  // phones: while the raise row is up my cards shrink (and the felt tightens, CSS), so the whole felt stays above my area
  const raising = !!(myTurn && legal && r && r.max > r.min);
  return (
    <div className={cx(s.me, myTurn && s.meTurn, raising && s.raising)} data-testid="holdem-me">
      <div className={s.myCards}>
        <div
          className={cx(s.hand, hidden && s.handHidden)}
          onPointerDown={hidden ? (e) => (e.currentTarget.setPointerCapture(e.pointerId), setPeek(true)) : undefined}
          onPointerUp={() => setPeek(false)}
          onPointerCancel={() => setPeek(false)}
          onLostPointerCapture={() => setPeek(false)}
          data-testid="holdem-mycards"
          data-hidden={hidden && !peek ? "1" : "0"}
        >
          {cards.length ? cards.map((c, i) => <PlayingCard key={i} card={showFaces ? c : null} size={mobile ? (raising ? "lg" : "xl") : "lg"} />) : <span className={s.noCards}>{mine.state === "out" ? w("table.out") : mine.state === "away" ? w("table.sitting_out") : w("table.seat_states.waiting")}</span>}
        </div>
        {hidden && cards.length > 0 && <span className={s.peekHint}>{sharing ? w("table.peek_share") : w("table.peek_pad")}</span>}
        <div className={s.myInfo}>
          <PlayerName mxid={mine.u} roomId={roomId} className={s.myName} />
          <Chips n={mine.stack} big />
          {y?.at_cap && <span className={s.cap}>{w("wallet.at_cap_table")}</span>}
          {(y?.timeouts ?? 0) > 0 && mine.state !== "away" && <span className={s.cap}>{w("table.timeout_note")}</span>}
        </div>
      </div>
      <div className={s.actions} data-testid="holdem-actions">
        {myTurn && legal ? (
          <>
            <div className={s.btnRow}>
              <span className={cx(s.timer, left <= 5 && s.timerLow)} data-testid="holdem-timer">
                {left}s
              </span>
              {legal.fold && <Button className={s.act} text={w("table.fold")} onClick={() => void actOn(v, { do: "fold" })} data-testid="holdem-fold" />}
              {legal.check && <Button className={s.act} text={w("table.check")} onClick={() => void actOn(v, { do: "check" })} data-testid="holdem-check" />}
              {!!call && call > 0 && <Button className={s.act} highlighted text={`Call ${call}`} onClick={() => void actOn(v, { do: "call" })} data-testid="holdem-call" />}
              {r && (
                <Button className={s.act} highlighted={!call} text={raiseTo >= r.max ? `All-in ${r.max}` : `${v.seats.some((x) => x.bet > 0) ? "Raise to" : w("table.actions.bet")} ${raiseTo}`} onClick={() => void actOn(v, raiseTo >= r.max ? { do: "allin" } : { do: "raise", to: raiseTo })} data-testid="holdem-raise" />
              )}
            </div>
            {r && r.max > r.min && (
              <div className={s.raiseRow}>
                <Slider className={s.slider} value={raiseTo} from={r.min} to={r.max} stepSize={1} onMoved={(n) => setRaiseTo(Math.round(n))} aria-label="Raise amount" wheel />
                <div className={s.presets}>
                  {presets.map((p) => (
                    <button key={p.id} type="button" className={cx(s.preset, raiseTo === p.to && s.presetOn)} onClick={() => setRaiseTo(p.to)} data-testid={`holdem-preset-${p.id}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className={s.waitTurn}>{v.hand?.to_act ? w("table.wait_turn") : v.status === "pause" ? w("table.next_hand") : ""}</div>
        )}
      </div>
    </div>
  );
}

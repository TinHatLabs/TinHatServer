// HoldemTable.tsx — Texas Hold'em at one table (GAMES-V1-SPEC.md §4): the felt with up to 8 seats (mine at the bottom
// centre), the board and pots, every seat's stack / bet / state / turn ring, the dealer button, shown cards at the
// showdown, my two cards (face down with hold-to-peek while my Pad has the table, and always while I share my screen),
// the action bar (Fold · Check / Call N · Raise to N with ½ pot / pot / all-in · All-in) and the host's Deal / Close.
// The server's `legal` is the only word on what I may do. Phones: the same pieces stacked (seats strip, felt, my
// cards, a big action bar).
import { useEffect, useMemo, useRef, useState } from "react";
import { useCallStore } from "@/features/calls";
import { toast } from "@/core/bus";
import { Button, ConfirmDialog, Icon, Slider, cx, useIsMobile } from "@/ui";
import { Chips, PlayerAvatar, PlayerName, PlayingCard, SEAT_TOKEN, TableNote, TableSpace, usePlayerLabel, TurnRing, myId, useNow } from "./bits";
import { HAND_NAME, R2_WORDS, actionWords, canDeal, CLOSED_WORDS, HAND_WORDS, winLine, potTotal, raisePresets, SEAT_STATE_WORDS, seatLayout, secondsLeft, w } from "./rules";
import { cardsFace, showHereNext } from "./cardsFace";
import { presenceOf, type CallSnap } from "./seatPresence";
import { PotReactions, ReactTray, SeatMuteMenu, SeatReactions } from "./Reactions";
import { TuneInOffer } from "./TuneIn";
import { HandsSheet } from "./HandsSheet";
import { madeHand, ODDS_DEFAULT_ON } from "./odds";
import { useOdds } from "./oddsClient";
import { usePrefState } from "@/core/prefs";
import { notificationPermission, requestNotificationPermission } from "@/features/settings/notify";
import { TURN_NOTIFY_PREF } from "./turnNotice";
import { actOn, reactsOn, type OpenView } from "./store";
import type { AwayInfo, HandCategory, HoldemSeat, HoldemView } from "./wire";
import s from "./Holdem.module.css";

/** `titled` = false when the game panel's header already names the game. `onPad` = drawn on the Pad screen (my cards are
 *  never hidden there because of the Pad itself). */
export function HoldemTable({ ov, roomId, titled = true, onPad = false }: { ov: OpenView & { view: HoldemView }; roomId: string; titled?: boolean; onPad?: boolean }) {
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
  // B10 §8.2: I stood up while away (the server's stand-up = the v1 leave, chips back to my wallet): say so once
  const wasMine = useRef<HoldemSeat | null>(null);
  useEffect(() => {
    const prev = wasMine.current;
    wasMine.current = mine;
    if (prev && !mine && isAway(prev) && v.status !== "closed") toast(R2_WORDS.stood_up.replace("{n}", String(prev.stack + prev.bet)));
  }, [mine, v.status]);
  const [specHands, setSpecHands] = useState<HTMLElement | null>(null);
  // F7: R opens the reactions tray (never while typing)
  const onRootKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "r" && e.key !== "R") || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const b = e.currentTarget.querySelector<HTMLButtonElement>("[data-react-anchor]");
    if (b) {
      e.preventDefault();
      b.click();
    }
  };
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
        {mine && !isAway(mine) && <Button flat text={w("table.sit_out")} onClick={() => void actOn(v, { do: "away", on: true })} data-testid="holdem-sit-out" />}
        {mine ? (
          <Button flat text={mine.state === "leaving" ? w("table.leaving") : w("table.leave_table")} disabled={mine.state === "leaving"} onClick={() => void actOn(v, { do: "leave" })} data-testid="holdem-leave" />
        ) : (
          v.seats.length < v.opts.seats && <Button highlighted text={w("table.sit")} onClick={() => sit()} data-testid="holdem-sit" />
        )}
        {reactsOn(ov.owner) && <ReactTray table={v.table} roomId={roomId} targets={v.seats.filter((x) => x.u !== me).map((x) => ({ seat: x.seat, u: x.u }))} />}
        {!mine && <Button flat text={R2_WORDS.hands_button} onClick={(e) => setSpecHands(specHands ? null : (e.currentTarget as HTMLElement))} data-testid="holdem-hands-spectator" />}
        {isHost && <Button flat text={w("table.close")} onClick={() => setCloseAsk(true)} data-testid="holdem-close" />}
        {!mine && <HandsSheet open={!!specHands} onClose={() => setSpecHands(null)} anchor={specHands} mine={null} />}
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
        <PotReactions table={v.table} />
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
    <TableSpace.Provider value={v.space || null}>
    <div className={cx(s.root, mobile && s.mobile)} onKeyDown={onRootKey} tabIndex={-1} data-testid="holdem-table" data-status={v.status} data-table={v.table} data-step-hand={v.hand?.street ?? ""}>
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
      {mine ? <MyArea key={v.table} v={v} mine={mine} roomId={roomId} left={toAct?.seat === mine.seat ? left : 0} sharing={sharing} mobile={mobile} onPad={onPad} /> : <div className={s.watching}>{v.seats.length < v.opts.seats ? w("table.watching_sit") : w("table.watching_full")}</div>}
    </div>
    </TableSpace.Provider>
  );
}

const NO_SCREENS: readonly string[] = [];

/** B4: this person's presence in MY call of the table's room (seatPresence.ts); nothing when I'm not in that call. */
function useSeatPresence(mxid: string, roomId: string): { speaking: boolean; muted: boolean } {
  const key = useCallStore((c) => {
    if (!c.inCall || c.callRoomId !== roomId) return "";
    const p = presenceOf(c as unknown as CallSnap, mxid, myId());
    return `${p.speaking ? 1 : 0}${p.muted ? 1 : 0}`;
  });
  return { speaking: key[0] === "1", muted: key[1] === "1" };
}

/** B10: a seat that sits out (0.3.21's `away` object, or v1's `away` state between hands). */
function isAway(seat: Pick<HoldemSeat, "state" | "away">): boolean {
  return !!seat.away || seat.state === "away";
}
function awayReason(a: AwayInfo | null): string {
  if (!a) return R2_WORDS.away_reason_asked;
  return a.reason === "timeout" ? R2_WORDS.away_reason_timeout : a.reason === "gone" ? R2_WORDS.away_reason_gone : R2_WORDS.away_reason_asked;
}
function standLine(n: number): string {
  return n <= 1 ? R2_WORDS.away_stand_one : R2_WORDS.away_stand_hands.replace("{n}", String(n));
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
  const pres = useSeatPresence(seat.u, roomId);
  const away = isAway(seat);
  const awayWord = away ? (seat.away ? R2_WORDS.away_pill_hands.replace("{n}", String(seat.away.hands_left)) : SEAT_STATE_WORDS.away) : "";
  const plateName = usePlayerLabel(roomId, seat.u);
  return (
    <SeatMuteMenu u={seat.u} name={plateName}>
      {(bind) => (
    <div {...(self ? {} : bind)} className={cx(s.seat, compact && s.seatCompact, side === "l" && s.sideL, side === "r" && s.sideR, turn && s.turn, seat.state === "folded" && s.folded, away && !turn && s.awaySeat, winner && s.winner, self && s.self)} data-testid={`holdem-seat-${seat.seat}`} data-state={seat.state} data-away={away ? "1" : undefined}>
      <SeatReactions table={v.table} seat={seat.seat} />
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
      <div className={cx(s.avatarWrap, pres.speaking && s.speaking)} style={{ width: av + 6, height: av + 6 }} data-speaking={pres.speaking ? "1" : undefined} data-muted={pres.muted ? "1" : undefined}>
        <PlayerAvatar mxid={seat.u} roomId={roomId} size={av} />
        {pres.muted && (
          <span className={s.micOff} title="Mic off" data-testid={`holdem-muted-${seat.seat}`}>
            <Icon name="microphone-sensitivity-muted-symbolic" size={compact ? 9 : 11} color="var(--th-text-primary)" />
          </span>
        )}
        {turn && <TurnRing left={left} total={v.opts.turn_s} size={av + 6} />}
        {h?.button === seat.seat && <span className={s.dealer} title="Dealer button">D</span>}
      </div>
      <div className={s.seatText}>
        <PlayerName mxid={seat.u} roomId={roomId} className={s.seatName} tokenSize={SEAT_TOKEN} />
        <span className={s.seatSub}>
          <Chips n={seat.stack} />
          {(stateWord || last || turn || winner || !seat.connected || away) && (
            <span className={cx(s.tag, winner && s.tagWin, away && !winner && !turn && s.tagAway)} data-testid={away ? `holdem-away-${seat.seat}` : undefined}>
              {winner ? `Won ${wonN}` : turn ? `${left}s` : !seat.connected ? w("table.offline") : away ? awayWord : stateWord || last}
            </span>
          )}
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
      )}
    </SeatMuteMenu>
  );
}

function MyArea({ v, mine, roomId, left, sharing, mobile, onPad }: { v: HoldemView; mine: HoldemSeat; roomId: string; left: number; sharing: boolean; mobile: boolean; onPad: boolean }) {
  const y = v.you;
  const legal = y?.legal ?? null;
  const myTurn = !!legal && v.hand?.to_act?.seat === mine.seat;
  // where my cards are face up (addendum §1.4, cardsFace.ts): sharing → down; a Pad of mine has the table → peek with
  // "Your cards are on your phone · Show here"; Show here holds until a Pad attaches AGAIN or the table closes
  const screens = y?.screens ?? NO_SCREENS;
  const [here, setHere] = useState(false);
  const prevScreens = useRef<readonly string[]>(screens);
  const screensKey = screens.join(",");
  useEffect(() => {
    const prev = prevScreens.current; // captured before the updater runs (astra pass 2)
    setHere((h) => showHereNext({ here: h, prevScreens: prev, screens, tableClosed: v.status === "closed" }));
    prevScreens.current = screens;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screensKey, v.status]);
  // astra: the revocation must hold in THIS render (a Pad attaching again never shows one frame of the faces)
  const hereNow = here && showHereNext({ here, prevScreens: prevScreens.current, screens, tableClosed: v.status === "closed" });
  const face = cardsFace({ hasCards: (y?.cards ?? []).length > 0, sharing, onPad, here: hereNow, screens });
  const padHas = face === "peek";
  const hidden = face === "down" || face === "peek";
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
  // faces only when up, or while a Pad-hidden hand is held to peek; never while sharing (the share would show them)
  const showFaces = face === "up" || (face === "peek" && peek);
  // phones: while the raise row is up my cards shrink (and the felt tightens, CSS), so the whole felt stays above my area
  const raising = !!(myTurn && legal && r && r.max > r.min);
  // F5/F6: my made hand and my odds, only while I can see my own cards (up, or held to peek)
  const seen = face === "up" || (face === "peek" && peek);
  const made = seen && cards.length ? madeHand([...cards, ...(v.hand?.board ?? [])]) : null;
  const [oddsOn, setOddsOn] = usePrefState("games.odds", ODDS_DEFAULT_ON);
  const od = useOdds(v, face === "peek" && peek ? "peeking" : face, oddsOn);
  const [handsAt, setHandsAt] = useState<HTMLElement | null>(null);
  // §8.3 "your turn" notices: asked once, the first time I sit (this line under the action bar), then in the Hands sheet
  const [turnPref, setTurnPref] = usePrefState(TURN_NOTIFY_PREF, "");
  const answerTurns = async (yes: boolean) => {
    setTurnPref(yes ? "1" : "0");
    if (yes && notificationPermission() === "default") await requestNotificationPermission();
  };
  return (
    <div className={cx(s.me, myTurn && s.meTurn, raising && s.raising)} data-testid="holdem-me">
      <div className={s.myCards}>
        <div
          className={cx(s.hand, face === "peek" && s.handHidden)}
          onPointerDown={face === "peek" ? (e) => (e.currentTarget.setPointerCapture(e.pointerId), setPeek(true)) : undefined}
          onPointerUp={() => setPeek(false)}
          onPointerCancel={() => setPeek(false)}
          onLostPointerCapture={() => setPeek(false)}
          data-testid="holdem-mycards"
          data-hidden={cards.length && !showFaces ? "1" : "0"}
        >
          {cards.length ? cards.map((c, i) => <PlayingCard key={i} card={showFaces ? c : null} size={mobile ? (raising ? "lg" : "xl") : "lg"} />) : <span className={s.noCards}>{mine.state === "out" ? w("table.out") : mine.state === "away" ? w("table.sitting_out") : w("table.seat_states.waiting")}</span>}
          {mine.state === "out" && <TuneInOffer owner={v.owner} space={v.space} compact />}
        </div>
        {face === "down" && <span className={s.peekHint}>{R2_WORDS.hidden_sharing}</span>}
        <div className={s.myInfo}>
          <PlayerName mxid={mine.u} roomId={roomId} className={s.myName} />
          <Chips n={mine.stack} big />
          {face === "peek" && (
            <span className={s.onPhone} data-testid="holdem-on-phone">
              <span>{R2_WORDS.cards_on_phone}</span>
              <button type="button" className={s.showHere} onClick={() => setHere(true)} data-testid="holdem-show-here">
                {R2_WORDS.show_here}
              </button>
            </span>
          )}
          {made && (
            <span className={s.oddsLine} data-testid="holdem-odds">
              <span className={s.made}>{HAND_NAME[made]}</span>
              {od && <span data-testid="holdem-odds-win">{R2_WORDS.odds_win.replace("{p}", od.winLabel)}</span>}
              {od && od.tieLabel !== "0%" && <span>{R2_WORDS.odds_tie.replace("{p}", od.tieLabel)}</span>}
              {od?.outs && od.outs.total > 0 && (
                <span className={s.improve} title={`${Object.entries(od.outs.by).map(([c, n]) => `${HAND_NAME[c as HandCategory]} ${n}`).join(" · ")}\n${R2_WORDS.odds_info}`} tabIndex={0} data-testid="holdem-odds-improve">
                  {od.outs.total === 1 ? R2_WORDS.odds_improve_one : R2_WORDS.odds_improve.replace("{n}", String(od.outs.total))}
                  <Icon name="help-about-symbolic" size={10} color="currentColor" />
                </span>
              )}
            </span>
          )}
          {y?.at_cap && <span className={s.cap}>{w("wallet.at_cap_table")}</span>}
          {/* v1's "two in a row and you sit out": only from a 0.3.20 server (0.3.21 sends `you.away` and sits you out after one) */}
          {(y?.timeouts ?? 0) > 0 && !isAway(mine) && !(y && "away" in y) && <span className={s.cap}>{w("table.timeout_note")}</span>}
        </div>
        <button type="button" className={s.handsBtn} onClick={(e) => setHandsAt(handsAt ? null : e.currentTarget)} aria-expanded={!!handsAt} data-testid="holdem-hands">
          <Icon name="help-about-symbolic" size={12} color="currentColor" />
          {R2_WORDS.hands_button}
        </button>
        <HandsSheet open={!!handsAt} onClose={() => setHandsAt(null)} anchor={handsAt} mine={made} odds={{ on: oddsOn === true, set: (b) => setOddsOn(b) }} turns={{ on: turnPref === "1", set: (b) => void answerTurns(b) }} />
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
        ) : turnPref === "" && !isAway(mine) ? (
          <div className={s.turnAsk} data-testid="holdem-turn-ask">
            <span>{R2_WORDS.turn_ask}</span>
            <button type="button" className={s.showHere} onClick={() => void answerTurns(true)} data-testid="holdem-turn-yes">
              {R2_WORDS.turn_yes}
            </button>
            <button type="button" className={s.turnNo} onClick={() => void answerTurns(false)} data-testid="holdem-turn-no">
              {R2_WORDS.turn_no}
            </button>
          </div>
        ) : isAway(mine) ? (
          <div className={s.awayBox} data-testid="holdem-away-me">
            <Button highlighted className={s.backBtn} text={R2_WORDS.away_back} onClick={() => void actOn(v, { do: "away", on: false })} data-testid="holdem-back" />
            <span className={s.awayLine}>
              {awayReason(y?.away ?? mine.away ?? null)}
              {(y?.away ?? mine.away) && <> · {standLine((y?.away ?? mine.away)!.hands_left)}</>}
            </span>
          </div>
        ) : (
          <div className={s.waitTurn}>{v.hand?.to_act ? w("table.wait_turn") : v.status === "pause" ? w("table.next_hand") : ""}</div>
        )}
      </div>
    </div>
  );
}

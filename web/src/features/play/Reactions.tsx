// Reactions.tsx — F7 table reactions on the web (GAMES-V1.1-ADDENDUM §4): the tray (6 reactions in the shared order,
// Toss asks where to, "Mute reactions" as its last row), the badges drawn on the seat plates (64 px max, 1.2 s; a
// still badge for 2 s when the window isn't focused / the stage isn't visible / reduced motion), and the seat plate's
// "Mute {person}'s reactions" (right-click / long-press). Light and free: no money, no sound. Desktop twin:
// ReactionsTray.qml + the seat plate overlay (games-desktop2).
import { useRef, useState, type ReactNode } from "react";
import { useWinState } from "@/core/winstate";
import { setPref, usePref } from "@/core/prefs";
import { toast } from "@/core/bus";
import { CheckBox, Icon, Popover, cx } from "@/ui";
import { useReducedMotion } from "@/ui/motion";
import { glyphFor, inkFor } from "@/features/prestige/PrestigeToken";
import { prestigeTier } from "@/features/prestige/clientRules";
import { PlayerName, SEAT_TOKEN, useNow } from "./bits";
import { REACT_GLYPH, REACTIONS, type ReactEvt, type ReactionId } from "./reactRules";
import { REACT_WORDS } from "./rules";
import { REACT_MUTE_PREF, reactMutedPeople, reactWait, sendReact, setReactMutedPerson, usePlay } from "./store";
import s from "./Reactions.module.css";

/** The glyph of a reaction (`tip` = the prestige token's hat). */
export function ReactGlyph({ r, size = 20 }: { r: ReactionId; size?: number }) {
  if (r === "tip") {
    const look = prestigeTier(5);
    return <Icon name={glyphFor(look)} size={size} color={inkFor(look)} staticOnly />;
  }
  return (
    <span className={s.emoji} style={{ fontSize: size }} aria-hidden>
      {REACT_GLYPH[r]}
    </span>
  );
}

/** The tray's button + popover (the table bar). `targets` = the seats a coin can go to (not mine). */
export function ReactTray({ table, roomId, targets, anchorClass }: { table: string; roomId: string; targets: { seat: number; u: string }[]; anchorClass?: string }) {
  const [at, setAt] = useState<HTMLElement | null>(null);
  const [tossing, setTossing] = useState(false);
  const muteAll = usePref(REACT_MUTE_PREF, "0");
  const now = useNow(at ? 500 : 60_000);
  const wait = at ? reactWait(table) : 0;
  void now;
  const go = (r: ReactionId, to?: number | "pot") => {
    void sendReact(table, r, to).then((a) => {
      if (!a.ok && a.code === "cooldown") toast("Easy there: one more in a moment");
    });
    setTossing(false);
  };
  return (
    <>
      <button type="button" className={cx(s.trayBtn, anchorClass)} onClick={(e) => setAt(at ? null : e.currentTarget)} aria-expanded={!!at} aria-label={REACT_WORDS.tray} title={`${REACT_WORDS.tray} (R)`} data-testid="react-tray-button" data-react-anchor="">
        <span aria-hidden>👏</span>
        <span className={s.trayWord}>{REACT_WORDS.tray}</span>
      </button>
      <Popover open={!!at} onClose={() => (setAt(null), setTossing(false))} anchor={at} placement="below" align="end" plain aria-label={REACT_WORDS.tray} role="dialog">
        <div className={s.tray} data-testid="react-tray">
          <div className={s.row}>
            {REACTIONS.map((r) => (
              <button key={r} type="button" className={cx(s.rx, tossing && r === "toss" && s.rxOn)} disabled={wait > 0} onClick={() => (r === "toss" ? setTossing(!tossing) : go(r))} aria-label={REACT_WORDS[`label_${r}`]} title={REACT_WORDS[`label_${r}`]} data-testid={`react-${r}`}>
                <ReactGlyph r={r} size={22} />
              </button>
            ))}
          </div>
          {tossing && (
            <div className={s.toss} data-testid="react-toss-targets">
              <span className={s.tossWord}>{REACT_WORDS.toss_to}</span>
              <button type="button" className={s.target} onClick={() => go("toss", "pot")} data-testid="react-toss-pot">
                {REACT_WORDS.pot}
              </button>
              {targets.map((t) => (
                <button key={t.seat} type="button" className={s.target} onClick={() => go("toss", t.seat)} data-testid={`react-toss-${t.seat}`}>
                  <PlayerName mxid={t.u} roomId={roomId} tokenSize={SEAT_TOKEN} />
                </button>
              ))}
            </div>
          )}
          <div className={s.mute}>
            <CheckBox text={REACT_WORDS.mute_all} checked={muteAll === "1"} onToggled={(b: boolean) => setPrefMuteAll(b)} data-testid="react-mute-all" />
          </div>
        </div>
      </Popover>
    </>
  );
}
function setPrefMuteAll(on: boolean): void {
  setPref(REACT_MUTE_PREF, on ? "1" : "0");
}

/** The reactions of one seat (drawn inside its plate) — and the coins tossed TO it. */
export function SeatReactions({ table, seat }: { table: string; seat: number }) {
  const list = usePlay((x) => x.reacts[table]);
  const win = useWinState();
  const reduced = useReducedMotion();
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  const still = reduced || win !== "focused" || !visible;
  const mine = (list ?? []).filter((e) => e.seat === seat || (e.r === "toss" && e.to === seat));
  if (!mine.length) return null;
  const last = mine[mine.length - 1]!;
  const incoming = last.r === "toss" && last.to === seat && last.seat !== seat;
  return (
    <span key={`${last.u}${last.got}`} className={cx(s.badge, !still && s[`a_${last.r}`], incoming && s.incoming, still && s.still)} data-testid={`react-on-${seat}`} data-r={last.r} aria-hidden>
      <ReactGlyph r={last.r} size={22} />
    </span>
  );
}

/** A coin tossed into the pot (drawn by the pot). */
export function PotReactions({ table }: { table: string }) {
  const list = usePlay((x) => x.reacts[table]);
  const reduced = useReducedMotion();
  const e = [...(list ?? [])].reverse().find((x) => x.r === "toss" && (x.to === "pot" || x.to === undefined));
  if (!e) return null;
  return (
    <span key={`${e.u}${e.got}`} className={cx(s.potCoin, !reduced && s.a_potcoin)} data-testid="react-pot" aria-hidden>
      🪙
    </span>
  );
}

/** Right-click / long-press on someone's plate: "Mute {person}'s reactions" (saved per person). */
export function SeatMuteMenu({ u, name, children }: { u: string; name: string; children: (bind: { onContextMenu: (e: React.MouseEvent) => void; onPointerDown: (e: React.PointerEvent) => void; onPointerUp: () => void; onPointerCancel: () => void }) => ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>(0);
  const muted = reactMutedPeople().includes(u);
  const bind = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const { clientX: x, clientY: y } = e;
      timer.current = window.setTimeout(() => setAt({ x, y }), 550);
    },
    onPointerUp: () => window.clearTimeout(timer.current),
    onPointerCancel: () => window.clearTimeout(timer.current),
  };
  return (
    <>
      {children(bind)}
      <Popover open={!!at} onClose={() => setAt(null)} anchor={at} placement="at" plain aria-label={name}>
        <div className={s.menu} data-testid="react-seat-menu">
          <button
            type="button"
            className={s.menuItem}
            onClick={() => {
              setReactMutedPerson(u, !muted);
              setAt(null);
              toast(muted ? `${name}'s reactions are back` : `${name}'s reactions are muted`);
            }}
            data-testid="react-mute-person"
          >
            {(muted ? REACT_WORDS.unmute_person : REACT_WORDS.mute_person).replace("{person}", name)}
          </button>
        </div>
      </Popover>
    </>
  );
}

export type { ReactEvt };

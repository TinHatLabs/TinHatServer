// HandsSheet.tsx — F5 (GAMES-V1.1-ADDENDUM §2): the hand rankings, strongest first, each with a five-card example drawn
// with the table's own card faces (60 %) and one line; my current made hand highlighted ("You: …") while my cards are
// face up (or peeked). Desktop / web: a 360 px popover anchored to the Hands button (Esc / outside closes it); phones: a
// bottom sheet. Not modal: the table keeps running behind it. The desktop's HandsSheet.qml draws the same.
import { CheckBox, Popover, useIsMobile } from "@/ui";
import { artVars } from "./art";
import { PlayingCard } from "./bits";
import { HAND_RANKINGS, R2_WORDS } from "./rules";
import type { HandCategory } from "./wire";
import s from "./HandsSheet.module.css";

/** `odds` = the "Show my odds" switch (players only; F6 §3.1: saved per person in the app's settings). */
export function HandsSheet({ open, onClose, anchor, mine, odds, turns }: { open: boolean; onClose: () => void; anchor: HTMLElement | null; mine: HandCategory | null; odds?: { on: boolean; set: (on: boolean) => void }; turns?: { on: boolean; set: (on: boolean) => void } }) {
  // phones: the app's bottom sheet (the popover's own sheet chrome); desktop / web: our 360 px panel
  const mobile = useIsMobile();
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="above" align="end" plain={!mobile} aria-label={R2_WORDS.hands_title} role="dialog">
      <div className={s.sheet} style={artVars()} data-testid="hands-sheet">
        <div className={s.title}>{R2_WORDS.hands_title}</div>
        <ol className={s.list}>
          {HAND_RANKINGS.map((r, i) => (
            <li key={r.category} className={s.row} data-mine={mine === r.category ? "1" : undefined} data-testid={`hands-row-${r.category}`}>
              <span className={s.n}>{i + 1}</span>
              <span className={s.body}>
                <span className={s.name}>{r.name}</span>
                <span className={s.cards} aria-hidden>
                  {r.example.map((c) => (
                    <PlayingCard key={c} card={c} size="sm" className={s.card} />
                  ))}
                </span>
                <span className={s.line}>{r.line}</span>
                {mine === r.category && <span className={s.you}>{R2_WORDS.hands_you.replace("{what}", r.name)}</span>}
              </span>
            </li>
          ))}
        </ol>
        <div className={s.foot}>{R2_WORDS.hands_foot}</div>
        {odds && (
          <div className={s.setting}>
            <CheckBox text={R2_WORDS.odds_toggle} checked={odds.on} onToggled={(b: boolean) => odds.set(b)} data-testid="hands-odds-toggle" />
            {turns && <CheckBox text={R2_WORDS.turn_toggle} checked={turns.on} onToggled={(b: boolean) => turns.set(b)} data-testid="hands-turn-toggle" />}
          </div>
        )}
      </div>
    </Popover>
  );
}

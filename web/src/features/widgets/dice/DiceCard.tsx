// dice/DiceCard.tsx — a roll as a card (WIDGETS-UI.md §16.3; the desktop's DiceCard.qml): the total big on the left, then
// who / when (the widget) or "rolled <expr>" (the chat), the dice faces — kept dice filled, dropped dice outlined and
// struck through, a subtracted group led by "−" — the modifier, and the Advantage / Disadvantage label; a natural 20 / 1
// on the one kept d20 colours the total and that die and adds a "NAT 20" / "NAT 1" chip. An opaque card
// (`widget.dice.card.*`), so it reads the same in my bubble, in others' and in the widget.
//
// The landing (motion `diceTumble`, GPU.md §1 (a): one-shot, the duration token): a roll I just made in this app lands
// once — its faces rotate ∓12° → 0 (alternating), scale 0.7 → 1 and fade in, the total with them, `verylong` 400 ms
// OutCubic — only while `animate`; otherwise (and for every other card) the final card at once. No timer, nothing loops.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx, useAnimate } from "@/ui";
import { facesOf, modifierOf, type DiceResult } from "@/widgets/dice";
import s from "./DiceCard.module.css";

/** Faces the card shows in one line before "+n" (the widget; the chat card wraps and shows every die). */
export const WIDGET_FACES = 8;

export function natText(r: DiceResult): string {
  return r.natural === "nat20" ? "NAT 20" : r.natural === "nat1" ? "NAT 1" : "";
}

/** The card's text for screen readers: "2d6+3: 9 — dice 4, 2, plus 3". */
export function diceLabel(r: DiceResult): string {
  const faces = facesOf(r);
  const kept = faces.filter((f) => f.kept).map((f) => `${f.sign < 0 ? "minus " : ""}${f.v}`);
  const dropped = faces.filter((f) => !f.kept).map((f) => String(f.v));
  const mod = modifierOf(r);
  const nat = r.natural === "nat20" ? ", natural 20" : r.natural === "nat1" ? ", natural 1" : "";
  return `${r.expr}${r.label ? ` (${r.label})` : ""}: ${r.total}${nat} — dice ${kept.join(", ")}${mod ? `, ${mod.startsWith("-") ? "minus" : "plus"} ${mod.replace(/^[+-]/, "")}` : ""}${dropped.length ? `; dropped ${dropped.join(", ")}` : ""}`;
}

/** The landing: a new `playKey` (a roll of mine) lands once while animate is on → the key to animate with, else null. */
function useLand(playKey: number | null): number | null {
  const animate = useAnimate();
  const played = useRef<number | null>(null);
  const [landing, setLanding] = useState<number | null>(null);
  useEffect(() => {
    // another card (someone else's roll, an older one) never lands: new faces must not pick the landing up
    if (playKey === null) return setLanding(null);
    if (played.current === playKey) return;
    played.current = playKey;
    setLanding(animate ? playKey : null);
  }, [playKey, animate]);
  return landing;
}

export interface DiceCardProps {
  r: DiceResult;
  variant: "widget" | "chat";
  /** the widget's first line (who · when); the chat card says "rolled <expr>" instead */
  head?: ReactNode;
  /** a new value plays the landing once (a roll I just made) */
  playKey?: number | null;
  mobile?: boolean;
  maxWidth?: number;
}

export function DiceCard({ r, variant, head, playKey = null, mobile, maxWidth }: DiceCardProps) {
  const land = useLand(playKey);
  const faces = facesOf(r);
  const limit = variant === "widget" ? WIDGET_FACES : faces.length;
  const more = faces.length - limit;
  const mod = modifierOf(r);
  const nat = natText(r);
  const natIdx = r.natural ? faces.findIndex((f) => f.sides === 20 && f.kept) : -1;
  return (
    <div
      className={cx(s.card, variant === "chat" ? s.chat : s.widget, mobile && s.mobile)}
      style={maxWidth ? { maxWidth } : undefined}
      data-natural={r.natural || undefined}
      role="group"
      aria-label={`Dice roll ${diceLabel(r)}`}
    >
      <div key={`t${land ?? ""}`} className={cx(s.total, r.natural === "nat20" && s.nat20, r.natural === "nat1" && s.nat1)} data-land={land !== null ? "" : undefined} aria-hidden="true">
        {r.total}
      </div>
      <div className={s.main}>
        {variant === "widget" ? (
          head
        ) : (
          <div className={s.line}>
            <span className={s.meta}>
              rolled <span className={s.expr}>{r.expr}</span>
              {r.label ? ` · ${r.label}` : ""}
            </span>
            {nat && <span className={cx(s.natChip, r.natural === "nat20" ? s.natChip20 : s.natChip1)}>{nat}</span>}
          </div>
        )}
        <div key={`f${land ?? ""}`} className={cx(s.faces, variant === "chat" && s.facesWrap)} aria-hidden="true">
          {faces.slice(0, limit).map((f, i) => {
            const lead = f.sign < 0 && (i === 0 || faces[i - 1]!.sign > 0);
            return (
              <span key={i} className={s.faceBox}>
                {lead && <span className={s.minus}>−</span>}
                <span
                  className={cx(s.face, !f.kept && s.dropped, i === natIdx && (r.natural === "nat20" ? s.face20 : s.face1))}
                  data-land={land !== null ? (i % 2 ? "r" : "l") : undefined}
                  title={`d${f.sides}${f.kept ? "" : " · dropped"}`}
                >
                  {f.v}
                </span>
              </span>
            );
          })}
          {more > 0 && <span className={s.more}>+{more}</span>}
          {mod && <span className={s.mod}>{mod}</span>}
        </div>
        {variant === "widget" && (
          <div className={s.line}>
            <span className={s.meta}>
              <span className={s.expr}>{r.expr}</span>
              {r.label ? ` · ${r.label}` : ""}
            </span>
            {nat && <span className={cx(s.natChip, r.natural === "nat20" ? s.natChip20 : s.natChip1)}>{nat}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

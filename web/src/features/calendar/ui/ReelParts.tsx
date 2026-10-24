// ReelParts.tsx — the Game Reel's small pieces: ReelButton.qml (T.Button: primary / checked /
// quiet / default, 34 tall, radius 8, 13 px text, hint tooltip after 500 ms), ReelCover.qml (the
// 132 px portrait cover on the strip: badges, name, odds bar, explain overlay on hover, winner
// outline + pulse) and TierList.qml (96×176 cards with the odds strip, sub-line and explain).
import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DUR, animate, cx, mergeRefs, useAnimate } from "@/ui";
import { useTipRef } from "./util";
import { artUrl, type ReelGame, type StripGame } from "../model/reel";
import { CATALOG_BASE } from "../gamesStore";
import type { Badge } from "../model/games";
import s from "./Reel.module.css";

/** `<catalog>/art/<encodeURIComponent(id)>/portrait` */
export const art = (id: string) => artUrl(CATALOG_BASE, id, "portrait");

export interface ReelButtonProps {
  text: ReactNode;
  primary?: boolean;
  quiet?: boolean;
  checked?: boolean;
  disabled?: boolean;
  hint?: string;
  radius?: number;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  "aria-label"?: string;
}

export const ReelButton = forwardRef<HTMLButtonElement, ReelButtonProps>(function ReelButton(
  { text, primary, quiet, checked, disabled, hint, radius = 8, width, height, className, style, onClick, ...rest },
  ref,
) {
  const tip = useTipRef<HTMLButtonElement>(hint || null, { delay: 500 });
  return (
    <button
      ref={mergeRefs(ref, tip)}
      type="button"
      className={cx(s.rb, primary ? s.rbPrimary : checked ? s.rbChecked : quiet ? s.rbQuiet : s.rbDefault, disabled && s.rbDisabled, className)}
      style={{ borderRadius: radius, width, minWidth: width ?? undefined, height, ...style }}
      disabled={disabled}
      aria-pressed={checked === undefined ? undefined : checked}
      aria-label={rest["aria-label"]}
      onClick={onClick}
    >
      <span className={s.rbText}>{text}</span>
    </button>
  );
});

function Badges({ badges }: { badges: Badge[] }) {
  if (!badges.length) return null;
  return (
    <div className={s.badges}>
      {badges.map((b, i) => (
        <span key={i} className={cx(s.badge, b.kind === "credit" ? s.badgeCredit : b.kind === "favorite" ? s.badgeFav : s.badgeOther)}>
          {b.text}
        </span>
      ))}
    </div>
  );
}

/** Portrait art, cover-cropped, lazy (the catalog never 404s — it draws an SVG placeholder). */
export function Art({ src, className, style }: { src: string; className?: string; style?: CSSProperties }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={cx(s.art, className)} style={style}>
      {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />}
    </span>
  );
}

export interface CoverGame {
  id: string;
  name?: string;
  odds?: number;
  badges?: Badge[];
  explain?: string[];
}

export function ReelCover({ game, art, winner, height }: { game: CoverGame; art: string; winner: boolean; height: number }) {
  const [hover, setHover] = useState(false);
  // GPU.md §1: the winner pop is a one-shot transition → only while the motion switch is on, and within the one
  // duration token's 400 ms cap (was 150 + 320 = 470 ms; same curve, same 150 : 320 split)
  const moving = useAnimate();
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<Animation | null>(null);
  // the pop starts only when this cover BECOMES the winner (not when the switch flips back on) …
  useEffect(() => {
    if (!winner || !animate() || !ref.current?.animate) return;
    // 1 → 1.12 OutCubic → 1.0 OutBack, the whole pop = the `verylong` step (400 ms)
    const a = ref.current.animate(
      [
        { transform: "scale(1)", easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
        { transform: "scale(1.12)", offset: 150 / 470, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
        { transform: "scale(1)" },
      ],
      { duration: DUR.verylong },
    );
    pop.current = a;
    return () => a.cancel();
  }, [winner]);
  // … and a pop in flight finishes at once when the motion switch goes off (unfocused, Reduce motion)
  useEffect(() => {
    if (!moving) pop.current?.finish();
  }, [moving]);
  const odds = Math.min(1, game.odds ?? 0);
  const explain = game.explain ?? [];
  return (
    <div
      ref={ref}
      className={cx(s.cover, winner && s.coverWinner)}
      style={{ height }}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      // touch: no hover — a tap toggles the explain overlay (ARCHITECTURE mobile rules)
      onPointerUp={(e) => e.pointerType !== "mouse" && setHover((h) => !h)}
    >
      <div className={s.coverArt}>
        <Art src={art} className={s.coverImg} />
        <Badges badges={game.badges ?? []} />
      </div>
      <div className={s.coverName}>{game.name || game.id}</div>
      <div className={s.oddsRow}>
        <span className={s.bar}>
          <span className={s.barFill} style={{ width: `${odds * 100}%` }} />
        </span>
        <span className={s.pct}>{Math.round((game.odds ?? 0) * 100)}%</span>
      </div>
      {hover && explain.length > 0 && <div className={s.explain}>{explain.join("\n")}</div>}
    </div>
  );
}

export function TierList({
  title,
  subtitle,
  games,
  art,
  dim,
  showReason,
  nameOf,
}: {
  title: string;
  subtitle?: string;
  games: ReelGame[];
  art: (id: string) => string;
  dim?: boolean;
  showReason?: boolean;
  nameOf: (mxid: string) => string;
}) {
  return (
    <div className={s.tier}>
      <div className={s.caps}>{title}</div>
      {subtitle && <div className={s.tierSub}>{subtitle}</div>}
      <div className={s.tierFlow}>
        {games.map((g) => (
          <TierCard key={g.id} g={g} art={art(g.id)} dim={dim} showReason={showReason} nameOf={nameOf} />
        ))}
      </div>
    </div>
  );
}

function TierCard({ g, art, dim, showReason, nameOf }: { g: ReelGame; art: string; dim?: boolean; showReason?: boolean; nameOf: (m: string) => string }) {
  const [hover, setHover] = useState(false);
  const sub = showReason ? (g.reason ?? "") : g.missing.length ? "Not " + g.missing.map(nameOf).join(", ") : `${g.owners.length} of you would play this`;
  return (
    <div
      className={s.tcard}
      style={{ opacity: dim ? 0.6 : 1 }}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      onPointerUp={(e) => e.pointerType !== "mouse" && setHover((h) => !h)}
    >
      <div className={s.tart}>
        <Art src={art} className={s.coverImg} />
        {!!g.weight && (
          <span className={s.tstrip}>
            <span className={s.tstripFill} style={{ width: `${Math.min(1, g.odds || 0) * 100}%` }} />
          </span>
        )}
      </div>
      <div className={s.tname}>{g.name || g.id}</div>
      <div className={s.tsub}>{sub}</div>
      {hover && g.explain.length > 0 && <div className={s.texplain}>{g.explain.join("\n")}</div>}
    </div>
  );
}

export type { StripGame };

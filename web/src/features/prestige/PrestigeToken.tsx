// PrestigeToken.tsx — the small tin-hat token to the left of a name (GAMES-V1-SPEC §3.1). The desktop's
// PrestigeToken.qml draws the same: one pack glyph (prestige-symbolic / -filled / -ring / -star) tinted with the
// prestige.* theme tokens, 14 px beside 15 px text (12 px in widgets), 4 px before the name, centred on the text.
// Rank 13+: a one-time shine (400 ms: the glyph flashes to prestige.shine.highlight and back, a 1.15× pop) the first
// time that person's token appears while the window is focused and motion is on; never looping (the low-GPU rule).
import { useEffect, useState } from "react";
import { Icon } from "@/ui/Icon";
import { useReducedMotion } from "@/ui/motion";
import { useWinState } from "@/core/winstate";
import { prestigeLabel, prestigeTier, type PrestigeLook } from "./clientRules";
import s from "./PrestigeToken.module.css";

/** The pack glyph for a look (= PrestigeToken.qml glyphFor). */
export function glyphFor(look: PrestigeLook): string {
  if (look.star) return "prestige-star-symbolic";
  if (look.ring) return "prestige-ring-symbolic";
  return look.glyph === "filled" ? "prestige-filled-symbolic" : "prestige-symbolic";
}

/** The ink for a look (= PrestigeToken.qml inkFor): the prestige.* element tokens. */
export function inkFor(look: PrestigeLook): string {
  return look.colour === "muted" ? "var(--th-prestige-outline-fg)" : look.colour === "text" ? "var(--th-prestige-filled-fg)" : "var(--th-prestige-accent-fg)";
}

/** People whose shine has played in this page (one shine per person per run). */
const shone = new Set<string>();

export const TOKEN_SIZE = 14;
export const TOKEN_SIZE_WIDGET = 12;
export const TOKEN_GAP = 4;

export interface PrestigeTokenProps {
  rank: number;
  /** who (for the one-time shine) */
  mxid?: string;
  /** 14 beside 15 px text (default), 12 in widgets */
  size?: number;
  /** add the 4 px gap after the token (the token-only form placed before an existing name label) */
  gap?: boolean;
  className?: string;
}

export function PrestigeToken(p: PrestigeTokenProps) {
  const look = prestigeTier(p.rank);
  const win = useWinState();
  const reduced = useReducedMotion();
  const [shining, setShining] = useState(false);
  const canShine = look.shine && !!p.mxid && win === "focused" && !reduced;
  useEffect(() => {
    if (!canShine || !p.mxid || shone.has(p.mxid)) return;
    shone.add(p.mxid);
    setShining(true);
    const t = setTimeout(() => setShining(false), 450);
    return () => clearTimeout(t);
  }, [canShine, p.mxid]);
  if (look.tier === 0) return null;
  const size = p.size ?? TOKEN_SIZE;
  const label = prestigeLabel(p.rank);
  const name = glyphFor(look);
  return (
    <span
      className={`${s.token} ${shining ? s.pop : ""} ${p.className ?? ""}`}
      style={{ width: size, height: size, marginRight: p.gap ? TOKEN_GAP : undefined }}
      role="img"
      aria-label={label}
      title={label}
      data-prestige-tier={look.tier}
    >
      <Icon name={name} size={size} color={inkFor(look)} staticOnly />
      {shining && <Icon className={s.shine} name={name} size={size} color="var(--th-prestige-shine-highlight)" staticOnly />}
    </span>
  );
}

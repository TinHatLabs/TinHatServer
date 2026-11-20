// bits.tsx — the small pieces every game screen uses: a player's name + avatar (the prestige token's PersonName takes
// over here from the prestige feature), a playing card, a chip stack, the turn ring, the clock hook, the refusal note.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { peekClient, useMember } from "@/core/matrix";
import { Avatar, cx } from "@/ui";
import { PersonName } from "@/features/spaces/PersonName";
import { cardFace } from "./rules";
import { meNow, usePlay } from "./store";
import s from "./bits.module.css";

/** Seconds-precision clock while mounted (1 Hz; nothing animates on its own). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function myId(): string {
  return meNow() || (peekClient()?.getUserId() ?? "");
}

/** A person's name as its own label, with the prestige token of the room's game space at its left (the prestige feature's
 *  PersonName, rev 2 §3.2/§3.3). */
export function PlayerName({ mxid, roomId, className }: { mxid: string; roomId: string; className?: string }) {
  const m = useMember(roomId, mxid);
  const name = m?.name || mxid.replace(/^@([^:]+):.*$/, "$1");
  return <PersonName mxid={mxid} roomId={roomId} name={name} className={cx(s.name, className)} title={mxid} />;
}

export function PlayerAvatar({ mxid, roomId, size = 36 }: { mxid: string; roomId: string; size?: number }) {
  const m = useMember(roomId, mxid);
  return <Avatar name={m?.name || mxid} seed={mxid} size={size} imageSource={m?.avatarMxc ?? null} />;
}

/** One playing card. `card` = "As"; null = a face-down back; `ghost` = an empty board slot. */
export function PlayingCard({ card, size = "md", ghost, dim, className, style }: { card: string | null; size?: "sm" | "md" | "lg" | "xl"; ghost?: boolean; dim?: boolean; className?: string; style?: CSSProperties }) {
  if (ghost) return <span className={cx(s.card, s[size], s.ghost, className)} style={style} aria-hidden />;
  const f = card ? cardFace(card) : null;
  if (!f)
    return (
      <span className={cx(s.card, s[size], s.back, className)} style={style} role="img" aria-label="A face-down card">
        <span className={s.backInner} />
      </span>
    );
  return (
    <span className={cx(s.card, s[size], f.red ? s.red : s.black, dim && s.dim, className)} style={style} role="img" aria-label={f.label} data-card={card}>
      <span className={s.corner}>
        <span className={s.rank}>{f.rank}</span>
        <span className={s.suitSm}>{f.glyph}</span>
      </span>
      <span className={s.pip}>{f.glyph}</span>
    </span>
  );
}

/** A small chip with an amount ("● 18"). */
export function Chips({ n, className, big }: { n: number; className?: string; big?: boolean }) {
  return (
    <span className={cx(s.chips, big && s.chipsBig, className)}>
      <span className={s.chip} aria-hidden />
      <span className={s.chipN}>{n}</span>
    </span>
  );
}

/** The ring that runs down a turn's time: a static SVG arc whose length is the time left (re-drawn at 1 Hz, so an
 *  unfocused window draws nothing between seconds). */
export function TurnRing({ left, total, size }: { left: number; total: number; size: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <svg className={cx(s.ring, left <= 5 && s.ringLow)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className={s.ringBg} />
      <circle cx={size / 2} cy={size / 2} r={r} className={s.ringFg} strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/** The latest refusal on a table, for 4 s. */
export function TableNote({ table }: { table: string }) {
  const note = usePlay((x) => x.notes[table]);
  const now = useNow(1000);
  const ref = useRef<HTMLDivElement>(null);
  if (!note || now - note.at > 4000) return null;
  return (
    <div ref={ref} className={s.note} role="status" data-testid="play-note">
      {note.text}
    </div>
  );
}

// ui.tsx — REACH §2.6 + A4.5 display: hooks over the presence map, the dot (standalone and as Avatar props),
// the status chip and the profile card's presence line.
//
//   usePresence(mxid)          the GET row (null = no dot)
//   useMyPresence()            our own row = the server's view of us (A2.15)
//   avatarDot(row, ring)       Avatar props: colour (statusView), headset glyph in a call, text alternative
//   <PresenceDot row size ring ringWidth/>   the strip's bottom-left dot
//   <StatusChip text color/>   a custom status pill (status colour at 14 % alpha, text in the colour)
//   <PresenceLine mxid [normal]/>  profile card: dot + "Online" / chip + " · In a call · <room>" (normal = the
//                              default font + text colour, Settings → Privacy "Others see you as")
//   presenceLabel(row, room)   "In a call · <room>" / "🎯 LFG · Away" … (tooltips, secondary lines)
import type { CSSProperties } from "react";
import { useRoomName, useSession } from "@/core/matrix";
import { Icon, cx, type AvatarProps, useContentInk } from "@/ui";
import { usePresenceStore, type PresenceRow } from "./runtime";
import { stateWord, statusView, type StatusView } from "./status";
import s from "./presence.module.css";

/** The in-call glyph (the pack has no audio-headset-symbolic; both apps fall back to headphones-symbolic). */
export const CALL_GLYPH = "headphones-symbolic";

export function usePresence(mxid: string | null | undefined): PresenceRow | null {
  return usePresenceStore((st) => (mxid ? (st.users[mxid] ?? null) : null));
}

export function useMyPresence(): PresenceRow | null {
  return usePresence(useSession().userId);
}

export function viewOf(row: PresenceRow): StatusView {
  return statusView(row.state, row.status ?? null, Date.now());
}

/** "Online" / "Away" / "In a call · <room>" — with a custom status "🎯 LFG · In a call · <room>". */
export function presenceLabel(row: PresenceRow, roomName = ""): string {
  const label = viewOf(row).label;
  return row.state === "call" && roomName ? `${label} · ${roomName}` : label;
}

/** Avatar props for a person's dot (§2.6: size = the Avatar rule; the cut ring = the surface behind it). */
export function avatarDot(row: PresenceRow | null, ring?: string): Partial<AvatarProps> {
  if (!row) return {};
  return {
    presenceColor: viewOf(row).dot,
    presenceRing: ring,
    presenceGlyph: row.state === "call",
    presenceLabel: stateWord(row.state),
  };
}

/** A standalone dot (the strip's bubble, lines): a `size` px dot inside its `ringWidth` cut ring in `ring`
 *  (drawn outside the dot, like the desktop Avatar.qml); the white headset in a call at ≥ 12 px. */
export function PresenceDot({
  row,
  size = 12,
  ring,
  ringWidth = 2,
  className,
  style,
}: {
  row: PresenceRow;
  size?: number;
  ring?: string;
  ringWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const v = viewOf(row);
  const glyph = row.state === "call" && size >= 12;
  const outer = size + 2 * ringWidth;
  return (
    <span
      className={cx(s.dot, className)}
      role="img"
      aria-label={stateWord(row.state)}
      data-presence-dot={row.state}
      style={{ width: outer, height: outer, background: ringWidth ? ring : "transparent", ...style }}
    >
      <span className={s.core} style={{ width: size, height: size, background: v.dot }}>
        {glyph && <Icon name={CALL_GLYPH} size={Math.round(size * 0.72)} color="var(--th-presence-incall-icon)" />}
      </span>
    </span>
  );
}

/** "#5865F2" → "rgba(88, 101, 242, a)". */
export function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(149, 165, 166, ${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** A4.5: the status chip — rounded pill, the status colour at 14 % alpha behind text in that colour. */
export function StatusChip({ text, color, className, title }: { text: string; color: string; className?: string; title?: string }) {
  const ink = useContentInk();
  return (
    <span className={cx(s.chip, className)} style={{ background: hexA(color, 0.14), color: ink(color) }} title={title}>
      {text}
    </span>
  );
}

/** Profile card (§2.6 place 4): a line under the name, led by the dot; nothing while the person is absent. */
export function PresenceLine({ mxid, className, ring, normal = false }: { mxid: string; className?: string; ring?: string; normal?: boolean }) {
  const row = usePresence(mxid);
  const room = useRoomName(row?.state === "call" ? row.room : null);
  if (!row) return null;
  const v = viewOf(row);
  // the desktop PresenceLine.qml: the state word unless a chip already says it (plain Online), + the room
  const parts: string[] = [];
  if (!v.chip || row.state !== "online") parts.push(stateWord(row.state));
  if (row.state === "call" && room) parts.push(room);
  return (
    <div className={cx(s.line, normal && s.lineNormal, className)} data-presence={row.state}>
      <PresenceDot row={row} size={10} ring={ring} ringWidth={0} />
      {v.chip && <StatusChip text={v.chip.text} color={v.chip.color} />}
      {parts.length > 0 && <span className={s.tail}>{(v.chip ? "· " : "") + parts.join(" · ")}</span>}
    </div>
  );
}

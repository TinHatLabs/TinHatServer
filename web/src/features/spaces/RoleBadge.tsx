// RoleBadge.tsx — RoleBadge.qml (RBAC §7.2) + the contract form other features use.
//   <RoleBadge name="Streamer" color="#3cbad0" compact />   presentational (member rows)
//   <RoleBadge roomId={r} userId={u} compact />              the member's space tag in that room
//                                                           (highest CUSTOM role; nothing otherwise)
// tone = the role colour when it is a valid colour, else textDim; hidden when the name is empty.
import type { CSSProperties } from "react";
import { useContentInk } from "@/ui/themes";
import { useMemberRoleImpl } from "./roles";
import s from "./RoleBadge.module.css";

export interface RoleBadgeProps {
  /** contract form: show `userId`'s space tag in `roomId` */
  roomId?: string;
  userId?: string;
  /** presentational form */
  name?: string;
  color?: string;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Qt.color(c).valid — a colour the browser understands (hex, rgb(), names). */
export function isValidColor(c: string | null | undefined): boolean {
  if (!c) return false;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") return CSS.supports("color", c.trim());
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim());
}

export function toneOf(color: string | null | undefined): string {
  return isValidColor(color) ? color!.trim() : "var(--th-roles-badge-default-fg)";
}

export function RoleBadge(p: RoleBadgeProps) {
  if (p.name !== undefined || !p.roomId || !p.userId) return <Chip name={p.name ?? ""} color={p.color ?? ""} compact={p.compact} className={p.className} style={p.style} />;
  return <TagBadge roomId={p.roomId} userId={p.userId} compact={p.compact} className={p.className} style={p.style} />;
}

function TagBadge({ roomId, userId, compact, className, style }: { roomId: string; userId: string; compact?: boolean; className?: string; style?: CSSProperties }) {
  const tag = useMemberRoleImpl(roomId, userId);
  if (!tag) return null;
  return <Chip name={tag.name} color={tag.color} compact={compact} className={className} style={style} />;
}

function Chip({ name, color, compact, className, style }: { name: string; color: string; compact?: boolean; className?: string; style?: CSSProperties }) {
  const ink = useContentInk();
  if (!name) return null;
  return (
    <span className={`${s.badge} ${compact ? s.compact : ""} ${className ?? ""}`} style={{ ["--tone" as string]: isValidColor(color) ? ink(color.trim()) : toneOf(color), ...style }} title={name}>
      <span className={s.label}>{name}</span>
    </span>
  );
}

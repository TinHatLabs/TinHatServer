// PersonName.tsx — a person's name where it stands as its own label (GAMES-V1-SPEC §3.2), with the prestige token to
// its left: rank ≥ 1 in the surface's space (rev 2 §3.3). `roomId` = the room the surface is about (its game space's
// rank) or, on a space's own surfaces (its members, its settings), the space's id (that space's rank). Without it (the
// account card, Settings, search) and for DMs / rooms in no space: no token. The desktop's PersonName.qml is the same
// piece. Not for names inside sentences, tooltips, toasts or notifications.
//
//   <PersonName mxid={id} roomId={roomId} name={displayName} className={s.name} />
//   <PrestigeFor mxid={id} roomId={roomId} />      the token alone, before an existing name label (4 px gap included)
//   <WidgetPersonName mxid={id} roomId={roomId} name={…} />   widgets: the 12 px token
//
// Rank 0 (or no games on that server) renders exactly what the surface rendered before: the label element with the
// caller's class and style, nothing else. With a token, the root becomes an inline flex row (token, 4 px, label) and the
// label keeps the caller's ellipsis.
import type { CSSProperties, ReactNode } from "react";
import { PrestigeToken, TOKEN_GAP, TOKEN_SIZE, TOKEN_SIZE_WIDGET } from "@/features/prestige/PrestigeToken";
import { usePrestige } from "@/features/prestige/store";
import s from "./PersonName.module.css";

export interface PersonNameProps {
  mxid: string | null | undefined;
  /** the room the name is shown about (its game space's rank), or a space's own id on its own surfaces; omit = no token */
  roomId?: string | null;
  /** the text (default: children, else the localpart) */
  name?: string;
  children?: ReactNode;
  /** the class/style the surface's name element had */
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** the label's own class (when the surface styles the text separately from the row) */
  labelClassName?: string;
  /** 14 (default) or 12 in widgets */
  tokenSize?: number;
  /** the root takes a whole line (flex instead of inline-flex) */
  block?: boolean;
  /** the element the label was (span by default) */
  as?: "span" | "div" | "strong" | "b";
  onClick?: (e: React.MouseEvent) => void;
}

function localpart(mxid: string | null | undefined): string {
  if (!mxid) return "";
  const i = mxid.indexOf(":");
  return mxid.slice(1, i > 0 ? i : undefined);
}

export function PersonName(p: PersonNameProps) {
  const rank = usePrestige(p.mxid, p.roomId);
  const Tag = p.as ?? "span";
  const text = p.children ?? p.name ?? localpart(p.mxid);
  if (rank <= 0) {
    return (
      <Tag className={[p.className, p.labelClassName].filter(Boolean).join(" ") || undefined} style={p.style} title={p.title} onClick={p.onClick}>
        {text}
      </Tag>
    );
  }
  return (
    <Tag
      className={`${s.row} ${p.block ? s.block : ""} ${p.className ?? ""}`}
      // the row's own display wins over a surface class that made the old label a block / inline element
      style={{ display: p.block ? "flex" : "inline-flex", alignItems: "center", ...p.style }}
      title={p.title}
      onClick={p.onClick}
      data-person-name=""
    >
      <PrestigeToken rank={rank} mxid={p.mxid ?? undefined} size={p.tokenSize ?? TOKEN_SIZE} />
      <span className={`${s.label} ${p.labelClassName ?? ""}`} style={{ marginLeft: TOKEN_GAP }}>
        {text}
      </span>
    </Tag>
  );
}

/** The token alone (with its 4 px gap), placed before a name label a surface already lays out itself. */
export function PrestigeFor(p: { mxid: string | null | undefined; roomId?: string | null; size?: number; className?: string }) {
  const rank = usePrestige(p.mxid, p.roomId);
  if (rank <= 0) return null;
  return <PrestigeToken rank={rank} mxid={p.mxid ?? undefined} size={p.size ?? TOKEN_SIZE} gap className={p.className} />;
}

/** Widgets: the 12 px token (§3.1). One component for every widget's person label. */
export function WidgetPersonName(p: Omit<PersonNameProps, "tokenSize">) {
  return <PersonName {...p} tokenSize={TOKEN_SIZE_WIDGET} />;
}

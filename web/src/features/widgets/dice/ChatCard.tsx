// dice/ChatCard.tsx — a dice roll in the chat (WIDGETS-UI.md §16.4; the desktop's ChatBubble → DiceCard.qml): an
// r.timelineRenderers component for m.room.message events whose ORIGINAL content carries a `dev.tinhat.dice` field that
// re-adds up (the shared readDice) — the card replaces the body text inside the bubble; everything else (edits of such a
// message, a field that doesn't add up, a newer version) stays the plain text other clients show.
import { useMemo } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import type { TimelineRendererProps } from "@/core/registry";
import { readDice } from "@/widgets/dice";
import { DiceCard } from "./DiceCard";

/** The renderer's match: a message whose original content reads as a roll. */
export function isDiceEvent(ev: MatrixEvent): boolean {
  return readDice(ev.getOriginalContent()) !== null;
}

export function DiceChatCard({ event }: TimelineRendererProps) {
  const r = useMemo(() => readDice(event.getOriginalContent()), [event]);
  if (!r) return null;
  return <DiceCard r={r} variant="chat" />;
}

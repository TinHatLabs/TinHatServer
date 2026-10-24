// polls/ChatCard.tsx — a poll in the chat (WIDGETS-UI.md §17.4; the desktop's ChatBubble → PollCard.qml): an
// r.timelineRenderers component for poll starts (both names) that read as a poll (the shared readStart) — the card in
// place of the body. It follows the room's loaded timeline for the responses and ends (js-sdk's local echo makes my vote
// count at once); the gates' sample polls (?chatsamples=polls) bring their own responses and ends.
import { useMemo } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import type { TimelineRendererProps } from "@/core/registry";
import { useClient, useMyMembership } from "@/core/matrix";
import { useIsMobile } from "@/ui";
import { sampleRelations, useRoomTimeline } from "@/features/chat";
import { readStart } from "@/widgets/polls";
import { PollCard } from "./PollCard";
import { endPoll, relationsOf, viewOf, vote } from "./store";

/** The renderer's match: a start that reads as a poll. */
export function isPollEvent(ev: MatrixEvent): boolean {
  return readStart(ev.getType(), ev.getOriginalContent()) !== null;
}

export function PollChatCard({ roomId, event }: TimelineRendererProps) {
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const tl = useRoomTimeline(roomId);
  const membership = useMyMembership(roomId);
  const mobile = useIsMobile();
  const v = useMemo(() => {
    const room = client?.getRoom(roomId) ?? null;
    return viewOf(room, event, [...relationsOf(tl.events), ...sampleRelations(roomId, me)], me);
  }, [client, roomId, event, tl.version, tl.events, me]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return null;
  // a gate sample looks like the real card, but never sends anything
  const sample = event.getId()?.startsWith("$w3-sample-") ?? false;
  return (
    <PollCard
      poll={v.poll}
      t={v.t}
      canVote={!v.pending && membership === "join"}
      canEnd={v.canEnd}
      onVote={(a) => !sample && vote(roomId, v.id, a)}
      onEnd={() => !sample && endPoll(roomId, v)}
      mobile={mobile}
    />
  );
}

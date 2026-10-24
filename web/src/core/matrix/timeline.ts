// timeline.ts — a room's contiguous history as a view must see it: the live EventTimeline PLUS every
// timeline js-sdk has linked behind it.
//
// Why (2026-09-23 report: "going back into a room the conversation does not load"): with
// `timelineSupport` (client.ts) a gappy sync (`limited: true` — after a reconnect, a sleeping laptop,
// an iOS suspension, a frozen tab, or the first sync after a reload from the IndexedDB cache when >10
// events arrived) makes js-sdk start a NEW, nearly empty live timeline (EventTimelineSet
// .resetLiveTimeline) and keep the old one. Back-paginating the new one fills the gap and, the moment
// it reaches an event it already holds, LINKS the two (EventTimeline.setNeighbouringTimeline) instead
// of copying the older events in — and linking nulls the live timeline's back-pagination token. A view
// that reads `room.getLiveTimeline()` alone then shows only the events since the gap, says "This is
// the start of the conversation" and never loads older messages again (an empty room when the
// post-gap slice held no message rows). Element walks the same chain through its TimelineWindow.
//
//   liveTimelineChain(room)  { timelines (oldest → live), events (oldest first), head, canBack }
//   paginateChainBack(client, room, limit)   back-paginate the chain's OLDEST timeline
import { Direction, type EventTimeline, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";

export interface TimelineChain {
  /** oldest → newest; the live timeline is last */
  timelines: EventTimeline[];
  /** every event of the chain, oldest first (js-sdk keeps each event in exactly one timeline) */
  events: MatrixEvent[];
  /** the timeline to back-paginate: the oldest one in the chain */
  head: EventTimeline;
  /** older history exists on the server (the head still has a back-pagination token) */
  canBack: boolean;
}

/** The live timeline and every timeline linked behind it (`seen` guards against a bad, cyclic link; no
 *  count cap — stopping part-way would leave a head whose back token is null because it HAS a
 *  neighbour, i.e. the very "history ends here" lie this exists to remove). */
export function liveTimelineChain(room: Room): TimelineChain {
  const live = room.getLiveTimeline();
  const timelines: EventTimeline[] = [live];
  const seen = new Set<EventTimeline>(timelines);
  for (let t = live.getNeighbouringTimeline(Direction.Backward); t && !seen.has(t); t = t.getNeighbouringTimeline(Direction.Backward)) {
    timelines.unshift(t);
    seen.add(t);
  }
  const head = timelines[0];
  const events = timelines.length === 1 ? live.getEvents() : timelines.flatMap((t) => t.getEvents());
  return { timelines, events, head, canBack: head.getPaginationToken(Direction.Backward) !== null };
}

/** Load `limit` older events at the chain's oldest end. Resolves like client.paginateEventTimeline. */
export function paginateChainBack(client: MatrixClient, room: Room, limit: number): Promise<boolean> {
  return client.paginateEventTimeline(liveTimelineChain(room).head, { backwards: true, limit });
}

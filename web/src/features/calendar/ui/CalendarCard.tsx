// CalendarCard.tsx — CalendarCard.qml (CAL-62..65) as an r.timelineRenderers component for any
// m.room.message carrying `dev.tinhat.calendar` {container, event}. Live (the event is in the
// calendar the app mirrors right now): stripe, kind, CANCELLED, "title · game", when in MY zone,
// notes (≤ 3 lines), counts and Going / Maybe / Can't answered in place; the markdown summary is
// hidden. Not live (another container / a deleted event): the markdown summary renders above a
// compact "Calendar event — Open calendar" card. A tap anywhere not on a button opens the calendar
// on that event (switching the calendar's container first when needed).
import { useMemo, useState } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import type { TimelineRendererProps } from "@/core/registry";
import { Button, cx } from "@/ui";
import { peekClient } from "@/core/matrix";
import { CARD_KEY, cardWhen, cardKindLabel, markdownToHtml, type CalEvent } from "../model/calendar";
import { useCal, rsvp, mineOf, useMine } from "../calendarStore";
import { openCalendar } from "../entry";
import s from "./Card.module.css";
// the Game servers link (docs/GAMESERVERS.md §5): the linked server's state and join address under the time
import { linkServer } from "@/widgets/gameservers";
import { useGameServers } from "@/features/widgets/gameservers/store";
import { ServerLine } from "@/features/widgets/gameservers/parts";

export interface CardMarker {
  container: string;
  event: string;
}

/** The marker is read from the ORIGINAL event (edits carry it too; chat spec 4.2.14). */
export function cardMarker(ev: MatrixEvent): CardMarker | null {
  const pick = (c: Record<string, unknown> | undefined | null): CardMarker | null => {
    const m = c?.[CARD_KEY] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") return null;
    const container = typeof m.container === "string" ? m.container : "";
    const event = typeof m.event === "string" ? m.event : "";
    return container && event ? { container, event } : null;
  };
  return pick(ev.getOriginalContent?.() as Record<string, unknown>) ?? pick(ev.getContent() as Record<string, unknown>);
}

export const hasCardMarker = (ev: MatrixEvent) => ev.getType() === "m.room.message" && cardMarker(ev) !== null;

/** Answer from the card: same toggle as the detail pane (repeat = clear), my options kept (CAL-63/65). */
export function answerFromCard(marker: CardMarker, ev: CalEvent | null, status: string): void {
  const st = useCal.getState();
  if (!ev || st.containerId !== marker.container) {
    openCalendar({ containerId: marker.container, eventId: marker.event });
    return;
  }
  const m = mineOf(ev); // a still-pending answer counts (two quick taps)
  const next = (m.status || "") === status ? "" : status;
  void rsvp(ev.id, next, m.options);
}

export function CalendarCard({ event }: TimelineRendererProps) {
  const marker = useMemo(() => cardMarker(event), [event]);
  const cid = useCal((x) => x.containerId);
  const live = useCal((x) => (marker && x.containerId === marker.container ? (x.events.find((e) => e.id === marker.event) ?? null) : null));
  const [hover, setHover] = useState(false);
  const mineNow = useMine(live);
  const wantServer = !!live && live.canceled !== true && (!!live.game || !!live.gameId);
  const gs = useGameServers(wantServer);
  const linked = wantServer && gs.status ? linkServer({ game: live!.game, gameId: live!.gameId }, gs.status) : null;
  void cid;
  if (!marker) return null;
  const me = peekClient()?.getUserId() ?? "";
  const mine = event.getSender() === me;
  const canceled = live?.canceled === true;
  const answerable = !!live && !canceled && live.kind !== "focus" && !live.past;
  const myStatus = mineNow.status || "";
  const open = () => openCalendar({ containerId: marker.container, eventId: marker.event });
  const content = event.getContent() as Record<string, unknown>;
  const body = typeof content.body === "string" ? content.body.replace(/^\* /, "") : "";
  const yes = live?.rsvp.yes.length ?? 0;
  const maybe = live?.rsvp.maybe.length ?? 0;
  const counts = [yes > 0 ? `${yes} going` : "", maybe > 0 ? `${maybe} maybe` : ""].filter(Boolean).join(" · ") || "Nobody has answered yet";
  const when = live ? cardWhen(live) : "";
  return (
    <div className={s.wrap} data-calendar-card={live ? "live" : "stale"}>
      {!live && body && <div className={cx(s.summary, mine && s.mine)} dangerouslySetInnerHTML={{ __html: markdownToHtml(body) }} />}
      <div
        className={cx(s.card, mine && s.cardMine, hover && s.cardHover)}
        role="button"
        tabIndex={0}
        onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          open();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            open();
          }
        }}
      >
        <div className={s.stripe} style={{ background: live?.gameColor ? live.gameColor : "var(--th-calendar-card-stripe)" }} />
        <div className={s.col}>
          <div className={s.kindRow}>
            <span className={s.cal}>📅</span>
            <span className={s.kind}>{live ? cardKindLabel(live.kind, live.chosen) : "Calendar event"}</span>
            {canceled && <span className={s.cancelled}>CANCELLED</span>}
          </div>
          {live && <div className={cx(s.title, canceled && s.strike)}>{live.title + (live.game ? "  ·  " + live.game : "")}</div>}
          {live && when && <div className={s.when}>{when}</div>}
          {linked && <ServerLine sv={linked} className={s.server} />}
          {live && live.notes && <div className={s.notes}>{live.notes}</div>}
          {!live && <div className={s.dim}>Open the calendar for the details and to RSVP.</div>}
          {live && !canceled && live.kind !== "focus" && <div className={cx(s.dim, s.elide)}>{counts}</div>}
          {answerable ? (
            <div className={s.answers}>
              {(
                [
                  ["yes", "Going"],
                  ["maybe", "Maybe"],
                  ["no", "Can't"],
                ] as const
              ).map(([k, t]) => (
                <Button
                  key={k}
                  className={s.ans}
                  text={(myStatus === k ? "✓ " : "") + t}
                  flat={myStatus !== k}
                  highlighted={myStatus === k}
                  onClick={() => answerFromCard(marker, live, k)}
                />
              ))}
              <span className={s.fill} />
              <Button className={cx(s.ans, s.openBtn)} text="Open" flat onClick={open} />
            </div>
          ) : (
            <div className={s.openRow}>
              <Button className={s.ans} text="Open calendar" flat onClick={open} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

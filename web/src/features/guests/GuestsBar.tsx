// GuestsBar.tsx — the bar under the Guests room's header (docs/GUESTS.md "The apps" 2; r.roomBanners): on — "Guest
// room is on · [Copy guest link] [New link] [Turn off]" (New link / Turn off for managers), off — "Guest room is off ·
// [Turn on]" (managers) or "The guest room is off"; below it one row per waiting guest "Ana is waiting · [Let in]
// [Turn away]". Driven by the room state the server keeps (`dev.tinhat.guests`, `dev.tinhat.guests.waiting`) through
// sync; the doc (store.ts) adds the roles a device can't see (server admins) and the link. Guests see nothing here.
import { useEffect } from "react";
import { useRoomState, useSession } from "@/core/matrix";
import { Button, Icon, cx } from "@/ui";
import { serverOf } from "@/features/nav/dmTarget";
import { BAR_LABEL, GUESTS_TYPE, WAITING_TYPE, WORDS, barPlan, isGuestsRoom, localRole, mergeRole, parseGuestState, parseWaiting, waitingRows, type BarButton, type BarPlan, type Waiter } from "./model";
import { copyGuestLink, letGuestIn, newGuestLink, refreshGuests, turnGuestAway, turnGuestRoomOff, turnGuestRoomOn, useGuestRoomOffered, useGuests } from "./store";
import s from "./Guests.module.css";

const RUN: Readonly<Record<BarButton, () => Promise<void>>> = { copy: copyGuestLink, newLink: newGuestLink, turnOff: turnGuestRoomOff, turnOn: turnGuestRoomOn };

/** r.roomBanners: draws only in THE Guests room (model.isGuestsRoom), and only when the server offers the guest room. */
export function GuestsBar({ roomId }: { roomId: string }) {
  const offered = useGuestRoomOffered();
  const docRoom = useGuests((st) => st.doc?.room ?? null);
  const hasGuestState = !!useRoomState(roomId, GUESTS_TYPE);
  const alias = useRoomState(roomId, "m.room.canonical_alias")?.alias;
  const me = useSession().userId ?? "";
  if (!offered || !isGuestsRoom({ roomId, docRoom, hasGuestState, canonicalAlias: typeof alias === "string" ? alias : null, server: serverOf(me) })) return null;
  return <Bar roomId={roomId} me={me} />;
}

function Bar({ roomId, me }: { roomId: string; me: string }) {
  const doc = useGuests((st) => st.doc);
  const busy = useGuests((st) => st.busy);
  const pending = useGuests((st) => st.pending);
  const state = parseGuestState(useRoomState(roomId, GUESTS_TYPE));
  const waiting = parseWaiting(useRoomState(roomId, WAITING_TYPE));
  const powerLevels = useRoomState(roomId, "m.room.power_levels");
  const membership = useRoomState(roomId, "m.room.member", me)?.membership;
  const on = state?.on ?? doc?.on ?? false;
  // the doc's roles and link: read when the bar shows, and again whenever the room is turned on or off
  useEffect(() => {
    void refreshGuests();
  }, [roomId, state?.on, state?.since]);
  const role = mergeRole(localRole({ userId: me, membership: typeof membership === "string" ? membership : null, powerLevels }), doc && doc.room === roomId ? doc : null);
  const plan = barPlan(on, role);
  if (!plan) return null;
  return (
    <GuestsBarView
      on={on}
      plan={plan}
      rows={waitingRows(on, role, waiting)}
      busy={busy}
      pending={pending}
      onButton={(b) => void RUN[b]()}
      onLetIn={(w) => void letGuestIn(w)}
      onTurnAway={(w) => void turnGuestAway(w)}
    />
  );
}

export interface GuestsBarViewProps {
  on: boolean;
  plan: BarPlan;
  rows: readonly Waiter[];
  /** a turn on / off / new link is on its way (Copy guest link stays usable) */
  busy: boolean;
  /** waiting ids whose Let in / Turn away is on its way */
  pending: readonly string[];
  onButton: (b: BarButton) => void;
  onLetIn: (w: Waiter) => void;
  onTurnAway: (w: Waiter) => void;
}

/** The bar as drawn (no data of its own: the container above, the UI gallery's `guests` section). */
export function GuestsBarView({ on, plan, rows, busy, pending, onButton, onLetIn, onTurnAway }: GuestsBarViewProps) {
  return (
    <div className={s.bar} role="region" aria-label="Guest room" data-guests-bar={on ? "on" : "off"}>
      <div className={s.line}>
        <Icon name="system-users-symbolic" size={16} color="var(--th-account-ask-icon)" className={s.icon} />
        <span className={s.text}>{plan.text}</span>
        {plan.buttons.length > 0 && (
          <span className={s.btns}>
            {plan.buttons.map((b) => (
              <Button key={b} className={s.btn} flat={b !== "turnOn"} highlighted={b === "turnOn"} text={BAR_LABEL[b]} disabled={busy && b !== "copy"} onClick={() => onButton(b)} data-guests-button={b} />
            ))}
          </span>
        )}
      </div>
      {rows.map((w) => {
        const wait = pending.includes(w.id);
        return (
          <div key={w.id} className={cx(s.line, s.waiter)} data-guest-waiting={w.id}>
            <span className={s.text}>
              <b className={s.name}>{w.name}</b> is waiting
            </span>
            <span className={s.btns}>
              <Button className={s.btn} highlighted text={WORDS.letIn} disabled={wait} onClick={() => onLetIn(w)} data-guests-button="letIn" />
              <Button className={s.btn} flat text={WORDS.turnAway} disabled={wait} onClick={() => onTurnAway(w)} data-guests-button="turnAway" />
            </span>
          </div>
        );
      })}
    </div>
  );
}

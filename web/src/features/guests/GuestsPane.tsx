// GuestsPane.tsx — Settings → Guests (server level; docs/GUESTS.md "The apps" 1): what the guest room is (two
// sentences), its state, and the buttons this user may use (model.panePlan): managers Turn on the guest room / Turn off
// · Copy guest link · New link · Open the Guests room; members Copy guest link · Open the Guests room; everyone else
// Open the Guests room once it exists. The link shows as text too (a browser may refuse the clipboard).
import { useEffect, type ReactNode } from "react";
import { useRoomState, useSession } from "@/core/matrix";
import { Button } from "@/ui";
import { closeSettings } from "@/features/settings";
import { Buttons, NoteRow, Row, Section } from "@/features/settings/rows";
import { EXPLAIN, GUESTS_TYPE, PANE_LABEL, WORDS, localRole, mergeRole, panePlan, parseGuestState, type PaneButton, type PanePlan } from "./model";
import { copyGuestLink, newGuestLink, openGuestsRoom, refreshGuests, turnGuestRoomOff, turnGuestRoomOn, useGuests } from "./store";
import s from "./Guests.module.css";

const RUN: Readonly<Record<PaneButton, () => Promise<unknown>>> = {
  turnOn: turnGuestRoomOn,
  turnOff: turnGuestRoomOff,
  copy: copyGuestLink,
  newLink: newGuestLink,
  open: async () => {
    if (await openGuestsRoom()) closeSettings();
  },
};

export function GuestsPane() {
  const st = useGuests();
  const me = useSession().userId ?? "";
  const room = st.doc?.room ?? null;
  const state = parseGuestState(useRoomState(room, GUESTS_TYPE));
  const powerLevels = useRoomState(room, "m.room.power_levels");
  const membership = useRoomState(room, "m.room.member", me)?.membership;
  useEffect(() => {
    void refreshGuests();
  }, []);
  // on/off as sync has it (the doc may be a moment older)
  useEffect(() => {
    if (state && st.doc && state.on !== st.doc.on) void refreshGuests();
  }, [state?.on]); // eslint-disable-line react-hooks/exhaustive-deps

  let body: ReactNode;
  if (!st.doc) body = <NoteRow tone={st.error ? "danger" : undefined}>{st.loaded ? st.error || WORDS.unavailable : "Checking…"}</NoteRow>;
  else {
    const doc = state ? { ...st.doc, on: state.on } : st.doc;
    const role = mergeRole(localRole({ userId: me, membership: typeof membership === "string" ? membership : null, powerLevels }), st.doc);
    body = <GuestsPaneBody plan={panePlan(doc, role)} link={doc.link} busy={st.busy} onButton={(b) => void RUN[b]()} />;
  }
  return (
    <Section title="Guest room" hint={EXPLAIN}>
      {body}
    </Section>
  );
}

/** The pane's rows as drawn (no data of its own: the pane above, the UI gallery's `guests` section). */
export function GuestsPaneBody({ plan, link, busy, onButton }: { plan: PanePlan; link: string | null; busy: boolean; onButton: (b: PaneButton) => void }) {
  return (
    <>
      <Row
        id="guests.state"
        label={plan.text}
        attrs={{ "data-guests-state": plan.state }}
        control={
          plan.buttons.length > 0 ? (
            <Buttons>
              {plan.buttons.map((b) => (
                <Button key={b} text={PANE_LABEL[b]} highlighted={b === "turnOn"} flat={b === "turnOff" || b === "newLink"} disabled={busy && b !== "copy" && b !== "open"} onClick={() => onButton(b)} data-guests-button={b} />
              ))}
            </Buttons>
          ) : undefined
        }
      />
      {plan.showLink && link && <Row id="guests.link" label="Guest link" description={<span className={s.link}>{link}</span>} />}
    </>
  );
}

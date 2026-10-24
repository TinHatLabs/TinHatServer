// gallery.tsx — the UI gallery's `guests` section (#/__gallery/guests): the bar and Settings → Guests in each state, drawn
// by the real views from the real rules (model.ts) with sample data — no server, no account. For screenshots and
// review; the buttons only toast.
import { toast } from "@/core/bus";
import { Section } from "@/features/settings/rows";
import { EXPLAIN, barPlan, panePlan, waitingRows, type GuestRole, type GuestsDoc, type Waiter } from "./model";
import { GuestsBarView } from "./GuestsBar";
import { GuestsPaneBody } from "./GuestsPane";

const role = (o: Partial<GuestRole>): GuestRole => ({ member: true, guest: false, canAdmit: true, canManage: false, ...o });
const MANAGER = role({ canManage: true });
const MEMBER = role({});
const OUTSIDER = role({ member: false, canAdmit: false });
const WAITING: Waiter[] = [
  { id: "abcd1234", name: "Ana", at: 0 },
  { id: "efgh5678", name: "Bo from the raid group with a long name", at: 0 },
];
const DOC: GuestsDoc = {
  available: true,
  room: "!guests:sample.invalid",
  alias: "#guests:sample.invalid",
  on: true,
  since: 0,
  link: "https://sample.invalid/call/?g=Xq3v9LmR2kT8wYp4ZnB6cJ1d",
  waiting: [],
  canManage: true,
  canAdmit: true,
  member: true,
};
const say = (what: string) => () => toast(`(gallery) ${what}`);

function Bar({ title, on, r, waiting = [] }: { title: string; on: boolean; r: GuestRole; waiting?: Waiter[] }) {
  const plan = barPlan(on, r);
  return (
    <div style={{ marginBottom: 12 }} data-gallery-guests={title}>
      <div style={{ fontSize: "var(--th-font-size-small)", color: "var(--th-text-secondary)", margin: "0 4px" }}>{title}</div>
      {plan ? (
        <GuestsBarView on={on} plan={plan} rows={waitingRows(on, r, waiting)} busy={false} pending={title.includes("letting") ? ["abcd1234"] : []} onButton={(b) => say(b)()} onLetIn={(w) => say(`let ${w.name} in`)()} onTurnAway={(w) => say(`turn ${w.name} away`)()} />
      ) : (
        <div style={{ margin: 4, color: "var(--th-text-secondary)" }}>(no bar)</div>
      )}
    </div>
  );
}

function Pane({ title, doc, r }: { title: string; doc: GuestsDoc; r: GuestRole }) {
  return (
    <div style={{ marginBottom: 12 }} data-gallery-guests-pane={title}>
      <div style={{ fontSize: "var(--th-font-size-small)", color: "var(--th-text-secondary)" }}>{title}</div>
      <Section title="Guest room" hint={EXPLAIN}>
        <GuestsPaneBody plan={panePlan(doc, r)} link={doc.link} busy={false} onButton={(b) => say(b)()} />
      </Section>
    </div>
  );
}

export function GuestsGallery() {
  return (
    <div style={{ background: "var(--th-settings-window-bg)", color: "var(--th-text-primary)", minHeight: "100vh", padding: 16, boxSizing: "border-box", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 520px", maxWidth: 760 }}>
          <Bar title="manager · on · two waiting" on r={MANAGER} waiting={WAITING} />
          <Bar title="member · on · letting Ana in" on r={MEMBER} waiting={WAITING} />
          <Bar title="member · on · nobody waiting" on r={MEMBER} />
          <Bar title="manager · off" on={false} r={MANAGER} />
          <Bar title="member · off" on={false} r={MEMBER} />
          <Bar title="guest · on" on r={role({ guest: true, canAdmit: false })} waiting={WAITING} />
        </div>
        <div style={{ flex: "1 1 520px", maxWidth: 760 }}>
          <Pane title="manager · on" doc={DOC} r={MANAGER} />
          <Pane title="member · on" doc={{ ...DOC, canManage: false }} r={MEMBER} />
          <Pane title="manager · never turned on" doc={{ ...DOC, room: null, on: false, link: null }} r={MANAGER} />
          <Pane title="not a member · off" doc={{ ...DOC, on: false, link: null, canManage: false, canAdmit: false, member: false }} r={OUTSIDER} />
        </div>
      </div>
    </div>
  );
}

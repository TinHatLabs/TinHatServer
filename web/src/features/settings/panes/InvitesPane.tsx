// Invites pane (operators only) — SETTINGS-WINDOW.md §5 (settings-account.md §3.11 for the behaviour): card "Invite
// someone" (Good for / Valid for / Create invite), card "Codes" (one row per code: the code, its summary, Copy code /
// Copy message / Revoke — used-up and expired ones dimmed until removed; Refresh on the heading).
import { useEffect, useState } from "react";
import { toast } from "@/core/bus";
import { Button, ToolButton, cx } from "@/ui";
import { createInvite, inviteBlip, inviteMessage, inviteSummary, refreshInvites, revokeInvite, useInvites } from "../invites";
import { Buttons, ComboRow, NoteRow, Row, Section } from "../rows";
import p from "./panes.module.css";

const USES = [1, 5, 10, 0];
const DAYS = [7, 30, 90, 0];

async function copy(text: string, note: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch {
    toast("Couldn't copy — your browser blocked the clipboard");
  }
}

export function InvitesPane() {
  const st = useInvites();
  const [uses, setUses] = useState(0);
  const [days, setDays] = useState(0);
  useEffect(() => {
    void refreshInvites();
  }, []);
  return (
    <>
      <Section title="Invite someone">
        <ComboRow label="Good for" model={["1 person", "5 people", "10 people", "Unlimited"]} currentIndex={uses} onActivated={setUses} />
        <ComboRow label="Valid for" model={["7 days", "30 days", "90 days", "No expiry"]} currentIndex={days} onActivated={setDays} />
        <Row
          id="invites.create-invite"
          label="Create invite"
          description={`A code lets someone make an account on ${st.server || "this server"} from Tin Hat's sign-in screen ("Create an account"). They type the 8 characters after TH-.`}
          control={<Button highlighted text="Create invite" icon="list-add-symbolic" disabled={st.busy} onClick={() => void createInvite(USES[uses], DAYS[days])} />}
        />
      </Section>

      <Section
        title={"Codes" + (st.invites.length > 0 ? ` · ${st.invites.length}` : "")}
        actions={<ToolButton iconName="view-refresh-symbolic" tip="Refresh" disabled={st.busy} onClick={() => void refreshInvites()} />}
      >
        <Row
          id="invites.codes"
          label="Invite codes"
          description="Revoking a code stops anyone still holding it; accounts already made keep working. Used-up and expired codes stay here, dimmed, until you remove them."
        />
        {st.invites.length === 0 && <NoteRow>No invite codes yet.</NoteRow>}
        {st.invites.map((inv) => (
          <Row
            key={inv.code}
            className={cx(!inv.active && p.invInactive)}
            attrs={{ "data-invite": inv.code }}
            label={
              <span className={p.code}>
                {/^TH-/i.test(inv.code) && <span className={p.codePrefix}>TH-</span>}
                <span className={inv.active ? p.codeOn : p.codeOff}>{inviteBlip(inv.code)}</span>
              </span>
            }
            description={inviteSummary(inv)}
            control={
              <Buttons>
                {inv.active && <Button flat text="Copy code" onClick={() => void copy(inviteBlip(inv.code), `Copied ${inviteBlip(inv.code)}`)} />}
                {inv.active && <Button flat text="Copy message" onClick={() => void copy(inviteMessage(inv, st.server), "Invite message copied — paste it to them")} />}
                <Button flat disabled={st.busy} onClick={() => void revokeInvite(inv.code)}>
                  <span className={p.revoke}>{inv.active ? "Revoke" : "Remove"}</span>
                </Button>
              </Buttons>
            }
          />
        ))}
      </Section>
    </>
  );
}

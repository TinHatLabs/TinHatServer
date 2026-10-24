// InvitesPane.tsx — Settings → Invites (Main.qml 4117-4262) on top of invites.ts. Operators only.
// "Invite someone" (explainer, Good for [1 person|5 people|10 people|Unlimited] for [7 days|30 days|
// 90 days|No expiry], Create invite) · "Codes · N" + refresh · code rows (TH- + blip, summary, Copy
// code / Copy message / Revoke|Remove) · footnote. Owned by features/settings per DECISIONS D18 —
// exported for integration, not registered here.
import { webAppUrl } from "@/core/api";
import { SERVER_LABEL } from "@/core/bearer";
import { useState } from "react";
import { toast } from "@/core/bus";
import { Button, ComboBox, GlowButton, ScrollArea, SectionLabel, Separator, ToolButton, cx } from "@/ui";
import { inviteBlip, inviteMessage, inviteSummary, useInviteCodes } from "./invites";
import { copyText } from "./roomActions";
import s from "./InvitesPane.module.css";

const USES = [
  { t: "1 person", v: 1 },
  { t: "5 people", v: 5 },
  { t: "10 people", v: 10 },
  { t: "Unlimited", v: 0 },
];
const DAYS = [
  { t: "7 days", v: 7 },
  { t: "30 days", v: 30 },
  { t: "90 days", v: 90 },
  { t: "No expiry", v: 0 },
];

export function InvitesPane() {
  const inv = useInviteCodes();
  const [uses, setUses] = useState(0);
  const [days, setDays] = useState(0);
  return (
    <ScrollArea className={s.scroll} contentClassName={s.col}>
      <SectionLabel>Invite someone</SectionLabel>
      <div className={s.hint}>
        {`A code lets someone create an account on ${inv.server || "this server"} from Tin Hat's sign-in screen ("Create an account"). They type just the 8 characters — the TH- is already in the box. Make one, then send them the message.`}
      </div>
      <div className={s.row}>
        <span>Good for</span>
        <ComboBox className={s.combo} model={USES} textRole="t" currentIndex={uses} onActivated={setUses} aria-label="Good for" />
        <span>for</span>
        <ComboBox className={s.combo} model={DAYS} textRole="t" currentIndex={days} onActivated={setDays} aria-label="Valid for" />
        <span className={s.fill} />
        <GlowButton text="Create invite" busy={inv.busy} disabled={inv.busy} onClick={() => void inv.create(USES[uses].v, DAYS[days].v)} />
      </div>
      <Separator />
      <div className={s.row}>
        <SectionLabel>{`Codes · ${inv.invites.length}`}</SectionLabel>
        <span className={s.fill} />
        <ToolButton iconName="view-refresh-symbolic" tip="Refresh" disabled={inv.busy} onClick={() => void inv.refresh()} />
      </div>
      {inv.invites.length === 0 && <div className={s.empty}>No invite codes yet.</div>}
      {inv.invites.map((c) => (
        <div key={c.code} className={cx(s.code, !c.active && s.codeOff)}>
          <div className={s.codeText}>
            <div className={s.codeLine}>
              <span className={s.lh}>TH-</span>
              <span className={cx(s.blip, !c.active && s.blipOff)}>{inviteBlip(c.code)}</span>
            </div>
            <div className={s.summary}>{inviteSummary(c)}</div>
          </div>
          {c.active && (
            <Button
              flat
              text="Copy code"
              onClick={async () => {
                if (await copyText(inviteBlip(c.code))) toast(`Copied ${inviteBlip(c.code)}`, { timeoutMs: 2500 });
              }}
            />
          )}
          {c.active && (
            <Button
              flat
              text="Copy message"
              onClick={async () => {
                if (await copyText(inviteMessage(c, inv.server || SERVER_LABEL, webAppUrl(), ""))) toast("Invite message copied — paste it to them", { timeoutMs: 2500 });
              }}
            />
          )}
          <Button flat className={s.danger} text={c.active ? "Revoke" : "Remove"} disabled={inv.busy} onClick={() => void inv.revoke(c.code)} />
        </div>
      ))}
      <div className={s.hint}>
        Revoking a code stops anyone still holding it; accounts already created keep working. Used-up and expired codes stay here, dimmed, until you remove them.
      </div>
    </ScrollArea>
  );
}

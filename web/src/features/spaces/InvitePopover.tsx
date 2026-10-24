// InvitePopover.tsx — SSW invite popover: modal, centred, 440 px, padding 12, radius 14, panel, 1 px
// sep, shadow 18 px; "Invite to <space>", hint, the query field (autofocus, 250 ms debounced user
// directory search, stale answers dropped), results (28 px avatars, "already a member" dimmed),
// Enter invites a full @user:server or the first non-member hit; "Done".
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Heading, HintLabel, Icon, Popover, ScrollArea, TextField, localpart, cx, useIsMobile } from "@/ui";
import { spaceActions, useSpaceAdmin } from "./store";
import { MiddleElide } from "./MiddleElide";
import { spaceWinRect } from "./winGeom";
import s from "./SpaceSettings.module.css";

export function InvitePopover({ onClose }: { onClose: () => void }) {
  const summary = useSpaceAdmin((st) => st.summary);
  const hits = useSpaceAdmin((st) => st.userSearch);
  const [q, setQ] = useState("");
  const timer = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    spaceActions.clearSearch();
    requestAnimationFrame(() => field.current?.focus());
    return () => window.clearTimeout(timer.current);
  }, []);
  const onText = (v: string) => {
    setQ(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => spaceActions.searchUsers(v.trim()), 250);
  };
  const invite = (mxid: string) => {
    spaceActions.invite(mxid);
    onText("");
  };
  const fromQuery = () => {
    const t = q.trim();
    if (/^@[^:\s]+:[^\s]+$/.test(t)) return invite(t);
    const first = hits.find((h) => !h.alreadyMember);
    if (first) invite(first.mxid);
  };
  const shownHits = q.trim() ? hits : [];
  const listH = Math.min(252, Math.max(72, shownHits.length * 43.2 + 4));
  const spaceName = summary?.name || "the space";
  const mobile = useIsMobile();
  // centred on the Space settings window (Qt Popup parented to it), not on the page
  const [winRect] = useState(() => spaceWinRect());
  return (
    <Popover open onClose={onClose} modal plain anchor={winRect} placement="center" flip={false} className={mobile ? undefined : s.invitePop} aria-label={`Invite to ${spaceName}`}>
      <div className={s.inviteCol}>
        <Heading level={3} className={s.inviteTitle}>
          Invite to {spaceName}
        </Heading>
        <HintLabel>Search the directory, or paste a full @user:server id and press Enter.</HintLabel>
        <TextField ref={field} className={s.mt4} placeholder="Name or @user:server" value={q} onChange={(e) => onText(e.target.value)} onAccepted={fromQuery} aria-label="Name or @user:server" />
        <div className={s.inviteList} style={{ height: listH }}>
          {shownHits.length === 0 ? (
            <div className={s.inviteEmpty}>{q.trim() ? "No one by that name yet — a full @user:server id always works" : "Type a name to search"}</div>
          ) : (
            <ScrollArea className={s.fillArea} contentClassName={s.hitList}>
              {shownHits.map((h) => (
                <div
                  key={h.mxid}
                  className={cx(s.hit, h.alreadyMember && s.hitTaken)}
                  role="button"
                  aria-disabled={h.alreadyMember}
                  onClick={() => !h.alreadyMember && invite(h.mxid)}
                >
                  <div className={s.hitInner} style={{ opacity: h.alreadyMember ? 0.55 : 1 }}>
                    <Avatar size={28} name={h.name || h.mxid} seed={h.mxid} imageSource={h.avatar} />
                    <div className={s.hitText}>
                      <div className={s.hitName}>{h.name || localpart(h.mxid)}</div>
                      <MiddleElide className={s.hitMxid} text={h.mxid} />
                    </div>
                    {h.alreadyMember ? <span className={s.hitTakenLabel}>already a member</span> : <Icon name="list-add-user" size={16} color="var(--th-invite-result-icon)" />}
                  </div>
                </div>
              ))}
            </ScrollArea>
          )}
        </div>
        <div className={s.inviteFooter}>
          <span className={s.fill} />
          <Button flat text="Done" onClick={onClose} />
        </div>
      </div>
    </Popover>
  );
}

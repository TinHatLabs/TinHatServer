// InvitePopover.tsx — SSW invite popover: modal, centred, 440 px, padding 12, radius 14, panel, 1 px
// sep, shadow 18 px; "Invite to <space>", hint, then the add-people picker (2026-11-12 feat/people-search, the same one as
// room Invite and New DM: People you know, the user directory 250 ms debounced with stale answers dropped, a looked-up
// address; "already a member" dimmed). Enter invites the picked person and the field clears for the next; "Done".
import { useState } from "react";
import { Button, Heading, HintLabel, Popover, useIsMobile } from "@/ui";
import { PeoplePicker } from "@/features/people/PeoplePicker";
import { spaceActions, useSpaceAdmin } from "./store";
import { spaceWinRect } from "./winGeom";
import s from "./SpaceSettings.module.css";

export function InvitePopover({ onClose }: { onClose: () => void }) {
  const summary = useSpaceAdmin((st) => st.summary);
  const spaceId = useSpaceAdmin((st) => st.spaceId);
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
        <HintLabel>Search by name or username, or type someone's full address, like @name:their.server.</HintLabel>
        <div className={s.mt4}>
          <PeoplePicker
            verb="Invite"
            roomId={spaceId || null}
            onPick={(mxid) => {
              spaceActions.invite(mxid);
              return true;
            }}
          />
        </div>
        <div className={s.inviteFooter}>
          <span className={s.fill} />
          <Button flat text="Done" onClick={onClose} />
        </div>
      </div>
    </Popover>
  );
}

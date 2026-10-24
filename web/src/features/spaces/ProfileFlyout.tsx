// ProfileFlyout.tsx — Main.qml profileFlyout (the global user-profile popup): bus openUserProfile
// (timeline avatar click, member-row tap, "View profile" in Space settings). 320×300 modal popup
// centred on the window, padding 8, radius 8, panel fill, 1 px sep border, 16 px shadow; column
// (spacing 4): avatar 72 · name (defaultFont × 1.2, bold, tag colour else the sender hue) · mxid
// (small, dim, wrap anywhere) · RoleBadge (the space tag, else the Admin / Mod word) · "Direct
// message" GlowButton (→ open/create the DM, close). The column spreads over the full 300 px like
// the native ColumnLayout. Phones: a bottom sheet.
import { useState } from "react";
import { useBus } from "@/core/bus";
import { peekClient, useMember, useUserProfile } from "@/core/matrix";
import { Avatar, GlowButton, Popover, localpart, senderColor, useIsMobile } from "@/ui";
import { PresenceLine, usePresence } from "@/features/presence";
import { useContainer, useRolesState, powerLevelOf } from "./roles";
import { plLabel } from "./model";
import { RoleBadge } from "./RoleBadge";
import { openOrCreateDm } from "./roomActions";
import s from "./ProfileFlyout.module.css";

export function ProfileFlyout() {
  const [target, setTarget] = useState<{ userId: string; roomId?: string; n: number } | null>(null);
  useBus("openUserProfile", ({ userId, roomId }) => setTarget((t) => ({ userId, roomId, n: (t?.n ?? 0) + 1 })));
  if (!target) return null;
  return <Flyout key={target.n} userId={target.userId} roomId={target.roomId} onClose={() => setTarget(null)} />;
}

function Flyout({ userId, roomId, onClose }: { userId: string; roomId?: string; onClose: () => void }) {
  const member = useMember(roomId, userId);
  const profile = useUserProfile(member ? null : userId);
  const container = useContainer(roomId);
  const st = useRolesState(container);
  const joined = member?.membership === "join";
  const name = (member && member.rawName !== member.userId ? member.rawName : "") || profile.displayName || localpart(userId);
  const avatar = member?.avatarMxc ?? profile.avatarUrl ?? null;
  const tag = joined && st.active() ? st.tagRoleOf(userId) : null;
  // legacy role word from the room power level (only when they are a member of that room)
  const room = roomId ? peekClient()?.getRoom(roomId) : null;
  const word = member && joined ? plLabel(powerLevelOf(room, userId)) : member?.membership === "invite" ? "Invited" : member?.membership === "ban" ? "Banned" : "";
  const rn = tag ? tag.name : word;
  const rc = tag ? tag.color : "";
  const badgeName = rn === "Member" || rn === "Everyone" ? "" : rn;
  const badgeColor = rc || (rn === "Admin" ? "var(--th-roles-badge-admin-fg)" : "var(--th-roles-badge-mod-fg)");
  const mobile = useIsMobile();
  const present = !!usePresence(userId);
  return (
    <Popover open onClose={onClose} modal plain className={mobile ? undefined : s.flyout} aria-label={`Profile of ${name}`}>
      <div className={s.col}>
        <div className={s.cell}>
          <Avatar size={72} name={name || userId} seed={userId} imageSource={avatar} />
        </div>
        <div className={s.cell}>
          <div className={s.name} style={{ color: tag?.color || senderColor(userId) }}>
            {name}
          </div>
        </div>
        <div className={s.cell}>
          <div className={s.mxid}>{userId}</div>
        </div>
        {/* REACH §2.6 place 4: Online / Away / In a call (· room), led by the dot — nothing while absent */}
        {present && (
          <div className={s.cell}>
            <PresenceLine mxid={userId} />
          </div>
        )}
        {badgeName && (
          <div className={s.cell}>
            <RoleBadge name={badgeName} color={badgeColor} />
          </div>
        )}
        <div className={s.cell}>
          <GlowButton
            className={s.dm}
            text="Direct message"
            onClick={() => {
              void openOrCreateDm(userId);
              onClose();
            }}
          />
        </div>
      </div>
    </Popover>
  );
}

// features/spaces — Space settings (roles / RBAC, members, moderation, invites, rooms), the room's
// RightPanel (info, members, profile card), the global profile flyout, RoleBadge + space tags, and
// the RBAC model (roles_model.rs port) every permission-gated UI reads.
//
// Shell contract:
//   RightPanel  room info / members (RightPanel.qml) — docks beside the conversation when the room
//               page is ≥ 844 px wide, else overlays it; open state = useRightPanelOpen() /
//               toggleRightPanel() (also bus openRightPanel {roomId, tab: "info"|"members"|"toggle"}
//               and closeRightPanel). Phones: a full-screen sheet.
// Roles contract (chat sender names, nav participant bubbles, call tiles, member lists):
//   useMemberRole(roomId, userId) → RoleTag | null   (the member's space tag: highest CUSTOM role)
//   <RoleBadge roomId userId compact? />             (the tag chip; or name/color for a raw chip)
//   useEffectivePerms(roomId, mxid?) → {rank, perms, rolesActive, container}  (both RBAC modes)
//   useRoleTags(roomId) → Map<mxid, {roleId,name,color}>
// Activity / status (nav rows, callui game chip, RightPanel):
//   useRoomActivity / setActivity / useRoomStatuses / useMyStatus / postStatus
// Space moderation for the call participant menu: kickIn / banIn (+ r.memberMenu entries here).
// Space settings: openSpaceSettings(spaceId, tab) (bus openSpaceSettings works too).
import type { FeatureModule } from "@/core/registry";
import { bus } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { useMemberRoleImpl, type RoleTag } from "./roles";
import { closeRightPanel, openRightPanel, toggleRightPanel } from "./panelState";
import { installSpaceSettingsBus, openSpaceSettingsIntent, SPACE_SETTINGS_WINDOW } from "./intents";
import { SpaceSettingsWindow, spaceSettingsTitle } from "./SpaceSettingsWindow";
import { ProfileFlyout } from "./ProfileFlyout";
import { ConfirmHost } from "./confirmHost";
import { registerMemberMenu } from "./memberMenu";
import { closeSpace } from "./store";
import { resetInvites } from "./invites";
import { useNavStore } from "@/features/nav";
import { setPermsProvider } from "@/features/calls";
import { effectivePerms } from "./roles";
import { InvitesPane } from "./InvitesPane";

export { RightPanel, rightPanelIsOverlay, type RightPanelProps } from "./RightPanel";
export { RoleBadge, type RoleBadgeProps } from "./RoleBadge";
export type { RoleTag } from "./roles";
export { useRightPanelOpen, toggleRightPanel, openRightPanel, closeRightPanel, useRightPanelStore } from "./panelState";
export {
  containerOf,
  useContainer,
  useRolesState,
  useEffectivePerms,
  effectivePerms,
  useRoleTags,
  roleBadgeFor,
  tagFor,
  powerLevelOf,
  type Perms,
  type TagInfo,
} from "./roles";
export * as rolesModel from "./model";
export {
  PERMISSIONS,
  MANAGED_EVENT_TYPES,
  derivePowerLevels,
  permsFromPowerLevels,
  defaultTemplate,
  migrateFromPowerLevels,
  stateKeyFor,
  mxidFromStateKey,
  newRoleId,
} from "./model";
export { useRoomActivity, setActivity, useRoomStatuses, useMyStatus, postStatus, type Activity, type UserStatus } from "./activity";
export { kickIn, banIn } from "./store";
export { openSpaceSettingsIntent as openSpaceSettings } from "./intents";
export { spaceOf, openOrCreateDm, fetchProfileCard } from "./roomActions";
export { ProfileFlyout } from "./ProfileFlyout";
export { ProfileCardPopup } from "./ProfileCard";
export { InvitesPane } from "./InvitesPane";
export {
  useInviteCodes,
  probeInvites,
  resetInvites,
  inviteSummary,
  inviteBlip,
  inviteMessage,
  type Invite,
} from "./invites";

/** The role that decides how `userId` is shown in `roomId` (walks to the room's space). null = plain member. */
export function useMemberRole(roomId: string | null | undefined, userId: string | null | undefined): RoleTag | null {
  return useMemberRoleImpl(roomId, userId);
}

export const feature: FeatureModule = {
  id: "spaces",
  setup(r) {
    r.windows.add({
      id: SPACE_SETTINGS_WINDOW,
      order: 50,
      title: spaceSettingsTitle,
      component: SpaceSettingsWindow,
      // native Window 1040×700 (min 880×600) is the CONTENT size; the AppWindow adds its 30 px title bar
      defaultSize: { width: 1040, height: 730 },
      minSize: { width: 880, height: 630 },
      singleton: true,
    });
    r.overlays.add({ id: "spaces-profile-flyout", order: 50, component: ProfileFlyout });
    r.overlays.add({ id: "spaces-confirm", order: 51, component: ConfirmHost });
    registerMemberMenu(r);
    // the call engine's moderation permissions come from the roles model (roles when the space has
    // them, else power levels) — call_ctl.rs asks roles.rs the same way
    setPermsProvider((roomId, mxid) => effectivePerms(roomId, mxid).perms);
    // Ctrl+Shift+, → settings of the active rail space. nav registers the same shortcut, app-menu row,
    // rail-menu row and room-list gear (all → bus openSpaceSettings → openSpaceSettingsIntent); ours
    // only step in when nav's are gone, so there is exactly one of each.
    r.shortcuts.add({
      id: "spaces-settings",
      action: "space.settings.open",
      order: 50,
      keys: "Ctrl+Shift+,",
      whenTyping: true,
      description: "Space settings",
      enabled: () => !!peekClient() && activeSpaceId().startsWith("!") && !r.shortcuts.list().some((x) => x.id !== "spaces-settings" && x.keys === "Ctrl+Shift+,"),
      run: () => openSpaceSettingsIntent(activeSpaceId(), "overview"),
    });
    // (the ☰ menu no longer lists Space settings — 2026-09-29: the room column header's gear, the rail's menu and Ctrl+Shift+, open it)
    installSpaceSettingsBus();
    bus.on("openRightPanel", ({ tab }) => {
      if (tab === "toggle") toggleRightPanel();
      else openRightPanel(tab === "info" ? "info" : tab === "members" ? "members" : undefined);
    });
    bus.on("closeRightPanel", () => closeRightPanel());
    // dev-only: the Invites pane in a window, for looking at it without an operator account (D18)
    if (import.meta.env.DEV)
      r.windows.add({ id: "spaces-invites-preview", order: 99, title: "Invites (preview)", component: InvitesPane, defaultSize: { width: 720, height: 560 } });
    // invite codes: features/settings owns the Invites pane AND its operator probe (D18) — probing
    // here too sent a second GET /api/admin/invites (a 403 for everyone else) on every sign-in
    bus.on("loggedOut", () => {
      closeSpace();
      closeRightPanel();
      resetInvites();
    });
  },
};

/** The active rail space (native root.mNavActiveSpace) = nav's store `activeKey` ("home", "people", … or a !space id). */
function activeSpaceId(): string {
  return useNavStore.getState().activeKey ?? "";
}

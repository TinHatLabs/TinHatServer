// features/safety — account safety (docs/ACCOUNT-SAFETY.md; the rules + words: core/safety.ts, shared with the desktop's
// safety.rs). Apple App Review 1.2 (report content, block people) + 5.1.1(v) (delete the account in the app); the phone
// apps show this web app, so every entry point works in the phone layout (44 px targets).
//   store.ts        the ignored list, sending a report, deleting the account; the dialogs' state
//   SafetyHost      the Ignore + Report dialogs (r.overlays)
//   sections.tsx    Settings → Privacy → Ignored people; Devices & security → Your account → Delete my account
//   PersonActions   "Ignore…" / "Stop ignoring" + "Report…" for the hard-coded person menus and the profile popups
// Entry points: every member menu (r.memberMenu: the call participant menu), the room / space member lists' menus, the
// profile flyout + card (a tap on a name or avatar — the phone's way in), the message menu ("Report…", r.messageMenu).
import type { FeatureModule, MemberMenuCtx, MessageMenuCtx } from "@/core/registry";
import { WORDS } from "@/core/safety";
import { bus } from "@/core/bus";
import { nameOf as nameIn } from "./PersonActions";
import { SafetyHost, applyIgnore } from "./SafetyHost";
import { isIgnored, me, useSafetyUi } from "./store";

export { IgnoredPeopleSection, DeleteAccountRow } from "./sections";
export { PersonMenuItems, PersonButtons, nameOf } from "./PersonActions";
export { useIgnored, isIgnored } from "./store";

export const feature: FeatureModule = {
  id: "safety",
  setup(r) {
    const offs: Array<() => void> = [];
    offs.push(r.overlays.add({ id: "safety-host", order: 90, component: SafetyHost }));
    // a sign-out closes the dialogs (the next account never inherits one)
    offs.push(bus.on("loggedOut", () => useSafetyUi.getState().close()));
    const other = (ctx: MemberMenuCtx) => !!ctx.userId && ctx.userId !== me();
    // after Message (10), before the call / space moderation rows (100+)
    offs.push(
      r.memberMenu.add({
        id: "safety-ignore",
        order: 20,
        label: (ctx) => (isIgnored(ctx.userId) ? WORDS.unignore : WORDS.ignore),
        icon: "dialog-cancel-symbolic",
        visible: other,
        run: (ctx) => {
          const name = nameIn(ctx.userId, ctx.roomId);
          if (isIgnored(ctx.userId)) void applyIgnore(ctx.userId, name, false);
          else useSafetyUi.getState().openIgnore(ctx.userId, name);
        },
      }),
    );
    offs.push(
      r.memberMenu.add({
        id: "safety-report",
        order: 30,
        label: WORDS.report,
        icon: "dialog-warning",
        visible: other,
        run: (ctx) => useSafetyUi.getState().openReport({ user: ctx.userId, room: ctx.roomId ?? "", event: "" }, nameIn(ctx.userId, ctx.roomId)),
      }),
    );
    // the message menu: after Delete (80), its own separator
    const sender = (ctx: MessageMenuCtx) => ctx.event.getSender() ?? "";
    offs.push(
      r.messageMenu.add({
        id: "safety-report-message",
        order: 90,
        separatorBefore: true,
        label: WORDS.report,
        icon: "dialog-warning",
        visible: (ctx) => !!ctx.event.getId() && !ctx.event.getId()!.startsWith("~") && !!sender(ctx) && sender(ctx) !== me(),
        run: (ctx) =>
          useSafetyUi.getState().openReport({ user: sender(ctx), room: ctx.roomId, event: ctx.event.getId() ?? "" }, nameIn(sender(ctx), ctx.roomId)),
      }),
    );
    return () => offs.forEach((o) => o());
  },
};

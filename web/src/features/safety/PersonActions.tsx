// PersonActions.tsx — "Ignore…" / "Stop ignoring" and "Report…" for a person, in the two shapes the hosts need:
//   PersonMenuItems  menu rows (the room member list's menu, Space settings → Members, Who's around)
//   PersonButtons    a button row (the profile flyout and the profile card: a tap on a name or avatar — on a phone the
//                    first place people look). 44 px targets on phones.
// Nothing for myself. The desktop's Main.qml profileFlyout / RightPanel.qml menus carry the same two, in this order.
import { BasicButton, MenuItem, cx, localpart, useIsMobile } from "@/ui";
import { peekClient } from "@/core/matrix";
import { WORDS } from "@/core/safety";
import { applyIgnore } from "./SafetyHost";
import { me, useIgnored, useSafetyUi } from "./store";
import s from "./safety.module.css";

export function nameOf(mxid: string, roomId?: string): string {
  const m = roomId ? peekClient()?.getRoom(roomId)?.getMember(mxid) : null;
  const dn = m?.rawDisplayName;
  return dn && dn !== mxid ? dn : localpart(mxid) || mxid;
}

function useActions(mxid: string, roomId: string | undefined, name: string | undefined, onDone?: () => void) {
  const ignored = useIgnored().includes(mxid);
  const n = name || nameOf(mxid, roomId);
  return {
    show: !!mxid && mxid !== me(),
    ignored,
    ignore: () => {
      onDone?.();
      if (ignored) void applyIgnore(mxid, n, false);
      else useSafetyUi.getState().openIgnore(mxid, n);
    },
    report: () => {
      onDone?.();
      useSafetyUi.getState().openReport({ user: mxid, room: roomId ?? "", event: "" }, n);
    },
  };
}

export function PersonMenuItems({ mxid, roomId, name }: { mxid: string; roomId?: string; name?: string }) {
  const a = useActions(mxid, roomId, name);
  if (!a.show) return null;
  return (
    <>
      <MenuItem text={a.ignored ? WORDS.unignore : WORDS.ignore} icon="dialog-cancel-symbolic" onTriggered={a.ignore} />
      <MenuItem text={WORDS.report} icon="dialog-warning" onTriggered={a.report} />
    </>
  );
}

export function PersonButtons({ mxid, roomId, name, onDone, className }: { mxid: string; roomId?: string; name?: string; onDone?: () => void; className?: string }) {
  const a = useActions(mxid, roomId, name, onDone);
  const phone = useIsMobile();
  if (!a.show) return null;
  return (
    <div className={cx(s.actions, className)} data-safety="person">
      <BasicButton className={phone ? s.tap : undefined} text={a.ignored ? WORDS.unignore : WORDS.ignore} icon="dialog-cancel-symbolic" onClick={a.ignore} />
      <BasicButton className={phone ? s.tap : undefined} text={WORDS.report} icon="dialog-warning" onClick={a.report} />
    </div>
  );
}

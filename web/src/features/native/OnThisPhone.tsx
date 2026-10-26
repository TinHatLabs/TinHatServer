// OnThisPhone.tsx — "You're in this call on this phone" (bridge 2, docs/NATIVE-APPS.md). Wraps a room's Join entry
// point: while the app's native call is on in THAT room it is drawn instead of the entry point, with Open
// (→ tinhatNative.showCall()) and Leave (→ tinhatNative.leaveCall()); otherwise the wrapped entry point renders as it
// is. Outside an app with the "calls" cap it always renders its children unchanged (no listener, no extra element).
//   <OnThisPhone roomId={id}><JoinBanner roomId={id} /></OnThisPhone>               the banner (room header)
//   <OnThisPhone roomId={id} inline buttonClass={s.join}><JoinButton /></OnThisPhone> a widget row's compact form
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Button, GlowButton } from "@/ui";
import { nativeCalls } from "./bridge";
import { nativeCall, onNativeCall, phoneBanner, type NativeCall } from "./callState";
import s from "./OnThisPhone.module.css";

const subscribe = (cb: () => void) => onNativeCall(() => cb());
const none = () => null;

/** React: the native call (null outside an app with calls, or while the phone isn't in a call). */
export function useNativeCall(): NativeCall | null {
  return useSyncExternalStore(subscribe, nativeCall, none);
}

export function OnThisPhone({ roomId, inline, buttonClass, children }: { roomId: string; inline?: boolean; buttonClass?: string; children?: ReactNode }) {
  const call = useNativeCall();
  const view = phoneBanner(call, roomId);
  if (!call || !view) return <>{children}</>;
  // a widget row is itself a button (opens the room): the row's own click stays out of these
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    nativeCalls.show();
  };
  const leave = (e: MouseEvent) => {
    e.stopPropagation();
    nativeCalls.leave();
  };
  if (inline) {
    return (
      <span className={s.inline} data-native-call={call.state}>
        <span className={s.inlineText}>On this phone</span>
        <Button className={buttonClass} highlighted text="Open" onClick={open} />
        <Button className={buttonClass} flat text="Leave" disabled={!view.canLeave} onClick={leave} />
      </span>
    );
  }
  return (
    <div className={s.banner} data-testid="native-call-banner" data-native-call={call.state} role="status">
      <span className={s.text}>{view.text}</span>
      <Button className={s.btn} flat text="Leave" disabled={!view.canLeave} onClick={leave} />
      <GlowButton className={s.btn} text="Open" onClick={open} />
    </div>
  );
}

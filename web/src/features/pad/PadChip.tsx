// PadChip.tsx — on the device IN the call (DESIGN §1 "On the receiver", security rule 8 "Visible"): while any Pad
// session is live, the call bar shows "📱 Pad · <device> ×" — × ends that device's Pad and refuses it for the rest of
// this call. Desktop: a chip in the call's status strip (r.callStatusPills); phones: in the call screen's top bar
// (the "statusRight" call-bar slot, beside Rec / Clip).
import { useRef } from "react";
import { Icon, cx, useIsMobile, useTip } from "@/ui";
import { refusePadDevice, useDeviceName, usePadReceiver } from "./runtime";
import s from "./PadChip.module.css";

function Chip({ device, mobile }: { device: string; mobile: boolean }) {
  const name = useDeviceName(device);
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, `${name} is controlling this call with Pad (sounds, mute, volumes). × disconnects it for this call.`, { delay: 300 });
  return (
    <span ref={ref} className={cx(s.chip, mobile && s.mobile)} data-testid="pad-chip" data-device={device}>
      <span aria-hidden>📱</span>
      <span className={s.text}>
        Pad · <b>{name}</b>
      </span>
      <button type="button" className={s.x} aria-label={`Disconnect the Pad on ${name} for this call`} onClick={() => refusePadDevice(device)} data-testid="pad-chip-x">
        <Icon name="window-close-symbolic" size={mobile ? 14 : 12} color="var(--th-pad-chip-fg)" />
      </button>
    </span>
  );
}

/** One chip per controlling device (usually one). */
function PadChips({ mobile }: { mobile: boolean }) {
  const sessions = usePadReceiver((x) => x.sessions);
  const devices = [...new Set(sessions.map((x) => x.device))];
  if (!devices.length) return null;
  return (
    <>
      {devices.map((d) => (
        <Chip key={d} device={d} mobile={mobile} />
      ))}
    </>
  );
}

/** r.callStatusPills (the desktop status strip). */
export function PadStatusPill() {
  const mobile = useIsMobile();
  return mobile ? null : <PadChips mobile={false} />;
}

/** r.callBarItems slot "statusRight" — rendered in the phone call's top bar (the desktop has the pill above). */
export function PadTopBarChip() {
  const mobile = useIsMobile();
  return mobile ? <PadChips mobile /> : null;
}

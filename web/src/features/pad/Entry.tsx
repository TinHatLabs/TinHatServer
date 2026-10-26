// Entry.tsx — where Pad appears (DESIGN §1 "Where Pad appears"): next to every Join where one of my OTHER devices is in
// that call — the room's call banner (chat RoomPage CallBanner, callui JoinBanner), the Who's around widget, and the bar
// at the top of the room list "You're in <room>'s call on <device> · Pad · Join". Greyed with its one line when it can't
// work: "Verify this device to use Pad." (→ Devices & security), "Verify <device> to use Pad.", "Update Tin Hat on
// <device> to use Pad." (no `pad1` cap: an older Tin Hat, another client, or Pad turned off there).
import { openRoom, openSettings, startCall, toast } from "@/core/bus";
import { useRoomName } from "@/core/matrix";
import { Button, GlowButton, cx, useIsMobile } from "@/ui";
import { whyText, type PadTarget } from "@/features/calls/pad/rules";
import { deviceName, openPad, useDeviceName, useMyCallsElsewhere, usePadDevices } from "./runtime";
import s from "./Entry.module.css";

/** The first ready target, else the first one (its `why` greys the button). */
export function pickTarget(targets: PadTarget[]): PadTarget | null {
  return targets.find((t) => t.ready) ?? targets[0] ?? null;
}

/** The reason a Pad can't work for this target ("" = it can). */
export function padReason(t: PadTarget | null): string {
  if (!t || t.ready) return "";
  return whyText(t.why, deviceName(t.device));
}

/** "You're in this call on Desktop PC — Sam is there too" (others = everyone else's names, me excluded). */
export function padCallText(device: string, others: string[]): string {
  const head = `You're in this call on ${device}`;
  if (others.length === 0) return head;
  if (others.length === 1) return `${head} — ${others[0]} is there too`;
  if (others.length === 2) return `${head} — ${others[0]} and ${others[1]} are there too`;
  if (others.length === 3) return `${head} — ${others[0]}, ${others[1]} and ${others[2]} are there too`;
  return `${head} — ${others[0]}, ${others[1]} and ${others.length - 2} others are there too`;
}

/** A press on Pad — the button beside Join and the action `call.pad.open` (Ctrl+K, a button, a key) run this: the Pad
 *  on the target pickTarget chooses; a greyed one shows its one line instead (phones have no tooltips), and "Verify this
 *  device" leads to Devices & security. The desktop's twin: Main.qml openPad(room, padTargetIn(room)). */
export function pressPad(roomId: string, targets: PadTarget[]): void {
  const t = pickTarget(targets);
  if (!t) return;
  if (t.ready) {
    openPad(roomId, t.device);
    return;
  }
  toast(padReason(t), { timeoutMs: 4000, ...(t.why === "unverified" ? { action: { label: "Devices & security", run: () => openSettings("security") } } : {}) });
}

/** The "Pad" button for a call that one of my other devices is in. `targets` from usePadTargets(room). */
export function PadButton({ roomId, targets, compact, className }: { roomId: string; targets: PadTarget[]; compact?: boolean; className?: string }) {
  usePadDevices((x) => x.rev);
  const t = pickTarget(targets);
  const reason = padReason(t);
  const dev = t ? deviceName(t.device) : "";
  if (!t) return null;
  return (
    <Button
      text="Pad"
      icon="smartphone-symbolic"
      tip={reason || `Control the call on ${dev} from here — sounds, mute, volumes`}
      className={cx(s.padBtn, compact && s.compact, !t.ready && s.greyed, className)}
      aria-label={reason ? `Pad — ${reason}` : `Pad — control the call on ${dev}`}
      data-testid="pad-button"
      data-pad-why={t.why}
      onClick={(e) => {
        e.stopPropagation();
        pressPad(roomId, targets);
      }}
    />
  );
}

/** The greyed button's one line, for layouts without tooltips (phones) and the room-list bar. */
export function PadReasonLine({ targets }: { targets: PadTarget[] }) {
  usePadDevices((x) => x.rev);
  const reason = padReason(pickTarget(targets));
  if (!reason) return null;
  return <div className={s.reason}>{reason}</div>;
}

/** The bar at the top of the room list: "You're in <room>'s call on <device> · Pad · Join" (the newest such call). */
export function PadRoomListBar() {
  const calls = useMyCallsElsewhere();
  const mobile = useIsMobile();
  const first = calls[0];
  const t = first ? pickTarget(first.targets) : null;
  const roomName = useRoomName(first?.room ?? null);
  const dev = useDeviceName(t?.device ?? "");
  if (!first || !t) return null;
  return (
    <div className={cx(s.bar, mobile && s.barMobile)} data-testid="pad-room-list-bar">
      <button type="button" className={s.barText} onClick={() => openRoom(first.room)} title={`Open ${roomName}`}>
        You're in <b>{roomName || "a room"}</b>'s call on <b>{dev}</b>
      </button>
      <div className={s.barButtons}>
        <PadButton roomId={first.room} targets={first.targets} compact />
        <GlowButton text="Join" onClick={() => startCall(first.room)} />
      </div>
      {mobile && <PadReasonLine targets={first.targets} />}
    </div>
  );
}

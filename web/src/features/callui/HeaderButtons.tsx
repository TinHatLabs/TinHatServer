// HeaderButtons.tsx — the room header's call entry points (RoomHeaderBar.qml:227-248), for chat's
// RoomHeaderBar to place (CUI-150/151):
//   CallHeaderButton  call-start-symbolic: "Start a call" / "Join the active call" (accentBright while the
//                     room's call is live) / "Connecting…" (disabled); hidden while we are in a call.
//   CallHeaderGear    configure-symbolic "Call & device settings" → the devices menu at the button.
import { HeaderIconButton } from "@/ui";
import { act, useC } from "./store";
import { useCallParticipants } from "./Incoming";
import { openCallDevicesMenu } from "./Effects";

export function CallHeaderButton({ roomId }: { roomId: string }) {
  const inCall = useC("inCall");
  const connecting = useC("connecting");
  const fake = useC("fake");
  const live = useCallParticipants(roomId).length > 0;
  // RoomHeaderBar.qml:230 + Main.qml:5231 — hidden while in any call (the call bar owns the controls).
  if (inCall || fake) return null;
  const busy = connecting;
  return (
    <HeaderIconButton
      iconName="call-start-symbolic"
      accent={live}
      disabled={busy}
      tip={busy ? "Connecting…" : live ? "Join the active call" : "Start a call"}
      onClick={() => act("joinCall")(roomId)}
      data-testid="header-call-button"
    />
  );
}

export function CallHeaderGear({ roomId }: { roomId: string }) {
  return (
    <HeaderIconButton
      iconName="configure-symbolic"
      tip="Call & device settings"
      onClick={(e) => openCallDevicesMenu(e.currentTarget, roomId)}
      data-testid="header-call-gear"
    />
  );
}

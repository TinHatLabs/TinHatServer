// CopyLink.tsx — "Copy guest link" in the Guests room's menu (r.roomMenu) and header (r.roomHeaderActions) (launch-gate's
// guests QoL, 2026-10-27: the guest link was looked for in the room menu and found only the matrix.to invite link).
// Shown exactly where the bar under the header offers Copy (model.copyOffered); the click is the bar's copyGuestLink.
// Desktop twin: Main.qml's room menu row + RoomHeaderBar's button (GuestsController.copyOffered).
import { getSession, getState, useRoomState, useSession } from "@/core/matrix";
import { HeaderIconButton } from "@/ui";
import { serverOf } from "@/features/nav/dmTarget";
import { GUESTS_TYPE, WORDS, copyOffered, isGuestsRoom, localRole, mergeRole, parseGuestState, type GuestsDoc } from "./model";
import { copyGuestLink, guestRoomOffered, useGuestRoomOffered, useGuests } from "./store";

interface Inputs {
  roomId: string;
  me: string;
  offered: boolean;
  doc: GuestsDoc | null;
  guestState: unknown;
  alias: unknown;
  membership: unknown;
  powerLevels: unknown;
}

function offeredFrom(i: Inputs): boolean {
  if (!i.offered) return false;
  const docRoom = i.doc?.room ?? null;
  if (!isGuestsRoom({ roomId: i.roomId, docRoom, hasGuestState: !!i.guestState, canonicalAlias: typeof i.alias === "string" ? i.alias : null, server: serverOf(i.me) })) return false;
  const on = parseGuestState(i.guestState)?.on ?? i.doc?.on ?? false;
  const role = mergeRole(localRole({ userId: i.me, membership: typeof i.membership === "string" ? i.membership : null, powerLevels: i.powerLevels }), i.doc && i.doc.room === i.roomId ? i.doc : null);
  return copyOffered(on, role);
}

/** The room menu's predicate (read at the moment the menu opens). */
export function guestLinkOffered(roomId: string): boolean {
  const me = getSession().userId ?? "";
  return offeredFrom({
    roomId,
    me,
    offered: guestRoomOffered(),
    doc: useGuests.getState().doc,
    guestState: getState(roomId, GUESTS_TYPE),
    alias: getState(roomId, "m.room.canonical_alias")?.alias,
    membership: getState(roomId, "m.room.member", me)?.membership,
    powerLevels: getState(roomId, "m.room.power_levels"),
  });
}

/** The header's button: link-symbolic, tip "Copy guest link"; nothing outside the Guests room. */
export function GuestLinkHeaderButton({ roomId }: { roomId: string }) {
  const me = useSession().userId ?? "";
  const shown = offeredFrom({
    roomId,
    me,
    offered: useGuestRoomOffered(),
    doc: useGuests((st) => st.doc),
    guestState: useRoomState(roomId, GUESTS_TYPE),
    alias: useRoomState(roomId, "m.room.canonical_alias")?.alias,
    membership: useRoomState(roomId, "m.room.member", me)?.membership,
    powerLevels: useRoomState(roomId, "m.room.power_levels"),
  });
  if (!shown) return null;
  return <HeaderIconButton iconName="link-symbolic" tip={WORDS.copy} onClick={() => void copyGuestLink()} data-guests-header="copy" />;
}

// features/push — REACH §3 (web only): push notifications on phones and closed browsers, the app badge, the
// "at a computer" activity pings, and the in-page notifications' worker path (core/notes.ts).
//
//   client.ts      the worker (public/push-sw.js), the on/off transaction, the start-up check, sign-out, badge
//   active.ts      §3.4/A2.12 activity pings (instance id, quiet-wanted consent, phone = own pushkey only)
//   wire.ts        pure helpers (pushkey, key decoding, pusher bodies, the Settings block's detection order)
//   ThisDevice.tsx Settings → Notifications → "This device"
import type { FeatureModule } from "@/core/registry";
import { closeAllNotes, closeNotes, showNote } from "@/core/notes";
import { audioSessionType, isPreviewing, playClip, playUiSound, previewSound, soundsDebug, startRing, stopClip, stopRing } from "@/core/sounds";
import { useNavStore } from "@/features/nav";
import { disablePush, enablePush, installPush, updateBadge, usePushStore, workerReady } from "./client";
import type { RoomRow } from "@/features/nav";
import { activityDebug, installActivity } from "./active";

export { ThisDeviceSection } from "./ThisDevice";
export { useNotifyCardVisible, askNotificationPermission, snoozeNotifyAsk, PERMISSION_QUESTION } from "./PermissionCard";
export { usePushStore, enablePush, disablePush, sendTest, setQuiet } from "./client";

export const feature: FeatureModule = {
  id: "push",
  setup() {
    installPush();
    installActivity();
    // A5.10: the badge = rooms whose adjusted unread is > 0 + pending DM invites (spaces never), the same set
    // the worker reads for its count while the page is away
    const idsOf = (rows: RoomRow[]) => rows.filter((r) => !r.isSpace && ((r.membership === "join" && r.unread > 0) || (r.membership === "invite" && r.dm))).map((r) => r.id);
    updateBadge(idsOf(useNavStore.getState().globalRooms));
    useNavStore.subscribe((st, prev) => {
      if (st.globalRooms !== prev.globalRooms) updateBadge(idsOf(st.globalRooms));
    });
    if (import.meta.env.DEV || (window as unknown as { __TW_DEBUG__?: boolean }).__TW_DEBUG__)
      (window as unknown as { __twPush?: unknown }).__twPush = {
        usePushStore,
        workerReady,
        enablePush,
        disablePush,
        activityDebug,
        showNote,
        closeNotes,
        closeAllNotes,
        sounds: { soundsDebug, playUiSound, previewSound, isPreviewing, startRing, stopRing, audioSessionType, playClip, stopClip },
      };
  },
};

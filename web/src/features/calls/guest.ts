// guest.ts — the guest hand-off (CALL-134; docs/GUESTS.md). A guest page sends the browser to
//   #/guest-session?hs=<hs>&user=<mxid>&token=<access>&device=<dev>&room=<roomId>
// — the guest room's page (a Tin Hat Server's /call/?g=<key>: someone let the guest in; `room` = the Guests room). We
// adopt that session (only when this browser has no other Tin Hat session — never clobber a real account), replace
// the hash with the room route (the token must not stay in history), and once the client is ready join the room if
// needed and open it. The call: the Guests room's only when one is on (features/guests model.handoffJoinsCall), any
// other room's as before.
import { bus, openRoom, toast } from "@/core/bus";
import { SESSION_KEY, getState, peekClient } from "@/core/matrix";
import { homeserverAllowed } from "@/core/bearer";
import { createLogger } from "@/core/log";
import { navigate, roomHash } from "@/app/router";
import { GUESTS_TYPE, handoffJoinsCall } from "@/features/guests/model";
import { joinCall } from "./engine";
import { callActive } from "./rtc";
import { errText, sleep } from "./util";

const log = createLogger("call-guest");

export function adoptGuestHandoff(): void {
  if (typeof location === "undefined") return;
  const m = /^#\/guest-session\?(.*)$/.exec(location.hash);
  if (!m) return;
  const q = new URLSearchParams(m[1]);
  const hs = (q.get("hs") ?? "").replace(/\/+$/, "");
  const user = q.get("user") ?? "";
  const token = q.get("token") ?? "";
  const device = q.get("device") ?? "";
  const room = q.get("room") ?? "";
  // The token never stays in the address bar / history — and the router follows the new hash at once (a bare
  // history.replaceState left its route on the hand-off's, so the room stayed unselected).
  navigate(room ? roomHash(room) : { name: "home" }, { replace: true });
  if (!/^https:\/\//.test(hs) || !/^@[^:]+:.+/.test(user) || !token || !device) {
    log.warn("guest hand-off: incomplete parameters — ignored");
    return;
  }
  if (!homeserverAllowed(hs)) {
    log.warn(`guest hand-off: homeserver ${hs} is not allowed — ignored`);
    return;
  }
  let other = false;
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as { userId?: string; deviceId?: string } | null;
    other = !!saved && !(saved.userId === user && saved.deviceId === device);
  } catch {
    other = false;
  }
  if (other) {
    // Refused: the real account stays signed in and NOTHING else happens — no room join, no call
    // (Astra finding 7: a crafted guest link used to make the real account join its room + call).
    log.warn("guest hand-off: this browser already has a Tin Hat session — keeping it");
    bus.once("sessionReady", () => toast("You're already signed in here — open the guest link in a private window to join as a guest"));
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify({ hsUrl: hs, userId: user, deviceId: device, accessToken: token }));
  log.info(`guest hand-off: adopted ${user} / ${device}`);
  if (!room) return;
  bus.once("sessionReady", ({ userId, deviceId }) => {
    // Only the exact session this hand-off adopted auto-joins.
    if (userId !== user || deviceId !== device) return;
    void (async () => {
      const c = peekClient();
      if (!c || c.getUserId() !== user || c.getDeviceId() !== device) return;
      try {
        if (c.getRoom(room)?.getMyMembership() !== "join") await c.joinRoom(room);
      } catch (e) {
        log.warn(`guest hand-off: join ${room}: ${errText(e)}`);
      }
      for (let i = 0; i < 40 && c.getRoom(room)?.getMyMembership() !== "join"; i++) await sleep(250);
      // Still the adopted guest session after those awaits? (a sign-in / takeover meanwhile must not
      // make ANOTHER account join this call)
      const now = peekClient();
      if (now !== c || now.getUserId() !== user || now.getDeviceId() !== device) return;
      openRoom(room);
      const guestsRoom = !!getState(room, GUESTS_TYPE, "");
      const callLive = callActive(room);
      log.info(`guest hand-off: in ${guestsRoom ? "the Guests room" : "a guest-link room"}; call ${callLive ? "on" : "off"}`);
      if (handoffJoinsCall({ guestsRoom, callLive })) joinCall(room);
    })();
  });
}

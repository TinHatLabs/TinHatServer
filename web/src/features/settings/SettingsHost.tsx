// SettingsHost.tsx — the always-mounted half of Settings (the shell mounts it as `SettingsSheet`, ARCHITECTURE "Shell"):
// the bus entry points. The window itself is the registered in-app window "settings" (SettingsWindow.tsx), rendered by
// the WindowHost; this component only opens / raises / closes it.
//   openSettings { paneId? }   → the window on that pane (old key `sessions` = Devices & security)
//   openAbout                  → the window on About & help (the About sheet is gone, SETTINGS-WINDOW.md §5)
//   openThemeGallery           → Appearance with the theme gallery (THEMES-UI §12)
//   editCurrentTheme           → Appearance's Customize… (THEMES-UI §12 amendment)
//   closeSettings / loggedOut  → closed
//   a room opened (phone layout) → closed: there Settings covers the whole screen, so a notification tap (the push
//                                worker's click → openRoom, or the phone app's `#/room/…` link: onOutsideRoomLink, a
//                                new route) must bring the room to the front (the desktop app raises its main window
//                                over Settings)
import { useEffect, useRef } from "react";
import { toast, useBus } from "@/core/bus";
import { useFormFactor } from "@/core/device";
import { getSession, onSessionEnding, useSession } from "@/core/matrix";
import { onOutsideRoomLink, useRoute } from "@/app/router";
import { closeSettings, openSettingsAt, openThemeGallery, useSettingsUi } from "./store";

/** Bumped the moment a session starts ending (sign-out, takeover): an action begun in it never lands after that. */
let sessionGen = 0;
onSessionEnding(() => {
  sessionGen++;
});

export function SettingsHost() {
  const session = useSession();
  const signedIn = session.state === "ready" || session.state === "syncing";

  useBus("openSettings", ({ paneId }) => {
    if (signedIn) openSettingsAt(paneId);
  });
  useBus("openAbout", () => {
    if (signedIn) openSettingsAt("about");
  });
  // the ☰ Theme menu's "More themes…" (THEMES-UI §12)
  useBus("openThemeGallery", () => {
    if (signedIn) openThemeGallery();
  });
  // the ☰ Theme menu's "Edit current theme…" (THEMES-UI §12 amendment 2026-09-28): Appearance's Customize…
  useBus("editCurrentTheme", () => {
    // the Appearance pane is its own chunk (web-perf): normally already fetched after sign-in, else a moment's wait —
    // and only for the session that asked (signed out / another account meanwhile = dropped)
    if (!signedIn) return;
    const gen = sessionGen;
    const same = () => gen === sessionGen && (getSession().state === "ready" || getSession().state === "syncing");
    void import("./panes/AppearancePane")
      .then((m) => same() && m.editCurrentTheme())
      .catch((e: unknown) => same() && toast(`Couldn't open the theme editor: ${(e as Error)?.message ?? e}`));
  });
  useBus("closeSettings", () => closeSettings());
  useBus("loggedOut", () => closeSettings());

  // the phone layout: a room opened while Settings is up comes to the front (also the room already open behind it)
  const mobile = useFormFactor() === "mobile";
  const roomUp = () => {
    if (mobile && useSettingsUi.getState().open) closeSettings();
  };
  useBus("openRoom", roomUp);
  const roomUpRef = useRef(roomUp);
  roomUpRef.current = roomUp;
  // the phone app's #/room/… link into the open page — also the URL that is already open (no route change then)
  useEffect(() => onOutsideRoomLink(() => roomUpRef.current()), []);
  const route = useRoute();
  const roomKey = route.name === "room" ? `${route.target}/${route.eventId ?? ""}` : "";
  const lastKey = useRef(roomKey);
  useEffect(() => {
    if (roomKey === lastKey.current) return;
    lastKey.current = roomKey;
    if (roomKey) roomUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey]);
  return null;
}

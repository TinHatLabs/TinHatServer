// sheets.tsx — the nav-hosted OverlaySheets: "What's new in v<ver>" (NAV-12, qml/Main.qml:2163-2174)
// opened from the update banner / About, and a fallback About sheet (NAV-80, Main.qml:2041-2135 —
// the settings feature owns the real one as SET-102 and answers bus `openAbout`; this one only shows
// when nobody listens). Also the quit-during-a-call guard (NAV-05 → `beforeunload`, §5).
import { webAppUrl } from "@/core/api";
import { SERVER_LABEL } from "@/core/bearer";
import { useEffect } from "react";
import { create } from "zustand";
import { useSession } from "@/core/matrix";
import { useBus } from "@/core/bus";
import { navigate } from "@/app/router";
import { GlowButton, Heading, OverlaySheet } from "@/ui";
import { useCall } from "@/features/calls";
import { checkForUpdates, useUpdate } from "./update";
import s from "./dialogs.module.css";

/** web build id (the deploy writes VITE_BUILD_HASH; dev = "dev") */
export const BUILD_HASH: string = (import.meta.env.VITE_BUILD_HASH as string | undefined) ?? (import.meta.env.DEV ? "dev" : "web");
/** the release version (package.json, via vite.config.ts) */
export const APP_VERSION: string = (import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev";

const useSheets = create<{ sheet: "" | "whatsNew" | "about"; version?: string; notes?: string }>()(() => ({ sheet: "" }));
/** The ONE What's-new sheet (INTEGRATION #3): the update banner calls this, anyone else emits bus
 *  `openWhatsNew` (optionally with the version / notes to show; default = the waiting build). */
export const openWhatsNew = (p: { version?: string; notes?: string } = {}) => useSheets.setState({ sheet: "whatsNew", version: p.version, notes: p.notes });
export const openAboutFallback = () => useSheets.setState({ sheet: "about" });
const close = () => useSheets.setState({ sheet: "" });

export function NavSheets() {
  const sheet = useSheets((st) => st.sheet);
  useBus("loggedOut", () => {
    close();
    // NAV-08: the sign-in card must not sit on the previous account's #/room/<id> (a shared browser
    // would show the next account that room id, and open its page after sign-in) — back to Home
    navigate({ name: "home" }, { replace: true });
  });
  useBus("openWhatsNew", (p) => openWhatsNew(p ?? {}));
  if (sheet === "whatsNew") return <WhatsNewSheet />;
  if (sheet === "about") return <AboutSheet />;
  return null;
}

function WhatsNewSheet() {
  const u = useUpdate();
  const { version, notes } = useSheets();
  return (
    <OverlaySheet open onClose={close} title={`What's new in v${version || u.next || u.current || APP_VERSION}`} preferredWidth={396}>
      <div className={s.notes}>{(notes ?? u.notes).trim() || "No release notes provided."}</div>
    </OverlaySheet>
  );
}

/** The update row's status text (native mUpdateStatus → web semantics). */
export function updateStatusText(u: ReturnType<typeof useUpdate.getState>): string {
  if (u.checking) return "Checking for updates…";
  if (u.available) return `Update available: v${u.current || APP_VERSION} → v${u.next} — reload to get it.`;
  if (u.checkedAt) return "You're on the newest Tin Hat Web.";
  return "Updates are checked on startup.";
}

function AboutSheet() {
  const u = useUpdate();
  const me = useSession().userId ?? "";
  return (
    <OverlaySheet open onClose={close} title="About Tin Hat" preferredWidth={396}>
      <div className={s.about}>
        <div className={s.aboutHead}>
          <Heading level={2}>Tin Hat</Heading>
          <div className={s.dim}>Tin Hat Web · Matrix client in your browser</div>
          <div className={s.dimSmall}>
            Tin Hat Web {APP_VERSION} ({BUILD_HASH})
          </div>
        </div>
        <div>
          The Tin Hat client for {SERVER_LABEL}, running in your browser at {webAppUrl().replace(/^https:\/\/|\/$/g, "")} — same chat, calls, spaces and game nights
          as the desktop app, end-to-end encrypted.
        </div>
        <div className={s.dimSmall}>Signed in as {me}</div>
        <div className={s.aboutRow}>
          <div className={s.dimSmall} style={{ flex: 1 }}>
            {updateStatusText(u)}
          </div>
          <GlowButton
            text={u.available ? "Reload" : "Check"}
            disabled={u.checking}
            onClick={() => (u.available ? location.reload() : void checkForUpdates(true))}
          />
        </div>
      </div>
    </OverlaySheet>
  );
}

/** NAV-05: closing the tab during a call asks first (the browser's generic "Leave site?" prompt). */
export function QuitGuard() {
  const inCall = useCall((c) => !!c.joined);
  useEffect(() => {
    if (!inCall) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [inCall]);
  return null;
}

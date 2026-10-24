// App.tsx — boot → sign-in → shell (Main.qml + StartupWindow.qml + LoginView.qml).
//
// Launch: the "Starting Tin Hat" card narrates the boot like the native StartupWindow — the
// static copy in index.html paints before any JS ("Starting up", 5 %), then: Loading the
// interface 40 → Restoring your session 55 → Loading your rooms 80 (the user id) → Catching up on
// messages 90 → Ready (fades out over the shell), or Please sign in 95 → the sign-in card. The card
// only exists at launch; after an interactive sign-in the shell shows straight away (native: the
// main window is already up). Another tab owning the session (Web Lock) is offered a take-over.
// App-wide environment: Reduce motion (pref "reduce-motion"), form factor
// (<html data-ff data-touch>), the on-screen keyboard inset (--th-vv-bottom), tooltips, toasts.
import { useEffect, useRef, useState } from "react";
import { restoreSession, takeOverSession, useSession, type SessionInfo } from "@/core/matrix";
import { onPrefChange, getPref } from "@/core/prefs";
import { useFormFactor, useIsTouch } from "@/core/device";
import { installShortcuts } from "@/core/shortcuts";
import { applyReducedMotion, CrashProbe, GlowButton, setFormFactorAttrs, ToastHost, TooltipHost } from "@/ui";
import { Startup } from "./Startup";
import { LoginView } from "./LoginView";
import { Shell } from "./Shell";
import { Gallery } from "./Gallery";
import { useRoute } from "./router";

export function App() {
  useAppEnvironment();
  const route = useRoute();
  return (
    <>
      {route.name === "gallery" ? <Gallery section={route.section} /> : <Main />}
      <CrashProbe where="app" />
      <TooltipHost />
      <ToastHost />
    </>
  );
}

function stageOf(s: SessionInfo, catchingUp: boolean): { stage: string; detail?: string; percent: number } {
  switch (s.state) {
    case "booting":
      return { stage: "Loading the interface", percent: 40 };
    case "starting":
      return { stage: "Restoring your session", percent: 55 };
    case "syncing":
      return catchingUp ? { stage: "Catching up on messages", percent: 90 } : { stage: "Loading your rooms", detail: s.userId, percent: 80 };
    case "loggedOut":
      return { stage: "Please sign in", percent: 95 };
    case "ready":
      return { stage: "Ready", percent: 100 };
    default:
      return { stage: "Starting up", percent: 5 };
  }
}

function Main() {
  const session = useSession();
  const [launching, setLaunching] = useState(true); // the startup card phase
  const [cardGone, setCardGone] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void restoreSession();
  }, []);

  // native bridge.rs: "Catching up on messages" once the rooms are loading a while
  useEffect(() => {
    if (session.state !== "syncing") return;
    const t = window.setTimeout(() => setCatchingUp(true), 1500);
    return () => window.clearTimeout(t);
  }, [session.state]);

  const signedIn = session.state === "ready" || (session.state === "syncing" && session.firstSyncDone);
  const decided = signedIn || session.state === "loggedOut";
  useEffect(() => {
    if (launching && decided) setLaunching(false);
  }, [launching, decided]);
  // ADDITIVE (nav, NAV-02 — qml/AppCore.qml:1847-1865): the shell also reveals after 2.5 s of
  // loading rooms (the sidebar then says "Loading your rooms…"), and at a 20 s hard cap
  useEffect(() => {
    if (!launching || session.state !== "syncing") return;
    const t = window.setTimeout(() => setLaunching(false), 2500);
    return () => window.clearTimeout(t);
  }, [launching, session.state]);
  useEffect(() => {
    const t = window.setTimeout(() => setLaunching(false), 20_000);
    return () => window.clearTimeout(t);
  }, []);

  // Another tab owns the session / a chunk failed to load: say so on the startup card.
  if (session.state === "error" && (launching || session.otherTab)) {
    return (
      <Startup stage={session.otherTab ? "Open in another tab" : "Couldn't start"} percent={60}>
        <div style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{session.error}</div>
        {session.otherTab ? (
          <GlowButton text="Use Tin Hat here" onClick={() => void takeOverSession()} />
        ) : (
          <GlowButton text="Reload" onClick={() => location.reload()} />
        )}
      </Startup>
    );
  }

  const st = stageOf(session, catchingUp);
  let underneath: React.ReactNode = null;
  if (!launching) {
    if (session.state === "loggedOut" || session.state === "error") underneath = <LoginView />;
    else if (session.state === "starting") underneath = <LoginView />; // interactive sign-in in flight
    else underneath = <Shell />;
  }
  return (
    <>
      {underneath}
      {!cardGone && <Startup stage={st.stage} detail={st.detail} percent={st.percent} finished={!launching} onHidden={() => setCardGone(true)} />}
    </>
  );
}

/** Theme, reduced motion, form factor, keyboard inset, shortcuts — once, app-wide. */
function useAppEnvironment() {
  useEffect(() => {
    // the theme follows its store (ui/themeStore.ts, booted in main.tsx): prefs, other tabs, the account-data sync
    const motion = () => applyReducedMotion(getPref("reduce-motion", false));
    motion();
    installShortcuts();
    const offs = [onPrefChange("reduce-motion", motion)];
    return () => offs.forEach((o) => o());
  }, []);

  const ff = useFormFactor();
  const touch = useIsTouch();
  useEffect(() => setFormFactorAttrs(ff, touch), [ff, touch]);

  // The on-screen keyboard (phones): keep the composer / sheets above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--th-vv-bottom", `${Math.round(inset)}px`);
    };
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
}

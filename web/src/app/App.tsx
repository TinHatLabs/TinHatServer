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
import { keyboardInset, useFormFactor, useIsTouch } from "@/core/device";
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

const TEXT_INPUT = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
/** The text field a touch landed on (one the keyboard opens for), if any. */
function textFieldAt(t: EventTarget | null): HTMLElement | null {
  const el = t instanceof Element ? t.closest<HTMLElement>("textarea, input, [contenteditable]") : null;
  if (el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly ? null : el;
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly && TEXT_INPUT.has(el.type) ? el : null;
  return el?.isContentEditable ? el : null;
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
    const root = document.documentElement;
    const iosPwa = root.hasAttribute("data-ios-pwa");
    let shift = 0;
    let poll = 0;
    let kbUp = false;
    let nudges: number[] = [];
    let quiet = 0;
    let lastNudge = 0;
    let nudgeCount = 0;
    // After the keyboard comes up iOS can draw the page a status bar lower than where it tells the page it is, until
    // the next touch scroll lines the two up (device check, 2026-10-25). A 1-pt scroll and back does the same; it runs
    // as soon as iOS's own slide has stopped (no viewport event for 60 ms), with timed ones as a fallback.
    const nudge = () => {
      if (!kbUp) return;
      lastNudge = performance.now();
      nudgeCount++;
      const y = window.scrollY;
      window.scrollTo(window.scrollX, y >= 1 ? y - 1 : y + 1);
      requestAnimationFrame(() => window.scrollTo(window.scrollX, y));
    };
    const on = () => {
      // iOS Home Screen app: the body cancels iOS's keyboard pan (tokens.css), measured from where the body really
      // is (converges in one step, whatever iOS reports mid-move). A pinch-zoom: no shift.
      if (iosPwa) {
        shift = vv.scale > 1.01 ? 0 : Math.round(shift - document.body.getBoundingClientRect().top);
        root.style.setProperty("--th-vv-top", `${shift}px`);
      }
      const inset = keyboardInset(vv);
      root.style.setProperty("--th-vv-bottom", `${inset}px`);
      // iOS can still move the page after its last event while the keyboard is up: measure every 200 ms then, and
      // nudge (above) a few times once it has come up
      if (iosPwa && inset > 120 && !kbUp) {
        nudgeCount = 0;
        nudges.forEach((t) => window.clearTimeout(t));
        nudges = [400, 1200].map((ms) => window.setTimeout(nudge, ms));
      }
      kbUp = inset > 120;
      if (iosPwa && inset > 120 && !poll) poll = window.setInterval(on, 200);
      else if (poll && inset <= 120) {
        window.clearInterval(poll);
        poll = 0;
      }
    };
    // ... and again over the 1.5 s after each viewport / focus event (the keyboard sliding in or out)
    let settle: number[] = [];
    const onEvent = () => {
      on();
      if (!iosPwa) return;
      settle.forEach((t) => window.clearTimeout(t));
      settle = [50, 150, 300, 600, 1000, 1500].map((ms) => window.setTimeout(on, ms));
      // the nudge's own scroll events (right after it) don't count; a few per keyboard at most
      if (kbUp && nudgeCount < 5 && performance.now() - lastNudge > 150) {
        window.clearTimeout(quiet);
        quiet = window.setTimeout(nudge, 60);
      }
    };
    // iOS scrolls the page to the field it focuses for a tap, then the keyboard slides in: the header slid away and
    // back. A plain tap on a text field that isn't focused yet is focused here with preventScroll instead, so the page
    // stays still and only the composer rises (screen-check v5 "P4", 2026-10-25). Drags and long presses stay iOS's.
    let tap: { x: number; y: number; t: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      tap = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, t: performance.now() } : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const start = tap;
      tap = null;
      const t = e.changedTouches[0];
      const field = textFieldAt(e.target);
      if (!start || !t || !field || field === document.activeElement) return;
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10 || performance.now() - start.t > 500) return;
      e.preventDefault();
      field.focus({ preventScroll: true });
    };
    if (iosPwa) {
      document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
      document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    }
    on();
    vv.addEventListener("resize", onEvent);
    vv.addEventListener("scroll", onEvent);
    window.addEventListener("resize", onEvent);
    window.addEventListener("scroll", onEvent);
    document.addEventListener("focusin", onEvent);
    document.addEventListener("focusout", onEvent);
    return () => {
      settle.forEach((t) => window.clearTimeout(t));
      nudges.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(quiet);
      window.clearInterval(poll);
      vv.removeEventListener("resize", onEvent);
      vv.removeEventListener("scroll", onEvent);
      window.removeEventListener("resize", onEvent);
      window.removeEventListener("scroll", onEvent);
      document.removeEventListener("focusin", onEvent);
      document.removeEventListener("focusout", onEvent);
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
    };
  }, []);
}

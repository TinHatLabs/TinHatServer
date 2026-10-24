// ErrorBoundary.tsx — W1 (docs/VERIFY-SAS.md): one exception while rendering used to unmount the whole React
// root, which on the OLED theme is a pure black page with no text and no buttons until a reload ("the screen
// just goes black"). Web-only robustness (DECISIONS D22) — the desktop's QML engine has no equivalent failure.
//
//   <AppErrorBoundary>        the app: a full-screen card "Something went wrong" + the short error + Reload
//                             (+ "Go to Home" off the home page: a room whose content crashes would come back on Reload)
//   <OverlayBoundary name onReset?>  a dialog host: on a throw the dialog closes itself (onReset lets the
//                             feature drop the state that broke it), a toast says so, and the host comes back
//                             a moment later; a host that keeps failing stays down instead of looping
//   showFatalCard(error)      plain-DOM version of the card for errors that escape every boundary
//                             (createRoot onUncaughtError in main.tsx) — no React, no components
//   <CrashProbe where>        tests only: throws during render once armCrashProbe(where) was called (the
//                             devhook's __tw.crashRender — never reachable without the debug hook)
// The card uses only its element tokens (recovery.*, the backdrop window.bg — readable on OLED) and plain elements,
// so the fallback cannot throw the way the tree it replaces did. showFatalCard's var() fallbacks are the OLED values
// for a page whose theme variables never got set (applyTheme runs first, so they never paint in practice).
import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import s from "./ErrorBoundary.module.css";

const log = createLogger("ui");

/** The first line of an error, trimmed — what the card shows under its title. */
export function shortError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message}` : String(e ?? "");
  const line = raw.split("\n")[0].trim() || "Unknown error";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}

/** A crash caused by what one room shows would come back on every Reload of #/room/… — Home is the way out. */
function atHome(): boolean {
  const h = location.hash.replace(/^#/, "");
  return h === "" || h === "/" || h === "/home";
}
function reloadAtHome(): void {
  try {
    history.replaceState(history.state, "", "#/home");
  } catch {
    location.hash = "#/home";
  }
  location.reload();
}

function FatalCard({ error }: { error: unknown }) {
  return (
    <div className={s.screen} role="alert" data-fatal-card>
      <div className={s.card}>
        <div className={s.title}>Something went wrong</div>
        <div className={s.detail}>{shortError(error)}</div>
        <div className={s.hint}>Reload to carry on — you stay signed in.</div>
        <button type="button" className={s.reload} onClick={() => location.reload()}>
          Reload
        </button>
        {!atHome() && (
          <button type="button" className={s.home} onClick={reloadAtHome}>
            Go to Home
          </button>
        )}
      </div>
    </div>
  );
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null };
  static getDerivedStateFromError(error: unknown) {
    // `failed` separately: `throw 0` / `throw ""` are falsy and must still show the card
    return { failed: true, error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    log.error("app render failed — showing the recovery card", error, info.componentStack?.split("\n").slice(0, 6).join("\n"));
  }
  render() {
    return this.state.failed ? <FatalCard error={this.state.error} /> : this.props.children;
  }
}

interface OverlayProps {
  /** for the log / toast */
  name: string;
  /** drop the state that made the dialog throw (e.g. reset its store and close it) */
  onReset?: () => void;
  children: ReactNode;
}
interface OverlayState {
  failed: boolean;
}

/** A dialog host that throws closes itself (toast) instead of blanking the app. */
export class OverlayBoundary extends Component<OverlayProps, OverlayState> {
  state: OverlayState = { failed: false };
  private fails: number[] = [];
  private timer: number | null = null;
  static getDerivedStateFromError(): OverlayState {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    const now = Date.now();
    this.fails = [...this.fails.filter((t) => now - t < 30_000), now];
    log.error(`overlay "${this.props.name}" failed — closed it`, error, info.componentStack?.split("\n").slice(0, 6).join("\n"));
    try {
      this.props.onReset?.();
    } catch (e) {
      log.warn(`overlay "${this.props.name}" reset failed`, e);
    }
    const giveUp = this.fails.length >= 3;
    toast(giveUp ? "Something went wrong with that window — reload the page to use it again." : "Something went wrong, so that window was closed.", {
      timeoutMs: 5000,
    });
    if (giveUp) return; // keeps failing: stay down rather than loop
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.setState({ failed: false });
    }, 500);
  }
  componentWillUnmount() {
    if (this.timer) window.clearTimeout(this.timer);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Plain-DOM card for an error no boundary caught (React has unmounted the root by then). */
export function showFatalCard(error: unknown): void {
  try {
    const host = document.getElementById("root") ?? document.body;
    if (host.querySelector("[data-fatal-card]")) return;
    const el = (tag: string, css: string, text?: string) => {
      const n = document.createElement(tag);
      n.setAttribute("style", css);
      if (text != null) n.textContent = text;
      return n;
    };
    const screen = el(
      "div",
      "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--th-window-bg,#000);font-family:var(--th-font,system-ui,sans-serif);",
    );
    screen.setAttribute("role", "alert");
    screen.setAttribute("data-fatal-card", "");
    const card = el(
      "div",
      "display:flex;flex-direction:column;gap:12px;width:min(360px,100%);padding:24px;border-radius:12px;background:var(--th-recovery-card-bg,#0a0a0a);box-shadow:inset 0 0 0 1px var(--th-recovery-card-border,#2d2d2d);",
    );
    card.append(
      el("div", "color:var(--th-recovery-title-fg,#e0e0e0);font-size:18px;line-height:24px;font-weight:700;", "Something went wrong"),
      el("div", "color:var(--th-recovery-detail-fg,#ff6b6b);font-size:14px;line-height:20px;overflow-wrap:anywhere;", shortError(error)),
      el("div", "color:var(--th-recovery-hint-fg,#aaa);font-size:14px;line-height:20px;", "Reload to carry on — you stay signed in."),
    );
    const btn = el(
      "button",
      "min-height:48px;border:0;border-radius:8px;background:var(--th-recovery-button-primary-bg,#1e6a76);color:var(--th-recovery-button-primary-fg,#fff);font:inherit;font-size:16px;font-weight:700;",
      "Reload",
    );
    btn.setAttribute("type", "button");
    btn.addEventListener("click", () => location.reload());
    card.append(btn);
    if (!atHome()) {
      const home = el(
        "button",
        "min-height:48px;border:0;border-radius:8px;background:transparent;color:var(--th-recovery-button-fg,#e0e0e0);box-shadow:inset 0 0 0 1px var(--th-recovery-button-border,#2d2d2d);font:inherit;font-size:16px;",
        "Go to Home",
      );
      home.setAttribute("type", "button");
      home.addEventListener("click", reloadAtHome);
      card.append(home);
    }
    screen.append(card);
    host.append(screen);
  } catch {
    /* nothing more we can do */
  }
}

// ---- tests only: a deliberate render exception (devhook __tw.crashRender) -------------------------------
let crashWhere = "";
const crashListeners = new Set<() => void>();
export function armCrashProbe(where: string): void {
  crashWhere = where;
  for (const l of crashListeners) l();
}
export function CrashProbe({ where }: { where: string }) {
  const armed = useSyncExternalStore(
    (cb) => {
      crashListeners.add(cb);
      return () => crashListeners.delete(cb);
    },
    () => crashWhere === where,
  );
  // stays armed: React retries a failed render once synchronously — a one-shot throw would "recover" silently
  if (armed) throw new Error(`test render crash (${where})`);
  return null;
}

// overlay.tsx — web equivalent of the native voice overlay (OverlayWindow.qml, a KDE layer-shell
// HUD): a Document Picture-in-Picture window showing "who's talking" pills, honouring the same
// prefs (overlay-enabled / -mode / -hide-share). Corner is kept but the browser places the window.
// Browsers only open a PiP window from a click, so it opens when the box is ticked / Preview is
// pressed (and re-opens from the call's own controls later — integration).
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getPref } from "@/core/prefs";
import { registerAuxWindow } from "@/core/winstate";
import { getFormFactor } from "@/core/device";
import { useCallStore } from "@/features/calls";
import type { CallStore } from "@/features/calls/contract";
import { createLogger } from "@/core/log";
import { resolveIcon, useIconIndex } from "@/ui/iconpack";
import { themeColours } from "@/ui/themes";

const log = createLogger("overlay");

interface DPiP {
  requestWindow(o?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}
const dpip = (): DPiP | null => (typeof window !== "undefined" && "documentPictureInPicture" in window ? (window as unknown as { documentPictureInPicture: DPiP }).documentPictureInPicture : null);

/** Document PiP (Chromium desktop). Phones never get an always-on-top window (no DPiP on Android /
 *  iOS browsers; the emulated phone layout counts as a phone too). */
export const overlayAvailable = (): boolean => dpip() !== null && getFormFactor() !== "mobile";

let pipWin: Window | null = null;
let root: Root | null = null;
let previewUntil = 0;
let pillsPing: (() => void) | null = null;

function copyTheme(target: Document) {
  const cs = getComputedStyle(document.documentElement);
  const vars: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    const k = cs[i];
    if (k.startsWith("--th-")) vars.push(`${k}:${cs.getPropertyValue(k)}`);
  }
  const st = target.createElement("style");
  // body #000: this copy of the voice-HUD pop-out has no token of its own in step 1a — overlay.window.bg is the
  // callui/VoiceHud copy's #050507 (PARITY P25 folds the two copies into one; until then each keeps its pixels)
  st.textContent = `:root{${vars.join(";")}} html,body{margin:0;background:#000;color:var(--th-overlay-fg);font-family:var(--th-font);font-size:13px;overflow:hidden}`;
  target.head.appendChild(st);
}

// ---- pills (OverlayWindow.qml:59-345, same model + look) ----------------------------------------

interface Pill {
  key: string;
  label: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  self: boolean;
  sharing: boolean;
  more: boolean;
  warn: boolean;
}

const LINGER_MS = 1800;
const MAX_PILLS = 8;
const GU = 18;
const lastSpoke = new Map<string, number>();

/** Inline mask icon — the PiP document has none of the app's stylesheets, so no <Icon/>. */
function PipIcon({ name, color, size }: { name: string; color: string; size: number }) {
  const idx = useIconIndex();
  const r = resolveIcon(idx, name, size, true);
  const url = r ? (r.kind === "motion" ? r.rest : r.url) : null;
  if (!url) return null;
  const abs = new URL(url, location.href).href;
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: "none",
        background: color,
        WebkitMask: `url("${abs}") center / contain no-repeat`,
        mask: `url("${abs}") center / contain no-repeat`,
      }}
    />
  );
}

function fakePills(tick: number): Pill[] {
  const base = { deafened: false, more: false, warn: false };
  return [
    { ...base, key: "you", label: "You", speaking: tick === 0, muted: false, self: true, sharing: false },
    { ...base, key: "p1", label: "Alex", speaking: tick === 1, muted: false, self: false, sharing: true },
    { ...base, key: "p2", label: "Ripley", speaking: false, muted: true, self: false, sharing: false },
  ];
}

function livePills(e: Partial<CallStore>, now: number): Pill[] {
  const speakingOnly = getPref("overlay-mode", "speaking") !== "always";
  const active = e.speakers?.active ?? [];
  const speakingNow = (id: string) => active.some((a) => a === id || id.startsWith(a + ":") || a.startsWith(id + ":"));
  const out: Pill[] = [];
  const me = e.speakers?.me ?? "";
  const selfSpeaking = !e.micMuted && !!me && speakingNow(me);
  if (selfSpeaking) lastSpoke.set("__self", now);
  const selfLinger = (lastSpoke.get("__self") ?? 0) + LINGER_MS > now;
  const warn = !!e.micMuted && !!e.hear && (e.hear as { mutedTalk?: boolean }).mutedTalk === true;
  if (!speakingOnly || selfSpeaking || selfLinger || warn) {
    out.push({ key: "__self", label: "You", speaking: selfSpeaking, muted: !!e.micMuted, deafened: !!e.deafened, self: true, sharing: !!e.sharing || (e.tiles ?? []).some((t) => t.companionOf === "You"), more: false, warn }); // (or our phone shares for us)
  }
  const seen = new Map<string, { key: string; label: string; muted: boolean; sharing: boolean }>();
  for (const t of e.tiles ?? []) {
    const p = t.companionOf || t.participant; // a companion's share counts as its person's (screen share P3)
    if (!p || p === "You" || t.id === "vid_selfview") continue;
    const r = seen.get(p);
    if (!r) seen.set(p, { key: p, label: t.name || p.replace(/^@/, "").split(":")[0], muted: !!t.muted, sharing: !!t.screenshare });
    else {
      if (t.screenshare) r.sharing = true;
      if (t.kind !== "screenshare") r.muted = !!t.muted;
    }
  }
  for (const r of seen.values()) {
    const speaking = !r.muted && speakingNow(r.key);
    if (speaking) lastSpoke.set(r.key, now);
    const linger = (lastSpoke.get(r.key) ?? 0) + LINGER_MS > now;
    if (!speakingOnly || speaking || linger) out.push({ ...r, speaking, deafened: false, self: false, more: false, warn: false });
  }
  out.sort((a, b) => (a.self !== b.self ? (a.self ? -1 : 1) : a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.key.localeCompare(b.key)));
  if (out.length > MAX_PILLS) {
    const extra = out.length - (MAX_PILLS - 1);
    return [
      ...out.slice(0, MAX_PILLS - 1),
      { key: "__more", label: `+${extra}`, speaking: false, muted: false, deafened: false, self: false, sharing: false, more: true, warn: false },
    ];
  }
  return out;
}

function PillView({ p }: { p: Pill }) {
  const bg = p.warn ? "var(--th-overlay-pill-bg-error)" : p.speaking ? "var(--th-overlay-pill-bg-speaking)" : "var(--th-overlay-pill-bg)";
  const border = p.warn ? "var(--th-overlay-pill-border-error)" : p.speaking ? "var(--th-overlay-pill-border-speaking)" : "var(--th-overlay-pill-border)";
  const dot = GU * 1.3;
  return (
    <div
      style={{
        alignSelf: getPref("overlay-corner", "tl").endsWith("r") ? "flex-end" : "flex-start",
        height: GU * 1.9,
        borderRadius: (GU * 1.9) / 2,
        background: bg,
        border: `1px solid ${border}`,
        boxSizing: "border-box",
        padding: "0 8px",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {!p.more && (
        <span
          style={{
            width: dot,
            height: dot,
            borderRadius: "50%",
            boxSizing: "border-box",
            flex: "none",
            // (read at render from the active theme, like the accent it used to darken here)
            background: p.self ? themeColours().colour["overlay.avatar.bg.own"] : "var(--th-overlay-avatar-bg)",
            border: p.speaking ? "2px solid var(--th-overlay-avatar-ring-speaking)" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--th-overlay-avatar-fg)",
            fontWeight: 700,
            fontSize: dot * 0.52,
          }}
        >
          {(p.label || "?").charAt(0).toUpperCase()}
        </span>
      )}
      <span
        style={{
          color: p.warn ? "var(--th-overlay-name-fg-error)" : p.speaking ? "var(--th-overlay-name-fg-speaking)" : "var(--th-overlay-name-fg)",
          fontWeight: p.speaking || p.warn ? 700 : 400,
          fontSize: GU * 0.72,
          maxWidth: GU * 9,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {p.warn ? `${p.label} — muted!` : p.label}
      </span>
      {p.muted && !p.more && <PipIcon name="microphone-sensitivity-muted-symbolic" size={GU * 0.9} color={p.warn ? "var(--th-overlay-mic-off-icon-error)" : "var(--th-overlay-mic-off-icon)"} />}
      {p.deafened && <PipIcon name="audio-volume-muted-symbolic" size={GU * 0.9} color="var(--th-overlay-deafened-icon)" />}
      {p.sharing && <PipIcon name="monitor-symbolic" size={GU * 0.9} color="var(--th-overlay-sharing-icon)" />}
    </div>
  );
}

function Pills() {
  // GPU.md §2.8 (B16): event-driven — re-rendered when the call's speakers / tiles / mic / hear change (reading the
  // snapshot, not the whole store: the ~15 Hz level churn never reaches this window, INTEGRATION #10), plus ONE
  // timeout at the next linger's end; the preview's demo steps every 1.1 s while it lasts. (It ticked every 250 ms,
  // in and out of calls, for as long as the window was open.)
  const [now, setNow] = useState(Date.now());
  const e = useCallStore.getState() as unknown as Partial<CallStore>;
  useEffect(() => {
    pillsPing = () => setNow(Date.now());
    return () => void (pillsPing = null);
  }, []);
  useEffect(
    () =>
      useCallStore.subscribe((st, prev) => {
        const a = st as unknown as Partial<CallStore>;
        const b = prev as unknown as Partial<CallStore>;
        if (a.speakers !== b.speakers || a.tiles !== b.tiles || a.micMuted !== b.micMuted || a.hear !== b.hear || a.deafened !== b.deafened || a.sharing !== b.sharing || a.inCall !== b.inCall)
          setNow(Date.now());
      }),
    [],
  );
  useEffect(() => {
    if (now < previewUntil) {
      const t = setTimeout(() => setNow(Date.now()), Math.min(1100 - (now % 1100) + 5, previewUntil - now + 5));
      return () => clearTimeout(t);
    }
    const ends = [...lastSpoke.values()].map((v) => v + LINGER_MS).filter((x) => x > now);
    if (!ends.length) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(...ends) - now + 20);
    return () => clearTimeout(t);
  }, [now]);
  const preview = now < previewUntil;
  const hideShare = getPref("overlay-hide-share", "0") === "1";
  const pills = preview ? fakePills(Math.floor(now / 1100) % 3) : e.inCall && !(hideShare && e.sharing) ? livePills(e, now) : [];
  const bottom = getPref("overlay-corner", "tl").startsWith("b");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: bottom ? "flex-end" : "flex-start",
        gap: 4,
        padding: 16,
        minHeight: "100vh",
        boxSizing: "border-box",
        fontFamily: "var(--th-font)",
      }}
    >
      {pills.map((p) => (
        <PillView key={p.key} p={p} />
      ))}
    </div>
  );
}

/** Open (from a click) the PiP overlay. `previewMs` forces demo pills for that long. */
export async function openOverlayWindow(previewMs = 0): Promise<boolean> {
  const api = dpip();
  if (!api) return false;
  if (previewMs) previewUntil = Date.now() + previewMs;
  if (pipWin && !pipWin.closed) {
    pillsPing?.(); // an open window starts the preview now (it has no clock of its own any more)
    return true;
  }
  try {
    pipWin = await api.requestWindow({ width: 240, height: 160 });
    copyTheme(pipWin.document);
    pipWin.document.title = "Tin Hat — who's talking";
    const host = pipWin.document.createElement("div");
    pipWin.document.body.appendChild(host);
    root = createRoot(host);
    root.render(<Pills />);
    pipWin.addEventListener("pagehide", () => {
      root?.unmount();
      root = null;
      pipWin = null;
    });
    registerAuxWindow(pipWin); // GPU.md §1: its focus is the app's; <html data-win/-animate> kept in sync
    if (previewMs && getPref("overlay-enabled", "0") !== "1") {
      setTimeout(() => {
        if (Date.now() >= previewUntil && getPref("overlay-enabled", "0") !== "1") closeOverlayWindow();
      }, previewMs + 100);
    }
    return true;
  } catch (e) {
    log.info("PiP overlay refused", (e as Error)?.message);
    return false;
  }
}

export function closeOverlayWindow(): void {
  try {
    pipWin?.close();
  } catch {
    /* ignore */
  }
  pipWin = null;
}

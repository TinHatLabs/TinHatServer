// VoiceHud.tsx — the voice overlay HUD (OverlayWindow.qml; CUI-159). Native draws a layer-shell window over
// fullscreen games; a page can't, so the web shows the same "who's talking" pill stack in a Document
// Picture-in-Picture window (Chromium 116+), driven by the native prefs `overlay-enabled` ("1"),
// `overlay-mode` (speaking|always), `overlay-hide-share` ("1"). Document PiP needs a user gesture: the
// window opens from `openVoiceHud()` (Settings' checkbox / Preview button call it inside their click) and,
// while the overlay is on and we're in a call, on the next click/key anywhere in the app. Only one
// Document-PiP window exists per page: while the HUD holds it, tile pop-outs use the in-app panel.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { usePref } from "@/core/prefs";
import { isRecorder } from "@/core/server";
import { registerAuxWindow } from "@/core/winstate";
import { Icon, useThemeColours } from "@/ui";
import { callStore, getC, localpartOf, SELF_ID, tileMxid, useC } from "./store";
import { forwardKeys } from "./Pip";

export interface HudPill {
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

const LINGER = 1800;
const MAX_PILLS = 8;

function speakingNow(identity: string, active: string[]): boolean {
  const p = identity || "";
  return active.some((a) => a === p || p.startsWith(a + ":") || a.startsWith(p + ":"));
}

/** OverlayWindow.qml recompute(): self first, then alphabetical; "speaking" mode shows talkers (+1.8 s linger). */
export function hudPills(mode: "speaking" | "always", last: Record<string, number>, now = Date.now()): HudPill[] {
  const c = getC();
  const active = c.speakers?.active ?? [];
  const me = c.speakers?.me ?? "";
  const speakingOnly = mode === "speaking";
  const mutedTalk = !!(c.hear as { mutedTalk?: boolean }).mutedTalk;
  const out: HudPill[] = [];
  const selfSpeaking = !c.micMuted && !!me && speakingNow(me, active);
  if (selfSpeaking) last.__self = now;
  if (!c.micMuted) last.__mutedtalk = 0;
  if (c.micMuted && mutedTalk) last.__mutedtalk = now;
  const selfLinger = (last.__self ?? 0) + LINGER > now;
  const warnLinger = c.micMuted && (last.__mutedtalk ?? 0) + LINGER > now;
  if (!speakingOnly || selfSpeaking || selfLinger || warnLinger)
    out.push({ key: "__self", label: "You", speaking: selfSpeaking, muted: c.micMuted, deafened: c.deafened, self: true, sharing: c.sharing, more: false, warn: warnLinger });
  const seen = new Map<string, { key: string; label: string; muted: boolean; sharing: boolean }>();
  for (const t of c.tiles) {
    const p = t.participant || "";
    if (!p || p === "You" || t.id === SELF_ID || isRecorder(p)) continue;
    const r = seen.get(p);
    if (!r) seen.set(p, { key: p, label: t.name || localpartOf(tileMxid(p)), muted: !!t.muted, sharing: !!t.screenshare || t.kind === "screenshare" });
    else {
      if (t.screenshare || t.kind === "screenshare") r.sharing = true;
      if (t.kind !== "screenshare") r.muted = !!t.muted;
    }
  }
  for (const r of seen.values()) {
    const speaking = !r.muted && speakingNow(r.key, active);
    if (speaking) last[r.key] = now;
    const linger = (last[r.key] ?? 0) + LINGER > now;
    if (!speakingOnly || speaking || linger) out.push({ key: r.key, label: r.label, speaking, muted: r.muted, deafened: false, self: false, sharing: r.sharing, more: false, warn: false });
  }
  out.sort((a, b) => (a.self !== b.self ? (a.self ? -1 : 1) : a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (out.length > MAX_PILLS) {
    const extra = out.length - (MAX_PILLS - 1);
    return [...out.slice(0, MAX_PILLS - 1), { key: "__more", label: `+${extra}`, speaking: false, muted: false, deafened: false, self: false, sharing: false, more: true, warn: false }];
  }
  return out;
}

function previewPills(tick: number): HudPill[] {
  const base = { deafened: false, more: false, warn: false };
  return [
    { ...base, key: "you", label: "You", speaking: tick === 0, muted: false, self: true, sharing: false },
    { ...base, key: "p1", label: "Alex", speaking: tick === 1, muted: false, self: false, sharing: true },
    { ...base, key: "p2", label: "Ripley", speaking: false, muted: true, self: false, sharing: false },
  ];
}

// ---- the Document-PiP window ---------------------------------------------------------------------

const useHud = create<{ win: Window | null; previewUntil: number }>()(() => ({ win: null, previewUntil: 0 }));

type DocPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window>; window: Window | null };
const docPip = (): DocPip | null => (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture ?? null;

export function voiceHudAvailable(): boolean {
  return !!docPip();
}

/** Open the HUD window (call from a click/key handler). `preview` shows the fake pills for 10 s. */
export async function openVoiceHud(opts: { preview?: boolean } = {}): Promise<boolean> {
  if (opts.preview) useHud.setState({ previewUntil: Date.now() + 10000 });
  if (useHud.getState().win) return true;
  const dp = docPip();
  if (!dp || dp.window) return false;
  try {
    const win = await dp.requestWindow({ width: 260, height: 240 });
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const st = win.document.createElement("style");
        st.textContent = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join("\n");
        win.document.head.appendChild(st);
      } catch {
        /* cross-origin sheet */
      }
    }
    for (const a of Array.from(document.documentElement.attributes)) if (a.name.startsWith("data-")) win.document.documentElement.setAttribute(a.name, a.value);
    win.document.title = "Tin Hat overlay";
    win.document.body.style.margin = "0";
    win.document.body.style.background = "var(--th-overlay-window-bg)";
    win.addEventListener("pagehide", () => useHud.setState({ win: null }));
    registerAuxWindow(win); // GPU.md §1: its focus is the app's; <html data-win/-animate> kept in sync
    forwardKeys(win);
    useHud.setState({ win });
    return true;
  } catch {
    return false;
  }
}

export function closeVoiceHud() {
  const w = useHud.getState().win;
  useHud.setState({ win: null });
  try {
    w?.close();
  } catch {
    /* gone */
  }
}

/** Always mounted (r.overlays). */
export function VoiceHudHost() {
  const enabled = usePref("overlay-enabled", "0") === "1";
  const mode = usePref("overlay-mode", "speaking") === "always" ? "always" : "speaking";
  const hideShare = usePref("overlay-hide-share", "0") === "1";
  const inCall = useC("inCall");
  const sharing = useC("sharing");
  const { win, previewUntil } = useHud();
  const [, tick] = useState(0);
  const previewing = previewUntil > Date.now();
  const active = previewing || (enabled && inCall && !(hideShare && sharing));

  // (re)open on the next user gesture while the overlay is on and we're in a call
  useEffect(() => {
    if (!enabled || !inCall || win || !voiceHudAvailable()) return;
    const go = () => {
      if (!docPip()?.window) void openVoiceHud();
    };
    window.addEventListener("pointerdown", go, { capture: true, once: true });
    window.addEventListener("keydown", go, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", go, { capture: true });
      window.removeEventListener("keydown", go, { capture: true });
    };
  }, [enabled, inCall, win]);
  // close when the call ends / the overlay is switched off (not while a preview runs)
  useEffect(() => {
    if (win && !previewing && (!enabled || !inCall)) closeVoiceHud();
  }, [win, previewing, enabled, inCall]);
  // preview end
  useEffect(() => {
    if (!previewing) return;
    const t = window.setTimeout(() => tick((n) => n + 1), previewUntil - Date.now() + 20);
    return () => window.clearTimeout(t);
  }, [previewing, previewUntil]);
  if (!win) return null;
  return createPortal(<HudStack active={active} previewing={previewing} mode={mode} />, win.document.body);
}

function HudStack({ active, previewing, mode }: { active: boolean; previewing: boolean; mode: "speaking" | "always" }) {
  // The HUD's own window copies the app's stylesheets but not the active theme's variables on <html>: its var(--th-…)
  // colours are the static (OLED) values, right only for the theme-independent overlay tokens. The accent-based ones
  // are literals of the active theme (as the palette's were), re-rendered on a theme change.
  const { colour: c } = useThemeColours();
  const last = useRef<Record<string, number>>({});
  const [pills, setPills] = useState<HudPill[]>([]);
  const [t, setT] = useState(0);
  // GPU.md §2.8 (B16): event-driven — the pills are recomputed when the call's speakers / tiles / mic / hear change,
  // plus ONE timeout at the next linger's end (it polled every 300 ms). The preview's demo cycle keeps its 1.1 s step
  // for as long as the preview runs.
  useEffect(() => {
    if (previewing) {
      const iv = window.setInterval(() => setT((n) => n + 1), 1100);
      return () => window.clearInterval(iv);
    }
    if (!active) return;
    return callStore.subscribe((st, prev) => {
      if (st.speakers !== prev.speakers || st.tiles !== prev.tiles || st.micMuted !== prev.micMuted || st.hear !== prev.hear || st.deafened !== prev.deafened || st.sharing !== prev.sharing)
        setT((n) => n + 1);
    });
  }, [active, previewing]);
  useEffect(() => {
    const next = !active ? [] : previewing ? previewPills(t % 3) : hudPills(mode, last.current);
    setPills((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    if (!active || previewing) return;
    const now = Date.now();
    const ends = Object.values(last.current)
      .map((v) => v + LINGER)
      .filter((e) => e > now);
    if (!ends.length) return;
    const tm = window.setTimeout(() => setT((n) => n + 1), Math.min(...ends) - now + 20);
    return () => window.clearTimeout(tm);
  }, [t, active, previewing, mode]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 16, fontFamily: "'Noto Sans', sans-serif" }} data-testid="voice-hud">
      {pills.length === 0 && <div style={{ color: "var(--th-overlay-empty-fg)", fontSize: 12 }}>Nobody's talking</div>}
      {pills.map((p) => {
        const lit = p.speaking;
        return (
          <div
            key={p.key}
            style={{
              alignSelf: "flex-start",
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 34,
              padding: "0 8px",
              borderRadius: 17,
              boxSizing: "border-box",
              background: p.warn ? "var(--th-overlay-pill-bg-error)" : lit ? "var(--th-overlay-pill-bg-speaking)" : "var(--th-overlay-pill-bg)",
              border: `1px solid ${p.warn ? "var(--th-overlay-pill-border-error)" : lit ? c["overlay.pill.border.speaking"] : "var(--th-overlay-pill-border)"}`,
            }}
          >
            {!p.more && (
              <span
                style={{
                  width: 23,
                  height: 23,
                  borderRadius: 12,
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                  background: p.self ? c["overlay.pill.avatar.bg.own"] : "var(--th-overlay-pill-avatar-bg)",
                  border: lit ? `2px solid ${c["overlay.pill.avatar.ring.speaking"]}` : "none",
                  color: "var(--th-overlay-pill-avatar-fg)",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {(p.label || "?").charAt(0).toUpperCase()}
              </span>
            )}
            <span style={{ color: p.warn ? "var(--th-overlay-pill-fg-error)" : lit ? "var(--th-overlay-pill-fg-speaking)" : "var(--th-overlay-pill-fg)", fontWeight: lit || p.warn ? 700 : 400, fontSize: 13, maxWidth: 162, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.warn ? `${p.label} — muted!` : p.label}
            </span>
            {p.muted && !p.more && <Icon name="microphone-sensitivity-muted-symbolic" size={16} color={p.warn ? "var(--th-overlay-pill-icon-error)" : "var(--th-overlay-pill-icon-muted)"} />}
            {p.deafened && <Icon name="audio-volume-muted-symbolic" size={16} color="var(--th-overlay-pill-icon-muted)" />}
            {p.sharing && <Icon name="monitor-symbolic" size={16} color={c["overlay.pill.icon.live"]} />}
          </div>
        );
      })}
    </div>
  );
}

// Pip.tsx — pop-out windows (PipWindow.qml + AppCore.qml:472-546). Web: Document Picture-in-Picture
// (Chromium ≥ 116) renders the same PipWindow React tree in an always-on-top browser window; other
// browsers get an in-app floating panel (draggable, resizable by the corner). One per tile; opening
// an open one re-raises it; the popped tile leaves the grid (session hide) and is never SFU-paused.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, Slider, Menu, MenuItem } from "@/ui";
import { getPref, setPref } from "@/core/prefs";
import { registerAuxWindow } from "@/core/winstate";
import { setPopouts, setPopoutTiles } from "@/features/calls";
import { act, getC, isShareTile, tileName, ui, useC, useCallUi, type PipEntry, type Tile } from "./store";
import s from "./Pip.module.css";

const MIN_W = 260,
  MIN_H = 150;
const docPip = (): { requestWindow: (o: { width: number; height: number }) => Promise<Window>; window: Window | null } | null =>
  (window as unknown as { documentPictureInPicture?: { requestWindow: (o: { width: number; height: number }) => Promise<Window>; window: Window | null } }).documentPictureInPicture ?? null;

const windows = new Map<string, Window>();

/** openPip(tileId…) — call from a click (Document PiP needs the user gesture). */
export function openPip(t: Tile) {
  const u = ui();
  const existing = u.pips.find((p) => p.tileId === t.id);
  if (existing) {
    windows.get(t.id)?.focus();
    return;
  }
  const hidBy = !u.sessionHidden.includes(t.id);
  const entry: PipEntry = { tileId: t.id, participant: t.participant, name: tileName(t), isShare: isShareTile(t), hidBy };
  const dp = docPip();
  if (dp && !dp.window) {
    const w = clampSize(getPref("ui-pip-w", 360), MIN_W, 360);
    const h = clampSize(getPref("ui-pip-h", 214), MIN_H, 214);
    void dp
      .requestWindow({ width: w, height: h })
      .then((win) => {
        // the call or the tile may have gone while the browser opened the window
        const c = getC();
        if (!(c.inCall || c.fake) || !c.tiles.some((x) => x.id === t.id)) {
          win.close();
          return;
        }
        copyStyles(win);
        win.document.title = `${entry.name}${entry.isShare ? " — stream" : ""} — Tin Hat`;
        windows.set(t.id, win);
        registerAuxWindow(win); // GPU.md §1: its focus is the app's; <html data-win/-animate> kept in sync
        win.addEventListener("pagehide", () => closePip(t.id));
        win.addEventListener("keydown", (e) => e.key === "Escape" && win.close());
        forwardKeys(win);
        addPip(entry);
      })
      .catch(() => {
        const c = getC();
        if ((c.inCall || c.fake) && c.tiles.some((x) => x.id === t.id)) addPip(entry);
      });
    return;
  }
  addPip(entry);
}

function clampSize(v: number, min: number, def: number) {
  return v >= min && v < 8000 ? v : def;
}

function addPip(e: PipEntry) {
  const u = ui();
  if (u.pips.some((p) => p.tileId === e.tileId)) return;
  u.set({ pips: [...u.pips, e], sessionHidden: e.hidBy ? [...u.sessionHidden, e.tileId] : u.sessionHidden });
}

export function closePip(tileId: string) {
  const u = ui();
  const e = u.pips.find((p) => p.tileId === tileId);
  const win = windows.get(tileId);
  if (win) {
    if (win.innerWidth >= MIN_W && win.innerHeight >= MIN_H) {
      setPref("ui-pip-w", win.innerWidth);
      setPref("ui-pip-h", win.innerHeight);
    }
    windows.delete(tileId);
    try {
      if (!win.closed) win.close();
    } catch {
      /* already gone */
    }
  }
  if (!e) return;
  u.set({ pips: u.pips.filter((p) => p.tileId !== tileId), sessionHidden: e.hidBy ? u.sessionHidden.filter((x) => x !== tileId) : u.sessionHidden });
}

/** Keys pressed in a pop-out window reach the app (push-to-talk, Ctrl+Shift+M/D) like in the main window. */
export function forwardKeys(win: Window) {
  const fwd = (e: KeyboardEvent) => {
    if (e.key === "Escape") return;
    document.dispatchEvent(
      new KeyboardEvent(e.type, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true }),
    );
  };
  win.addEventListener("keydown", fwd);
  win.addEventListener("keyup", fwd);
}

/** Close every pop-out window (leave cleanup), whatever the session list says. */
export function closeAllPips() {
  for (const id of [...windows.keys()]) closePip(id);
  for (const p of ui().pips) closePip(p.tileId);
}

function copyStyles(win: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      const st = win.document.createElement("style");
      st.textContent = css;
      win.document.head.appendChild(st);
    } catch {
      if (sheet.href) {
        const l = win.document.createElement("link");
        l.rel = "stylesheet";
        l.href = sheet.href;
        win.document.head.appendChild(l);
      }
    }
  }
  const root = document.documentElement;
  for (const a of Array.from(root.attributes)) if (a.name.startsWith("data-")) win.document.documentElement.setAttribute(a.name, a.value);
  win.document.documentElement.style.cssText = root.style.cssText;
  win.document.body.style.margin = "0";
  win.document.body.style.background = "var(--th-pip-bg)";
}

/** Always mounted (r.overlays): renders every open pop-out and closes those whose tile left. */
export function PipHost() {
  const pips = useCallUi((x) => x.pips);
  const tiles = useC("tiles");
  const inCall = useC("inCall");
  const fake = useC("fake");
  useEffect(() => {
    for (const p of ui().pips) if (!tiles.some((t) => t.id === p.tileId) || (!inCall && !fake)) closePip(p.tileId);
  }, [tiles, inCall, fake, pips]);
  // INTEGRATION #9 + GPU.md §2.11: while the tab is hidden the engine keeps exactly the tracks a separate, visible
  // window shows (Document PiP pop-outs; the in-app floating panel hides with the page)
  useEffect(() => {
    if (fake) return;
    setPopouts(pips.length);
    setPopoutTiles(pips.filter((p) => windows.has(p.tileId)).map((p) => p.tileId));
  }, [pips, fake]);
  return (
    <>
      {pips.map((p, i) => {
        const win = windows.get(p.tileId);
        const body = <PipWindow entry={p} docWindow={!!win} />;
        if (win) return createPortal(body, win.document.body, p.tileId);
        return (
          <FloatingPip key={p.tileId} index={i} entry={p}>
            {body}
          </FloatingPip>
        );
      })}
    </>
  );
}

function FloatingPip({ entry, index, children }: { entry: PipEntry; index: number; children: React.ReactNode }) {
  const [geo, setGeo] = useState(() => ({
    x: Math.max(0, window.innerWidth - clampSize(getPref("ui-pip-w", 360), MIN_W, 360) - 24 - index * 24),
    y: 24 + index * 24,
    w: clampSize(getPref("ui-pip-w", 360), MIN_W, 360),
    h: clampSize(getPref("ui-pip-h", 214), MIN_H, 214),
  }));
  const drag = useRef<{ mx: number; my: number; x: number; y: number; w: number; h: number; mode: "move" | "size" } | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && closePip(entry.tileId);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [entry.tileId]);
  const down = (mode: "move" | "size") => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,[role=slider]") && mode === "move") return;
    drag.current = { mx: e.clientX, my: e.clientY, ...geo, mode };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "move") setGeo((g) => ({ ...g, x: d.x + e.clientX - d.mx, y: d.y + e.clientY - d.my }));
    else setGeo((g) => ({ ...g, w: Math.max(MIN_W, d.w + e.clientX - d.mx), h: Math.max(MIN_H, d.h + e.clientY - d.my) }));
  };
  const up = () => {
    if (drag.current?.mode === "size") {
      setPref("ui-pip-w", Math.round(geo.w));
      setPref("ui-pip-h", Math.round(geo.h));
    }
    drag.current = null;
  };
  return (
    <div
      className={s.floating}
      style={{ left: geo.x, top: geo.y, width: geo.w, height: geo.h }}
      onPointerDown={down("move")}
      onPointerMove={move}
      onPointerUp={up}
      role="dialog"
      aria-label={`${entry.name}${entry.isShare ? " — stream" : ""} — Tin Hat`}
    >
      {children}
      <div className={s.grip} onPointerDown={down("size")} onPointerMove={move} onPointerUp={up} />
    </div>
  );
}

const QUALITIES: [string, string][] = [
  ["auto", "Auto"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["360", "360p"],
  ["180", "180p"],
];

export function PipWindow({ entry, docWindow }: { entry: PipEntry; docWindow: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [hov, setHov] = useState(false);
  const [intro, setIntro] = useState(true);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const cat = entry.isShare ? "screenshare" : "mic";
  const [vol, setVol] = useState(() => act("volumeFor")(entry.participant, cat));
  const [muted, setMuted] = useState(() => act("mutedFor")(entry.participant, cat));
  const [q, setQ] = useState(() => act("tileQuality")(entry.tileId) || "auto");
  useEffect(() => {
    const t1 = window.setTimeout(() => setIntro(false), 2500);
    const t2 = window.setTimeout(() => setWaiting(false), 4000);
    return () => (window.clearTimeout(t1), window.clearTimeout(t2));
  }, []);
  // mirror the grid tile's stream (a second <video> on the same MediaStreamTrack)
  useEffect(() => {
    const sync = () => {
      const src = document.querySelector<HTMLVideoElement>(`[data-tile="${CSS.escape(entry.tileId)}"] video`);
      const v = videoRef.current;
      if (!v) return;
      // keep the last stream when the grid tile unmounts (phone minimised) — the track outlives the element
      const so = src?.srcObject ?? null;
      if (so && v.srcObject !== so) v.srcObject = so;
      const cur = v.srcObject as MediaStream | null;
      setHasVideo(!!cur && cur.getVideoTracks().some((tr) => tr.readyState === "live"));
    };
    sync();
    const iv = window.setInterval(sync, 1000);
    return () => window.clearInterval(iv);
  }, [entry.tileId]);
  const stripOn = hov || intro || !!menuAt;
  // another surface (tile menu, nav strip) may have changed this person's dial meanwhile
  useEffect(() => {
    if (!stripOn) return;
    setVol(act("volumeFor")(entry.participant, cat));
    setMuted(act("mutedFor")(entry.participant, cat));
  }, [stripOn, entry.participant, cat]);
  return (
    <div className={s.pip} onPointerEnter={() => setHov(true)} onPointerLeave={() => setHov(false)}>
      <video ref={videoRef} className={s.video} autoPlay playsInline muted style={{ visibility: hasVideo ? "visible" : "hidden" }} />
      {!hasVideo && (
        <div className={s.empty}>
          <Icon name={entry.isShare ? "monitor-symbolic" : "camera-video-symbolic"} size={36} color="var(--th-pip-empty-icon)" />
          <span>{waiting ? "Waiting for video…" : `No video from ${entry.name} right now`}</span>
        </div>
      )}
      <div className={s.caption}>
        {entry.name}
        {entry.isShare ? " — stream" : ""}
      </div>
      <div className={s.strip} style={{ opacity: stripOn ? 1 : 0 }}>
        <button
          type="button"
          className={s.icoBtn}
          aria-label={muted ? "Unmute for me" : "Mute for me"}
          title={docWindow ? (muted ? "Unmute for me" : "Mute for me") : undefined}
          onClick={() => {
            act("setMuted")(entry.participant, cat, !muted);
            setMuted(!muted);
          }}
        >
          <Icon name={muted ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"} size={18} color={muted ? "var(--th-pip-button-icon-muted)" : "var(--th-pip-button-icon)"} />
        </button>
        <Slider
          className={s.slider}
          value={vol}
          from={0}
          to={2}
          stepSize={0.01}
          onMoved={(v) => (setVol(v), act("pushVolume")(entry.participant, cat, v))}
          onRelease={(v) => (setVol(v), act("setVolume")(entry.participant, cat, v))}
        />
        <span className={s.pct}>{Math.round(vol * 100)}%</span>
        <button type="button" className={s.qPill} onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget)} aria-haspopup="menu">
          {QUALITIES.find(([k]) => k === q)?.[1] ?? "Auto"} ▾
        </button>
        <button type="button" className={s.icoBtn} aria-label="Close pop-out" title={docWindow ? "Close pop-out" : undefined} onClick={() => closePip(entry.tileId)}>
          <Icon name="window-close-symbolic" size={18} color="var(--th-pip-button-icon)" />
        </button>
      </div>
      {menuAt && !docWindow && (
        <Menu open onClose={() => setMenuAt(null)} anchor={menuAt} width={140}>
          {QUALITIES.map(([k, l]) => (
            <MenuItem key={k} text={`${q === k ? "✓ " : "   "}${l}`} onTriggered={() => (act("applyTileQuality")(entry.tileId, k), setQ(k))} />
          ))}
        </Menu>
      )}
      {menuAt && docWindow && (
        <div className={s.inlineMenu}>
          {QUALITIES.map(([k, l]) => (
            <button key={k} type="button" className={s.inlineItem} onClick={() => (act("applyTileQuality")(entry.tileId, k), setQ(k), setMenuAt(null))}>
              {q === k ? "✓ " : "  "}
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

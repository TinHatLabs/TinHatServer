// memory.ts — hide / show (two layers), tile view memory, watched-stream audio, adaptive receive
// (AppCore.qml:159-506). Prefs use the native key names (`call-hidden`, `call-tileview`).
import { useEffect, useMemo } from "react";
import { getPref, setPref, usePref } from "@/core/prefs";
import { toast } from "@/core/bus";
import { closeAllPips } from "./Pip";
import { act, getC, isShareTile, SELF_ID, SELF_SHARE_ID, tileKey, ui, useC, useCallUi, viewKey, type Tile } from "./store";

// ---- hidden tiles -----------------------------------------------------------------------------

function cleanKeys(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function getHiddenKeys(): string[] {
  return cleanKeys(getPref<unknown[]>("call-hidden", []));
}
export function useHiddenKeys(): string[] {
  const raw = usePref<unknown[]>("call-hidden", []);
  return useMemo(() => cleanKeys(raw), [raw]);
}
function setHiddenKeys(keys: string[]) {
  setPref("call-hidden", [...new Set(keys)]);
}

/** recording-only + tuned-in flags of a tile (engine recOnlyFlags, or the tile's own fields). */
export function recFlags(t: Tile, flags: Record<string, [boolean, boolean]>): [boolean, boolean] {
  const f = flags[t.id];
  if (f) return f;
  return [!!t.recordingOnly, !!t.tunedIn];
}

/** isTileHidden(id) = session hide || (recording-only && !tunedIn). */
export function useHiddenSet(): Set<string> {
  const tiles = useC("tiles");
  const flags = useC("recOnlyFlags");
  const session = useCallUi((s) => s.sessionHidden);
  return useMemo(() => {
    const s = new Set<string>();
    for (const t of tiles) {
      if (session.includes(t.id)) s.add(t.id);
      else {
        const [ro, tuned] = recFlags(t, flags);
        if (ro && !tuned) s.add(t.id);
      }
    }
    return s;
  }, [tiles, flags, session]);
}

/** Re-apply remembered keys to the session layer whenever the tiles or the keys change. */
export function useHideMemorySync() {
  const tiles = useC("tiles");
  const keys = useHiddenKeys();
  useEffect(() => {
    if (!keys.length) return;
    const cur = ui().sessionHidden;
    const add = tiles.filter((t) => t.id !== SELF_ID && keys.includes(tileKey(t)) && !cur.includes(t.id)).map((t) => t.id);
    if (add.length) ui().set({ sessionHidden: [...cur, ...add] });
  }, [tiles, keys]);
}

export function hideTileRemember(t: Tile) {
  const s = ui();
  if (!s.sessionHidden.includes(t.id)) s.set({ sessionHidden: [...s.sessionHidden, t.id] });
  setHiddenKeys([...getHiddenKeys(), tileKey(t)]);
  if (s.pinned === t.id) s.set({ pinned: null });
  toast('Hidden — remembered for future calls too. Bring it back from the "hidden" chip in the call header.');
}

export function showTile(t: Tile) {
  const s = ui();
  s.set({ sessionHidden: s.sessionHidden.filter((x) => x !== t.id) });
  setHiddenKeys(getHiddenKeys().filter((k) => k !== tileKey(t)));
}

export function showAllAndForget() {
  ui().set({ sessionHidden: [] });
  setHiddenKeys([]);
}

// ---- view memory (zoom / pan / mode) ----------------------------------------------------------

export type ViewMode = "auto" | "fill" | "fit";
export interface TileView {
  z: number;
  px: number;
  py: number;
  mode: ViewMode;
}
type ViewMap = Record<string, { z?: number; px?: number; py?: number; mode?: string; fill?: boolean }>;

export function getViews(): ViewMap {
  const v = getPref<Record<string, unknown>>("call-tileview", {});
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ViewMap) : {};
}

export function defaultMode(t: Tile): ViewMode {
  return isShareTile(t) ? "fit" : "auto";
}

export function loadView(t: Tile): TileView {
  const e = getViews()[viewKey(t)];
  const def = defaultMode(t);
  if (!e) return { z: 1, px: 0, py: 0, mode: def };
  const mode: ViewMode = e.mode === "fill" || e.mode === "fit" || e.mode === "auto" ? e.mode : e.fill === true ? "fill" : e.fill === false ? "fit" : def;
  return { z: Math.min(6, Math.max(0.01, Number(e.z) || 1)), px: Number(e.px) || 0, py: Number(e.py) || 0, mode };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export function saveView(t: Tile, v: TileView) {
  const next = { ...getViews() };
  const key = viewKey(t);
  const def = defaultMode(t);
  if (r2(v.z) === 1 && r2(v.px) === 0 && r2(v.py) === 0 && v.mode === def) delete next[key];
  else next[key] = { z: r2(v.z), px: r2(v.px), py: r2(v.py), mode: v.mode };
  setPref("call-tileview", next);
}

export function useSelfViewMode(): "pip" | "grid" {
  const v = usePref<Record<string, unknown>>("call-tileview", {});
  const self = (v as ViewMap)?._self;
  return self?.mode === "grid" ? "grid" : "pip";
}
export function setSelfViewMode(m: "pip" | "grid") {
  const next = { ...getViews(), _self: { mode: m } };
  setPref("call-tileview", next);
}

// ---- watched streams (CUI-162) ---------------------------------------------------------------

export function useWatchedShares(): Set<string> {
  const tiles = useC("tiles");
  const hidden = useHiddenSet();
  const pinned = useCallUi((s) => s.pinned);
  const listen = useCallUi((s) => s.listen);
  const pips = useCallUi((s) => s.pips);
  return useMemo(() => {
    const shares = tiles.filter((t) => isShareTile(t) && t.id !== SELF_SHARE_ID);
    const popped = new Set(pips.map((p) => p.tileId));
    const w = new Set<string>();
    for (const t of shares) if (popped.has(t.id) || pinned === t.id || listen.includes(t.id)) w.add(t.id);
    if (w.size === 0) {
      const vis = shares.filter((t) => !hidden.has(t.id));
      if (vis.length === 1) w.add(vis[0].id);
    }
    return w;
  }, [tiles, hidden, pinned, listen, pips]);
}

/** Push setTileWatched for every share on change and every 5 s while in a call. */
export function useWatchedPush(watched: Set<string>) {
  const tiles = useC("tiles");
  const inCall = useC("inCall");
  useEffect(() => {
    const push = () => {
      for (const t of getC().tiles) if (isShareTile(t) && t.id !== SELF_SHARE_ID) act("setTileWatched")(t.id, watched.has(t.id));
    };
    push();
    if (!inCall) return;
    const iv = window.setInterval(push, 5000);
    return () => window.clearInterval(iv);
  }, [watched, tiles, inCall]);
}

// ---- hidden-window pause (CUI-161) -----------------------------------------------------------

export function useHiddenWindowPause() {
  const inCall = useC("inCall");
  const pips = useCallUi((s) => s.pips.length);
  useEffect(() => {
    if (!inCall) return;
    const apply = () => act("pauseRemoteTiles")(document.visibilityState === "hidden" && pips === 0);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, [inCall, pips]);
}

/** Leave cleanup (CUI-14): clear fill-the-app, Listen choices, session hides, pin, pops. */
export function resetSession() {
  closeAllPips();
  ui().set({ sessionHidden: [], listen: [], pinned: null, pips: [], optsFace: null, streamPop: false, volMenu: null, mutedBubble: false, mobileMin: false });
}

// carry.ts — D02.3 (2026-11-13): a share in full screen survives its sharer's blip. When the full-screen tile leaves the
// call, its last tile object stays rendered (a "ghost": no picture, same React key, so the Tile — and the browser's
// full-screen element with it — stays mounted) for the grace (tilecarry.ts); the same participant's share coming back
// in that time is rendered under the ghost's key, so it lands in the same full screen. After the grace the ghost goes
// and the full screen ends as before. The desktop holds its OS full-screen window the same way (Main.qml fsCarryTimer).
import { useEffect, useRef, useState } from "react";
import { ui } from "./store";
import { carryTarget, holdOf, type Held } from "@/features/calls/tilecarry";
import { useCallUi, type Tile } from "./store";

interface GhostState {
  prev: Tile[];
  ghost: { tile: Tile; held: Held } | null;
  keys: Map<string, string>;
}

/** The tiles to render (the ghost appended while held) and each tile's React key. */
export function useFsGhost(raw: Tile[]): { tiles: Tile[]; keyOf: (t: Tile) => string } {
  const fsTile = useCallUi((x) => x.fsTile);
  const st = useRef<GhostState>({ prev: [], ghost: null, keys: new Map() });
  const [, bump] = useState(0);
  const s = st.current;
  const now = Date.now();
  if (s.ghost) {
    const to = carryTarget(s.ghost.held, raw, now);
    if (to) {
      s.keys.set(to, s.keys.get(s.ghost.tile.id) ?? s.ghost.tile.id);
      s.ghost = null;
    } else if (now >= s.ghost.held.until) s.ghost = null;
  } else if (fsTile && !raw.some((t) => t.id === fsTile)) {
    const gone = s.prev.find((t) => t.id === fsTile);
    const held = holdOf(gone, now);
    // (review) a replacement that arrives in the same update takes the key at once, no ghost
    const to = held ? carryTarget(held, raw, now) : null;
    if (gone && to) s.keys.set(to, s.keys.get(gone.id) ?? gone.id);
    else if (gone && held) s.ghost = { tile: gone, held };
  }
  for (const id of [...s.keys.keys()]) if (!raw.some((t) => t.id === id) && s.ghost?.tile.id !== id) s.keys.delete(id);
  if (raw.length || !s.ghost) s.prev = raw;
  const until = s.ghost?.held.until ?? 0;
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(() => bump((n) => n + 1), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [until]);
  const tiles = s.ghost ? [...raw, s.ghost.tile] : raw;
  return { tiles, keyOf: (t) => s.keys.get(t.id) ?? t.id };
}

/**
 * D02.3: the pin follows a blip (the desktop's AppCore _pinHeld). The pinned tile that left is held for the grace; the
 * same participant's tile of the same kind coming back in that time is pinned again — unless the person pinned something
 * else meanwhile (review). Used by the desktop-layout stage and the phone layout alike.
 */
export function usePinCarry(tiles: Tile[], pinned: string | null): void {
  const pinHeld = useRef<(Held & { from: string }) | null>(null);
  const pinPrev = useRef(tiles);
  useEffect(() => {
    const now = Date.now();
    if (pinned && !tiles.some((t) => t.id === pinned)) {
      const h = holdOf(pinPrev.current.find((t) => t.id === pinned), now);
      pinHeld.current = h ? { ...h, from: pinned } : null;
      ui().set({ pinned: null });
    } else if (pinHeld.current && pinned && pinned !== pinHeld.current.from) pinHeld.current = null; // a newer choice wins
    if (pinHeld.current) {
      const to = carryTarget(pinHeld.current, tiles, Date.now());
      if (to) {
        pinHeld.current = null;
        ui().set({ pinned: to });
      } else if (now >= pinHeld.current.until) pinHeld.current = null;
    }
    pinPrev.current = tiles;
  }, [tiles, pinned]);
}

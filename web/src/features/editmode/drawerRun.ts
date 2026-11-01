// drawerRun.ts — an open drawer at run time (EDITMODE-UI §7.3; feat/editmode-buttons-drawers; the desktop's Main.qml
// drawerRef / drawerBtn / toggleDrawer / closeDrawer): `layout.drawer.toggle` names a hidden island and the button it
// was pressed on; the shell renders drawerForm(the rendered form, island, the button's rect, the host size) while one is
// open — never saved. A press outside it (the dock host's catcher under the floats), Escape, opening edit mode or the
// button again close it.
import { create } from "zustand";

export interface DrawerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DrawerState {
  /** the island whose drawer is open ("" = none) */
  ref: string;
  /** its button's rect in layout units (the web: px, unitPm 1000), dock-host coordinates */
  btn: DrawerRect | null;
}

/** The outside-press catcher's z in the dock host, for a stored form with `floats` floats: above every docked island
 *  (z 0-2) and every float of the layout (z 10 … 9 + floats), under the drawer's float, which drawerForm appends last
 *  (z 10 + floats; LAYOUT.md §7.10). The desktop puts its catcher at 9.5 + floats; CSS z-index is an integer, so the web
 *  gives it the drawer's own z and draws it BEFORE the island frames (DockHost `underlay`): at an equal z-index the later
 *  element paints on top, so the drawer stays above it and nothing else of the layout does. */
export const drawerCatchZ = (floats: number): number => 10 + Math.max(0, Math.trunc(floats));

export const useDrawerRun = create<DrawerState>()(() => ({ ref: "", btn: null }));

export function closeDrawer(): void {
  const st = useDrawerRun.getState();
  if (!st.ref) return;
  console.log(`[drawer] close ${st.ref}`);
  useDrawerRun.setState({ ref: "", btn: null });
}

/** The button's rect relative to the dock host it sits in (integers); no anchor (a key, the palette) = 0,0,0,0. */
export function anchorRect(anchor: HTMLElement | null | undefined): DrawerRect {
  if (!anchor) return { x: 0, y: 0, w: 0, h: 0 };
  const host = anchor.closest<HTMLElement>("[data-dock-host]") ?? document.querySelector<HTMLElement>("[data-dock-host]");
  const a = anchor.getBoundingClientRect();
  const h = host?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: Math.round(a.left - h.left), y: Math.round(a.top - h.top), w: Math.round(a.width), h: Math.round(a.height) };
}

/** `layout.drawer.toggle`: open `ref`'s drawer under its button, or close it (the same island again, or none). */
export function toggleDrawer(ref: string | null, anchor: HTMLElement | null | undefined): void {
  if (!ref || useDrawerRun.getState().ref === ref) {
    closeDrawer();
    return;
  }
  const b = anchorRect(anchor);
  useDrawerRun.setState({ ref, btn: b });
  console.log(`[drawer] open ${ref} at ${JSON.stringify(b)}`);
}

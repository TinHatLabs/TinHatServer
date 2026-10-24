// shellView.ts — what the desktop shell hands the dock host (islands C6/C7; the desktop's Main.qml dockView /
// dockShape / callPageH and the Island {} properties), pure so the unit test checks the same inputs the app uses:
//   dockView()     the view state (LAYOUT.md §6.1) from the shell's state: a room open, the call (only with a room, like
//                  the desktop's roomShown && callShown), the right panel, "fill the app" = the call maximised, corner
//                  mode = the nav column forced into its drawer, the drawer open while its panel is on screen
//   mainColumnH()  the call's page: the main column = the host's height minus its margins
//   ISLAND_META    per island: how its size reaches the layout, its landmark (ISLANDS-ARCH §2.7), frame rules
// (relative imports only: the Node unit tests load it)
import type { MeasureMode } from "./IslandFrame";

export interface ShellState {
  roomOpen: boolean;
  callShown: boolean;
  panelOpen: boolean;
  /** "fill the app": the call maximised */
  fill: boolean;
  /** corner mode (pref nav_mode = "corner") */
  corner: boolean;
  /** the nav drawer's panel is on screen (open, or fading out) */
  drawerShown: boolean;
  /** 10.8: the nav column's drawer — "navcol", or "emergency" in the emergency arrangement (LAYOUT.md §7.12; the
   *  shell reads it from the last solve) */
  drawerId?: string;
}

export type DockView = {
  roomOpen: boolean;
  callShown: boolean;
  panelOpen: boolean;
  maximized: "call" | null;
  forceCollapse: string[];
  drawer: { open: string | null };
};

export function dockView(s: ShellState): DockView {
  const call = s.roomOpen && s.callShown;
  return {
    roomOpen: s.roomOpen,
    callShown: call,
    panelOpen: s.roomOpen && s.panelOpen,
    maximized: call && s.fill ? "call" : null,
    forceCollapse: s.corner ? ["navcol"] : [],
    drawer: { open: s.drawerShown ? (s.drawerId ?? "navcol") : null },
  };
}

/** The main column's height — the call stage's page (its seam share, its caps): the host minus the theme's margins. */
export function mainColumnH(hostH: number, margin: number): number {
  return Math.max(0, hostH - 2 * margin);
}

export interface IslandMeta {
  measure: MeasureMode;
  role: string;
  label: string;
  /** draws nothing, insets nothing */
  flush?: boolean;
  /** a content inset other than ceil(0.293 × radius) */
  inset?: number;
  /** "dom": the natural height is also the minimum (content.minH) — 10.8, the composer (desktop: Island.minIsNatural) */
  minIsNatural?: boolean;
}

/** Every island of the Classic preset, in the region order (x-tinhat.regionOrder), and how the shell frames it. */
export const ISLAND_META: Readonly<Record<string, IslandMeta>> = {
  nav: { measure: "dom", role: "navigation", label: "Navigation" },
  dms: { measure: "dom", role: "navigation", label: "Direct messages" },
  spaces: { measure: "none", role: "navigation", label: "Spaces" },
  rooms: { measure: "none", role: "navigation", label: "Rooms" },
  widgets: { measure: "explicit", role: "complementary", label: "Widgets", flush: true },
  account: { measure: "dom", role: "region", label: "Account" },
  header: { measure: "dom", role: "region", label: "Room header", inset: 0 },
  call: { measure: "explicit", role: "region", label: "Call" },
  timeline: { measure: "none", role: "main", label: "Conversation" },
  composer: { measure: "dom", role: "form", label: "Message composer", minIsNatural: true },
  panel: { measure: "none", role: "complementary", label: "Room info" },
  // 11.0: your own button islands (`buttons:<n>`) — they report their natural width and height (a float is as wide as
  // its buttons; docked, they wrap to the width they get)
  buttons: { measure: "explicit", role: "toolbar", label: "Buttons" },
};

/** The frame rules of an island ref (an instance `buttons:b1` takes its kind's). */
export function islandMeta(ref: string): IslandMeta | undefined {
  return ISLAND_META[ref] ?? ISLAND_META[ref.split(":")[0]];
}

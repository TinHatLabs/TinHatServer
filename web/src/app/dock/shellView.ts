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
  /** two-pane band (docs/TWO-PANE.md): the view's size overrides from twoPaneSizes(), absent outside the band */
  sizes?: Record<string, { fixed: number }>;
}

export type DockView = {
  roomOpen: boolean;
  callShown: boolean;
  panelOpen: boolean;
  maximized: "call" | null;
  forceCollapse: string[];
  drawer: { open: string | null };
  /** LAYOUT.md §6.1 `sizes`: present only in the two-pane band (twoPaneSizes) */
  sizes?: Record<string, { fixed: number }>;
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
    ...(s.sizes ? { sizes: s.sizes } : {}),
  };
}

// ---- the two-pane band (docs/TWO-PANE.md; the desktop's Main.qml twoPaneSizes, same numbers) ------------------------
// Tablets, a foldable's inner screen, small windows: a dock host narrower than TWO_PANE_BELOW layout units is two panes,
// the list (rail + rooms) and the room; the room info panel already overlays there (Classic's collapse step). The list
// gives the room more width: the rooms column is drawn at TWO_PANE_ROOMS_W instead of its stored width, as a device-local
// view override (LAYOUT.md §6.2 — never saved, never synced). Only a docked fixed column wider than that is narrowed (a
// column you made narrower yourself stays as it is); never in edit mode (it edits the stored sizes).
export const TWO_PANE_BELOW = 1024;
export const TWO_PANE_ROOMS_W = 248;
const TWO_PANE_COL = "roomscol";

/** sc(): a layout length at the UI scale (LAYOUT.md §7.2: fdiv(v × unitPm, 1000)). */
const scaled = (v: number, unitPm: number) => Math.floor((v * unitPm) / 1000);

/** Is a dock host of this width (layout px) in the two-pane band. */
export function inTwoPane(hostW: number, unitPm = 1000): boolean {
  return hostW > 0 && hostW < scaled(TWO_PANE_BELOW, unitPm);
}

type Node = { t?: unknown; id?: unknown; size?: unknown; c?: unknown };
function findNode(n: unknown, id: string, depth = 0): Node | null {
  if (!n || typeof n !== "object" || depth > 32) return null;
  const o = n as Node;
  if (o.id === id && (o.t === "col" || o.t === "row")) return o;
  if (Array.isArray(o.c)) for (const k of o.c) {
    const hit = findNode(k, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** The view's `sizes` for the two-pane band, or undefined (outside the band, edit mode, no such column, a column
 *  already at or under the two-pane width, a column whose width is not fixed). */
export function twoPaneSizes(form: unknown, hostW: number, editing: boolean, unitPm = 1000): Record<string, { fixed: number }> | undefined {
  if (editing || !inTwoPane(hostW, unitPm)) return undefined;
  const root = form && typeof form === "object" ? (form as { root?: unknown }).root : undefined;
  const col = findNode(root, TWO_PANE_COL);
  const size = col?.size as { fixed?: unknown } | undefined;
  const fixed = size && typeof size.fixed === "number" ? size.fixed : null;
  if (fixed === null || fixed <= TWO_PANE_ROOMS_W) return undefined;
  return { [TWO_PANE_COL]: { fixed: TWO_PANE_ROOMS_W } };
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

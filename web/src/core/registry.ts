// registry.ts — typed contribution points. Feature folders plug UI into the shell without the
// shell importing them (and without features importing each other).
//
//   // src/features/<name>/index.tsx
//   export const feature: FeatureModule = {
//     id: "media",
//     setup(r) {
//       r.roomHeaderActions.add({ id: "soundboard", order: 40, component: SoundboardButton });
//       r.windows.add({ id: "memories", order: 0, title: "Memories", component: MemoriesWindow });
//       r.onReady.add({ id: "media-warm", order: 0, run: () => warmCache() });
//     },
//   };
//
//   // a host (shell / feature) renders a registry, sorted by `order` (then id):
//   const actions = useRegistry("roomHeaderActions");
//
// `loadFeatures()` (called once by main.tsx/App) discovers every `src/features/*/index.tsx` via
// import.meta.glob and calls its `feature.setup(registries)`. Pick `order` values that reproduce
// the NATIVE left→right / top→bottom order (leave gaps of 10 so others can slot in).
//
// RULES: register ONLY inside `setup()` — never at a module's top level (this module statically
// imports every feature through the glob, so a top-level `registries.x.add` in a feature would run
// before this module has initialised). Core modules never import this file (no cycles): the
// session announces itself on the bus and this module runs `r.onReady` from there.
import { useSyncExternalStore, type ComponentType } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import { bus } from "@/core/bus";
import { createLogger } from "@/core/log";
import { installShortcuts, registerShortcut } from "@/core/shortcuts";

const log = createLogger("registry");

// ---- item shapes -----------------------------------------------------------------------------

export interface Contribution {
  /** Unique within its registry (re-adding the same id replaces the old item). */
  id: string;
  /** Sort key — ascending. */
  order: number;
}

/** A menu entry for app/room/message/member menus. `Ctx` is the menu's context object. */
export interface MenuContribution<Ctx> extends Contribution {
  label: string | ((ctx: Ctx) => string);
  /** Icon name from the iconpack (see @/ui Icon). */
  icon?: string | ((ctx: Ctx) => string);
  /** Hidden when false. */
  visible?: (ctx: Ctx) => boolean;
  /** Greyed out when false. */
  enabled?: (ctx: Ctx) => boolean;
  /** Checkable item (CheckMenuItem). */
  checked?: (ctx: Ctx) => boolean;
  /** Red / destructive styling. */
  danger?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
  /** A MenuSectionLabel above this item. */
  section?: string;
  /** Keyboard hint text shown right-aligned (e.g. "Ctrl+K"). */
  shortcut?: string;
  /** ADDITIVE (nav): a cascading submenu ("Theme ▸", "Notifications ▸"); `run` is not called then. */
  submenu?: (ctx: Ctx) => MenuSubItem[];
  /** Hover tooltip (hosts that support it; "" = none) and its delay in ms (Qt default 400). */
  tooltip?: string | ((ctx: Ctx) => string);
  tooltipDelay?: number;
  run: (ctx: Ctx) => void;
}

/** ADDITIVE (nav): one row of a registry submenu. */
export interface MenuSubItem {
  id: string;
  label: string;
  icon?: string;
  /** checkable row (exclusive checks are the caller's business) */
  checked?: boolean;
  enabled?: boolean;
  /** ADDITIVE (☰ Theme menu, THEMES-UI §12): a separator above this row */
  separatorBefore?: boolean;
  /** ADDITIVE (☰ Theme menu, THEMES-UI §12): a theme swatch at the row's right end — CSS colours [fill, border, dot 1,
   *  dot 2, dot 3] */
  swatch?: readonly string[];
  run: () => void;
}

export type AppMenuCtx = Record<string, never>;
export interface RoomMenuCtx {
  roomId: string;
}
/** ADDITIVE (nav): the space context menu (right-click a joined space on the rail). */
export interface SpaceMenuCtx {
  spaceId: string;
  label: string;
}
export interface MessageMenuCtx {
  roomId: string;
  event: MatrixEvent;
}
export interface MemberMenuCtx {
  userId: string;
  roomId?: string;
  /** Call participant identity (`@user:server:DEVICE`) when the menu is for one device in a call —
   *  moderation must target that device, not the user's first device in the tile list. */
  identity?: string;
}

export interface SettingsPaneContribution extends Contribution {
  title: string;
  icon?: string;
  /** Group heading in the pane list (native Settings sheet groups). */
  group?: string;
  /** Hide the pane (e.g. Invites only for operators). Re-evaluated on render. */
  visible?: () => boolean;
  component: ComponentType;
}

export interface RoomScopedComponentProps {
  roomId: string;
}

export interface RoomHeaderActionContribution extends Contribution {
  component: ComponentType<RoomScopedComponentProps>;
}

export interface ComposerActionProps {
  roomId: string;
  /** Insert text at the composer caret (provided by the chat feature's composer). */
  insertText: (text: string) => void;
  /** Put focus back into the composer. */
  focusComposer: () => void;
}
export interface ComposerActionContribution extends Contribution {
  component: ComponentType<ComposerActionProps>;
}

export interface TimelineRendererProps {
  roomId: string;
  event: MatrixEvent;
  /** The renderer is inside a grouped/continuation bubble (same sender, close in time). */
  continuation?: boolean;
}
export interface TimelineRendererContribution extends Contribution {
  /** Event types this renderer handles (fast pre-filter), e.g. ["m.room.message"]. */
  eventTypes?: string[];
  /** For m.room.message: msgtypes handled, e.g. ["m.image"]. */
  msgtypes?: string[];
  /** Final say (e.g. "has dev.tinhat.calendar.card"). */
  match?: (ev: MatrixEvent) => boolean;
  component: ComponentType<TimelineRendererProps>;
}

export interface CallBarItemContribution extends Contribution {
  /** Which cluster of the call bar (native CallBar: left info, centre controls, right extras). */
  side?: "left" | "center" | "right";
  /** ADDITIVE (Media Party 11.4): an explicit slot — "phoneStrip" = above the phone call's tiles (callui Mobile.tsx);
   *  the others equal `side`. */
  slot?: "statusLeft" | "statusRight" | "controls" | "phoneStrip";
  component: ComponentType<{ roomId: string }>;
}

export interface TileOverlayProps {
  /** LiveKit participant identity ("@user:server:DEVICE"). */
  identity: string;
  userId: string;
  /** "camera" | "screen" | "avatar" … (call-UI agent defines the set). */
  kind: string;
  local: boolean;
  roomId: string;
}
export interface TileOverlayContribution extends Contribution {
  component: ComponentType<TileOverlayProps>;
}

export interface RailExtraContribution extends Contribution {
  /** ADDITIVE (widgets): rendered by the room panel between the room list and the account card (phones: inside the
   *  list, after the rows) — `mobile` = the phone layout; `island` (11.0, islands C6/C7) = the desktop dock host's
   *  `widgets` island (the contribution sizes itself through useIsland() from @/ui) */
  component: ComponentType<{ mobile?: boolean; island?: boolean }>;
}

export interface RightPanelTabContribution extends Contribution {
  title: string;
  icon?: string;
  visible?: (roomId: string) => boolean;
  component: ComponentType<RoomScopedComponentProps>;
}

export interface WindowContribution extends Contribution {
  title: string | ((props: Record<string, unknown>) => string);
  icon?: string;
  component: ComponentType<any>;
  /** Initial size (native window default size). */
  defaultSize?: { width: number; height: number };
  minSize?: { width: number; height: number };
  /** Only one instance (openWindow raises it). Default true. */
  singleton?: boolean;
  /** ADDITIVE (settings window, 2026-09-29): phones — false = the window draws its own header (back chevron + title),
   *  the sheet only gives it the full screen (Settings steps pane → list itself). Default true. */
  phoneHeader?: boolean;
  /** ADDITIVE (Media Party 11.4): where the window opens the FIRST time (no remembered geometry): "center" (default)
   *  or "right" = docked at the right edge beside the call pane (the native snaps beside the main window). */
  defaultPlacement?: "center" | "right";
}

export interface OverlayContribution extends Contribution {
  component: ComponentType;
}

export interface ShortcutContribution extends Contribution {
  /** Qt-style sequence(s): "Ctrl+K", "Ctrl+Shift+M", "Alt+Up", "Escape" (see shortcuts.ts). */
  keys: string | string[];
  description?: string;
  /** Also fire while the user is typing in an input/textarea/contenteditable. */
  whenTyping?: boolean;
  enabled?: () => boolean;
  /** Return false to let the key fall through to the next handler. */
  run: (e: KeyboardEvent) => boolean | void;
  /** 11.0: the actions-table action these are the default keys of — they fire only while this device keeps them for it
   *  (Settings → Shortcuts, ACTIONS.md §8) */
  action?: string;
}

/** A strip rendered at the top of a room's page (below the header), e.g. "watch party is on", REC banner. */
export interface RoomBannerContribution extends Contribution {
  /** Render for this room, or return null. */
  component: ComponentType<{ roomId: string }>;
  visible?: (roomId: string) => boolean;
}

/** A pill in the call status strip (hear pills, now-playing sound, REC, game chat …). */
export interface CallStatusPillContribution extends Contribution {
  component: ComponentType<{ roomId: string }>;
}

export interface OnReadyContribution extends Contribution {
  /** Runs once per session after the first sync (errors are logged, never thrown). */
  run: () => void | Promise<void>;
}

// ---- registry class --------------------------------------------------------------------------

export class Registry<T extends Contribution> {
  private items = new Map<string, T>();
  private sorted: T[] = [];
  private listeners = new Set<() => void>();

  constructor(readonly name: string) {}

  /** Add (or replace by id). Returns a remover. */
  add(item: T): () => void {
    this.items.set(item.id, item);
    this.resort();
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id);
        this.resort();
      }
    };
  }

  remove(id: string): void {
    if (this.items.delete(id)) this.resort();
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** Sorted by order, then id. Stable identity until the registry changes. */
  list = (): T[] => this.sorted;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private resort() {
    this.sorted = [...this.items.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    for (const l of this.listeners) l();
  }
}

export interface Registries {
  settingsPanes: Registry<SettingsPaneContribution>;
  appMenu: Registry<MenuContribution<AppMenuCtx>>;
  roomMenu: Registry<MenuContribution<RoomMenuCtx>>;
  /** ADDITIVE (nav): space context menu rows (10 Space settings … 60 Leave space). */
  spaceMenu: Registry<MenuContribution<SpaceMenuCtx>>;
  messageMenu: Registry<MenuContribution<MessageMenuCtx>>;
  memberMenu: Registry<MenuContribution<MemberMenuCtx>>;
  roomHeaderActions: Registry<RoomHeaderActionContribution>;
  composerActions: Registry<ComposerActionContribution>;
  timelineRenderers: Registry<TimelineRendererContribution>;
  callBarItems: Registry<CallBarItemContribution>;
  tileOverlays: Registry<TileOverlayContribution>;
  railExtras: Registry<RailExtraContribution>;
  rightPanelTabs: Registry<RightPanelTabContribution>;
  windows: Registry<WindowContribution>;
  overlays: Registry<OverlayContribution>;
  shortcuts: Registry<ShortcutContribution>;
  onReady: Registry<OnReadyContribution>;
  roomBanners: Registry<RoomBannerContribution>;
  callStatusPills: Registry<CallStatusPillContribution>;
}

export type RegistryName = keyof Registries;
export type RegistryItem<N extends RegistryName> = Registries[N] extends Registry<infer T> ? T : never;

export const registries: Registries = {
  settingsPanes: new Registry("settingsPanes"),
  appMenu: new Registry("appMenu"),
  roomMenu: new Registry("roomMenu"),
  spaceMenu: new Registry("spaceMenu"),
  messageMenu: new Registry("messageMenu"),
  memberMenu: new Registry("memberMenu"),
  roomHeaderActions: new Registry("roomHeaderActions"),
  composerActions: new Registry("composerActions"),
  timelineRenderers: new Registry("timelineRenderers"),
  callBarItems: new Registry("callBarItems"),
  tileOverlays: new Registry("tileOverlays"),
  railExtras: new Registry("railExtras"),
  rightPanelTabs: new Registry("rightPanelTabs"),
  windows: new Registry("windows"),
  overlays: new Registry("overlays"),
  roomBanners: new Registry("roomBanners"),
  callStatusPills: new Registry("callStatusPills"),
  shortcuts: new Registry("shortcuts"),
  onReady: new Registry("onReady"),
};

/** React: the sorted items of one registry (re-renders only when that registry changes). */
export function useRegistry<N extends RegistryName>(name: N): RegistryItem<N>[] {
  const reg = registries[name] as unknown as Registry<RegistryItem<N>>;
  return useSyncExternalStore(reg.subscribe, reg.list, reg.list);
}

/** The first timeline renderer (by order) that claims `ev`, if any. */
export function findTimelineRenderer(ev: MatrixEvent): TimelineRendererContribution | undefined {
  const type = ev.getType();
  const msgtype = ev.getContent()?.msgtype as string | undefined;
  for (const r of registries.timelineRenderers.list()) {
    if (r.eventTypes && !r.eventTypes.includes(type)) continue;
    if (r.msgtypes && (!msgtype || !r.msgtypes.includes(msgtype))) continue;
    if (r.match && !r.match(ev)) continue;
    return r;
  }
  return undefined;
}

/** Evaluate a MenuContribution field that may be a value or a ctx function. */
export function menuValue<Ctx, V>(v: V | ((ctx: Ctx) => V), ctx: Ctx): V {
  return typeof v === "function" ? (v as (ctx: Ctx) => V)(ctx) : v;
}

// ---- features --------------------------------------------------------------------------------

export interface FeatureModule {
  id: string;
  /** Register contributions. May return a disposer (used by HMR). */
  setup(r: Registries): void | (() => void);
}

const loaded = new Map<string, void | (() => void)>();

/**
 * Discover and set up every feature folder once. Safe to call repeatedly (already-loaded
 * features are skipped). Returns the ids of all loaded features.
 */
export function loadFeatures(): string[] {
  const mods = import.meta.glob<{ feature?: FeatureModule }>("/src/features/*/index.tsx", { eager: true });
  for (const [path, mod] of Object.entries(mods)) {
    const f = mod.feature;
    if (!f || typeof f.setup !== "function") {
      log.debug(`${path}: no \`feature\` export`);
      continue;
    }
    if (loaded.has(f.id)) continue;
    try {
      loaded.set(f.id, f.setup(registries));
      log.debug(`feature ${f.id} loaded`);
    } catch (e) {
      log.error(`feature ${f.id} setup failed`, e);
    }
  }
  return [...loaded.keys()];
}

export function loadedFeatures(): string[] {
  return [...loaded.keys()];
}

let readyRan = false;

/** Runs every `r.onReady` item once per session (triggered by the bus "sessionReady" event). */
export async function runOnReady(): Promise<void> {
  if (readyRan) return;
  readyRan = true;
  // Started in `order`, awaited together: one slow hook never delays the others.
  const runs = registries.onReady.list().map(async (item) => {
    try {
      await item.run();
    } catch (e) {
      log.error(`onReady ${item.id} failed`, e);
    }
  });
  await Promise.all(runs);
}

/** Reset on sign-out so the next session runs onReady again. */
export function resetOnReady(): void {
  readyRan = false;
}

bus.on("sessionReady", () => void runOnReady());
bus.on("loggedOut", () => resetOnReady());

// ---- r.shortcuts → the global shortcut dispatcher ---------------------------------------------

const syncedShortcuts = new Map<string, () => void>();
function syncShortcuts() {
  installShortcuts();
  const items = registries.shortcuts.list();
  const ids = new Set(items.map((i) => i.id));
  for (const [id, off] of syncedShortcuts) {
    if (!ids.has(id)) {
      off();
      syncedShortcuts.delete(id);
    }
  }
  for (const c of items) {
    syncedShortcuts.get(c.id)?.();
    syncedShortcuts.set(
      c.id,
      registerShortcut({
        id: `registry:${c.id}`,
        keys: c.keys,
        run: c.run,
        whenTyping: c.whenTyping,
        enabled: c.enabled,
        // App-level: component-scoped shortcuts (useShortcut, priority 0) outrank these.
        priority: -1 + c.order / 1e6,
        description: c.description,
        action: c.action,
      }),
    );
  }
}
registries.shortcuts.subscribe(syncShortcuts);

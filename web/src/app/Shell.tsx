// Shell.tsx — the Main.qml frame for a signed-in session.
//
// Desktop (11.0, ISLANDS-ARCH §2.4 / §3.2, islands C6/C7): BannerStrip (verify / offline / update InlineMessages), then
// the dock host running the Classic preset (x-tinhat.presets.classic) with the theme's shape — every part of the window
// its own island (rounded, framed, the theme's gap between them), placed by the layout engine (src/layout; the desktop
// runs the same solver, byte for byte):
//   nav · dms · spaces · rooms · widgets · account   the nav column (features/nav; NavColumnState = its shared state)
//   header · call · timeline · composer · panel      the room (chat's HeaderIsland / TimelineIsland, callui's CallStage,
//                                                    spaces' RightPanel); the composer section of THE conversation
//                                                    renders into the composer island (createPortal)
//   With no room open the room's islands leave the layout and the timeline island says "Pick a room to start" (or,
//   with the nav in the drawer, "Your rooms are tucked away"). Corner mode (pref nav_mode) = the nav column forced
//   into its drawer; below 720 px the solver collapses it there too, and the right panel overlays the conversation
//   below 844. The drawer's chrome (handle + panel frame) is CornerDock at the solver's rects; the column's islands ride
//   in the panel. "Fill the app" (useCall().maximized while a call is shown) = the layout's maximised call.
//   10.8: the layout style, per device (pref `layout-style`): "islands" (default) = the theme's shape; "flat" = the SAME
//   preset edge to edge — shape gap 0 / margin 0, frames radius 0 / width 0 — and what had its own card before islands
//   draws it again: the composer box, the account card (on the room list's colour), the right panel's fill and edge,
//   the header's square gradient with its divider (Settings → Appearance → Layout).
//   Always mounted: FloatingChatsLayer, WindowHost (in-app secondary windows), SettingsSheet, every r.overlays
//   contribution — each in an OverlayBoundary (W1: a dialog that throws closes itself with a toast instead of blanking
//   the app). Ctrl+, opens Settings (Main.qml Shortcut).
// Phones: a stack — #/home = NavColumn full screen, #/room/… = RoomPage full screen with a back
// chevron (history back / edge swipe / Android back all work because routes push history).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SolveOut } from "@/layout";
import { buttonIslands } from "@/actions/layoutStore";
import { ButtonsIsland } from "@/actions/ui/ButtonsIsland";
import { peekClient, useClient } from "@/core/matrix";
import { useBus } from "@/core/bus";
import { getPref, setPref, usePref } from "@/core/prefs";
import { useRegistry } from "@/core/registry";
import { useShortcut } from "@/core/shortcuts";
import { openSettings, toast } from "@/core/bus";
import { INVITE_WHILE_SIGNED_IN } from "./invite";
import { useFormFactor } from "@/core/device";
import { EmptyState, Menu, MenuItem, MenuSeparator, OverlayBoundary } from "@/ui";
import { useShape } from "@/ui/themes";
import {
  NavColumn,
  CornerDock,
  NavColumnState,
  NavIsland,
  DmsIsland,
  SpacesIsland,
  RoomsIsland,
  WidgetsIsland,
  AccountIsland,
  closeDrawer,
  useDmStripEmpty,
  useDrawerStore,
} from "@/features/nav";
import { RoomPage, FloatingChatsLayer, HeaderIsland, TimelineIsland } from "@/features/chat";
import { CallStage } from "@/features/callui";
import { useCall } from "@/features/calls";
import { RightPanel, useRightPanelOpen } from "@/features/spaces";
import { SettingsSheet } from "@/features/settings";
import { useWidgetItems } from "@/features/widgets/store";
import { BannerStrip, ResetBanner } from "./Banners";
import { WindowHost } from "./WindowHost";
import { goBack, navigate, roomHash, useRoute } from "./router";
import { DockHost, type HostSize, type IslandDef, type SolveInputs } from "./dock/DockHost";
import { EditLayer, EditToolbar, IslandPlaceholder, islandText, openEdit, doneEdit, cancelEdit, resetOnThisDevice, useEdit, useRendered, useTabs, setTab } from "@/features/editmode";
import { dockView, islandMeta, mainColumnH } from "./dock/shellView";
import { contentInset } from "./dock/frame";
import { useBackDispatch } from "./dock/dispatch";
import s from "./Shell.module.css";

export function Shell() {
  const mobile = useFormFactor() === "mobile";
  const route = useRoute();
  const overlays = useRegistry("overlays");

  // bus openRoom → the route (history push, so Back returns)
  useBus("openRoom", ({ roomId, eventId }) => navigate(roomHash(roomId, eventId)));
  useShortcut("Ctrl+,", () => openSettings(), { whenTyping: true, action: "app.settings.open" });

  const target = route.name === "room" ? route.target : null;
  const roomId = useResolvedRoomId(target);
  const eventId = route.name === "room" ? route.eventId : undefined;

  // TH-SHELL-06: the last room comes back on the next launch (desktop; phones start at the list)
  useEffect(() => {
    if (mobile || route.name !== "home") return;
    const last = getPref("last-room", "");
    if (last && peekClient()?.getRoom(last)) navigate(roomHash(last), { replace: true });
    // only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (roomId && roomId.startsWith("!")) setPref("last-room", roomId);
  }, [roomId]);
  // selfhost/firstrun item 4: the sign-in screen's routes mean nothing once signed in (the address bar kept "#/login"
  // after signing in) — back to #/home; an invite link opened here says why it can't be used in this tab
  const token = route.name === "register" ? route.token : undefined;
  useEffect(() => {
    if (route.name !== "login" && route.name !== "register" && route.name !== "forgot") return;
    if (token) toast(INVITE_WHILE_SIGNED_IN, { timeoutMs: 8000 });
    navigate({ name: "home" }, { replace: true });
  }, [route.name, token]);

  const always = (
    <>
      <WindowHost />
      <SettingsSheet />
      {overlays.map((o) => (
        <OverlayBoundary key={o.id} name={o.id}>
          <o.component />
        </OverlayBoundary>
      ))}
    </>
  );
  if (mobile) return <PhoneShell roomId={roomId} eventId={eventId} always={always} />;
  return <DesktopShell roomId={roomId} eventId={eventId} always={always} />;
}

function PhoneShell({ roomId, eventId, always }: { roomId: string | null; eventId?: string; always: ReactNode }) {
  useBackDispatch(false);
  // 11.0 (EDITMODE-UI §12): the home page's sections in the order and visibility of the layout's phone form (the phone
  // editor's working copy while it is open)
  const rendered = useRendered();
  const session = useEdit((x) => x.session);
  useEdit((x) => x.v);
  const phone = session?.kind === "phone" ? session.form : rendered.phone;
  const sections = useMemo(() => {
    const arr = (k: string) => {
      const v = (phone as Record<string, unknown>)[k];
      return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
    };
    return { rail: arr("rail"), list: arr("list") };
  }, [phone]);
  return (
    <div className={`${s.shell} ${s.mobile}`}>
      <BannerStrip />
      <ResetBanner />
      <div className={s.stack}>
        {roomId ? (
          <div className={s.stackPage} key={roomId}>
            <RoomPage
              key={roomId}
              roomId={roomId}
              eventId={eventId}
              callSlot={<CallStage roomId={roomId} mobile />}
              rightPanelSlot={<RightPanel roomId={roomId} mobile />}
              leftInset={0}
              mobile
              onBack={() => goBack({ name: "home" })}
            />
          </div>
        ) : (
          <div className={s.stackHome}>
            <NavColumn currentRoomId={null} mobile sections={sections} />
          </div>
        )}
      </div>
      {always}
    </div>
  );
}

function DesktopShell({ roomId, eventId, always }: { roomId: string | null; eventId?: string; always: ReactNode }) {
  const corner = usePref("nav_mode", "persistent") === "corner";
  const callShown = useCall((c) => c.shown);
  const callMax = useCall((c) => c.maximized);
  const fill = callShown && callMax;
  const panelOpen = useRightPanelOpen();
  const drawerShown = useDrawerStore((d) => d.shown);
  const drawerOpened = useDrawerStore((d) => d.opened);
  const shape = useShape();
  const flat = usePref("layout-style", "islands") === "flat";
  const roomOpen = roomId !== null;
  // 11.0: the layout this device renders (features/editmode: the synced `dev.tinhat.layouts` entry, the device-local
  // reset, or built-in Classic — the dock host's form of 10.8) — or, while edit mode is open, its working copy
  const rendered = useRendered();
  const session = useEdit((x) => x.session);
  useEdit((x) => x.v);
  const preview = useEdit((x) => x.preview);
  const editing = session?.kind === "desktop";
  const form = editing ? (preview ?? session.form) : rendered.desktop;
  const tabs = useTabs();
  const [inputs, setInputs] = useState<SolveInputs | null>(null);
  const [gapMenu, setGapMenu] = useState<{ x: number; y: number } | null>(null);
  // Ctrl+E = the `layout.edit` action's default key (Settings → Shortcuts may move it; the action runs the same toggle)
  useShortcut("Ctrl+E", () => {
    if (useEdit.getState().session) doneEdit();
    else openEdit("desktop");
    return true;
  }, { whenTyping: true, action: "layout.edit" });
  // EDITMODE-UI §1: the desktop form going away (the phone breakpoint, signing out) cancels an open desktop session
  useEffect(
    () => () => {
      if (useEdit.getState().session?.kind === "desktop") cancelEdit();
    },
    [],
  );
  // 11.0 buttons: your own button islands (`buttons:<n>`) placed in the form
  const buttonRefs = useMemo(() => buttonIslands(form).join(","), [form]);

  const [out, setOut] = useState<SolveOut | null>(null);
  // 10.8: in the emergency arrangement (LAYOUT.md §7.12 — a very short window, e.g. under ~560 px with a call) the nav
  // column's islands sit in the `emergency` drawer, not `navcol`: the same chrome (CornerDock) shows it, so the rooms
  // stay reachable (the handle used to vanish). A string: it changes (and re-solves) only when the arrangement does.
  const navDrawerId = out?.emergency && out.drawers.some((d) => d.id === "emergency") ? "emergency" : "navcol";
  // the dock host's inputs: the view state (device-local) and the shape — the theme's, or Flat's zeros (tab / handle /
  // drawer sizes: the schema's shapeDefaults)
  // edit mode (EDITMODE-UI §2): every placed island is present — a room, the call and the panel as if open (placeholders
  // where the real content is absent), the nav column's drawer open — and nothing is maximised
  const view = useMemo(() => {
    const v = editing
      ? dockView({ roomOpen: true, callShown: true, panelOpen: true, fill: false, corner, drawerShown: true, drawerId: navDrawerId })
      : dockView({ roomOpen, callShown, panelOpen, fill, corner, drawerShown, drawerId: navDrawerId });
    return Object.keys(tabs).length ? { ...v, active: tabs } : v;
  }, [editing, roomOpen, callShown, panelOpen, fill, corner, drawerShown, navDrawerId, tabs]);
  const gap = flat ? 0 : shape.gap;
  const margin = flat ? 0 : shape.margin;
  const radius = flat ? 0 : shape.radius;
  const border = flat ? 0 : shape.border;
  const dockShape = useMemo(() => ({ gap, margin }), [gap, margin]);
  const [hostH, setHostH] = useState(0);
  const onLayout = useCallback((o: SolveOut, size: HostSize, inp: SolveInputs) => {
    setOut(o);
    setHostH(size.h);
    setInputs(inp);
  }, []);
  const onDrawerHover = useCallback((on: boolean) => useDrawerStore.setState({ islandHover: on }), []);

  const navInDrawer = out ? out.collapsed.includes("navcol:drawer") || navDrawerId === "emergency" : corner;
  const drawer = out?.drawers.find((d) => d.id === navDrawerId);
  useBackDispatch(navInDrawer && !fill);
  // a pick in the drawer closes it
  const onPicked = navInDrawer ? closeDrawer : undefined;
  // the room header clears the drawer handle by the solver's inset (10.1 TH-SHELL-21 used a fixed 46 in corner mode)
  const headerInset = out?.islands.header?.inset?.l ?? 0;
  // 10.8: the emergency arrangement hides the header — the call (then the column's first island) carries the handle's
  // inset; content px (the frame's own inset taken off)
  const callInset = Math.max(0, (out?.islands.call?.inset?.l ?? 0) - contentInset(radius));
  const dmsEmpty = useDmStripEmpty();
  // edit mode: an empty widget list shows the widgets island's placeholder
  const widgetsEmpty = useWidgetItems().length === 0;
  // the composer island's element: THE conversation renders its composer section into it
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);

  const pageH = mainColumnH(hostH, margin);
  // 11.0 (decision 6): nav · dms · spaces in a row when the layout says so (`opts.<ref>.orient = "h"`: Side monitor)
  const orientKey = useMemo(() => {
    const o = (form as { opts?: Record<string, { orient?: unknown }> }).opts ?? {};
    return ["nav", "dms", "spaces"].map((r) => (o[r]?.orient === "h" ? "h" : "v")).join("");
  }, [form]);
  const orient = (i: number): "v" | "h" => (orientKey[i] === "h" ? "h" : "v");
  // the islands' contents are built only when what they show changes — a new layout alone re-renders frames, not them
  const islands = useMemo<IslandDef[]>(() => {
    const nodes: Array<[string, ReactNode, Partial<IslandDef>?]> = [
      ["nav", <NavIsland orient={orient(0)} />, orient(0) === "h" ? { measure: "explicit" } : undefined],
      ["dms", <DmsIsland orient={orient(1)} />, { empty: dmsEmpty, present: editing, ...(orient(1) === "h" ? { measure: "explicit" as const } : {}) }],
      ["spaces", <SpacesIsland orient={orient(2)} />],
      ["rooms", <RoomsIsland currentRoomId={roomId} active={!navInDrawer || drawerOpened} onPicked={onPicked} />],
      ["widgets", <WidgetsIsland />, editing ? { present: true } : undefined],
      ["account", <AccountIsland onPicked={onPicked} flat={flat} />, flat ? { fill: "var(--th-island-bg-rooms)" } : undefined],
      ["header", roomId ? <HeaderIsland roomId={roomId} leftInset={headerInset} mobile={false} fill={fill} island bgRadius={radius} /> : null],
      ["call", roomId ? <CallStage roomId={roomId} pageH={pageH} leftInset={callInset} /> : null],
      [
        "timeline",
        roomId ? (
          <TimelineIsland roomId={roomId} eventId={eventId} composerHost={composerEl} hidden={fill} boxCard={flat} />
        ) : navInDrawer ? (
          <EmptyState
            iconName="documentinfo-symbolic"
            title="Your rooms are tucked away"
            explanation="Hover the handle in the top-left corner to open Spaces and rooms."
          />
        ) : (
          <EmptyState
            iconName="dialog-messages-symbolic"
            title="Pick a room to start"
            explanation="Your rooms are on the left. Ctrl+K jumps to any of them, Alt+↑/↓ steps through the list."
          />
        ),
      ],
      ["composer", <div ref={setComposerEl} data-room-page={roomId ?? undefined} />, flat ? { fill: "var(--th-island-bg-timeline)" } : undefined],
      ["panel", roomId ? <RightPanel roomId={roomId} framed={flat} /> : null],
      // your own button islands (after the region order: the host renders them last, in ref order)
      ...(buttonRefs ? buttonRefs.split(",") : []).map((ref): [string, ReactNode] => [ref, <ButtonsIsland islandRef={ref} />]),
    ];
    return nodes.map(([ref, node, extra]) => ({
      ref,
      node,
      ...islandMeta(ref),
      ...extra,
    }));
  }, [roomId, eventId, flat, fill, radius, pageH, headerInset, callInset, navInDrawer, drawerOpened, onPicked, dmsEmpty, composerEl, editing, orientKey, buttonRefs]);

  // edit mode: the islands whose real content is absent right now get a placeholder (EDITMODE-UI §2)
  const absent = useMemo(() => {
    const a = new Set<string>();
    if (!editing) return a;
    if (!roomId) for (const r of ["header", "call", "timeline", "composer", "panel"]) a.add(r);
    else {
      if (!callShown) a.add("call");
      if (!panelOpen) a.add("panel");
    }
    if (dmsEmpty) a.add("dms");
    if (widgetsEmpty) a.add("widgets");
    return a;
  }, [editing, roomId, callShown, panelOpen, dmsEmpty, widgetsEmpty]);
  // …drawn by the island's own frame (above its content, under its frame line), so a floating island covers it the way
  // it covers content (EDITMODE-UI §20) — not by the edit layer, which stacks each island's chrome by the island's z
  const hostIslands = useMemo(
    () => (absent.size ? islands.map((d) => (absent.has(d.ref) ? { ...d, placeholder: <IslandPlaceholder islandRef={d.ref} /> } : d)) : islands),
    [islands, absent],
  );

  return (
    <div className={s.shell}>
      <BannerStrip islandMargin={flat ? undefined : margin} />
      <ResetBanner islandMargin={flat ? undefined : margin} />
      {editing && <EditToolbar hostW={inputs?.size.w ?? window.innerWidth} ctx={inputs} />}
      <div className={s.body}>
        <NavColumnState currentRoomId={roomId} />
        <DockHost
          form={form}
          view={view}
          shape={dockShape}
          radius={radius}
          border={border}
          islands={hostIslands}
          onLayout={onLayout}
          drawerOpen={drawerOpened}
          onDrawerHover={onDrawerHover}
          onTab={setTab}
          tabLabel={tabLabel}
          onBackgroundMenu={editing ? undefined : (x, y) => setGapMenu({ x, y })}
          chrome={
            <>
              {drawer && !fill && (
                // the drawer's chrome: over the docked islands (z 0), under the drawer's islands (z 20)
                <div className={s.drawerLayer}>
                  <CornerDock handle={drawer.handle} panel={drawer.panel} />
                </div>
              )}
              {editing && out && inputs && <EditLayer out={out} ctx={inputs} form={form} />}
            </>
          }
        />
        {gapMenu && (
          // EDITMODE-UI §10: the way in that always works — right-click (long-press) a gap
          <Menu open onClose={() => setGapMenu(null)} anchor={gapMenu} width={260}>
            <MenuItem text="Edit layout" icon="window-symbolic" shortcut="Ctrl+E" onTriggered={() => openEdit("desktop")} />
            <MenuItem text="Settings" icon="settings-configure" shortcut="Ctrl+," onTriggered={() => openSettings()} />
            <MenuSeparator />
            <MenuItem text="Reset layout on this device" icon="view-refresh-symbolic" onTriggered={resetOnThisDevice} />
          </Menu>
        )}
      </div>
      <FloatingChatsLayer />
      {always}
    </div>
  );
}

const tabLabel = (ref: string) => islandText(ref).name;

/** "#alias:server" → the room id (joined rooms first, then the directory); "!id" passes through. */
function useResolvedRoomId(target: string | null): string | null {
  const client = useClient();
  const local = useMemo(() => {
    if (!target) return null;
    if (target.startsWith("!")) return target;
    const rooms = client?.getRooms() ?? [];
    const hit = rooms.find((r) => r.getCanonicalAlias() === target || r.getAltAliases().includes(target));
    return hit ? hit.roomId : null;
  }, [target, client]);
  const [remote, setRemote] = useState<{
    alias: string;
    id: string | null;
  } | null>(null);
  useEffect(() => {
    if (!target || local || !target.startsWith("#") || !client) return;
    let alive = true;
    client
      .getRoomIdForAlias(target)
      .then((r) => alive && setRemote({ alias: target, id: r.room_id }))
      .catch(() => alive && setRemote({ alias: target, id: null }));
    return () => {
      alive = false;
    };
  }, [target, local, client]);
  if (!target) return null;
  if (local) return local;
  if (remote && remote.alias === target && remote.id) return remote.id;
  // unresolved alias: hand it to the room page as-is (it can show a join preview)
  return target;
}

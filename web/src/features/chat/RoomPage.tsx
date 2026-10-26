// RoomPage.tsx — Main.qml roomPage: RoomHeaderBar (hidden while the call fills the app), the active-call
// banner, r.roomBanners (watch party, REC, guest call …), the call slot, then the conversation with the
// right panel slot docked beside it. Phones: full-screen page with a back chevron (the conversation inside
// is keyed per room).
// 11.0 (islands C6/C7): on the desktop there is no room page any more — the dock host places the room's islands itself:
// `header` (HeaderIsland with `island`: the bar's gradient rounds itself, no hairline; the banners under it), `call`
// (callui's CallStage), `timeline` (TimelineIsland: the conversation + the file-drop veil; its composer section renders
// into the `composer` island) and `panel` (spaces' RightPanel).
import { useEffect, useMemo, useRef, useState } from "react";
import { useBus, bus, startCall } from "@/core/bus";
import { useRegistry } from "@/core/registry";
import { useDmFace, useRoomName, useRoomAvatar, useMembers, useRoomState, useSession } from "@/core/matrix";
import { useCall } from "@/features/calls";
import { CallHeaderChips } from "@/features/callui";
import { PadButton, padCallText, pickTarget, useDeviceName, usePadTargets } from "@/features/pad";
import * as spacesFeature from "@/features/spaces";
import { Avatar, GlowButton, HeaderIconButton, Icon, OverlayPortal, Popover, avatarSeed, cx } from "@/ui";
import type { ItemOut } from "@/actions/evaluate";
import { Dim, EditableRow, RowButton, bespokeOk, shownItems, useRow, type RowState } from "@/actions/ui/rowHost";
import type { RoomHeaderActionContribution } from "@/core/registry";
import { OnThisPhone } from "@/features/native";
import { ConversationView } from "./ConversationView";
import { mainView } from "./store";
import { callBannerText, useRoomCallInfo } from "./roomCall";
import type { RoomPageProps } from "./types";
import s from "./RoomPage.module.css";

export function RoomPage({ roomId, eventId, callSlot, rightPanelSlot, leftInset = 0, mobile = false, onBack }: RoomPageProps) {
  const callShown = useCall((c) => c.shown);
  const callMax = useCall((c) => c.maximized);
  const callRoom = useCall((c) => c.roomId);
  const fill = callShown && callMax && callRoom === roomId;
  return (
    <div className={cx(s.page, mobile && s.mobile)} data-room-page={roomId}>
      <div className={s.head}>
        <HeaderIsland roomId={roomId} leftInset={leftInset} mobile={mobile} onBack={onBack} fill={fill} />
        {/* the call island (CallStage) comes in as a slot */}
        {callSlot}
      </div>
      <div className={s.body}>
        <ConversationView roomId={roomId} eventId={eventId} primary mobile={mobile} hidden={fill} viewKey="main" />
        {/* spaces' RightPanel measures this row itself: docked ≥ 844 px, else an overlay; hidden in fill */}
        {rightPanelSlot}
      </div>
      {!mobile && <DropVeil roomId={roomId} />}
    </div>
  );
}

// ---- HeaderIsland (ISLANDS-ARCH §3.2; Main.qml's HeaderIsland.qml) --------------------------------------------------
// The room header and its banners (the call chips / join banner, r.roomBanners). Phones: fragments in the page's head
// column. Desktop (`island`): the dock host's `header` island — a column spaced 4 px like the old head column; the
// island insets nothing (the bar's gradient takes the island's radius, `bgRadius`: the host's — 0 in the Flat layout
// style, where the bar is square with its divider line again) and clears the drawer handle by the solver's inset.
export function HeaderIsland({ roomId, leftInset, mobile, onBack, fill, island, bgRadius = 0 }: { roomId: string; leftInset: number; mobile: boolean; onBack?: () => void; fill: boolean; island?: boolean; bgRadius?: number }) {
  const banners = useRegistry("roomBanners");
  const calluiOwnsCall = useCalluiOwnsCall();
  const parts = (
    <>
      {!fill && <RoomHeaderBar roomId={roomId} leftInset={leftInset} mobile={mobile} onBack={onBack} bgRadius={island ? bgRadius : 0} />}
      {/* callui's join banner (CUI-149) when the real call UI is loaded; chat's own otherwise (CHAT-12) */}
      <CallHeaderChips roomId={roomId} />
      {!calluiOwnsCall && (
        <OnThisPhone roomId={roomId}>
          <CallBanner roomId={roomId} />
        </OnThisPhone>
      )}
      {banners
        .filter((b) => (b.visible ? b.visible(roomId) : true))
        .map((b) => (
          <b.component key={b.id} roomId={roomId} />
        ))}
    </>
  );
  return island ? <div className={s.headerIsland}>{parts}</div> : parts;
}

// ---- TimelineIsland (islands C6/C7) ------------------------------------------------------------------------------
// The desktop dock host's `timeline` island: THE conversation of the open room (keyed per room inside), its composer
// section rendered into the composer island (`composerHost`), and the window-wide file-drop veil. `data-room-page`
// marks the room's islands for the filter's focus hold and the quick switcher's refocus (the composer island has it
// too); the Lightbox measures the dock host instead.
export function TimelineIsland({ roomId, eventId, composerHost, hidden, boxCard }: { roomId: string; eventId?: string; composerHost: HTMLElement | null; hidden: boolean; boxCard?: boolean }) {
  return (
    <div className={s.timelineIsland} data-room-page={roomId}>
      <ConversationView roomId={roomId} eventId={eventId} primary hidden={hidden} viewKey="main" composerHost={composerHost} boxCard={boxCard} />
      <DropVeil roomId={roomId} />
    </div>
  );
}

// ---- RoomHeaderBar (RHB:75-261) ---------------------------------------------------------------

export function RoomHeaderBar({ roomId, leftInset = 0, mobile, onBack, bgRadius = 0 }: { roomId: string; leftInset?: number; mobile?: boolean; onBack?: () => void; bgRadius?: number }) {
  const name = useRoomName(roomId);
  const avatar = useRoomAvatar(roomId);
  // selfhost/firstrun item 6: a DM's header is its person — their picture and colour, as in the room list and chat
  const dm = useDmFace(roomId);
  const members = useMembers(roomId, "join");
  const topic = useRoomState<{ topic?: string }>(roomId, "m.room.topic")?.topic ?? "";
  const actions = useRegistry("roomHeaderActions");
  // 11.0 buttons: the header's buttons are a row of the actions table (header.main / phone: header.phoneEnd) — the
  // stored row or the preset's default (today's six); the elements are still the features' own (HEADER_HOSTS)
  const row = useRow("header", mobile ? "phoneEnd" : "main", { form: mobile ? "phone" : "desktop" });
  const hosts = useMemo(() => headerHosts(actions), [actions]);
  const n = members.length;
  const sub = n ? `${n} member${n === 1 ? "" : "s"}${topic ? `  ·  ${topic}` : ""}` : topic;
  const [more, setMore] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const [headW, setHeadW] = useState(1200);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeadW(el.clientWidth));
    ro.observe(el);
    setHeadW(el.clientWidth);
    return () => ro.disconnect();
  }, [mobile]);
  const item = (it: ItemOut, i: number) => headerItem(row, hosts, it, i, roomId);
  if (mobile) {
    // phones: the call button in the bar, everything else (the features' chips first) in the "More" popover
    const shown = shownItems(row);
    const primary = shown.filter(({ item: it }) => it.a === "call.join");
    const rest = shown.filter(({ item: it }) => it.a !== "call.join");
    const extras = hosts.unmapped;
    return (
      <header className={cx(s.header, s.mHeader)} data-room-header={roomId}>
        <button type="button" className={s.back} onClick={onBack} aria-label="Back">
          <Icon name="go-previous" size={22} color="var(--th-header-back-icon)" />
        </button>
        <Avatar size={32} name={name || "Room"} seed={avatarSeed(roomId, dm.peer)} imageSource={avatar || dm.avatar} />
        <div className={s.titleCol} onClick={() => bus.emit("openRightPanel", { roomId })}>
          <span className={s.title}>{name || "Room"}</span>
          {sub && <span className={s.sub}>{sub}</span>}
        </div>
        {primary.map(({ item: it, i }) => item(it, i))}
        {rest.length + extras.length > 0 && (
          <>
            <HeaderIconButton ref={moreBtn} iconName="overflow-menu-symbolic" tip="More" size={44} onClick={() => setMore((m) => !m)} />
            <Popover open={more} onClose={() => setMore(false)} anchor={moreBtn.current} title={name || "Room"}>
              <div className={s.moreRow} onClick={() => setMore(false)}>
                {extras.map((a) => (
                  <a.component key={a.id} roomId={roomId} />
                ))}
                {rest.map(({ item: it, i }) => item(it, i))}
              </div>
            </Popover>
          </>
        )}
      </header>
    );
  }
  // order < 10 = chips after the title (calendar's "next up" chip, CHAT-03): hidden at ≤ 612 px
  const chips = hosts.unmapped.filter((a) => a.order < 10);
  const others = hosts.unmapped.filter((a) => a.order >= 10);
  return (
    <header ref={headRef} className={s.header} data-room-header={roomId} style={bgRadius > 0 ? { paddingLeft: 8 + leftInset, borderRadius: bgRadius } : { paddingLeft: 8 + leftInset }}>
      <Avatar size={32} name={name || "Room"} seed={avatarSeed(roomId, dm.peer)} imageSource={avatar || dm.avatar} />
      <div className={s.titleCol}>
        <span className={s.title}>{name || "Room"}</span>
        {sub && <span className={s.sub}>{sub}</span>}
      </div>
      {headW > 612 &&
        chips.map((a) => (
          <a.component key={a.id} roomId={roomId} />
        ))}
      <EditableRow row={row} title="Room header">
        {shownItems(row).map(({ item: it, i }) => item(it, i))}
        {others.map((a) => (
          <a.component key={a.id} roomId={roomId} />
        ))}
      </EditableRow>
      {/* a rounded island has its own frame instead of the accent hairline (Main.qml RoomHeaderBar: bgRadius === 0) */}
      {bgRadius === 0 && <span className={s.hairline} />}
    </header>
  );
}

// ---- the header row's elements (11.0 buttons) -------------------------------------------------------------------
// The features register the header's buttons (r.roomHeaderActions); the row decides which ones show and in what order.
// Each action of the table maps to the registry entries that draw it today, first present wins (callui's call button
// replaces chat's once the call UI is loaded). Entries no action maps to (the next-up chip, a feature's future button)
// keep their registry order: chips after the title, buttons after the row.
const HEADER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "reel.open": ["game-reel"],
  "calendar.open": ["calendar"],
  "memories.open": ["media-memories"],
  "call.join": ["callui-call", "chat-call"],
  "call.devices.open": ["callui-gear"],
  "room.info.toggle": ["chat-info"],
};
/** elements that draw their own unavailable state (the call button's "Connecting…") — never dimmed twice */
const HEADER_SELF_DIM: ReadonlySet<string> = new Set(["call.join"]);

interface HeaderHosts {
  byAction: Map<string, RoomHeaderActionContribution>;
  unmapped: RoomHeaderActionContribution[];
}
function headerHosts(actions: RoomHeaderActionContribution[]): HeaderHosts {
  const byAction = new Map<string, RoomHeaderActionContribution>();
  const mapped = new Set<string>();
  for (const [aid, ids] of Object.entries(HEADER_HOSTS)) {
    for (const id of ids) mapped.add(id);
    const hit = ids.map((id) => actions.find((a) => a.id === id)).find((a) => a !== undefined);
    if (hit) byAction.set(aid, hit);
  }
  return { byAction, unmapped: actions.filter((a) => !mapped.has(a.id)) };
}

function headerItem(row: RowState, hosts: HeaderHosts, it: ItemOut, i: number, roomId: string) {
  const key = `${it.a}:${i}`;
  const host = bespokeOk(row, it) ? hosts.byAction.get(it.a) : undefined;
  if (!host) return <RowButton key={key} row={row} item={it} />;
  const C = host.component;
  if (it.state === "dimmed" && !HEADER_SELF_DIM.has(it.a))
    return (
      <Dim key={key}>
        <C roomId={roomId} />
      </Dim>
    );
  return <C key={key} roomId={roomId} />;
}

// constant for the app's lifetime (module shape), so calling it conditionally keeps the hook order stable
const useSpacesPanelOpen = (spacesFeature as unknown as Record<string, unknown>).useRightPanelOpen as (() => boolean) | undefined;

/** callui registers its own header call button (CUI-150) + join banner (CUI-149): chat's copies step aside. */
function useCalluiOwnsCall(): boolean {
  return useRegistry("roomHeaderActions").some((a) => a.id === "callui-call");
}

/** CHAT-07 — start / join call. Accent while a call is live; disabled while connecting; hidden in call. */
export function CallHeaderButton({ roomId }: { roomId: string }) {
  const calluiOwnsCall = useCalluiOwnsCall();
  const info = useRoomCallInfo(roomId);
  const joined = useCall((c) => c.joined);
  const connecting = useCall((c) => c.connecting);
  const callRoom = useCall((c) => c.roomId);
  const mobile = document.documentElement.dataset.ff === "mobile";
  if (calluiOwnsCall || (joined && callRoom === roomId)) return null;
  const conn = connecting && callRoom === roomId;
  return (
    <HeaderIconButton
      iconName="call-start-symbolic"
      tip={conn ? "Connecting…" : info.active ? "Join the active call" : "Start a call"}
      accent={info.active}
      disabled={conn}
      size={mobile ? 44 : 36}
      onClick={() => startCall(roomId)}
    />
  );
}

/** CHAT-09 — "Room info & members" toggles the right panel (spaces owns the panel). */
export function InfoHeaderButton({ roomId }: { roomId: string }) {
  const [busOpen, setOpen] = useState(false);
  // the real spaces feature exposes its panel store (useRightPanelOpen); the phase-1 stub doesn't
  const storeOpen = useSpacesPanelOpen ? useSpacesPanelOpen() : undefined;
  const open = storeOpen ?? busOpen;
  useBus("openRightPanel", (p) => setOpen(p.roomId === roomId));
  useBus("closeRightPanel", () => setOpen(false));
  useEffect(() => setOpen(false), [roomId]);
  const mobile = document.documentElement.dataset.ff === "mobile";
  return (
    <HeaderIconButton
      iconName="documentinfo-symbolic"
      tip={open ? "Close room info" : "Room info & members"}
      accent={open}
      size={mobile ? 44 : 36}
      onClick={() => (open ? bus.emit("closeRightPanel", {}) : bus.emit("openRightPanel", { roomId }))}
    />
  );
}

// ---- active-call banner (Main:5245-5291) ------------------------------------------------------

function CallBanner({ roomId }: { roomId: string }) {
  const info = useRoomCallInfo(roomId);
  const joined = useCall((c) => c.joined);
  const connecting = useCall((c) => c.connecting);
  const callRoom = useCall((c) => c.roomId);
  const inThis = callRoom === roomId && (joined || connecting);
  const [busy, setBusy] = useState(false);
  // Pad (features/pad): one of my other devices is in this call → "You're in this call on <device>" + Pad beside Join
  const pad = usePadTargets(roomId);
  const padT = pickTarget(pad);
  const padDev = useDeviceName(padT?.device ?? "");
  const me = useSession().userId ?? "";
  useEffect(() => {
    if (!connecting) setBusy(false);
  }, [connecting]);
  if (!info.active || (inThis && joined)) return null;
  const joining = busy || (connecting && callRoom === roomId);
  const text = padT ? padCallText(padDev, info.participants.filter((p) => p.userId !== me).map((p) => p.name)) : callBannerText(info.participants.map((p) => p.name));
  return (
    <div className={s.callBanner}>
      <span className={s.bannerText}>{text}</span>
      {padT && <PadButton roomId={roomId} targets={pad} />}
      <GlowButton
        text={joining ? "Joining…" : "Join"}
        busy={false}
        disabled={joining}
        onClick={() => {
          setBusy(true);
          startCall(roomId);
          window.setTimeout(() => setBusy(false), 8000);
        }}
      />
    </div>
  );
}

// ---- window-level drop veil (Main:2268-2336) --------------------------------------------------

function DropVeil({ roomId }: { roomId: string }) {
  const name = useRoomName(roomId);
  const [on, setOn] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || (e.target as HTMLElement)?.closest?.("[data-floating-chat]")) return;
      depth.current++;
      setOn(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOn(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = 0;
      setOn(false);
      if ((e.target as HTMLElement)?.closest?.("[data-floating-chat]")) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) mainView()?.stageFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  if (!on) return null;
  // the whole WINDOW is the drop target (Main:2268-2336) — portal out of the room page
  return (
    <OverlayPortal>
      <div className={s.veil}>
        <div className={s.veilCard}>
          <Icon name="document-send-symbolic" size={40} color="var(--th-drop-card-icon)" />
          <span className={s.veilTitle}>Drop to attach in {name || "this room"}</span>
          <span className={s.veilSub}>You can add a message before it goes.</span>
        </div>
      </div>
    </OverlayPortal>
  );
}

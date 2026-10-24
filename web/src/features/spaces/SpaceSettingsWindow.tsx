// SpaceSettingsWindow.tsx — SpaceSettingsWindow.qml as an in-app AppWindow (id "spacesettings",
// geometry remembered under the native WindowMemory key). Frame: rail (198 px, panel) | Kirigami
// separator | page (margins 16: title + description, status strip, busy spinner, Refresh; separator;
// the tab stack). Tabs stay mounted (a StackLayout) so a role draft survives a tab switch.
// Escape: invite popover → member menu → roles submenu → the window (popups take Esc first).
// Phones: the AppWindow is a full-screen sheet; the rail becomes a header + 4-tab strip.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { peekClient } from "@/core/matrix";
import { useAppWindow } from "@/app/WindowHost";
import { useFormFactor } from "@/core/device";
import { Avatar, BusyIndicator, ConfirmDialog, Heading, Icon, Separator, ToolButton, cx } from "@/ui";
import { closeSpace, openSpace, spaceActions, useSpaceAdmin } from "./store";
import { normalizeTab, type SpaceTab } from "./intents";
import { setSpaceWinEl, useCenterOnWindow, useKeyboardUp, useWindowEscapeFallback } from "./winGeom";
import { OverviewTab } from "./OverviewTab";
import { MembersTab } from "./MembersTab";
import { RolesTab } from "./RolesTab";
import { RoomsTab } from "./RoomsTab";
import s from "./SpaceSettings.module.css";

export const TABS: ReadonlyArray<{ k: SpaceTab; t: string; i: string; d: string }> = [
  { k: "overview", t: "Overview", i: "configure-symbolic", d: "Name, photo, topic and who can join" },
  { k: "members", t: "Members", i: "system-users-symbolic", d: "Everyone in the space — roles, invites and bans" },
  { k: "roles", t: "Roles", i: "security-medium-symbolic", d: "Named groups with permissions, applied to every room" },
  { k: "rooms", t: "Rooms", i: "view-list-details-symbolic", d: "The rooms in this space and whether their permissions match" },
];

/** Window title: "<name> · Space settings" (never exactly "Tin Hat"). */
export function spaceSettingsTitle(props: Record<string, unknown>): string {
  // phones: the sheet header already carries the space name + avatar right below it
  if (typeof document !== "undefined" && document.documentElement.dataset.ff === "mobile") return "Space settings";
  const id = String(props.spaceId ?? "");
  const name = id ? peekClient()?.getRoom(id)?.name : "";
  return name ? `${name} · Space settings` : "Space settings";
}

export interface SpaceSettingsProps {
  spaceId?: string;
  tab?: string;
  nonce?: number;
}

export function SpaceSettingsWindow({ spaceId = "", tab: tabProp, nonce }: SpaceSettingsProps) {
  const win = useAppWindow();
  const mobile = useFormFactor() === "mobile";
  const [tab, setTab] = useState<SpaceTab>(normalizeTab(tabProp));
  const railRef = useRef<HTMLDivElement>(null);
  const summary = useSpaceAdmin((st) => st.summary);
  const busy = useSpaceAdmin((st) => st.busy);
  const openId = useSpaceAdmin((st) => st.spaceId);

  // open(spaceId) + openOrRaise(tab): every (re)open switches the tab and focuses the rail
  useEffect(() => {
    openSpace(spaceId);
    setTab(normalizeTab(tabProp));
    requestAnimationFrame(() => railRef.current?.focus({ preventScroll: true }));
  }, [spaceId, tabProp, nonce]);
  // closing the window closes the controller (models cleared, spaceId "")
  useEffect(() => () => closeSpace(), []);

  const [leaveOpen, setLeaveOpen] = useState(false);
  const leaveStyle = useCenterOnWindow(leaveOpen);
  // phones: while typing, the sheet ends at the keyboard (padding --th-vv-bottom) and the space header + tab
  // strip step aside so the form keeps its room
  const kbUp = useKeyboardUp(mobile);
  // Escape after a clicked button dropped focus to <body> (desktop window; phones have Back)
  useWindowEscapeFallback(!mobile, () => win.close());
  const spaceName = summary?.name ?? "";
  const cur = TABS.find((t) => t.k === tab)!;

  const onRailKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.k === tab);
    if (e.key === "ArrowUp") setTab(TABS[(i + TABS.length - 1) % TABS.length].k);
    else if (e.key === "ArrowDown") setTab(TABS[(i + 1) % TABS.length].k);
    else return;
    e.preventDefault();
  };
  const onWinKey = (e: KeyboardEvent) => {
    // popups (menus, popover, dialogs) take Escape first through the popup stack
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      win.close();
    }
  };

  const memberCount = summary?.memberCount ?? 0;
  const roomCount = summary?.roomCount ?? 0;
  const caption = `${memberCount} ${memberCount === 1 ? "member" : "members"} · ${roomCount} ${roomCount === 1 ? "room" : "rooms"}`;
  const stale = openId !== spaceId;

  const rail = (
    <div className={s.rail}>
      <div className={s.railAvatar}>
        <Avatar size={56} radius={14} name={spaceName} seed={spaceId || spaceName} imageSource={summary?.avatar} />
      </div>
      <Heading level={3} className={s.railName}>
        {spaceName || "Space"}
      </Heading>
      <div className={s.railCaption}>{caption}</div>
      <Separator className={s.railSep} />
      <div ref={railRef} className={s.tabList} tabIndex={0} role="tablist" aria-orientation="vertical" onKeyDown={onRailKey}>
        {TABS.map((t) => (
          <RailItem key={t.k} tab={t} selected={tab === t.k} onClick={() => (setTab(t.k), railRef.current?.focus({ preventScroll: true }))} />
        ))}
      </div>
      <span className={s.fill} />
      {summary?.isMember && (
        <button type="button" className={s.leave} onClick={() => setLeaveOpen(true)}>
          <Icon name="go-previous-symbolic" size={16} color="var(--th-space-settings-leave-fg)" />
          <span>Leave space</span>
        </button>
      )}
    </div>
  );

  const header = (
    <div className={s.headerRow}>
      <div className={s.titleCol}>
        <Heading level={2} className={s.pageTitle}>
          {cur.t}
        </Heading>
        <div className={s.pageDesc}>{cur.d}</div>
      </div>
      <StatusStrip />
      {busy && <BusyIndicator size={22} color="var(--th-loader-spinner-fg)" />}
      <ToolButton iconName="view-refresh-symbolic" tip="Refresh" onClick={() => spaceActions.hardRefresh()} />
    </div>
  );

  const stack = (
    <div className={s.stack}>
      <div className={s.tabPane} hidden={tab !== "overview"}>
        {!stale && <OverviewTab mobile={mobile} onLeave={mobile && summary?.isMember ? () => setLeaveOpen(true) : undefined} />}
      </div>
      <div className={s.tabPane} hidden={tab !== "members"}>
        {!stale && <MembersTab mobile={mobile} onManageRoles={() => setTab("roles")} />}
      </div>
      <div className={s.tabPane} hidden={tab !== "roles"}>
        {!stale && <RolesTab key={spaceId} mobile={mobile} visible={tab === "roles"} />}
      </div>
      <div className={s.tabPane} hidden={tab !== "rooms"}>
        {!stale && <RoomsTab mobile={mobile} />}
      </div>
    </div>
  );

  const dialogs = (
    <ConfirmDialog
      open={leaveOpen}
      style={leaveStyle}
      onClose={() => setLeaveOpen(false)}
      dialogTitle="Leave space?"
      confirmText="Leave"
      destructive
      message={`Leave "${spaceName}"? Its rooms stay joined; you'll need a new invite to get the space (and its calendar) back.`}
      onConfirmed={() => {
        void spaceActions.leave();
        win.close();
      }}
    />
  );

  if (mobile) {
    return (
      <div className={cx(s.mWin, kbUp && s.mKb)} onKeyDown={onWinKey}>
        <div className={s.mHead}>
          <Avatar size={40} radius={10} name={spaceName} seed={spaceId || spaceName} imageSource={summary?.avatar} />
          <div className={s.mHeadText}>
            <div className={s.mHeadName}>{spaceName || "Space"}</div>
            <div className={s.mHeadCaption}>{caption}</div>
          </div>
          {busy && <BusyIndicator size={22} color="var(--th-loader-spinner-fg)" />}
          <ToolButton iconName="view-refresh-symbolic" tip="Refresh" onClick={() => spaceActions.hardRefresh()} />
        </div>
        <div className={s.mTabs} role="tablist">
          {TABS.map((t) => (
            <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={cx(s.mTab, tab === t.k && s.mTabOn)} onClick={() => setTab(t.k)}>
              <Icon name={t.i} size={18} color={tab === t.k ? "var(--th-space-settings-rail-item-icon-selected)" : "var(--th-space-settings-rail-item-icon)"} active={tab === t.k} />
              <span>{t.t}</span>
            </button>
          ))}
        </div>
        <div className={s.mStrip}>
          <StatusStrip />
        </div>
        <div className={s.mPage}>{stack}</div>
        {dialogs}
      </div>
    );
  }

  return (
    <div ref={setSpaceWinEl} className={s.win} onKeyDown={onWinKey}>
      {rail}
      <Separator vertical />
      <div className={s.page}>
        {header}
        <Separator />
        {stack}
      </div>
      {dialogs}
    </div>
  );
}

function RailItem({ tab, selected, onClick }: { tab: (typeof TABS)[number]; selected: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="tab"
      aria-selected={selected}
      className={cx(s.railItem, selected && s.railItemOn)}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <Icon name={tab.i} size={18} color={selected ? "var(--th-space-settings-rail-item-icon-selected)" : "var(--th-space-settings-rail-item-icon)"} hovered={hover} active={selected} />
      <span className={s.railLabel}>{tab.t}</span>
    </div>
  );
}

/** The inline status strip: the toast, where you are looking (4 s, repeats re-show). */
function StatusStrip() {
  const status = useSpaceAdmin((st) => st.status);
  const statusRev = useSpaceAdmin((st) => st.statusRev);
  const err = useSpaceAdmin((st) => st.lastError);
  const errorRev = useSpaceAdmin((st) => st.errorRev);
  const [strip, setStrip] = useState<{ text: string; error: boolean } | null>(null);
  const first = useRef(true);
  const timer = useRef(0);
  const show = (text: string, error: boolean) => {
    setStrip({ text, error });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStrip(null), 4000);
  };
  useEffect(() => {
    if (first.current) return;
    if (status) show(status, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusRev]);
  useEffect(() => {
    if (first.current) return;
    if (err) show(err, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorRev]);
  useEffect(() => {
    first.current = false;
    return () => window.clearTimeout(timer.current);
  }, []);
  if (!strip) return null;
  return (
    <div className={cx(s.strip, strip.error && s.stripError)} role="status">
      <span>{strip.text}</span>
    </div>
  );
}

// RightPanel.tsx — RightPanel.qml: the room's docked info / members column (TH-CONV-08).
//
// Desktop: a 324 px (gridUnit × 18) column beside the conversation, 1 px pal.sep line on its left,
// width animating 0 ↔ 324 in 140 ms OutCubic. Docked (the conversation shrinks) when the room page
// is ≥ 844 px wide, else it overlays the conversation (z 2). Hidden while the call fills the app.
// 11.0 (islands C6/C7): in the dock host the panel is the `panel` island — docked or overlaid as the solver's collapse
// chain decides (its z: 2 = the panel → overlay step), the island drawing the fill and the frame (no own background,
// edge line or width animation).
// Tabs: Info (avatar, name, alias, encryption pill, topic, "Now playing" editor, inline name/topic
// editor) | Members · N (your status + TTL, invite row, grouped member list, room member menu with
// power submenu, kick/ban confirms, profile card). Phones: a full-screen sheet with a back header.
import { useBackToClose } from "@/ui/backStack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { EventType } from "matrix-js-sdk";
import { useFormFactor } from "@/core/device";
import { openSpaceSettingsIntent } from "./intents";
import { openUserProfile } from "@/core/bus";
import {
  peekClient,
  useIsDirect,
  useMembers,
  usePowerLevels,
  useRoomAvatar,
  useDmFace,
  useRoomName,
  useRoomState,
  type MemberInfo,
} from "@/core/matrix";
import { useCall } from "@/features/calls";
import { StatusChip, avatarDot, usePresence, viewOf } from "@/features/presence";
import {
  Avatar,
  BasicButton,
  BasicTextField,
  BasicToolButton,
  BusyIndicator,
  ComboBox,
  ConfirmDialog,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  CheckMenuItem,
  ScrollArea,
  Separator,
  ToolButton,
  senderColor,
  localpart,
  useTip,
  cx,
  useContentInk,
  useIsland,
  avatarSeed,
} from "@/ui";
import { useContainer, useRolesState, powerLevelOf } from "./roles";
import { roleBadgeFrom, tagBadgeFrom, type RolesState } from "./model";
import { RoleBadge } from "./RoleBadge";
import { postStatus, setActivity, useMyStatus, useRoomActivity, useRoomStatuses } from "./activity";
import {
  banFromRoom,
  inviteToRoom,
  kickFromRoom,
  linkify,
  renameRoom,
  setMemberPower,
  setRoomTopic,
  spaceOf,
  unbanInRoom,
} from "./roomActions";
import { ProfileCardPopup } from "./ProfileCard";
import { freshMembers } from "./store";
import { useLongPress } from "./longPress";
import { setRightPanelTab, useRightPanelStore, closeRightPanel } from "./panelState";
import s from "./RightPanel.module.css";

export interface RightPanelProps {
  roomId: string;
  mobile?: boolean;
  /** 10.8 Flat layout style: in the dock host's (flat) panel island the panel draws its own fill and left edge again */
  framed?: boolean;
}

export const PANEL_WIDTH = 324;
const DOCK_MIN = PANEL_WIDTH + 520;

// ---- member rows (room.rs load_members) ----------------------------------------------------------------

export interface RoomMemberRow {
  mxid: string;
  name: string;
  avatar: string | null;
  power: number;
  role: "Invited" | "Banned" | "Admin" | "Mod" | "Member";
  membership: "join" | "invite" | "ban";
  sortKey: number;
  roleName: string;
  roleColor: string;
  group: string;
  groupColor: string;
  tier: number;
  tagName: string;
  tagColor: string;
}

function rawName(m: MemberInfo): string {
  return m.rawName && m.rawName !== m.userId ? m.rawName : localpart(m.userId);
}

export function buildMemberRows(members: MemberInfo[], st: RolesState): RoomMemberRow[] {
  const rows: RoomMemberRow[] = [];
  for (const m of members) {
    const membership = m.membership === "invite" ? "invite" : m.membership === "ban" ? "ban" : m.membership === "join" ? "join" : null;
    if (!membership) continue;
    let power: number, role: RoomMemberRow["role"], sortKey: number;
    if (membership === "invite") [power, role, sortKey] = [0, "Invited", -1];
    else if (membership === "ban") [power, role, sortKey] = [0, "Banned", -2];
    else if (m.powerLevel === Infinity) [power, role, sortKey] = [100, "Admin", Number.MAX_SAFE_INTEGER];
    else {
      const p = m.powerLevel;
      [power, role, sortKey] = [p, p >= 100 ? "Admin" : p >= 50 ? "Mod" : "Member", p];
    }
    const [roleName, roleColor] = membership === "invite" ? ["Invited", ""] : membership === "ban" ? ["Banned", ""] : roleBadgeFrom(st, m.userId, power);
    const [tagName, tagColor] = membership === "join" ? tagBadgeFrom(st, m.userId) : ["", ""];
    let group: string, groupColor: string, tier: number;
    if (membership === "invite") [group, groupColor, tier] = ["Invited", "", 2];
    else if (membership === "ban") [group, groupColor, tier] = ["Banned", "", 3];
    else if (st.active()) {
      const top = st.rolesOf(m.userId)[0];
      [group, groupColor, tier] = top && top.hoist ? [top.name, top.color, 0] : ["Member", "", 1];
    } else [group, groupColor, tier] = [role, "", role === "Member" ? 1 : 0];
    rows.push({ mxid: m.userId, name: rawName(m), avatar: m.avatarMxc, power, role, membership, sortKey, roleName, roleColor, group, groupColor, tier, tagName, tagColor });
  }
  const bytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => a.tier - b.tier || b.sortKey - a.sortKey || bytes(a.group, b.group) || bytes(a.name.toLowerCase(), b.name.toLowerCase()));
  return rows;
}

function roleColorWord(role: string): string {
  if (role === "Admin") return "var(--th-roles-badge-admin-fg)";
  if (role === "Mod") return "var(--th-roles-badge-mod-fg)";
  if (role === "Banned") return "var(--th-roles-badge-banned-fg)";
  if (role === "Invited") return "var(--th-roles-badge-invited-fg)";
  return "var(--th-roles-badge-default-fg)";
}
function groupLabel(section: string): string {
  if (section === "Admin") return "Admins";
  if (section === "Mod") return "Moderators";
  if (section === "" || section === "Member") return "Members";
  return section;
}

// ---- room permissions (RoomController myPower / canX) ----------------------------------------------------

interface RoomPerms {
  myPower: number;
  canChangeName: boolean;
  canChangeTopic: boolean;
  canInvite: boolean;
  canKick: boolean;
  canBan: boolean;
  canChangePower: boolean;
}

/** The level a room action needs (Matrix defaults: invite 0, kick/ban/redact 50; integers only). */
function actionLevel(pl: Record<string, unknown> | undefined, key: string, def: number): number {
  const v = pl?.[key];
  return typeof v === "number" && Number.isInteger(v) ? v : def;
}

function useRoomPerms(roomId: string): RoomPerms {
  const pl = usePowerLevels(roomId);
  const me = peekClient()?.getUserId() ?? "";
  return useMemo(() => {
    const room = peekClient()?.getRoom(roomId);
    if (!room || !me) return { myPower: 0, canChangeName: false, canChangeTopic: false, canInvite: false, canKick: false, canBan: false, canChangePower: false };
    const st = room.currentState;
    const my = powerLevelOf(room, me);
    const myRaw = room.getMember(me)?.powerLevel ?? my;
    const plc = st.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as Record<string, unknown> | undefined;
    return {
      myPower: my,
      canChangeName: st.maySendStateEvent(EventType.RoomName, me),
      canChangeTopic: st.maySendStateEvent(EventType.RoomTopic, me),
      canInvite: myRaw >= actionLevel(plc, "invite", 0),
      canKick: myRaw >= actionLevel(plc, "kick", 50),
      canBan: myRaw >= actionLevel(plc, "ban", 50),
      canChangePower: st.maySendStateEvent(EventType.RoomPowerLevels, me),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, me, pl]);
}

// ---- the panel -------------------------------------------------------------------------------------------

// 11.0 (ISLANDS-ARCH §2.8): Back and Escape close the panel only while it OVERLAYS the conversation (a narrow page)
let overlaid = false;
export function rightPanelIsOverlay(): boolean {
  return overlaid;
}

export function RightPanel({ roomId, mobile, framed }: RightPanelProps) {
  const ff = useFormFactor();
  const isMobile = mobile ?? ff === "mobile";
  const open = useRightPanelStore((st) => st.open);
  const callFill = useCall((c) => c.shown && c.maximized);
  const island = useIsland();
  if (isMobile) return open ? <MobileSheet roomId={roomId} /> : null;
  if (island) return <IslandPanel roomId={roomId} shown={open} overlay={island.z > 0 && island.z < 10} framed={!!framed} />;
  return <DesktopDock roomId={roomId} shown={open && !callFill} />;
}

/** The dock host's `panel` island (the island is in the layout while the panel is open; z 2 = overlaid). */
function IslandPanel({ roomId, shown, overlay, framed }: { roomId: string; shown: boolean; overlay: boolean; framed: boolean }) {
  useEffect(() => {
    overlaid = overlay;
    return () => {
      overlaid = false;
    };
  }, [overlay]);
  if (!shown) return null;
  return (
    <div className={framed ? cx(s.islandPanel, s.islandPanelFramed) : s.islandPanel}>
      <PanelBody roomId={roomId} />
    </div>
  );
}

function DesktopDock({ roomId, shown }: { roomId: string; shown: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [pageW, setPageW] = useState(10000);
  const [mounted, setMounted] = useState(shown);
  useLayoutEffect(() => {
    const parent = wrap.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setPageW(parent.clientWidth));
    ro.observe(parent);
    setPageW(parent.clientWidth);
    return () => ro.disconnect();
  }, []);
  // keep the content mounted through the close animation
  useEffect(() => {
    if (shown) setMounted(true);
    else {
      const t = window.setTimeout(() => setMounted(false), 160);
      return () => window.clearTimeout(t);
    }
  }, [shown]);
  const docked = pageW >= DOCK_MIN;
  useEffect(() => {
    overlaid = !docked;
    return () => {
      overlaid = false;
    };
  }, [docked]);
  const w = shown ? PANEL_WIDTH : 0;
  return (
    <div ref={wrap} className={s.dock} style={{ width: docked ? w : 0 }} data-docked={docked ? "1" : "0"} aria-hidden={!shown}>
      <div className={s.clip} style={{ width: w }}>
        {mounted && (
          <div className={s.panel} style={{ width: PANEL_WIDTH }}>
            <PanelBody roomId={roomId} />
          </div>
        )}
      </div>
    </div>
  );
}

function MobileSheet({ roomId }: { roomId: string }) {
  const name = useRoomName(roomId);
  // phones: the browser / Android back button closes room info instead of leaving the room (fix/polish 5)
  useBackToClose(true, closeRightPanel);
  return (
    <div className={s.sheet} role="dialog" aria-label="Room info">
      <div className={s.sheetHeader}>
        <button type="button" className={s.back} aria-label="Back" onClick={closeRightPanel}>
          <Icon name="go-previous-symbolic" size={22} />
        </button>
        <span className={s.sheetTitle}>{name || "Room info"}</span>
      </div>
      <div className={s.sheetBody}>
        <PanelBody roomId={roomId} mobile />
      </div>
    </div>
  );
}

/** rooms whose member list was re-fetched this page session (see store.freshMembers) */
const freshened = new Set<string>();

function PanelBody({ roomId, mobile }: { roomId: string; mobile?: boolean }) {
  const tab = useRightPanelStore((st) => st.tab);
  useEffect(() => {
    if (!roomId || freshened.has(roomId)) return;
    freshened.add(roomId);
    void freshMembers(roomId);
  }, [roomId]);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [roomId, tab]);
  const members = useMembers(roomId, "all");
  const container = useContainer(roomId);
  const st = useRolesState(container);
  const rows = useMemo(() => buildMemberRows(members, st), [members, st]);
  const joinedCount = rows.filter((r) => r.membership === "join").length;
  const perms = useRoomPerms(roomId);
  const spaceId = useMemo(() => spaceOf(roomId), [roomId, container]); // eslint-disable-line react-hooks/exhaustive-deps
  const inSpace = spaceId.startsWith("!");

  return (
    <div className={cx(s.column, mobile && s.mColumn)}>
      <div className={s.header}>
        <BasicButton text="Info" checked={tab === 0} onClick={() => setRightPanelTab(0)} className={s.tabBtn} />
        <BasicButton text={`Members${joinedCount > 0 ? ` · ${joinedCount}` : ""}`} checked={tab === 1} onClick={() => setRightPanelTab(1)} className={s.tabBtn} />
        <span className={s.fill} />
        {tab === 0 && (perms.canChangeName || perms.canChangeTopic) && (
          <BasicToolButton
            iconName={editing ? "dialog-cancel-symbolic" : "document-edit-symbolic"}
            display="iconOnly"
            tip={editing ? "Cancel editing" : "Edit room info"}
            onClick={() => setEditing((v) => !v)}
          />
        )}
        {tab === 1 && inSpace && <ToolButton iconName="configure-symbolic" tip="Space settings — roles and who's in the space" onClick={() => openSpaceSettingsIntent(spaceId, "overview")} />}
      </div>
      {tab === 0 ? (
        <InfoPane roomId={roomId} editing={editing} setEditing={setEditing} perms={perms} />
      ) : (
        <MembersPane roomId={roomId} rows={rows} perms={perms} inSpace={inSpace} spaceId={spaceId} />
      )}
    </div>
  );
}

// ---- Info ----------------------------------------------------------------------------------------------------

function InfoPane({ roomId, editing, setEditing, perms }: { roomId: string; editing: boolean; setEditing: (v: boolean) => void; perms: RoomPerms }) {
  const name = useRoomName(roomId);
  const avatar = useRoomAvatar(roomId);
  const dm = useDmFace(roomId); // selfhost/firstrun item 6: a DM's card is its person, as in the room list
  const topicC = useRoomState<{ topic?: string }>(roomId, EventType.RoomTopic, "");
  const aliasC = useRoomState<{ alias?: string }>(roomId, EventType.RoomCanonicalAlias, "");
  const enc = useRoomState(roomId, EventType.RoomEncryption, "");
  const room = peekClient()?.getRoom(roomId);
  const loaded = !!room;
  const topic = typeof topicC?.topic === "string" ? topicC.topic : "";
  const alias = typeof aliasC?.alias === "string" ? aliasC.alias : "";
  const encrypted = !!enc && Object.keys(enc).length > 0;
  // optimistic name/topic (room.rs patch_summary)
  const [opt, setOpt] = useState<{ name?: string; topic?: string }>({});
  useEffect(() => setOpt({}), [roomId, name, topic]);
  const shownName = opt.name ?? name;
  const shownTopic = opt.topic ?? topic;

  const [nameText, setNameText] = useState("");
  const [topicText, setTopicText] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setNameText(shownName);
    setTopicText(shownTopic);
    requestAnimationFrame(() => (perms.canChangeName ? nameRef.current?.focus() : topicRef.current?.focus()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const save = () => {
    if (perms.canChangeName && nameText !== shownName) {
      setOpt((o) => ({ ...o, name: nameText }));
      void renameRoom(roomId, nameText).then((ok) => !ok && setOpt((o) => ({ ...o, name: undefined })));
    }
    if (perms.canChangeTopic && topicText !== shownTopic) {
      setOpt((o) => ({ ...o, topic: topicText }));
      void setRoomTopic(roomId, topicText).then((ok) => !ok && setOpt((o) => ({ ...o, topic: undefined })));
    }
    setEditing(false);
  };

  const activity = useRoomActivity(roomId);
  const [game, setGame] = useState("");

  if (!loaded) return <Loading text="Loading room info…" />;
  return (
    <ScrollArea className={s.fillArea} contentClassName={s.infoContent}>
      <div className={s.infoAvatar}>
        <Avatar size={72} name={shownName} seed={avatarSeed(roomId, dm.peer)} imageSource={avatar || dm.avatar} />
      </div>
      {!editing && <div className={s.roomName}>{shownName}</div>}
      {!editing && alias && <div className={s.alias}>{alias}</div>}
      {editing && (
        <div className={s.editor}>
          {perms.canChangeName && <div className={s.smallBold}>Room name</div>}
          {perms.canChangeName && <BasicTextField ref={nameRef} placeholder="Room name" value={nameText} onChange={(e) => setNameText(e.target.value)} onAccepted={save} />}
          {perms.canChangeTopic && <div className={s.smallBold}>Topic</div>}
          {perms.canChangeTopic && (
            <textarea ref={topicRef} className={s.basicArea} placeholder="Topic" value={topicText} onChange={(e) => setTopicText(e.target.value)} rows={3} />
          )}
          <div className={s.editorButtons}>
            <span className={s.fill} />
            <BasicButton text="Cancel" onClick={() => setEditing(false)} />
            <BasicButton text="Save" icon="dialog-ok-apply-symbolic" onClick={save} />
          </div>
        </div>
      )}
      <div className={s.encRow}>
        <span className={cx(s.encPill, encrypted && s.encOn)}>
          <Icon name={encrypted ? "channel-secure-symbolic" : "channel-insecure-symbolic"} size={16} color={encrypted ? "var(--th-panel-encryption-fg-active)" : "var(--th-panel-encryption-fg)"} />
          <span>{encrypted ? "Encrypted" : "Not encrypted"}</span>
        </span>
      </div>
      {!editing && shownTopic && (
        <>
          <Separator />
          <div className={s.topic} dangerouslySetInnerHTML={{ __html: linkify(shownTopic) }} />
        </>
      )}
      <Separator />
      <div className={s.smallBold}>Now playing</div>
      {activity && (
        <div className={s.gameRow}>
          {!activity.emoji && <Icon name="applications-games-symbolic" size={16} color="var(--th-panel-activity-fg)" className={s.gameIcon} />}
          <span className={s.gameText}>
            {(activity.emoji ? `${activity.emoji} ` : "") + activity.game + (activity.setBy ? `  ·  ${localpart(activity.setBy)}` : "")}
          </span>
        </div>
      )}
      <div className={s.fieldRow}>
        <BasicTextField
          className={s.growField}
          placeholder="What are you playing?"
          value={game}
          onChange={(e) => setGame(e.target.value)}
          onAccepted={(v) => {
            if (!v) return;
            // re-setting the same game keeps the shared join code (MQ:8008)
            void setActivity(roomId, v, "", activity && activity.game === v ? activity.code : "");
            setGame("");
          }}
        />
        {activity && <BasicToolButton iconName="dialog-cancel-symbolic" display="iconOnly" tip="Clear now playing" onClick={() => void setActivity(roomId, "")} />}
      </div>
    </ScrollArea>
  );
}

// ---- Members ---------------------------------------------------------------------------------------------------

const TTL = [
  { t: "15m", v: 15 },
  { t: "30m", v: 30 },
  { t: "1h", v: 60 },
  { t: "3h", v: 180 },
  { t: "∞", v: 0 },
];

function MembersPane({ roomId, rows, perms, inSpace, spaceId }: { roomId: string; rows: RoomMemberRow[]; perms: RoomPerms; inSpace: boolean; spaceId: string }) {
  const ink = useContentInk();
  const isDm = useIsDirect(roomId);
  const myStatus = useMyStatus(roomId);
  const statuses = useRoomStatuses(roomId);
  const statusOf = useMemo(() => new Map(statuses.map((x) => [x.userId, x.text])), [statuses]);
  const [statusText, setStatusText] = useState("");
  const [ttl, setTtl] = useState(1);
  const [invite, setInvite] = useState("");
  const me = peekClient()?.getUserId() ?? "";

  // member menu state (actor captured when the menu opens)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; row: RoomMemberRow } | null>(null);
  const [powerMenu, setPowerMenu] = useState<{ at: { x: number; y: number }; row: RoomMemberRow } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "kick" | "ban"; row: RoomMemberRow } | null>(null);
  const [card, setCard] = useState<{ mxid: string; name: string; avatar: string | null } | null>(null);

  const canActOn = (r: RoomMemberRow) => r.mxid !== me && perms.myPower > r.power;
  const actionable = (r: RoomMemberRow) => canActOn(r) && (perms.canKick || perms.canBan || perms.canChangePower);
  const openMenu = (e: { clientX: number; clientY: number }, r: RoomMemberRow) => setMenu({ at: { x: e.clientX, y: e.clientY }, row: r });

  const sections = useMemo(() => {
    const out: Array<{ key: string; label: string; color: string; rows: RoomMemberRow[] }> = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.key === r.group) last.rows.push(r);
      else out.push({ key: r.group, label: "", color: "", rows: [r] });
    }
    for (const sec of out) {
      const n = rows.filter((r) => r.group === sec.key).length;
      sec.label = `${groupLabel(sec.key)} — ${n}`;
      const withColor = rows.find((r) => r.group === sec.key && r.groupColor);
      sec.color = withColor ? withColor.groupColor : roleColorWord(sec.key);
    }
    return out;
  }, [rows]);

  if (rows.length === 0) return <Loading text="Loading members…" />;
  return (
    <>
      {!isDm && (
        <div className={s.statusBox}>
          <div className={s.smallBold}>Your status</div>
          <div className={s.fieldRow}>
            <BasicTextField
              className={s.growField}
              placeholder={myStatus || "Looking to play…"}
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              onAccepted={(v) => {
                if (!v) return;
                void postStatus(roomId, v, TTL[ttl].v);
                setStatusText("");
              }}
            />
            <ComboBox variant="basic" model={TTL} textRole="t" currentIndex={ttl} onActivated={(i) => setTtl(i)} className={s.ttl} aria-label="How long" />
            {myStatus && <BasicToolButton iconName="dialog-cancel-symbolic" display="iconOnly" tip="Clear your status" onClick={() => void postStatus(roomId, "", 0)} />}
          </div>
        </div>
      )}
      {perms.canInvite && (
        <div className={cx(s.fieldRow, s.inviteRow)}>
          <BasicTextField
            className={s.growField}
            placeholder="Invite @user:server…"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            onAccepted={(v) => {
              if (v.trim()) {
                void inviteToRoom(roomId, v.trim());
                setInvite("");
              }
            }}
          />
          <BasicToolButton
            iconName="list-add-user"
            display="iconOnly"
            tip="Invite"
            disabled={!invite.trim()}
            onClick={() => {
              if (invite.trim()) {
                void inviteToRoom(roomId, invite.trim());
                setInvite("");
              }
            }}
          />
        </div>
      )}
      <ScrollArea className={s.fillArea} contentClassName={s.list}>
        {sections.map((sec) => (
          <div key={sec.key + sec.rows[0].mxid} role="group" aria-label={sec.label}>
            <div className={s.secHeader} style={{ color: ink(sec.color) }}>
              {sec.label}
            </div>
            {sec.rows.map((r) => (
              <MemberRowView
                key={r.mxid}
                row={r}
                status={statusOf.get(r.mxid) ?? ""}
                showMore={actionable(r)}
                menuTarget={menu?.row.mxid === r.mxid || powerMenu?.row.mxid === r.mxid}
                onClick={() => openUserProfile(r.mxid, roomId)}
                onMenu={(e) => actionable(r) && openMenu(e, r)}
              />
            ))}
          </div>
        ))}
      </ScrollArea>

      {menu && (
        <Menu open modal anchor={menu.at} onClose={() => setMenu(null)} title={menu.row.name}>
          <MenuItem text="View profile" icon="user-identity" onTriggered={() => setCard({ mxid: menu.row.mxid, name: menu.row.name, avatar: menu.row.avatar })} />
          <MenuSeparator />
          {perms.canChangePower && menu.row.membership === "join" && (
            <MenuItem text="Change role…" icon="system-users-symbolic" onTriggered={() => setPowerMenu({ at: menu.at, row: menu.row })} />
          )}
          {perms.canChangePower && (perms.canKick || perms.canBan) && <MenuSeparator />}
          {perms.canKick && menu.row.membership !== "ban" && (
            <MenuItem text={menu.row.membership === "invite" ? "Withdraw invite…" : "Kick…"} icon="im-kick-user-symbolic" onTriggered={() => setConfirm({ kind: "kick", row: menu.row })} />
          )}
          {perms.canBan && menu.row.membership !== "ban" && <MenuItem text="Ban…" icon="im-ban-user-symbolic" onTriggered={() => setConfirm({ kind: "ban", row: menu.row })} />}
          {perms.canBan && menu.row.membership === "ban" && <MenuItem text="Unban" icon="checkmark-symbolic" onTriggered={() => void unbanInRoom(roomId, menu.row.mxid)} />}
          {inSpace && perms.canChangePower && <MenuSeparator />}
          {inSpace && perms.canChangePower && <MenuItem text="Manage roles…" icon="configure-symbolic" onTriggered={() => openSpaceSettingsIntent(spaceId, "members")} />}
        </Menu>
      )}
      {powerMenu && (
        <Menu open modal anchor={powerMenu.at} onClose={() => setPowerMenu(null)} title="Change role">
          {[
            { t: "Admin", v: 100 },
            { t: "Moderator", v: 50 },
            { t: "Member", v: 0 },
          ]
            .filter((x) => x.v < perms.myPower)
            .map((x) => (
              <CheckMenuItem key={x.v} text={x.t} checked={powerMenu.row.power === x.v} onTriggered={() => void setMemberPower(roomId, powerMenu.row.mxid, x.v)} />
            ))}
        </Menu>
      )}
      <ConfirmDialog
        open={confirm?.kind === "kick"}
        onClose={() => setConfirm(null)}
        dialogTitle={confirm?.row.membership === "invite" ? "Withdraw invite?" : "Kick member?"}
        confirmText={confirm?.row.membership === "invite" ? "Withdraw" : "Kick"}
        destructive
        message={
          confirm?.row.membership === "invite"
            ? `Withdraw the invite for ${confirm?.row.name}? They can be invited again later.`
            : `Remove ${confirm?.row.name} from this room? They can rejoin if it's public or re-invited.`
        }
        onConfirmed={() => confirm && void kickFromRoom(roomId, confirm.row.mxid, "")}
      />
      <ConfirmDialog
        open={confirm?.kind === "ban"}
        onClose={() => setConfirm(null)}
        dialogTitle="Ban member?"
        confirmText="Ban"
        destructive
        message={`Ban ${confirm?.row.name} from this room? They won't be able to rejoin until unbanned.`}
        onConfirmed={() => confirm && void banFromRoom(roomId, confirm.row.mxid, "")}
      />
      {card && <ProfileCardPopup roomId={roomId} mxid={card.mxid} name={card.name} avatar={card.avatar} onClose={() => setCard(null)} />}
    </>
  );
}

function MemberRowView({
  row,
  status,
  showMore,
  menuTarget,
  onClick,
  onMenu,
}: {
  row: RoomMemberRow;
  status: string;
  showMore: boolean;
  /** this row's menu is open: its ⋯ stays up (native shows EVERY actionable row's ⋯ while any
   *  member menu is open, shifting their badges — not replicated, docs/native-bugs/spaces.md) */
  menuTarget: boolean;
  onClick: () => void;
  onMenu: (e: RMouseEvent) => void;
}) {
  const ink = useContentInk();
  const nameRef = useRef<HTMLSpanElement>(null);
  useTip(nameRef, row.mxid, { delay: 500 });
  const lp = useLongPress((pt) => showMore && onMenu({ clientX: pt.x, clientY: pt.y } as RMouseEvent));
  // REACH §2.6 place 3: a dot on each member's avatar (the order is not changed); A4.5: a custom status
  // takes the row's secondary line as a chip
  const pres = usePresence(row.mxid);
  const chip = pres ? viewOf(pres).chip : null;
  const hasTag = !!row.tagName;
  const badgeName = hasTag ? row.tagName : row.roleName;
  const badgeColor = hasTag ? row.tagColor : row.roleColor;
  const showBadge = !!badgeName && badgeName !== "Member" && badgeName !== "Everyone";
  return (
    <div
      className={cx(s.row, showMore && menuTarget && s.rowMenuOpen)}
      role="button"
      tabIndex={0}
      onPointerDown={lp.onPointerDown}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerCancel={lp.onPointerCancel}
      onClick={lp.guardClick(() => onClick())}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
    >
      <span className={s.rowBg} />
      <Avatar size={32.4} name={row.name || row.mxid} seed={row.mxid} imageSource={row.avatar} {...avatarDot(pres, "var(--row-surface)")} />
      <span className={s.rowText}>
        <span ref={nameRef} className={s.rowName} style={{ color: (row.tagColor && ink(row.tagColor)) || senderColor(row.mxid) }}>
          {row.name || localpart(row.mxid)}
        </span>
        {chip ? (
          <span className={s.rowSub} data-member-status="">
            <StatusChip text={chip.text} color={chip.color} />
          </span>
        ) : (
          <span className={cx(s.rowSub, status && s.rowStatus)}>{status || row.mxid}</span>
        )}
      </span>
      {showBadge && <RoleBadge name={badgeName} color={badgeColor || roleColorWord(badgeName)} />}
      {showMore && (
        <BasicToolButton
          className={s.more}
          iconName="view-more-symbolic"
          display="iconOnly"
          tip="More"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e);
          }}
        />
      )}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 12000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={s.loading}>
      {!slow && <BusyIndicator size={36} color="var(--th-loader-spinner-fg)" />}
      <div className={s.loadingText}>{slow ? "Still loading — the server may be slow or unreachable. Close and reopen this panel to try again." : text}</div>
    </div>
  );
}

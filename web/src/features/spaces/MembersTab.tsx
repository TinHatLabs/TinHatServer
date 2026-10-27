// MembersTab.tsx — SSW Members: search (288 px, Esc clears), filter pills All / Invited / Banned,
// the Invite button + popover, the list grouped by top role (pluralised) / Invited / Banned, rows
// with role chips + membership pill + ⋯, the member menu (anchored 45 px in from the row's left at
// its bottom, in window coordinates), the Roles submenu (checkable, rank-gated), kick/ban confirms.
import { useEffect, useMemo, useRef, useState } from "react";
import { openUserProfile, toast } from "@/core/bus";
import {
  Avatar,
  CheckMenuItem,
  ConfirmDialog,
  EmptyState,
  GlowButton,
  Menu,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
  ScrollArea,
  TextField,
  BasicToolButton,
  localpart,
  senderColor,
  useTip,
  cx,
  useContentInk,
} from "@/ui";
import { spaceActions, useSpaceAdmin, type MemberRow } from "./store";
import { RoleBadge } from "./RoleBadge";
import { InvitePopover } from "./InvitePopover";
import { openOrCreateDm } from "./roomActions";
import { PersonMenuItems } from "@/features/safety";
import { useLongPress } from "./longPress";
import { MiddleElide } from "./MiddleElide";
import { useCenterOnWindow } from "./winGeom";
import s from "./SpaceSettings.module.css";

type Filter = "all" | "invited" | "banned";

function pluralRole(name: string) {
  if (name === "Admin") return "Admins";
  if (name === "Moderator") return "Moderators";
  return name;
}

interface VisibleRow extends MemberRow {
  section: string;
  sectionColor: string;
}

export function MembersTab({ mobile, onManageRoles }: { mobile?: boolean; onManageRoles: () => void }) {
  const ink = useContentInk();
  const members = useSpaceAdmin((st) => st.members);
  const roles = useSpaceAdmin((st) => st.roles);
  const summary = useSpaceAdmin((st) => st.summary);
  const rolesActive = useSpaceAdmin((st) => st.rolesActive);
  const myRank = useSpaceAdmin((st) => st.myRank);
  const busy = useSpaceAdmin((st) => st.busy);
  const spaceId = useSpaceAdmin((st) => st.spaceId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    setQuery("");
    setFilter("all");
  }, [spaceId]);

  const counts = useMemo(() => {
    let j = 0,
      i = 0,
      b = 0;
    for (const m of members) {
      if (m.membership === "invite") i++;
      else if (m.membership === "ban") b++;
      else j++;
    }
    return { j, i, b };
  }, [members]);

  const visible: VisibleRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: VisibleRow[] = [];
    for (const m of members) {
      if (filter === "all" && m.membership !== "join") continue;
      if (filter === "invited" && m.membership !== "invite") continue;
      if (filter === "banned" && m.membership !== "ban") continue;
      if (q && !m.name.toLowerCase().includes(q) && !m.mxid.toLowerCase().includes(q)) continue;
      const section = m.membership === "invite" ? "Invited" : m.membership === "ban" ? "Banned" : m.topRole?.name ? pluralRole(m.topRole.name) : "Members";
      const sectionColor =
        m.membership === "invite"
          ? "var(--th-roles-badge-invited-fg)"
          : m.membership === "ban"
            ? "var(--th-roles-badge-banned-fg)"
            : m.topRole?.color
              ? m.topRole.color
              : "var(--th-roles-badge-default-fg)";
      out.push({ ...m, section, sectionColor });
    }
    return out;
  }, [members, query, filter]);

  const sections = useMemo(() => {
    const out: Array<{ name: string; color: string; count: number; rows: VisibleRow[] }> = [];
    for (const r of visible) {
      const last = out[out.length - 1];
      if (last && last.name === r.section) last.rows.push(r);
      else out.push({ name: r.section, color: r.sectionColor, count: 0, rows: [r] });
    }
    for (const sec of out) {
      sec.count = visible.filter((r) => r.section === sec.name).length;
      sec.color = visible.find((r) => r.section === sec.name)?.sectionColor ?? "var(--th-roles-badge-default-fg)";
    }
    return out;
  }, [visible]);

  // ---- menus / dialogs (actor captured when a menu opens) ----
  const [actor, setActor] = useState<MemberRow | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [rolesAt, setRolesAt] = useState<{ x: number; y: number } | null>(null);
  const [actorRoles, setActorRoles] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"kick" | "ban" | null>(null);
  const kickStyle = useCenterOnWindow(dialog === "kick");
  const banStyle = useCenterOnWindow(dialog === "ban");
  const [inviteOpen, setInviteOpen] = useState(false);
  const actorName = actor ? actor.name || localpart(actor.mxid) : "";
  const spaceName = summary?.name ?? "";

  const openMenu = (row: MemberRow, el: HTMLElement | null, pt?: { x: number; y: number }) => {
    setActor(row);
    setActorRoles([...row.roles]);
    if (pt) setMenuAt(pt);
    else if (el) {
      const r = el.getBoundingClientRect();
      setMenuAt({ x: r.left + 45, y: r.bottom });
    }
  };

  const toggleRole = (id: string, assignable: boolean) => {
    if (!actor) return;
    if (!assignable) {
      toast("You can't give a role ranked above yours", { timeoutMs: 3000 });
      return;
    }
    const next = actorRoles.filter((r) => r !== id);
    if (!actorRoles.includes(id)) next.push(id);
    setActorRoles(next);
    spaceActions.setMemberRoles(actor.mxid, next);
  };

  const searchRef = useRef<HTMLInputElement>(null);

  const empty = (() => {
    if (!summary) return <EmptyState loading title="Loading members…" />;
    if (visible.length > 0) return null;
    if (query.trim()) return <EmptyState iconName={filter === "banned" ? "im-ban-user-symbolic" : filter === "invited" ? "list-add-user" : "system-users-symbolic"} title="No matches" explanation="Try part of a name, or the @user:server id." />;
    if (filter === "invited")
      return <EmptyState iconName="list-add-user" title="Nobody's invited" explanation={summary.canInvite ? "Invite someone with the button above." : "Pending invites show up here."} />;
    if (filter === "banned") return <EmptyState iconName="im-ban-user-symbolic" title="Nobody's banned" explanation="People you ban from the space are listed here so you can unban them." />;
    if (busy && members.length === 0) return <EmptyState loading title="Loading members…" />;
    return <EmptyState iconName="system-users-symbolic" title="Nobody here yet" />;
  })();

  return (
    <div className={cx(s.membersTab, mobile && s.mMembers)}>
      <div className={s.toolbar}>
        <TextField
          ref={searchRef}
          className={s.search}
          placeholder="Search by name or id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
          aria-label="Search members"
        />
        <div className={s.pills}>
          <Pill label="All" count={counts.j} on={filter === "all"} onClick={() => setFilter("all")} />
          <Pill label="Invited" count={counts.i} on={filter === "invited"} onClick={() => setFilter("invited")} />
          <Pill label="Banned" count={counts.b} on={filter === "banned"} onClick={() => setFilter("banned")} />
        </div>
        <span className={s.fill} />
        {summary?.canInvite && <GlowButton text="Invite" icon="list-add-user" onClick={() => setInviteOpen(true)} />}
      </div>
      {empty ?? (
        <ScrollArea className={s.memberScroll} contentClassName={s.memberList}>
          {sections.map((sec, i) => (
            <div key={`${sec.name}-${i}`} role="group" aria-label={sec.name}>
              <div className={s.sectionHeader} style={{ color: ink(sec.color) }}>
                {`${sec.name} — ${sec.count}`}
              </div>
              {sec.rows.map((r) => (
                <MemberRowView
                  key={r.mxid}
                  row={r}
                  roles={roles}
                  mobile={mobile}
                  menuTarget={!!menuAt && actor?.mxid === r.mxid}
                  onView={() => openUserProfile(r.mxid, spaceId)}
                  onMenu={(el, pt) => openMenu(r, el, pt)}
                />
              ))}
            </div>
          ))}
        </ScrollArea>
      )}

      {menuAt && actor && (
        <Menu open modal anchor={menuAt} onClose={() => setMenuAt(null)} title={actorName}>
          <MenuItem text="View profile" icon="user-identity" onTriggered={() => openUserProfile(actor.mxid, spaceId)} />
          {!actor.isMe && actor.membership === "join" && <MenuItem text="Message" icon="mail-message-new-symbolic" onTriggered={() => void openOrCreateDm(actor.mxid)} />}
          {!actor.isMe && <PersonMenuItems mxid={actor.mxid} roomId={spaceId} name={actorName} />}
          {rolesActive && actor.canEditRoles && actor.membership === "join" && (
            <>
              <MenuSeparator />
              <MenuItem
                text="Roles…"
                icon="security-medium-symbolic"
                onTriggered={() => {
                  // popped at (memberMenu.x + gridUnit, memberMenu.y + rolesItem.y): items 40 px, separators 13 px
                  const y = 40 + (!actor.isMe && actor.membership === "join" ? 40 : 0) + 13;
                  setRolesAt({ x: menuAt.x + 18, y: menuAt.y + y });
                }}
              />
            </>
          )}
          {((actor.canKick && actor.membership !== "ban") || actor.canBan) && <MenuSeparator />}
          {actor.canKick && actor.membership !== "ban" && (
            <MenuItem text={actor.membership === "invite" ? "Withdraw invite…" : "Remove from space…"} icon="im-kick-user-symbolic" onTriggered={() => setDialog("kick")} />
          )}
          {actor.canBan && actor.membership !== "ban" && <MenuItem text="Ban from space…" icon="im-ban-user-symbolic" onTriggered={() => setDialog("ban")} />}
          {actor.canBan && actor.membership === "ban" && <MenuItem text="Unban" icon="checkmark-symbolic" onTriggered={() => spaceActions.unban(actor.mxid)} />}
          <MenuSeparator />
          <MenuItem text="Manage roles…" icon="configure-symbolic" onTriggered={onManageRoles} />
        </Menu>
      )}
      {rolesAt && actor && (
        <Menu open modal anchor={rolesAt} placement="at" onClose={() => setRolesAt(null)} title={`Roles for ${actorName}`}>
          {!mobile && (
            <MenuSectionLabel>
              <span className={s.rolesFor}>Roles for {actorName}</span>
            </MenuSectionLabel>
          )}
          {roles
            .filter((r) => !r.isEveryone)
            .map((r) => {
              const assignable = r.rank <= myRank;
              return (
                <RoleCheckItem key={r.id} name={r.name || r.id} checked={actorRoles.includes(r.id)} assignable={assignable} onTriggered={() => toggleRole(r.id, assignable)} />
              );
            })}
          <MenuSeparator />
          <MenuItem text="Manage roles…" icon="configure-symbolic" onTriggered={onManageRoles} />
        </Menu>
      )}
      <ConfirmDialog
        open={dialog === "kick"}
        style={kickStyle}
        onClose={() => setDialog(null)}
        dialogTitle={actor?.membership === "invite" ? "Withdraw invite?" : "Remove from the space?"}
        confirmText={actor?.membership === "invite" ? "Withdraw" : "Remove"}
        destructive
        askReason={actor?.membership !== "invite"}
        message={
          actor?.membership === "invite"
            ? `Withdraw the invite for ${actorName}? They can be invited again later.`
            : `Remove ${actorName} from ${spaceName || "this space"} and its rooms? They can come back with a new invite.`
        }
        onConfirmed={(reason) => actor && spaceActions.kick(actor.mxid, reason)}
      />
      <ConfirmDialog
        open={dialog === "ban"}
        style={banStyle}
        onClose={() => setDialog(null)}
        dialogTitle="Ban from the space?"
        confirmText="Ban"
        destructive
        askReason
        message={`Ban ${actorName} from ${spaceName || "this space"} and its rooms? They can't rejoin until unbanned.`}
        onConfirmed={(reason) => actor && spaceActions.ban(actor.mxid, reason)}
      />
      {inviteOpen && <InvitePopover onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

function RoleCheckItem({ name, checked, assignable, onTriggered }: { name: string; checked: boolean; assignable: boolean; onTriggered: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, assignable ? "" : "You can't give a role ranked above yours", { delay: 300 });
  return (
    <div ref={ref} style={{ opacity: assignable ? 1 : 0.5 }}>
      <CheckMenuItem text={name} checked={checked} onTriggered={onTriggered} />
    </div>
  );
}

function Pill({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx(s.pill, on && s.pillOn)} onMouseDown={(e) => e.preventDefault()} onClick={onClick} aria-pressed={on}>
      <span className={s.pillLabel}>{label}</span>
      <span className={s.pillCount}>{count}</span>
    </button>
  );
}

function MemberRowView({
  row,
  roles,
  mobile,
  menuTarget,
  onView,
  onMenu,
}: {
  row: VisibleRow;
  roles: ReadonlyArray<{ id: string; name: string; color: string }>;
  /** phones: the chips go on their own line under the mxid (the row grows) */
  mobile?: boolean;
  menuTarget: boolean;
  onView: () => void;
  onMenu: (el: HTMLElement | null, pt?: { x: number; y: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lp = useLongPress(() => onMenu(ref.current));
  const ink = useContentInk();
  const nameColor = (row.tag?.color && ink(row.tag.color)) || senderColor(row.mxid);
  const opacity = row.membership === "invite" ? 0.75 : row.membership === "ban" ? 0.5 : 1;
  const second = row.membership === "ban" && row.reason ? `${row.mxid}  ·  ${row.reason}` : row.mxid;
  const chips =
    row.membership !== "ban" && row.roles.length > 0 ? (
      <div className={s.chips}>
        {row.roles.map((id) => {
          const r = roles.find((x) => x.id === id);
          return <RoleBadge key={id} compact name={r ? r.name || id : id} color={r?.color ?? ""} />;
        })}
      </div>
    ) : null;
  return (
    <div
      ref={ref}
      className={cx(s.mRow, menuTarget && s.mRowTarget)}
      role="button"
      tabIndex={0}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={lp.onPointerDown}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerCancel={lp.onPointerCancel}
      onClick={lp.guardClick(onView)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onView();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(ref.current);
      }}
    >
      <Avatar size={36} name={row.name || row.mxid} seed={row.mxid} imageSource={row.avatar} style={{ opacity }} />
      <div className={s.mRowText}>
        <div className={s.mRowLine1}>
          <span className={s.mRowName} style={{ color: nameColor }}>
            {row.name || localpart(row.mxid)}
          </span>
          {row.isMe && <span className={s.you}>you</span>}
        </div>
        <MiddleElide className={s.mRowSub} text={second} />
        {mobile && chips}
      </div>
      {!mobile && chips}
      {row.membership !== "join" && <span className={cx(s.statePill, row.membership === "ban" && s.statePillBan)}>{row.membership === "invite" ? "Invited" : "Banned"}</span>}
      <BasicToolButton
        className={cx(s.more, menuTarget && s.moreOn)}
        iconName="view-more-symbolic"
        display="iconOnly"
        tip="More"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(ref.current);
        }}
      />
    </div>
  );
}

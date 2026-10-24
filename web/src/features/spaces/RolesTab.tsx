// RolesTab.tsx — SSW Roles: the not-set-up card ("Set up roles"), or the role list (234 px) + editor
// (name, rank, colour swatches + hex, tag hint, hoist, 17 permission rows with enforcement chips) with
// the always-visible action bar, and the footer strip (out-of-sync pill + Sync now).
// State machine = SSW:241-327 with two intended-behaviour fixes (docs/native-bugs/spaces.md):
//   * the tab opens with the first role (Admin) selected (native first-open race leaves none);
//   * a remote edit of the selected role shows up unless the USER edited the draft (native compares
//     the draft against the NEW role, so any remote edit counted as a local draft and never showed).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  CheckBox,
  ConfirmDialog,
  GlowButton,
  HintLabel,
  Icon,
  InlineMessage,
  ScrollArea,
  SectionLabel,
  Separator,
  TextField,
  useThemeColours,
  useTip,
  cx,
} from "@/ui";
import { gateOfPermission, useOffered } from "@/core/server";
import { PERMISSIONS } from "./model";
import { spaceActions, useSpaceAdmin, type RoleRow } from "./store";
import { toneOf } from "./RoleBadge";
import { useCenterOnWindow } from "./winGeom";
import s from "./SpaceSettings.module.css";

interface Draft {
  name: string;
  color: string;
  rank: number;
  perms: string[];
  hoist: boolean;
}

const sameSet = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const draftOf = (r: RoleRow, fallbackColor: string): Draft => ({
  name: r.name || "",
  color: r.color || fallbackColor,
  rank: Number(r.rank || 0),
  perms: [...(r.permissions || [])],
  hoist: r.hoist !== undefined ? r.hoist !== false : true,
});
const draftEq = (d: Draft, e: Draft) =>
  d.name === e.name && d.color.toLowerCase() === e.color.toLowerCase() && d.rank === e.rank && sameSet(d.perms, e.perms) && d.hoist === e.hoist;

const GROUPS = (() => {
  const out: Array<{ group: string; items: typeof PERMISSIONS }> = [];
  for (const p of PERMISSIONS) {
    let g = out.find((x) => x.group === p.group);
    if (!g) out.push((g = { group: p.group, items: [] }));
    (g.items as (typeof PERMISSIONS)[number][]).push(p);
  }
  return out;
})();

export function RolesTab({ mobile, visible }: { mobile?: boolean; visible: boolean }) {
  const permOn = useOffered(gateOfPermission);
  const roles = useSpaceAdmin((st) => st.roles);
  const rolesActive = useSpaceAdmin((st) => st.rolesActive);
  const summary = useSpaceAdmin((st) => st.summary);
  const busy = useSpaceAdmin((st) => st.busy);
  const myRank = useSpaceAdmin((st) => st.myRank);
  // role colour defaults: the theme's accent roles — they become wire data (a new role's colour), so they are the
  // role values themselves (byte-identical to the old palette's accent / accentBright), never an element token
  const { colour: role } = useThemeColours();
  const accent = role["accent.base"];
  const accentBright = role["accent.bright"];
  const canManageRoles = !!summary?.canManageRoles;
  const outOfSync = summary?.outOfSyncRooms ?? 0;

  const [editRoleId, setEditRoleId] = useState("");
  const [editIsNew, setEditIsNew] = useState(false);
  const [d, setD] = useState<Draft>({ name: "", color: accent, rank: 0, perms: [], hoist: true });
  const loaded = useRef<Draft>(d); // what the draft was seeded from (for "did the user edit it")
  const [rankText, setRankText] = useState("0");
  const [hexText, setHexText] = useState("");
  const [pending, setPending] = useState<string>(""); // role id or "__new__" behind the discard prompt
  const [pendingSelectName, setPendingSelectName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteStyle = useCenterOnWindow(deleteOpen);
  const pendingStyle = useCenterOnWindow(!!pending);
  const [mobileEditor, setMobileEditor] = useState(false);

  const editRole = editIsNew ? null : (roles.find((r) => r.id === editRoleId) ?? null);
  const editIsEveryone = !!editRole?.isEveryone;
  const editIsBuiltin = !editIsNew && !!editRole && ["admin", "moderator", "everyone"].includes(editRole.id);
  const editEditable = editIsNew ? canManageRoles : !!editRole?.editable;
  const editIsAdminRank = !editIsNew && !!editRole && editRole.rank >= 100;
  const open = editIsNew || !!editRole;
  const roleDirty = editIsNew ? d.name.trim().length > 0 || d.perms.length > 0 : !!editRole && !draftEq(d, draftOf(editRole, accent));
  const roleValid = d.name.trim().length > 0 && /^#[0-9a-fA-F]{6}$/.test(d.color) && d.rank >= 0 && d.rank <= 100;
  const swatches = [accent, "#e8b923", "#4da3ff", "#ff5d73", "#4ad295", "#c084fc", "#f97316", "#8a8f98"];

  const load = (next: Draft) => {
    setD(next);
    loaded.current = next;
    setRankText(String(next.rank));
    setHexText(next.color);
  };
  const loadRole = (r: RoleRow) => load(draftOf(r, accent));
  const selectFirst = () => {
    if (roles.length > 0) {
      setEditIsNew(false);
      setEditRoleId(roles[0].id);
      loadRole(roles[0]);
    }
  };
  const newDraft = (): Draft => ({ name: "", color: accentBright, rank: Math.max(1, Math.min(99, myRank - 1)), perms: [], hoist: true });

  const selectRole = (id: string) => {
    if (id === editRoleId && !editIsNew) {
      if (mobile) setMobileEditor(true);
      return;
    }
    if (roleDirty) {
      setPending(id);
      return;
    }
    const r = roles.find((x) => x.id === id);
    if (!r) return;
    setEditIsNew(false);
    setEditRoleId(id);
    loadRole(r);
    if (mobile) setMobileEditor(true);
  };
  const newRole = () => {
    if (roleDirty) {
      setPending("__new__");
      return;
    }
    setEditIsNew(true);
    setEditRoleId("");
    load(newDraft());
    if (mobile) setMobileEditor(true);
  };
  const save = () => {
    if (!roleValid) return;
    const payload = { id: editIsNew ? "" : editRoleId, name: d.name.trim(), color: d.color.toLowerCase(), rank: d.rank, permissions: [...d.perms], hoist: d.hoist };
    spaceActions.saveRole(payload);
    if (editIsNew) setPendingSelectName(payload.name);
    loaded.current = { ...d };
  };
  const discard = () => {
    if (editIsNew) {
      setEditIsNew(false);
      setEditRoleId("");
      selectFirst();
    } else if (editRole) loadRole(editRole);
  };

  // onRolesChanged
  useEffect(() => {
    if (!rolesActive) return;
    if (pendingSelectName) {
      const hit = roles.find((r) => r.name === pendingSelectName);
      if (hit) {
        setPendingSelectName("");
        setEditIsNew(false);
        setEditRoleId(hit.id);
        loadRole(hit);
        return;
      }
    }
    if (editIsNew) return;
    const r = roles.find((x) => x.id === editRoleId);
    if (!r) {
      selectFirst();
      return;
    }
    // the user's own edits are kept; otherwise the (possibly remote) new values show — and only
    // when the role really changed, so a refresh never clobbers a half-typed hex / rank field
    const fresh = draftOf(r, accent);
    if (draftEq(d, loaded.current) && !draftEq(fresh, loaded.current)) loadRole(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, rolesActive]);
  // opening / switching to the tab with nothing selected → the first role (Admin)
  useEffect(() => {
    if (visible && rolesActive && !editRoleId && !editIsNew) selectFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rolesActive, roles.length]);

  const setupCard = (
    <div className={s.setupWrap}>
      <div className={s.setupCard}>
        <Icon name="security-medium-symbolic" size={22} color="var(--th-roles-setup-icon)" active />
        <div className={s.setupTitle}>Roles aren't set up in this space</div>
        <div className={s.setupText}>
          Tin Hat will create Admin, Moderator and Everyone from the current admins and moderators. Nothing changes for anyone until you edit a role.
        </div>
        {canManageRoles ? (
          <div className={s.setupBtn}>
            <GlowButton text="Set up roles" busy={busy} disabled={busy} onClick={() => spaceActions.setupRoles()} />
          </div>
        ) : (
          <HintLabel className={s.center}>Ask an admin — only people with Manage roles can set this up.</HintLabel>
        )}
      </div>
    </div>
  );

  if (!summary) return null;
  if (!rolesActive) return setupCard;

  const list = (
    <div className={cx(s.roleListCol, mobile && s.mRoleListCol)}>
      <ScrollArea className={s.fillArea} contentClassName={s.roleList}>
        {roles.map((r) => (
          <RoleListRow key={r.id} role={r} selected={!editIsNew && r.id === editRoleId} onClick={() => selectRole(r.id)} />
        ))}
      </ScrollArea>
      {canManageRoles && (
        <Button flat icon="list-add-symbolic" text="New role" className={cx(s.newRole, editIsNew && s.newRoleOn)} onClick={newRole} />
      )}
    </div>
  );

  const editor = (
    <div className={s.editorCol}>
      {mobile && (
        <button type="button" className={s.mBackToRoles} onClick={() => setMobileEditor(false)}>
          <Icon name="go-previous-symbolic" size={18} />
          <span>Roles</span>
        </button>
      )}
      <ScrollArea className={s.fillArea} contentClassName={cx(s.form, !open && s.formDisabled)}>
        {open && !editEditable && (
          <InlineMessage type="information" text={canManageRoles ? "You can't edit a role ranked at or above yours." : "Only people with Manage roles can edit roles. You can still look."} />
        )}
        <div className={s.nameRankRow}>
          <div className={s.nameCol}>
            <SectionLabel>Name</SectionLabel>
            <NameField value={d.name} disabled={!open || !editEditable || editIsEveryone} everyone={editIsEveryone} onChange={(v) => setD({ ...d, name: v })} />
          </div>
          <div className={s.rankCol}>
            <SectionLabel>Rank</SectionLabel>
            <div className={s.rankRow}>
              {!editIsAdminRank && !editIsEveryone ? (
                <TextField
                  className={s.rankField}
                  inputMode="numeric"
                  value={rankText}
                  disabled={!open || !editEditable}
                  aria-label="Rank"
                  onChange={(e) => {
                    const t = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                    setRankText(t);
                    const v = parseInt(t, 10);
                    setD({ ...d, rank: isNaN(v) ? 0 : Math.max(0, Math.min(99, v)) });
                  }}
                />
              ) : (
                <>
                  <span className={s.rankFixed}>{editIsAdminRank ? "100" : "0"}</span>
                  <span className={s.rankFixedNote}>{editIsAdminRank ? "fixed" : "everyone"}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <HintLabel>Higher ranks can manage lower ranks. Admin is 100.</HintLabel>
        <SectionLabel className={s.mt4}>Colour</SectionLabel>
        <div className={s.colourRow}>
          <div className={s.swatches}>
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className={cx(s.swatch, d.color.toLowerCase() === c.toLowerCase() && s.swatchOn)}
                style={{ background: c, opacity: editEditable ? 1 : 0.5 }}
                disabled={!open || !editEditable}
                aria-label={`Colour ${c}`}
                onClick={() => {
                  setD({ ...d, color: c.toLowerCase() });
                  setHexText(c.toLowerCase());
                }}
              />
            ))}
          </div>
          <TextField
            className={s.hexField}
            placeholder="#rrggbb"
            value={hexText}
            disabled={!open || !editEditable}
            aria-label="Colour hex"
            onChange={(e) => {
              const raw = e.target.value;
              const m = /#?[0-9a-fA-F]{0,6}/.exec(raw.replace(/[^#0-9a-fA-F]/g, ""));
              const t0 = m ? m[0] : "";
              setHexText(t0);
              let t = t0.trim();
              if (t && t[0] !== "#") t = `#${t}`;
              if (/^#[0-9a-fA-F]{6}$/.test(t)) setD({ ...d, color: t.toLowerCase() });
            }}
          />
          <span className={s.preview} style={{ background: roleValid ? d.color : "transparent" }} />
        </div>
        {!editIsEveryone && (
          <HintLabel className={s.mt2}>
            {editIsBuiltin
              ? "Admin and Moderator keep the colour for their badge only — names in chat stay as they are. Make a role of your own to colour and tag people."
              : "People with this role get their name in this colour and the role as a tag next to it, in chat and in the member list."}
          </HintLabel>
        )}
        {!editIsEveryone && (
          <CheckBox text="Show them as their own group in the member list" checked={d.hoist} disabled={!open || !editEditable} onToggled={(v) => setD({ ...d, hoist: v })} />
        )}
        <SectionLabel className={s.mt8}>Permissions</SectionLabel>
        {editIsEveryone && <HintLabel>Everyone's permissions are the baseline for every member.</HintLabel>}
        {/* selfhost/firstrun item 1: a permission for a feature the server doesn't offer is not shown (a role keeps it) */}
        {GROUPS.filter((g) => g.items.some((p) => permOn(p.key))).map((g) => (
          <div key={g.group} className={s.permGroup}>
            <div className={s.groupLabel}>{g.group}</div>
            {g.items.filter((p) => permOn(p.key)).map((p) => (
              <PermRow
                key={p.key}
                label={p.label}
                description={p.description}
                honour={p.enforcement === "client"}
                checked={d.perms.includes(p.key)}
                editable={open && editEditable}
                onToggle={(on) => setD({ ...d, perms: on ? [...d.perms.filter((k) => k !== p.key), p.key] : d.perms.filter((k) => k !== p.key) })}
              />
            ))}
          </div>
        ))}
        <div style={{ height: 8, flex: "none" }} />
      </ScrollArea>
      {open && (
        <div className={cx(s.actionBar, roleDirty && editEditable && s.actionBarDirty)}>
          <span className={cx(s.actionText, roleDirty && editEditable && s.actionTextDirty)}>
            {roleDirty && editEditable
              ? editIsNew
                ? roleValid
                  ? "New role — not created yet"
                  : "Give the role a name to create it"
                : "Unsaved changes"
              : "Changes apply to every room in this space"}
          </span>
          {roleDirty && <Button flat text="Discard" onClick={discard} />}
          {roleDirty && editEditable && <GlowButton text={editIsNew ? "Create role" : "Save changes"} busy={busy} disabled={busy || !roleValid} onClick={save} />}
          {!editIsNew && !!editRole && editRole.deletable && !editIsEveryone && !roleDirty && (
            <Button flat text="Delete role" className={s.deleteRole} onClick={() => setDeleteOpen(true)} />
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={cx(s.rolesTab, mobile && s.mRolesTab)}>
      <div className={s.rolesRow}>
        {mobile ? (
          mobileEditor && open ? editor : list
        ) : (
          <>
            {list}
            <div className={s.vsep} />
            {editor}
          </>
        )}
      </div>
      <div className={s.footer} hidden={mobile && mobileEditor && open && outOfSync === 0}>
        <Icon name="view-list-details-symbolic" size={16} color="var(--th-space-settings-hint-fg)" />
        <span className={s.footerText}>Roles apply to every room in this space</span>
        {outOfSync > 0 && (
          <span className={s.warnPill}>
            {outOfSync} {outOfSync === 1 ? "room" : "rooms"} out of sync
          </span>
        )}
        {outOfSync > 0 && canManageRoles && <Button text="Sync now" icon="view-refresh-symbolic" className={s.btn28} disabled={busy} onClick={() => spaceActions.syncRooms()} />}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        style={deleteStyle}
        onClose={() => setDeleteOpen(false)}
        dialogTitle="Delete role?"
        confirmText="Delete"
        destructive
        message={`Delete "${d.name}"? People who have it lose it; nothing else changes. Every room's permissions are re-synced.`}
        onConfirmed={() => {
          if (!editIsNew && editRoleId) spaceActions.deleteRole(editRoleId);
        }}
      />
      <ConfirmDialog
        open={!!pending}
        style={pendingStyle}
        onClose={() => setPending("")}
        dialogTitle="Discard changes?"
        confirmText="Discard"
        cancelText="Keep editing"
        destructive
        message={`You have unsaved changes to ${editIsNew ? "the new role" : `"${d.name}"`}.`}
        onConfirmed={() => {
          const id = pending;
          setPending("");
          if (id === "__new__") {
            setEditIsNew(true);
            setEditRoleId("");
            load(newDraft());
            if (mobile) setMobileEditor(true);
          } else {
            const r = roles.find((x) => x.id === id);
            if (!r) return;
            setEditIsNew(false);
            setEditRoleId(id);
            loadRole(r);
            if (mobile) setMobileEditor(true);
          }
        }}
        onCancelled={() => setPending("")}
      />
    </div>
  );
}

function NameField({ value, disabled, everyone, onChange }: { value: string; disabled: boolean; everyone: boolean; onChange: (v: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  useTip(wrap, everyone ? "Everyone is the baseline role — it can't be renamed" : "");
  return (
    <div ref={wrap}>
      <TextField placeholder="Role name" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="Role name" />
    </div>
  );
}

function RoleListRow({ role, selected, onClick }: { role: RoleRow; selected: boolean; onClick: () => void }) {
  return (
    <div
      className={cx(s.roleRow, selected && s.roleRowOn, role.isEveryone && s.roleRowEveryone)}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      // a Qt MouseArea click leaves keyboard focus where it was (the rail keeps its ring)
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className={s.roleDot} style={{ background: role.color ? toneOf(role.color) : "var(--th-roles-badge-default-fg)" }} />
      <span className={s.roleName}>{role.name}</span>
      {role.isEveryone ? <Icon name="system-users-symbolic" size={14} color="var(--th-space-settings-hint-fg)" /> : <span className={s.roleCount}>{role.memberCount}</span>}
    </div>
  );
}

function PermRow({
  label,
  description,
  honour,
  checked,
  editable,
  onToggle,
}: {
  label: string;
  description: string;
  honour: boolean;
  checked: boolean;
  editable: boolean;
  onToggle: (on: boolean) => void;
}) {
  const chip = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useTip(
    chip,
    honour
      ? "Honour system: Tin Hat hides or blocks this, but a modified client could ignore it."
      : "Server-enforced: the homeserver or the Tin Hat server refuses it — a modified client can't get around it.",
    { delay: 300 },
  );
  useTip(box, editable ? "" : "You can't edit a role ranked at or above yours.");
  return (
    <div className={s.permRow}>
      <div ref={box} className={s.permCheck}>
        <CheckBox checked={checked} disabled={!editable} onToggled={onToggle} aria-label={label} />
      </div>
      <div className={s.permText}>
        <div className={s.permLabel} onClick={() => editable && onToggle(!checked)}>
          {label}
        </div>
        <HintLabel>{description}</HintLabel>
      </div>
      <span ref={chip} className={cx(s.enfChip, honour ? s.enfHonour : s.enfServer)}>
        {honour ? "Honour system" : "Server-enforced"}
      </span>
    </div>
  );
}


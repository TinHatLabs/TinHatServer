// RoomsTab.tsx — SSW Rooms: "N room(s)[ · N out of sync | · all in sync]" + Sync all, the not-set-up
// hint, rows (32 px squircle avatar, bold name, "Not joined" pill, Synced / Out of sync chip, Sync),
// empty state. Sync / Sync all reconcile the whole space (v1, like native onSyncRoom).
import { Avatar, Button, EmptyState, HintLabel, ScrollArea, cx } from "@/ui";
import { spaceActions, useSpaceAdmin } from "./store";
import s from "./SpaceSettings.module.css";

export function RoomsTab({ mobile }: { mobile?: boolean }) {
  const rooms = useSpaceAdmin((st) => st.rooms);
  const rolesActive = useSpaceAdmin((st) => st.rolesActive);
  const summary = useSpaceAdmin((st) => st.summary);
  const busy = useSpaceAdmin((st) => st.busy);
  const canManageRoles = !!summary?.canManageRoles;
  const outOfSync = summary?.outOfSyncRooms ?? 0;
  const n = rooms.length;
  const head = `${n} ${n === 1 ? "room" : "rooms"}${rolesActive ? (outOfSync > 0 ? `  ·  ${outOfSync} out of sync` : n > 0 ? "  ·  all in sync" : "") : ""}`;
  return (
    <div className={cx(s.roomsTab, mobile && s.mRoomsTab)}>
      <div className={s.roomsHead}>
        <span className={s.roomsHeadText}>{head}</span>
        {rolesActive && canManageRoles && <Button text="Sync all" icon="view-refresh-symbolic" disabled={busy || outOfSync === 0} onClick={() => spaceActions.syncRooms()} />}
      </div>
      {!rolesActive && <HintLabel>Set up roles (Roles tab) to keep every room's permissions in step with the space.</HintLabel>}
      {n === 0 ? (
        busy ? (
          <EmptyState loading title="Loading rooms…" />
        ) : (
          <EmptyState iconName="view-list-details-symbolic" title="No rooms in this space yet" explanation="Rooms you create inside the space, or add to it, show up here." />
        )
      ) : (
        <ScrollArea className={s.fillArea} contentClassName={s.roomList}>
          {rooms.map((r) => (
            <div key={r.id} className={s.roomRow}>
              <Avatar size={32} radius={8} name={r.name} seed={r.id} imageSource={r.avatar} style={{ opacity: r.joined ? 1 : 0.6 }} />
              <span className={cx(s.roomName, !r.joined && s.roomNameDim)}>{r.name}</span>
              {!r.joined && <span className={s.notJoined}>Not joined</span>}
              {rolesActive && r.joined && <span className={cx(s.syncChip, r.synced ? s.syncOk : s.syncWarn)}>{r.synced ? "Synced" : "Out of sync"}</span>}
              {rolesActive && r.canSync && !r.synced && <Button text="Sync" className={s.btn28} disabled={busy} onClick={() => spaceActions.syncRooms()} />}
            </div>
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

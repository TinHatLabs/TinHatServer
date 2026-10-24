// __debug.tsx — FOUNDATION-CORE's self-test page (not product UI). Rendered by the router at
// #/__core-debug (FOUNDATION-UI) or standalone from tools/core-debug.html. It exercises the core
// contracts end to end: session state, crypto status, owned IndexedDB names, the room hooks
// (useRooms/useRoomName/useUnread/useRoomAvatar) and authenticated media (useMxcUrl).
import { useEffect, useState, type CSSProperties } from "react";
import { runCoreSelfTest, type Check } from "@/core/selftest";
import {
  listOwnedDatabases,
  logout,
  restoreSession,
  useCryptoStatus,
  useMxcUrl,
  useRoomAvatar,
  useRoomName,
  useRooms,
  useSession,
  useAccountData,
  useDirectRoomIds,
  useMember,
  useMembers,
  usePowerLevels,
  useRoomState,
  useRoomStateAll,
  useRoomStateEvents,
  useRoomTags,
  useSpaceChildren,
  useSpaces,
  useTimeline,
  useTyping,
  useUnread,
  useUserProfile,
} from "@/core/matrix";

const box: CSSProperties = {
  border: "1px solid var(--th-border-strong, #333)",
  borderRadius: 8,
  padding: 10,
  margin: "8px 0",
};

function RoomRow({ roomId }: { roomId: string }) {
  const name = useRoomName(roomId);
  const unread = useUnread(roomId);
  const mxc = useRoomAvatar(roomId);
  const src = useMxcUrl(mxc, { width: 48, height: 48, method: "crop" });
  return (
    <li data-room-id={roomId} data-avatar-loaded={src ? "1" : "0"} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
      <span style={{ width: 24, height: 24, borderRadius: 12, overflow: "hidden", background: "var(--th-surface-raised, #222)", flex: "none" }}>
        {src ? <img src={src} width={24} height={24} alt="" /> : null}
      </span>
      <span className="tw-room-name">{name || roomId}</span>
      {unread.count > 0 ? <span style={{ opacity: 0.7 }}>({unread.count}{unread.highlight ? "!" : ""})</span> : null}
    </li>
  );
}

function Me({ userId }: { userId: string }) {
  const p = useUserProfile(userId);
  const src = useMxcUrl(p.avatarUrl, { width: 64, height: 64, method: "crop" });
  return (
    <div id="tw-me" data-avatar-loaded={src ? "1" : "0"} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {src ? <img id="tw-me-avatar" src={src} width={32} height={32} style={{ borderRadius: 16 }} alt="" /> : null}
      <b>{p.displayName ?? userId}</b>
    </div>
  );
}

/** First avatar mxc we can find (room avatar, else any member's) → fetched through useMxcUrl. */
function AvatarProbe() {
  const rooms = useRooms();
  let mxc: string | null = null;
  for (const r of rooms) {
    mxc = r.getMxcAvatarUrl();
    if (mxc) break;
  }
  if (!mxc) {
    outer: for (const r of rooms) {
      for (const m of r.getJoinedMembers()) {
        const a = m.getMxcAvatarUrl();
        if (a) {
          mxc = a;
          break outer;
        }
      }
    }
  }
  const src = useMxcUrl(mxc, { width: 64, height: 64, method: "crop" });
  return (
    <div id="tw-avatar-probe" data-mxc={mxc ?? ""} data-loaded={src ? "1" : "0"} style={box}>
      avatar probe: {mxc ?? "(no avatar anywhere)"} {src ? <img src={src} width={48} height={48} style={{ verticalAlign: "middle", borderRadius: 24 }} alt="" /> : "…"}
    </div>
  );
}

/** useTimeline on the first room: live event count + back-pagination (read-only). */
function TimelineProbe({ roomId }: { roomId: string }) {
  const tl = useTimeline(roomId);
  return (
    <div id="tw-timeline-probe" data-count={tl.events.length} data-can-back={tl.canPaginateBack ? "1" : "0"} style={box}>
      timeline {roomId}: <b id="tw-tl-count">{tl.events.length}</b> events, canPaginateBack={String(tl.canPaginateBack)} loading=
      {String(tl.loadingBack)}{" "}
      <button id="tw-tl-back" onClick={() => void tl.paginateBack(30)}>
        load older
      </button>
      <div style={{ opacity: 0.7 }}>last: {tl.events.slice(-3).map((e) => e.getType()).join(", ")}</div>
    </div>
  );
}

/** Every remaining room/space hook on the first room + first space, as data attributes for the gate. */
function HooksProbe({ roomId, me }: { roomId: string; me: string }) {
  const members = useMembers(roomId);
  const meMember = useMember(roomId, me);
  const create = useRoomState(roomId, "m.room.create");
  const memberStates = useRoomStateAll(roomId, "m.room.member");
  const memberEvents = useRoomStateEvents(roomId, "m.room.member");
  const pl = usePowerLevels(roomId);
  const typing = useTyping(roomId);
  const tags = useRoomTags(roomId);
  const push = useAccountData("m.push_rules");
  const direct = useDirectRoomIds();
  const spaces = useSpaces();
  const children = useSpaceChildren(spaces[0]?.roomId);
  const data = {
    members: members.length,
    meMembership: meMember?.membership ?? "",
    mePower: meMember?.powerLevel ?? -1,
    createVersion: String((create as { room_version?: string } | undefined)?.room_version ?? ""),
    memberStates: memberStates.size,
    memberEvents: memberEvents.length,
    plUsers: Object.keys((pl?.users as Record<string, number> | undefined) ?? {}).length,
    typing: typing.length,
    tags: Object.keys(tags).join(","),
    pushRules: push ? 1 : 0,
    directRooms: direct.size,
    spaces: spaces.length,
    firstSpaceChildren: children.length,
  };
  return (
    <pre id="tw-hooks-probe" data-json={JSON.stringify(data)} style={box}>
      {JSON.stringify(data)}
    </pre>
  );
}

function SelfTest() {
  const [res, setRes] = useState<Check[] | null>(null);
  useEffect(() => {
    void runCoreSelfTest().then(setRes);
  }, []);
  if (!res) return <div style={box}>self-test running…</div>;
  const fails = res.filter((r) => !r.ok);
  return (
    <div id="tw-selftest" data-fails={fails.length} style={box}>
      self-test: {res.length - fails.length}/{res.length} pass
      {fails.map((f) => (
        <div key={f.name} style={{ color: "var(--th-state-danger, #f55)" }}>
          FAIL {f.name} {f.detail}
        </div>
      ))}
    </div>
  );
}

export function CoreDebugPage() {
  const s = useSession();
  const crypto = useCryptoStatus();
  const rooms = useRooms();
  const [dbs, setDbs] = useState<string[]>([]);
  useEffect(() => {
    if (s.state === "booting") void restoreSession();
  }, [s.state]);
  useEffect(() => {
    void listOwnedDatabases().then(setDbs);
  }, [s.state, s.firstSyncDone]);
  return (
    <div id="tw-core-debug" style={{ font: "13px/1.4 system-ui, sans-serif", color: "var(--th-text-primary, #ddd)", background: "var(--th-surface-window, #000)", padding: 16, minHeight: "100vh", boxSizing: "border-box", overflow: "auto" }}>
      <h2 style={{ margin: "0 0 8px" }}>core debug</h2>
      <pre id="tw-session" style={box}>{JSON.stringify(s, null, 1)}</pre>
      {s.userId ? <Me userId={s.userId} /> : null}
      <pre id="tw-crypto" style={box}>{JSON.stringify(crypto, null, 1)}</pre>
      <pre id="tw-dbs" style={box}>{JSON.stringify(dbs)}</pre>
      <SelfTest />
      {s.firstSyncDone ? <AvatarProbe /> : null}
      {s.firstSyncDone && rooms[0] ? <TimelineProbe roomId={rooms[0].roomId} /> : null}
      {s.firstSyncDone && rooms[0] && s.userId ? <HooksProbe roomId={rooms[0].roomId} me={s.userId} /> : null}
      {s.state !== "loggedOut" ? (
        <button id="tw-logout" onClick={() => void logout()}>
          Sign out
        </button>
      ) : null}
      <div style={box}>
        <b id="tw-room-count">{rooms.length}</b> rooms
        <ul id="tw-rooms" style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
          {rooms.slice(0, 60).map((r) => (
            <RoomRow key={r.roomId} roomId={r.roomId} />
          ))}
        </ul>
      </div>
    </div>
  );
}

export default CoreDebugPage;

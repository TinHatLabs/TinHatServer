// actions.ts — every Matrix write the nav makes (port of the LoginController / NavController
// invokables the nav calls: bridge.rs create_dm / create_room / join_by_link / invite_to_room /
// accept_invite / reject_invite, nav.rs mark_room_read / mark_space_read / set_favourite,
// notify.rs set_room_notification_mode, room.rs room photo, activity.rs).
// Wire shapes = shell-nav spec §4.2 byte for byte. Status sentences = the native ones; every one
// is shown as a short (4 s) toast (onMStatusChanged).
import { EventType, Preset, type ICreateRoomOpts, type MatrixClient } from "matrix-js-sdk";
import { SERVER_LABEL } from "@/core/bearer";
import { toast } from "@/core/bus";
import { ensureWritable, getClient, getSession, getState, peekClient, provisionNewRoom, sendState } from "@/core/matrix";
import { setRecordCall } from "@/features/media";
import { invalidateHierarchy, noteLeft, notePendingChild, userDefinedMode, readSpaceOrder, refreshNow, scheduleRefresh, useNavStore, type NotifyMode } from "./model";
import { openRoomId } from "./open";
import { serverOf as serverPartOf } from "./dmTarget";
import { newRoomInitialState } from "./newRoom";

export const status = (msg: string) => {
  if (msg) toast(msg, { timeoutMs: 4000 });
};

/** The server part of a room / user id; a bare id falls back to the signed-in user's own server. */
const serverOf = (id: string) => serverPartOf(id) || serverPartOf(getSession().userId);
const errText = (e: unknown) => {
  const m = (e as { data?: { error?: string }; message?: string })?.data?.error ?? (e as Error)?.message ?? String(e);
  return m;
};
export const isUserId = (s: string) => /^@[^:\s]+:[^\s]+$/.test(s);

// ---- links -------------------------------------------------------------------------------------

/** roomInviteLink(id, alias) (qml/Main.qml:1397) */
export function roomInviteLink(id: string, alias: string): string {
  return alias
    ? `https://matrix.to/#/${encodeURIComponent(alias)}`
    : `https://matrix.to/#/${encodeURIComponent(id)}?via=${encodeURIComponent(serverOf(id))}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http on a LAN IP: no async clipboard → the old textarea trick
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---- favourite / read / notify -----------------------------------------------------------------

export async function setFavourite(roomId: string, on: boolean): Promise<void> {
  const c = getClient();
  try {
    if (on) await c.setRoomTag(roomId, "m.favourite", {});
    else await c.deleteRoomTag(roomId, "m.favourite");
    toast(on ? "Added to Favourites — it moves up the list and into the ★ rail" : "Removed from Favourites", { timeoutMs: 4000 });
  } catch (e) {
    status(`Couldn't change favourites: ${errText(e)}`);
  }
  scheduleRefresh();
}

/** nav.rs newest_event_id — GET /messages?dir=b&limit=1 → chunk[0].event_id */
async function newestEventId(c: MatrixClient, roomId: string): Promise<string | null> {
  try {
    const path = `/rooms/${encodeURIComponent(roomId)}/messages`;
    const res = (await c.http.authedRequest("GET" as never, path, { dir: "b", limit: "1" })) as { chunk?: Array<{ event_id?: string }> };
    return res.chunk?.[0]?.event_id ?? null;
  } catch {
    const tl = c.getRoom(roomId)?.getLiveTimeline().getEvents() ?? [];
    return tl.length ? (tl[tl.length - 1]!.getId() ?? null) : null;
  }
}

export async function markRoomRead(roomId: string): Promise<void> {
  const c = getClient();
  const eid = await newestEventId(c, roomId);
  if (!eid) return;
  try {
    await c.setRoomReadMarkersHttpRequest(roomId, eid, eid);
  } catch {
    /* best effort (native ignores failures) */
  }
  scheduleRefresh();
}

/** A5.3: once per session, after the first live sync — a read receipt on the newest event of each joined
 *  SPACE room the server still counts (its invite's permanent "1": no client ever reads a space). */
export async function clearSpaceCounts(): Promise<number> {
  const c = getClient();
  const ids = c
    .getRooms()
    .filter((r) => r.getMyMembership() === "join" && r.isSpaceRoom() && (r.getUnreadNotificationCount() ?? 0) > 0)
    .map((r) => r.roomId);
  for (const id of ids) await markRoomRead(id).catch(() => undefined);
  return ids.length;
}

/** nav.rs mark_space_read: every joined room with notification_count > 0 that `key` owns — A5.3: spaces
 *  included (Home clears every space's count, a space its own and its sub-spaces'). */
export async function markSpaceRead(key: string, label: string): Promise<void> {
  toast(`Marking everything in ${label} as read…`, { timeoutMs: 4000 });
  const c = getClient();
  const st = useNavStore.getState();
  const parented = new Set(st.roomSpace.keys());
  const ids: string[] = [];
  const dms = new Set<string>(st.globalRooms.filter((r) => r.dm).map((r) => r.id));
  for (const r of c.getRooms()) {
    if (r.getMyMembership() !== "join") continue;
    if ((r.getUnreadNotificationCount() ?? 0) <= 0) continue;
    if (r.isSpaceRoom()) {
      if (key === "home" || key === r.roomId || (key.startsWith("!") && isChildOf(c, key, r.roomId))) ids.push(r.roomId);
      continue;
    }
    const fav = !!r.tags?.["m.favourite"];
    const owned =
      key === "home"
        ? !parented.has(r.roomId) || dms.has(r.roomId)
        : key === "favourites"
          ? fav
          : key === "people"
            ? dms.has(r.roomId)
            : key === "orphans"
              ? !parented.has(r.roomId) && !dms.has(r.roomId)
              : isChildOf(c, key, r.roomId);
    if (owned) ids.push(r.roomId);
  }
  await Promise.all(ids.map((id) => markRoomRead(id)));
}

function isChildOf(c: MatrixClient, spaceId: string, roomId: string): boolean {
  const ev = c.getRoom(spaceId)?.currentState.getStateEvents(EventType.SpaceChild, roomId);
  const via = (ev?.getContent() as { via?: unknown } | undefined)?.via;
  return Array.isArray(via) && via.length > 0;
}

/**
 * notify.rs set_room_notification_mode — PUT the new rule, then DELETE every other custom rule for
 * the room (override rules whose id is the room or that match room_id == roomId, the room rule,
 * underride likewise).
 */
type PushRulesLike = { global?: Record<string, Array<{ rule_id: string }>> };

function isDmRoom(c: MatrixClient, roomId: string): boolean {
  const d = (c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, unknown>;
  return Object.values(d).some((ids) => Array.isArray(ids) && ids.includes(roomId));
}

const notifyChains = new Map<string, Promise<void>>();
/** Changes for one room run one after another (Mute then All in quick succession must end on All). */
export function setNotifyMode(roomId: string, mode: NotifyMode, current: NotifyMode): Promise<void> {
  const prev = notifyChains.get(roomId);
  const next = (prev ?? Promise.resolve()).then(() => setNotifyModeNow(roomId, mode, current)).catch(() => {});
  notifyChains.set(roomId, next);
  void next.then(() => {
    if (notifyChains.get(roomId) === next) notifyChains.delete(roomId);
  });
  return next;
}

async function setNotifyModeNow(roomId: string, mode: NotifyMode, current: NotifyMode): Promise<void> {
  const c = getClient();
  // judge on the server's rules (the account-data echo of a change made a moment ago may not have
  // synced yet — a stale read would leave the previous mode's rule behind); local copy as fallback
  let fresh: unknown = null;
  try {
    fresh = await c.http.authedRequest("GET" as never, "/pushrules/");
  } catch {
    fresh = null;
  }
  const local = (c.getAccountData(EventType.PushRules)?.getContent() ?? c.pushRules ?? {}) as PushRulesLike;
  const rules = ((fresh as PushRulesLike | null) ?? local) as {
    global?: Record<string, Array<{ rule_id: string; conditions?: Array<{ kind?: string; key?: string; pattern?: string }> }>>;
  };
  const g = rules.global ?? {};
  const ud = userDefinedMode(rules as never, roomId);
  if (mode === (fresh ? (ud ?? (isDmRoom(c, roomId) ? "all" : "mentions")) : current)) return;
  const matches = (r: { rule_id: string; conditions?: Array<{ kind?: string; key?: string; pattern?: string }> }) =>
    r.rule_id === roomId || (r.conditions ?? []).some((cd) => cd.kind === "event_match" && cd.key === "room_id" && cd.pattern === roomId);
  const existing: Array<{ kind: "override" | "room" | "underride"; id: string }> = [];
  for (const kind of ["override", "room", "underride"] as const)
    for (const r of g[kind] ?? []) if (!r.rule_id.startsWith(".") && matches(r)) existing.push({ kind, id: r.rule_id });
  const put = (kind: string, body: unknown) =>
    c.http.authedRequest("PUT" as never, `/pushrules/global/${kind}/${encodeURIComponent(roomId)}`, undefined, body as never);
  try {
    let keep: { kind: string; id: string };
    if (mode === "mute") {
      await put("override", { conditions: [{ kind: "event_match", key: "room_id", pattern: roomId }], actions: [] });
      keep = { kind: "override", id: roomId };
    } else if (mode === "all") {
      await put("room", { actions: ["notify", { set_tweak: "sound", value: "default" }] });
      keep = { kind: "room", id: roomId };
    } else {
      await put("room", { actions: [] });
      keep = { kind: "room", id: roomId };
    }
    for (const r of existing) {
      if (r.kind === keep.kind && r.id === keep.id) continue;
      try {
        await c.http.authedRequest("DELETE" as never, `/pushrules/global/${r.kind}/${encodeURIComponent(r.id)}`);
      } catch {
        /* already gone */
      }
    }
  } catch (e) {
    status(`Couldn't change notifications: ${errText(e)}`);
  }
  scheduleRefresh();
}

// ---- membership ----------------------------------------------------------------------------------

/** The inviter of a pending invite whose own member event says `is_direct` (a DM invite), else "". */
export function dmInviter(c: MatrixClient, roomId: string): string {
  const me = c.getUserId() ?? "";
  const ev = c.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomMember, me);
  return ev && (ev.getContent() as { is_direct?: boolean }).is_direct === true ? (ev.getSender() ?? "") : "";
}

export async function acceptInvite(roomId: string, name: string): Promise<boolean> {
  const c = getClient();
  const dmWith = dmInviter(c, roomId);
  try {
    await c.joinRoom(roomId);
    // matrix-sdk (desktop) files an accepted DM invite under the inviter in m.direct; js-sdk's join
    // does not — without it the chat would land in Home as a plain room (square avatar, Mentions
    // default) instead of People
    if (dmWith) {
      try {
        const direct = { ...((c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>) };
        if (!(direct[dmWith] ?? []).includes(roomId)) {
          direct[dmWith] = [...(direct[dmWith] ?? []), roomId];
          await c.setAccountData(EventType.Direct, direct as never);
        }
      } catch {
        /* the room still works */
      }
    }
    scheduleRefresh();
    // selfhost/firstrun item 5: accepting a DM invite opens that DM (round 5: it left you in General) — once the
    // join is in the local state (≤ 4 s), so the page opens on the conversation, not on the invite
    if (dmWith) {
      await joinedLocally(c, roomId, 4000);
      openRoomId(roomId);
    }
    return true;
  } catch (e) {
    status(`Couldn't join ${name}: ${errText(e)}`);
    return false;
  }
}

/** Resolves once this client sees itself joined to the room, or after `ms` (whichever is first). */
function joinedLocally(c: MatrixClient, roomId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (c.getRoom(roomId)?.getMyMembership() === "join" || Date.now() - t0 >= ms) resolve();
      else window.setTimeout(tick, 100);
    };
    tick();
  });
}

export async function rejectInvite(roomId: string, name: string): Promise<void> {
  const c = getClient();
  if (!c.getRoom(roomId)) {
    status("That invite isn't there any more");
    return;
  }
  try {
    await c.leave(roomId);
    noteLeft(roomId);
  } catch (e) {
    status(`Couldn't decline the invite to ${name}: ${errText(e)}`);
  }
  scheduleRefresh();
}

export async function joinRoom(roomId: string): Promise<void> {
  status("Joining…");
  try {
    await getClient().joinRoom(roomId, { viaServers: [serverOf(roomId)] });
    invalidateHierarchy();
    scheduleRefresh();
  } catch {
    status("Couldn't join that room — you may need an invite.");
  }
}

export async function leaveRoom(roomId: string): Promise<boolean> {
  try {
    await getClient().leave(roomId);
    noteLeft(roomId);
    return true;
  } catch (e) {
    status(`Couldn't leave: ${errText(e)}`);
    return false;
  }
}

export async function inviteToRoom(roomId: string, mxidRaw: string): Promise<void> {
  const mxid = mxidRaw.trim();
  const c = getClient();
  if (!isUserId(mxid)) {
    status(`${mxid} doesn't look like a user id`);
    return;
  }
  if (!c.getRoom(roomId)) {
    status("That room isn't loaded yet");
    return;
  }
  status("Inviting…");
  try {
    await c.invite(roomId, mxid);
    status(`Invited ${mxid}`);
  } catch {
    status(`Couldn't invite ${mxid}`);
  }
}

// ---- join by link (room.rs parse_join_link + bridge.rs join_by_link) ------------------------------

export type JoinTarget = { kind: "join"; target: string; via: string[] } | { kind: "error"; message: string };

export function parseJoinLink(input: string): JoinTarget {
  const text = input.trim();
  if (!text) return { kind: "error", message: "Paste a link first." };
  let s = text;
  const hashAt = s.indexOf("#/");
  if (hashAt >= 0) s = s.slice(hashAt + 2);
  if (s.startsWith("room/")) s = s.slice(5);
  s = s.replace(/%21/gi, "!").replace(/%23/gi, "#").replace(/%40/gi, "@").replace(/%3A/gi, ":");
  const via: string[] = [];
  const q = s.indexOf("?");
  if (q >= 0) {
    for (const part of s.slice(q + 1).split("&")) {
      const [k, v] = part.split("=");
      if (k === "via" && v) via.push(decodeURIComponent(v));
    }
    s = s.slice(0, q);
  }
  s = s.replace(/\/+$/, "");
  // a matrix.to link to a specific event: #/!room:server/$event → the room
  const slash = s.indexOf("/");
  if (slash > 0 && /^[!#]/.test(s)) s = s.slice(0, slash);
  if (/^@[^:]+:.+/.test(s)) return { kind: "error", message: `${s} is a person, not a space — use New chat to message them.` };
  if (/^[!#][^:]+:.+/.test(s)) return { kind: "join", target: s, via };
  return { kind: "error", message: `That doesn't look like a Tin Hat link. Paste an invite link, or a room address like #general:${SERVER_LABEL}.` };
}

export async function joinByLink(text: string): Promise<string | null> {
  const p = parseJoinLink(text);
  if (p.kind === "error") {
    status(p.message);
    return null;
  }
  status("Joining…");
  try {
    const r = await getClient().joinRoom(p.target, { viaServers: p.via.length ? p.via : [serverOf(p.target)] });
    invalidateHierarchy();
    scheduleRefresh();
    return r.roomId;
  } catch {
    status("Couldn't join with that link — it may have expired, or the space may need an invite.");
    return null;
  }
}

// ---- create ------------------------------------------------------------------------------------

/** bridge.rs find_dm: a joined room in m.direct whose ACTIVE members other than me are exactly [mxid]. */
export async function findDm(mxid: string): Promise<string | null> {
  const c = getClient();
  const me = c.getUserId();
  const direct = (c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>;
  // the rooms filed under that person first (the likely hit), then every other DM
  const ids = new Set<string>(Array.isArray(direct[mxid]) ? direct[mxid] : []);
  for (const list of Object.values(direct)) if (Array.isArray(list)) for (const id of list) ids.add(id);
  for (const id of ids) {
    const r = c.getRoom(id);
    if (!r || r.getMyMembership() !== "join") continue;
    // lazy-loaded member lists miss the invitee of a fresh DM — load before judging
    try {
      await r.loadMembersIfNeeded();
    } catch {
      /* judge on what we have */
    }
    const others = r
      .getMembers()
      .filter((m) => (m.membership === "join" || m.membership === "invite") && m.userId !== me)
      .map((m) => m.userId);
    if (others.length === 1 && others[0] === mxid) return id;
  }
  return null;
}

export async function createDm(mxidRaw: string): Promise<string | null> {
  const mxid = mxidRaw.trim();
  if (!isUserId(mxid)) {
    status("That doesn't look like a user id");
    return null;
  }
  const existing = await findDm(mxid);
  if (existing) return existing;
  status("Opening…");
  const c = getClient();
  try {
    const { room_id } = await c.createRoom({
      invite: [mxid],
      is_direct: true,
      preset: Preset.TrustedPrivateChat,
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2", rotation_period_ms: 604800000, rotation_period_msgs: 100 },
        },
      ],
    });
    const direct = { ...((c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>) };
    direct[mxid] = [...(direct[mxid] ?? []).filter((x) => x !== room_id), room_id];
    try {
      await c.setAccountData(EventType.Direct, direct as never);
    } catch {
      /* the room still works */
    }
    void provisionNewRoom(room_id);
    return room_id;
  } catch (e) {
    status(`Couldn't start that chat: ${errText(e)}`);
    return null;
  }
}

export async function createRoom(o: { name: string; topic: string; isPrivate: boolean; space: boolean; parent: string | null }): Promise<string | null> {
  const name = o.name.trim();
  if (!name) {
    status("Give it a name first");
    return null;
  }
  status("Creating…");
  const c = getClient();
  const parent = !o.space && o.parent ? o.parent : null;
  const opts: ICreateRoomOpts = { name, preset: o.isPrivate ? Preset.PrivateChat : Preset.PublicChat };
  if (!o.space && o.topic.trim()) opts.topic = o.topic.trim();
  if (o.space) opts.creation_content = { type: "m.space" };
  // 2026-10-23: every room is encrypted from the start except a PUBLIC room inside a space (its members walk in
  // without an invite and read what was said before — option (a)); a space isn't (no messages). newRoom.ts — the
  // desktop's new_room.rs builds the same list (shared vectors).
  const initial = newRoomInitialState({ space: o.space, isPrivate: o.isPrivate, parent });
  if (initial.length) opts.initial_state = initial;
  try {
    const { room_id } = await c.createRoom(opts);
    await provisionNewRoom(room_id);
    if (parent) {
      // bridge.rs attach_to_space: both writes are attempted independently (the parent link is
      // what the restricted join rule checks). Native only logs a failure; the web says so
      // (docs/native-bugs/nav.md) — e.g. no power to add rooms to someone else's space.
      let childOk = true;
      try {
        await c.sendStateEvent(parent, EventType.SpaceChild, { via: [serverOf(room_id)], suggested: false } as never, room_id);
      } catch (e) {
        childOk = false;
        status(`Created, but couldn't put it in the space: ${errText(e)}`);
      }
      try {
        await c.sendStateEvent(room_id, EventType.SpaceParent, { via: [serverOf(parent)], canonical: true } as never, parent);
      } catch {
        /* logged natively only */
      }
      if (childOk) notePendingChild(room_id, parent);
    }
    if (o.space) {
      // a new space goes to the end of the saved rail order (it would anyway; keep the file tidy)
      const ord = readSpaceOrder();
      if (ord.length && !ord.includes(room_id)) {
        /* unsaved spaces keep their default position at the end — nothing to write */
      }
    }
    return room_id;
  } catch (e) {
    status(`Couldn't create it: ${errText(e)}`);
    return null;
  }
}

// ---- now playing (activity.rs set_activity) ------------------------------------------------------

export async function setActivity(roomId: string, game: string, prevGame: string, prevCode: string): Promise<void> {
  const c = getClient();
  const me = c.getUserId() ?? "";
  try {
    await ensureWritable(roomId, ["dev.tinhat.activity"]);
    if (!game) {
      await sendState(roomId, "dev.tinhat.activity", "", {});
    } else {
      const code = prevGame === game ? prevCode : "";
      const content: Record<string, unknown> = { game, setBy: me, ts: Date.now() };
      if (code) content.code = code;
      await sendState(roomId, "dev.tinhat.activity", "", content);
    }
  } catch {
    status("Couldn't set — you may not have permission in this room");
  }
  refreshNow();
}

// ---- room photo (room.rs) -------------------------------------------------------------------------

export function canChangeAvatar(roomId: string): boolean {
  const c = peekClient();
  const r = c?.getRoom(roomId);
  if (!c || !r) return false;
  return r.currentState.maySendStateEvent(EventType.RoomAvatar, c.getUserId() ?? "");
}

export async function setRoomPhoto(roomId: string, file: File): Promise<void> {
  const c = getClient();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
  try {
    const up = await c.uploadContent(file, { type, name: file.name, includeFilename: false });
    await c.sendStateEvent(roomId, EventType.RoomAvatar, { url: up.content_uri } as never, "");
  } catch (e) {
    status(`Couldn't change the photo: ${errText(e)}`);
  }
}

export async function removeRoomPhoto(roomId: string): Promise<void> {
  try {
    await getClient().sendStateEvent(roomId, EventType.RoomAvatar, {} as never, "");
  } catch (e) {
    status(`Couldn't remove the photo: ${errText(e)}`);
  }
}

// ---- record (Memories) — media area owns the controller; the nav writes the same two requests ------

export async function setRecording(roomId: string, on: boolean): Promise<void> {
  // fix/media wave 2: one implementation for the room-list row and the call-bar Rec — media's has the
  // native toasts ("Starting call recording…" → "Recording on — …"), the friendly M_FORBIDDEN text,
  // 429 retry and skips the invite when the recorder is already in the room (MED-156)
  await setRecordCall(roomId, on);
}

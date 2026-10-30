// roomActions.ts — room-level moderation + settings used by the RightPanel (room.rs apply_room_name /
// apply_room_topic / invite_user / kick_user / ban_user / unban_user / set_member_power), the
// profile card fetch (settings.rs fetch_profile_card — MSC4133 extended profile keys), the "which
// space is this room in" lookup (nav.spaceOf) and open-or-create a DM (login.createDm).
// Failures toast "Couldn't <verb> — you may not have permission in this room" (room.rs mod_err).
import { EventType, Method, Preset, Visibility, type MatrixClient } from "matrix-js-sdk";
import { openRoom, toast } from "@/core/bus";
import { peekClient, powerLevelsForWrite, sendPowerLevels, withPowerLevelLock } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { rl } from "./ratelimit";
import { goneText } from "./leftWords";

const log = createLogger("spaces.room");

const modErr = (action: string) => `Couldn't ${action} — you may not have permission in this room`;
function fail(action: string, e: unknown) {
  log.warn(`${action}: ${(e as Error)?.message ?? e}`);
  toast(modErr(action), { kind: "error", timeoutMs: 6000 });
}

/** true on success; failure toasts (room.rs mod_err) and the caller drops its optimistic value */
export async function renameRoom(roomId: string, name: string): Promise<boolean> {
  try {
    await rl(() => peekClient()!.sendStateEvent(roomId, EventType.RoomName, { name } as never, ""));
    return true;
  } catch (e) {
    fail("rename this room", e);
    return false;
  }
}

export async function setRoomTopic(roomId: string, topic: string): Promise<boolean> {
  try {
    await rl(() => peekClient()!.sendStateEvent(roomId, EventType.RoomTopic, { topic } as never, ""));
    return true;
  } catch (e) {
    fail("set the topic", e);
    return false;
  }
}

export async function inviteToRoom(roomId: string, mxid: string) {
  try {
    await rl(() => peekClient()!.invite(roomId, mxid.trim()));
  } catch (e) {
    fail("invite that user", e);
  }
}

export async function kickFromRoom(roomId: string, mxid: string, reason = "") {
  // they left (or someone else removed them) while the confirmation was open: the server would only answer with an
  // error about permissions (leftWords.ts)
  const m = peekClient()?.getRoom(roomId)?.getMember(mxid);
  const gone = goneText("room", m?.rawDisplayName || mxid, m?.membership);
  if (gone) return void toast(gone, { timeoutMs: 4000 });
  try {
    await rl(() => peekClient()!.kick(roomId, mxid, reason.trim() || undefined));
  } catch (e) {
    fail("kick that member", e);
  }
}

export async function banFromRoom(roomId: string, mxid: string, reason = "") {
  try {
    await rl(() => peekClient()!.ban(roomId, mxid, reason.trim() || undefined));
  } catch (e) {
    fail("ban that member", e);
  }
}

export async function unbanInRoom(roomId: string, mxid: string) {
  try {
    await rl(() => peekClient()!.unban(roomId, mxid));
  } catch (e) {
    fail("unban that user", e);
  }
}

/** users[mxid] = power in THIS room's m.room.power_levels (not reconciled with space roles). */
export async function setMemberPower(roomId: string, mxid: string, power: number) {
  try {
    // a person-chosen moderator action (allowed in any room); in the room's power-level queue so it can't race
    // ensureWritable / the roles reconciler (state.ts withPowerLevelLock)
    await withPowerLevelLock(roomId, async () => {
      const cur = powerLevelsForWrite(roomId);
      if (!cur) throw new Error("the room's power levels are still updating — try again in a moment");
      const users = { ...((cur.users as Record<string, number>) ?? {}) };
      users[mxid] = power;
      await rl(() => sendPowerLevels(roomId, { ...cur, users }));
    });
  } catch (e) {
    fail("change that power level", e);
  }
}

// ---- which space holds a room (nav.spaceOf) ------------------------------------------------------------

/**
 * The space a room belongs to: its canonical-first joined m.space.parent, else a joined space
 * that lists it as an m.space.child. "" when none (native returns "home" — see docs/native-bugs).
 */
export function spaceOf(roomId: string, client: MatrixClient | null = peekClient()): string {
  const room = client?.getRoom(roomId);
  if (!client || !room) return "";
  if (room.isSpaceRoom()) return roomId;
  const parents: Array<{ canonical: boolean; id: string }> = [];
  for (const ev of room.currentState.getStateEvents(EventType.SpaceParent)) {
    const c = ev.getContent() as { via?: unknown; canonical?: unknown };
    const pid = ev.getStateKey() ?? "";
    if (pid && Array.isArray(c.via) && c.via.length > 0) parents.push({ canonical: c.canonical === true, id: pid });
  }
  parents.sort((a, b) => Number(b.canonical) - Number(a.canonical));
  for (const p of parents) if (client.getRoom(p.id)?.getMyMembership() === "join") return p.id;
  for (const r of client.getRooms()) {
    if (r.getMyMembership() !== "join" || !r.isSpaceRoom()) continue;
    const ev = r.currentState.getStateEvents(EventType.SpaceChild, roomId);
    const via = (ev?.getContent() as { via?: unknown } | undefined)?.via;
    if (Array.isArray(via) && via.length > 0) return r.roomId;
  }
  return "";
}

// ---- profile card (MSC4133 extended profile) --------------------------------------------------------------

export interface ProfileCard {
  mxid: string;
  bio: string;
  accent: string;
  joinSound: string;
  loading: boolean;
}

async function profileKey(c: MatrixClient, mxid: string, key: string): Promise<string> {
  try {
    const r = await c.http.authedRequest<Record<string, unknown>>(Method.Get, `/profile/${encodeURIComponent(mxid)}/${encodeURIComponent(key)}`);
    const v = r?.[key];
    return typeof v === "string" ? v : "";
  } catch {
    return ""; // 404 = unset
  }
}

export async function fetchProfileCard(mxid: string): Promise<ProfileCard> {
  const c = peekClient();
  if (!c) return { mxid, bio: "", accent: "", joinSound: "", loading: false };
  const [bio, accent, joinSound] = await Promise.all([
    profileKey(c, mxid, "dev.tinhat.bio"),
    profileKey(c, mxid, "dev.tinhat.accent"),
    profileKey(c, mxid, "dev.tinhat.joinsound"),
  ]);
  return { mxid, bio, accent: /^#[0-9a-f]{6}$/i.test(accent.trim()) ? accent.trim() : "", joinSound, loading: false };
}

// ---- DM (login.createDm) -----------------------------------------------------------------------------------

/** Open the existing DM with `mxid` (m.direct, joined or invited), else create one and open it. */
export async function openOrCreateDm(mxid: string): Promise<void> {
  const c = peekClient();
  if (!c || !mxid) return;
  const direct = (c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>;
  for (const rid of direct[mxid] ?? []) {
    const r = c.getRoom(rid);
    const ms = r?.getMyMembership();
    if (r && (ms === "join" || ms === "invite")) {
      const other = r.getMember(mxid)?.membership;
      if (other === "join" || other === "invite" || ms === "invite") {
        openRoom(rid);
        return;
      }
    }
  }
  try {
    const res = await c.createRoom({
      is_direct: true,
      invite: [mxid],
      preset: Preset.TrustedPrivateChat,
      visibility: Visibility.Private,
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    const next = { ...direct, [mxid]: [...(direct[mxid] ?? []).filter((x) => x !== res.room_id), res.room_id] };
    await c.setAccountData(EventType.Direct, next as never);
    openRoom(res.room_id);
  } catch (e) {
    log.warn(`createDm failed: ${(e as Error)?.message ?? e}`);
    toast("Couldn't start the conversation", { kind: "error", timeoutMs: 6000 });
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export { linkify } from "./linkify";

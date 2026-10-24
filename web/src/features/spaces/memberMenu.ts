// memberMenu.ts — this area's r.memberMenu entries (ParticipantVolumeMenu.qml moderation block +
// the Message / Manage roles entries), usable by any member menu host (call participant menu,
// timeline sender menu …). Ids are prefixed "spaces-"; the call-only rows are "spaces-call-*"
// (a host that renders its own call moderation can filter those out).
//   Message · [Moderation] Mute/Unmute their mic for everyone · Disconnect from the call… ·
//   Kick from space… · Ban from space… · Manage roles…
// Kick/Ban from space are hidden when the room is not in a real space (native shows them and fails
// with "Bad space id" — fixed per DECISIONS D6, see docs/native-bugs/spaces.md).
import type { MemberMenuCtx, MenuContribution, Registries } from "@/core/registry";
import { toast } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { useCallStore } from "@/features/calls";
import { effectivePerms } from "./roles";
import { openOrCreateDm, spaceOf } from "./roomActions";
import { openSpaceSettingsIntent } from "./intents";
import { askConfirm } from "./confirmHost";
import { banIn, kickIn } from "./store";

const call = () => useCallStore.getState();
const me = () => peekClient()?.getUserId() ?? "";

function displayName(mxid: string, roomId?: string): string {
  const c = peekClient();
  const m = roomId ? c?.getRoom(roomId)?.getMember(mxid) : null;
  const dn = m?.rawDisplayName;
  if (dn && dn !== mxid) return dn;
  return mxid.replace(/^@/, "").split(":")[0];
}

/** The room the menu is about: the host's room (the nav strip opens it for another room's call), else my call's. */
function callRoom(ctx: MemberMenuCtx): string {
  return ctx.roomId || call().callRoomId || "";
}
/** The menu's person is in the call I'm in (a menu for another room's call gets no call moderation). */
function inMyCall(ctx: MemberMenuCtx): boolean {
  const c = call();
  if (!(c.inCall || c.fake)) return false;
  return !ctx.roomId || !c.callRoomId || ctx.roomId === c.callRoomId;
}
/** A tile of `mxid`: identity "@u:server:DEVICE" (the fake call's tiles carry the bare mxid). */
const isTileOf = (participant: string, mxid: string) => participant === mxid || participant.startsWith(`${mxid}:`);
// The menu's own device (ctx.identity, set by the call participant menu) wins: with the same user on
// two devices, "first tile of that mxid" moderated the wrong device (callui fix round, CORE-CHANGES).
function identityFor(mxid: string, ctx?: MemberMenuCtx): string {
  const tiles = call().tiles ?? [];
  if (ctx?.identity && tiles.some((x) => x.participant === ctx.identity)) return ctx.identity;
  const t = tiles.find((x) => x.id !== "vid_selfview" && isTileOf(x.participant, mxid));
  return t?.participant ?? "";
}
/** Server-muted? → the moderator ("" = unknown). Scoped to the menu's device when known. */
function mutedBy(mxid: string, ctx?: MemberMenuCtx): { muted: boolean; by: string } {
  const tiles = call().tiles ?? [];
  const t = ctx?.identity
    ? tiles.find((x) => x.participant === ctx.identity && x.serverMuted)
    : tiles.find((x) => isTileOf(x.participant, mxid) && x.serverMuted);
  return { muted: !!t, by: t?.serverMutedBy ?? "" };
}
function canModerate(ctx: MemberMenuCtx): boolean {
  if (ctx.userId === me() || !inMyCall(ctx)) return false;
  // PVM canModerate = mCanModerateCall only: the engine derives it from the roles model (setPermsProvider)
  // and refuses serverMute/disconnect without it, so a roles fallback here only produced refusal toasts
  return call().canModerateCall === true;
}

/** Kick / Ban / Manage roles each come in two registrations — "…-first" carries the separator of PVM:129-131
 *  ("call rows | space rows", visible only when both groups are) and shows when it is the first visible space
 *  row; the plain one shows otherwise. MenuContribution.separatorBefore is static, so this keeps it data-only. */
function addSpaceRow(r: Registries, row: MenuContribution<MemberMenuCtx>, before: ((ctx: MemberMenuCtx) => boolean)[]) {
  const shown = row.visible ?? (() => true);
  const first = (ctx: MemberMenuCtx) => !before.some((v) => v(ctx));
  r.memberMenu.add({ ...row, visible: (ctx) => shown(ctx) && !(first(ctx) && canModerate(ctx)) });
  r.memberMenu.add({ ...row, id: `${row.id}-first`, separatorBefore: true, visible: (ctx) => shown(ctx) && first(ctx) && canModerate(ctx) });
}

export function registerMemberMenu(r: Registries) {
  r.memberMenu.add({
    id: "spaces-message",
    order: 10,
    label: "Message",
    icon: "mail-message-new-symbolic",
    visible: (ctx) => ctx.userId !== me(),
    run: (ctx) => void openOrCreateDm(ctx.userId),
  });
  r.memberMenu.add({
    id: "spaces-call-mute",
    order: 100,
    section: "Moderation",
    label: (ctx) => (mutedBy(ctx.userId, ctx).muted ? "Unmute their mic for everyone" : "Mute their mic for everyone"),
    icon: (ctx) => (mutedBy(ctx.userId, ctx).muted ? "audio-input-microphone-symbolic" : "microphone-sensitivity-muted-symbolic"),
    // PVM:108-120 — shown after 600 ms by hosts that render MenuContribution.tooltip
    tooltip: (ctx) => {
      const m = mutedBy(ctx.userId, ctx);
      return m.muted ? `Muted by ${m.by ? displayName(m.by, callRoom(ctx)) : "a moderator"} — lets them talk again` : "Nobody in the call hears their mic until a moderator unmutes them";
    },
    tooltipDelay: 600,
    visible: canModerate,
    run: async (ctx) => {
      const id = identityFor(ctx.userId, ctx);
      if (!id) return void toast("They're not in the call", { timeoutMs: 4000 });
      const c = call();
      const f = mutedBy(ctx.userId, ctx).muted ? c.serverUnmute : c.serverMute;
      const why = f ? await f(id) : "Call moderation isn't available";
      if (why) toast(why, { kind: "error", timeoutMs: 4000 });
    },
  });
  r.memberMenu.add({
    id: "spaces-call-disconnect",
    order: 110,
    section: "Moderation",
    label: "Disconnect from the call…",
    icon: "call-stop-symbolic",
    visible: canModerate,
    run: (ctx) => {
      const name = displayName(ctx.userId, callRoom(ctx));
      askConfirm({
        title: "Disconnect from the call?",
        message: `Drop ${name} from this call? They can rejoin right away — use Kick or Ban to keep them out.`,
        confirmText: "Disconnect",
        destructive: true,
        onConfirmed: async () => {
          const id = identityFor(ctx.userId, ctx);
          if (!id) return void toast("They're not in the call", { timeoutMs: 4000 });
          const f = call().disconnectParticipant;
          const why = f ? await f(id) : "Call moderation isn't available";
          if (why) toast(why, { kind: "error", timeoutMs: 4000 });
        },
      });
    },
  });
  const spaceFor = (ctx: MemberMenuCtx) => spaceOf(callRoom(ctx));
  const spacePerm = (ctx: MemberMenuCtx, k: string) => !!effectivePerms(callRoom(ctx)).perms[k];
  const kickShown = (ctx: MemberMenuCtx) => spaceFor(ctx).startsWith("!") && spacePerm(ctx, "kick") && ctx.userId !== me();
  const banShown = (ctx: MemberMenuCtx) => spaceFor(ctx).startsWith("!") && spacePerm(ctx, "ban") && ctx.userId !== me();
  addSpaceRow(r, {
    id: "spaces-kick-space",
    order: 130,
    section: "Moderation",
    label: "Kick from space…",
    icon: "im-kick-user-symbolic",
    visible: kickShown,
    run: (ctx) => {
      const sid = spaceFor(ctx);
      const name = displayName(ctx.userId, callRoom(ctx));
      askConfirm({
        title: "Kick from the space?",
        message: `Remove ${name} from the space and its rooms? They can come back with a new invite.`,
        confirmText: "Kick",
        destructive: true,
        askReason: true,
        onConfirmed: (reason) => void kickIn(sid, ctx.userId, reason),
      });
    },
  }, []);
  addSpaceRow(r, {
    id: "spaces-ban-space",
    order: 140,
    section: "Moderation",
    label: "Ban from space…",
    icon: "im-ban-user-symbolic",
    visible: banShown,
    run: (ctx) => {
      const sid = spaceFor(ctx);
      const name = displayName(ctx.userId, callRoom(ctx));
      askConfirm({
        title: "Ban from the space?",
        message: `Ban ${name} from the space and its rooms? They can't rejoin until unbanned.`,
        confirmText: "Ban",
        destructive: true,
        askReason: true,
        onConfirmed: (reason) => void banIn(sid, ctx.userId, reason),
      });
    },
  }, [kickShown]);
  addSpaceRow(r, {
    id: "spaces-manage-roles",
    order: 150,
    section: "Moderation",
    label: "Manage roles…",
    icon: "configure-symbolic",
    visible: (ctx) => spaceFor(ctx).startsWith("!") && spacePerm(ctx, "manage_roles"),
    run: (ctx) => openSpaceSettingsIntent(spaceFor(ctx), "members"),
  }, [kickShown, banShown]);
}

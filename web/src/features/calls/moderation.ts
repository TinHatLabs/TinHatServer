// moderation.ts — the call-moderation client (call_ctl.rs:637-759, 2720-2795; call.rs:4789-5151):
// permissions, server mute / unmute / disconnect through the server's Tin Hat API `/api/moderation/call`, the
// `tinhat.moderation` packets, shields, being server-muted, removal notices, late-joiner
// re-announce and the moderator's auto re-enforcement of a recorded mute.
import { Track } from "livekit-client";
import { getState, peekClient, sendState, CALL_MOD_TYPE, containerOf, rolesActive } from "@/core/matrix";
import { apiJson } from "@/core/api";
import { effectivePerms } from "@/features/spaces/roles";
import { createLogger } from "@/core/log";
import { getCall, patch, setError, setStatus } from "./store";
import { sess, type Sess } from "./session";
import { hooks, rebuildTiles, reconcileMic, sendData, stopMusic, stopSound } from "./engine";
import { displayName, errText, isRecorder, localpart, mxidOf } from "./util";

const log = createLogger("call-mod");

// ---- permissions -------------------------------------------------------------------------------------

export type PermsProvider = (roomId: string, mxid: string) => Record<string, boolean> | Promise<Record<string, boolean>>;

/**
 * Fallback when the spaces feature hasn't supplied roles-aware perms: power levels.
 * moderate_calls = my PL ≥ events["dev.tinhat.call.moderation"] ‖ state_default (50).
 */
const plPerms: PermsProvider = (roomId, mxid) => {
  const r = peekClient()?.getRoom(roomId);
  const pl = (r?.currentState.getStateEvents("m.room.power_levels", "")?.getContent() ?? {}) as Record<string, unknown>;
  const users = (pl.users ?? {}) as Record<string, number>;
  const events = (pl.events ?? {}) as Record<string, number>;
  const mine = typeof users[mxid] === "number" ? users[mxid] : typeof pl.users_default === "number" ? (pl.users_default as number) : 0;
  const sd = typeof pl.state_default === "number" ? (pl.state_default as number) : 50;
  const need = (t: string) => (typeof events[t] === "number" ? events[t] : sd);
  return {
    moderate_calls: mine >= need(CALL_MOD_TYPE),
    kick: mine >= (typeof pl.kick === "number" ? (pl.kick as number) : 50),
    ban: mine >= (typeof pl.ban === "number" ? (pl.ban as number) : 50),
    manage_roles: mine >= need("m.room.power_levels"),
  };
};

let provider: PermsProvider = plPerms;

/** Integration hook: the spaces feature's roles-aware `effectivePerms(roomId, mxid)`. */
export function setPermsProvider(p: PermsProvider | null): void {
  provider = p ?? plPerms;
  void refreshPerms();
}

/** A member's rank in the call room (who may moderate whom). */
export type RankProvider = (roomId: string, mxid: string) => number;

/**
 * Default rank = the space's roles rank when roles are active, else the room power level — exactly
 * what the Tin Hat API's /moderation/call compares ("They rank at or above you"). Read-only use of the spaces
 * feature's pure `effectivePerms` (no UI, no cycle: roles.ts imports only core + its model).
 */
const rolesRank: RankProvider = (roomId, mxid) => effectivePerms(roomId, mxid).rank;

/** Power-level rank (used if the roles lookup throws). */
const plRank: RankProvider = (roomId, mxid) => {
  const r = peekClient()?.getRoom(roomId);
  const m = r?.getMember(mxid);
  if (m) return m.powerLevel === Infinity ? 100 : m.powerLevel;
  const pl = (r?.currentState.getStateEvents("m.room.power_levels", "")?.getContent() ?? {}) as Record<string, unknown>;
  const users = (pl.users ?? {}) as Record<string, number>;
  if (typeof users[mxid] === "number") return users[mxid];
  return typeof pl.users_default === "number" ? (pl.users_default as number) : 0;
};
let rankProvider: RankProvider = rolesRank;

/** Integration hook: the spaces feature's roles rank, `(roomId, mxid) => effectivePerms(roomId, mxid).rank`. */
export function setRankProvider(p: RankProvider | null): void {
  rankProvider = p ?? rolesRank;
}

/** The rank, or null when it can't be determined (callers then fail CLOSED). */
function rankOf(roomId: string, mxid: string): number | null {
  try {
    const v = rankProvider(roomId, mxid);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export async function refreshPerms(): Promise<void> {
  const s = sess();
  if (!s) {
    patch({ callPerms: {}, canModerateCall: false });
    return;
  }
  try {
    const p = await provider(s.roomId, s.me);
    if (sess() !== s) return;
    patch({ callPerms: p, canModerateCall: p.moderate_calls === true });
  } catch (e) {
    log.debug(`perms: ${errText(e)}`);
  }
}

// ---- shields ---------------------------------------------------------------------------------------------

const shields = new Map<string, { by: string; name: string }>(); // target identity → moderator
const MAX_SHIELDS = 64;
const iMuted = new Set<string>(); // targets *I* muted (late-joiner re-announce)
const enforcedThisJoin = new Set<string>();
let removal: { by: string; name: string; at: number; roomId: string } | null = null;

function label(by: string, name: string): string {
  if (name) return name;
  const s = sess();
  if (by) return displayName(s?.roomId, mxidOf(by));
  return "a moderator";
}

hooks.shieldFor = (identity: string) => {
  const m = shields.get(identity);
  return m ? { serverMuted: true, serverMutedBy: label(m.by, m.name) } : { serverMuted: false, serverMutedBy: "" };
};

const stateKeyFor = (mxid: string) => mxid.replace(/^@/, "");

hooks.micPublishBlocked = (roomId: string) => {
  const me = peekClient()?.getUserId() ?? "";
  const c = getState<{ muted?: boolean; by?: string }>(roomId, CALL_MOD_TYPE, stateKeyFor(me));
  if (c?.muted === true) return { muted: true, by: c.by ? displayName(roomId, c.by) : "A moderator" };
  return { muted: false, by: "" };
};

hooks.onRemoved.push((s) => {
  const r = removal;
  removal = null; // consumed: never explains a later, unrelated removal
  if (r && r.roomId === s.roomId && Date.now() - r.at < 60000) return label(r.by, r.name);
  return "";
});

// ---- being server-muted -------------------------------------------------------------------------------------

function selfMutedByUser(): boolean {
  const st = getCall();
  return st.micMuted || (st.pushToTalk && !st.pttSpeaking);
}

async function lockMe(s: Sess, byLabel: string) {
  if (sess() !== s) return;
  patch({ serverMuted: true, serverMutedBy: byLabel, moderationRev: getCall().moderationRev + 1 });
  if (s.mic && !s.mic.isMuted) await s.mic.mute().catch(() => undefined);
  if (sess() !== s) return;
  void stopSound();
  if (getCall().musicPlaying) void stopMusic(true);
  rebuildTiles();
}

async function unlockMe(s: Sess) {
  if (sess() !== s) return;
  patch({ serverMuted: false, serverMutedBy: "", moderationRev: getCall().moderationRev + 1 });
  s.micWanted = true;
  if (!selfMutedByUser()) {
    try {
      const pub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (s.mic && !pub?.track) await s.room.localParticipant.publishTrack(s.mic, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
      await reconcileMic(s); // the user's own mute / PTT intent decides from here
    } catch (e) {
      log.warn(`mic back after unmute: ${errText(e)}`);
    }
  }
  rebuildTiles();
}

hooks.onPermissionChanged.push((s) => {
  const perm = s.room.localParticipant.permissions;
  if (!perm) return;
  const sources = perm.canPublishSources ?? [];
  // TrackSource enum in the protocol: MICROPHONE = 2, SCREEN_SHARE_AUDIO = 4
  const micAllowed = perm.canPublish && (sources.length === 0 || sources.includes(2 as never));
  const st = getCall();
  if (!micAllowed && !st.serverMuted) {
    const me = shields.get(s.myIdentity);
    void lockMe(s, me ? label(me.by, me.name) : "");
    if (sources.length && !sources.includes(4 as never)) void stopMusic(true);
  } else if (micAllowed && st.serverMuted) {
    void unlockMe(s);
  }
});

// ---- packets ---------------------------------------------------------------------------------------------------

/**
 * May the packet's SENDER moderate `target` here? (Astra finding 11.) The same rules the Tin Hat API enforces
 * for the real action: the sender holds `moderate_calls` (roles-aware provider when spaces set it,
 * else power levels) AND outranks the target (a target ranked at or above the sender is refused).
 */
async function senderMayModerate(s: Sess, identity: string, target: string): Promise<boolean> {
  const sender = mxidOf(identity);
  const tgt = mxidOf(target);
  if (!sender || sender === tgt) return false;
  try {
    // bounded: a lookup that never answers counts as "not a moderator" (fail closed, queue keeps moving)
    const p = await Promise.race([
      Promise.resolve(provider(s.roomId, sender)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("perms lookup timed out")), 5000)),
    ]);
    if (p?.moderate_calls !== true) return false;
  } catch {
    return false;
  }
  const a = rankOf(s.roomId, sender);
  const b = rankOf(s.roomId, tgt);
  return a !== null && b !== null && a > b; // unknown rank → not honoured
}

/** Is `target` someone in this call (a remote participant or me)? */
function inCall(s: Sess, target: string): boolean {
  return target === s.myIdentity || s.room.remoteParticipants.has(target);
}

/** Our own SFU permissions still allow the mic (a real server mute removes MICROPHONE). */
function micAllowedHere(s: Sess): boolean {
  const perm = s.room.localParticipant.permissions;
  if (!perm) return true;
  const sources = perm.canPublishSources ?? [];
  return perm.canPublish && (sources.length === 0 || sources.includes(2 as never));
}

// Packets are handled strictly in arrival order (the authorization check awaits): a delayed "mute" can
// never finish after a newer "unmute" and re-lock the mic.
let packetChain: Promise<unknown> = Promise.resolve();
hooks.onData.push((s, topic, payload, from) => {
  if (topic !== "tinhat.moderation") return;
  const run = () => onModerationPacket(s, payload, from).catch((e) => log.warn(`moderation packet: ${errText(e)}`));
  packetChain = packetChain.then(run, run); // (every step finishes: the authorization lookup is bounded at 5 s)
});

async function onModerationPacket(s: Sess, payload: Record<string, unknown>, from: string): Promise<void> {
  const action = typeof payload.action === "string" ? payload.action : "";
  const target = typeof payload.target === "string" && payload.target.length <= 512 ? payload.target : "";
  const name = typeof payload.name === "string" ? payload.name.slice(0, 128) : "";
  if (!target || !action) return;
  // Only people actually in this call can carry a shield (no unbounded map of made-up targets).
  if (!inCall(s, target)) return;
  // The SENDER is the moderator (the JSON `by` is informational) — and must be one who outranks the
  // target: a forged packet from an ordinary participant, or a lower-ranked moderator's packet aimed
  // at an owner, neither locks a mic nor paints shields. (The real mute is the SFU permission change,
  // handled in onPermissionChanged, so nothing legitimate is lost.)
  const trusted = await senderMayModerate(s, from, target);
  if (sess() !== s || s.closing) return;
  if (action === "mute") {
    if (!trusted) return log.warn(`ignoring a mute packet from ${from} for ${target} (not a call moderator here, or not ranked above them)`);
    if (!shields.has(target) && shields.size >= MAX_SHIELDS) return;
    shields.set(target, { by: from, name });
    if (target === s.myIdentity) void lockMe(s, label(from, name));
    rebuildTiles();
  } else if (action === "unmute") {
    if (!trusted && !(target === s.myIdentity && micAllowedHere(s))) return;
    shields.delete(target);
    iMuted.delete(target); // another moderator lifted it: no stale re-announce to late joiners
    if (target === s.myIdentity && micAllowedHere(s)) void unlockMe(s);
    rebuildTiles();
  } else if (action === "disconnect" && target === s.myIdentity && trusted) {
    removal = { by: from, name, at: Date.now(), roomId: s.roomId };
  }
}

hooks.onParticipantJoined.push((s, p) => {
  void refreshPerms();
  if (isRecorder(p.identity)) return;
  // Late joiner: tell them whom I have server-muted.
  const myName = displayName(s.roomId, s.me);
  for (const t of iMuted) sendData("tinhat.moderation", { action: "mute", target: t, by: s.myIdentity, name: myName }, { to: [p.identity] });
  // Moderator auto re-enforcement of a recorded mute (once per identity per join).
  if (getCall().canModerateCall && !enforcedThisJoin.has(p.identity)) {
    const rec = getState<{ muted?: boolean }>(s.roomId, CALL_MOD_TYPE, stateKeyFor(mxidOf(p.identity)));
    if (rec?.muted === true) {
      enforcedThisJoin.add(p.identity);
      log.info(`re-enforcing the recorded server mute of ${p.identity}`);
      void moderate(s, "mute", p.identity, false);
    }
  }
});

hooks.onParticipantLeft.push((_s, p) => {
  enforcedThisJoin.delete(p.identity);
  if (!iMuted.has(p.identity)) shields.delete(p.identity); // others re-announce theirs to a returning peer
});

hooks.onConnected.push((s) => {
  void refreshPerms();
  s.timers.push(setInterval(() => sess() === s && void refreshPerms(), 30000));
});

hooks.onTeardown.push(() => {
  packetChain = Promise.resolve();
  removal = null;
  shields.clear();
  iMuted.clear();
  enforcedThisJoin.clear();
});

// ---- actions ------------------------------------------------------------------------------------------------------

function resolveTarget(s: Sess, target: string): string | null {
  const ids = [...s.room.remoteParticipants.keys()].filter((i) => !isRecorder(i)).sort();
  if (ids.includes(target)) return target;
  if (target === s.myIdentity || target === s.me) return s.myIdentity;
  return ids.find((i) => mxidOf(i) === target) ?? null;
}

function who(s: Sess, identity: string): string {
  const n = displayName(s.roomId, mxidOf(identity));
  return n || localpart(mxidOf(identity));
}

async function moderate(s: Sess, action: "mute" | "unmute" | "disconnect", target: string, announce: boolean): Promise<void> {
  const myName = displayName(s.roomId, s.me);
  const w = who(s, target);
  if (action === "disconnect") sendData("tinhat.moderation", { action: "disconnect", target, by: s.myIdentity, name: myName }, { to: [target] });
  try {
    await apiJson("/moderation/call", { method: "POST", json: { room_id: s.roomId, action, target }, timeoutMs: 10000 });
    if (sess() !== s) return; // the call ended (or another began) while the server answered
    sendData("tinhat.moderation", { action, target, by: s.myIdentity, name: myName });
    if (action === "mute") {
      shields.set(target, { by: s.myIdentity, name: myName });
      iMuted.add(target);
    } else if (action === "unmute") {
      shields.delete(target);
      iMuted.delete(target);
    }
    rebuildTiles();
    if (action !== "disconnect" && announce) {
      try {
        await sendState(s.roomId, CALL_MOD_TYPE, stateKeyFor(mxidOf(target)), action === "mute" ? { muted: true, by: s.me, ts: Date.now() } : {});
      } catch (e) {
        log.warn(`state write failed (${action} ${target}): ${errText(e)}`);
      }
    }
    if (announce) setStatus(action === "mute" ? `Muted ${w} for everyone` : action === "unmute" ? `Unmuted ${w} for everyone` : `Disconnected ${w} from the call`);
  } catch (e) {
    const text = `Couldn't ${action} ${w}: ${errText(e)}`;
    if (announce) setError(text);
    else log.warn(`auto re-enforcement: ${text}`);
  }
}

function precheck(target: string, action: "mute" | "unmute" | "disconnect"): { s: Sess; id: string } | string {
  const s = sess();
  if (!s || !getCall().inCall) return "You're not in a call";
  if (!getCall().canModerateCall) return "You can't moderate calls in this space";
  const id = resolveTarget(s, target);
  if (!id) return "They're not in the call";
  if (id === s.myIdentity) return action === "disconnect" ? "You can't disconnect yourself — hang up instead" : "You can't server-mute yourself";
  return { s, id };
}

async function run(target: string, action: "mute" | "unmute" | "disconnect"): Promise<string> {
  const r = precheck(target, action);
  if (typeof r === "string") {
    setStatus(r);
    return r;
  }
  void moderate(r.s, action, r.id, true);
  return "";
}

export const serverMute = (t: string) => run(t, "mute");
export const serverUnmute = (t: string) => run(t, "unmute");
export const disconnectParticipant = (t: string) => run(t, "disconnect");

/** rolesActive/containerOf re-exported for the menu (kick/ban from space are the spaces feature's). */
export { rolesActive, containerOf };

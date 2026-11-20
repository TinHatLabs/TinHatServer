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
import { toast } from "@/core/bus";
import { HAND_MS, TOAST_GAP_MS, UNDO_MS, UNMUTE_ASK_TOPIC, WORDS, askLabel, askPayload, askScopeIn, askVerdict, cooldownLeft, handShown, holdPut, holdTake, nextMuteEpisode, personTileIn, undoOffered, undoScopeIn, parseAsk, staleText, toastMayAct, words } from "./unmuteask";

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
    recheckHands(s); // 12.1.17: hands I may no longer answer go down
  } catch (e) {
    log.debug(`perms: ${errText(e)}`);
  }
}

// ---- shields ---------------------------------------------------------------------------------------------

// target identity → moderator + the mute's revision (12.1.17 Stage B: an Undo / ask toast acts only on the revision it
// was made for; unmuteask.ts nextMuteEpisode / toastMayAct). Every set goes through setShield.
const shields = new Map<string, { by: string; name: string; rev: number }>();
const MAX_SHIELDS = 64;
let muteSeq = 0; // revisions: never handed out twice in this page (not reset with the call)

/** `id` is server-muted by `by`: the same moderator's repeat keeps the revision, anything else starts a new one.
 *  Returns the revision (read in the same step: what my own mute's Undo keeps). */
function setShield(id: string, by: string, name: string): number {
  const prev = shields.get(id);
  const ep = nextMuteEpisode(prev ? { by: prev.by, rev: prev.rev } : null, "mute", by, ++muteSeq);
  const rev = ep ? ep.rev : muteSeq;
  shields.set(id, { by, name, rev });
  return rev;
}

/** The current mute revisions of `ids` (the ones muted now): what an ask's toast keeps (read when the ask arrives). */
function revsOf(ids: string[]): Array<{ id: string; at: number }> {
  const out: Array<{ id: string; at: number }> = [];
  for (const id of ids) {
    const m = shields.get(id);
    if (m) out.push({ id, at: m.rev });
  }
  return out;
}

/** Who an Undo's unmute of `target` reaches NOW (unmuteask.ts undoScopeIn: run() / runPerson's own rule). */
const undoScope = (target: string, person: boolean) => undoScopeIn(getCall().tiles ?? [], target, person);

/** Who an ask's Unmute reaches NOW (unmuteask.ts askScopeIn: unmuteAsker's own rule). */
const askScope = (from: string) => askScopeIn(getCall().tiles ?? [], from);

/** A toast button's press: true = act. `kept` = the revisions the toast kept; `scope` = who the press would unmute now
 *  (one it didn't keep that is muted now = a newer mute). Stale (another call, a newer mute, already lifted) = nothing
 *  but a word why. */
function toastMayActNow(s: Sess, kept: Array<{ id: string; at: number }>, name: string, scope: string[]): boolean {
  const now = (id: string) => shields.get(id)?.rev ?? null;
  const seen = new Set(kept.map((k) => k.id));
  const revs = [...kept.map((k) => ({ at: k.at as number | null, now: now(k.id) })), ...scope.filter((id) => !seen.has(id)).map((id) => ({ at: null, now: now(id) }))];
  const v = toastMayAct(sess() === s, revs);
  if (v === "act") return true;
  log.info(`toast press ignored: ${v}`);
  toast(staleText(v, name), { timeoutMs: 4000 });
  return false;
}
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
  if (sess() !== s || s.closing || !inCall(s, target)) return; // (Stage B: they may have left during the lookup)
  if (action === "mute") {
    if (!trusted) return log.warn(`ignoring a mute packet from ${from} for ${target} (not a call moderator here, or not ranked above them)`);
    if (!shields.has(target) && shields.size >= MAX_SHIELDS) return;
    setShield(target, from, name);
    if (target === s.myIdentity) void lockMe(s, label(from, name));
    rebuildTiles();
    releaseHeldAsk(s, target); // 12.1.17 Stage B (#3): their ask that came in before this announcement
  } else if (action === "unmute") {
    if (!trusted && !(target === s.myIdentity && micAllowedHere(s))) return;
    shields.delete(target);
    iMuted.delete(target); // another moderator lifted it: no stale re-announce to late joiners
    if (target === s.myIdentity && micAllowedHere(s)) void unlockMe(s);
    rebuildTiles();
    pushHands(); // 12.1.17: an unmuted person's hand goes down
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
  askHands.delete(p.identity); // 12.1.17: gone = no hand (their toast gap stays: a rejoin doesn't reset it)
  askHeld.delete(p.identity); // (Stage B #3: and no held ask)
  pushHands();
  // Stage B: gone = no mute record (as the desktop): a re-enforced mute after a rejoin is a NEW revision, so an old Undo
  // can't lift it. My own re-announce list (iMuted) stays; others re-announce theirs to a returning peer.
  shields.delete(p.identity);
});

hooks.onConnected.push((s) => {
  void refreshPerms();
  s.timers.push(setInterval(() => sess() === s && void refreshPerms(), 30000));
});

hooks.onTeardown.push(() => {
  packetChain = Promise.resolve();
  askChain = Promise.resolve();
  askHands.clear();
  askToasted.clear();
  askBusy.clear();
  askHeld.clear();
  lastAskMs = null;
  if (handTimer) clearTimeout(handTimer);
  handTimer = 0;
  patch({ unmuteAsks: [], unmuteAskAt: 0 });
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

/** PAD-PHONE Step B: the server's per-device answer to a person-wide action. */
interface PersonResult {
  done?: number;
  failed?: number;
  devices?: Array<{ identity: string; result: "ok" | "failed" | "skipped"; reason?: string; error?: string }>;
}

async function moderate(s: Sess, action: "mute" | "unmute" | "disconnect", target: string, announce: boolean, person = false): Promise<void> {
  const since = muteSeq; // (round 2) the newest revision as my request goes out: a newer mute overtakes a late answer
  const myName = displayName(s.roomId, s.me);
  const w = who(s, target);
  if (action === "disconnect") sendData("tinhat.moderation", { action: "disconnect", target, by: s.myIdentity, name: myName }, { to: [target] });
  try {
    // (Step B) a person tile's Mute / Remove: every connection of theirs (their phone's Pad ones too), answered per device
    const r = (await apiJson("/moderation/call", { method: "POST", json: { room_id: s.roomId, action, target, ...(person ? { scope: "person" } : {}) }, timeoutMs: 10000 })) as PersonResult | undefined;
    if (sess() !== s) return; // the call ended (or another began) while the server answered
    const okIds = person && Array.isArray(r?.devices) ? r!.devices!.filter((d) => d.result === "ok").map((d) => d.identity) : [target];
    const kept: Array<{ id: string; at: number }> = []; // Stage B: my mutes' revisions, each read as it is recorded
    // (round 2) someone muted them after my request left: my late answer offers no Undo (unmuteask.ts undoOffered)
    const offered = action === "mute" && okIds.every((id) => undoOffered(shields.get(id)?.rev ?? null, since));
    for (const id of okIds) {
      if (action === "disconnect" && id !== target) sendData("tinhat.moderation", { action: "disconnect", target: id, by: s.myIdentity, name: myName }, { to: [id] });
      sendData("tinhat.moderation", { action, target: id, by: s.myIdentity, name: myName });
      if (action === "mute") {
        kept.push({ id, at: setShield(id, s.myIdentity, myName) });
        iMuted.add(id);
      } else if (action === "unmute") {
        shields.delete(id);
        iMuted.delete(id);
      }
    }
    if (action === "unmute") pushHands();
    if (action === "mute") for (const id of okIds) releaseHeldAsk(s, id); // 12.1.17 Stage B (#3)
    if (person && (r?.failed ?? 0) > 0) {
      const total = (r?.done ?? 0) + (r?.failed ?? 0);
      const verb = action === "mute" ? "muted" : action === "unmute" ? "unmuted" : "removed";
      if (announce) setError(`Only ${r?.done ?? 0} of ${total} of ${w}'s devices were ${verb} — the call server refused the rest`);
      announce = false;
    }
    rebuildTiles();
    if (action !== "disconnect" && announce) {
      try {
        await sendState(s.roomId, CALL_MOD_TYPE, stateKeyFor(mxidOf(target)), action === "mute" ? { muted: true, by: s.me, ts: Date.now() } : {});
      } catch (e) {
        log.warn(`state write failed (${action} ${target}): ${errText(e)}`);
      }
      if (sess() !== s) return; // (Stage B) the call ended while the state write ran
    }
    if (announce && action === "mute") {
      // 12.1.17: the moderator's mute toast carries an Undo (UNDO_MS) = unmute the same target. The status line is
      // kept for its readers without its own toast (statusRev not bumped: one toast, the one with the button).
      const text = words("muteToast", w);
      patch({ status: text });
      // Undo acts only on THIS mute: this call, and the revisions it recorded (12.1.17 Stage B: a newer mute by anyone,
      // even after a lift in between, or on a device it never covered, is never lifted by an old toast)
      if (!offered) toast(text, { timeoutMs: UNDO_MS });
      else toast(text, { timeoutMs: UNDO_MS, action: { label: WORDS.muteToastAction, run: () => void (toastMayActNow(s, kept, w, undoScope(target, person)) && (person ? serverUnmutePerson(target) : serverUnmute(target))) } });
    } else if (announce) setStatus(action === "unmute" ? `Unmuted ${w} for everyone` : `Disconnected ${w} from the call`);
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
  // PAD-PHONE Step B: the menu of a PERSON tile (their devices folded in: members) acts on the whole person
  if ((getCall().tiles ?? []).some((t) => t.participant === target && (t.members?.length ?? 0) > 1)) return runPerson(target, action);
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

/** PAD-PHONE Step B: Mute / Unmute / Remove on a PERSON tile (several devices folded in): every connection of theirs. */
async function runPerson(target: string, action: "mute" | "unmute" | "disconnect"): Promise<string> {
  const r = precheck(target, action);
  if (typeof r === "string") {
    setStatus(r);
    return r;
  }
  void moderate(r.s, action, r.id, true, true);
  return "";
}
export const serverMutePerson = (t: string) => runPerson(t, "mute");
export const serverUnmutePerson = (t: string) => runPerson(t, "unmute");
export const disconnectPerson = (t: string) => runPerson(t, "disconnect");

// ---- 12.1.17 (D04.6): ask to be unmuted (unmuteask.ts; desktop call_ctl.rs on_unmute_ask) -----------------------

const askHands = new Map<string, number>(); // asker identity → when their hand went up (only asks I may answer)
// asker identity → when I last toasted their ask. Kept when they leave (a rejoin is no way around the toast gap);
// pruned once older than the gap; cleared with the call.
const askToasted = new Map<string, number>();
const askBusy = new Set<string>(); // askers with an ask being decided (a flood never queues more than one each)
// 12.1.17 Stage B (#3): asker identity → when their ask came in before I knew they were muted (the call server mutes
// them before the moderator's request returns and is announced). Decided when their mute record arrives, if still
// live (heldAskLive); at most one per asker, MAX_SHIELDS at once; dropped when they leave / the call ends.
const askHeld = new Map<string, number>();
let lastAskMs: number | null = null;
let askChain: Promise<unknown> = Promise.resolve();
let handTimer: ReturnType<typeof setTimeout> | 0 = 0;

/** Drop the hands that are down (unmuted, or older than HAND_MS), publish the rest (sorted), and keep ONE timer
 *  armed for the next hand to go down. */
function pushHands(): void {
  const now = Date.now();
  for (const [id, at] of askHands) if (!handShown(at, now, shields.has(id))) askHands.delete(id);
  const ids = [...askHands.keys()].sort();
  const cur = getCall().unmuteAsks ?? [];
  if (cur.length !== ids.length || cur.some((x, i) => x !== ids[i])) patch({ unmuteAsks: ids });
  if (handTimer) clearTimeout(handTimer);
  handTimer = 0;
  if (askHands.size) {
    const next = Math.min(...askHands.values()) + HAND_MS - now;
    handTimer = setTimeout(() => ((handTimer = 0), pushHands()), Math.max(50, next + 50));
  }
}

/** My permissions or someone's rank moved: hands I may no longer answer go down at once. */
function recheckHands(s: Sess): void {
  if (!askHands.size) return;
  const mine = getCall().canModerateCall ? rankOf(s.roomId, s.me) : null;
  for (const id of [...askHands.keys()]) {
    const theirs = rankOf(s.roomId, mxidOf(id));
    if (mine === null || theirs === null || !(mine > theirs)) askHands.delete(id);
  }
  pushHands();
}

hooks.onData.push((s, topic, _payload, from, text) => {
  if (topic !== UNMUTE_ASK_TOPIC) return;
  if (!parseAsk(text)) return log.debug(`unmute ask: ignored a malformed packet from ${from}`);
  // cheap drops before any permissions lookup: an ask from someone not server-muted (as far as I know yet) is held
  // until their mute is announced (Stage B #3), and one ask per asker is decided at a time
  if (!shields.has(from)) return holdAsk(s, from);
  decideAsk(s, from);
});

/** Decide `from`'s ask (one at a time per asker, in arrival order). Its toast keeps the revisions of NOW (the mute the
 *  ask was made under: its arrival, or for a held ask the arrival of the asker's mute record). */
function decideAsk(s: Sess, from: string): void {
  if (askBusy.has(from)) return;
  askBusy.add(from);
  const kept = revsOf(askScope(from));
  const go = () =>
    onAsk(s, from, kept)
      .catch((e) => log.warn(`unmute ask: ${errText(e)}`))
      .finally(() => sess() === s && askBusy.delete(from)); // (an old call's ask never clears a newer call's mark)
  askChain = askChain.then(go, go);
}

/** Stage B (#3): an ask from someone I don't know to be muted yet: held for ASK_HOLD_MS (bounded), never shown by itself. */
function holdAsk(s: Sess, from: string): void {
  if (from === s.myIdentity || !inCall(s, from)) return;
  holdPut(askHeld, from, Date.now(), MAX_SHIELDS);
}

/** Stage B (#3): `id`'s mute is known now: a held ask of theirs that is still live is decided like a fresh one. */
function releaseHeldAsk(s: Sess, id: string): void {
  if (holdTake(askHeld, id, Date.now()) && sess() === s) decideAsk(s, id);
}

/** The person tile `from` is one of the devices of (more than one device), if any (unmuteask.ts personTileIn). */
const personTileOf = (from: string) => personTileIn(getCall().tiles ?? [], from);

/** The ask's Unmute: the asker's whole person when they are one of a person tile's devices (as the desktop does). */
function unmuteAsker(from: string): Promise<string> {
  const t = personTileOf(from);
  return t ? serverUnmutePerson(t.participant) : serverUnmute(from);
}

/** Someone asked to be unmuted: a hand + a toast only if I may answer (askVerdict). Never unmutes anyone. */
async function onAsk(s: Sess, from: string, kept: Array<{ id: string; at: number }>): Promise<void> {
  if (!inCall(s, from)) return;
  const sender = mxidOf(from);
  let iModerate = false;
  try {
    const p = await Promise.race([
      Promise.resolve(provider(s.roomId, s.me)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("perms lookup timed out")), 5000)),
    ]);
    iModerate = p?.moderate_calls === true;
  } catch {
    iModerate = false;
  }
  if (sess() !== s || s.closing || !inCall(s, from)) return; // (Stage B: they may have left during the lookup)
  const now = Date.now();
  for (const [id, at] of askToasted) if (now - at >= TOAST_GAP_MS || now < at) askToasted.delete(id);
  const v = askVerdict({
    senderIsMe: sender === s.me,
    senderServerMuted: shields.has(from),
    iModerate,
    myRank: rankOf(s.roomId, s.me),
    senderRank: rankOf(s.roomId, sender),
    lastToastMs: askToasted.get(from) ?? null,
    nowMs: now,
  });
  log.info(`${from} asks to be unmuted -> ${v}`);
  if (v !== "toast" && v !== "hand") return;
  if (!askHands.has(from) && askHands.size >= MAX_SHIELDS) return;
  askHands.set(from, now);
  if (v === "toast") {
    askToasted.set(from, now);
    // the button acts only on the mute the ask was made under: this call, the revisions kept when it arrived, and no
    // device of theirs muted since (12.1.17 Stage B: a lift + a newer mute meanwhile is never lifted by this toast)
    const name = who(s, from);
    toast(words("askToast", name), { timeoutMs: 8000, action: { label: WORDS.askToastAction, run: () => void (toastMayActNow(s, kept, name, askScope(from)) && unmuteAsker(from)) } });
  }
  pushHands();
}

/** I'm server-muted: ask the moderators to unmute me (everyone gets it; only those who outrank me show it).
 *  "" = sent; else why not (the caller shows it). */
export async function askToUnmute(): Promise<string> {
  const s = sess();
  if (!s || !getCall().inCall) return "You're not in a call";
  if (!getCall().serverMuted) return "Your mic isn't muted by a moderator";
  const now = Date.now();
  const left = cooldownLeft(lastAskMs, now);
  if (left > 0) return askLabel(left);
  lastAskMs = now;
  patch({ unmuteAskAt: now });
  try {
    await s.room.localParticipant.publishData(new TextEncoder().encode(askPayload()), { reliable: true, topic: UNMUTE_ASK_TOPIC });
  } catch (e) {
    if (sess() !== s || lastAskMs !== now) return ""; // another call / a newer ask owns the cooldown now
    lastAskMs = null; // nothing went out: the button works again
    patch({ unmuteAskAt: 0 });
    return `Couldn't ask to be unmuted: ${errText(e)}`;
  }
  if (sess() === s) setStatus(WORDS.askSent);
  log.info("unmute ask sent");
  return "";
}

/** rolesActive/containerOf re-exported for the menu (kick/ban from space are the spaces feature's). */
export { rolesActive, containerOf };

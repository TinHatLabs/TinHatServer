// receiver.ts — Pad on the device that is IN the call (docs/PAD.md): the session table (PadSessions), the executor
// that maps every op to the SAME command the receiver's own buttons call, the state snapshots (buildState) and their
// pacing, and the final states (call ended / switched, ×, Pad switched off, replaced).
//
//   op            the command (identical to the button's)                         the button
//   sound.play    soundboard startSound(url, name, emoji)                         a soundboard card / the Soundboard pad
//   sound.stop    soundboard stopCurrent()                                        the playing card / ⏹ in the call bar
//   mic muted     forceMicMuted(true)  (always allowed)                           —
//   mic unmuted   toggleMic()  (only when muted; keeps the server-mute lock)       the mic button
//   deafen on     applyDeafen(on)                                                 the deafen button
//   brb on        setAfk(on)                                                      the BRB button
//   vol           live → pushVolume, else setVolume / setMuted (identity|user)    the per-person menu's slider / mute
//   vol.reset     setVolume(…, 1) + setMuted(…, false) for the three categories   "Reset all to 100%"
//   leave         leaveCall()                                                     the hang-up button
//   sound.play.web soundboard startSound(url, name, emoji)                        a search result card
//   party.join    Media Party joinParty(callRoom)                                 the call bar's Media Party "Join"
//   party.play    play() / pause()                                                the window's ▶ / ⏸
//   party.seek    seek(pos)                                                       the window's seek bar
//   party.next    playUrl(nextQueueUrl(queue, playing))                           the window's ⏭ (watchParty.next)
//   party.add     addLinkToParty(callRoom, url, now)                              the window's "Add a link"
//
// So every gate a local press meets applies again behind the rules' own refusals (padGate / use_soundboard, the
// server-mute lock, sounds only in a call): a Pad can do nothing the person at this device couldn't do with one click.
// Pure of the app (everything injected): features/pad wires the call store, the soundboard, the audio prefs and the
// transport; the tests drive it with spies and a fake clock.
import { PAD_CATS, PAD_CMD, PadSessions, buildState, checkPadMessage, checkTrust, type PadCat, type PadCmd, type PadCtx, type PadFacts, type PadSounds, type PadStateIn, type PadVerdict } from "./rules";
import type { PadLog } from "./transport";

type Obj = Record<string, unknown>;

export interface PadSoundRef {
  name: string;
  url: string;
  emoji: string;
}

export interface PadPerson {
  /** bare user id */
  u: string;
  /** a LiveKit identity of theirs ("@u:server:DEVICE"), "" = none — what the per-person menu passes to the prefs */
  identity: string;
  talk: boolean;
  micOff: boolean;
  away: boolean;
  /** publishing a screen share (the Pad's Watch strip) */
  share?: boolean;
  vol: Record<PadCat, number>;
  muted: Record<PadCat, boolean>;
}

/** The receiver's Media Party in its call room (null = none): what its own window shows. */
export interface PadPartySnap {
  in: boolean;
  /** its own canControl */
  host: boolean;
  /** the playing url ("" = nothing) */
  url: string;
  title: string;
  playing: boolean;
  /** the room's playback clock: seconds at `at` (the writer's ms clock) */
  pos: number;
  at: number;
  dur: number;
  next: string[];
  /** the outcome of the latest party.add (one session's), for that Pad's "couldn't add that link" */
  add?: { sid: string; re: number; ok: boolean } | null;
}

/** Everything the receiver's own UI shows that a Pad reads (taken from the stores at one instant). */
export interface PadSnapshot {
  /** the call this device is in (connected), null = none; gen changes with every call session */
  call: null | { room: string; gen: string; since: number };
  me: {
    micMuted: boolean;
    ptt: boolean;
    serverMuted: boolean;
    deaf: boolean;
    brb: boolean;
    talk: boolean;
    /** the sound playing now ("" = none) */
    sound: string;
    /** padGate(inCall, callPerms) */
    gate: { allowed: boolean; hint: string };
  };
  /** the people in the call with me (bare ids, not me, devices folded, no recorder) */
  people: PadPerson[];
  /** what sound.play may play (favourites, the CALL room's sounds, Recent) */
  sounds: PadSounds;
  /** name + emoji by url (favourites, the call room's sounds, Recent) — startSound's other two arguments */
  named: PadSoundRef[];
  /** this device's Recent list (newest first) */
  recent: PadSoundRef[];
  /** the call room's Media Party (absent = none; the 12.1 snapshot had no such field) */
  party?: PadPartySnap | null;
}

/** The commands the receiver's own buttons call (features/pad hands in the real ones). */
export interface PadExec {
  forceMicMuted(muted: boolean): void;
  toggleMic(): void;
  applyDeafen(on: boolean): void;
  setAfk(on: boolean): void;
  leaveCall(): void;
  startSound(url: string, name: string, emoji: string): void;
  stopCurrent(): void;
  setVolume(identity: string, cat: PadCat, v: number): void;
  pushVolume(identity: string, cat: PadCat, v: number): void;
  setMuted(identity: string, cat: PadCat, muted: boolean): void;
  /** Media Party of the call room (the window's own functions); each re-checks `url` against what plays right now */
  partyJoin?(room: string): void;
  partyPlay?(url: string, playing: boolean): void;
  partySeek?(url: string, pos: number): void;
  partyNext?(url: string): void;
  /** `sid` / `re` = the command's session and seq: its outcome comes back in call.party.add */
  partyAdd?(room: string, url: string, now: boolean, sid: string, re: number): void;
}

/** me.mic of the state: a moderator's lock first, then push to talk, then the mute. */
export function micWord(me: PadSnapshot["me"]): "on" | "muted" | "server" | "ptt" {
  if (me.serverMuted) return "server";
  if (me.ptt) return "ptt";
  return me.micMuted ? "muted" : "on";
}

/** The rules' context from a snapshot. */
export function ctxOf(snap: PadSnapshot, padOn: boolean): PadCtx {
  return {
    padOn,
    call: snap.call ? { room: snap.call.room, gen: snap.call.gen } : null,
    participants: snap.people.map((p) => p.u),
    me: { micMuted: snap.me.micMuted, ptt: snap.me.ptt, serverMuted: snap.me.serverMuted, deaf: snap.me.deaf, brb: snap.me.brb, soundRole: snap.me.gate.allowed },
    sounds: snap.sounds,
    party: snap.party ? { in: snap.party.in, host: snap.party.host, url: snap.party.url, playing: snap.party.playing } : null,
  };
}

/** The state's `call` from a snapshot (buildState applies the caps and drops the defaults). */
export function stateCall(snap: PadSnapshot): PadStateIn["call"] {
  if (!snap.call) return null;
  return {
    room: snap.call.room,
    gen: snap.call.gen,
    since: snap.call.since,
    me: { mic: micWord(snap.me), deaf: snap.me.deaf, brb: snap.me.brb, talk: snap.me.talk, sound: snap.me.sound, gate: snap.me.gate },
    people: snap.people.map((p) => ({ u: p.u, talk: p.talk, micOff: p.micOff, away: p.away, share: p.share === true, vol: { ...p.vol }, muted: { ...p.muted } })),
    recent: snap.recent.map((r) => ({ name: r.name, url: r.url, emoji: r.emoji })),
    party: snap.party
      ? {
          in: snap.party.in,
          host: snap.party.host,
          url: snap.party.url,
          title: snap.party.title,
          playing: snap.party.playing,
          pos: Math.max(0, Math.floor(snap.party.pos)),
          at: Math.max(0, Math.floor(snap.party.at)),
          dur: Math.max(0, Math.floor(snap.party.dur)),
          next: snap.party.next.map((title) => ({ title })),
          ...(snap.party.add ? { add: { ...snap.party.add } } : {}),
        }
      : null,
  };
}

/**
 * Run one ACCEPTED command (`verdict.ok && verdict.run`) through the receiver's own command for it. Returns what it
 * called (for the log). `open` / `ping` / `close` call nothing.
 */
export function execPadCmd(cmd: PadCmd, snap: PadSnapshot, x: PadExec, meta: { sid: string; re: number } = { sid: "", re: 0 }): string {
  switch (cmd.op) {
    case "sound.play": {
      const ref = snap.named.find((s) => s.url === cmd.url);
      x.startSound(cmd.url, ref?.name ?? "", ref?.emoji ?? "");
      return "startSound";
    }
    case "sound.stop":
      x.stopCurrent();
      return "stopCurrent";
    case "mic":
      if (cmd.muted) {
        x.forceMicMuted(true);
        return "forceMicMuted(true)";
      }
      x.toggleMic();
      return "toggleMic";
    case "deafen":
      x.applyDeafen(cmd.on);
      return `applyDeafen(${cmd.on})`;
    case "brb":
      x.setAfk(cmd.on);
      return `setAfk(${cmd.on})`;
    case "vol": {
      const id = snap.people.find((p) => p.u === cmd.user)?.identity || cmd.user;
      if (cmd.live) {
        x.pushVolume(id, cmd.cat, cmd.level as number);
        return "pushVolume";
      }
      const did: string[] = [];
      if (cmd.level !== undefined) {
        x.setVolume(id, cmd.cat, cmd.level);
        did.push("setVolume");
      }
      if (cmd.muted !== undefined) {
        x.setMuted(id, cmd.cat, cmd.muted);
        did.push("setMuted");
      }
      return did.join("+");
    }
    case "vol.reset": {
      const id = snap.people.find((p) => p.u === cmd.user)?.identity || cmd.user;
      for (const c of PAD_CATS) {
        x.setVolume(id, c, 1);
        x.setMuted(id, c, false);
      }
      return "reset";
    }
    case "leave":
      x.leaveCall();
      return "leaveCall";
    case "sound.play.web":
      x.startSound(cmd.url, cmd.name || "Sound", cmd.emoji);
      return "startSound";
    case "party.join":
      if (!snap.call || !x.partyJoin) return "";
      x.partyJoin(snap.call.room);
      return "joinParty";
    case "party.play":
      if (!x.partyPlay) return "";
      x.partyPlay(cmd.url, cmd.playing);
      return cmd.playing ? "play" : "pause";
    case "party.seek":
      if (!x.partySeek) return "";
      x.partySeek(cmd.url, cmd.pos);
      return "seek";
    case "party.next":
      if (!x.partyNext) return "";
      x.partyNext(cmd.url);
      return "next";
    case "party.add":
      if (!snap.call || !x.partyAdd) return "";
      x.partyAdd(snap.call.room, cmd.url, cmd.now, meta.sid, meta.re);
      return cmd.now ? "addLink(playNow)" : "addLink";
    default:
      return "";
  }
}

export interface PadReceiverDeps {
  now(): number;
  timer(fn: () => void, ms: number): unknown;
  cancel(h: unknown): void;
  /** the transport (Olm, one device, never queued); resolves false when it could not go */
  send(device: string, content: Obj): Promise<boolean>;
  /** rule 10 before a push / final: this device verified and that device cross-signing trusted (≤ 60 s cache) */
  mayReceive(device: string): Promise<boolean>;
  /** Settings → Calls → Pad on this device */
  padOn(): boolean;
  snapshot(): PadSnapshot;
  exec: PadExec;
  log?: PadLog;
  /** the live sessions changed (the chip "📱 Pad · <device> ×") */
  changed?(): void;
  /** a session from this device was opened (the first-time toast) */
  opened?(device: string): void;
}

const NOLOG: PadLog = { info: () => undefined, warn: () => undefined };
/** sweep lapsed sessions this often while any exist */
export const SWEEP_MS = 5_000;
/** the call-change / push check runs at most this often after a store change */
export const POKE_MS = 100;
/** silent drops worth a warning line (the rest log at debug) */
const LOUD_DROPS = new Set(["not-olm", "sender-mismatch", "unbound", "self-unverified", "peer-untrusted", "bad-envelope"]);

function talkSig(c: PadStateIn["call"]): string {
  if (!c) return "";
  return JSON.stringify([c.me.talk, c.people.map((p) => [p.u, p.talk])]);
}
function bodySig(c: PadStateIn["call"]): string {
  if (!c) return "null";
  return JSON.stringify({ ...c, me: { ...c.me, talk: false }, people: c.people.map((p) => ({ ...p, talk: false })) });
}

/** The rules' context for a message that fails rules 1–4 (the rules return before they read it): no snapshot is taken
 *  for anything untrusted (Astra 2026-10-25 #4). */
const NO_CTX: PadCtx = {
  padOn: false,
  call: null,
  participants: [],
  me: { micMuted: false, ptt: false, serverMuted: false, deaf: false, brb: false, soundRole: false },
  sounds: { favourites: [], roomSounds: {}, recent: [] },
};

export class PadReceiver {
  readonly table = new PadSessions();
  /** grows with every state sent; it starts at the clock (ms × 1000) so a receiver that restarted keeps counting
   *  above what its controllers last accepted (acceptState keeps the highest rseq: Astra 2026-10-25 #7) */
  private rseq: number;
  /** what each session was last sent (signature of the body, of the talking flags) */
  private sent = new Map<string, { body: string; talk: string }>();
  private pushTimers = new Map<string, { h: unknown; talkOnly: boolean }>();
  private pokeTimer: unknown = null;
  private sweepTimer: unknown = null;
  /** the call (room + gen) the sessions last heard of */
  private lastCall: { room: string; gen: string } | null = null;
  private readonly log: PadLog;
  private readonly d: PadReceiverDeps;

  constructor(d: PadReceiverDeps) {
    this.d = d;
    this.log = d.log ?? NOLOG;
    this.rseq = Math.max(0, Math.floor(d.now())) * 1000;
    const s = d.snapshot().call;
    this.lastCall = s ? { room: s.room, gen: s.gen } : null;
  }

  /** The live sessions (oldest first) — for the chip. */
  live(): { sid: string; device: string }[] {
    return this.table.live(this.d.now()).map((s) => ({ sid: s.sid, device: s.device }));
  }

  /** One received `dev.tinhat.pad.cmd` with its trust facts. Returns the verdict (tests / logs). */
  handle(type: string, content: unknown, facts: PadFacts): PadVerdict {
    const now = this.d.now();
    if (type !== PAD_CMD || !checkTrust(facts).ok) {
      // untrusted (or not a command): dropped by the rules before they read any state — none is taken
      const v = checkPadMessage(this.table, type, content, facts, NO_CTX, now);
      const line = `dropped ${type} from ${facts.olmSender || facts.eventSender || "?"}/${facts.senderDevice || "?"}: ${v.reason}`;
      if (LOUD_DROPS.has(v.reason)) this.log.warn(line);
      else this.log.debug?.(line);
      return v;
    }
    const before = new Map(this.table.sessions.map((s) => [s.sid, s.device]));
    const liveBefore = this.table.live(now).length;
    const snap = this.d.snapshot();
    // a call change the store hasn't poked yet must not let a command through on the old call's state
    this.noteCall(snap, now);
    const v = checkPadMessage(this.table, type, content, facts, this.ctx(snap), now);
    const op = content && typeof content === "object" && !Array.isArray(content) && Object.prototype.hasOwnProperty.call(content, "op") ? String((content as Obj).op) : "";
    const who = facts.senderDevice || "?";
    if (!v.ok && !v.why) {
      const line = `dropped ${op || type} from ${facts.olmSender || facts.eventSender || "?"}/${who}: ${v.reason}`;
      if (LOUD_DROPS.has(v.reason)) this.log.warn(line);
      else this.log.debug?.(line);
    } else if (!v.ok) this.log.info(`REFUSED ${op} seq ${v.re} from ${who}: ${v.why}`);
    if (v.ok && v.run && v.cmd) {
      const did = execPadCmd(v.cmd, snap, this.d.exec, { sid: v.sid, re: v.re });
      this.log.info(`${v.cmd.op} seq ${v.re} from ${who} → ${did}`);
    }
    for (const sid of v.evicted) {
      const dev = before.get(sid);
      if (dev) this.final(sid, dev, "replaced");
    }
    if (v.reply && type === PAD_CMD) {
      // the call goes only with Pad on and to the live session of the very device that asked (an early refusal — bad,
      // busy, version — or a refused open never carries it: Astra 2026-10-25 #3); a closed session gets call null
      const s = this.table.get(v.sid, this.d.now());
      const withCall = this.d.padOn() === true && !!s && s.device === facts.senderDevice && !(!v.ok && op === "open");
      this.state(v.sid, facts.senderDevice, { re: v.re, ok: v.ok, why: v.why, call: withCall ? stateCall(this.d.snapshot()) : null }, true);
    }
    if (v.ok && op === "close") this.forget(v.sid);
    if (v.ok && op === "open") this.d.opened?.(facts.senderDevice);
    // what the command changed reaches the OTHER sessions too (and a live slider push, which is never answered)
    if (v.ok && v.run) this.poke();
    if (this.table.live(now).length !== liveBefore || v.evicted.length || (v.ok && (op === "open" || op === "close"))) this.d.changed?.();
    this.armSweep();
    return v;
  }

  private ctx(snap: PadSnapshot): PadCtx {
    return ctxOf(snap, this.d.padOn() === true);
  }

  /** Send one state to `sid` on `device` (a reply goes at once; a push / final checks rule 10 first). */
  private state(sid: string, device: string, a: { re: number; ok: boolean; why: string; call: PadStateIn["call"] }, isReply: boolean): void {
    const now = this.d.now();
    const { state } = buildState({ sid, rseq: ++this.rseq, rt: now, re: a.re, ok: a.ok, why: a.why, call: a.call });
    this.table.markPushed(sid, now);
    // what a LIVE session was last sent (nothing is kept for a sid without one: Astra 2026-10-25 #5)
    if (this.table.get(sid, now)?.device === device) this.sent.set(sid, { body: bodySig(a.call), talk: talkSig(a.call) });
    else this.forget(sid);
    const go = () => void this.d.send(device, state).then((ok) => ok || this.log.debug?.(`state to ${device} not sent`));
    if (isReply) go();
    else
      void this.d.mayReceive(device).then((ok) => {
        if (ok) go();
        else {
          // rule 10: an untrusted device learns nothing; its sessions end
          this.log.warn(`${device} is no longer trusted — its Pad session ends`);
          for (const s of this.table.sessions.filter((x) => x.device === device)) {
            this.table.close(s.sid, this.d.now());
            this.forget(s.sid);
          }
          this.d.changed?.();
        }
      });
  }

  private final(sid: string, device: string, why: string): void {
    this.forget(sid);
    this.state(sid, device, { re: 0, ok: false, why, call: null }, false);
  }

  /** A session's bookkeeping goes with it (closed, replaced, refused, lapsed, cleared, untrusted). */
  private forget(sid: string): void {
    this.cancelPush(sid);
    this.sent.delete(sid);
  }

  /** Tests: how many sessions' last states are remembered (never more than the live sessions). */
  tracked(): number {
    return this.sent.size;
  }

  private cancelPush(sid: string): void {
    const t = this.pushTimers.get(sid);
    if (t !== undefined) this.d.cancel(t.h);
    this.pushTimers.delete(sid);
  }

  /** A call change (left / switched / joined) → final or fresh states, and the × refusals end with the call. */
  private noteCall(snap: PadSnapshot, now: number): void {
    const cur = snap.call ? { room: snap.call.room, gen: snap.call.gen } : null;
    const last = this.lastCall;
    if ((cur?.room ?? "") === (last?.room ?? "") && (cur?.gen ?? "") === (last?.gen ?? "")) return;
    this.lastCall = cur;
    this.table.clearRefused();
    const live = this.table.live(now);
    if (!live.length) return;
    // the session survives a call change; only a VISIBLE controller hears of it now (vis:false stops every unsolicited
    // push — its next ping's answer brings the new state: Astra 2026-10-25 #12); pacing doesn't hold this one back
    const call = cur ? stateCall(snap) : null;
    let told = 0;
    for (const s of live) {
      this.cancelPush(s.sid);
      if (!s.vis) continue;
      told++;
      this.state(s.sid, s.device, cur ? { re: 0, ok: true, why: "", call } : { re: 0, ok: false, why: "ended", call: null }, false);
    }
    this.log.info(cur ? `call is now ${cur.room} (gen ${cur.gen}) — told ${told} Pad session(s)` : `call ended — told ${told} Pad session(s)`);
  }

  /** The receiver's own state changed (call store, soundboard, prefs): coalesced, then paced pushes. */
  poke(): void {
    // no sessions: nothing to tell (the next command catches the call up first: handle → noteCall)
    if (!this.table.sessions.length || this.pokeTimer !== null) return;
    this.pokeTimer = this.d.timer(() => {
      this.pokeTimer = null;
      this.check();
    }, POKE_MS);
  }

  /** Run the change check now (tests; the poke timer). */
  check(): void {
    const now = this.d.now();
    const snap = this.d.snapshot();
    this.noteCall(snap, now);
    const call = stateCall(snap);
    const body = bodySig(call);
    const talk = talkSig(call);
    for (const s of this.table.live(now)) {
      const prev = this.sent.get(s.sid);
      if (!prev) continue;
      if (prev.body !== body) this.schedule(s.sid, false);
      else if (prev.talk !== talk) this.schedule(s.sid, true);
    }
  }

  private schedule(sid: string, talkOnly: boolean): void {
    const pending = this.pushTimers.get(sid);
    // the pending push re-reads everything when it fires; only a talk-only wait gives way to a real change (250 ms)
    if (pending && (talkOnly || !pending.talkOnly)) return;
    if (pending) this.cancelPush(sid);
    const now = this.d.now();
    const w = this.table.pushWait(sid, now, talkOnly);
    if (w < 0) return;
    if (w === 0) return this.push(sid);
    const h = this.d.timer(() => {
      this.pushTimers.delete(sid);
      this.push(sid);
    }, w);
    this.pushTimers.set(sid, { h, talkOnly });
  }

  /** An unsolicited push (re 0) of the current state, if it still differs from what that session has. */
  private push(sid: string): void {
    const now = this.d.now();
    const s = this.table.get(sid, now);
    if (!s) return;
    const snap = this.d.snapshot();
    this.noteCall(snap, now);
    const call = stateCall(snap);
    const prev = this.sent.get(sid);
    const body = bodySig(call);
    const talk = talkSig(call);
    if (prev && prev.body === body && prev.talk === talk) return;
    const talkOnly = !!prev && prev.body === body;
    const w = this.table.pushWait(sid, now, talkOnly);
    if (w < 0) return;
    if (w > 0) return this.schedule(sid, talkOnly);
    this.state(sid, s.device, { re: 0, ok: true, why: "", call }, false);
  }

  /** × on the chip: end that device's sessions (final `closed`) and refuse it for the rest of this call. */
  refuse(device: string): void {
    const now = this.d.now();
    const sids = this.table.live(now).filter((s) => s.device === device).map((s) => s.sid);
    this.table.refuse(device, now);
    for (const sid of sids) this.final(sid, device, "closed");
    this.log.info(`${device} closed with × — refused until the call changes`);
    this.d.changed?.();
  }

  /** Settings → Calls → Pad switched off: every session ends (final `off`). */
  padOff(): void {
    const now = this.d.now();
    const live = this.table.live(now).map((s) => ({ sid: s.sid, device: s.device }));
    this.table.clear(now);
    for (const s of live) this.final(s.sid, s.device, "off");
    if (live.length) this.d.changed?.();
  }

  /** Sign-out / client change: forget everything (nothing is sent). */
  reset(): void {
    for (const sid of [...this.pushTimers.keys()]) this.cancelPush(sid);
    if (this.pokeTimer !== null) this.d.cancel(this.pokeTimer);
    if (this.sweepTimer !== null) this.d.cancel(this.sweepTimer);
    this.pokeTimer = this.sweepTimer = null;
    this.table.clear(this.d.now());
    this.sent.clear();
    this.d.changed?.();
  }

  private armSweep(): void {
    if (this.sweepTimer !== null || !this.table.sessions.length) return;
    this.sweepTimer = this.d.timer(() => {
      this.sweepTimer = null;
      const gone = this.table.sweep(this.d.now());
      for (const sid of gone) {
        this.cancelPush(sid);
        this.sent.delete(sid);
      }
      if (gone.length) {
        this.log.info(`${gone.length} Pad session(s) lapsed`);
        this.d.changed?.();
      }
      this.armSweep();
    }, SWEEP_MS);
  }
}

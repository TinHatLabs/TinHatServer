// controller.ts — Pad on the device that drives (usually the phone): one session with ONE of my other devices that is
// in a call (docs/PAD.md "Sessions", "Stale and rate", DESIGN §4.5/§4.8).
//
//   open   a fresh sid, seq 1, `want: ["talk"]`; commands go only after the open was answered ok (its state brings
//          the `gen`); unanswered after its resend → abandoned ("Not reaching <device>"), the next try mints a new sid
//   ping   every 15 s while the Pad is visible, at once when it becomes visible again; `vis:false` once when hidden
//   close  when the Pad closes
//   acks   every command but a live slider push waits for its state (`re` = its seq): none in 3 s → one resend (the
//          same seq) → still none → roll back; "Not reaching <device>" unless a newer state came in meanwhile (then the
//          link lives and that full snapshot is already the truth)
//   rates  slider pushes ≤ 4/s per slider (the release always goes), sound taps ≤ 4/s (a newer tap replaces a waiting
//          one); `unknown-sound` → one retry after 2 s as a NEW command (new seq); `no-session` → re-open
//   view   the newest accepted state (acceptState: highest rseq wins) with the optimistic changes of the commands still
//          waiting for their answer laid over it — a press moves at once, a refusal rolls it back with its reason
//
// Pure of the app (clock, timers, transport, sid minting injected); features/pad holds one per open Pad screen.
import { PAD_CATS, PAD_STATE, acceptState, type PadCat, type PadCtrlSession, type PadFacts } from "./rules";
import type { PadLog } from "./transport";

type Obj = Record<string, unknown>;

export const ACK_MS = 3_000;
export const PING_MS = 15_000;
export const RETRY_SOUND_MS = 2_000;
export const SLIDER_EVERY_MS = 250;
export const TAP_EVERY_MS = 250;
/** an abandoned open is tried again this often while the Pad is visible */
export const REOPEN_MS = 15_000;

export type PadMic = "on" | "muted" | "server" | "ptt";

export interface PadPersonView {
  u: string;
  talk: boolean;
  micOff: boolean;
  away: boolean;
  /** publishing a screen share (older receivers never say: false) */
  share: boolean;
  vol: Record<PadCat, number>;
  mute: Record<PadCat, boolean>;
}

/** The receiver's Media Party in its call room. `pos` = seconds at the receiver's send time (`at` already applied). */
export interface PadPartyView {
  in: boolean;
  host: boolean;
  url: string;
  title: string;
  playing: boolean;
  /** the position when the state was sent (the room clock + what passed on the receiver's clock since) */
  pos: number;
  dur: number;
  next: string[];
  /** this controller's clock when that state arrived (the UI adds what passed since, while playing) */
  seenAt: number;
  /** the outcome of the receiver's latest party.add (one session's) */
  add: { sid: string; re: number; ok: boolean } | null;
}

/** The receiver's call as the Pad shows it. */
export interface PadView {
  room: string;
  gen: string;
  since: number;
  me: { mic: PadMic; deaf: boolean; brb: boolean; talk: boolean; sound: string; gate: { allowed: boolean; hint: string } };
  people: PadPersonView[];
  more: number;
  recent: { name: string; url: string; emoji: string }[];
  ops: string[];
  /** the call room's Media Party (null = none, or an older receiver) */
  party: PadPartyView | null;
}

/** opening = waiting for the open's answer; open = live; unreachable = timed out; ended = nothing to control */
export type PadLink = "opening" | "open" | "unreachable" | "ended";

export interface PadNotice {
  /** the refusal / final code (rules.ts whyText) or "unreachable" */
  code: string;
  /** the op it answered ("" = a final / the link) */
  op: string;
  /** bumps with every notice (the UI shows each once) */
  n: number;
}

interface Patch {
  key: string;
  apply(v: PadView): void;
}

interface Pending {
  seq: number;
  op: string;
  content: Obj;
  sentAt: number;
  resent: boolean;
  timer: unknown;
  patch: Patch | null;
  /** sound.play: retried once already after unknown-sound */
  retried?: boolean;
  /** the press's intent (session, call generation, that control's press count) when it was MADE */
  intent?: { sid: string; gen: string; rev: number };
}

export interface PadCtrlDeps {
  now(): number;
  timer(fn: () => void, ms: number): unknown;
  cancel(h: unknown): void;
  /** the transport to the target device (Olm, never queued) */
  send(device: string, content: Obj): Promise<boolean>;
  /** a fresh 16-character base64url session id */
  sid(): string;
  /** the view / link / notice changed */
  changed(): void;
  log?: PadLog;
}

const NOLOG: PadLog = { info: () => undefined, warn: () => undefined };
/** finals that end the session (any other "no call" keeps it: the receiver may join again) */
const TERMINAL = new Set(["closed", "off", "replaced", "version", "no-session"]);

/** The validated state content → the typed view (acceptState already checked every field). */
export function readView(c: Obj, seenAt = 0): PadView | null {
  const call = c.call as Obj | null;
  if (!call) return null;
  const me = call.me as Obj;
  const gate = me.gate as Obj;
  const sound = me.sound as Obj | null;
  const people = (call.people as Obj[]).map((p) => {
    const vol = { mic: 1, screenshare: 1, music: 1 } as Record<PadCat, number>;
    const mute = { mic: false, screenshare: false, music: false } as Record<PadCat, boolean>;
    const vi = (p.vol ?? {}) as Obj;
    for (const k of PAD_CATS) if (typeof vi[k] === "number") vol[k] = vi[k] as number;
    for (const k of (p.mute ?? []) as string[]) if ((PAD_CATS as readonly string[]).includes(k)) mute[k as PadCat] = true;
    return { u: p.u as string, talk: p.talk === true, micOff: p.micOff === true, away: p.away === true, share: p.share === true, vol, mute };
  });
  return {
    room: call.room as string,
    gen: call.gen as string,
    since: call.since as number,
    me: { mic: me.mic as PadMic, deaf: me.deaf === true, brb: me.brb === true, talk: me.talk === true, sound: sound ? (sound.url as string) : "", gate: { allowed: gate.allowed === true, hint: gate.hint as string } },
    people,
    more: call.more as number,
    recent: (call.recent as Obj[]).map((r) => ({ name: r.name as string, url: r.url as string, emoji: r.emoji as string })),
    ops: (c.ops as string[]).slice(),
    party: partyView(call.party, c.rt as number, seenAt),
  };
}

/** call.party (acceptState checked its shape) → the view; the position is carried forward to the state's send time on
 *  the receiver's clock (`rt − at`, never negative, at most a day). */
function partyView(p: unknown, rt: number, seenAt: number): PadPartyView | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Obj;
  const playing = o.playing === true;
  const at = o.at as number;
  const ahead = playing && at > 0 && rt > at ? Math.min(86_400, (rt - at) / 1000) : 0;
  return {
    in: o.in === true,
    host: o.host === true,
    url: o.url as string,
    title: o.title as string,
    playing,
    pos: Math.min(86_400, (o.pos as number) + ahead),
    dur: o.dur as number,
    next: (o.next as Obj[]).map((n) => n.title as string),
    seenAt,
    add: o.add && typeof o.add === "object" ? { ...(o.add as { sid: string; re: number; ok: boolean }) } : null,
  };
}

/** Where the party's video is now on this controller's clock (seconds). */
export function partyPosNow(p: PadPartyView, now: number): number {
  const ahead = p.playing && now > p.seenAt ? (now - p.seenAt) / 1000 : 0;
  const x = p.pos + ahead;
  return p.dur > 0 ? Math.min(p.dur, x) : x;
}

function personOf(v: PadView, user: string, f: (p: PadPersonView) => void): void {
  const p = v.people.find((x) => x.u === user);
  if (p) f(p);
}

function cloneView(v: PadView): PadView {
  return {
    ...v,
    me: { ...v.me, gate: { ...v.me.gate } },
    people: v.people.map((p) => ({ ...p, vol: { ...p.vol }, mute: { ...p.mute } })),
    recent: v.recent.map((r) => ({ ...r })),
    ops: [...v.ops],
    party: v.party ? { ...v.party, next: [...v.party.next], add: v.party.add ? { ...v.party.add } : null } : null,
  };
}

export class PadController {
  /** the receiver (one device of mine) and the call room the Pad was opened for */
  readonly device: string;
  readonly room: string;
  link: PadLink = "opening";
  notice: PadNotice | null = null;
  /** the newest accepted state (null before the open's answer, or when there is nothing to control) */
  truth: PadView | null = null;
  private sess: PadCtrlSession | null = null;
  private seq = 0;
  private openSeq = 0;
  private openTimer: unknown = null;
  private openResent = false;
  private reopenTimer: unknown = null;
  private pingTimer: unknown = null;
  private visible = true;
  private closed = false;
  private lastGen = "";
  private lastStateAt = -Infinity;
  private noticeN = 0;
  private pending = new Map<number, Pending>();
  private gates = new Map<string, { last: number; timer: unknown; run: (() => void) | null }>();
  private readonly log: PadLog;

  private readonly d: PadCtrlDeps;

  constructor(d: PadCtrlDeps, device: string, room: string) {
    this.d = d;
    this.device = device;
    this.room = room;
    this.log = d.log ?? NOLOG;
  }

  // ---- session ---------------------------------------------------------------------------------------------

  /** Open (or re-open with a fresh sid). */
  open(): void {
    if (this.closed) return;
    this.clearOpen();
    this.rollbackAll();
    this.stopPings();
    const sid = this.d.sid();
    this.overtook = null;
    this.sess = { sid, device: this.device, lastRseq: 0 };
    this.seq = 1;
    this.openSeq = 1;
    this.openResent = false;
    this.truth = null;
    this.link = "opening";
    const content: Obj = { v: 1, sid, seq: 1, ts: this.d.now(), room: this.room, op: "open", want: ["talk"] };
    void this.d.send(this.device, content);
    this.openTimer = this.d.timer(() => this.openTimeout(content), ACK_MS);
    this.d.changed();
  }

  private openTimeout(content: Obj): void {
    this.openTimer = null;
    if (this.closed || !this.sess || this.link !== "opening") return;
    if (!this.openResent) {
      this.openResent = true;
      void this.d.send(this.device, content); // the same seq (a duplicate is dropped silently)
      this.openTimer = this.d.timer(() => this.openTimeout(content), ACK_MS);
      return;
    }
    // abandoned: no command was ever sent on this sid; the next try mints a new one
    this.log.info(`open of ${this.device} unanswered — not reaching it`);
    this.sess = null;
    this.link = "unreachable";
    this.say("unreachable", "");
    this.armReopen();
    this.d.changed();
  }

  private clearOpen(): void {
    if (this.openTimer !== null) this.d.cancel(this.openTimer);
    if (this.reopenTimer !== null) this.d.cancel(this.reopenTimer);
    this.openTimer = this.reopenTimer = null;
  }

  private armReopen(): void {
    if (this.reopenTimer !== null || !this.visible || this.closed) return;
    this.reopenTimer = this.d.timer(() => {
      this.reopenTimer = null;
      if (this.visible && !this.closed && this.link === "unreachable" && !this.sess) this.open();
    }, REOPEN_MS);
  }

  /** The Pad screen is visible (or not): pings every 15 s while visible, one at once on becoming visible. */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    if (this.closed) return;
    const kept = this.link === "open" || (this.link === "ended" && !!this.sess);
    if (!v) {
      this.stopPings();
      if (this.reopenTimer !== null) this.d.cancel(this.reopenTimer);
      this.reopenTimer = null;
      if (kept) this.command("ping", { vis: false }, null);
      return;
    }
    if (kept) {
      this.command("ping", { vis: true }, null);
      this.armPings();
    } else if (this.link === "unreachable" && !this.sess) this.open();
  }

  private armPings(): void {
    this.stopPings();
    if (!this.visible || this.closed) return;
    this.pingTimer = this.d.timer(() => {
      this.pingTimer = null;
      // (also while there's no call: the session stays alive for the receiver's next one)
      if ((this.link === "open" || (this.link === "ended" && !!this.sess)) && this.visible) this.command("ping", { vis: true }, null);
      this.armPings();
    }, PING_MS);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) this.d.cancel(this.pingTimer);
    this.pingTimer = null;
  }

  /** The Pad closes (screen closed, device switched, sign-out). */
  close(): void {
    if (this.closed) return;
    // an answered session (with a call or without one right now) is closed on the receiver; an open still waiting for
    // its answer isn't (no command before the open's answer)
    if (this.sess && this.link !== "opening") this.command("close", {}, null, { ack: false });
    this.closed = true;
    this.clearOpen();
    this.stopPings();
    for (const g of this.gates.values()) if (g.timer !== null) this.d.cancel(g.timer);
    this.gates.clear();
    for (const p of this.pending.values()) this.d.cancel(p.timer);
    this.pending.clear();
    this.sess = null;
    this.link = "ended";
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---- states ----------------------------------------------------------------------------------------------

  /** One received `dev.tinhat.pad.state` with its trust facts. */
  onState(content: unknown, facts: PadFacts): boolean {
    if (this.closed || !this.sess) return false;
    // the handshake: until the open is answered only ITS answer counts — a state that overtook it must not move the
    // acceptance mark past it (Astra 2026-10-25 #8); the open's answer itself is a full snapshot anyway
    if (this.link === "opening") {
      const re0 = content && typeof content === "object" && Object.prototype.hasOwnProperty.call(content, "re") ? (content as Obj).re : undefined;
      if (re0 !== this.openSeq) {
        // …but the newest of them is kept (checked on a copy of the session: the mark doesn't move) and applied right
        // after the open's answer, so a push or a final that overtook it isn't lost (Astra 2026-10-25 pass 2 #4)
        const probe = { ...this.sess };
        if (acceptState(probe, PAD_STATE, content, facts).ok && probe.lastRseq > (this.overtook?.rseq ?? 0)) this.overtook = { content, facts, rseq: probe.lastRseq };
        return false;
      }
    }
    const r = acceptState(this.sess, PAD_STATE, content, facts);
    if (!r.ok || !r.state) {
      this.log.debug?.(`state from ${facts.senderDevice || "?"} ignored: ${r.reason}`);
      return false;
    }
    const c = r.state;
    const now = this.d.now();
    this.lastStateAt = now;
    const re = c.re as number;
    const ok = c.ok === true;
    const why = c.why as string;
    const view = readView(c, this.d.now());
    if (view) this.lastGen = view.gen;
    // the open's answer
    if (this.link === "opening") {
      this.clearOpen();
      if (ok && view) {
        this.truth = view;
        this.link = "open";
        this.notice = null;
        // hidden while it opened: the receiver starts every session visible — tell it (Astra 2026-10-25 #12)
        if (!this.visible) this.command("ping", { vis: false }, null);
        this.armPings();
        const o = this.overtook;
        this.overtook = null;
        if (o && o.rseq > (this.sess?.lastRseq ?? Infinity)) return this.onState(o.content, o.facts);
      } else {
        this.overtook = null;
        this.truth = null;
        this.link = "ended";
        this.sess = null;
        this.say(why || "not-in-call", "open");
      }
      this.d.changed();
      return true;
    }
    // no session there any more (the receiver restarted / forgot it): ONE fresh open (Astra 2026-10-25 #6)
    if (why === "no-session") {
      this.reopenSoon();
      this.d.changed();
      return true;
    }
    const prevRoom = this.truth?.room ?? "";
    const prevGen = this.truth?.gen ?? "";
    // the answer to a command
    const p = re > 0 ? this.pending.get(re) : undefined;
    if (p) {
      this.d.cancel(p.timer);
      this.pending.delete(re);
    }
    // another call (room or generation): what was pressed for the old one — waiting answers, drags, deferred
    // presses — doesn't carry over (Astra 2026-10-25 pass 2 #5)
    if (view && this.truth && (view.room !== prevRoom || view.gen !== prevGen)) this.rollbackAll();
    this.truth = view;
    if (p && !ok) this.refused(p, why);
    // a press that went through takes an old refusal line away (the desktop's PadWindow does the same: a "muted for
    // everyone" line must not linger once the receiver does what I press again — phase 3); "left the call" stays
    else if (p && ok && this.notice && this.notice.code !== "ended") this.notice = null;
    // a link this session asked the receiver's Media Party to add couldn't be added (its lookup failed, the link was
    // refused, or the party changed meanwhile): its answer was the acceptance, this is the outcome (once per seq)
    // (deduplicated by (sid, seq): an outcome that arrives out of order is still said once; review pass 2)
    const add = view?.party?.add;
    if (add && add.sid === this.sess?.sid) {
      const k = `${add.sid}:${add.re}`;
      if (!this.addSeen.has(k)) {
        this.addSeen.add(k);
        if (this.addSeen.size > 64) this.addSeen.delete(this.addSeen.values().next().value as string);
        if (!add.ok) this.say("bad-link", "party.add");
      }
    }
    if (!view) {
      this.rollbackAll();
      if (TERMINAL.has(why)) {
        // the session is over (× on the receiver, Pad switched off, replaced, …): a new one needs a new open
        this.sess = null;
        this.link = "ended";
        this.stopPings();
        this.say(why, "");
      } else {
        // no call right now (it left, or I left it): the session lives on — kept alive by the pings, it comes back
        // with the receiver's next call (Astra 2026-10-25 #10)
        this.link = "ended";
        // (the answer to my own Leave is "it left", not "it isn't in a call")
        if (!(p && !ok)) this.say(why || (p?.op === "leave" ? "ended" : "not-in-call"), "");
      }
    } else {
      if (this.link !== "open") {
        this.link = "open";
        this.notice = null;
        this.armPings();
      }
      if (prevRoom && view.room !== prevRoom) this.say("other-call", "");
    }
    this.d.changed();
    return true;
  }

  private refused(p: Pending, why: string): void {
    if (why === "unknown-sound" && p.op === "sound.play" && !p.retried) {
      // the favourite may not have reached that device yet: once more in 2 s, as a NEW command — unless another sound
      // tap / Stop came meanwhile or the session / call changed (Astra 2026-10-25 #9)
      // (the intent is the one of the press itself — a Stop / another tap made before this answer came cancels it:
      // Astra 2026-10-25 pass 2 #3)
      const url = p.content.url as string;
      const ctx = p.intent;
      if (!ctx || !this.stillIntent("sound", ctx)) return;
      this.d.timer(() => {
        if (!this.stillIntent("sound", ctx)) return;
        this.command("sound.play", { url }, { key: "sound", apply: (v) => void (v.me.sound = url) }, { retried: true, intent: ctx });
      }, RETRY_SOUND_MS);
      return;
    }
    if (why) this.say(why, p.op);
  }

  /** A control's intent: the session, the call generation and how many presses that control has had. */
  private intents = new Map<string, number>();
  private intent(key: string): { sid: string; gen: string; rev: number } {
    return { sid: this.sess?.sid ?? "", gen: this.truth?.gen ?? "", rev: this.intents.get(key) ?? 0 };
  }
  private bumpIntent(key: string): void {
    this.intents.set(key, (this.intents.get(key) ?? 0) + 1);
  }
  private stillIntent(key: string, c: { sid: string; gen: string; rev: number }): boolean {
    return !this.closed && this.link === "open" && !!this.sess && this.sess.sid === c.sid && (this.truth?.gen ?? "") === c.gen && (this.intents.get(key) ?? 0) === c.rev;
  }

  /** the newest state that overtook the open's answer (applied right after it) */
  private overtook: { content: unknown; facts: PadFacts; rseq: number } | null = null;
  private reopens: number[] = [];
  private reopenSoon(): void {
    const now = this.d.now();
    this.reopens = this.reopens.filter((t) => now - t < 60_000);
    if (this.reopens.length >= 3) {
      this.link = "ended";
      this.say("unreachable", "");
      return;
    }
    this.reopens.push(now);
    this.open();
  }

  private say(code: string, op: string): void {
    this.notice = { code, op, n: ++this.noticeN };
  }

  /** "Try again" / "Take it back": a ping when the session is there, else a fresh open. */
  retry(): void {
    if (this.closed) return;
    if (this.sess && (this.link === "open" || this.link === "ended")) {
      this.command("ping", { vis: this.visible }, null);
      this.d.changed();
    } else this.open();
  }

  /** Clear the notice line (the UI dismissed it). */
  dismiss(): void {
    if (!this.notice) return;
    this.notice = null;
    this.d.changed();
  }

  // ---- commands --------------------------------------------------------------------------------------------

  /** The controls may send now (open, a call to control, the op offered by the receiver). */
  canSend(op: string): boolean {
    return !this.closed && this.link === "open" && !!this.sess && !!this.truth && this.truth.ops.includes(op);
  }

  private command(op: string, fields: Obj, patch: Patch | null, opts: { ack?: boolean; retried?: boolean; intent?: { sid: string; gen: string; rev: number } } = {}): boolean {
    if (this.closed || !this.sess) return false;
    const control = op !== "ping" && op !== "close";
    if (control && !this.canSend(op)) return false;
    const gen = this.truth?.gen || this.lastGen;
    const room = this.truth?.room || this.room;
    if (!gen) return false;
    const seq = ++this.seq;
    const content: Obj = { v: 1, sid: this.sess.sid, seq, ts: this.d.now(), room, gen, op, ...fields };
    void this.d.send(this.device, content);
    const ack = opts.ack !== false && !(op === "vol" && fields.live === true);
    if (ack) {
      // a newer press on the same control takes over the optimistic change (the older one only waits for its answer)
      if (patch) for (const q of this.pending.values()) if (q.patch?.key === patch.key) q.patch = null;
      const p: Pending = { seq, op, content, sentAt: this.d.now(), resent: false, timer: null, patch, retried: opts.retried, intent: opts.intent };
      p.timer = this.d.timer(() => this.ackTimeout(seq), ACK_MS);
      this.pending.set(seq, p);
    }
    if (control) this.d.changed();
    return true;
  }

  private ackTimeout(seq: number): void {
    const p = this.pending.get(seq);
    if (!p || this.closed) return;
    if (!p.resent) {
      p.resent = true;
      void this.d.send(this.device, p.content); // the same seq: dropped silently if the first one arrived
      p.timer = this.d.timer(() => this.ackTimeout(seq), ACK_MS);
      return;
    }
    this.pending.delete(seq);
    // a state that came in after this command was sent is a full snapshot: it already shows the truth
    if (this.lastStateAt > p.sentAt) {
      this.d.changed();
      return;
    }
    this.log.info(`${p.op} seq ${seq} to ${this.device} unanswered — not reaching it`);
    this.link = "unreachable";
    this.rollbackAll();
    this.say("unreachable", p.op);
    // abandon this sid: the next try is a fresh open (a receiver that restarted would answer below this sid's rseq
    // mark, and its old session is gone anyway: Astra 2026-10-25 #7)
    this.sess = null;
    this.stopPings();
    this.armReopen();
    this.d.changed();
  }

  private rollbackAll(): void {
    for (const p of this.pending.values()) this.d.cancel(p.timer);
    this.pending.clear();
    this.liveLevels.clear(); // (a drag's live value must never outlive its session: Astra 2026-10-25 #11)
    this.liveOwner = "";
    this.cancelGate("vol-live");
  }

  /** ≤ 4 per second per gate; a newer call while waiting replaces the waiting one. */
  private gated(key: string, every: number, run: () => void): void {
    const now = this.d.now();
    let g = this.gates.get(key);
    if (!g) this.gates.set(key, (g = { last: -Infinity, timer: null, run: null }));
    if (g.timer === null && now - g.last >= every) {
      g.last = now;
      run();
      return;
    }
    // a waiting press belongs to this session and call: dropped if either changes before it goes (#9)
    const sid = this.sess?.sid ?? "";
    const gen = this.truth?.gen ?? "";
    g.run = () => {
      if (this.sess?.sid === sid && (this.truth?.gen ?? "") === gen) run();
    };
    if (g.timer === null) {
      const gg = g;
      gg.timer = this.d.timer(
        () => {
          gg.timer = null;
          const r = gg.run;
          gg.run = null;
          if (r && !this.closed) {
            gg.last = this.d.now();
            r();
          }
        },
        Math.max(0, every - (now - g.last)),
      );
    }
  }

  private cancelGate(key: string): void {
    const g = this.gates.get(key);
    if (!g) return;
    if (g.timer !== null) this.d.cancel(g.timer);
    g.timer = null;
    g.run = null;
  }

  setMic(muted: boolean): boolean {
    return this.command("mic", { muted }, { key: "mic", apply: (v) => void (v.me.mic = muted ? "muted" : "on") });
  }
  setDeafen(on: boolean): boolean {
    return this.command("deafen", { on }, { key: "deaf", apply: (v) => void (v.me.deaf = on) });
  }
  setBrb(on: boolean): boolean {
    return this.command("brb", { on }, { key: "brb", apply: (v) => void (v.me.brb = on) });
  }
  leave(): boolean {
    return this.command("leave", {}, null);
  }
  /** A tap on a sound: ≤ 4/s, the newest waiting tap wins. */
  playSound(url: string): void {
    if (!this.canSend("sound.play")) return;
    this.bumpIntent("sound");
    const intent = this.intent("sound");
    this.gated("sound", TAP_EVERY_MS, () => void this.command("sound.play", { url }, { key: "sound", apply: (v) => void (v.me.sound = url) }, { intent }));
  }
  stopSound(): void {
    if (!this.canSend("sound.stop")) return;
    this.bumpIntent("sound");
    this.gated("sound", TAP_EVERY_MS, () => void this.command("sound.stop", {}, { key: "sound", apply: (v) => void (v.me.sound = "") }));
  }
  /** A search result played on the receiver (`sound.play.web`): ≤ 4/s with the other sound taps. */
  playWebSound(url: string, name: string, emoji = ""): void {
    if (!this.canSend("sound.play.web")) return;
    this.bumpIntent("sound");
    const intent = this.intent("sound");
    const nm = [...name].slice(0, 64).join("");
    const em = [...emoji].slice(0, 16).join("");
    this.gated("sound", TAP_EVERY_MS, () => void this.command("sound.play.web", { url, name: nm, emoji: em }, { key: "sound", apply: (v) => void (v.me.sound = url) }, { intent }));
  }
  /** Media Party of the receiver's call room (each bound to what the Pad last saw playing: `party-changed` else). */
  partyJoin(): boolean {
    return this.command("party.join", {}, { key: "party:in", apply: (v) => void (v.party && (v.party.in = true)) });
  }
  partyPlay(playing: boolean): boolean {
    const url = this.view()?.party?.url ?? "";
    const now = this.d.now();
    return this.command("party.play", { url, playing }, {
      key: "party:play",
      apply: (v) => {
        if (!v.party) return;
        v.party.pos = partyPosNow(v.party, now);
        v.party.seenAt = now;
        v.party.playing = playing;
      },
    });
  }
  partySeek(pos: number): boolean {
    const url = this.view()?.party?.url ?? "";
    const p = Math.max(0, Math.min(86_400, Math.floor(pos)));
    const now = this.d.now();
    return this.command("party.seek", { url, pos: p }, {
      key: "party:pos",
      apply: (v) => {
        if (!v.party) return;
        v.party.pos = p;
        v.party.seenAt = now;
      },
    });
  }
  partyNext(): boolean {
    const url = this.view()?.party?.url ?? "";
    return this.command("party.next", { url }, null);
  }
  /** the party.add outcomes already seen, "sid:seq" (a failure is said once; bounded) */
  private addSeen = new Set<string>();
  partyAdd(url: string, now: boolean): boolean {
    return this.command("party.add", { url, now }, null);
  }
  /** A slider: `live` while dragging (≤ 4/s, unanswered), the release (live false) always sent and answered. */
  volume(user: string, cat: PadCat, level: number, live: boolean): void {
    const key = `vol:${user}:${cat}`;
    if (!this.canSend("vol")) {
      this.liveLevels.delete(key);
      return;
    }
    const lv = Math.min(2, Math.max(0, Math.round(level * 100) / 100));
    if (live) {
      this.liveLevels.set(key, { user, cat, level: lv });
      // ONE budget for every slider (≤ 4 live pushes/s in all: PAD.md); the newest value waits — and that slider owns
      // the waiting slot (only its own release cancels it: Astra 2026-10-25 pass 2 #7)
      this.liveOwner = key;
      this.gated("vol-live", SLIDER_EVERY_MS, () => void this.command("vol", { user, cat, level: lv, live: true }, null));
      this.d.changed();
      return;
    }
    // the release always goes (answered); a live push of THIS slider still waiting is dropped
    if (this.liveOwner === key) {
      this.cancelGate("vol-live");
      this.liveOwner = "";
    }
    this.liveLevels.delete(key);
    this.command("vol", { user, cat, level: lv }, { key, apply: (v) => personOf(v, user, (p) => (p.vol[cat] = lv)) });
  }
  /** what a slider shows while it is being dragged (until its release is sent) */
  private liveLevels = new Map<string, { user: string; cat: PadCat; level: number }>();
  private liveOwner = "";
  volumeMute(user: string, cat: PadCat, muted: boolean): boolean {
    return this.command("vol", { user, cat, muted }, { key: `mute:${user}:${cat}`, apply: (v) => personOf(v, user, (p) => (p.mute[cat] = muted)) });
  }
  volumeReset(user: string): boolean {
    return this.command("vol.reset", { user }, {
      key: `reset:${user}`,
      apply: (v) =>
        personOf(v, user, (p) => {
          for (const c of PAD_CATS) {
            p.vol[c] = 1;
            p.mute[c] = false;
          }
        }),
    });
  }

  // ---- what the UI shows -----------------------------------------------------------------------------------

  /** The newest state with every waiting command's optimistic change laid over it (oldest first). */
  view(): PadView | null {
    if (!this.truth) return null;
    const v = cloneView(this.truth);
    for (const p of [...this.pending.values()].sort((a, b) => a.seq - b.seq)) p.patch?.apply(v);
    for (const l of this.liveLevels.values()) personOf(v, l.user, (p) => (p.vol[l.cat] = l.level));
    return v;
  }

  /** A press on this control is waiting for its answer (the thin pending ring). */
  isPending(key: string): boolean {
    for (const p of this.pending.values()) if (p.patch?.key === key) return true;
    return false;
  }

  /** Test / log: the session id and the next seq. */
  debug(): { sid: string; seq: number; pending: number[] } {
    return { sid: this.sess?.sid ?? "", seq: this.seq, pending: [...this.pending.keys()] };
  }
}


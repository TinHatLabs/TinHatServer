// machine.ts — REACH §2.4 + A2.13 (the presence sender) and §3.4 + A2.12 (the web activity sender) as pure
// state machines: time and decisions only. sender.ts wires them to the page (input events, visibility,
// the call store, fetch); machine.test.ts drives them with a fake clock. No imports, so the test runs under
// plain Node type stripping.
//
// Presence (only while the account data says share: true):
//   • beat at once, then every 30 s, and 2 s after a state change (debounced; the server applies a changed
//     state at once and only coalesces identical beats, A2.3);
//   • away after 10 min without pointer/key/touch/wheel input in the page;
//   • phone form factor: when the page hides, one keepalive "away" beat, then silence — the server's 90 s
//     TTL makes us absent; beats resume when the page is visible again (A2.13);
//   • desktop form factor: hidden time simply counts as time without input — no beat on hide (A2.13);
//   • call = the room of the call we are connected to;
//   • 409 not_sharing → stop until the account data says share: true again;
//   • share true → false → stop at once + the off switch (DELETE); network errors keep the cadence;
//   • `refresh` (A4.4): the beat right after a change of share or status asks the server to re-read them.
//   • phone back from silence: opening the app counts as input, so it says "online" at once, and the cadence
//     restarts with that beat (web review #12; 2026-09-25).
// Activity (§3.4, only while the wiring says it is wanted — model.ts pingKeyFor), two kinds:
//   • "foreground" (A6, this device's own pushkey while its push is on): active while the page is on screen
//     (visible) — no input rule, no call exception; a hidden page (a phone in a call too) clears it at once;
//   • "activity" (A2.12, user-level null): while the page is visible and had input within 3 min — or, on a
//     COMPUTER (desktop form factor), we are in a call (model.ts computerActive); a phone never (web review #13).
// A beat every 15 s while active; one "not visible" on hide (keepalive), on going idle, or when the kind changes
// to one that isn't active.

export type SendState = "online" | "away";
export type FormFactorMode = "phone" | "desktop";
/** What the activity sender reports: this device's foreground (own pushkey, A6) or user-level activity (A2.12). */
export type PingKind = "foreground" | "activity";

export interface Beat {
  state: SendState;
  call: string | null;
  client: "web";
  /** A4.4: bypass the server's cached opt-in/status for this user (sent right after a change) */
  refresh?: true;
}

export type BeatResult = "ok" | "not_sharing" | "error";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface PresenceTransport {
  /** PUT /api/presence */
  beat(b: Beat, keepalive: boolean): Promise<BeatResult>;
  /** DELETE /api/presence — the off switch (every device of the user) */
  remove(): Promise<void>;
}

export interface ActivityTransport {
  /** POST /api/push/active (the wiring adds the pushkey / instance) */
  active(visible: boolean, keepalive: boolean): Promise<void>;
}

export const BEAT_EVERY_MS = 30_000;
export const CHANGE_DEBOUNCE_MS = 2_000;
export const IDLE_AWAY_MS = 10 * 60_000;
export const ACTIVE_EVERY_MS = 15_000;
export const ACTIVE_INPUT_MS = 3 * 60_000;

const sameBeat = (a: Beat | null, b: Beat | null) => !!a && !!b && a.state === b.state && a.call === b.call;

export class PresenceSender {
  private readonly clock: Clock;
  private readonly tx: PresenceTransport;
  private readonly mode: () => FormFactorMode;
  private readonly onChange: () => void;
  private known = false; // the account data is known (start() ran)
  private share = false;
  private blocked = false; // the server answered 409 not_sharing
  private lastInput: number;
  private hidden = false;
  private silent = false; // phone: hidden after its keepalive "away" — no beats until visible again
  private call: string | null = null;
  private wantRefresh = false;
  private lastSent: Beat | null = null;
  private tBeat = 0;
  private tChange = 0;
  private tIdle = 0;
  private epoch = 0; // bumps whenever sending stops: a late 409 from before can't block a new run

  constructor(clock: Clock, tx: PresenceTransport, mode: () => FormFactorMode = () => "desktop", onChange: () => void = () => undefined) {
    this.clock = clock;
    this.tx = tx;
    this.mode = mode;
    this.onChange = onChange;
    this.lastInput = clock.now();
  }

  /** The account data allows it and the server hasn't refused. */
  get active(): boolean {
    return this.known && this.share && !this.blocked;
  }
  get isBlocked(): boolean {
    return this.blocked;
  }
  get sharing(): boolean {
    return this.share;
  }

  /** What this device reports right now. */
  state(now = this.clock.now()): SendState {
    if (now - this.lastInput >= IDLE_AWAY_MS) return "away";
    if (this.silent) return "away";
    return "online";
  }

  current(): Beat {
    return { state: this.state(), call: this.call, client: "web" };
  }

  /** The account data is known (after the first sync): begin — beats only while share is true. */
  start(share: boolean): void {
    this.halt();
    this.known = true;
    this.share = share;
    this.blocked = false;
    this.lastSent = null;
    if (this.active && !this.silent) this.beatNow();
    this.onChange();
  }

  /** The account data changed (on this device or seen via sync from another). `remove: false` = this device's
   *  own switch: stop at once, but the off transaction sends the DELETE itself after share:false is written
   *  (A2.2 + web review #1). */
  setShare(share: boolean, opts: { remove?: boolean } = {}): void {
    const was = this.share;
    this.share = share;
    if (!this.known) return;
    if (share) {
      // a 409 waits for exactly this: the account data saying share: true (again)
      if (!was || this.blocked) {
        this.blocked = false;
        this.wantRefresh = true;
        if (!this.silent) this.beatNow();
      }
    } else if (was) {
      this.halt();
      this.blocked = false;
      this.lastSent = null;
      if (opts.remove !== false) this.tx.remove().catch(() => undefined);
    }
    this.onChange();
  }

  /** The status (or share) just changed: the next beat — now — carries refresh: true (A4.4). */
  refresh(): void {
    this.wantRefresh = true;
    if (this.active && !this.silent) this.beatNow();
  }

  /** Pointer / key / touch / wheel input in the page. Cheap: called for every pointermove. */
  input(): void {
    const now = this.clock.now();
    const wasIdle = now - this.lastInput >= IDLE_AWAY_MS;
    this.lastInput = now;
    if (!this.active || this.silent) return;
    if (wasIdle) this.changed();
    if (!this.tIdle) this.armIdle();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      if (this.mode() === "phone") {
        // one keepalive "away" beat (the page may never run again), then nothing: the TTL makes us absent
        this.silent = true;
        if (this.active) {
          this.clearTimers();
          this.send({ state: "away", call: this.call, client: "web" }, true);
        }
      }
      // desktop: hidden time is just time without input
    } else if (this.silent) {
      this.silent = false;
      // A phone only comes back to the foreground because its user opened it: that IS input, so it says
      // "online" at once instead of the idle "away" it would compute from the last tap (2026-09-25 report:
      // "not changing from away to online when I'm on my phone").
      this.lastInput = this.clock.now();
      // back from silence: the TTL may have dropped us — restart the cadence with a beat now (web review #12)
      if (this.active) this.beatNow();
    }
    this.onChange();
  }

  /** The Tin Hat call we are connected to (room id), or null. */
  setCall(room: string | null): void {
    if (room === this.call) return;
    this.call = room;
    if (this.active && !this.silent) this.changed();
    this.onChange();
  }

  /** QA only (the webshot hook, never a shortened timer): pretend the last input was `ms` ago. */
  simulateIdle(ms: number): void {
    this.lastInput -= ms;
    if (!this.active || this.silent) return;
    this.changed();
    this.armIdle();
  }

  /** Sign-out: stop without the account-wide DELETE (the caller sends DELETE ?device=this). */
  stop(): void {
    this.halt();
    this.known = false;
    this.share = false;
    this.blocked = false;
    this.lastSent = null;
    this.onChange();
  }

  // ---- internals ----

  private changed(): void {
    this.clear("tChange");
    this.tChange = this.clock.setTimeout(() => {
      this.tChange = 0;
      if (!this.active || this.silent) return;
      if (this.wantRefresh || !sameBeat(this.current(), this.lastSent)) this.beatNow();
    }, CHANGE_DEBOUNCE_MS);
  }

  private beatNow(): void {
    this.clear("tChange");
    const b = this.current();
    if (this.wantRefresh) {
      b.refresh = true;
      this.wantRefresh = false;
    }
    this.send(b, false);
    this.clear("tBeat");
    this.tBeat = this.clock.setTimeout(() => {
      this.tBeat = 0;
      if (this.active && !this.silent) this.beatNow();
    }, BEAT_EVERY_MS);
    if (!this.tIdle) this.armIdle();
  }

  private send(b: Beat, keepalive: boolean): void {
    this.lastSent = b;
    const epoch = this.epoch;
    this.tx.beat(b, keepalive).then(
      (r) => {
        if (epoch !== this.epoch || r !== "not_sharing") return;
        this.blocked = true;
        this.halt();
        this.onChange();
      },
      () => undefined,
    );
    this.onChange();
  }

  /** Fires at the 10-min idle boundary; re-armed lazily when input moved the boundary meanwhile. */
  private armIdle(): void {
    this.clear("tIdle");
    const due = Math.max(0, this.lastInput + IDLE_AWAY_MS - this.clock.now());
    this.tIdle = this.clock.setTimeout(() => {
      this.tIdle = 0;
      if (!this.active || this.silent) return;
      if (this.clock.now() - this.lastInput >= IDLE_AWAY_MS) this.changed();
      else this.armIdle();
    }, due);
  }

  private clear(k: "tBeat" | "tChange" | "tIdle"): void {
    if (this[k]) this.clock.clearTimeout(this[k]);
    this[k] = 0;
  }

  private clearTimers(): void {
    this.clear("tBeat");
    this.clear("tChange");
    this.clear("tIdle");
  }

  private halt(): void {
    this.epoch++;
    this.clearTimers();
  }
}

/** §3.4 + A2.12, web half: "this person is at this device right now" — never shown to anyone (server
 *  memory, 35 s TTL). Runs only while the wiring says a ping is wanted (consent + eligibility, model.ts
 *  pingKeyFor). */
export class ActivitySender {
  private readonly clock: Clock;
  private readonly tx: ActivityTransport;
  private readonly mode: () => FormFactorMode;
  private readonly kind: () => PingKind;
  private running = false;
  private hidden = false;
  private inCall = false;
  private lastInput: number;
  private sentVisible = false;
  private tBeat = 0;
  private tIdle = 0;

  constructor(clock: Clock, tx: ActivityTransport, mode: () => FormFactorMode = () => "desktop", kind: () => PingKind = () => "activity") {
    this.clock = clock;
    this.tx = tx;
    this.mode = mode;
    this.kind = kind;
    this.lastInput = clock.now();
  }

  private foreground(): boolean {
    return this.kind() === "foreground";
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The server was last told {visible: true} (this device reports its foreground / activity now). */
  get reportingVisible(): boolean {
    return this.running && this.sentVisible;
  }

  /** A call keeps a COMPUTER active, idle or hidden (A2.12); a phone counts only while visible with input. */
  private callCounts(): boolean {
    return this.inCall && this.mode() === "desktop";
  }

  /** foreground (A6): the page is on screen. activity: visible with input in the last 3 min, or (a computer) in a
   *  call (model.ts computerActive). */
  isActive(now = this.clock.now()): boolean {
    if (!this.running) return false;
    if (this.foreground()) return !this.hidden;
    return this.callCounts() || (!this.hidden && now - this.lastInput < ACTIVE_INPUT_MS);
  }

  start(hidden: boolean): void {
    if (this.running) return;
    this.running = true;
    this.hidden = hidden;
    if (this.isActive()) this.beat();
  }

  /** No longer wanted (or signed out): clear what we said, quietly. The promise settles when that last
   *  {visible: false} has been answered (sign-out awaits it while the token still works). `silent`: the
   *  session is already gone — say nothing (its entry expires by the server's TTL). */
  stop(silent = false): Promise<void> {
    if (!this.running) return Promise.resolve();
    const last = this.sentVisible && !silent ? this.tx.active(false, false).catch(() => undefined) : Promise.resolve();
    this.running = false;
    this.sentVisible = false;
    this.clear("tBeat");
    this.clear("tIdle");
    return last;
  }

  input(): void {
    const now = this.clock.now();
    const was = this.isActive(now);
    this.lastInput = now;
    if (!this.running) return;
    if (!was && this.isActive(now)) this.beat();
    else if (!this.tIdle && !this.foreground() && this.isActive(now)) this.armIdle();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!this.running) return;
    if (this.isActive()) {
      if (!hidden) this.beat();
      return; // hidden but in a call: still at the computer
    }
    this.clear("tBeat");
    this.clear("tIdle");
    if (this.sentVisible) {
      this.sentVisible = false;
      this.tx.active(false, hidden).catch(() => undefined);
    }
  }

  /** Connected to a call: on a computer it counts as being there, idle or hidden (not on a phone). */
  setInCall(on: boolean): void {
    if (on === this.inCall) return;
    const was = this.isActive();
    this.inCall = on;
    if (!this.running) return;
    const now = this.isActive();
    if (now && !was) this.beat();
    else if (!now && was) {
      this.clear("tBeat");
      this.clear("tIdle");
      if (this.sentVisible) {
        this.sentVisible = false;
        this.tx.active(false, false).catch(() => undefined);
      }
    }
  }

  /** What a beat carries changed (the pushkey — and with it the kind): say it again at once while active, or
   *  clear what we said when the new kind isn't active (an idle page whose push was just switched off). */
  nudge(): void {
    if (!this.running) return;
    if (this.isActive()) return this.beat();
    this.clear("tBeat");
    this.clear("tIdle");
    if (this.sentVisible) {
      this.sentVisible = false;
      this.tx.active(false, false).catch(() => undefined);
    }
  }

  private beat(): void {
    this.sentVisible = true;
    this.tx.active(true, false).catch(() => undefined);
    this.clear("tBeat");
    this.tBeat = this.clock.setTimeout(() => {
      this.tBeat = 0;
      if (this.isActive()) this.beat();
    }, ACTIVE_EVERY_MS);
    if (this.foreground()) this.clear("tIdle");
    else this.armIdle();
  }

  private armIdle(): void {
    this.clear("tIdle");
    const due = Math.max(0, this.lastInput + ACTIVE_INPUT_MS - this.clock.now());
    this.tIdle = this.clock.setTimeout(() => {
      this.tIdle = 0;
      if (!this.running || this.foreground()) return;
      if (this.isActive()) return this.callCounts() ? undefined : this.armIdle();
      // idle at a visible page: say so once (the desktop sends {visible: false} when it goes idle too)
      this.clear("tBeat");
      if (this.sentVisible) {
        this.sentVisible = false;
        this.tx.active(false, false).catch(() => undefined);
      }
    }, due);
  }

  private clear(k: "tBeat" | "tIdle"): void {
    if (this[k]) this.clock.clearTimeout(this[k]);
    this[k] = 0;
  }
}

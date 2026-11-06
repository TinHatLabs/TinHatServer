// capturelease.ts — Pad Watch Layer 2 (share claude/tinhat-pad/WATCH-LEASE/DESIGN.md §2): every capture / publish
// operation of this app takes a LEASE before it starts, hands every resource it acquires to that lease the moment the
// platform returns it, re-checks the lease after each await and right before it commits (stores the track / publishes),
// and ends it in `finally`. A Watch press REVOKES all leases synchronously: everything they hold stops at the press,
// work still inside a platform call stops what it gets the moment it gets it, and `pending()` tells the watch join to
// wait until that has happened. Pure (no platform code): the case table captureleases.cases.json pins it, byte-identical
// with the desktop's tinhat_streamer::capture_lease (same runner rules).

export type LeaseKind = "mic" | "meter" | "camera" | "screen" | "share-audio" | "music" | "sameroom" | "conntest" | "settings-meter" | "output-tap";

export class Lease {
  private stops: Array<() => void> = [];
  private committed = false;
  private finished = false;
  private readonly owner: CaptureLeases;
  readonly kind: LeaseKind;
  readonly session: unknown;
  readonly gen: number;
  constructor(owner: CaptureLeases, kind: LeaseKind, session: unknown, gen: number) {
    this.owner = owner;
    this.kind = kind;
    this.session = session;
    this.gen = gen;
  }

  /** Still allowed to capture / publish: not revoked, not barred, its session still the current one, not committed. */
  valid(): boolean {
    return !this.committed && !this.finished && this.owner.admits(this);
  }

  private starting = false;
  /** Round 6 (parity with the desktop's begin_start): admission of a platform start — checked and marked in one step. */
  beginStart(): boolean {
    if (!this.valid()) return false;
    this.starting = true;
    return true;
  }
  /** Round 6: the platform start returned — still valid? */
  endStart(): boolean {
    this.starting = false;
    return this.valid();
  }

  /** Hand a resource to the lease. Invalid already: it is stopped NOW and false comes back (the caller stands down). */
  hold(stop: () => void): boolean {
    if (!this.valid()) {
      CaptureLeases.runStop(stop);
      return false;
    }
    this.stops.push(stop);
    return true;
  }

  /** The commit point (store the track, call it published): true = the resources are the caller's from now on;
   *  false = revoked meanwhile, what the lease still held is stopped. Synchronous: nothing can come in between. */
  commit(): boolean {
    if (!this.valid()) {
      this.stopAll();
      return false;
    }
    this.committed = true;
    this.stops = [];
    return true;
  }

  /** Round 10 (parity with the desktop's Lease::commit_opening): commit, and register `close` — the gate of what was
   *  committed — with the leases: the next revoke (a Watch press, sign-out) runs it at once. false = revoked meanwhile. */
  commitOpening(close: () => void): boolean {
    if (!this.commit()) return false;
    this.owner.addGate(close);
    return true;
  }

  /** The operation is over (always, in `finally`): an uncommitted lease stops what it still holds. */
  done(): void {
    if (this.finished) return;
    if (!this.committed) this.stopAll();
    this.finished = true;
    this.owner.release(this);
  }

  /** (CaptureLeases.revoke) */
  stopAll(): number {
    const s = this.stops;
    this.stops = [];
    for (const f of s) CaptureLeases.runStop(f);
    return s.length;
  }
  isCommitted(): boolean {
    return this.committed;
  }
}

export interface LeaseRules {
  /** is `kind` barred right now (the engine: the meter kinds follow monitorBarred, the rest captureBarred) */
  barred(kind: LeaseKind): boolean;
  /** the current call session (null: none, or it is closing) */
  session(): unknown;
}

export class CaptureLeases {
  gen = 0;
  private barred = false;
  private current: unknown = null;
  private readonly rules?: LeaseRules;
  constructor(rules?: LeaseRules) {
    this.rules = rules;
  }
  private live = new Set<Lease>();
  /** round 10: the gates of committed taps (commitOpening), closed by the next revoke */
  private gates = new Set<() => void>();
  addGate(close: () => void): void {
    this.gates.add(close);
  }
  removeGate(close: () => void): void {
    this.gates.delete(close);
  }
  gatesOpen(): number {
    return this.gates.size;
  }
  /** test seam: the Layer 2 escape scenarios run once with leases "off" (the pre-lease behaviour: only the start is
   *  checked) to show they escape (red), then on (green) */
  enforce = true;

  /** The bar (a watch call's capture bar) and the current call session, as the engine has them. */
  setBarred(on: boolean): void {
    this.barred = on;
  }
  setSession(s: unknown): void {
    this.current = s;
  }

  /** A lease for `kind` on behalf of `session` (null = no call: a meter, the connection test), or null when refused. */
  take(kind: LeaseKind, session: unknown): Lease | null {
    if (this.isBarred(kind) || (session !== null && session !== this.currentSession())) return null;
    const l = new Lease(this, kind, session, this.gen);
    this.live.add(l);
    return l;
  }

  admits(l: Lease): boolean {
    if (!this.enforce) return true;
    return l.gen === this.gen && !this.isBarred(l.kind) && (l.session === null || l.session === this.currentSession());
  }

  /** Revoke every lease (a Watch press, a queued one too; sign-out): each stops what it holds, NOW. Returns how many
   *  leases were live (uncommitted). */
  revoke(_why: string): number {
    if (!this.enforce) return 0;
    this.gen += 1;
    let n = 0;
    for (const l of this.live) {
      if (l.isCommitted()) continue;
      n += 1;
      l.stopAll();
    }
    // round 10 (the desktop's open_gates): every committed tap's gate closes now too
    const g = [...this.gates];
    this.gates.clear();
    for (const close of g) CaptureLeases.runStop(close);
    return n;
  }

  /** Leases whose operation hasn't ended yet (revoked ones included): a watch join starts only at 0. */
  pending(): number {
    return this.live.size;
  }

  private isBarred(kind: LeaseKind): boolean {
    return this.barred || (this.rules?.barred(kind) ?? false);
  }
  private currentSession(): unknown {
    return this.rules ? this.rules.session() : this.current;
  }

  release(l: Lease): void {
    this.live.delete(l);
  }

  static runStop(f: () => void): void {
    try {
      f();
    } catch {
      /* every resource gets its stop, whatever one of them throws */
    }
  }
}

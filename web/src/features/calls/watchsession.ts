// watchsession.ts — Pad Watch (12.1.7, share claude/tinhat-pad/WATCH-1217/STATE-TABLE.md): the ONE place that decides
// whether a call join WATCHES (no microphone, nothing captured or published until this device's own "Talk here").
// Byte-compatible with the desktop's crates/app/src/watch_session.rs; both run the same case table
// (watchsession.cases.json, sha256 pinned in both tests).
//
// The rule. A Watch press starts a WATCH EPISODE; every other press (Join, a switch, Try again, the guest hand-off)
// starts a NORMAL one; Leave / session loss / a give-up end the episode. Internal joins never choose a mode: a
// recovery after a drop holds the TICKET (the episode id) it was given and joins only while that episode is still
// the current one, in that episode's mode; a join queued behind a teardown is the episode that queued it. So a press,
// a Leave or a sign-out during a teardown voids the recovery instead of letting it rejoin normally.
// The capture BAR (engine captureBarred / streamer capture_barred) is set from the episode when its join starts and
// cleared only by a NORMAL join's start or Talk here — never by a leave (fail closed: anything still in flight from a
// watch call stays refused until the next normal join).

export type Phase = "idle" | "connecting" | "live" | "tearing";

export interface Episode {
  id: number;
  room: string;
  watch: boolean;
}

export type Decision =
  | { kind: "none"; why: string }
  | { kind: "join"; id: number; room: string; watch: boolean }
  | { kind: "queue"; id: number; room: string; watch: boolean }
  | { kind: "leave-then-join"; id: number; room: string; watch: boolean }
  | { kind: "leave" }
  | { kind: "abort"; why: string };

export class WatchLedger {
  private seq = 0;
  ep: Episode | null = null;
  /** the episode queued behind a teardown (joined by teardownDone) */
  pending: number | null = null;
  bar = false;

  private fresh(room: string, watch: boolean): Episode {
    this.seq += 1;
    this.ep = { id: this.seq, room, watch };
    return this.ep;
  }
  private join(kind: "join" | "queue" | "leave-then-join", e: Episode): Decision {
    return { kind, id: e.id, room: e.room, watch: e.watch };
  }

  /** a Join press (call buttons, palette, Pad join, Answer, Try again, the guest hand-off): always a normal join */
  pressJoin(room: string, phase: Phase): Decision {
    if (!room) return { kind: "none", why: "no room" };
    if (phase === "live" || phase === "connecting") return { kind: "none", why: "in a call" };
    const e = this.fresh(room, false);
    if (phase === "tearing") {
      this.pending = e.id;
      return this.join("queue", e);
    }
    this.pending = null;
    return this.join("join", e);
  }

  /** the Watch press: a watch join; refused while a call is up or connecting */
  pressWatch(room: string, phase: Phase): Decision {
    if (!room) return { kind: "none", why: "no room" };
    if (phase === "live" || phase === "connecting") return { kind: "none", why: "in a call" };
    const e = this.fresh(room, true);
    if (phase === "tearing") {
      this.pending = e.id;
      return this.join("queue", e);
    }
    this.pending = null;
    return this.join("join", e);
  }

  /** a switch press: the call already up (or joining) in that room stays as it is; any other room is a normal join */
  pressSwitch(room: string, phase: Phase, cur: string): Decision {
    if (!room) return { kind: "none", why: "no room" };
    if ((phase === "live" || phase === "connecting") && cur === room) return { kind: "none", why: "already there" };
    const e = this.fresh(room, false);
    if (phase === "idle") {
      this.pending = null;
      return this.join("join", e);
    }
    this.pending = e.id;
    return this.join(phase === "tearing" ? "queue" : "leave-then-join", e);
  }

  /** Leave / Stop watching: ends the episode — a recovery or a queued join of it never runs (the bar stays as is) */
  pressLeave(): Decision {
    this.ep = null;
    this.pending = null;
    return { kind: "leave" };
  }

  /** Talk here: the current watch episode becomes a normal one (its recoveries are normal joins) and capture opens */
  talk(): boolean {
    if (!this.ep || !this.ep.watch || this.pending !== null) return false;
    this.ep.watch = false;
    this.bar = false;
    return true;
  }

  /** the join of episode `id` really starts: the bar follows that episode; null = not the current episode, don't join */
  startJoin(id: number): { watch: boolean } | null {
    if (!this.ep || this.ep.id !== id) return null;
    this.bar = this.ep.watch;
    return { watch: this.ep.watch };
  }

  /** the call in `room` dropped. Recoverable → the ticket a recovery must present (null: nothing to recover);
   *  not recoverable (kicked, the call ended) → the episode ends. A drop of a call already being left changes nothing. */
  dropped(room: string, recoverable: boolean): number | null {
    if (!this.ep || this.ep.room !== room || this.pending !== null) return null;
    if (!recoverable) {
      this.ep = null;
      return null;
    }
    return this.ep.id;
  }

  /** a recovery (the auto-rejoin after a drop) holding `ticket`: joins only the episode that dropped, in its mode */
  recover(ticket: number | null): Decision {
    if (ticket === null) return { kind: "abort", why: "no ticket" };
    if (!this.ep || this.ep.id !== ticket || this.pending !== null) return { kind: "abort", why: "episode replaced or ended" };
    return this.join("join", this.ep);
  }

  /** an internal go-ahead for the current call's join (the call-host sheet): the current episode, in its mode */
  resume(room: string): Decision {
    if (!this.ep || this.ep.room !== room || this.pending !== null) return { kind: "abort", why: "not the current episode" };
    return this.join("join", this.ep);
  }

  /** every teardown finished: the queued episode joins (still current), else nothing */
  teardownDone(): Decision {
    const id = this.pending;
    this.pending = null;
    if (id === null) return { kind: "none", why: "nothing queued" };
    if (!this.ep || this.ep.id !== id) return { kind: "abort", why: "queued episode replaced" };
    return this.join("join", this.ep);
  }

  /** the join failed / was given up / the recovery budget ran out: the episode ends (the next join is a press) */
  gaveUp(): void {
    if (this.pending !== null) return;
    this.ep = null;
  }

  /** the reload rejoin (the one persisted mark): a new episode in the mode it was left in */
  reloadRejoin(room: string, watching: boolean, phase: Phase): Decision {
    if (!room || phase !== "idle") return { kind: "none", why: "busy" };
    const e = this.fresh(room, watching);
    this.pending = null;
    return this.join("join", e);
  }

  /** sign-out / session loss: no episode, nothing queued (the bar stays as is until a normal join) */
  sessionLost(): void {
    this.ep = null;
    this.pending = null;
  }

  /** every teardown is done and no episode is current (left / given up / signed out): the bar may open — nothing of a
   *  watch call is running any more. While an episode is current (even a dropped one recovering) it changes nothing. */
  settled(): boolean {
    if (this.ep || this.pending !== null) return false;
    this.bar = false;
    return true;
  }

  watching(): boolean {
    return this.ep?.watch === true;
  }
}

// takeover.ts — PAD-PHONE Step B, the COMPUTER's side of "the phone has the mic" (docs/PAD.md "Phone as Mic / Camera"):
// the pure rules, no store, no network, no clock of its own. The engine feeds it what it sees and does what it says.
// Mirrors the desktop's PadHost.qml / pad_engine.rs rules (the same cases are tested on both sides; client review r2).
//
// - A HOLD: the phone of Pad session `sid` (or, `auto`, a Pad Mic connection of my own person already transmitting when
//   I joined) holds this device's mic. Taking it mutes with a reason of its own; `prior` = the mic was already off, or the
//   user asked for it off meanwhile (their intent is kept: a give-back never turns it on against it).
// - EVERY unmute request while a hold or a restore is pending goes through ONE deferred handoff: the hold ends (the
//   phone sees take:false), the Pad Mic identities in the call are remembered (never auto-taken again), and the mic
//   comes on only once no Pad Mic of mine publishes an unmuted mic — never both live.
// - A give-back (the phone's on:false, its session ending, its connection leaving) restores only if the mic was on
//   (not `prior`), again only once the phone has stopped.
// - The auto hold is a JOINING rule (the first 15 s of a call), and never for an identity the user took the mic back from.
// - A mute request while a restore is pending cancels it.

export interface Hold {
  sid: string;
  device: string;
  prior: boolean;
  auto: string;
}

export type Act = "mute" | "unmute" | "none";

export const AUTO_TAKE_MS = 15_000;

export class Handoff {
  hold: Hold | null = null;
  /** the BARRIER: a phone that held the mic (released or relinquished) may still publish — nothing turns this mic on
   *  until no Pad Mic of mine publishes an unmuted mic (client review r3 #1: never cleared by a mute) */
  barrier = false;
  /** the WANT: the mic should come on once the barrier is down (an unmute request, or a give-back of a mic that was on) */
  want = false;
  /** the last ended hold was an automatic one with no Pad session: the phone can't be told — say "stop it there" */
  autoGone = false;
  /** Pad Mic identities the user took the mic back from */
  takenBack = new Set<string>();
  autoUntil = 0;

  /** compat: a restore is pending (barrier up or wanted) */
  get restorePending(): boolean {
    return this.barrier || this.want;
  }

  joined(now: number): void {
    this.hold = null;
    this.barrier = this.want = this.autoGone = false;
    this.takenBack.clear();
    this.autoUntil = now + AUTO_TAKE_MS;
  }
  ended(): void {
    this.hold = null;
    this.barrier = this.want = this.autoGone = false;
  }

  take(sid: string, device: string, micMuted: boolean): Act {
    if (this.hold) {
      this.hold = { ...this.hold, sid, device, auto: "" };
      return "none";
    }
    // a pending want carries over: the mic was meant to come on (r3 #2)
    this.hold = { sid, device, prior: this.want ? false : micMuted, auto: "" };
    this.barrier = this.want = this.autoGone = false;
    return micMuted ? "none" : "mute";
  }

  /** an automatic hold while joining — never after a take-back, never during an unresolved release (r3 #2) */
  autoTake(identity: string, device: string, micMuted: boolean, now: number): Act {
    if (this.hold || this.barrier || this.takenBack.has(identity) || now > this.autoUntil) return "none";
    this.hold = { sid: "", device, prior: this.want ? false : micMuted, auto: identity };
    this.want = false;
    return micMuted ? "none" : "mute";
  }

  /** a mute request (not the handoff's own): kept at the give-back; cancels a pending want — the barrier stays up */
  userMute(): void {
    if (this.hold) this.hold = { ...this.hold, prior: true };
    this.want = false;
  }

  /** an unmute request: while a hold, a barrier or a want exists it is deferred until the phone has stopped */
  requestUnmute(livePadMics: readonly string[], blocked = false): { handled: boolean; act: Act; autoGone: boolean } {
    if (!this.hold && !this.barrier && !this.want) return { handled: false, act: "none", autoGone: false };
    if (this.hold) {
      if (this.hold.auto) {
        this.takenBack.add(this.hold.auto);
        this.autoGone = !this.hold.sid;
      }
      this.hold = null;
      this.barrier = true;
    }
    for (const id of livePadMics) this.takenBack.add(id);
    this.want = true;
    // (client review r4 #2) the immediate path honours the same blockers (push-to-talk with the key up) as the deferred one
    return { handled: true, act: this.check(livePadMics.length > 0, blocked), autoGone: this.autoGone };
  }

  /** the phone gave the mic back: the barrier until it stopped; the mic comes on after only if it was on */
  release(): void {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    this.barrier = true;
    this.want = !h.prior;
  }

  /** re-checked on every call change: the barrier drops once the phone stopped; then a want turns the mic on, unless
   *  `blocked` (a moderator's mute, BRB, a watch call, push-to-talk with the key UP): the want then waits (a PTT key-down
   *  completes it later; a key-up is a mute request and cancels it) */
  check(phoneLive: boolean, blocked: boolean): Act {
    if (this.barrier && !phoneLive) {
      this.barrier = false;
      this.autoGone = false;
    }
    // (client review r4 #1) a want is fulfilled only while the phone is stopped RIGHT NOW: a phone live again re-raises
    // the barrier (an earlier "stopped" is never reused)
    if (this.want && phoneLive) this.barrier = true;
    if (this.barrier || !this.want || blocked) return "none";
    this.want = false;
    return "unmute";
  }

  holder(): string {
    return this.hold?.sid ?? "";
  }
}

/**
 * The PHONE's mic gate (Mic mode), serialized (client review r2 #5): at most ONE publish or unpublish in flight; the
 * latest wish is applied when it settles, so a close-then-reopen during a pending publish never leaves a publication
 * nobody tracks, and a stale completion never undoes a newer one. The engine silences the track (enabled=false) at once
 * whenever the wish turns off.
 */
export type GateOp = "publish" | "unpublish" | null;
export class MicGate {
  /** confirmed published */
  pub = false;
  busy: "" | "publish" | "unpublish" = "";
  want = false;
  /** a new wish; -> the operation to start now (null: nothing, or one is in flight: it runs when that settles) */
  set(want: boolean): GateOp {
    this.want = want;
    return this.next();
  }
  /** the operation in flight finished (ok = it took effect); -> the next one to start */
  settle(ok: boolean): GateOp {
    if (this.busy === "publish" && ok) this.pub = true;
    if (this.busy === "unpublish" && ok) this.pub = false;
    this.busy = "";
    // a failed operation isn't chained into another at once (no tight retry loop): the next gate run decides
    return ok ? this.next() : null;
  }
  /** live = published, wanted, nothing in flight */
  live(): boolean {
    return this.pub && this.want && !this.busy;
  }
  private next(): GateOp {
    if (this.busy) return null;
    if (this.want && !this.pub) return (this.busy = "publish");
    if (!this.want && this.pub) return (this.busy = "unpublish");
    return null;
  }
}

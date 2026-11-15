// callHealth.ts — call link watch (reconnect-wedge, 12.1.13): when a call that is no longer really connected must end
// VISIBLY: the "Call ended — connection lost" banner with Rejoin, or the auto-rejoin that runs before it.
// The desktop's crates/streamer call_health.rs, rule for rule; both run testvectors/call-health/vectors.json
// (byte-identical in both repos). The engine feeds it the room's real connection state once a second, every
// share/camera publish feeds it its timeout, and the room's own terminal drop latches it: the terminal drop
// reaches the call state exactly once.

/** A call reconnecting this long without a break is over. */
export const RECONNECT_GIVE_UP_MS = 60000;
/** The room says disconnected but no terminal drop followed this long after: say it ourselves. */
export const DISCONNECTED_GRACE_MS = 3000;
/** A share / camera publish that hasn't finished by then never will: the call isn't connected. */
export const PUBLISH_TIMEOUT_MS = 20000;

/** Status line when Share is pressed during a reconnect (desktop + web, same words). */
export const SHARE_WHILE_RECONNECTING = "Can't share while the call is reconnecting";
/** The error a timed-out publish rejects with; the share path shows it as "Share failed: " + this. */
export const NOT_CONNECTED_ERR = "the call isn't connected";
/** Status line when a share publish timed out (desktop + web, same words); the call then ends visibly. */
export const SHARE_NOT_CONNECTED = `Share failed: ${NOT_CONNECTED_ERR}`;

export type Link = "connected" | "reconnecting" | "disconnected";
export type LostWhy = "reconnect-too-long" | "engine-gave-up" | "publish-timed-out";

export class LinkWatch {
  private reconnectingSince: number | null = null;
  private disconnectedSince: number | null = null;
  private done = false;

  /** A verdict was given or the terminal drop came: nothing more will be said. */
  isDone(): boolean {
    return this.done;
  }

  /** One observation of the room's connection state at `now` (ms). A value = the call is lost (given once). */
  observe(now: number, link: Link): LostWhy | null {
    if (this.done) return null;
    if (link === "connected") {
      this.reconnectingSince = null;
      this.disconnectedSince = null;
      return null;
    }
    if (link === "reconnecting") {
      this.disconnectedSince = null;
      if (this.reconnectingSince === null) this.reconnectingSince = now;
      return this.verdict(now - this.reconnectingSince >= RECONNECT_GIVE_UP_MS, "reconnect-too-long");
    }
    this.reconnectingSince = null;
    if (this.disconnectedSince === null) this.disconnectedSince = now;
    return this.verdict(now - this.disconnectedSince >= DISCONNECTED_GRACE_MS, "engine-gave-up");
  }

  /** A publish timed out: the call is lost at once (unless already over). */
  publishTimedOut(): LostWhy | null {
    if (this.done) return null;
    return this.verdict(true, "publish-timed-out");
  }

  /** The room's own terminal drop reached us. true = first word on it (act); false = the watch already did. */
  terminal(): boolean {
    const first = !this.done;
    this.done = true;
    return first;
  }

  private verdict(lost: boolean, why: LostWhy): LostWhy | null {
    if (!lost) return null;
    this.done = true;
    return why;
  }
}

/** Share pressed: refuse during a reconnect (the publish would only wait on it). null = go ahead. */
export function shareRefusal(reconnecting: boolean): string | null {
  return reconnecting ? SHARE_WHILE_RECONNECTING : null;
}

/** livekit-client's ConnectionState, as the watch reads it (connecting = no observation). */
export function linkOf(state: string): Link | null {
  if (state === "connected") return "connected";
  if (state === "reconnecting" || state === "signalReconnecting") return "reconnecting";
  if (state === "disconnected") return "disconnected";
  return null;
}

// Pad Watch round 10/11 (share claude/tinhat-pad/WATCH-LEASE/ "ROUND 10", "ROUND 11"): the OUTPUT tap — the speaker
// meter's analyser on what the app plays (the call mix in the page's own AudioContext; a browser has no loopback of
// other apps' output, getDisplayMedia audio aside, which is leased as share-audio). Parity with the desktop's
// speaker-output taps (the streamer's Kind::OutputTap): an "output-tap" lease, refused while watching. Round 11: the
// gate is at the SOURCE — the analyser is connected to the playback mix (`connect`, audio.openOutputTap) only after
// the lease committed, and the gate registered at the commit (commitOpening) DISCONNECTS it; the next revoke (the Watch
// press, sign-out) runs it at once. Playback itself (master → destination) is never touched.
import type { CaptureLeases } from "./capturelease";

export interface OutputTap {
  /** may the speaker meter read the playback mix now? (connects it under a fresh lease once not watching) */
  ok(): boolean;
  /** the meter closed: disconnect the analyser and release the gate */
  close(): void;
}

export function makeOutputTap(leases: CaptureLeases, connect: () => () => void): OutputTap {
  let open = false;
  let gate: (() => void) | null = null;
  return {
    ok(): boolean {
      if (open) return true;
      const l = leases.take("output-tap", null);
      if (!l) return false;
      let disconnect: (() => void) | null = null;
      const g = () => {
        open = false;
        gate = null;
        disconnect?.();
        disconnect = null;
      };
      open = l.commitOpening(g);
      if (open) {
        gate = g;
        disconnect = connect(); // (synchronous after the commit: no revoke can come in between)
      }
      l.done();
      return open;
    },
    close(): void {
      const g = gate;
      if (!g) return;
      leases.removeGate(g);
      g();
    },
  };
}

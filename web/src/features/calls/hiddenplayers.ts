// hiddenplayers.ts — remote call video has no <video> player while the page is hidden; a FRESH player takes the track
// the moment the page shows, before the SFU is asked to send again (10.8.1).
//
// Why: Chromium (seen on 153) wedges the receive side of an E2EE remote video — a track with an encoded
// (RTCRtpScriptTransform) transform — whose <video> player sat in a hidden page across the SFU pause (hidden = the
// track is released at the SFU, GPU.md §2.11). After the page shows again the first frame (the SFU's low-layer
// keyframe) decodes, then no encoded frame reaches the transform any more — for minutes: the tile stayed on a frozen
// 320×180 frame ("~1 fps at 320×180 for over a minute"). The SFU's stream is clean (packet capture: contiguous
// sequence numbers, keyframes, the layer switch), a disable / enable at the SFU does not help, pausing at the SFU while
// the page stays visible does not wedge, and a detach + attach of the element (a new player) releases it at once.
// With no player while hidden there is nothing to wedge — and hidden means "nothing drawn, no decode" anyway: the
// desktop pauses its remote decode pipelines while hidden too (Main.qml _applyVisibilityPause → pauseRemoteTiles).
//
// A tile that a visible Tin Hat window still shows (a Document PiP pop-out, the <video> Picture-in-Picture) keeps its
// player (GPU.md §2.11: hidden is per track). Pure bookkeeping — the engine supplies detach / attach and the tile list.

export interface PlayerOps {
  /** give the track back: the tile's element holds no player (false = nothing to detach) */
  detach(tileId: string): boolean;
  /** hand the track to the tile's element again — a fresh player (false = no element or no track yet) */
  attach(tileId: string): boolean;
}

export interface SyncResult {
  held: string[];
  restored: string[];
}

/** remote camera / share tiles (not the self-view or the own share preview) */
export function isRemoteVideoTile(tileId: string): boolean {
  return tileId.startsWith("vid_") && tileId !== "vid_selfview" && tileId !== "vid_selfshare";
}

export class HiddenPlayers {
  private readonly held = new Set<string>();
  private readonly ops: PlayerOps;

  constructor(ops: PlayerOps) {
    this.ops = ops;
  }

  /** Re-evaluate every remote tile for the page state: hidden → release each player a visible window doesn't show;
   *  shown (or now in a visible pop-out) → attach it again. Call it BEFORE the tracks are re-enabled at the SFU. */
  sync(hidden: boolean, tiles: Iterable<string>, keep: (tileId: string) => boolean): SyncResult {
    const out: SyncResult = { held: [], restored: [] };
    const list = [...tiles];
    for (const tileId of list) {
      if (!isRemoteVideoTile(tileId)) continue;
      const hold = hidden && !keep(tileId);
      if (hold && !this.held.has(tileId)) {
        if (this.ops.detach(tileId)) {
          this.held.add(tileId);
          out.held.push(tileId);
        }
      } else if (!hold && this.held.has(tileId)) {
        this.held.delete(tileId);
        if (this.ops.attach(tileId)) out.restored.push(tileId);
      }
    }
    // a held tile that is gone from the list (unsubscribed, unmounted) is forgotten, not attached
    const listed = new Set(list);
    for (const tileId of [...this.held]) if (!listed.has(tileId)) this.held.delete(tileId);
    return out;
  }

  /** An element for a remote tile arrives (a mount, a resubscription) while the page is hidden: true = hold it
   *  (don't attach now; the next sync on show attaches it). */
  holdOnAttach(hidden: boolean, tileId: string, keep: (tileId: string) => boolean): boolean {
    if (!hidden || !isRemoteVideoTile(tileId) || keep(tileId)) {
      this.held.delete(tileId);
      return false;
    }
    this.held.add(tileId);
    return true;
  }

  isHeld(tileId: string): boolean {
    return this.held.has(tileId);
  }

  forget(tileId: string): void {
    this.held.delete(tileId);
  }

  clear(): void {
    this.held.clear();
  }
}

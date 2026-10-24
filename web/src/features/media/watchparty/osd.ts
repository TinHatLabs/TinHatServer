// watchparty/osd.ts — what the on-screen display says about someone ELSE's playback write (11.3 QOL, QOL.md §2). Pure (no
// imports) so node tests load it. The window feeds it each new `dev.tinhat.watchparty.playback` event with its
// SENDER (getSender — never written to the wire): only a `playing` flip, a `seekNonce` change or a `url` change by
// another person shows anything; the advancer's drift / heartbeat writes (same url, same nonce, same playing) never do,
// and neither does its stale-clock write (playing → false after the clock went > 60 s without any write).

export interface PbSnap {
  url: string;
  playing: boolean;
  seekNonce: number;
  positionSecs: number;
  updatedAt: number;
}

export type RemoteChange = { kind: "nowPlaying"; url: string } | { kind: "jumped"; at: number } | { kind: "paused" } | { kind: "played" };

/** the native PLAYBACK_LIVE_TTL (engine.ts PLAYBACK_LIVE_TTL_MS): an advancer's write after this long is a stale flip */
export const STALE_FLIP_MS = 60_000;

/** `prev` = the clock before this event (null = cleared / nothing); `next` = this event's clock (null = cleared). */
export function remoteChange(prev: PbSnap | null, next: PbSnap | null, sender: string, me: string): RemoteChange | null {
  if (!next || !sender || sender === me) return null;
  if (next.url !== (prev?.url ?? "")) return next.url.startsWith("tinhat-memory://") ? null : { kind: "nowPlaying", url: next.url };
  if (!prev) return null;
  if (next.seekNonce !== prev.seekNonce && next.seekNonce !== 0) return { kind: "jumped", at: next.positionSecs };
  if (next.playing !== prev.playing) {
    if (!next.playing && next.updatedAt - prev.updatedAt > STALE_FLIP_MS) return null;
    return next.playing ? { kind: "played" } : { kind: "paused" };
  }
  return null;
}

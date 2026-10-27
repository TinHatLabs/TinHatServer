// limits.mjs — the per-address request limits of the Tin Hat API (server.mjs's shared limiter; the Reach routes,
// the game servers and the guest room keep their own). Pure: the clock is injected, so the tests drive it.
//
// Four tiers, per REAL client address (server.mjs: trust proxy):
//   - /vods/file + /vods/thumb: exempt (every request carries its HMAC signature; the player's media plane).
//   - /vods/sessions: 60/min.
//   - /clip + /fetch, the soundboard's clip reads: 240/min. Every play reads its clip again (the desktop twice: its
//     speakers + the call), so the strict 30/min below cut fast tapping, or a Pad, off after ~15 sounds a minute, and
//     a household behind one router shares the count. A clip the server doesn't have yet (a myinstants fetch) also
//     costs one from the strict tier: only reads of what is already on the disk get the larger allowance.
//     /clip/sign (a member's app asks for a signed link right before it plays a sound) counts like a clip read.
//   - everything else (soundboard search, GIFs, the invites check, …): strict 30/min.
// Callers are keyed by server.mjs with reachcommon.ipBucket: an IPv4 address or an IPv6 /64.
import { RateLimit } from "./reachcommon.mjs";

export const STRICT_PER_MIN = 30;
export const SESSIONS_PER_MIN = 60;
export const CLIPS_PER_MIN = 240;

/** The clip routes as Express matches them by default: any case, with or without a trailing slash. */
export function isClipPath(path) {
    const p = String(path).toLowerCase().replace(/\/+$/, "");
    return p === "/clip" || p === "/fetch" || p === "/clip/sign";
}

export function createLimits(now) {
    const strict = new RateLimit(STRICT_PER_MIN, 60_000, now);
    const sessions = new RateLimit(SESSIONS_PER_MIN, 60_000, now);
    const clips = new RateLimit(CLIPS_PER_MIN, 60_000, now);
    return {
        /** The shared limiter's check of a request for `path` from `ip`: true = go on (and counted). */
        request(path, ip) {
            if (path.startsWith("/vods/file/") || path.startsWith("/vods/thumb/")) return true;
            if (path.startsWith("/vods/sessions")) return sessions.hit(ip);
            if (isClipPath(path)) return clips.hit(ip);
            return strict.hit(ip);
        },
        /** A clip that must come from upstream first: one from the strict tier. true = go on. */
        upstreamFetch(ip) {
            return strict.hit(ip);
        },
        /** Drop idle addresses (server.mjs runs it every 10 minutes). */
        sweep() {
            strict.sweep();
            sessions.sweep();
            clips.sweep();
        },
    };
}

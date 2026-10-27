// limits.mjs — the games catalogue's request limits (security review 2026-10-26: it had none, and every request with
// a bearer cost a fresh Synapse whoami). Pure: the clock is injected, so the tests drive it.
//
//   per address (an IPv4 address or an IPv6 /64, reachcommon.ipBucket):
//     /art/*  600 a minute (the Game Reel shows many covers at once; cached art is a file read)
//     else    120 a minute
//   per person (after the sign-in check):
//     search  30 a minute (each can run a Steam store search)
//     custom  20 a day, and at most CUSTOM_MAX custom games made by one person in the catalogue
//     library 10 an hour (two Steam Web API calls each)
import { RateLimit } from "../tinhat-api/reachcommon.mjs";

export const G = Object.freeze({ ART_PER_MIN: 600, OTHER_PER_MIN: 120, SEARCH_PER_MIN: 30, CUSTOM_PER_DAY: 20,
    CUSTOM_MAX: 200, LIBRARY_PER_HOUR: 10 });

export function createGamesLimits(now) {
    const art = new RateLimit(G.ART_PER_MIN, 60_000, now);
    const other = new RateLimit(G.OTHER_PER_MIN, 60_000, now);
    const per = {
        search: new RateLimit(G.SEARCH_PER_MIN, 60_000, now),
        custom: new RateLimit(G.CUSTOM_PER_DAY, 24 * 3600_000, now),
        library: new RateLimit(G.LIBRARY_PER_HOUR, 3600_000, now),
    };
    return {
        /** The per-address check of a request for `path`; true = go on (and counted). /health is never limited. */
        request(path, key) {
            const p = String(path).toLowerCase();
            if (p === "/health") return true;
            return p.startsWith("/art/") ? art.hit(key) : other.hit(key);
        },
        /** One `kind` ("search" | "custom" | "library") for `user`; true = go on (and counted). */
        user(kind, user) { return per[kind].hit(user); },
        retryAfter(kind, user) { return per[kind].retryAfter(user); },
        sweep() { art.sweep(); other.sweep(); for (const r of Object.values(per)) r.sweep(); },
    };
}

/** May `user` make one more custom game, with `rows` (the catalogue's entries) as they are? */
export function customAllowed(rows, user) {
    let n = 0;
    for (const g of rows) if (g && g.source === "custom" && g.createdBy === user && ++n >= G.CUSTOM_MAX) return false;
    return true;
}

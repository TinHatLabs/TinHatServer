// access.mjs — who may make this server spend its owner's keys and its outbound fetches (security review 2026-10-26,
// finding H4). Used by server.mjs for the GIF picker (Giphy), the soundboard (myinstants search + clip cache) and,
// through watch.mjs, Media Party (YouTube Data API units).
//
// Two lanes:
//   member  the request carries `Authorization: Bearer <Matrix access token>` and Synapse says whose it is
//           (reachcommon.createMatrixAuth: cached 60 s, budgeted). A bad token is a 401 — it never falls back to the
//           lane below. Upstream calls count against that PERSON's hourly budget per family (429 when spent).
//   legacy  no token at all: Tin Hat apps released before the server asked for one (desktop 12.0.x, the web app of
//           servers up to 0.3.3) keep working while the owner's members update. Cached answers are served as before;
//           every UPSTREAM call (a Giphy request, a myinstants search or clip download, YouTube units) comes out of
//           that caller's own allowance (per address: an IPv4 address or an IPv6 /64, reachcommon.clientKey) under a
//           larger ceiling for every token-less caller together, so one stranger can't drain anyone else's and all of
//           them can spend at most the ceiling — never the members' budgets (review of 116d103, #2: it was one pool).
//           Spent (or the lane switched off: API_LEGACY_ANON=off) → 401 SIGNIN_REQUIRED.
//
// Every number is an environment variable (docs/API.md "Who may use the extras"); 0 means none.
import { RateLimit, mono, clientKey } from "./reachcommon.mjs";

const HOUR = 3600_000;

export const ACCESS_DEFAULTS = Object.freeze({
    legacy: true,                // API_LEGACY_ANON: on|off — the token-less lane for older apps
    anonGifPerHour: 60,          // API_ANON_GIF_PER_HOUR: Giphy calls per token-less caller (address)
    anonGifAllPerHour: 300,      // API_ANON_GIF_ALL_PER_HOUR: ... and for every token-less caller together
    anonSoundSearchPerHour: 60,  // API_ANON_SOUNDSEARCH_PER_HOUR: myinstants searches per token-less caller
    anonSoundSearchAllPerHour: 600, // API_ANON_SOUNDSEARCH_ALL_PER_HOUR
    anonClipFetchPerHour: 120,   // API_ANON_CLIPFETCH_PER_HOUR: new clips fetched for a token-less caller
    anonClipFetchAllPerHour: 1200, // API_ANON_CLIPFETCH_ALL_PER_HOUR
    userGifPerHour: 240,         // API_USER_GIF_PER_HOUR: Giphy calls per person
    userSoundSearchPerHour: 240, // API_USER_SOUNDSEARCH_PER_HOUR
    userClipFetchPerHour: 240,   // API_USER_CLIPFETCH_PER_HOUR: clips fetched from myinstants per person
    userClipSignPerHour: 1200,   // API_USER_CLIPSIGN_PER_HOUR: signed clip links per person (/clip/sign)
    searchedClipPerAddrHour: 60, // API_SEARCHED_CLIPFETCH_PER_IP_HOUR: new clips a search answer handed out, per address
    searchedClipPerHour: 600,    // API_SEARCHED_CLIPFETCH_PER_HOUR: ... and for every address together
    watchAnonUnitsPerDay: 1000,  // WATCH_ANON_UNITS_PER_DAY: YouTube units per Pacific day per token-less caller
    watchAnonAllUnitsPerDay: 4000, // WATCH_ANON_ALL_UNITS_PER_DAY: ... and for every token-less caller together
    watchUserUnitsPerDay: 9000,  // WATCH_USER_UNITS_PER_DAY: per person (a Media Party host can use most of the day's)
});

const ENV_NAMES = {
    anonGifPerHour: "API_ANON_GIF_PER_HOUR", anonSoundSearchPerHour: "API_ANON_SOUNDSEARCH_PER_HOUR",
    anonGifAllPerHour: "API_ANON_GIF_ALL_PER_HOUR", anonSoundSearchAllPerHour: "API_ANON_SOUNDSEARCH_ALL_PER_HOUR",
    anonClipFetchAllPerHour: "API_ANON_CLIPFETCH_ALL_PER_HOUR", watchAnonAllUnitsPerDay: "WATCH_ANON_ALL_UNITS_PER_DAY",
    anonClipFetchPerHour: "API_ANON_CLIPFETCH_PER_HOUR", userGifPerHour: "API_USER_GIF_PER_HOUR",
    userSoundSearchPerHour: "API_USER_SOUNDSEARCH_PER_HOUR", userClipFetchPerHour: "API_USER_CLIPFETCH_PER_HOUR",
    userClipSignPerHour: "API_USER_CLIPSIGN_PER_HOUR", watchAnonUnitsPerDay: "WATCH_ANON_UNITS_PER_DAY",
    searchedClipPerAddrHour: "API_SEARCHED_CLIPFETCH_PER_IP_HOUR", searchedClipPerHour: "API_SEARCHED_CLIPFETCH_PER_HOUR",
    watchUserUnitsPerDay: "WATCH_USER_UNITS_PER_DAY",
};

/** The settings from the environment: whole numbers >= 0 (anything else keeps the default). */
export function accessConfig(env = process.env) {
    const out = { ...ACCESS_DEFAULTS };
    const lane = String(env.API_LEGACY_ANON ?? "").trim().toLowerCase();
    if (["off", "0", "false", "no"].includes(lane)) out.legacy = false;
    for (const [k, name] of Object.entries(ENV_NAMES)) {
        const raw = String(env[name] ?? "").trim();
        if (/^\d{1,9}$/.test(raw)) out[k] = Number(raw);
    }
    return out;
}

/** What a token-less caller gets once the lane is off or its allowance is spent (status 401). */
export const SIGNIN_REQUIRED = Object.freeze({
    error: "Sign in to use this. If you are signed in, update Tin Hat.",
    signin: true,
});

export const FAMILIES = Object.freeze({
    gif: ["anonGifPerHour", "userGifPerHour", "GIF searches", "anonGifAllPerHour"],
    soundsearch: ["anonSoundSearchPerHour", "userSoundSearchPerHour", "sound searches", "anonSoundSearchAllPerHour"],
    clipfetch: ["anonClipFetchPerHour", "userClipFetchPerHour", "new sounds", "anonClipFetchAllPerHour"],
    clipsign: [null, "userClipSignPerHour", "sound links", null],
});

const hasBearer = (req) => /^Bearer\s+\S/i.test(String(req.headers?.authorization || ""));

/**
 * deps: { auth (createMatrixAuth), config (accessConfig()), now (ms clock, monotonic by default) }.
 * Returns { resolve, member, memberOrLegacy, optionalMember, spend, spendAs, spendSearched, refuse, config }.
 */
export function createAccess({ auth, config = ACCESS_DEFAULTS, now = mono }) {
    const budgets = {};
    // a clip one of our search answers handed out, fetched by a player that sends no token: per address and overall
    const searchedPerAddr = new RateLimit(config.searchedClipPerAddrHour, HOUR, now);
    const searchedAll = new RateLimit(config.searchedClipPerHour, HOUR, now);
    for (const [fam, [anonKey, userKey, , allKey]] of Object.entries(FAMILIES)) {
        budgets[fam] = {
            anon: anonKey ? new RateLimit(config[anonKey], HOUR, now) : null,       // per token-less caller
            anonAll: allKey ? new RateLimit(config[allKey], HOUR, now) : null,      // every token-less caller together
            user: new RateLimit(config[userKey], HOUR, now),
        };
    }

    /** Resolve the bearer into req.matrixUser; false = a response was sent (401 / 429 / 502). */
    async function resolve(req, res) {
        let who;
        try { who = await auth.authenticate(req, res); } catch { res.status(502).json({ error: "homeserver unreachable" }); return false; }
        if (!who) return false;
        req.matrixUser = who.user;
        req.legacy = false;
        return true;
    }

    /** Members only (the bearer is required, whatever the legacy lane says). */
    async function member(req, res, next) {
        if (await resolve(req, res)) next();
    }

    /** A bearer must be valid; no bearer = the legacy lane (401 SIGNIN_REQUIRED when it is off). */
    async function memberOrLegacy(req, res, next) {
        if (hasBearer(req)) { if (await resolve(req, res)) next(); return; }
        if (!config.legacy) return res.status(401).json(SIGNIN_REQUIRED);
        req.matrixUser = undefined;
        req.legacy = true;
        next();
    }

    /** Like memberOrLegacy, but a token-less caller always goes on (the clip route: cached clips are public bytes,
     *  and an upload's id is its own capability); what it may spend is decided by spend(). */
    async function optionalMember(req, res, next) {
        if (hasBearer(req)) { if (await resolve(req, res)) next(); return; }
        req.matrixUser = undefined;
        req.legacy = true;
        next();
    }

    /**
     * May this request make one upstream call of `family`? null = yes (and counted); otherwise {status, body,
     * retryAfter} to send (refuse()). Members count against their own budget; token-less callers against the shared
     * allowance (none when the legacy lane is off).
     */
    function spend(req, family) {
        const b = budgets[family];
        if (!b) throw new Error(`unknown family ${family}`);
        if (req.matrixUser) {
            if (b.user.hit(req.matrixUser)) return null;
            return { status: 429, retryAfter: b.user.retryAfter(req.matrixUser),
                body: { error: `That's a lot of ${FAMILIES[family][2]} for one hour. Try again a bit later.` } };
        }
        // token-less: this caller's own allowance and the ceiling for everybody, both or neither
        const who = clientKey(req);
        if (config.legacy && b.anon && b.anonAll && b.anon.can(who) && b.anonAll.can("all")) {
            b.anon.hit(who);
            b.anonAll.hit("all");
            return null;
        }
        return { status: 401, body: SIGNIN_REQUIRED };
    }

    /** Like spend() for a member, but charged to `key` (a budget principal: e.g. whoever signed a clip link). */
    function spendAs(family, key) {
        const b = budgets[family];
        if (!b) throw new Error(`unknown family ${family}`);
        if (b.user.hit(key)) return null;
        return { status: 429, retryAfter: b.user.retryAfter(key),
            body: { error: `That's a lot of ${FAMILIES[family][2]} for one hour. Try again a bit later.` } };
    }

    /** One download of a clip a search answer handed out, by an address that sent no token: both budgets or none. */
    function spendSearched(addrKey) {
        if (searchedPerAddr.can(addrKey) && searchedAll.can("all")) {
            searchedPerAddr.hit(addrKey);
            searchedAll.hit("all");
            return null;
        }
        return { status: 429, retryAfter: Math.max(searchedPerAddr.retryAfter(addrKey), 1),
            body: { error: "That's a lot of new sounds for one hour. Try again a bit later." } };
    }

    function refuse(res, r) {
        if (r.retryAfter) res.set ? res.set("Retry-After", String(r.retryAfter)) : res.setHeader("Retry-After", String(r.retryAfter));
        return res.status(r.status).json(r.body);
    }

    return { resolve, member, memberOrLegacy, optionalMember, spend, spendAs, spendSearched, refuse, config };
}

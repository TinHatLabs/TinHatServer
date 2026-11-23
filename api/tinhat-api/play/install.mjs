// Wiring the mini games into the Tin Hat API (server.mjs calls installPlay once). Everything comes from the
// environment the manager writes (docs/PLAY.md): no database settings = games off (the API answers 503 off).
//   PLAY_ENABLED=1|0            Dashboard → Features → Mini games (the manager always writes it, default 0 since 0.3.20;
//                               missing here = on, which only a hand-made env with a games database could hit)
//   PLAY_RIG_PHONE_APPS=1|0     "Show The Rig in the iPhone and Android apps" (default off: PLAY_DEFAULTS in the manager)
//   PLAY_DAY_MAX, PLAY_START    §2.7 (bounds in rules.mjs; out of bounds = the default + one log line)
//   PLAY_TZ                     the server day's time zone (the update schedule's zone; UTC if none)
//   PLAY_DB_HOST / PLAY_DB_NAME / PLAY_DB_USER / PLAY_DB_PASSWORD_FILE, or PLAY_DB_URL (labs/tests)
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import express from "express";
import pg from "pg";
import { migrate } from "./db.mjs";
import { configFromEnv } from "./rules.mjs";
import { createStateReader, createSpaces, createSpaceInfo } from "./space.mjs";
import { createPlay } from "./platform.mjs";
import { createSampler } from "./sampler.mjs";
import { signLk } from "../calltoken.mjs";
import { parseNetwork } from "../network.mjs";

const on = (v, dflt) => (v === undefined || v === "" ? dflt : !["0", "off", "false", "no"].includes(String(v).trim().toLowerCase()));

/** The salt for the deletion tombstones (§2.2): 32 random bytes kept in the API's own folder (0600), made once. */
function saltFrom(dir) {
    const p = join(dir, "play-salt");
    try { const s = readFileSync(p, "utf8").trim(); if (s.length >= 32) return s; } catch { /* first run */ }
    const s = randomBytes(32).toString("base64url");
    writeFileSync(p, s + "\n", { mode: 0o600 });
    return s;
}

/**
 * Who a play sign-in's Matrix OpenID token belongs to (§1.1): this server's own Synapse for a local player; for a
 * federated one, only a server on this server's connection list (network.json), asked through fedresolve (the SSRF-
 * guarded federation client). -> the mxid, or null (refused: the route answers `session`). Throws {code}:
 *   "remote-refused"  not a connected server, or one the SSRF guard refuses (not public / not a server name) — 403
 *   "unavailable"     the other server can't be asked right now — 503
 * fedresolve.userinfo() answers {sub} (an OBJECT) | null; reading it as a string refused EVERY federated player
 * (G3, games-gates 21:48).
 */
export function createOpenIdResolver({ hs, serverName, conf, federation }) {
    // an id's server, exactly: everything after the FIRST colon. `@p:evil:far.example` belongs to "evil:far.example";
    // an endsWith(":far.example") check would wrongly take it as far.example's (astra round 4)
    const serverOf = (id) => { const m = /^@[^:\s]{1,255}:(.+)$/.exec(typeof id === "string" ? id : ""); return m ? m[1] : null; };
    return async function resolveOpenId({ openid, user_id }) {
        const server = openid.matrix_server_name;
        if (server === serverName) {
            const r = await hs.get(`/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(openid.access_token)}`);
            const sub = r.ok && typeof r.body?.sub === "string" ? r.body.sub : null;
            return sub && sub === user_id && serverOf(sub) === serverName ? sub : null;
        }
        // a federated player: only from a server on this server's list (network.json, the manager's connections)
        let net = null;
        try { net = parseNetwork(readFileSync(join(conf, "network.json"), "utf8")); } catch { /* none */ }
        if (!net || !net.connected.includes(server) || !federation) throw Object.assign(new Error("remote-refused"), { code: "remote-refused" });
        let r;
        try { r = await federation.userinfo(server, openid.access_token); } catch (e) {
            if (e && e.status === 403) throw Object.assign(new Error("remote-refused"), { code: "remote-refused" }); // the SSRF guard
            if (e && e.status === 502) throw Object.assign(new Error("unavailable"), { code: "unavailable" }); // it didn't answer
            throw e; // anything else is a bug here, never dressed up as the other server's outage
        }
        const sub = r && typeof r.sub === "string" ? r.sub : null;
        return sub && sub === user_id && serverOf(sub) === server ? sub : null;
    };
}

export function installPlay(app, { env = process.env, conf, hs, adminToken, serverName, federation, isGuest, lk = null, log = (s) => console.log(s), isServerAdmin = async () => false }) {
    const dbConfigured = !!(env.PLAY_DB_URL || env.PLAY_DB_HOST);
    const flags = () => ({ play: dbConfigured && on(env.PLAY_ENABLED, true), rig_phone_apps: on(env.PLAY_RIG_PHONE_APPS, false) });
    const router = express.Router();
    if (!dbConfigured || !adminToken) {
        // games off: one answer for every play path, so the apps (which show games only on features.play: true) and
        // anyone calling directly see the same thing
        router.all(/^\/(v1|api\/play\/v1)(\/.*)?$/, (_req, res) => { res.set("Access-Control-Allow-Origin", "*"); res.status(503).json({ code: "off", error: "games are off on this server" }); });
        app.use(router);
        log(`[play] off (${!dbConfigured ? "no games database configured" : "no system account"})`);
        return { attach() {}, ready: Promise.resolve(false), drain: async () => {} };
    }
    const cfg = configFromEnv(env, (w) => log(`[play] ${w}`));
    let password = env.PLAY_DB_PASSWORD;
    if (!password && env.PLAY_DB_PASSWORD_FILE) { try { password = readFileSync(env.PLAY_DB_PASSWORD_FILE, "utf8").trim(); } catch { log("[play] PLAY_DB_PASSWORD_FILE unreadable"); } }
    const pool = env.PLAY_DB_URL ? new pg.Pool({ connectionString: env.PLAY_DB_URL, max: 8 })
        : new pg.Pool({ host: env.PLAY_DB_HOST, port: Number(env.PLAY_DB_PORT || 5432), database: env.PLAY_DB_NAME || "tinhat_play", user: env.PLAY_DB_USER || "tinhat_play", password, max: 8 });
    pool.on("error", (e) => log(`[play] database: ${e.message}`));
    // the ONE admin-API handle the games get: read-only room state, allow-listed (space.mjs)
    const reader = createStateReader({ call: hs.call, adminToken });
    const spaces = createSpaces({ reader, serverName });
    const spaceInfo = createSpaceInfo(reader);
    const resolveOpenId = createOpenIdResolver({ hs, serverName, conf, federation });
    // the call server's room service (LiveKit twirp), signed per request like calltoken.mjs does: a room-list token for
    // ListRooms, a room-admin token for one room's ListParticipants; read-only calls only
    async function lkCall(method, room, body) {
        const nowS = Math.floor(Date.now() / 1000);
        const tok = signLk({ iss: lk.key, sub: "tinhat-api-play", nbf: nowS - 10, exp: nowS + 60, video: room ? { room, roomAdmin: true } : { roomList: true } }, lk.secret);
        const r = await fetch(`${lk.url}/twirp/livekit.RoomService/${method}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`call server said ${r.status}`);
        return r.json();
    }
    const recorder = (env.RECORDER_USER || "").trim();
    const sampler = lk && lk.secret ? createSampler({
        pool, cfg, spaces, isGuest, isRecorder: (u) => !!recorder && u === recorder, log,
        lk: { listRooms: async () => (await lkCall("ListRooms", "", {}))?.rooms || [], participants: async (room) => (await lkCall("ListParticipants", room, { room }))?.participants || [] },
    }) : null;
    // guests, the Memories recorder and the server's own system account never get a wallet (§2.2)
    const system = `@tinhat-system:${serverName}`; // manager config.SYSTEM_LOCALPART
    const noWallet = (u) => isGuest(u) || u === system || (!!recorder && u === recorder);
    let playRef = null; // the sampler asks the platform for an open Rig round's running result (holdings, §2.1)
    if (sampler) sampler.setProvisional?.((w) => (playRef ? playRef.provisionalOf(w) : 0));
    const play = createPlay({ pool, cfg, flags, spaces, spaceInfo, resolveOpenId, isGuest: noWallet, serverName, salt: saltFrom(conf), log, onMove: (u) => sampler?.touch(u),
        isServerAdmin }); // F8: the server owner (a Synapse server admin here, from server.mjs) counts as an admin of every space it keeps
    playRef = play;
    if (sampler) sampler.setOnCredit((wid, sid) => play.pushWalletFor(wid, sid));
    play.routes(router);
    // the same routes under /api/play/v1 too (a lab without Caddy in front); Caddy strips /api/play
    const prefixed = express.Router(); play.routes(prefixed);
    app.use(router);
    app.use("/api/play", prefixed);
    // the manager creates the role + database once Postgres is up (play.py ensure_db): until then games answer 503 db,
    // and this tries again every 30 s (one log line the first time, then one when it works)
    const ready = (async () => {
        for (let i = 0; ; i++) {
            try {
                await migrate(pool); await play.recover();
                log(`[play] ${flags().play ? "on" : "off (the owner's switch: the database is ready, nothing is offered or earned)"}: day max ${cfg.day_max}, start ${cfg.start}, day in ${cfg.tz}, The Rig in the phone apps ${flags().rig_phone_apps ? "shown" : "hidden"}${sampler ? "" : "; no call server key: nobody earns"}`);
                if (sampler && flags().play) sampler.start();
                const sweep = () => play.sweep().catch((e) => log(`[play] retention: ${e.message}`));
                sweep(); setInterval(sweep, 3600_000).unref?.();
                // §6.0: a leave, kick or ban in the room or the space closes that person's view of its tables within 15 s
                setInterval(() => { play.revalidateAll().catch(() => {}); }, 15_000).unref?.();
                return true;
            } catch (e) {
                if (i === 0) log(`[play] database not ready (${e.code || e.message}); trying again every 30 s`);
                await new Promise((r) => setTimeout(r, 30_000).unref?.());
            }
        }
    })();
    return { attach: (server) => play.attach(server), ready, drain: (ms, why) => play.drain(ms, why), pool };
}

export const PLAY_ENV_KEYS = ["PLAY_ENABLED", "PLAY_RIG_PHONE_APPS", "PLAY_DAY_MAX", "PLAY_START", "PLAY_TZ",
    "PLAY_CHIP_MINUTES", "PLAY_TOPUP_TO", "PLAY_CAP_BASE", "PLAY_CAP_PER_RANK", "PLAY_SIDE_DAY_MAX", "PLAY_SIDE_ON", "PLAY_DB_HOST", "PLAY_DB_NAME", "PLAY_DB_USER", "PLAY_DB_PASSWORD_FILE", "PLAY_DB_URL"];

// vodslist.mjs — how /vods/sessions describes ONE recorded session (Memories). Pure over the session directory:
// session.json + tracks.jsonl + which files exist and how big they are. Moved out of server.mjs (recorder fix,
// 2026-11-04) so the rule can be tested.
//
// Frameless captures: a capture smaller than FRAMELESS_MAX_BYTES never received a frame (the recorder opened the
// Matroska file — a 173-byte header — and nothing followed: no media key reached it, the track ended at once, …).
// Same threshold as the recorder (desktop vodsvc.rs FRAMELESS_MAX_BYTES). Such a track is NOT handed to players
// (there is nothing to play) and never blocks `ready`: before this a session with one frameless camera stayed
// "Processing" in every app forever, because a frameless video can never get its combined file. The files are
// listed by name in `frameless` so nothing disappears silently. A session whose every capture is frameless is
// `empty` (nothing was captured), like a session without tracks.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { parseIdentity } from "./identity.mjs";

export const FRAMELESS_MAX_BYTES = 1024;

function sizeOf(path) {
    try { return statSync(path).size; } catch { return -1; }
}

/** One session's listing entry, or null when it has no readable session.json (not a session).
 *  `urlFor(file)` = the signed URL of a file inside the session directory. */
export function describeSession(sd, id, urlFor) {
    let session;
    try { session = JSON.parse(readFileSync(`${sd}/session.json`, "utf8")); } catch { return null; }
    const tracks = [];
    const frameless = [];
    try {
        for (const line of readFileSync(`${sd}/tracks.jsonl`, "utf8").trim().split("\n")) {
            if (!line) continue;
            let t;
            try { t = JSON.parse(line); } catch { continue; }
            if (!t || typeof t.file !== "string" || !t.file) continue;
            if (sizeOf(`${sd}/${t.file}`) < FRAMELESS_MAX_BYTES) { frameless.push(t.file); continue; }
            t.url = urlFor(t.file);
            // combined POV file (video + aligned mixed audio) — the player's preferred single-file lipsync source (0.8.10)
            if (t.kind !== "audio" && existsSync(`${sd}/combined-${t.file}`)) t.combined_url = urlFor(`combined-${t.file}`);
            tracks.push(t);
        }
    } catch { /* no tracks yet */ }
    const mixed = existsSync(`${sd}/mixed.mka`) ? urlFor("mixed.mka") : "";
    // Player gating: live = the call is still being recorded; ready = post-close processing done (the mix, when
    // there is audio to mix, and every playable video track's combined file). A session can be neither (processing
    // window ~minutes after close, or a crashed recorder) — the player shows those as "Processing…" until this flips.
    const live = session.end_ms == null;
    const hasAudio = tracks.some((t) => t.kind === "audio");
    // No playable audio = nothing to mix and nothing to combine (the recorder builds combined files from the mix):
    // the videos play as they are (the players take a track without combined_url).
    const ready = !live && (hasAudio ? mixed !== "" && tracks.filter((t) => t.kind !== "audio").every((t) => !!t.combined_url) : true);
    // 0.8.15 polish: card metadata. bytes = on-disk size of the whole session; people = unique Matrix users behind
    // the tracks (identity is "@user:server:DEVICE"), first-seen order; empty = nothing playable was captured.
    let bytes = 0;
    try { for (const f of readdirSync(sd)) { const n = sizeOf(`${sd}/${f}`); if (n > 0) bytes += n; } } catch { /* unreadable */ }
    const people = [];
    for (const t of tracks) {
        // the shared identity rule (identity.mjs: split at the LAST ':'), so a user on `host:port` keeps the port;
        // an identity this server wouldn't mint (another call server's) falls back to the last ':'
        const tid = String(t.identity || "");
        const mx = parseIdentity(tid)?.mxid ?? (tid.lastIndexOf(":") > tid.indexOf(":") ? tid.slice(0, tid.lastIndexOf(":")) : "");
        if (mx.startsWith("@") && !people.includes(mx)) people.push(mx);
    }
    return { id, ...session, tracks, mixed_url: mixed, live, ready, bytes, people, empty: tracks.length === 0, frameless };
}

/** Every session of one room directory, newest first. A repaired copy (a sibling session whose session.json carries
 *  `repair_of: "<original id>"`, written beside the original by an add-only repair — the original is never touched)
 *  REPLACES its original in the list, so the apps show one memory, the playable one. Only a readable session can
 *  hide another, only a finished one (ready and not empty), only inside the same room directory, and only an original
 *  (no repair_of of its own) is ever hidden. `urlForSession(id)` returns that session's urlFor. */
export function listRoom(dir, urlForSession, room = undefined) {
    const all = [];
    let names = [];
    try { names = readdirSync(dir); } catch { return all; } // room has no recordings yet
    for (const s of names) {
        const entry = describeSession(`${dir}/${s}`, s, urlForSession(s));
        // (round 3 security review, RECORDER-10) a directory name stands for more than one room id (characters outside
        // [A-Za-z0-9._@-] all become "_"): only the sessions the recorder wrote for THIS room are listed
        if (entry && (room === undefined || entry.room === room)) all.push(entry);
    }
    const byId = new Map(all.map((e) => [e.id, e]));
    const replaced = new Set();
    for (const r of all) {
        const o = typeof r.repair_of === "string" ? byId.get(r.repair_of) : undefined;
        // only an ORIGINAL (a session that is not itself a repaired copy) can be hidden: never itself, and no chain or
        // cycle of repair_of can make a group of sessions disappear
        // 0.3.13 review: and only a FINISHED copy (ready, something playable): a repair that stopped half-way (session.json
        // written, media or the mix missing) never hides a usable original
        // + the repair tool's own completion stamp (rec-repair.py writes session.json LAST, with repaired_ms, after every
        // hardlink and tracks.jsonl; a failed run removes the folder)
        if (o && o.id !== r.id && o.repair_of === undefined && r.ready && !r.empty && typeof r.repaired_ms === "number") replaced.add(o.id);
    }
    const out = all.filter((e) => !replaced.has(e.id));
    out.sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
    return out;
}

// ── who sees which memories (round 3 security review, RECORDER-5) ──────────────────────────────────────────────────
// A recording is room history: a member sees the sessions the room's history visibility lets them see. "shared" and
// "world_readable" rooms: every session (as with messages). "joined" / "invited" (and anything unknown): only sessions
// that were still running at or after the start of the member's current, continuous membership (membershipStart: a
// name or avatar change is not a new join; a rejoin starts again, which is stricter than Matrix's per-period rule:
// never wider). "invited" history starts at the invite that led to it. Guest accounts always get the join rule.

/** The earliest session end a caller may see (0 = all of them), or null = nothing (not joined). */
export function historySince({ membership, joinedAt, historyVisibility, user, now = Date.now() }) {
    if (membership !== "join") return null;
    const guest = /^@guest-/.test(String(user || ""));
    if (!guest && (historyVisibility === "shared" || historyVisibility === "world_readable")) return 0;
    return Number.isFinite(joinedAt) && joinedAt > 0 ? joinedAt : now;  // unknown join time: only what is live from now
}

/** Is this listed session inside what the caller may see (historySince)? A live session (no end) always is. */
export function visibleSince(entry, since, now = Date.now()) {
    if (!since) return true;
    const end = typeof entry?.end_ms === "number" ? entry.end_ms : (entry?.live ? now : NaN);
    return Number.isFinite(end) && end >= since;
}

/** historySince from a room's full state as Synapse's admin API lists it (events with their envelopes). `joinedAt`:
 *  the start of the membership (membershipStart); without it, the time of the current member event. */
export function sinceFromState(state, user, now = Date.now(), joinedAt = undefined) {
    const ev = state.find((e) => e?.type === "m.room.member" && e?.state_key === user);
    const hv = state.find((e) => e?.type === "m.room.history_visibility" && e?.state_key === "");
    return historySince({ membership: ev?.content?.membership, joinedAt: joinedAt ?? Number(ev?.origin_server_ts), user, now,
        historyVisibility: hv ? hv.content?.history_visibility : "shared" /* the spec's default */ });
}

export const MEMBERSHIP_WALK = Object.freeze({ MAX_STEPS: 50, DEADLINE_MS: 8000 });

/** When the caller's current, continuous membership began (ms): back along the member event's `replaces_state` chain,
 *  through every earlier "join" (a name or avatar change writes a new join event, it isn't a new join), to the first
 *  join of this membership or, for "invited" history, to the invite that led to it. Guests always get the join.
 *  Fails closed: an unreadable or foreign event, a chain over the bound or past the deadline answers the time of the
 *  CURRENT member event, the narrowest view. `fetchEvent(id)` -> the event as Synapse stores it, or null. */
export async function membershipStart(state, user, fetchEvent, { maxSteps = MEMBERSHIP_WALK.MAX_STEPS, deadlineMs = MEMBERSHIP_WALK.DEADLINE_MS, clock = Date.now } = {}) {
    const cur = state.find((e) => e?.type === "m.room.member" && e?.state_key === user);
    const curTs = Number(cur?.origin_server_ts);
    if (cur?.content?.membership !== "join") return curTs;
    const hvEv = state.find((e) => e?.type === "m.room.history_visibility" && e?.state_key === "");
    const hv = hvEv ? hvEv.content?.history_visibility : "shared";
    const guest = /^@guest-/.test(String(user || ""));
    if (!guest && (hv === "shared" || hv === "world_readable")) return curTs;  // everything is shown: nothing to walk
    const started = clock();
    let ev = cur;
    for (let i = 0; i < maxSteps; i++) {
        if (clock() - started > deadlineMs) return curTs;
        const prevId = ev?.unsigned?.replaces_state;
        if (typeof prevId !== "string" || !prevId) return Number.isFinite(Number(ev.origin_server_ts)) ? Number(ev.origin_server_ts) : curTs;
        let prev;
        try { prev = await fetchEvent(prevId); } catch { return curTs; }
        if (clock() - started > deadlineMs) return curTs;   // a slow read counts: the answer it brought is not used
        if (!prev || prev.type !== "m.room.member" || prev.state_key !== user || prev.room_id !== cur.room_id
            || typeof prev.content?.membership !== "string") return curTs;
        const m = prev.content.membership;
        if (m === "join") { ev = prev; continue; }
        if (m === "invite" && hv === "invited" && !guest) {
            const ts = Number(prev.origin_server_ts);
            return Number.isFinite(ts) && ts > 0 ? ts : curTs;
        }
        return Number.isFinite(Number(ev.origin_server_ts)) ? Number(ev.origin_server_ts) : curTs;
    }
    return curTs;
}

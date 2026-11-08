// reports.mjs — the shape of an abuse report ("Report…" on a person or a message in the apps, docs/ACCOUNT-SAFETY.md).
// A problem report is stored as the app sent it; an abuse report is checked and cut down to the fields below, so the
// dashboard can show it (apiconf.reports) and one is always tiny: it never counts toward the inbox's size cap, and
// has its own daily quota, so a bug-report day doesn't stop anybody from reporting a person. Stored as
// `<stamp>-abuse.json`, which the cap's count leaves out.

export const ABUSE_CATEGORIES = ["spam", "harassment", "sexual", "violence", "other"];
export const ABUSE_PER_DAY = 50;
export const ABUSE_MAX_BYTES = 16 * 1024;  // what an abuse report's body may be (an app's is well under 2 KB)
export const ABUSE_SUFFIX = "-abuse.json";
// All abuse reports together at most this much (outside the inbox's 200 MB cap, so they need their own bound; ~1,300
// reports at the 16 KB maximum, many more at an app's real size). Full → 507 until the owner clears some (dashboard).
export const ABUSE_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
// Matrix identifiers (spec appendix "Identifier grammar"): a server name is a host name, IPv4 or a bracketed IPv6
// address with an optional port; room ids since room version 12 have no server part; each id is at most 255 bytes.
const SERVER = String.raw`(?:[A-Za-z0-9.-]{1,255}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?`;
const MXID = new RegExp(String.raw`^@[^:\s\x00-\x1f\x7f]{1,255}:${SERVER}$`);
const ROOM_ID = new RegExp(String.raw`^![^:\s\x00-\x1f\x7f]{1,255}(?::${SERVER})?$`);
const EVENT_ID = /^\$[^\s\x00-\x1f\x7f]{1,255}$/;
/** A well-formed id (no lone surrogates: the dashboard builds links from it) of at most 255 bytes. */
const id = (re, v) => typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) <= 255 && re.test(v);

/** True when the app sent an abuse report (both keys say so; older apps send neither). */
export const isAbuse = (body) => !!body && typeof body === "object" && (body.kind === "abuse" || body.type === "abuse");

/** Plain text of at most n characters (code points, so an emoji is never cut in half), control characters out. */
function text(v, n) {
    if (typeof v !== "string") return "";
    return Array.from(v.toWellFormed().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")).slice(0, n).join("");
}

/** The stored report, or { error } (the app shows it). `reporter` is the signed-in sender, never the body's claim. */
export function abuseReport(body, reporter) {
    const reported = typeof body.reported_user === "string" ? body.reported_user : "";
    const room = typeof body.room_id === "string" ? body.room_id : "";
    const event = typeof body.event_id === "string" ? body.event_id : "";
    if (reported && !id(MXID, reported)) return { error: "reported_user must be a Matrix id (@name:server)." };
    if (room && !id(ROOM_ID, room)) return { error: "room_id must be a room id (!id:server)." };
    if (event && !id(EVENT_ID, event)) return { error: "event_id must be an event id ($id)." };
    if (event && !room) return { error: "A reported message needs its room_id." };
    if (!reported && !event) return { error: "Say who or which message you are reporting." };
    const category = ABUSE_CATEGORIES.includes(body.category) ? body.category : "other";
    const out = {
        kind: "abuse", type: "abuse",
        title: text(body.title, 200) || `[report] ${category}: ${reported || event}`,
        category, details: text(body.details, 1000), reporter,
        platform: text(body.platform, 80), version: text(body.version, 40),
    };
    if (reported) out.reported_user = reported;
    if (room) out.room_id = room;
    if (event) out.event_id = event;
    return out;
}

// ── what a stored report may be (problem reports and abuse reports alike) ───────────────────────────────────────────
// A report is stored as compact JSON, built from the parsed body. Nesting is bounded before it is serialised (the
// serialiser recurses, the parser doesn't, so an accepted body could otherwise fail to be written), and the size cap
// counts what is written, not what arrived.
export const REPORT_MAX_DEPTH = 32;
export const REPORT_MAX_WRITE_BYTES = 1024 * 1024 + 4096;  // the 1 MB body + the envelope (time, sender)

/** True when no array or object in `value` sits deeper than `max` levels (checked without recursion). */
export function depthWithin(value, max = REPORT_MAX_DEPTH) {
    const stack = [[value, 1]];
    while (stack.length) {
        const [v, d] = stack.pop();
        if (v === null || typeof v !== "object") continue;
        if (d > max) return false;
        for (const k in v) if (Object.hasOwn(v, k)) stack.push([v[k], d + 1]);
    }
    return true;
}

/** The text stored for a report: {text} (compact JSON, at most REPORT_MAX_WRITE_BYTES) or {error, status}. */
export function reportText(envelope, maxBytes = REPORT_MAX_WRITE_BYTES) {
    let text;
    try { text = JSON.stringify(envelope); } catch { return { error: "report can't be stored", status: 400 }; }
    if (typeof text !== "string") return { error: "report can't be stored", status: 400 };
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) return { error: "report too big (1 MB)", status: 413 };
    return { text, bytes };
}

/** Keeps daily quotas (RateLimits on the wall clock) across restarts: {load(), save() -> written?} on one small JSON
 *  file (at most QUOTA_FILE_MAX_BYTES and QUOTA_FILE_MAX_KEYS people per limit are read back). */
export const QUOTA_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const QUOTA_FILE_MAX_KEYS = 100_000;
export function quotaFile(file, limits, fs, log = (s) => console.error(s)) {
    return {
        load() {
            let j;
            try {
                if (fs.statSync(file).size > QUOTA_FILE_MAX_BYTES) { log(`[reports] ALERT ${file} is too big to be a quota file: ignored`); return; }
                j = JSON.parse(fs.readFileSync(file, "utf8"));
            } catch (e) {
                if (e?.code !== "ENOENT") log(`[reports] ALERT the daily quotas couldn't be read back (${e?.message}): everybody starts a fresh day`);
                return;
            }
            if (!j || typeof j !== "object" || Array.isArray(j)) { log("[reports] ALERT the daily quotas file isn't an object: everybody starts a fresh day"); return; }
            for (const name of Object.keys(limits)) {
                const m = j[name];
                if (m !== undefined && (!m || typeof m !== "object" || Array.isArray(m))) log(`[reports] ALERT the daily quotas file's "${name}" isn't a map: that quota starts a fresh day`);
            }
            for (const [name, rl] of Object.entries(limits)) {
                const m = j[name];
                if (!m || typeof m !== "object" || Array.isArray(m)) continue;
                const t = rl.now();
                let keys = 0;
                for (const [key, arr] of Object.entries(m)) {
                    if (++keys > QUOTA_FILE_MAX_KEYS) break;
                    if (!Array.isArray(arr)) continue;
                    const keep = arr.slice(-rl.max).filter((x) => Number.isFinite(x) && x <= t && t - x < rl.windowMs);
                    if (keep.length) rl.m.set(key, keep);
                }
            }
        },
        save() {
            const out = {};
            for (const [name, rl] of Object.entries(limits)) {
                rl.sweep();
                if (rl.m.size > QUOTA_FILE_MAX_KEYS) { log("[reports] ALERT more people than the quota file reads back"); return false; }
                out[name] = Object.fromEntries(rl.m);
            }
            const text = JSON.stringify(out);
            // never written when it couldn't be read back as it is (load's bounds): the caller refuses instead
            if (Buffer.byteLength(text) > QUOTA_FILE_MAX_BYTES) { log("[reports] ALERT the daily quotas outgrew their file"); return false; }
            try {
                fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
                fs.renameSync(`${file}.tmp`, file);
                return true;
            } catch (e) { log(`[reports] couldn't keep the daily quotas: ${e.message}`); return false; }
        },
    };
}

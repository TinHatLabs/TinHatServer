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

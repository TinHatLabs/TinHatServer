// safety.ts — account safety: ignore a person, report a person or a message, delete my account (docs/ACCOUNT-SAFETY.md).
// SHARED LOGIC: the desktop's crates/app/src/safety.rs implements the same rules, line for line, and both replay
// testvectors/account-safety/vectors.json (byte copy in the desktop's src/testvectors/account-safety.json): the
// m.ignored_user_list edits, the abuse report's body for the server's /api/reports, the Matrix report requests (the
// fallback every Matrix server answers), who may not delete their account, the deactivate requests and every word the
// two apps show. Pure: no React, no app imports — the unit test runs it in plain Node.
//
// Ignore = standard Matrix (`m.ignored_user_list` account data, spec §10.2.13): the server stops sending their
// events and invites to every device of the account; the apps also hide what is already on screen.
// Report = to the people who run the server: the Tin Hat Server's /api/reports (`kind: "abuse"`, the owner's
// dashboard) when it offers reports, else — and when that fails — the Matrix report APIs (Synapse's event reports).
// Delete = POST /account/deactivate with `erase: true` (user-interactive auth with the account password, like Change
// password), then the app signs out locally and forgets the account. Never for the server's own system account or its
// owner (the well-known's `dev.tinhat.server.account.owner`, SERVER-SPEC.md).

export const IGNORED_TYPE = "m.ignored_user_list";
const MXID = /^@[^:\s]+:[^\s]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const isMxid = (s: unknown): s is string => typeof s === "string" && MXID.test(s);

// ---- the words (both apps, the same) -----------------------------------------------------------------------------

export const WORDS = {
  ignore: "Ignore…",
  unignore: "Stop ignoring",
  ignoreTitle: "Ignore {name}?",
  ignoreText: "You won't see their messages or invites anywhere. They aren't told. Settings → Privacy → Ignored people lists everyone you ignore.",
  ignoreConfirm: "Ignore",
  ignoredToast: "You're ignoring {name}.",
  unignoredToast: "You're no longer ignoring {name}. Their new messages show again.",
  ignoreSelf: "You can't ignore yourself.",
  ignoreFailed: "Couldn't change your ignored list. Try again in a moment.",
  ignoredSection: "Ignored people",
  ignoredSectionHint: "Their messages and invites are hidden on every device you use.",
  ignoredEmpty: "You aren't ignoring anyone.",
  report: "Report…",
  reportPersonTitle: "Report {name}",
  reportMessageTitle: "Report this message",
  reportIntro: "Reports go to the people who run {server}. The person you report isn't told who sent it.",
  reportWhat: "What's wrong?",
  reportDetails: "Anything else they should know (optional)",
  reportAlsoIgnore: "Also ignore them",
  reportSend: "Send report",
  reportSent: "Report sent. Thank you.",
  reportFailed: "Couldn't send the report. Try again in a moment.",
  deleteRow: "Delete my account",
  deleteRowHint: "Close this account for good",
  deleteTitle: "Delete your account?",
  deleteLines: [
    "This closes {mxid} for good.",
    "You're signed out on every device.",
    "You leave every room, and your name and photo are removed.",
    "Your messages are hidden from anyone who joins a room later; people who already saw them may keep their copies.",
    "Nobody can sign up with this name again.",
    "This can't be undone.",
  ],
  deletePassword: "Enter your account password to confirm.",
  deleteConfirm: "Delete my account",
  deleteDone: "Your account has been deleted.",
  deleteWrong: "That isn't your password.",
  deleteUnsupported: "This server wants another way to confirm it's you: delete your account where you signed up.",
  deleteFailedHttp: "The server didn't delete the account (HTTP {status}).",
  deleteSystem: "This is the server's own system account. It can't be deleted from the app.",
  deleteOwner: "You own this server, so this account can't be deleted from the app: the server needs it. Manage it from the server's dashboard.",
  deleteGuest: "Guest accounts are deleted by the server when the visit ends.",
  unreachable: "Couldn't reach your server. Try again in a moment.",
} as const;

/** A template's `{key}` filled in. */
export function fill(t: string, vars: Record<string, string | number>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// ---- ignore ---------------------------------------------------------------------------------------------------------

/** The people an `m.ignored_user_list` content ignores: valid Matrix ids only, sorted, each once. */
export function ignoredUsers(content: unknown): string[] {
  const m = isObj(content) ? content.ignored_users : undefined;
  if (!isObj(m)) return [];
  return Object.keys(m).filter(isMxid).sort();
}

/** The content after ignoring (`ignore` true) or no longer ignoring `mxid`. Every other entry and key stays as it was
 *  (another client's extra fields survive); a new entry is `{}`; an entry that isn't an object becomes `{}`. */
export function withIgnored(content: unknown, mxid: string, ignore: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(content) ? { ...content } : {};
  const m: Record<string, unknown> = isObj(out.ignored_users) ? { ...out.ignored_users } : {};
  if (ignore) m[mxid] = isObj(m[mxid]) ? m[mxid] : {};
  else delete m[mxid];
  out.ignored_users = m;
  return out;
}

/** Why `me` can't ignore `target` ("" = they can). */
export function ignoreRefusal(me: string, target: string): string {
  if (!isMxid(target)) return "That isn't an account.";
  if (target === me) return WORDS.ignoreSelf;
  return "";
}

// ---- report ---------------------------------------------------------------------------------------------------------

export const REPORT_CATEGORIES = [
  { id: "spam", label: "Spam or a scam" },
  { id: "harassment", label: "Harassment or hate" },
  { id: "sexual", label: "Sexual content" },
  { id: "violence", label: "Violence or threats" },
  { id: "other", label: "Something else" },
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]["id"];
/** The longest "anything else" text sent (UTF-16 units, as the web's `length`). */
export const DETAILS_MAX = 1000;

export interface ReportTarget {
  /** the reported person (always; for a message, its sender) */
  user: string;
  /** the room it happened in ("" = none known) */
  room: string;
  /** the reported message ("" = the person, not a message) */
  event: string;
}

const categoryLabel = (c: string) => REPORT_CATEGORIES.find((x) => x.id === c)?.label ?? REPORT_CATEGORIES[4].label;
const categoryId = (c: string): ReportCategory => (REPORT_CATEGORIES.find((x) => x.id === c)?.id ?? "other") as ReportCategory;

/** The details as sent: trimmed, at most DETAILS_MAX UTF-16 units without splitting a surrogate pair, trimmed again. */
export function cleanDetails(s: string): string {
  const t = s.trim();
  let end = Math.min(t.length, DETAILS_MAX);
  if (end < t.length && end > 0) {
    const c = t.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--; // a high surrogate whose pair would be cut off
  }
  return t.slice(0, end).trim();
}

/** "Send report" is enabled: a category is chosen ("other" needs words). */
export function reportReady(category: string, details: string): boolean {
  if (!REPORT_CATEGORIES.some((x) => x.id === category)) return false;
  return category !== "other" || cleanDetails(details).length > 0;
}

/** The body POSTed to the Tin Hat Server's /api/reports (the owner's dashboard); empty room/event left out (key order
 *  is not part of the contract: the desktop's serde_json sorts them). `platform` = the app's own line ("web (Chrome on Linux)", "desktop (Linux)"), `version` its version. */
export function abuseReport(o: { reporter: string; target: ReportTarget; category: string; details: string; platform: string; version: string }): Record<string, unknown> {
  const category = categoryId(o.category);
  const details = cleanDetails(o.details);
  const r: Record<string, unknown> = {
    kind: "abuse",
    type: "abuse",
    title: `[report] ${categoryLabel(category)}: ${o.target.user}`,
    category,
    details,
    reported_user: o.target.user,
  };
  if (o.target.room) r.room_id = o.target.room;
  if (o.target.event) r.event_id = o.target.event;
  r.reporter = o.reporter;
  r.platform = o.platform;
  r.version = o.version;
  return r;
}

/** The `reason` of a Matrix report: the category's words, then the details. */
export function matrixReason(category: string, details: string): string {
  const d = cleanDetails(details);
  const l = categoryLabel(categoryId(category));
  return d ? `${l}: ${d}` : l;
}

/** The room-report fallback's reason: the room report itself names no one, so the moderator reads who here
 *  (desktop: safety.rs room_report_reason). */
export function roomReportReason(reason: string, user: string): string {
  return `${reason} (reported: ${user})`;
}

/** encodeURIComponent (the desktop's encode_component is the same rule): a Matrix id in a path. */
export const enc = (s: string) => encodeURIComponent(s);

export interface ReportRequest {
  via: "tinhat" | "matrix";
  method: "POST";
  /** tinhat: under the server's API base; matrix: under /_matrix/client/v3 */
  path: string;
  body: Record<string, unknown>;
}

/** The requests that send a report, in order: the first one that succeeds ends it. The Tin Hat Server's inbox first
 *  when it takes reports from this account (`tinhat`); then Matrix: a message → POST /rooms/{room}/report/{event}; a
 *  person → POST /users/{user}/report (Matrix 1.14), then POST /rooms/{room}/report (Matrix 1.13) when a room is known
 *  (older servers answer the first 404 / M_UNRECOGNIZED). */
export function reportPlan(o: { tinhat: boolean; report: Record<string, unknown>; target: ReportTarget; category: string; details: string }): ReportRequest[] {
  const out: ReportRequest[] = [];
  if (o.tinhat) out.push({ via: "tinhat", method: "POST", path: "/reports", body: o.report });
  const reason = matrixReason(o.category, o.details);
  const { user, room, event } = o.target;
  if (event && room) out.push({ via: "matrix", method: "POST", path: `/rooms/${enc(room)}/report/${enc(event)}`, body: { reason } });
  else {
    out.push({ via: "matrix", method: "POST", path: `/users/${enc(user)}/report`, body: { reason } });
    // a room report doesn't name anyone: the reason carries who (12.0.4, assembly-035 review W4)
    if (room) out.push({ via: "matrix", method: "POST", path: `/rooms/${enc(room)}/report`, body: { reason: roomReportReason(reason, user) } });
  }
  return out;
}

// ---- delete my account ------------------------------------------------------------------------------------------------

export const SYSTEM_LOCALPART = "tinhat-system";
const localpart = (mxid: string) => mxid.replace(/^@/, "").split(":")[0];

/** Why this account can't be deleted from the app ("" = it can): the server's own system account, the server's owner
 *  (`owner` = the well-known's account.owner, "" when it doesn't say), a temporary guest. */
export function deleteRefusal(me: string, owner: string, guest: boolean): string {
  if (localpart(me) === SYSTEM_LOCALPART) return WORDS.deleteSystem;
  if (owner && me === owner) return WORDS.deleteOwner;
  if (guest) return WORDS.deleteGuest;
  return "";
}

/** The explainer, filled in. */
export function deleteLines(mxid: string): string[] {
  return WORDS.deleteLines.map((l) => fill(l, { mxid }));
}

/** The deactivate body: the first POST (`auth` null) and the second (user, password, the challenge's session). */
export function deactivateBody(auth: { user: string; password: string; session?: string } | null): Record<string, unknown> {
  const b: Record<string, unknown> = { erase: true };
  if (auth) {
    const a: Record<string, unknown> = { type: "m.login.password", identifier: { type: "m.id.user", user: auth.user }, password: auth.password };
    if (auth.session !== undefined) a.session = auth.session;
    b.auth = a;
  }
  return b;
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/** The server's `error`, or deleteFailedHttp. */
export function deleteFailureText(status: number, body: string): string {
  const v = parse(body);
  const e = isObj(v) && typeof v.error === "string" ? v.error.trim() : "";
  return e || fill(WORDS.deleteFailedHttp, { status });
}

export type DeleteFirst = { step: "done" } | { step: "password"; session?: string } | { step: "failed"; text: string };

/** The first answer (password.rs first_answer's rule): 2xx = deleted without a password; a 401 challenge with a
 *  password-only flow = send the password; another challenge = deleteUnsupported (the password is never sent); else
 *  the server's words. */
export function deleteFirstAnswer(status: number, body: string): DeleteFirst {
  if (status >= 200 && status < 300) return { step: "done" };
  const v = parse(body);
  if (status === 401 && isObj(v) && v.flows) {
    const flows = Array.isArray(v.flows) ? v.flows : [];
    const ok = flows.some((f) => isObj(f) && Array.isArray(f.stages) && f.stages.length === 1 && f.stages[0] === "m.login.password");
    if (!ok) return { step: "failed", text: WORDS.deleteUnsupported };
    return typeof v.session === "string" ? { step: "password", session: v.session } : { step: "password" };
  }
  return { step: "failed", text: deleteFailureText(status, body) };
}

export type DeleteOutcome = { kind: "deleted" } | { kind: "wrong"; text: string } | { kind: "failed"; text: string };

/** The second answer: 2xx = deleted; 401 + M_FORBIDDEN = not the password; anything else = the server's words. */
export function deleteSecondAnswer(status: number, body: string): DeleteOutcome {
  if (status >= 200 && status < 300) return { kind: "deleted" };
  const v = parse(body);
  if (status === 401 && isObj(v) && v.errcode === "M_FORBIDDEN") return { kind: "wrong", text: WORDS.deleteWrong };
  return { kind: "failed", text: deleteFailureText(status, body) };
}

/** The two steps over any transport (`post(body)` → {status, body}, null = no answer). The password goes out only in
 *  the second body, and only for a password-only flow. */
export async function deleteWith(post: (body: Record<string, unknown>) => Promise<{ status: number; body: string } | null>, user: string, password: string): Promise<DeleteOutcome> {
  const a = await post(deactivateBody(null));
  if (!a) return { kind: "failed", text: WORDS.unreachable };
  const f = deleteFirstAnswer(a.status, a.body);
  if (f.step === "done") return { kind: "deleted" };
  if (f.step === "failed") return { kind: "failed", text: f.text };
  const b = await post(deactivateBody({ user, password, ...(f.session !== undefined ? { session: f.session } : {}) }));
  if (!b) return { kind: "failed", text: WORDS.unreachable };
  return deleteSecondAnswer(b.status, b.body);
}

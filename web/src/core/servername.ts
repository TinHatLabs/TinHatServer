// servername.ts — what a typed Server field means (server_name.rs on the desktop). A bare name — ASCII letters, digits
// and inner hyphens; no dot, no colon, no scheme — is a tinhat.me name: "crew" → crew.tinhat.me, as the phone apps'
// resolver does. Anything else is left as typed (trimmed). Shared table: servername.cases.json, byte-identical with
// the desktop's (sha256 pinned in both tests); its `origin` column is the phone apps' rule.

export const NAME_ZONE = "tinhat.me";

const BARE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

// Unicode White_Space exactly (Rust's str::trim): JS's own trim also strips U+FEFF and keeps U+0085.
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

/** The typed text with a bare name made a tinhat.me name ("crew/#/x" → "crew.tinhat.me/#/x"); else trimmed. */
export function expandServerName(typed: string): string {
  const s = typed.replace(TRIM, "");
  if (s.includes("://")) return s;
  const m = /[/#?]/.exec(s);
  const end = m ? m.index : s.length;
  const host = s.slice(0, end);
  return BARE.test(host) ? `${host.toLowerCase()}.${NAME_ZONE}${s.slice(end)}` : s;
}

/** The host the sign-in screen asks for its moved and password-reset checks (lower case, no scheme, no trailing
 *  slash); null = nothing usable typed. */
export function serverHost(typed: string): string | null {
  // checked BEFORE lower-casing: JS lower-cases Unicode (U+212A KELVIN SIGN → "k"); the desktop's is ASCII-only
  const h = expandServerName(typed).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9[][A-Za-z0-9.:[\]-]*$/.test(h) && !h.endsWith("-") ? h.toLowerCase() : null;
}

/** The quiet line under the Server field while a bare name is typed ("Opens crew.tinhat.me"); "" otherwise. */
export function serverNameHint(typed: string): string {
  const t = typed.replace(TRIM, "");
  if (expandServerName(t) === t) return "";
  const h = serverHost(t);
  return h ? `Opens ${h}` : "";
}

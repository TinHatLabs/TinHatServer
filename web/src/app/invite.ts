// invite.ts — the invite link (selfhost/firstrun item 4). A Tin Hat Server invite is https://<server>/#/register?token=CODE
// (router.ts parses `token`, or `invite`). It fills the sign-up form's invite code on a fresh load AND when Tin Hat is
// already open in that tab — then only the hash changes and the page stays (LoginView follows the route). Signed in, the
// link can't be used in that tab: the shell says so (Shell.tsx). Pure — the unit test runs it in plain Node.
import { parseHash } from "./router"; // (relative: the unit tests load this file in Node)

/** The register route's code as the invite field holds it: trimmed, without the "TH-" the field draws itself. */
export function inviteFieldValue(token: string | null | undefined): string {
  return (token ?? "").trim().replace(/^th-/i, "");
}

/** The words when an invite link is opened in a tab that is signed in already. */
export const INVITE_WHILE_SIGNED_IN = "You're signed in already. To create a new account with this invite, sign out first, then open the link again.";

/** What pasting `text` into the Invite code field means (A14.2; the desktop's InviteLink.qml codeFromPaste, the same
 *  cases in invite.test.ts and tools/invite-link-test.mjs): a whole invite link (https://<server>/#/register?token=CODE,
 *  or just its "#/register?…" part) → the code for the field; null when it isn't one. */
export function codeFromPaste(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim();
  let hash: string;
  if (/^https?:\/\/\S+$/i.test(t)) {
    const i = t.indexOf("#");
    if (i < 0) return null;
    hash = t.slice(i);
  } else if (t.charAt(0) === "#") {
    hash = t;
  } else {
    return null;
  }
  const r = parseHash(hash);
  return r.name === "register" ? inviteFieldValue(r.token) : null;
}

/** A14.3: the server a pasted invite link names — its host ("maplehouse.tinhat.me", "chat.example.com:8443"),
 *  lower-cased; null when `text` isn't a whole https?:// invite link (the desktop's InviteLink.qml hostFromPaste). */
export function hostFromPaste(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim();
  if (codeFromPaste(t) === null) return null;
  const m = /^https?:\/\/([^/?#@]+)(?=[/?#]|$)/i.exec(t);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return /^[a-z0-9[][a-z0-9.:[\]-]*$/.test(h) ? h : null;
}

/** What a paste into the Server or Invite code field means, in one piece (A14.3; the desktop's InviteLink.qml
 *  inviteFromPaste): {code, host} for a whole invite link, {code, host: null} for just its "#/register?…" part, null
 *  otherwise — also for an https?:// link whose host can't be used (a user@ part, a non-ASCII name): its code must
 *  never go to whatever server the field held before. */
export function inviteFromPaste(text: string | null | undefined): { code: string; host: string | null } | null {
  const code = codeFromPaste(text);
  if (code === null) return null;
  if (!/^https?:\/\//i.test(String(text ?? "").trim())) return { code, host: null };
  const host = hostFromPaste(text);
  return host === null ? null : { code, host };
}

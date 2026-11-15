// invitesModel.ts — the pure invite-code helpers of Main.qml (inviteSummary / inviteBlip /
// inviteMessage) and the list item shape of the server's invites API. NO imports: unit-tested under Node
// (invites.test.ts).

export interface Invite {
  code: string;
  usesAllowed: number | null;
  pending: number;
  completed: number;
  expiresAt: number | null;
  active: boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Qt.formatDate(d, "MMM d") / "MMMM d" in the C locale (English month names). */
export function formatMonthDay(ms: number, long = false): string {
  const d = new Date(ms);
  const m = MONTHS[d.getMonth()];
  return `${long ? m : m.slice(0, 3)} ${d.getDate()}`;
}

/** "1 of 5 used · 2 signing up · expires Sep 30 · no longer works" */
export function inviteSummary(inv: Invite, now = Date.now()): string {
  const parts: string[] = [];
  if (inv.usesAllowed === null || inv.usesAllowed === undefined) parts.push("unlimited uses");
  else parts.push(`${inv.completed || 0} of ${inv.usesAllowed} used`);
  if ((inv.pending || 0) > 0) parts.push(`${inv.pending} signing up`);
  if (inv.expiresAt === null || inv.expiresAt === undefined) parts.push("never expires");
  else parts.push(`${inv.expiresAt < now ? "expired " : "expires "}${formatMonthDay(inv.expiresAt)}`);
  if (!inv.active) parts.push("no longer works");
  return parts.join(" · ");
}

/** The part people type: codes are TH-XXXX-XXXX and the sign-in field shows the TH- itself. */
export function inviteBlip(code: string): string {
  const c = String(code || "");
  return /^TH-/i.test(c) ? c.substring(3) : c;
}

/** The one-tap invite link a code is handed out as (A14.0; the desktop's InviteLink.qml registerLink):
 *  `<web app>/#/register?token=CODE` — the web app opens its create-account form with the code filled in. */
export function registerLink(webUrl: string, code: string): string {
  let base = String(webUrl ?? "");
  if (base.length > 0 && !base.endsWith("/")) base += "/";
  return `${base}#/register?token=${encodeURIComponent(String(code ?? "").trim())}`;
}

/**
 * The ready-to-paste invite message (A14.0; the desktop's InviteLink.qml inviteMessageText, the same text —
 * testvectors/invite-message/vectors.json). It leads with the one-tap link; the manual steps stay under it.
 * `until` = the expiry day already formatted ("December 1"), "" when the code never expires.
 */
export function inviteMessageText(server: string, webUrl: string, code: string, until: string, installUrl = ""): string {
  const u = until ? ` It's good until ${until}.` : "";
  const steps = installUrl
    ? `1. Install Tin Hat: ${installUrl}\n` + '2. Open it and pick "Create an account" under the sign-in button.\n'
    : `1. Open ${webUrl} in your browser (or install the Tin Hat app).\n` + '2. Pick "Create an account" under the sign-in button.\n';
  return `You're invited to ${server} on Tin Hat.\n` + `Join here: ${registerLink(webUrl, code)}\n` + "Or set it up by hand:\n"
    + steps + `3. Server: ${server} — invite code: ${inviteBlip(code)}.${u}` + (installUrl ? `\nOr open it in your browser: ${webUrl}` : "");
}

/**
 * The ready-to-paste instructions (native text + the web line, DECISIONS D10). Pure — the caller names the places:
 * `server` = the server people sign in to (the invite's, else core/bearer SERVER_LABEL), `webUrl` = where Tin Hat Web
 * lives (core/api webAppUrl()), `installUrl` = where the desktop app is downloaded (the hub's site; "" on a Tin Hat
 * Server, whose invite leads with the web address — docs/SELFHOST.md). The desktop's InviteLink.qml mirrors both shapes.
 */
export function inviteMessage(inv: Invite, server: string, webUrl: string, installUrl = ""): string {
  const until = inv.expiresAt === null || inv.expiresAt === undefined ? "" : formatMonthDay(inv.expiresAt, true);
  return inviteMessageText(server, webUrl, inv.code, until, installUrl);
}


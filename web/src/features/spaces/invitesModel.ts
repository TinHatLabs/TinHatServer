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

/**
 * The ready-to-paste instructions (native text + the web line, DECISIONS D10). Pure — the caller names the places:
 * `server` = the server people sign in to (the invite's, else core/bearer SERVER_LABEL), `webUrl` = where Tin Hat Web
 * lives (core/api webAppUrl()), `installUrl` = where the desktop app is downloaded (the hub's site; "" on a Tin Hat
 * Server, whose invite leads with the web address — docs/SELFHOST.md). The desktop's invites.rs mirrors both shapes.
 */
export function inviteMessage(inv: Invite, server: string, webUrl: string, installUrl = ""): string {
  const until = inv.expiresAt === null || inv.expiresAt === undefined ? "" : ` It's good until ${formatMonthDay(inv.expiresAt, true)}.`;
  const steps = installUrl
    ? `1. Install Tin Hat: ${installUrl}\n` + '2. Open it and pick "Create an account" under the sign-in button.\n'
    : `1. Open ${webUrl} in your browser (or install the Tin Hat app).\n` + '2. Pick "Create an account" under the sign-in button.\n';
  return `You're invited to ${server} on Tin Hat.\n` + steps + `3. Server: ${server} — invite code: ${inviteBlip(inv.code)}.${until}` + (installUrl ? `\nOr open it in your browser: ${webUrl}` : "");
}


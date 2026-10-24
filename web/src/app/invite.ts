// invite.ts — the invite link (selfhost/firstrun item 4). A Tin Hat Server invite is https://<server>/#/register?token=CODE
// (router.ts parses `token`, or `invite`). It fills the sign-up form's invite code on a fresh load AND when Tin Hat is
// already open in that tab — then only the hash changes and the page stays (LoginView follows the route). Signed in, the
// link can't be used in that tab: the shell says so (Shell.tsx). Pure — the unit test runs it in plain Node.

/** The register route's code as the invite field holds it: trimmed, without the "TH-" the field draws itself. */
export function inviteFieldValue(token: string | null | undefined): string {
  return (token ?? "").trim().replace(/^th-/i, "");
}

/** The words when an invite link is opened in a tab that is signed in already. */
export const INVITE_WHILE_SIGNED_IN = "You're signed in already. To create a new account with this invite, sign out first, then open the link again.";

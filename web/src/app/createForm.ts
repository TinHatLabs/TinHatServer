// createForm.ts — what the web's create-account form keeps after a try (A14.1; the desktop's LoginView.qml rule:
// the two password fields are cleared only once the account exists — registerStage "created" — or when the person
// leaves the form). A refused invite code, a taken username or a network error keeps them, so fixing the one wrong
// field doesn't mean typing both passwords again. Pure — src/app/createForm.test.ts runs it in plain Node.

export type CreateOutcome = "created" | "failed";

/** True when the password fields are cleared after a create-account try ended this way. */
export function clearPasswordsAfter(outcome: CreateOutcome): boolean {
  return outcome === "created";
}

const HINT_DEFAULT = "Usernames are lowercase letters, numbers, dots, dashes and underscores. Passwords are at least 8 characters.";

/** D01.7: the line under the create form's passwords says which field is wrong while it is typed (the desktop's
 *  LoginView.qml signupHint; testvectors/signup-hint/vectors.json is byte-identical on both sides). The username rule
 *  is the one the form checks on Create (validateRegistration); a short password is a hint, a mismatch an error. */
export function signupHint(username: string, password: string, password2: string): { text: string; error: boolean } {
  const u = username.trim().toLowerCase();
  if (u.length > 0 && (u.length > 64 || !/^[a-z0-9._=\-/+]+$/.test(u))) {
    return { text: "That username won't work: use lowercase letters, numbers, dots, dashes and underscores — no spaces.", error: true };
  }
  const n = Array.from(password).length;
  if (n > 0 && n < 8) return { text: "The password needs at least 8 characters.", error: false };
  if (password2.length > 0 && password2 !== password) return { text: "The passwords don't match.", error: true };
  return { text: HINT_DEFAULT, error: false };
}

// dmTarget.ts — the New DM field's rule (2026-09-29: "the ability for them to just type usernames instead of full
// @user:example.com"). Shared logic: the desktop's crates/app/src/dm_target.rs applies the same rule, and both replay the
// contract vectors testvectors/dm-target/vectors.json (reference: contract tools/dm-target-vectors.py).
//
//   dmTarget("alex", "example.com")            → "@alex:example.com"
//   dmTarget("@Someone:Matrix.ORG", "…")       → "@someone:matrix.org"
//   dmTarget("https://matrix.to/#/@x:y.com")   → "@x:y.com"
//   dmTarget("two words", "…")                 → null (not a user)

const LOCAL = /^[a-z0-9._=\-/+]+$/;
const SERVER = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;

/** The Matrix user ID a New DM field means, or null. `ownServer` = the signed-in account's server name. */
export function dmTarget(input: string, ownServer: string): string | null {
  let s = input.trim();
  const link = /^https?:\/\/matrix\.to\/#\/([^?]*)/i.exec(s);
  if (link) s = link[1].trim();
  if (!s || /\s/.test(s)) return null;
  if (s.startsWith("@")) s = s.slice(1);
  s = s.toLowerCase();
  const colon = s.indexOf(":");
  const local = colon >= 0 ? s.slice(0, colon) : s;
  const server = colon >= 0 ? s.slice(colon + 1) : ownServer.trim().toLowerCase();
  if (!LOCAL.test(local) || !SERVER.test(server)) return null;
  const host = server.split(":")[0];
  if (!host.includes(".") && host !== "localhost") return null;
  return `@${local}:${server}`;
}

/** The server part of a user ID ("@me:example.com" → "example.com"; "" when there is none). */
export function serverOf(userId: string | null | undefined): string {
  const i = (userId ?? "").indexOf(":");
  return i >= 0 ? (userId as string).slice(i + 1) : "";
}

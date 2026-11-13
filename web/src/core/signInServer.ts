// signInServer.ts — the server a sign-in goes to (QA 12.1.11 D6/W9; the desktop's bridge.rs sign_in_server is the same
// rule): the Server field; else the server part of a full `@name:server` user ID (the card says so and fills the
// field); else "Type your server's address first". Pure (the node unit test loads it).
export const SERVER_FIELD_HINT = "Type your server's address first (like yourname.tinhat.me).";

export type SignInServer = { server: string; fromUserId: boolean } | { error: string };

export function signInServer(field: string, username: string): SignInServer {
  const f = field.trim();
  if (f) return { server: f, fromUserId: false };
  const m = /^@([^:]+):([A-Za-z0-9.\-:[\]]+)$/.exec(username.trim());
  if (m) return { server: m[2].toLowerCase(), fromUserId: true };
  return { error: SERVER_FIELD_HINT };
}

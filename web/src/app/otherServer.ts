// otherServer.ts — A14.5: Tin Hat Web signs in to ONE server, the page's own (core/bearer.ts), so a different server
// typed in the Server field (or named by an @name:server user ID) must not quietly sign in or register HERE with that
// server's password. The sign-in card says where that server's own web app is and offers to go there
// (docs/WEB-EXCEPTIONS.md, "Sign-in on another server"). Pure — otherServer.test.ts runs it in plain Node.
import { NAME_ZONE, serverHost } from "../core/servername"; // (relative: the unit test loads this file in Node)

const bare = (h: string) => h.toLowerCase().replace(/:443$/, "");

/** The typed server's host when it is NOT this page's server, else null (empty / unparsable / ours). The page's own
 *  host counts as ours, and so does its DIRECT parent domain when that is a real server name: a server named
 *  example.org may serve its web app on chat.example.org. Never a shared zone: on crew.tinhat.me, "tinhat.me" (or
 *  another name under it) is another server, so its password is never sent here. */
export function otherServerHost(typed: string, pageHost: string): string | null {
  const h = serverHost(typed);
  if (!h || !pageHost) return null;
  const t = bare(h);
  const p = bare(pageHost);
  if (t === p) return null;
  const dot = p.indexOf(".");
  const parent = dot > 0 ? p.slice(dot + 1) : "";
  if (t === parent && t.includes(".") && t !== NAME_ZONE) return null;
  return h;
}

/** The sign-in card's line for another server's host. */
export function otherServerText(host: string): string {
  return `${host} has its own Tin Hat web app — continue there.`;
}

/** Where "Go to <host>" leads: its web app, on the create-account form (with the typed invite code) from that face. */
export function otherServerUrl(host: string, face: "signin" | "create" | "reset", code = ""): string {
  const c = code.trim().replace(/^th-/i, "");
  if (face === "create") return `https://${host}/#/register${c ? `?token=${encodeURIComponent(`TH-${c}`)}` : ""}`;
  if (face === "reset") return `https://${host}/#/forgot`;
  return `https://${host}/`;
}

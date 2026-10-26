// router.ts — hash routing, compatible with the old element-web links that are already out there
// (<host>/#/room/!id:server, #/room/#alias:server, %-encoded forms, ?via=…,
// /$eventId permalinks, #/user/@x:server) — the same parsing the native parse_join_link does.
//
//   #/home                     the nav (no room)            #/login  #/register  #/forgot
//   #/room/<!id|#alias>[/$ev]  a room (optionally at an event)
//   #/user/<@mxid>             a profile                    #/__gallery[/section]  the UI gallery
// Navigations push history entries, so the phone back button / edge swipe walks back (mobile stack).
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "room"; target: string; eventId?: string; via: string[] }
  | { name: "user"; userId: string }
  | { name: "login" }
  | { name: "register"; token?: string }
  | { name: "forgot" }
  | { name: "gallery"; section?: string }
  | { name: "unknown"; path: string };

function decode(s: string): string {
  // native: %21 → !, %23 → #, %40 → @, %3A → :  (then anything else that is still encoded)
  let out = s.replace(/%21/g, "!").replace(/%23/g, "#").replace(/%40/g, "@").replace(/%3a/gi, ":").replace(/%24/g, "$");
  try {
    out = decodeURIComponent(out);
  } catch {
    /* keep */
  }
  return out;
}

/** A room id: "!opaque:server" (room versions 1–11) or, from room version 12 on, "!opaque" with no server part
 *  (Synapse makes v12 rooms by default since 1.163; federated rooms can be v12 whatever our own server makes). */
export function isRoomId(s: string): boolean {
  return /^![^\s/]+$/.test(s);
}

export function parseHash(hash: string): Route {
  let h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h || h === "/") return { name: "home" };
  if (!h.startsWith("/")) h = "/" + h;
  const q = h.indexOf("?");
  const path = q >= 0 ? h.slice(0, q) : h;
  const query = new URLSearchParams(q >= 0 ? h.slice(q + 1) : "");
  const [, head = "", ...restParts] = path.split("/");
  const rest = restParts.join("/");
  switch (head) {
    case "":
    case "home":
    case "welcome":
      return { name: "home" };
    case "login":
      return { name: "login" };
    case "register":
      return { name: "register", token: query.get("token") ?? query.get("invite") ?? undefined };
    case "forgot":
    case "forgot_password":
      return { name: "forgot" };
    case "__gallery":
      return { name: "gallery", section: rest || undefined };
    case "user": {
      const u = decode(rest.replace(/\/+$/, ""));
      return u.startsWith("@") ? { name: "user", userId: u } : { name: "unknown", path };
    }
    case "room": {
      // "#/room/#alias:server" arrives with the second "#" intact inside the hash
      const raw = decode(rest);
      const [target, ev] = raw.split(/\/(?=\$)/);
      const t = target.replace(/\/+$/, "").trim();
      if (isRoomId(t) || (t.startsWith("#") && t.includes(":"))) {
        return { name: "room", target: t, eventId: ev || undefined, via: query.getAll("via") };
      }
      if (t.startsWith("@") && t.includes(":")) return { name: "user", userId: t };
      return { name: "unknown", path };
    }
    default:
      return { name: "unknown", path };
  }
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case "home":
      return "#/home";
    case "room": {
      const via = r.via.length ? "?" + r.via.map((v) => `via=${encodeURIComponent(v)}`).join("&") : "";
      return `#/room/${r.target}${r.eventId ? "/" + r.eventId : ""}${via}`;
    }
    case "user":
      return `#/user/${r.userId}`;
    case "login":
      return "#/login";
    case "register":
      return r.token ? `#/register?token=${encodeURIComponent(r.token)}` : "#/register";
    case "forgot":
      return "#/forgot";
    case "gallery":
      return `#/__gallery${r.section ? "/" + r.section : ""}`;
    default:
      return "#" + r.path;
  }
}

let current: Route = typeof location !== "undefined" ? parseHash(location.hash) : { name: "home" };
let currentHash = typeof location !== "undefined" ? location.hash : "";
const listeners = new Set<() => void>();

function sync() {
  if (location.hash === currentHash) return;
  currentHash = location.hash;
  current = parseHash(location.hash);
  for (const l of listeners) l();
}
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", sync);
  window.addEventListener("popstate", sync);
}

export function getRoute(): Route {
  return current;
}

/** Re-read the route from the address bar — for code that rewrote it with history.replaceState / pushState (no
 *  hashchange / popstate fires for those). navigate() does it itself. */
export function refreshRoute(): void {
  sync();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

/** Go to a route (pushes history unless `replace`). */
export function navigate(to: Route | string, opts: { replace?: boolean } = {}): void {
  const hash = typeof to === "string" ? (to.startsWith("#") ? to : "#" + to) : routeToHash(to);
  // already in the address bar (e.g. written there by history.replaceState, which fires no event): make sure the route
  // follows it — the guest hand-off's room stayed unselected, "Pick a room to start", while the URL named it
  if (hash === location.hash) return sync();
  const depth = ((history.state as { thDepth?: number } | null)?.thDepth ?? 0) as number;
  if (opts.replace) history.replaceState({ thDepth: depth }, "", hash);
  else history.pushState({ thDepth: depth + 1 }, "", hash);
  sync();
}

/** Back one step if we came from inside the app, else to `fallback` (mobile back chevron). */
export function goBack(fallback: Route = { name: "home" }): void {
  const depth = ((history.state as { thDepth?: number } | null)?.thDepth ?? 0) as number;
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function roomHash(roomIdOrAlias: string, eventId?: string): string {
  return routeToHash({ name: "room", target: roomIdOrAlias, eventId, via: [] });
}

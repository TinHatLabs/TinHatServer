// space.ts — which space's chips a room plays with (GAMES-V1-SPEC rev 2 §1.1). The rule is the prestige feature's pure
// `gameSpace` (features/prestige/clientRules.ts, replayed against testvectors client-rules.json); this file only feeds
// it the CURRENT state this client holds and keeps the answer, with its reason, for the games UI:
//   ok            {space, owner}: the space's create-event sender's server keeps the chips (never a via)
//   no-space      "Games live in spaces: start one from a room in a space."
//   unavailable   a candidate space isn't held in full (not joined / still loading): never fall through it
//   is-space      the room is a space itself
//   unknown       this client doesn't hold the room
// Cached 5 min per room; dropped on any m.space.parent / m.space.child / m.room.create / own membership change.
// Also: the spaces that list a room which doesn't name them back (for a room admin's "Use <space>'s chips here").
import { useSyncExternalStore } from "react";
import { RoomEvent, RoomStateEvent, type MatrixEvent } from "matrix-js-sdk";
import { onClientChanged, peekClient, useRoomName } from "@/core/matrix";
import { gameSpace, viaOk, type HeldSpace, type SpaceLink } from "@/features/prestige/clientRules";

export type RoomGameWhy = "" | "no-space" | "unavailable" | "is-space" | "unknown";
export interface RoomGame {
  why: RoomGameWhy;
  space: string | null;
  owner: string | null;
}
const UNKNOWN: RoomGame = Object.freeze({ why: "unknown", space: null, owner: null }) as RoomGame;

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { g: RoomGame; at: number }>();
let version = 0;
const listeners = new Set<() => void>();

/** DEV only (the games gallery): every room plays in this space (named `devName`). */
let devGame: RoomGame | null = null;
let devName = "";
export function setDevRoomGame(g: RoomGame | null, name = ""): void {
  if (!import.meta.env.DEV) return;
  devGame = g;
  devName = name;
}

/** A space's name for the games UI (its room name; the gallery's stand-in in DEV; else the id). */
export function useSpaceName(space: string | null | undefined): string {
  const n = useRoomName(space ?? "");
  return n || (import.meta.env.DEV && devGame && space === devGame.space ? devName : "") || space || "";
}

export function dropRoomGames(): void {
  cache.clear();
  version++;
  for (const l of [...listeners]) l();
}

const EVENTS = new Set(["m.space.parent", "m.space.child", "m.room.create"]);
let watched: unknown = null;
function watch(): void {
  const c = peekClient();
  if (!c || watched === c) return;
  watched = c;
  c.on(RoomStateEvent.Events, (ev: MatrixEvent) => {
    if (EVENTS.has(ev.getType()) || (ev.getType() === "m.room.member" && ev.getStateKey() === c.getUserId())) dropRoomGames();
  });
  c.on(RoomEvent.MyMembership, () => dropRoomGames());
}
onClientChanged(() => dropRoomGames());

function held(id: string): HeldSpace | null {
  const r = peekClient()?.getRoom(id);
  if (!r || r.getMyMembership() !== "join") return null;
  const create = r.currentState.getStateEvents("m.room.create", "");
  return {
    create_sender: create?.getSender() ?? null,
    create_type: (create?.getContent() as { type?: unknown } | undefined)?.type ?? null,
    children: r.currentState.getStateEvents("m.space.child").map((e) => ({ room: e.getStateKey() ?? "", content: e.getContent() })),
  };
}

function compute(roomId: string): RoomGame {
  const r = peekClient()?.getRoom(roomId);
  if (!r) return UNKNOWN;
  const create = r.currentState.getStateEvents("m.room.create", "");
  const createType = (create?.getContent() as { type?: unknown } | undefined)?.type ?? null;
  const parents: SpaceLink[] = r.currentState.getStateEvents("m.space.parent").map((e) => ({ space: e.getStateKey() ?? "", content: e.getContent() }));
  const spaces: Record<string, HeldSpace> = {};
  for (const p of parents) {
    const h = p.space ? held(p.space) : null;
    if (h) spaces[p.space] = h;
  }
  const g = gameSpace({ mode: "app", room: { id: roomId, create_type: createType, parents }, spaces });
  if (g.why === "" && g.space && g.server) return { why: "", space: g.space, owner: g.server };
  return { why: g.why === "wrong-server" ? "unavailable" : (g.why as RoomGameWhy) || "no-space", space: null, owner: null };
}

/** The room's game space now (cached 5 min). */
export function roomGame(roomId: string): RoomGame {
  if (import.meta.env.DEV && devGame) return roomId ? devGame : UNKNOWN;
  if (!roomId) return UNKNOWN;
  watch();
  const now = Date.now();
  const hit = cache.get(roomId);
  if (hit && now - hit.at < TTL_MS) return hit.g;
  const g = compute(roomId);
  if (g.why !== "unknown") cache.set(roomId, { g, at: now });
  return g;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function useRoomGame(roomId: string): RoomGame {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return roomGame(roomId);
}

/** Spaces I'm in that list this room (valid via) while the room doesn't name them: the candidates for a room admin's
 *  "Use <space>'s chips here" (rev 2 §1.1 step 4). */
export function childOnlySpaces(roomId: string): { space: string; via: string[] }[] {
  const c = peekClient();
  const r = c?.getRoom(roomId);
  if (!c || !r) return [];
  const named = new Set(r.currentState.getStateEvents("m.space.parent").filter((e) => viaOk(e.getContent())).map((e) => e.getStateKey() ?? ""));
  const out: { space: string; via: string[] }[] = [];
  for (const s of c.getRooms()) {
    if (s.getMyMembership() !== "join" || named.has(s.roomId)) continue;
    const create = s.currentState.getStateEvents("m.room.create", "");
    if ((create?.getContent() as { type?: unknown } | undefined)?.type !== "m.space") continue;
    const child = s.currentState.getStateEvents("m.space.child", roomId);
    if (child && viaOk(child.getContent())) out.push({ space: s.roomId, via: (child.getContent() as { via: string[] }).via.slice(0, 20) });
  }
  return out.sort((a, b) => (a.space < b.space ? -1 : a.space > b.space ? 1 : 0));
}

/** May I write the room's m.space.parent (a room admin)? */
export function canLinkParent(roomId: string): boolean {
  const c = peekClient();
  const r = c?.getRoom(roomId);
  const me = c?.getUserId();
  return !!r && !!me && r.currentState.maySendStateEvent("m.space.parent", me);
}

/** "Use <space>'s chips here": the room names the space back (canonical, with the space's via). */
export async function linkParent(roomId: string, space: string, via: string[]): Promise<void> {
  const c = peekClient();
  if (!c) throw new Error("not signed in");
  // canonical only when no other parent already claims it (two canonicals fall back to code-point order anyway)
  const r = c.getRoom(roomId);
  const taken = !!r?.currentState.getStateEvents("m.space.parent").some((e) => (e.getContent() as { canonical?: unknown }).canonical === true);
  await c.sendStateEvent(roomId, "m.space.parent" as never, (taken ? { via } : { via, canonical: true }) as never, space);
  dropRoomGames();
}

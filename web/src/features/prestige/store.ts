// store.ts — the prestige rank store of the app (GAMES-V1-SPEC rev 2 §1.1 / §3.3 / §3.4): rankCache.ts wired to the
// matrix client, each space owner's well-known and its play API. The desktop's prestige.rs is the same wiring.
//
//   usePrestige(mxid, contextId?)   the rank to draw beside that name (0 = no token). contextId = the room the surface
//                                   is about (its game space's rank), or a space's own id (that space's rank); none =
//                                   no token (account card, Settings, search, DMs and rooms in no space)
//   prestigeScopeOf(contextId)      {owner, space} or null: gameSpace (app mode) on the state this client holds, the
//                                   owner = the space's create-event sender's server (never a via); cached 5 min per
//                                   room, dropped on any m.space.parent / m.space.child / own membership change
//   applyRankPush(owner, frame)     the play client hands every {"t":"rank"} frame of an owner's socket here
//   registerPlaySessionSource(fn)   the play client shares its play sessions (one exchange per server)
//
// An owner shows tokens only when ITS well-known says `dev.tinhat.server.features.play === true` (§1: "explicit play:
// true"); the app never contacts a server named by a via or by another server's answer. The play session is the play
// client's when it has one, else this store's own OpenID exchange (§6.1).
//
// Fixture (until the server's contract freeze, and for screenshots): in a LAB build only (`vite dev`, or a build with
// TW_LAB_BUILD=1: __TW_LAB__; a production bundle folds it to false and drops the code), `window.__TW_PRESTIGE_FIXTURE__ =
// {"ranks": {"<space id>"|"*": {"<mxid>": rank}}, "ctx"?: {"<context id>"|"*": "<space id>"}}` — or, instead of
// "ranks", "play": {"<owner>"|"*": "<api>/play/v1"} to run the real session + ranks reads against e.g. the contract mock — (or
// `?thprestige=@a:x=3,@b:y=13` in a DEV build: every context, one fixture space) answers instead of the network, through
// the same cache (every owner then counts as having games); `ctx` maps a surface to a space without any space state
// (screenshots on rooms that aren't in a space). A production build has no fixture at all.
import { useSyncExternalStore } from "react";
import { RoomEvent, RoomStateEvent, type MatrixEvent } from "matrix-js-sdk";
import { getClient, getClientEpoch, onClientChanged, peekClient } from "@/core/matrix/client";
import { useSessionStore } from "@/core/matrix/session";
import { createLogger } from "@/core/log";
import { nativeInfo } from "@/features/native/bridge";
import { WEB_VERSION } from "@/features/calls/rtc";
import { gameSpace, rankContext, serverOfUserId, type HeldSpace, type RankSurface, type SpaceLink } from "./clientRules";
import { RankCache, keyOf, type Clock, type RankAnswer, type RankTransport, type Scope } from "./rankCache";

const log = createLogger("prestige");

const HTTP_TIMEOUT_MS = 10_000;

interface Fixture {
  /** fake answers: space | "*" → mxid → rank (no network) */
  ranks?: Record<string, Record<string, number>>;
  /** OR a real play API per owner (owner | "*" → `<api>/play/v1`, e.g. the contract mock): real session + ranks reads */
  play?: Record<string, string>;
  ctx?: Record<string, string>;
}

/** The fixture, in a lab build when one was given; null otherwise (a production build folds this to null). */
function fixture(): Fixture | null {
  if (!__TW_LAB__ || typeof window === "undefined") return null;
  const w = window as Window & { __TW_PRESTIGE_FIXTURE__?: unknown };
  const f = w.__TW_PRESTIGE_FIXTURE__ as Partial<Fixture> | undefined;
  if (f && typeof f === "object" && ((f.ranks && typeof f.ranks === "object") || (f.play && typeof f.play === "object"))) return f as Fixture;
  {
    const q = new URLSearchParams(location.search).get("thprestige");
    if (q) {
      const all: Record<string, number> = {};
      for (const part of q.split(",")) {
        const i = part.lastIndexOf("=");
        if (i > 0) all[part.slice(0, i)] = Number(part.slice(i + 1));
      }
      return { ranks: { "*": all }, ctx: { "*": "!fixture" } };
    }
  }
  return null;
}

// ---- the play session ---------------------------------------------------------------------------------------------

export type PlaySessionSource = (server: string, base: string, renew: boolean) => Promise<string | null>;
let sharedSource: PlaySessionSource | null = null;

/** The play client registers how to get its session for a server (null = it has none: the store makes its own). */
export function registerPlaySessionSource(fn: PlaySessionSource | null): void {
  sharedSource = fn;
}

const own = new Map<string, { session: string; expires: number }>();

/** §6.1 client.kind: what this page is (a claim, used only to hide The Rig in the phone apps). */
export function clientKind(): "web" | "ios-app" | "android-app" | "mac-app" {
  const p = nativeInfo()?.platform;
  return p === "ios" ? "ios-app" : p === "android" ? "android-app" : p === "macos" ? "mac-app" : "web";
}

/** The whole exchange — headers AND body — under one deadline (a server that stalls its body can't strand a read). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error("timed out")), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function ownSession(server: string, base: string, renew: boolean): Promise<string> {
  const have = own.get(server);
  if (have && !renew && have.expires - 60_000 > Date.now()) return have.session;
  own.delete(server);
  const c = getClient();
  // an account switch during the exchange: its session belongs to nobody here (onClientChanged bumps the epoch)
  const epoch = getClientEpoch();
  const me = c.getUserId();
  if (!me) throw new Error("not signed in");
  const openid = await withTimeout(c.getOpenIdToken(), HTTP_TIMEOUT_MS);
  const j = await withTimeout(
    (async () => {
      const res = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openid, user_id: me, client: { kind: clientKind(), v: WEB_VERSION, pad: false } }),
      });
      if (!res.ok) throw new Error(`play session: HTTP ${res.status}`);
      return (await res.json()) as { v?: unknown; session?: unknown; expires?: unknown; user?: unknown };
    })(),
    HTTP_TIMEOUT_MS,
  );
  if (j.v !== 1 || typeof j.session !== "string" || j.session.length < 16 || j.user !== me) throw new Error("play session: not a session answer");
  if (getClientEpoch() !== epoch) throw new Error("play session: the account changed meanwhile");
  own.set(server, { session: j.session, expires: typeof j.expires === "number" ? j.expires : Date.now() + 60 * 60_000 });
  return j.session;
}

// ---- the transport ------------------------------------------------------------------------------------------------

const ORIGIN_RE = /^https?:\/\/[^/\s?#]+/;

/** `dev.tinhat.server` of a well-known answer → `<api>/play/v1` when features.play === true, else null. */
export function playBaseFromWellKnown(wk: unknown): string | null {
  if (!wk || typeof wk !== "object") return null;
  const d = (wk as Record<string, unknown>)["dev.tinhat.server"];
  if (!d || typeof d !== "object") return null;
  const o = d as { api?: unknown; features?: unknown };
  const f = o.features && typeof o.features === "object" ? (o.features as Record<string, unknown>) : null;
  if (!f || f.play !== true) return null;
  if (typeof o.api !== "string" || !ORIGIN_RE.test(o.api)) return null;
  return `${o.api.replace(/\/+$/, "")}/play/v1`;
}

const realTransport: RankTransport = {
  async playBase(server) {
    const fx = fixture();
    if (fx?.play) return fx.play[server] ?? fx.play["*"] ?? null;
    if (fx) return `fixture://${server}`;
    return withTimeout(
      (async () => {
        const res = await fetch(`https://${server}/.well-known/matrix/client`, { cache: "no-cache" });
        return res.ok ? playBaseFromWellKnown(await res.json()) : null;
      })(),
      HTTP_TIMEOUT_MS,
    );
  },
  async session(server, base, renew) {
    if (base.startsWith("fixture://")) return "fixture";
    if (sharedSource) {
      const s = await sharedSource(server, base, renew).catch(() => null);
      if (s) return s;
    }
    return ownSession(server, base, renew);
  },
  async ranks(base, session, space, ids): Promise<RankAnswer> {
    if (base.startsWith("fixture://")) {
      const fx = fixture()?.ranks ?? {};
      const table = { ...(fx["*"] ?? {}), ...(fx[space] ?? {}) };
      const ranks: Record<string, number> = {};
      for (const id of ids) if (typeof table[id] === "number" && table[id] > 0) ranks[id] = table[id];
      return { status: 200, body: { v: 1, space, ranks } };
    }
    const q = new URLSearchParams();
    q.set("space", space);
    for (const id of ids) q.append("u", id);
    const answer = await withTimeout(
      (async (): Promise<RankAnswer> => {
        const res = await fetch(`${base}/ranks?${q.toString()}`, { headers: { Authorization: `Play ${session}` } });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return { status: res.status, body };
      })(),
      HTTP_TIMEOUT_MS,
    );
    if (answer.status !== 200) log.info(`ranks: HTTP ${answer.status} (${ids.length} ids)`);
    return answer;
  },
};

const clock: Clock = { now: () => Date.now(), setTimeout: (cb, ms) => setTimeout(cb, ms) };

export const prestigeCache = new RankCache(realTransport, clock);

onClientChanged(() => {
  own.clear();
  prestigeCache.clear();
});

// ---- the surface's space (§1.1, §3.3) ------------------------------------------------------------------------------

const SPACE_TTL_MS = 5 * 60_000;
const spaceCache = new Map<string, { scope: Scope | null; at: number }>();
let spaceVersion = 0;
const spaceListeners = new Set<() => void>();

function dropSpaces(): void {
  spaceCache.clear();
  spaceVersion++;
  for (const cb of [...spaceListeners]) cb();
}

const SPACE_EVENTS = new Set(["m.space.parent", "m.space.child", "m.room.create"]);
let watchedClient: unknown = null;
function watchClient(): void {
  const c = peekClient();
  if (!c || watchedClient === c) return;
  watchedClient = c;
  c.on(RoomStateEvent.Events, (ev: MatrixEvent) => {
    if (SPACE_EVENTS.has(ev.getType()) || (ev.getType() === "m.room.member" && ev.getStateKey() === c.getUserId())) dropSpaces();
    // someone else left (or was removed from) a space: no rank shown for them there any more (§1.1)
    if (ev.getType() === "m.room.member" && ev.getStateKey() !== c.getUserId()) {
      const membership = (ev.getContent() as { membership?: unknown }).membership;
      const roomId = ev.getRoomId();
      if (roomId && membership !== "join" && (c.getRoom(roomId)?.isSpaceRoom() ?? false)) prestigeCache.forgetPerson(roomId, ev.getStateKey() ?? "");
    }
  });
  c.on(RoomEvent.MyMembership, () => dropSpaces());
}

/** A room's or space's state as gameSpace (app mode) reads it; null when this client doesn't hold the room. */
function heldSpace(id: string): HeldSpace | null {
  const c = peekClient();
  const r = c?.getRoom(id);
  if (!r || r.getMyMembership() !== "join") return null;
  const create = r.currentState.getStateEvents("m.room.create", "");
  return {
    create_sender: create?.getSender() ?? null,
    create_type: (create?.getContent() as { type?: unknown } | undefined)?.type ?? null,
    // a joined room whose state hasn't arrived yet (no create event) is unknown, not invalid: gameSpace stops there
    partial: !create,
    children: r.currentState.getStateEvents("m.space.child").map((e) => ({ room: e.getStateKey() ?? "", content: e.getContent() })),
  };
}

function computeScope(contextId: string): Scope | null {
  const c = peekClient();
  const r = c?.getRoom(contextId);
  if (!c || !r) return null;
  const create = r.currentState.getStateEvents("m.room.create", "");
  const createType = (create?.getContent() as { type?: unknown } | undefined)?.type;
  let surface: RankSurface;
  let owner: string | null = null;
  if (createType === "m.space") {
    // a space's own surfaces (its members, its settings): that space, when this client is in it
    if (r.getMyMembership() !== "join") return null;
    owner = serverOfUserId(create?.getSender());
    surface = { kind: "space", space: contextId };
  } else {
    const parents: SpaceLink[] = r.currentState.getStateEvents("m.space.parent").map((e) => ({ space: e.getStateKey() ?? "", content: e.getContent() }));
    const spaces: Record<string, HeldSpace> = {};
    for (const p of parents) {
      const h = p.space ? heldSpace(p.space) : null;
      if (h) spaces[p.space] = h;
    }
    const g = gameSpace({ mode: "app", room: { id: contextId, create_type: createType ?? null, parents }, spaces });
    owner = g.server;
    surface = { kind: "room", room: contextId, game_space: g.why === "" ? g.space : null };
  }
  const space = rankContext(surface);
  return space && owner ? { owner, space } : null;
}

/** Whose rank a token on this surface shows (§3.3): {owner, space}, or null = no token. */
export function prestigeScopeOf(contextId?: string | null): Scope | null {
  if (!contextId) return null;
  const fxc = fixture()?.ctx;
  if (fxc) {
    const space = fxc[contextId] ?? fxc["*"];
    return typeof space === "string" && space.startsWith("!") ? { owner: "fixture.invalid", space } : null;
  }
  watchClient();
  const now = Date.now();
  const hit = spaceCache.get(contextId);
  if (hit && now - hit.at < SPACE_TTL_MS) return hit.scope;
  const scope = computeScope(contextId);
  // a room the client doesn't hold yet isn't cached: the next render asks again
  if (peekClient()?.getRoom(contextId)) spaceCache.set(contextId, { scope, at: now });
  return scope;
}

onClientChanged(() => dropSpaces());

/** The play client: every {"t":"rank"} frame from `owner`'s play socket (it can only change that owner's spaces). */
export function applyRankPush(owner: string, frame: unknown): boolean {
  return prestigeCache.push(owner, frame);
}

function subscribeSpaces(cb: () => void): () => void {
  spaceListeners.add(cb);
  return () => spaceListeners.delete(cb);
}

/** The rank to draw beside `mxid` (0 = no token). contextId = the room the surface is about, or a space's own id. */
export function usePrestige(mxid: string | null | undefined, contextId?: string | null): number {
  useSessionStore((s) => s.userId); // a new account → everything again
  useSyncExternalStore(subscribeSpaces, () => spaceVersion, () => 0);
  const scope = mxid ? prestigeScopeOf(contextId) : null;
  const key = scope && mxid ? keyOf(scope, mxid) : "";
  return useSyncExternalStore(
    (cb) => (key ? prestigeCache.subscribe(key, cb) : () => {}),
    () => (scope && mxid ? prestigeCache.get(scope, mxid) : 0),
    () => 0,
  );
}

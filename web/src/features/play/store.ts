// store.ts — the games' app state (GAMES-V1-SPEC rev 2: §1.1, §2.2, §6). A room plays with its GAME SPACE's chips
// (space.ts → the prestige feature's pure gameSpace); the space's OWNER server (its create-event sender's server, never a via)
// deals and keeps the wallets. One PlayConnection per owner, found through the owner's own well-known (our own server:
// this page's same-origin /api). Wallets are per (owner, space); the opt-in line is asked once per space. React reads
// it through the hooks at the bottom. The token store (features/prestige) gets this client's play sessions and rank
// pushes, so there is one sign-in per server.
import { acquirePoll } from "./poll";
import { create } from "zustand";
import { useEffect } from "react";
import { API_BASE } from "@/core/api";
import { MATRIX_ORIGIN } from "@/core/bearer";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import { getSession, onSessionEnding, peekClient } from "@/core/matrix";
import { getFormFactor } from "@/core/device";
import { inPhoneApp } from "@/features/native";
import { useCallStore } from "@/features/calls";
import { applyRankPush, clientKind, registerPlaySessionSource } from "@/features/prestige/store";
import { gameVisible, serverOfUserId } from "@/features/prestige/clientRules";
import { PlayConnection, PlayHttpError, type Ack, type ConnStatus, type NetDeps, type SocketLike } from "./net";
import { cardBody, GAME_WORDS } from "./rules";
import { dropRoomGames, roomGame, useRoomGame, type RoomGame } from "./space";
import { contractOf, type Contract } from "./contract";
import { codeWords, newerView, parseMe, parseSpace, parseSummary, parseTables, type CardKind, type Game, type ServerFrame, type Summary, type TableItem, type View, type Wallet } from "./wire";

const log = createLogger("play");

// the frozen contract's schema (95 KB): fetched with the first connection, never in the start-up bundle
let contractP: Promise<Contract> | null = null;
export function loadContract(): Promise<Contract> {
  contractP ??= import("../../../testvectors/games/views/schema.json").then((m) => contractOf((m as { default: unknown }).default));
  return contractP;
}

// ---- DEV-only stand-ins (the #/__gallery/games page: no account, the mock dealer) ----------------------------------
let mockOn: boolean = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("playmock") === "1";
function playMock(): boolean {
  return import.meta.env.DEV && mockOn;
}
let devMe = "";
export function setPlayDevIdentity(me: string): void {
  if (!import.meta.env.DEV) return;
  devMe = me;
  mockOn = true;
}
/** My Matrix id (the session's; the gallery's stand-in in DEV). */
export function meNow(): string {
  return (import.meta.env.DEV && devMe) || getSession().userId || "";
}
export function ownServer(): string {
  return serverOfUserId(meNow()) ?? "";
}

// ---- state ----------------------------------------------------------------------------------------------------------
export interface PlayFeatures {
  play: boolean;
  rigPhoneApps: boolean;
  /** the owner's play API base ("" = none) */
  base: string;
  /** the owner couldn't be reached (vs. reached and plays no games) */
  unreachable: boolean;
}
export interface OwnerPlay {
  features: PlayFeatures | null;
  status: ConnStatus | "unknown";
  error: string;
  rigHidden: boolean;
  /** the spaces on this owner where I have a wallet (the session answer); null = not signed in yet */
  wallets: string[] | null;
}
const NO_OWNER: OwnerPlay = Object.freeze({ features: null, status: "unknown", error: "", rigHidden: false, wallets: null }) as OwnerPlay;

export interface SpaceWallet {
  /** null = unknown */
  has: boolean | null;
  wallet: Wallet | null;
}
export const wkey = (owner: string, space: string) => `${owner}|${space}`;

export interface OpenView {
  view: View;
  seenAt: number;
  owner: string;
  space: string;
  room: string;
}

export interface PlayState {
  owners: Record<string, OwnerPlay>;
  wallets: Record<string, SpaceWallet>;
  /** room id → its tables (as its owner lists them) */
  rooms: Record<string, TableItem[]>;
  views: Record<string, OpenView>;
  /** The Rig's live dial per table (the `live` frames) */
  dial: Record<string, number>;
  /** the latest refusal per table, shown on the table for a few seconds */
  notes: Record<string, { text: string; at: number }>;
  /** the opt-in line, while it is asked */
  ask: { owner: string; space: string } | null;
  /** the owner's answer to GET /rooms/{room}/space, by `room|owner|space`: "" = it confirms; else its code */
  confirm: Record<string, string>;
  /** a table that couldn't be opened (an `error` frame for it), by table: its code */
  openErr: Record<string, string>;
  /** the game panel, while open: the room and the table ("" = the Games list) */
  panel: { roomId: string; table: string } | null;
}

export const usePlay = create<PlayState>()(() => ({ owners: {}, wallets: {}, rooms: {}, views: {}, dial: {}, notes: {}, ask: null, confirm: {}, openErr: {}, panel: null }));

const ckey = (room: string, owner: string, space: string) => `${room}|${owner}|${space}`;
function setConfirm(key: string, why: string) {
  usePlay.setState((s) => ({ confirm: { ...s.confirm, [key]: why } }));
}
const confirmAsked = new Map<string, number>();
const confirmRetries = new Map<string, number>();
/** Ask the owner this app's game_space found (and only it) to confirm the room's space: GET /rooms/{room}/space. A
 *  `wrong-server` answer is SHOWN, never followed (rev 2 §1.1); asked again after 5 min or a space change. */
async function confirmSpace(roomId: string, g: RoomGame): Promise<void> {
  if (!g.owner || !g.space) return;
  const k = ckey(roomId, g.owner, g.space);
  const my = gen;
  const last = confirmAsked.get(k) ?? 0;
  if (Date.now() - last < 5 * 60_000) return;
  confirmAsked.set(k, Date.now());
  const c = await conn(g.owner);
  if (!c) return;
  try {
    const a = parseSpace(await loadContract(), await c.get(`/rooms/${encodeURIComponent(roomId)}/space`));
    if (my !== gen) return;
    setConfirm(k, a && a.space === g.space && a.server === g.owner ? "" : "wrong-server");
  } catch (e) {
    if (my !== gen) return;
    const code = e instanceof PlayHttpError ? e.code : "network";
    if (code === "network" || code === "db" || code.startsWith("http-")) {
      // a passing failure: ask again in 30 s (a mounted panel then updates)
      confirmAsked.delete(k);
      const n = (confirmRetries.get(k) ?? 0) + 1;
      confirmRetries.set(k, n);
      // bounded: 30 s, 60 s, … at most 5 times; a new look at the room (a remount) starts again
      if (n <= 5) setTimeout(() => my === gen && roomGame(roomId).space === g.space && void confirmSpace(roomId, g), 30_000 * n);
      return;
    }
    setConfirm(k, code === "no-space" || code === "unavailable" ? code : "wrong-server");
  }
}

const conns = new Map<string, PlayConnection>();
const connPs = new Map<string, Promise<PlayConnection | null>>();
/** bumped at sign-out: an async step that started before it changes nothing after it */
let gen = 0;
const featureAsks = new Map<string, Promise<PlayFeatures>>();
const featureRetries = new Map<string, number>();
const reopenTries = new Map<string, number>();
/** table → where it lives (from table lists, creation and views) */
const tableHome = new Map<string, { owner: string; space: string; room: string }>();

function patchOwner(owner: string, p: Partial<OwnerPlay>) {
  usePlay.setState((s) => ({ owners: { ...s.owners, [owner]: { ...(s.owners[owner] ?? NO_OWNER), ...p } } }));
}
export function ownerState(owner: string): OwnerPlay {
  return usePlay.getState().owners[owner] ?? NO_OWNER;
}
function patchWallet(owner: string, space: string, p: Partial<SpaceWallet>) {
  const k = wkey(owner, space);
  usePlay.setState((s) => ({ wallets: { ...s.wallets, [k]: { ...(s.wallets[k] ?? { has: null, wallet: null }), ...p } } }));
}
export function walletState(owner: string, space: string): SpaceWallet {
  return usePlay.getState().wallets[wkey(owner, space)] ?? { has: null, wallet: null };
}

type O = Record<string, unknown>;
const isObj = (v: unknown): v is O => !!v && typeof v === "object" && !Array.isArray(v);

/** An owner's play switches from its /.well-known/matrix/client (strict: only `features.play === true` plays). */
export function parsePlayFeatures(doc: unknown, own: boolean): PlayFeatures {
  const t = isObj(doc) ? doc["dev.tinhat.server"] : undefined;
  const f = isObj(t) ? t.features : undefined;
  const api = isObj(t) && typeof t.api === "string" ? t.api.trim().replace(/\/+$/, "") : "";
  const play = isObj(f) && f.play === true;
  // our own server: this page's same-origin API (proxied in dev); another: its announced https API only
  const base = own ? `${API_BASE}/play/v1` : /^https:\/\/[^/\s?#]+(\/\S*)?$/i.test(api) ? `${api}/play/v1` : "";
  return { play: play && !!base, rigPhoneApps: isObj(f) && f.play_rig_phone_apps === true, base, unreachable: false };
}

/** Ask an owner for its play switches (once per session; a failure is asked again a minute later). Only ever an owner
 *  taken from a space's create event: never a server named by a via or by another server's answer. */
export function playFeatures(owner: string): Promise<PlayFeatures> {
  const have = ownerState(owner).features;
  if (have) return Promise.resolve(have);
  const inflight = featureAsks.get(owner);
  if (inflight) return inflight;
  const p = (async (): Promise<PlayFeatures> => {
    // DEV gallery: the play contract's mock behind the dev server's /api proxy (TH_DEV_SERVER = the mock)
    if (playMock()) return { play: true, rigPhoneApps: new URLSearchParams(location.search).get("playrigphone") === "1", base: `${API_BASE}/play/v1`, unreachable: false };
    const own = owner === ownServer();
    try {
      const url = own ? `${MATRIX_ORIGIN}/.well-known/matrix/client` : `https://${owner}/.well-known/matrix/client`;
      const r = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8000) });
      return r.ok ? parsePlayFeatures(await r.json(), own) : { play: false, rigPhoneApps: false, base: "", unreachable: r.status >= 500 };
    } catch (e) {
      log.warn(`couldn't read ${owner}'s switches`, e);
      return { play: false, rigPhoneApps: false, base: "", unreachable: true };
    }
  })();
  featureAsks.set(owner, p);
  const my = gen;
  void p.then((pf) => {
    if (my !== gen) return;
    patchOwner(owner, { features: pf });
    // unreachable is never final: forget it a minute later, so the next look asks again
    if (pf.unreachable)
      setTimeout(() => {
        if (my !== gen) return;
        // ask again (a mounted panel then updates), at most 10 times a session per owner; after that the failure stays
        // on screen ("Can't reach this space's server") rather than an endless "asking"
        const n = (featureRetries.get(owner) ?? 0) + 1;
        featureRetries.set(owner, n);
        if (n > 10) return;
        featureAsks.delete(owner);
        patchOwner(owner, { features: null });
        void playFeatures(owner);
      }, 60_000);
  });
  return p;
}

// ---- connections -----------------------------------------------------------------------------------------------
function realDeps(base: string, contract: Contract): NetDeps {
  return {
    base,
    contract,
    userId: meNow(),
    client: { kind: clientKind(), v: (import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev", pad: getFormFactor() === "mobile" },
    openId: async () => {
      const c = peekClient();
      // DEV gallery: the contract mock signs anyone in on loopback (it never checks the token)
      if (!c && import.meta.env.DEV && playMock()) return { access_token: "gallery", matrix_server_name: ownServer(), token_type: "Bearer", expires_in: 3600 };
      if (!c) throw new PlayHttpError(401, "session");
      const t = await c.getOpenIdToken();
      return { access_token: t.access_token, matrix_server_name: t.matrix_server_name, token_type: t.token_type ?? "Bearer", expires_in: t.expires_in ?? 3600 };
    },
    fetch: (u, i) => fetch(u, i),
    socket: (u) => new WebSocket(u) as unknown as SocketLike,
    now: () => Date.now(),
  };
}

/** The live connection to an owner that plays (started on first use; null while its switches are unknown / off). */
export function conn(owner: string): Promise<PlayConnection | null> {
  const have = conns.get(owner);
  if (have) {
    have.start();
    return Promise.resolve(have);
  }
  // single flight: concurrent callers share one creation (one socket per owner)
  let p = connPs.get(owner);
  if (!p) {
    p = makeConn(owner).finally(() => connPs.delete(owner));
    connPs.set(owner, p);
  }
  return p;
}

async function makeConn(owner: string): Promise<PlayConnection | null> {
  const my = gen;
  const pf = await playFeatures(owner);
  if (!pf.play || my !== gen) return null;
  const contract = await loadContract();
  if (my !== gen) return null;
  if (conns.has(owner)) return conns.get(owner)!;
  const deps = realDeps(pf.base, contract);
  const c: PlayConnection = new PlayConnection(
    deps,
    (f) => onFrame(owner, f),
    (st, err) => {
      patchOwner(owner, { status: st, error: err });
      if (st === "live" && c.session) patchOwner(owner, { wallets: c.session.wallets, rigHidden: c.session.rigHidden });
    },
  );
  conns.set(owner, c);
  c.start();
  return c;
}

// the token store signs in through this client's sessions (one exchange per server)
registerPlaySessionSource(async (server, _base, renew) => {
  const c = conns.get(server);
  if (!c) return null;
  if (renew) c.session = null;
  try {
    return (await c.ensureSession()).session;
  } catch {
    return null;
  }
});

function onFrame(owner: string, f: ServerFrame) {
  switch (f.t) {
    case "room": {
      // only what this owner may speak for: its own listing of a room whose game space it keeps (as found here)
      if (f.owner !== owner || roomGame(f.room).owner !== owner) return;
      const mine = f.tables.filter((t) => t.owner === owner && !(tableHome.has(t.table) && tableHome.get(t.table)!.owner !== owner));
      for (const t of mine) tableHome.set(t.table, { owner, space: t.space || f.space, room: f.room });
      usePlay.setState((s) => ({ rooms: { ...s.rooms, [f.room]: mine } }));
      for (const t of mine) drainPosts(owner, t.table);
      return;
    }
    case "view": {
      // a view must be this owner's table, of a room whose game space it keeps; a table another owner already
      // spoke for is never taken over
      const rg = roomGame(f.view.room);
      if (f.view.owner !== owner || rg.owner !== owner || (rg.space && f.view.space && rg.space !== f.view.space)) return;
      const known = tableHome.get(f.table);
      if (known && known.owner !== owner) return;
      const curOv = usePlay.getState().views[f.table];
      if (curOv && curOv.owner !== owner) return;
      if (!newerView(curOv?.view, f.view)) return;
      tableHome.set(f.table, { owner, space: f.view.space, room: f.view.room });
      reopenTries.delete(f.table);
      usePlay.setState((s) => {
        const dial = { ...s.dial };
        delete dial[f.table]; // a newer view carries the dial itself
        const openErr = { ...s.openErr };
        delete openErr[f.table];
        return { views: { ...s.views, [f.table]: { view: f.view, seenAt: Date.now(), owner, space: f.view.space, room: f.view.room } }, dial, openErr };
      });
      drainPosts(owner, f.table); // after the record is committed: the post knows its game
      return;
    }
    case "live": {
      // only for the view it belongs to (a newer view carries the dial itself; an older live is dropped)
      const curOv = usePlay.getState().views[f.table];
      if (curOv && curOv.owner === owner && curOv.view.vseq === f.vseq) usePlay.setState((s) => ({ dial: { ...s.dial, [f.table]: f.dial } }));
      return;
    }
    case "wallet": {
      const prev = walletState(owner, f.space).wallet;
      if (prev) patchWallet(owner, f.space, { wallet: { ...prev, balance: f.balance, holdings: f.holdings, rank: f.rank, cap: f.cap, ...(typeof f.earned_today === "number" ? { earned_today: f.earned_today } : {}) }, has: true });
      else void refreshMe(owner, f.space);
      return;
    }
    case "rank":
      applyRankPush(owner, { t: "rank", space: f.space, u: f.u, rank: f.rank });
      return;
    case "post":
      void postCard(owner, f.kind, f.table, f.round);
      return;
    case "error":
      if (f.table) {
        const t = f.table;
        // only about a table this owner speaks for
        if (tableHome.get(t)?.owner !== owner) return;
        // a call membership the server hasn't seen yet (just joined): ask again a few times before giving up
        if (!usePlay.getState().views[t] && f.code === "not-in-call") {
          const n = (reopenTries.get(t) ?? 0) + 1;
          reopenTries.set(t, n);
          if (n <= 6) {
            const my = gen;
            setTimeout(() => my === gen && conns.get(owner)?.reopen(t), 2500);
            return;
          }
        }
        if (usePlay.getState().views[t]) usePlay.setState((s) => ({ notes: { ...s.notes, [t]: { text: codeWords(f.code), at: Date.now() } } }));
        else usePlay.setState((s) => ({ openErr: { ...s.openErr, [t]: f.code } }));
      } else if (f.room && (f.code === "no-space" || f.code === "wrong-server" || f.code === "unavailable" || f.code === "not-member")) {
        const g = roomGame(f.room);
        if (g.owner === owner && g.space) setConfirm(ckey(f.room, owner, g.space), f.code === "not-member" ? "wrong-server" : f.code);
      }
      return;
    case "bye":
      if (f.code === "replaced") log.info(`${owner}: this socket was replaced by a newer one`);
      return;
    default:
      return;
  }
}

/** GET /me?space= (also runs the server's top-up check). */
export async function refreshMe(owner: string, space: string): Promise<Wallet | null> {
  const c = await conn(owner);
  if (!c) return null;
  const my = gen;
  try {
    const w = parseMe(await loadContract(), await c.get(`/me?space=${encodeURIComponent(space)}`));
    if (my !== gen) return null;
    if (w) patchWallet(owner, space, { wallet: w, has: true });
    return w;
  } catch (e) {
    if (my === gen && e instanceof PlayHttpError && e.code === "no-wallet") patchWallet(owner, space, { has: false, wallet: null });
    return null;
  }
}

// ---- opt-in (§2.2: once per space) -----------------------------------------------------------------------------
const askWaiters = new Map<string, Array<(ok: boolean) => void>>();
/** spaces where "Not now" was answered this session: opening the panel doesn't ask again (sitting down does) */
const declined = new Set<string>();
/** Make sure I have a wallet in this space; the first time, ask the opt-in line (OK / Not now). `quiet` (the panel
 *  opening) doesn't ask again after a "Not now". */
export async function ensureWallet(owner: string, space: string, quiet = false): Promise<boolean> {
  const my = gen;
  const c = await conn(owner);
  if (!c || my !== gen) return false;
  const k = wkey(owner, space);
  try {
    const s = await c.ensureSession();
    if (my !== gen) return false;
    if (s.wallets.includes(space) || walletState(owner, space).has) return true;
  } catch (e) {
    if (my !== gen) return false;
    toast(codeWords(e instanceof PlayHttpError ? e.code : "bad"));
    return false;
  }
  if (quiet && declined.has(k)) return false;
  // one line at a time: while another space's line is up, this one waits for the next open
  const cur = usePlay.getState().ask;
  if (cur && wkey(cur.owner, cur.space) !== k) return false;
  return new Promise((resolve) => {
    const list = askWaiters.get(k) ?? [];
    list.push(resolve);
    askWaiters.set(k, list);
    usePlay.setState({ ask: { owner, space } });
  });
}
/** The opt-in answer (the dialog calls this). OK creates the wallet; Not now creates nothing and counts nothing. */
export async function answerOptIn(owner: string, space: string, ok: boolean): Promise<void> {
  const my = gen;
  usePlay.setState({ ask: null });
  const k = wkey(owner, space);
  if (!ok) declined.add(k);
  let done = false;
  if (ok) {
    const c = await conn(owner);
    try {
      await c?.post("/wallet", { space });
      if (my !== gen) return;
      if (c?.session && !c.session.wallets.includes(space)) c.session.wallets = [...c.session.wallets, space];
      patchWallet(owner, space, { has: true });
      patchOwner(owner, { wallets: c?.session?.wallets ?? null });
      await refreshMe(owner, space);
      done = true;
    } catch (e) {
      toast(codeWords(e instanceof PlayHttpError ? e.code : "bad"));
    }
  }
  for (const w of askWaiters.get(k) ?? []) w(done);
  askWaiters.delete(k);
}

/** Settings → Games → "Delete my chips in <space>". "" = done, else the refusal code. */
export async function deleteChips(owner: string, space: string): Promise<string> {
  const my = gen;
  const c = await conn(owner);
  if (!c || my !== gen) return "off";
  try {
    await c.del(`/wallet?space=${encodeURIComponent(space)}`);
    if (my !== gen) return "";
    if (c.session) c.session.wallets = c.session.wallets.filter((x) => x !== space);
    patchWallet(owner, space, { has: false, wallet: null });
    patchOwner(owner, { wallets: c.session?.wallets ?? null });
    return "";
  } catch (e) {
    return e instanceof PlayHttpError ? e.code : "bad";
  }
}

// ---- rooms and tables --------------------------------------------------------------------------------------------
/** Why a room has no games here (the words both apps use: wire.ts CODE_WORDS); "" when it plays. */
export type RoomPlayWhy = "" | "no-space" | "unavailable" | "is-space" | "unknown" | "owner-unsupported" | "owner-unavailable" | "wrong-server" | "confirming";
export interface RoomPlay {
  game: RoomGame;
  why: RoomPlayWhy;
  features: PlayFeatures | null;
  tables: TableItem[];
  /** the owner has answered with this room's listing (vs. still loading / failed) */
  loaded: boolean;
}

/** A cached view drawn for this room only while it is of the room's CURRENT owner + space (a room that moved never
 *  shows, or acts on, the old space's table). Every surface uses this. */
export function validFor(ov: OpenView | null | undefined, roomId: string, g: RoomGame): OpenView | null {
  if (!ov || !g.owner) return null;
  return ov.owner === g.owner && ov.room === roomId && (!g.space || ov.space === g.space) ? ov : null;
}

/** The room's games, kept live while mounted (in its call, or while its card is on screen). */
export function useRoomTables(roomId: string, on = true): RoomPlay {
  const game = useRoomGame(roomId);
  const owner = game.owner;
  const features = usePlay((s) => (owner ? (s.owners[owner]?.features ?? null) : null));
  const tables = usePlay((s) => s.rooms[roomId]);
  const confirmed = usePlay((s) => (game.owner && game.space ? s.confirm[ckey(roomId, game.owner, game.space)] : undefined));
  useEffect(() => {
    if (owner) void playFeatures(owner);
  }, [owner]);
  useEffect(() => {
    if (features?.play && game.owner && game.space) void confirmSpace(roomId, game);
  }, [roomId, game, features?.play]);
  useEffect(() => {
    if (!on || !owner || !roomId || !features?.play || confirmed !== "") return;
    let release: (() => void) | null = null;
    let dead = false;
    void conn(owner).then((c) => {
      if (dead || !c) return;
      release = c.sub(roomId);
    });
    return () => {
      dead = true;
      release?.();
    };
  }, [owner, roomId, on, features?.play, confirmed]);
  const why: RoomPlayWhy = game.why ? game.why : !features ? "" : !features.play ? (features.unreachable ? "owner-unavailable" : "owner-unsupported") : confirmed === undefined ? "confirming" : (confirmed as RoomPlayWhy);
  return { game, why, features, tables: tables ?? EMPTY, loaded: tables !== undefined };
}
const EMPTY: TableItem[] = [];

/** While a games surface shows (the panel, the call chips): refetch my wallet every 60 s, so chips earned in the call
 *  show without a reload (the `wallet` frames cover moves at a table). */
export function useWalletPoll(owner: string | null, space: string | null, on = true): void {
  useEffect(() => {
    if (!on || !owner || !space) return;
    // ONE poll per wallet, however many surfaces show it (the call bar's button, the phone strip, the panel)
    return acquirePoll(
      `wallet|${owner}|${space}`,
      () => {
        if (document.visibilityState === "visible" && walletState(owner, space).has) void refreshMe(owner, space);
      },
      60_000,
    );
  }, [owner, space, on]);
}

/** Which games this context shows (§6.5 gameVisible: the phone-app switch). */
export function visibleGame(game: Game, features: PlayFeatures | null): boolean {
  return gameVisible(game, { play: features?.play === true, phone_app: inPhoneApp(), rig_phone_apps: features?.rigPhoneApps === true });
}

/** Keep this table's view live while mounted. */
export function useTableView(owner: string | null, table: string | null): OpenView | null {
  const v = usePlay((s) => (table ? (s.views[table] ?? null) : null));
  useEffect(() => {
    if (!owner || !table) return;
    let release: (() => void) | null = null;
    let dead = false;
    void conn(owner).then((c) => {
      if (dead || !c) return;
      release = c.open(table);
    });
    return () => {
      dead = true;
      release?.();
    };
  }, [owner, table]);
  return v;
}

/** After `space-changed`: forget what was shown about the room and ask again. */
function spaceChanged(roomId: string) {
  dropRoomGames();
  for (const k of [...confirmAsked.keys()]) if (k.startsWith(`${roomId}|`)) confirmAsked.delete(k);
  usePlay.setState((s) => {
    const rooms = { ...s.rooms };
    delete rooms[roomId];
    const confirm = Object.fromEntries(Object.entries(s.confirm).filter(([k]) => !k.startsWith(`${roomId}|`)));
    return { rooms, confirm };
  });
  toast(codeWords("space-changed"));
}

/** Open a new table in the call's room (needs a wallet in its space: asks the opt-in line first). */
export async function createTable(roomId: string, game: Game, opts: Record<string, unknown>): Promise<string | null> {
  const g = roomGame(roomId);
  if (!g.owner || !g.space) {
    toast(codeWords(g.why || "no-space"));
    return null;
  }
  const my = gen;
  if (!(await ensureWallet(g.owner, g.space))) return null;
  const c = await conn(g.owner);
  if (!c || my !== gen) return null;
  try {
    const j = (await c.post(`/rooms/${encodeURIComponent(roomId)}/tables`, { game, opts, space: g.space })) as { table?: unknown };
    if (my !== gen) return null;
    const table = typeof j?.table === "string" ? j.table : null;
    if (table) {
      tableHome.set(table, { owner: g.owner, space: g.space, room: roomId });
      openGameWindow(roomId, table);
    }
    return table;
  } catch (e) {
    const code = e instanceof PlayHttpError ? e.code : "bad";
    if (code === "space-changed") spaceChanged(roomId);
    else toast(codeWords(code));
    return null;
  }
}

/** Show the game panel (over the room's timeline area; a sheet on phones) on a table, or the Games list (null). */
export function openGameWindow(roomId: string, table: string | null): void {
  usePlay.setState({ panel: { roomId, table: table ?? "" } });
}
/** A card's "Join the call" (spec §4.5): the room's normal join (its gates and sheets), then the panel on the table once
 *  this room's call is up. ONE pending join at a time: a second click for the same room only retargets the table (no
 *  second join); another room's card replaces it. It is dropped when the call fails, another room's call takes over,
 *  on sign-out, or after 60 s, and re-checked right before the panel opens (nothing opens outside the call). */
let pendingJoin: { roomId: string; table: string; cancel: () => void } | null = null;
export function joinCallForGame(roomId: string, table: string): void {
  if (pendingJoin && pendingJoin.roomId === roomId) {
    pendingJoin.table = table;
    return;
  }
  pendingJoin?.cancel();
  const my = gen;
  let off: (() => void) | null = null;
  let timer = 0;
  const me = {
    roomId,
    table,
    cancel: () => {
      off?.();
      off = null;
      window.clearTimeout(timer);
      if (pendingJoin === me) pendingJoin = null;
    },
  };
  pendingJoin = me;
  type St = { inCall: boolean; connecting: boolean; callFailed: boolean; callRoomId: string };
  const settle = (st: St) => {
    if (pendingJoin !== me) return;
    if (my !== gen || st.callFailed || (st.callRoomId && st.callRoomId !== roomId && (st.inCall || st.connecting))) return me.cancel();
    if (st.inCall && st.callRoomId === roomId) {
      const t = me.table;
      me.cancel();
      openGameWindow(roomId, t);
    }
  };
  off = useCallStore.subscribe((st) => settle(st));
  timer = window.setTimeout(() => me.cancel(), 60_000);
  useCallStore.getState().joinCall(roomId);
  settle(useCallStore.getState());
}
/** × / Esc: back to the chat. */
export function closeGamePanel(): void {
  usePlay.setState({ panel: null });
}

/** A move on a table. Refusals show on the table (and a session refusal signs in again). */
/** A move on what this screen drew: its `at` comes from that view (a turn the person never saw is refused stale). */
export function actOn(seen: View, a: Record<string, unknown>): Promise<Ack> {
  return act(seen.table, a, seen);
}

export async function act(table: string, a: Record<string, unknown>, seen?: View): Promise<Ack> {
  const my0 = gen;
  const gone: Ack = { op: "", ok: false, code: "closed", dup: false };
  const ov = usePlay.getState().views[table];
  const home = tableHome.get(table);
  const owner = ov?.owner ?? home?.owner;
  const space = ov?.space || home?.space || "";
  const room = ov?.room || home?.room || "";
  const c = owner ? await conn(owner) : null;
  if (!c || !owner) return { op: "", ok: false, code: "no-table", dup: false };
  // entering a table needs a wallet in its space (the opt-in line) and names the space I was shown
  const entering = a.do === "sit" || a.do === "join";
  if (entering && !(space && (await ensureWallet(owner, space)))) return { op: "", ok: false, code: "no-wallet", dup: false };
  if (my0 !== gen) return gone;
  let ack = await c.act(table, seen ?? ov?.view ?? null, entering ? { ...a, space } : a);
  if (my0 !== gen) return gone; // signed out while the move was in flight: no retry under the next session
  // sitting down / joining right after joining the call: the server may not have seen the call membership yet
  for (let i = 0; entering && !ack.ok && ack.code === "not-in-call" && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    if (my0 !== gen) return gone;
    ack = await c.act(table, null, { ...a, space });
    if (my0 !== gen) return gone;
  }
  if (my0 !== gen) return gone;
  if (!ack.ok && ack.code && ack.code !== "closed") {
    if (ack.code === "space-changed" && room) spaceChanged(room);
    usePlay.setState((s) => ({ notes: { ...s.notes, [table]: { text: codeWords(ack.code), at: Date.now() } } }));
    if (ack.code === "session") c.renew();
  }
  return ack;
}

/** GET /rooms/{room}/tables once (cards outside a call). */
export async function fetchTables(roomId: string): Promise<TableItem[] | null> {
  const g = roomGame(roomId);
  if (!g.owner) return null;
  const c = await conn(g.owner);
  if (!c) return null;
  try {
    const j = parseTables(await loadContract(), await c.get(`/rooms/${encodeURIComponent(roomId)}/tables`));
    if (!j) return null;
    for (const x of j.tables) tableHome.set(x.table, { owner: g.owner, space: x.space, room: roomId });
    usePlay.setState((s) => ({ rooms: { ...s.rooms, [roomId]: j.tables } }));
    return j.tables;
  } catch {
    return null;
  }
}

/** A table's summary from its owner (what a result / summary card draws); null = gone or refused. */
export async function fetchSummary(owner: string, table: string): Promise<Summary | null> {
  const c = await conn(owner);
  if (!c) return null;
  try {
    return parseSummary(await loadContract(), await c.get(`/tables/${encodeURIComponent(table)}/summary`));
  } catch {
    return null;
  }
}

// ---- chat cards (§6.6) ------------------------------------------------------------------------------------------
const posted = new Set<string>();
/** "please post" requests that came before their table's context: replayed when it arrives */
const pendingPosts = new Map<string, { owner: string; kind: CardKind; round?: number }[]>();
function drainPosts(owner: string, table: string): void {
  const list = pendingPosts.get(table);
  if (!list) return;
  pendingPosts.delete(table);
  for (const p of list) if (p.owner === owner) void postCard(owner, p.kind, table, p.round);
}
/** The owner asked this app to post a card: a normal m.text whose body names no amounts + the dev.tinhat.game block. */
async function postCard(owner: string, kind: CardKind, table: string, round?: number): Promise<void> {
  const key = `${table}:${kind}:${round ?? 0}`;
  if (posted.has(key)) return;
  const home = tableHome.get(table);
  const ov = usePlay.getState().views[table];
  const room = home?.room || ov?.room;
  const space = ov?.space || home?.space;
  const c = peekClient();
  if (!c) return;
  if (!room || !space) {
    // no context yet: keep the request until the table's view or listing arrives (a few at most)
    const list = pendingPosts.get(table) ?? [];
    if (list.length < 6 && !list.some((p) => p.kind === kind && p.round === round)) list.push({ owner, kind, round });
    pendingPosts.set(table, list);
    return;
  }
  const g = roomGame(room);
  if (g.owner !== owner || g.space !== space) return;
  posted.add(key);
  const game: Game | undefined = ov?.view.game ?? usePlay.getState().rooms[room]?.find((t) => t.table === table)?.game;
  if (!game) {
    // never a guessed game: wait for the record (its view or listing replays this)
    posted.delete(key);
    const list = pendingPosts.get(table) ?? [];
    if (list.length < 6 && !list.some((p) => p.kind === kind && p.round === round)) list.push({ owner, kind, round });
    pendingPosts.set(table, list);
    return;
  }
  const me = c.getUser(c.getUserId() ?? "")?.displayName || (c.getUserId() ?? "").replace(/^@([^:]+):.*$/, "$1");
  const block: Record<string, unknown> = { v: 1, kind, game, server: owner, space, table };
  if (round !== undefined) block.round = round;
  try {
    await c.sendEvent(room, "m.room.message" as never, { msgtype: "m.text", body: cardBody(kind, game, me), "dev.tinhat.game": block } as never);
  } catch (e) {
    posted.delete(key);
    log.warn("couldn't post the game card", e);
  }
}

// ---- sign-out ------------------------------------------------------------------------------------------------------
onSessionEnding(() => {
  gen++;
  pendingJoin?.cancel();
  for (const c of conns.values()) c.stop();
  conns.clear();
  connPs.clear();
  for (const ws of askWaiters.values()) for (const w of ws) w(false);
  askWaiters.clear();
  featureAsks.clear();
  tableHome.clear();
  posted.clear();
  declined.clear();
  confirmAsked.clear();
  confirmRetries.clear();
  featureRetries.clear();
  pendingPosts.clear();
  usePlay.setState({ owners: {}, wallets: {}, rooms: {}, views: {}, dial: {}, notes: {}, ask: null, confirm: {}, openErr: {}, panel: null });
});

export { GAME_WORDS };

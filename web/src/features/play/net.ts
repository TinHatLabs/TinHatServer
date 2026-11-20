// net.ts — one play connection per Tin Hat server (GAMES-V1-SPEC.md §6.1–§6.3): OpenID → play session, the HTTP
// reads, and the one WebSocket (session in the first frame, never the URL; ping every 20 s; reconnect with backoff;
// subscriptions and open tables restored on every reconnect). No React here; store.ts owns the state.
import { check, type Contract } from "./contract";
import { MAX_FRAME, atFor, newOp, parseFrame, parseSession, type ServerFrame, type View } from "./wire";

export interface OpenIdToken {
  access_token: string;
  matrix_server_name: string;
  token_type: string;
  expires_in: number;
}

export interface ClientInfo {
  kind: "web" | "ios-app" | "android-app" | "mac-app";
  v: string;
  pad: boolean;
}

/** What a connection needs from the app (store.ts gives the real ones; tests and the mock give their own). */
export interface NetDeps {
  /** the server's play API base, e.g. "/api/play/v1" or "https://example.org/api/play/v1" */
  base: string;
  /** the frozen play contract (every frame and answer is checked against it) */
  contract: Contract;
  userId: string;
  client: ClientInfo;
  openId(): Promise<OpenIdToken>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  socket(url: string): SocketLike;
  now(): number;
}

export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  readonly readyState: number;
}

export interface Session {
  session: string;
  user: string;
  expires: number;
  /** rev 2: the spaces on this server where I have a wallet */
  wallets: string[];
  rigHidden: boolean;
}

export class PlayHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`play ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export type ConnStatus = "idle" | "signing-in" | "connecting" | "live" | "retrying" | "off" | "refused" | "closed";

export interface Ack {
  op: string;
  ok: boolean;
  code: string;
  dup: boolean;
}

const BACKOFF = [1000, 2000, 5000, 10_000, 30_000];
const PING_MS = 20_000;
const ACK_MS = 10_000;
const AUTH_MS = 15_000;
const HTTP_MS = 15_000;
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new PlayHttpError(0, "network")), ms)))]).finally(() => clearTimeout(t));
}
const SILENT_MS = 60_000;

/** The ws:// / wss:// URL of the socket for an http(s) or same-origin base. */
export function socketUrl(base: string, pageHref: string): string {
  const u = new URL(`${base.replace(/\/+$/, "")}/ws`, pageHref);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

export class PlayConnection {
  status: ConnStatus = "idle";
  session: Session | null = null;
  /** the last refusal (a code), "" while fine */
  error = "";
  private ws: SocketLike | null = null;
  private authed = false;
  private tries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecv = 0;
  private closed = false;
  private rooms = new Map<string, number>();
  private tables = new Map<string, number>();
  private acks = new Map<string, { resolve: (a: Ack) => void; timer: ReturnType<typeof setTimeout> }>();
  /** moves sent but not yet answered, by op: resent after a reconnect (the server answers a repeat with dup: true) */
  private unacked = new Map<string, string>();

  readonly deps: NetDeps;
  private readonly onFrame: (f: ServerFrame) => void;
  private readonly onStatus: (s: ConnStatus, error: string) => void;
  constructor(deps: NetDeps, onFrame: (f: ServerFrame) => void, onStatus: (s: ConnStatus, error: string) => void) {
    this.deps = deps;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
  }

  private setStatus(s: ConnStatus, error = this.error) {
    this.status = s;
    this.error = error;
    this.onStatus(s, error);
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------
  private async http(method: string, path: string, body?: unknown, withSession = true): Promise<unknown> {
    const h: Record<string, string> = {};
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (withSession) {
      const s = await this.ensureSession();
      h.Authorization = `Play ${s.session}`;
    }
    // a deadline covers the request AND reading its body (a stalled server never leaves the client "signing in")
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HTTP_MS);
    try {
      return await this.httpInner(method, path, h, body, withSession, ctl.signal);
    } finally {
      clearTimeout(t);
    }
  }
  private async httpInner(method: string, path: string, h: Record<string, string>, body: unknown, withSession: boolean, signal: AbortSignal): Promise<unknown> {
    const r = await this.deps.fetch(`${this.deps.base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", cache: "no-store", redirect: "error", signal });
    let j: unknown = null;
    try {
      j = await r.json();
    } catch {
      // an answer we couldn't read (a stalled body cut by the deadline, or not JSON) is a network failure, never a
      // success with no body (a 204 has none by design)
      if (r.ok && r.status !== 204) throw new PlayHttpError(0, "network");
      j = null;
    }
    if (!r.ok) {
      const code = j && typeof j === "object" && typeof (j as { code?: unknown }).code === "string" ? (j as { code: string }).code : `http-${r.status}`;
      if (r.status === 401 && withSession) this.session = null;
      throw new PlayHttpError(r.status, code);
    }
    return j;
  }
  get(path: string): Promise<unknown> {
    return this.http("GET", path);
  }
  post(path: string, body?: unknown): Promise<unknown> {
    return this.http("POST", path, body ?? {});
  }
  del(path: string): Promise<unknown> {
    return this.http("DELETE", path);
  }

  private sessionP: Promise<Session> | null = null;
  /** The play session (OpenID exchange when there is none or it is within 5 min of its end). */
  ensureSession(): Promise<Session> {
    const s = this.session;
    if (s && s.expires - this.deps.now() > 5 * 60_000) return Promise.resolve(s);
    if (this.sessionP) return this.sessionP;
    this.sessionP = (async () => {
      try {
        const openid = await deadline(this.deps.openId(), HTTP_MS);
        const j = parseSession(this.deps.contract, await this.http("POST", "/session", { openid, user_id: this.deps.userId, client: this.deps.client }, false));
        if (!j || j.user !== this.deps.userId) throw new PlayHttpError(502, "bad");
        const next: Session = { session: j.session, user: j.user, expires: j.expires, wallets: [...j.wallets], rigHidden: j.rig_hidden };
        this.session = next;
        return next;
      } finally {
        this.sessionP = null;
      }
    })();
    return this.sessionP;
  }

  // ---- the socket ----------------------------------------------------------------------------------------------
  /** Start (or keep) the live connection. */
  start(): void {
    this.closed = false;
    if (this.ws || this.retryTimer || this.status === "signing-in" || this.status === "connecting") return;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.setStatus("signing-in", "");
    let s: Session;
    try {
      s = await this.ensureSession();
    } catch (e) {
      if (this.closed) return;
      const code = e instanceof PlayHttpError ? e.code : "network";
      if (code === "off" || code === "guest" || code === "remote-refused") return this.setStatus(code === "off" ? "off" : "refused", code);
      return this.retry(code);
    }
    if (this.closed) return;
    this.setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = this.deps.socket(socketUrl(this.deps.base, typeof location !== "undefined" ? location.href : "http://localhost/"));
    } catch {
      return this.retry("network");
    }
    this.ws = ws;
    this.authed = false;
    this.lastRecv = this.deps.now();
    // no hello within 15 s, or 60 s without any frame (pings are answered by pongs): drop it and reconnect
    if (this.watchTimer) clearInterval(this.watchTimer);
    const opened = this.deps.now();
    this.watchTimer = setInterval(() => {
      if (this.ws !== ws) return;
      const now = this.deps.now();
      if ((!this.authed && now - opened > AUTH_MS) || now - this.lastRecv > SILENT_MS) {
        this.drop();
        if (!this.closed) this.retry("closed");
      }
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "auth", session: s.session, client: { kind: this.deps.client.kind, pad: this.deps.client.pad } }));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      this.lastRecv = this.deps.now();
      const f = parseFrame(this.deps.contract, ev.data);
      if (!f) return;
      if (f.t === "hello") {
        if (this.session) {
          this.session.wallets = [...f.wallets];
          this.session.rigHidden = f.rig_hidden;
        }
        this.authed = true;
        this.tries = 0;
        this.setStatus("live", "");
        for (const room of this.rooms.keys()) this.raw({ t: "sub", room });
        for (const table of this.tables.keys()) this.raw({ t: "open", table });
        for (const q of this.unacked.values()) ws.send(q);
        this.pingTimer = setInterval(() => this.raw({ t: "ping" }), PING_MS);
      } else if (f.t === "ack") {
        // an answered op is never resent, whether or not the UI is still waiting for it
        this.unacked.delete(f.op);
        const w = this.acks.get(f.op);
        if (w) {
          clearTimeout(w.timer);
          this.acks.delete(f.op);
          w.resolve({ op: f.op, ok: f.ok, code: f.code ?? "", dup: f.dup === true });
        }
      } else if (f.t === "bye") {
        if (f.code === "session") {
          this.renew();
          return;
        }
        if (f.code === "off") {
          this.closed = true;
          this.drop();
          this.setStatus("off", "off");
          return;
        }
      }
      this.onFrame(f);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.drop();
      if (!this.closed) this.retry("closed");
    };
    ws.onerror = () => {};
  }

  private drop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onopen = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private retry(code: string) {
    this.setStatus("retrying", code);
    const d = BACKOFF[Math.min(this.tries, BACKOFF.length - 1)]!;
    this.tries++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, d);
  }

  /** The server refused the session: sign in again and replace the socket (subscriptions and tables are restored). */
  renew(): void {
    this.session = null;
    this.drop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.closed) void this.connect();
  }

  /** Stop for good (sign-out, games off). */
  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
    for (const [, w] of this.acks) {
      clearTimeout(w.timer);
      w.resolve({ op: "", ok: false, code: "closed", dup: false });
    }
    this.acks.clear();
    this.unacked.clear();
    this.setStatus("closed", "");
  }

  private raw(frame: Record<string, unknown>): void {
    // every frame this app sends must be exactly the contract's (it is the producer): a wrong one is a bug, never sent
    if (!check(this.deps.contract, "clientFrame", frame, true)) {
      console.warn(`play: refusing to send a frame outside the contract (${String(frame.t)}${frame.a ? ` ${String((frame.a as { do?: unknown }).do)}` : ""})`);
      return;
    }
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).length > MAX_FRAME) return;
    if (frame.t === "act" && frame.a && (frame.a as { do?: unknown }).do !== "dial") this.unacked.set(String(frame.op), text);
    if (this.ws && this.authed) this.ws.send(text);
  }

  /** Keep this room's table list coming (refcounted). Returns the release. */
  sub(room: string): () => void {
    const n = this.rooms.get(room) ?? 0;
    this.rooms.set(room, n + 1);
    if (n === 0) this.raw({ t: "sub", room });
    return () => {
      const m = (this.rooms.get(room) ?? 1) - 1;
      if (m <= 0) {
        this.rooms.delete(room);
        this.raw({ t: "unsub", room });
      } else this.rooms.set(room, m);
    };
  }

  /** Keep this table's view coming (refcounted). Returns the release. */
  open(table: string): () => void {
    const n = this.tables.get(table) ?? 0;
    this.tables.set(table, n + 1);
    if (n === 0) this.raw({ t: "open", table });
    return () => {
      const m = (this.tables.get(table) ?? 1) - 1;
      if (m <= 0) {
        this.tables.delete(table);
        this.raw({ t: "close", table });
      } else this.tables.set(table, m);
    };
  }

  /** Ask for a table's view again (after the server refused an `open`, e.g. a call membership it hadn't seen yet). */
  reopen(table: string): void {
    if (this.tables.has(table)) this.raw({ t: "open", table });
  }

  /** A move. `view` = the view the press was made on (its turn goes in `at`). Resolves with the server's ack
   *  (`closed` / `timeout` when none came). `dial` gets no ack: it resolves at once. */
  act(table: string, view: View | null, a: Record<string, unknown>): Promise<Ack> {
    const op = newOp();
    const frame: Record<string, unknown> = { t: "act", table, op, a };
    const at = view ? atFor(view, String(a.do)) : undefined;
    if (at) frame.at = at;
    if (a.do === "dial") {
      this.raw(frame);
      return Promise.resolve({ op, ok: true, code: "", dup: false });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // the UI stops waiting; the op stays queued and is resent after a reconnect (a repeat is answered dup: true)
        this.acks.delete(op);
        resolve({ op, ok: false, code: "timeout", dup: false });
      }, ACK_MS);
      this.acks.set(op, { resolve, timer });
      this.raw(frame);
    });
  }
}

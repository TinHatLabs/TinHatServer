// session.ts — sign-in, registration, password reset, restore and sign-out (FOUNDATION contract).
//
// Port of the native LoginController (bridge.rs login / create_account / restore / logout /
// request_password_reset / complete_password_reset, invites.rs normalize_invite_code). Every
// thrown Error carries a sentence that can be shown as-is (same wording as the native app).
//
// CONTRACT (FOUNDATION-CORE ↔ FOUNDATION-UI):
//   type SessionState = "booting" | "loggedOut" | "starting" | "syncing" | "ready" | "error"
//   interface SessionInfo { state; userId?; deviceId?; hsUrl?; error?; firstSyncDone }
//   useSession() / getSession() / restoreSession() / loginWithPassword() /
//   checkRegistrationToken() / registerAccount() / requestPasswordReset() /
//   completePasswordReset() / logout() / DEFAULT_HOMESERVER
//
// ADDITIVE beyond the contract (the native LoginView needs them):
//   SessionInfo.status        native `status` line for the sign-in card: "Signed out",
//                             "Your saved session couldn't be restored — please sign in again.",
//                             "You were signed out: this session expired or was ended from
//                             another device. Sign in again." (LoginView dims lines matching
//                             /^(signed out|you were signed out|your saved session)/i)
//   SessionInfo.syncDown      native `sync_down`: /sync failed 3× in a row → "can't reach the
//                             server" banner; clears on the next good sync
//   SessionInfo.syncState     raw js-sdk SyncState (PREPARED/SYNCING/ERROR/RECONNECTING/CATCHUP)
//   SessionInfo.liveSyncDone  first sync from the NETWORK is done (firstSyncDone may come from
//                             the IndexedDB cache on warm starts — that is the fast path)
//   SessionInfo.otherTab      state "error" because another tab owns the session → takeOverSession()
//   SessionInfo.storeKind     "worker" | "local" | "memory" (sync store in use — diagnostics)
//   registerAccount({…, displayName?, onCreated?})  displayName is set on the new account
//                             (native create_account); onCreated fires between "account created"
//                             and the automatic sign-in (native registerStage "created" — show
//                             "Account created — signing you in…")
//   requestPasswordReset → also returns `message` (native "Check <email> and click the link…")
//   normalizeInviteCode(typed)  the "TH-XXXX-XXXX" normaliser (bridge.rs normalize_invite_code)
//   validateRegistration({username,password,token}) → first problem sentence or null
//   resolveHomeserver(input)  always this page's own origin (the server that served the app)
//   takeOverSession()         steal the session from another tab (that tab signs itself off)
//   logout({ server?, status? })  server=true (default) also ends the device on the server (the
//                             native app only deletes local state — see FOUNDATION-NOTES.md)
//   getAccessToken()          bearer for same-origin /api calls (api.ts uses it)
import { create } from "zustand";
import { SyncState, createClient, type SyncStateData } from "matrix-js-sdk";
import {
  acquireTabLock,
  createAndStartClient,
  holdsTabLock,
  DEVICE_DISPLAY_NAME,
  peekClient,
  releaseTabLock,
  runSessionEnding,
  stopClient,
  wipeLocalStores,
  type Credentials,
} from "./client";
import { friendlyLoginError, matrixErrorMessage, UserFacingError } from "./errors";
import { installMatrixResume } from "./resume";
import { MATRIX_ORIGIN, SERVER_LABEL, bearerAllowed, homeserverAllowed } from "@/core/bearer";
import { bus } from "@/core/bus";
import { createLogger } from "@/core/log";

const log = createLogger("session");

// Back from an iOS app switch / frozen tab / sleep: restart a dead sync, re-kick the key queue (resume.ts).
installMatrixResume();

export type SessionState = "booting" | "loggedOut" | "starting" | "syncing" | "ready" | "error";

export interface SessionInfo {
  state: SessionState;
  userId?: string;
  deviceId?: string;
  hsUrl?: string;
  error?: string;
  firstSyncDone: boolean;
  // ---- additive (see header) ----
  status?: string;
  syncDown: boolean;
  syncState?: string;
  liveSyncDone: boolean;
  otherTab?: boolean;
  storeKind?: "worker" | "local" | "memory";
}

/** The homeserver: the Tin Hat Server's own origin, which serves this page (bearer.ts). */
export const DEFAULT_HOMESERVER = MATRIX_ORIGIN;

/** localStorage key of the saved session (hsUrl/userId/deviceId/accessToken[/refreshToken]). */
export const SESSION_KEY = "tinhat.session";

const initial: SessionInfo = { state: "booting", firstSyncDone: false, syncDown: false, liveSyncDone: false };

/** The zustand store behind useSession (use a selector for fine-grained re-renders). */
export const useSessionStore = create<SessionInfo>()(() => initial);

/** React: the whole session info (re-renders on any session change — they are rare). */
export function useSession(): SessionInfo {
  return useSessionStore();
}

export function getSession(): SessionInfo {
  return useSessionStore.getState();
}

function set(p: Partial<SessionInfo>) {
  useSessionStore.setState(p);
}

// ---- persistence -----------------------------------------------------------------------------

function readSaved(): Credentials | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Credentials>;
    if (!v.hsUrl || !v.userId || !v.deviceId || !v.accessToken) return null;
    return v as Credentials;
  } catch {
    return null;
  }
}

/**
 * This page's own origin is the homeserver (core/bearer.ts). A saved session under another address (a server whose
 * web app lives at another name than its server name, as chat.example.com for example.com; an older build that
 * stored another address) moves to this origin only when its account belongs to the server this origin
 * serves now (its server name, asked without credentials at /_matrix/key/v2/server). Anything else stays as it was and
 * is refused below: an origin that once served another server never receives that server's token.
 */
async function adoptSavedOrigin(c: Credentials): Promise<void> {
  if (c.hsUrl === MATRIX_ORIGIN) return;
  try {
    const r = await fetch(`${MATRIX_ORIGIN}/_matrix/key/v2/server`, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(8000) });
    const name = r.ok ? String(((await r.json()) as { server_name?: unknown }).server_name ?? "") : "";
    if (name && c.userId.endsWith(`:${name}`)) {
      log.info(`saved session moves from ${c.hsUrl} to ${MATRIX_ORIGIN} (the same server, ${name})`);
      c.hsUrl = MATRIX_ORIGIN;
      writeSaved(c);
    }
  } catch (e) {
    log.warn("couldn't ask this server's name; the saved session keeps its address", e);
  }
}

function writeSaved(c: Credentials) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(c));
}

function clearSaved() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * localStorage keys that belong to the signed-in ACCOUNT (not the device) and are removed on
 * sign-out with the session. Device prefs (`tinhat.pref.*`: theme, sounds, layout …) stay, like
 * the desktop's prefs in its config dir survive a sign-out.
 */
const ACCOUNT_KEY_PREFIXES = ["tinhat.session", "tinhat.blob.", "tinhat.user.", "tinhat.cache."];
const ACCOUNT_PREF_KEYS = ["tinhat.pref.last-room", "tinhat.pref.soundboard-recent"];

function clearAccountKeys() {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("tinhat.")) continue;
    if (ACCOUNT_KEY_PREFIXES.some((p) => k.startsWith(p)) || ACCOUNT_PREF_KEYS.includes(k)) doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
}

/** Best effort: end a session we are about to forget on the server, so no dead device lingers. */
async function serverLogout(c: Credentials): Promise<void> {
  if (!homeserverAllowed(c.hsUrl)) return; // never hand a token to a homeserver we don't allow
  try {
    await fetch(`${c.hsUrl}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.accessToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* offline / already gone */
  }
}

/** A lazily-loaded chunk (e.g. the Rust crypto module) failed to load — a deploy or a blip, not a bad session. */
function isChunkLoadError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError|Failed to fetch dynamically/i.test(m);
}

/** The current access token (for same-origin /api calls), or undefined when signed out. */
export function getAccessToken(): string | undefined {
  return peekClient()?.getAccessToken() ?? readSaved()?.accessToken ?? undefined;
}

// ---- homeserver resolution -------------------------------------------------------------------

/**
 * bridge.rs resolve_homeserver, for the web: the server that served this page is the homeserver, reached through
 * this page's own origin — even when its well-known names its server name (example.com) and the web app lives at
 * another name (chat.example.com). What was typed in the Server field doesn't change it.
 */
export async function resolveHomeserver(_input: string): Promise<string> {
  return MATRIX_ORIGIN;
}

// ---- lifecycle -------------------------------------------------------------------------------

let inflight: Promise<unknown> | null = null;
let starting: Promise<void> | null = null;
let loggingOut: Promise<void> | null = null;
let firstPrepared = false;

function markReadyDom(on: boolean) {
  if (typeof document === "undefined") return;
  const d = document.documentElement.dataset;
  if (on) {
    d.twReady = "1";
    d.twReadyMs = String(Math.round(performance.now())); // ms since page start (perf checks)
  } else {
    delete d.twReady;
    delete d.twReadyMs;
  }
}

// widgets W2 ("Is it just me?", WIDGETS.md §20): when the last sync answered from the network, and when this session's
// sync began (the age counts from there until the first one) — read by syncAgeMs().
let lastSyncOkAt = 0;
let syncWatchFrom = 0;

/** ms since the last successful sync from the network (since the sync began, before the first); null = no session. */
export function syncAgeMs(now: number = Date.now()): number | null {
  if (!syncWatchFrom) return null;
  return Math.max(0, now - Math.max(lastSyncOkAt, syncWatchFrom));
}

function onSyncState(state: SyncState, _prev: SyncState | null, data?: SyncStateData) {
  if ((state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup) && !data?.fromCache) lastSyncOkAt = Date.now();
  const s = getSession();
  const patch: Partial<SessionInfo> = { syncState: state };
  if (state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup) {
    if (s.syncDown) patch.syncDown = false;
  }
  if (state === SyncState.Error) patch.syncDown = true;
  if ((state === SyncState.Prepared || state === SyncState.Syncing) && !data?.fromCache && !s.liveSyncDone) {
    patch.liveSyncDone = true;
    if (typeof document !== "undefined") document.documentElement.dataset.twLive = "1";
  }
  if (state === SyncState.Prepared && !firstPrepared) {
    firstPrepared = true;
    patch.state = "ready";
    patch.firstSyncDone = true;
    patch.status = undefined;
    set(patch);
    markReadyDom(true);
    log.info(`first sync done (${data?.fromCache ? "from cache" : "network"}) at ${Math.round(performance.now())} ms`);
    const { userId, deviceId } = getSession();
    // registry.ts runs r.onReady off this event (core never imports the registry: no cycles).
    if (userId && deviceId) bus.emit("sessionReady", { userId, deviceId });
    return;
  }
  set(patch);
}

function onSessionLoggedOut() {
  if (loggingOut) return;
  log.warn("token rejected by the server — signing out");
  void runSessionEnding("token"); // calls stop their capture at once (the token can't withdraw anything)
  // The token is dead: nothing to tell the server, just drop local state. If the client is still
  // inside startClient() (the /versions call is often the first 401), wait for it to finish —
  // stopping it half-way leaves its sync loop and pollers running on a dead client.
  const go = () =>
    logout({
      server: false,
      status: "You were signed out: this session expired or was ended from another device. Sign in again.",
    });
  if (starting) void starting.catch(() => undefined).then(go);
  else void go();
}

function onTabLost() {
  // End our call (capture off, membership withdrawn) before this tab lets go of the session.
  void runSessionEnding("takeover", 3000)
    .then(() => stopClient({ wipe: false }))
    .then(() => {
      firstPrepared = false;
      markReadyDom(false);
      set({
        state: "error",
        error: "Tin Hat was opened in another tab. Use that tab, or take over here.",
        otherTab: true,
        firstSyncDone: false,
        liveSyncDone: false,
      });
    });
}

async function startFor(creds: Credentials): Promise<void> {
  firstPrepared = false;
  set({
    state: "starting",
    userId: creds.userId,
    deviceId: creds.deviceId,
    hsUrl: creds.hsUrl,
    error: undefined,
    otherTab: undefined,
    firstSyncDone: false,
    liveSyncDone: false,
    syncDown: false,
    syncState: undefined,
  });
  syncWatchFrom = Date.now();
  lastSyncOkAt = 0;
  const run = createAndStartClient(creds, { onSyncState, onSessionLoggedOut });
  starting = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    const { storeKind } = await run;
    // startClient resolved = the sync loop runs; PREPARED may already have flipped us to ready.
    if (getSession().state === "starting") set({ state: "syncing", storeKind });
    else set({ storeKind });
  } finally {
    starting = null;
  }
}

/**
 * Start the stored session, if there is one. true = a session was found and its client started
 * (the state moves on to syncing → ready); false = none / unusable (state loggedOut with a status
 * line) or another tab owns it (state error, otherTab).
 */
export async function restoreSession(): Promise<boolean> {
  if (inflight) {
    await inflight.catch(() => undefined);
    return peekClient() !== null;
  }
  if (peekClient()) return true;
  const saved = readSaved();
  if (!saved) {
    set({ state: "loggedOut" });
    return false;
  }
  const run = (async () => {
    await adoptSavedOrigin(saved);
    set({ state: "starting", userId: saved.userId, deviceId: saved.deviceId, hsUrl: saved.hsUrl });
    if (!(await acquireTabLock({ onLost: onTabLost }))) {
      set({ state: "error", error: "Tin Hat is already open in another tab. Use that tab, or take over here.", otherTab: true });
      return false;
    }
    try {
      await startFor(saved);
      log.info(`restored ${saved.userId} / ${saved.deviceId}`);
      return true;
    } catch (e) {
      log.error("restore failed", e);
      await stopClient({ wipe: false });
      releaseTabLock();
      if (isChunkLoadError(e)) {
        // Keep the session: this is the page's code failing to load, not the session.
        set({ state: "error", error: "Part of Tin Hat couldn't load — reload the page to try again." });
        return false;
      }
      // The saved session is unusable: end it on the server, forget it, sign in fresh.
      clearSaved();
      void serverLogout(saved);
      await wipeLocalStores();
      set({
        state: "loggedOut",
        status: "Your saved session couldn't be restored — please sign in again.",
        userId: undefined,
        deviceId: undefined,
      });
      return false;
    }
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    inflight = null;
  }
}

/** Steal the session from the tab that has it (that tab stops its client and shows why). */
export async function takeOverSession(): Promise<boolean> {
  const saved = readSaved();
  if (!saved) {
    set({ state: "loggedOut", otherTab: undefined, error: undefined });
    return false;
  }
  await acquireTabLock({ steal: true, onLost: onTabLost });
  // Give the other tab a moment to close its crypto store before we open it.
  await new Promise((r) => setTimeout(r, 600));
  try {
    await startFor(saved);
    return true;
  } catch (e) {
    set({ state: "error", error: friendlyLoginError(e) });
    return false;
  }
}

/**
 * Password sign-in (m.login.password, identifier m.id.user — exactly the native login_username).
 * A fresh sign-in is a NEW device: this browser's Tin Hat stores are wiped first (native
 * wipe_store) so a previous device's crypto can't collide. Resolves once the client is started.
 */
export async function loginWithPassword(o: { homeserver: string; username: string; password: string }): Promise<void> {
  if (inflight) throw new UserFacingError("Already signing in…");
  const username = o.username.trim();
  if (!username || !o.password) throw new UserFacingError("Enter your username and password.");
  const run = (async () => {
    let hsUrl: string;
    try {
      hsUrl = await resolveHomeserver(o.homeserver);
    } catch (e) {
      throw new UserFacingError(friendlyLoginError(e));
    }
    // The password goes to our homeserver only (Astra calls finding 12).
    if (!homeserverAllowed(hsUrl)) throw new UserFacingError(`Tin Hat signs in to ${SERVER_LABEL} only (${hsUrl} isn't allowed).`);
    if (!(await acquireTabLock({ onLost: onTabLost }))) {
      throw new UserFacingError("Tin Hat is already open in another tab — sign in there, or close it first.");
    }
    let creds: Credentials;
    try {
      const tmp = createClient({ baseUrl: hsUrl });
      const res = await tmp.loginRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password: o.password,
        initial_device_display_name: DEVICE_DISPLAY_NAME,
      });
      const wk = (res as { well_known?: { "m.homeserver"?: { base_url?: string } } }).well_known;
      const wkRaw = wk?.["m.homeserver"]?.base_url?.replace(/\/+$/, "");
      const wkBase = wkRaw && homeserverAllowed(wkRaw) ? wkRaw : undefined; // a login answer can't redirect the token
      creds = {
        hsUrl: wkBase || hsUrl,
        userId: res.user_id,
        deviceId: res.device_id,
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? undefined,
      };
    } catch (e) {
      releaseTabLock();
      throw new UserFacingError(friendlyLoginError(e));
    }
    // Fresh login = new device; start from clean stores.
    await stopClient({ wipe: false });
    await wipeLocalStores();
    writeSaved(creds);
    try {
      await startFor(creds);
      log.info(`signed in ${creds.userId} / ${creds.deviceId}`);
    } catch (e) {
      log.error("start after login failed", e);
      await stopClient({ wipe: true });
      clearSaved();
      void serverLogout(creds);
      releaseTabLock();
      set({ state: "loggedOut", userId: undefined, deviceId: undefined });
      throw new UserFacingError(`Signed in, but encryption couldn't start: ${(e as Error)?.message ?? e}`);
    }
  })();
  inflight = run;
  try {
    await run;
  } finally {
    inflight = null;
  }
}

/**
 * Sign out. server (default true) = also end this device on the homeserver (POST /logout);
 * then stop the client, delete this device's crypto + sync databases and the account's
 * `tinhat.*` keys (device prefs stay). `status` = the line the sign-in card shows.
 */
export async function logout(opts: { server?: boolean; status?: string } = {}): Promise<void> {
  if (loggingOut) return loggingOut;
  loggingOut = doLogout(opts).finally(() => {
    loggingOut = null;
  });
  return loggingOut;
}

async function doLogout(opts: { server?: boolean; status?: string }): Promise<void> {
  syncWatchFrom = 0; // widgets W2: no session, no sync age
  const c = peekClient();
  if (!c && getSession().otherTab && !holdsTabLock()) {
    // Another tab owns this session and its databases: wiping them from here would corrupt it.
    log.warn("logout ignored: another tab owns the session");
    return;
  }
  // The call ends while the token still works (membership withdrawn, media off) — Astra calls finding 6.
  await runSessionEnding(opts.server === false ? "token" : "logout");
  if (c && opts.server !== false) {
    try {
      await Promise.race([c.logout(true), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
    } catch (e) {
      log.warn("server logout failed (continuing locally)", e);
    }
  }
  await stopClient({ wipe: true });
  if (!c) await wipeLocalStores();
  clearAccountKeys();
  releaseTabLock();
  firstPrepared = false;
  markReadyDom(false);
  if (typeof document !== "undefined") delete document.documentElement.dataset.twLive;
  useSessionStore.setState(
    {
      state: "loggedOut",
      firstSyncDone: false,
      liveSyncDone: false,
      syncDown: false,
      status: opts.status ?? "Signed out",
    },
    true,
  );
  bus.emit("loggedOut", { status: opts.status });
}

// ---- registration (invite codes) -------------------------------------------------------------

/**
 * bridge.rs normalize_invite_code: people type the 8 characters after the fixed "TH-", any case,
 * with or without hyphens; pasted full codes and older long tokens pass through.
 */
export function normalizeInviteCode(typed: string): string {
  const t = (typed || "").trim();
  const plain = /^[A-Za-z0-9-]*$/.test(t);
  const bare = t.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (plain && bare.length === 10 && bare.startsWith("TH")) return `TH-${bare.slice(2, 6)}-${bare.slice(6, 10)}`;
  if (plain && bare.length === 8) return `TH-${bare.slice(0, 4)}-${bare.slice(4)}`;
  return t;
}

/** The first thing wrong with a sign-up form (native wording), or null when it can be sent. */
export function validateRegistration(o: { username: string; password: string; token: string }): string | null {
  const username = o.username.trim().toLowerCase();
  if (!username || username.length > 64 || !/^[a-z0-9._=\-/+]+$/.test(username)) {
    return "Usernames are lowercase letters, numbers, dots, dashes and underscores.";
  }
  if ([...o.password].length < 8) return "Use a password of at least 8 characters.";
  if (!normalizeInviteCode(o.token)) return "Enter the invite code you were given.";
  return null;
}

async function http(url: string, init: RequestInit, server: string, timeoutMs = 20000): Promise<{ status: number; json: Record<string, unknown> }> {
  // Registration / reset carry passwords and tokens: our homeserver only (Astra calls finding 12).
  if (!bearerAllowed(url) || !url.startsWith(`${MATRIX_ORIGIN}/`)) throw new UserFacingError(`Tin Hat talks to ${SERVER_LABEL} only (${server} isn't allowed).`);
  let r: Response;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new UserFacingError("The server didn't answer in time.");
    throw new UserFacingError(`Couldn't reach ${server}: ${(e as Error)?.message ?? e}`);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await r.json()) as Record<string, unknown>;
  } catch {
    /* empty / not JSON */
  }
  return { status: r.status, json };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Is this invite code (a Synapse registration token) usable right now? Throws when the server
 * refuses sign-ups entirely or can't be reached.
 */
export async function checkRegistrationToken(homeserver: string, token: string): Promise<boolean> {
  const base = await resolveHomeserver(homeserver);
  const code = normalizeInviteCode(token);
  if (!code) return false;
  const { status, json } = await http(
    `${base}/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent(code)}`,
    { method: "GET" },
    homeserver,
  );
  if (status === 403) throw new UserFacingError("This server isn't taking new accounts right now.");
  if (status === 200) return json.valid === true;
  throw new UserFacingError(matrixErrorMessage(json) ?? `The server said ${status}.`);
}

const USERNAME_ERRORS: Record<string, string> = {
  M_USER_IN_USE: "That username is taken — try another.",
  M_INVALID_USERNAME: "That username isn't allowed — use lowercase letters, numbers, dots, dashes and underscores.",
  M_EXCLUSIVE: "That username is reserved on this server.",
};

/**
 * Create an account with an invite code (bridge.rs do_register: validity → availability → UIA
 * m.login.registration_token [+ m.login.dummy]), set the display name with the one-shot token,
 * log that token out, then sign in through loginWithPassword so the session is built exactly
 * like a password sign-in. `onCreated(userId)` fires between the two.
 */
export async function registerAccount(o: {
  homeserver: string;
  username: string;
  password: string;
  token: string;
  displayName?: string;
  onCreated?: (userId: string) => void;
}): Promise<void> {
  const problem = validateRegistration(o);
  if (problem) throw new UserFacingError(problem);
  const username = o.username.trim().toLowerCase();
  const code = normalizeInviteCode(o.token);
  const displayName = (o.displayName ?? "").trim();
  const server = (o.homeserver || DEFAULT_HOMESERVER).trim();
  const base = await resolveHomeserver(server);

  // 1. The code — a clear sentence before anything else is typed for nothing.
  const v = await http(
    `${base}/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent(code)}`,
    { method: "GET" },
    server,
  );
  if (v.status === 200 && v.json.valid !== true) {
    throw new UserFacingError(
      "That invite code isn't valid — it may have expired or been used up. Ask whoever invited you for a new one.",
    );
  }
  if (v.status === 403) throw new UserFacingError("This server isn't taking new accounts right now.");

  // 2. The username.
  const a = await http(`${base}/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`, { method: "GET" }, server);
  if (a.status === 400) {
    const ec = str(a.json.errcode);
    throw new UserFacingError(USERNAME_ERRORS[ec] ?? (str(a.json.error) || "The server refused that username."));
  }

  // 3. The UIA dance: token stage, then whatever else the flow wants (dummy).
  let auth: Record<string, unknown> | undefined;
  let session: string | undefined;
  let userId = "";
  let created = false;
  for (let i = 0; i < 4 && !created; i++) {
    const body: Record<string, unknown> = {
      username,
      password: o.password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
      inhibit_login: false,
    };
    if (auth) body.auth = auth;
    const r = await http(`${base}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, server);
    if (r.status === 200) {
      userId = str(r.json.user_id);
      const token = str(r.json.access_token);
      if (token) {
        if (displayName && userId) {
          await http(`${base}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ displayname: displayName }),
          }, server).catch(() => undefined);
        }
        await http(`${base}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, server).catch(
          () => undefined,
        );
      }
      created = true;
      break;
    }
    const errcode = str(r.json.errcode);
    const msg = str(r.json.error);
    if (r.status === 401 && !errcode) {
      const sess = str(r.json.session) || session;
      if (!sess) throw new UserFacingError("The server started a sign-up flow Tin Hat doesn't understand.");
      session = sess;
      const completed = Array.isArray(r.json.completed) ? (r.json.completed as unknown[]).map(String) : [];
      const flows = Array.isArray(r.json.flows) ? (r.json.flows as Array<{ stages?: unknown[] }>) : [];
      let next: string | undefined;
      for (const f of flows) {
        const stages = (f.stages ?? []).map(String);
        if (stages.every((s) => s === "m.login.registration_token" || s === "m.login.dummy")) {
          next = stages.find((s) => !completed.includes(s));
          if (next) break;
        }
      }
      if (!next) {
        throw new UserFacingError(
          "This server wants an email check or a CAPTCHA to sign up, which Tin Hat can't do yet — create the account on the website, then sign in here.",
        );
      }
      auth =
        next === "m.login.registration_token"
          ? { type: next, token: code, session: sess }
          : { type: "m.login.dummy", session: sess };
      continue;
    }
    switch (errcode) {
      case "M_USER_IN_USE":
      case "M_INVALID_USERNAME":
        throw new UserFacingError(USERNAME_ERRORS[errcode]!, errcode);
      case "M_WEAK_PASSWORD":
      case "M_PASSWORD_TOO_SHORT":
      case "M_PASSWORD_NO_DIGIT":
      case "M_PASSWORD_NO_SYMBOL":
      case "M_PASSWORD_NO_UPPERCASE":
      case "M_PASSWORD_NO_LOWERCASE":
      case "M_PASSWORD_IN_DICTIONARY":
        throw new UserFacingError(msg ? `Pick a stronger password: ${msg}` : "Pick a stronger password.", errcode);
      case "M_UNAUTHORIZED":
        throw new UserFacingError("That invite code was refused — it may have just been used up.", errcode);
      case "M_FORBIDDEN":
        throw new UserFacingError("This server isn't taking new accounts right now.", errcode);
      case "M_LIMIT_EXCEEDED":
        throw new UserFacingError("Too many tries — wait a minute and try again.", errcode);
      default:
        throw new UserFacingError(msg || `The server said ${r.status}.`, errcode);
    }
  }
  if (!created) throw new UserFacingError("The sign-up didn't finish — try again.");
  log.info(`registered ${userId}`);
  o.onCreated?.(userId);
  await loginWithPassword({ homeserver: server, username, password: o.password });
}

// ---- password reset (unauthenticated, email) -------------------------------------------------

/**
 * Step 1 of "Forgot your password?": mail a reset link. Returns the sid + client secret to pass
 * to completePasswordReset, plus the native status sentence.
 */
export async function requestPasswordReset(o: {
  homeserver: string;
  email: string;
}): Promise<{ sid: string; clientSecret: string; message: string }> {
  const email = o.email.trim();
  if (!email.includes("@")) throw new UserFacingError("Enter the email address on your account.");
  const server = (o.homeserver || DEFAULT_HOMESERVER).trim();
  const base = await resolveHomeserver(server);
  // A fresh secret per attempt; reusing one would let the server tie this request to a previous address.
  const clientSecret = `tinhat${crypto.randomUUID().replace(/-/g, "")}`;
  const r = await http(`${base}/_matrix/client/v3/account/password/email/requestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_secret: clientSecret, email, send_attempt: 1 }),
  }, server).catch((e: unknown) => {
    throw new UserFacingError(`Could not reach the server: ${(e as Error)?.message ?? e}`);
  });
  if (r.status < 200 || r.status >= 300) {
    throw new UserFacingError(matrixErrorMessage(r.json) ?? `The server refused the request (${r.status}).`);
  }
  const sid = str(r.json.sid);
  if (!sid) throw new UserFacingError("The server didn't return a session id.");
  return { sid, clientSecret, message: `Check ${email} and click the link, then set a new password below.` };
}

/**
 * Step 3: set the new password (auth m.login.email.identity, logout_devices: true). The first
 * attempt may come back 401 with a UIA session — that is expected; retry with it.
 */
export async function completePasswordReset(o: {
  homeserver: string;
  sid: string;
  clientSecret: string;
  newPassword: string;
}): Promise<void> {
  if (!o.sid || !o.clientSecret) throw new UserFacingError("Ask for a reset email first.");
  if (o.newPassword.length < 8) throw new UserFacingError("Use at least 8 characters.");
  const server = (o.homeserver || DEFAULT_HOMESERVER).trim();
  const base = await resolveHomeserver(server);
  const url = `${base}/_matrix/client/v3/account/password`;
  const body = (session?: string) =>
    JSON.stringify({
      new_password: o.newPassword,
      logout_devices: true,
      auth: {
        type: "m.login.email.identity",
        threepid_creds: { sid: o.sid, client_secret: o.clientSecret },
        ...(session ? { session } : {}),
      },
    });
  const post = (b: string) =>
    http(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: b }, server).catch((e: unknown) => {
      throw new UserFacingError(`Could not reach the server: ${(e as Error)?.message ?? e}`);
    });
  const first = await post(body());
  if (first.status >= 200 && first.status < 300) return;
  const session = str(first.json.session);
  if (!session) {
    throw new UserFacingError(matrixErrorMessage(first.json) ?? `The server wouldn't change the password (${first.status}).`);
  }
  const second = await post(body(session));
  if (second.status >= 200 && second.status < 300) return;
  throw new UserFacingError(
    matrixErrorMessage(second.json) ?? "Couldn't confirm the reset — click the link in the email first, then try again.",
  );
}

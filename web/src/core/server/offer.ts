// offer.ts — what a Tin Hat Server offers (selfhost/firstrun item 1; docs/SELFHOST.md). SHARED LOGIC: the desktop
// implements the same rules and replays the cases of offer.test.ts. Pure: no React, no app imports — the unit test runs it in plain Node.
//
// Discovery: GET <homeserver>/.well-known/matrix/client carries
//   "dev.tinhat.server": {"server": "0.2.21", "api": "https://<server>/api",
//                        "features": {"calls": true, "soundboard": true, "gifs": false, "watch": true, "games": true,
//                                     "steam": false, "gameservers": false, "presence": true, "push": true,
//                                     "memories": true, "reports": true},
//                        "recorder": "@recorder:<server>",      ← only with memories on
//                        "account": {"password_reset": "owner"}} ← Tin Hat Server ≥ 0.3.0: it sends no email, so a
//                                                                   forgotten password is the owner's to reset
//                                                                   (dashboard → People); the sign-in screen says so
// A feature is OFF only when the server says `false`. No document, no key, no `features`, or a value that is not a
// boolean keeps today's behaviour (on). The recorder is the Memories recorder's account: the apps leave it out of
// tiles, participant lists and call history, and invite it when recording starts; without one NOTHING is treated as a
// recorder.
//
// Off means hidden, never dimmed: the actions a feature carries get the contract's `requires` rule (ACTIONS.md §4:
// false ⇒ hidden in every row, menu, the Ctrl+K palette and the run path) through the global predicate
// `server.<feature>`; the settings rows it carries leave the Settings search; everything else (buttons, windows,
// widgets, the tour's words) asks serverFeatureOn() / useServerFeature() (core/server/store.ts).

export const DISCOVERY_KEY = "dev.tinhat.server";

export type ServerFeature = "calls" | "soundboard" | "gifs" | "watch" | "games" | "steam" | "gameservers" | "presence" | "push" | "memories" | "reports" | "guests";
export const SERVER_FEATURES: readonly ServerFeature[] = ["calls", "soundboard", "gifs", "watch", "games", "steam", "gameservers", "presence", "push", "memories", "reports", "guests"];

/** What each feature covers in the apps (docs/SELFHOST.md has the full gate list). */
export const FEATURE_DOC: Readonly<Record<ServerFeature, string>> = {
  calls: "calls (a call service on the server)",
  soundboard: "the soundboard (and the join sounds it hosts)",
  gifs: "the GIF picker",
  watch: "YouTube search and browsing in Media Party (pasted links always work)",
  games: "the Game Reel's games catalogue (search, add by name, covers)",
  steam: "importing a Steam library into My games",
  gameservers: "the Game servers widget",
  presence: "Reach: online / away / in-a-call statuses, custom statuses, Who's around, Friends' clocks, Is it just me?",
  push: "push notifications on phones and closed browsers",
  memories: "Memories, the call recorder (and its recorder account)",
  reports: "Report a problem",
  guests: "the guest room (Settings → Guests, the Guests room's bar, the waiting-at-the-door notices — docs/GUESTS.md)",
};

export interface ServerOffer {
  /** the server's version ("0.2.21"); "" when it doesn't say */
  server: string;
  /** the Tin Hat API base it announces; "" when it doesn't say */
  api: string;
  /** only the features it announced as booleans */
  features: Partial<Record<ServerFeature, boolean>>;
  /** the Memories recorder's Matrix id; "" = this server has none */
  recorder: string;
  /** how a forgotten password comes back: "owner" = this server sends no email, its owner sets a new one; "" = the
   *  email form (no document, no key, any other value) */
  passwordReset: "owner" | "";
}

export const NO_OFFER: ServerOffer = Object.freeze({ server: "", api: "", features: Object.freeze({}), recorder: "", passwordReset: "" }) as ServerOffer;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const MXID = /^@[^:\s]+:[^\s]+$/;

/** The `dev.tinhat.server` part of a /.well-known/matrix/client answer (any JSON value; never throws). */
export function parseOffer(wellKnown: unknown): ServerOffer {
  if (!isObj(wellKnown)) return NO_OFFER;
  const t = own(wellKnown, DISCOVERY_KEY);
  if (!isObj(t)) return NO_OFFER;
  const server = own(t, "server");
  const api = own(t, "api");
  const f = own(t, "features");
  const features: Partial<Record<ServerFeature, boolean>> = {};
  if (isObj(f)) {
    for (const k of SERVER_FEATURES) {
      const v = own(f, k);
      if (typeof v === "boolean") features[k] = v;
    }
  }
  // the recorder only counts while Memories is on (the server sends it only then; a stray value is ignored)
  const r = own(t, "recorder");
  const recorder = typeof r === "string" && MXID.test(r) && features.memories !== false ? r : "";
  const acct = own(t, "account");
  const passwordReset = isObj(acct) && own(acct, "password_reset") === "owner" ? "owner" : "";
  return { server: typeof server === "string" ? server : "", api: typeof api === "string" ? api : "", features, recorder, passwordReset };
}

/** The offer back in the server's own shape (the `dev.tinhat.server` value): what the cache keeps, so parseOffer reads
 *  it back the same. */
export function offerDoc(o: ServerOffer): Record<string, unknown> {
  const doc: Record<string, unknown> = { server: o.server, api: o.api, features: { ...o.features } };
  if (o.recorder) doc.recorder = o.recorder;
  if (o.passwordReset) doc.account = { password_reset: o.passwordReset };
  return doc;
}

/** Is the feature on? Only an explicit `false` turns it off. */
export function featureOn(offer: ServerOffer, f: ServerFeature): boolean {
  return offer.features[f] !== false;
}

/** What a temporary guest account (`@guest-…`, docs/GUESTS.md) never gets, whatever the server offers: the server
 *  refuses its problem reports and shared logs (403). */
export const GUEST_WITHHELD: readonly ServerFeature[] = ["reports"];

/** Settings rows a guest account never sees, in the pane or the Settings search (a guest has no password to change). The
 *  desktop's GUEST_HIDDEN_SETTINGS is the same list. */
export const GUEST_HIDDEN_SETTINGS: readonly string[] = ["security.password"];

/** Is the feature on for this user? featureOn, minus GUEST_WITHHELD for a guest account. */
export function featureFor(offer: ServerOffer, f: ServerFeature, guest: boolean): boolean {
  return featureOn(offer, f) && !(guest && GUEST_WITHHELD.includes(f));
}

/** The same offer? (the store notifies only on a real change) */
export function sameOffer(a: ServerOffer, b: ServerOffer): boolean {
  if (a.server !== b.server || a.api !== b.api || a.recorder !== b.recorder || a.passwordReset !== b.passwordReset) return false;
  return SERVER_FEATURES.every((k) => a.features[k] === b.features[k]);
}

// ---- the actions a feature carries (actions.json ids; ACTIONS.md) -----------------------------------------------

/** id → feature. An entry ending in "." covers every id with that prefix. */
export const ACTION_GATES: ReadonlyArray<readonly [string, ServerFeature]> = [
  // Memories = the call recorder (Memories) and its library
  ["memories.", "memories"],
  ["room.recording.toggle", "memories"],
  ["call.clip", "memories"],
  ["call.share.recordingOnly.toggle", "memories"],
  ["call.recStream.tuneIn", "memories"],
  ["call.recStream.leave", "memories"],
  ["app.recordOptOut.toggle", "memories"],
  // the soundboard (and the join sounds it hosts)
  ["soundboard.", "soundboard"],
  ["sound.", "soundboard"],
  ["person.joinSound.play", "soundboard"],
  // the GIF picker
  ["composer.gif", "gifs"],
  // Reach: your status (status.open / set / clear), the one-time question, the sharing switch
  ["status.", "presence"],
  ["presence.", "presence"],
  // push notifications while Tin Hat is closed (push.enable / quiet.toggle / test)
  ["push.", "push"],
  // Report a problem, and sharing logs (the server's same reports / logs inbox)
  ["app.bugReport", "reports"],
  ["app.logship.toggle", "reports"],
];

/** The feature an action needs, or null. */
export function gateOfAction(id: string): ServerFeature | null {
  for (const [k, f] of ACTION_GATES) {
    if (k.endsWith(".") ? id.startsWith(k) : id === k) return f;
  }
  return null;
}

/** The global predicate that carries a feature into the actions engine's snapshot. */
export function featurePredicate(f: ServerFeature): string {
  return `server.${f}`;
}

// ---- actions the apps don't have at all (whatever the server offers) ----------------------------------------------

/** Retired in both apps: the per-room guest link → the guest room (docs/GUESTS.md). They stay in the shared actions
 *  table for now and are never offered. */
export const RETIRED_ACTIONS: readonly string[] = ["room.guestLink", "room.guestLink.disable"];
/** The global predicate that hides them: always false in the self-hosted UI's snapshot. */
export const RETIRED_PREDICATE = "selfhost.retired";

export function isRetiredAction(id: string): boolean {
  return RETIRED_ACTIONS.includes(id);
}

/** The predicate values for the actions snapshot (`values`): one per feature (for a guest account: featureFor) + the
 *  retired actions' (false). */
export function predicateValues(offer: ServerOffer, guest = false): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of SERVER_FEATURES) out[featurePredicate(f)] = featureFor(offer, f, guest);
  out[RETIRED_PREDICATE] = false;
  return out;
}

interface GateTable {
  actions: Array<{ id: string; requires?: unknown }>;
  predicates: Record<string, unknown>;
}

function predicateDoc(f: ServerFeature): string {
  return `The server offers ${FEATURE_DOC[f]} (a self-hosted Tin Hat Server's announcement; absent = yes).`;
}

/**
 * Lay the gates over a loaded actions table (a self-hosted build, once at start): every gated action gets
 * `requires` = its own rule AND `server.<feature>` (a requires-less action: just the predicate), and the predicates
 * are declared as global booleans. Idempotent; returns how many actions it changed.
 */
export function applyActionGates(table: GateTable): number {
  let n = 0;
  for (const f of SERVER_FEATURES) {
    const p = featurePredicate(f);
    if (!Object.prototype.hasOwnProperty.call(table.predicates, p)) table.predicates[p] = { type: "bool", scope: "global", doc: predicateDoc(f) };
  }
  if (!Object.prototype.hasOwnProperty.call(table.predicates, RETIRED_PREDICATE))
    table.predicates[RETIRED_PREDICATE] = { type: "bool", scope: "global", doc: "Always false in a self-hosted build: actions it replaced (the per-room guest link → the guest room)." };
  for (const a of table.actions) {
    const f = gateOfAction(a.id);
    const p = f ? featurePredicate(f) : isRetiredAction(a.id) ? RETIRED_PREDICATE : null;
    if (!p) continue;
    const r = a.requires;
    if (r === p) continue;
    if (isObj(r) && Array.isArray(own(r, "all")) && (own(r, "all") as unknown[]).includes(p)) continue;
    a.requires = r === undefined ? p : { all: [r, p] };
    n++;
  }
  return n;
}

// ---- Settings rows a feature carries (settingsIndex.json ids) ---------------------------------------------------

export const SETTING_GATES: ReadonlyArray<readonly [string, ServerFeature]> = [
  ["privacy.never-record", "memories"],
  ["profile.join-sound", "soundboard"],
  // Reach: "Your status" and the time zone Friends' clocks shows (both live in the presence service)
  ["privacy.share-status", "presence"],
  ["privacy.share-time-zone", "presence"],
  ["privacy.time-zone", "presence"],
  ["about.report", "reports"],
  ["privacy.log-sharing", "reports"],
  // the guest room's pane (Settings → Guests: its state + the link)
  ["guests.state", "guests"],
  ["guests.link", "guests"],
];

export function gateOfSetting(id: string): ServerFeature | null {
  for (const [k, f] of SETTING_GATES) if (k === id) return f;
  return null;
}

// ---- widgets a feature carries (widgets.json ids) and roles permissions (spaces/model.ts keys) --------------------

export const WIDGET_GATES: ReadonlyArray<readonly [string, ServerFeature]> = [
  ["memories", "memories"],
  ["soundPad", "soundboard"],
  ["gameServers", "gameservers"],
  // Reach's widgets: who shares a status, their clocks, and the probe of the presence service
  ["whosAround", "presence"],
  ["clocks", "presence"],
  ["justMe", "presence"],
];

export function gateOfWidget(id: string): ServerFeature | null {
  for (const [k, f] of WIDGET_GATES) if (k === id) return f;
  return null;
}

export const PERMISSION_GATES: ReadonlyArray<readonly [string, ServerFeature]> = [
  ["record_calls", "memories"],
  ["use_soundboard", "soundboard"],
  ["manage_soundboard", "soundboard"],
];

export function gateOfPermission(key: string): ServerFeature | null {
  for (const [k, f] of PERMISSION_GATES) if (k === key) return f;
  return null;
}

// ---- Settings panes a feature carries (settings PaneId) -----------------------------------------------------------

export const PANE_GATES: ReadonlyArray<readonly [string, ServerFeature]> = [["guests", "guests"]];

export function gateOfPane(key: string): ServerFeature | null {
  for (const [k, f] of PANE_GATES) if (k === key) return f;
  return null;
}

// ---- a Tin Hat Server's temporary guest accounts --------------------------------------------------------------

/** A temporary guest account (`@guest-…`, made by the server for whoever was let in — the guest room's, and the old
 *  per-room links'): no encryption set-up, no verify prompts, none of the guest room's buttons (docs/GUESTS.md). */
export function isGuestAccount(mxid: string | null | undefined): boolean {
  return typeof mxid === "string" && /^@guest-[^:]*:./.test(mxid);
}

// ---- the recorder ---------------------------------------------------------------------------------------------

/**
 * Is `id` the recorder? `id` is a Matrix id ("@u:server") or a LiveKit identity ("@u:server:DEVICE"); `recorder` is
 * the announced account ("" = none, so nobody is). Pure; the apps' isRecorder() feeds it the server's announcement.
 */
export function isRecorderId(id: string, recorder: string): boolean {
  if (!recorder || !id) return false;
  return id === recorder || id.startsWith(`${recorder}:`);
}

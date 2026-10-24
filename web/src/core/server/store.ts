// store.ts — the server's offer at run time (selfhost/firstrun item 1; the rules: ./offer.ts). Read at start, at every
// sign-in and when the page comes back (at most every 10 min), and kept in localStorage so a reload draws the right
// buttons at once.
//
// Dev preview (DEV builds only, never in a production bundle): ?selfhostui=1 fakes the server's answer — the offer
// comes from ?thfeatures=memories:0,soundboard:0,gifs:0,… (default: calls on, Memories and the soundboard off, the
// round-5 server; `&threcorder=@x:y` names a recorder) and is never fetched.
//
// The recorder (docs/SELFHOST.md): recorderMxid() / isRecorder() — the account the server announces with Memories; a
// server without one has NO recorder (nothing is filtered, nothing is invited).
import { useCallback, useSyncExternalStore } from "react";
import { MATRIX_ORIGIN } from "@/core/bearer";
import { createLogger } from "@/core/log";
import { getSession, useSessionStore } from "@/core/matrix/session";
import { DISCOVERY_KEY, NO_OFFER, SERVER_FEATURES, featureFor, isGuestAccount, isRecorderId, offerDoc, parseOffer, sameOffer, type ServerFeature, type ServerOffer } from "./offer";

const log = createLogger("server-offer");

function devQuery(k: string): string | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  try {
    return new URLSearchParams(location.search).get(k);
  } catch {
    return null;
  }
}

/** DEV builds only: a canned offer instead of the server's (?selfhostui=1). Always false in a production build. */
export const SELFHOST_PREVIEW: boolean = import.meta.env.DEV && devQuery("selfhostui") === "1";

const CACHE_KEY = "tinhat.server-offer";
const REFRESH_MS = 10 * 60_000;

function previewOffer(): ServerOffer {
  const q = devQuery("thfeatures");
  const features: Partial<Record<ServerFeature, boolean>> = q === null ? { calls: true, memories: false, soundboard: false } : {};
  for (const part of (q ?? "").split(",")) {
    const [k, v] = part.split(":");
    if ((SERVER_FEATURES as readonly string[]).includes(k ?? "") && (v === "0" || v === "1")) features[k as ServerFeature] = v === "1";
  }
  const recorder = devQuery("threcorder") ?? "";
  return { server: "preview", api: "", features, recorder: /^@[^:\s]+:[^\s]+$/.test(recorder) && features.memories !== false ? recorder : "", passwordReset: devQuery("thpwreset") === "owner" ? "owner" : "" };
}

function readCache(): ServerOffer {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? parseOffer(JSON.parse(raw)) : NO_OFFER;
  } catch {
    return NO_OFFER;
  }
}

function writeCache(o: ServerOffer): void {
  try {
    if (o === NO_OFFER || (!o.server && !o.api && Object.keys(o.features).length === 0 && !o.passwordReset)) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify({ [DISCOVERY_KEY]: offerDoc(o) }));
  } catch {
    /* private mode: the next start asks again */
  }
}

let offer: ServerOffer = SELFHOST_PREVIEW ? previewOffer() : readCache();
let lastRead = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: ServerOffer): void {
  if (sameOffer(next, offer)) return;
  log.info(`${JSON.stringify(offer.features)} → ${JSON.stringify(next.features)} (server ${next.server || "?"})`);
  offer = next;
  writeCache(next);
  for (const l of [...listeners]) l();
}

/** What the server offers (NO_OFFER before the server answered). */
export function serverOffer(): ServerOffer {
  return offer;
}

/** Is this feature on? False only when the server said so (or it is withheld from a guest account). */
export function serverFeatureOn(f: ServerFeature): boolean {
  return featureFor(offer, f, guestNow());
}

/** The signed-in account is a temporary guest account (docs/GUESTS.md: some features are withheld from it). */
export function guestNow(): boolean {
  return isGuestAccount(getSession().userId);
}

// what this account is offered also changes with the account (a guest withholds GUEST_WITHHELD): tell the same listeners
useSessionStore.subscribe((s, p) => {
  if (isGuestAccount(s.userId) !== isGuestAccount(p.userId)) for (const l of [...listeners]) l();
});

/** Subscribe to offer changes (and to the account becoming / ceasing to be a guest); returns the unsubscribe. */
export function onServerOffer(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React: is this feature on (re-renders when the server's answer changes). */
export function useServerFeature(f: ServerFeature): boolean {
  const get = () => serverFeatureOn(f);
  return useSyncExternalStore(onServerOffer, get, get);
}

let featCache: { o: ServerOffer; g: boolean; v: Readonly<Record<ServerFeature, boolean>> } | null = null;
/** Every feature's state at once (the same object until the offer — or whether the account is a guest — changes). */
export function serverFeatures(): Readonly<Record<ServerFeature, boolean>> {
  const g = guestNow();
  if (!featCache || featCache.o !== offer || featCache.g !== g) {
    const v = {} as Record<ServerFeature, boolean>;
    for (const f of SERVER_FEATURES) v[f] = serverFeatureOn(f);
    featCache = { o: offer, g, v };
  }
  return featCache.v;
}

/** React: a test "is the thing with this id offered?" for lists gated by id — `gateOf` is offer.ts's gateOfWidget /
 *  gateOfSetting / gateOfPermission; an id no feature carries is always offered. */
export function useOffered(gateOf: (id: string) => ServerFeature | null): (id: string) => boolean {
  const feats = useSyncExternalStore(onServerOffer, serverFeatures, serverFeatures);
  return useCallback(
    (id: string) => {
      const g = gateOf(id);
      return !g || feats[g];
    },
    [feats, gateOf],
  );
}

// ---- the recorder ---------------------------------------------------------------------------------------------

/** The Memories recorder's Matrix id — the account to invite when recording starts: the one the server announces;
 *  "" = this server has none. */
export function recorderMxid(): string {
  return offer.recorder;
}

/** Is this Matrix id / LiveKit identity ("@u:server:DEVICE") the recorder? Exactly the announced account (none
 *  announced → nobody). */
export function isRecorder(id: string): boolean {
  return isRecorderId(id, offer.recorder);
}

/** The recorder rule for the pure widget logic (src/widgets/history.ts, people.ts — `recorder` input): the announced
 *  account, `null` when the server names none (nobody is a recorder). */
export function recorderRule(): string | null {
  return offer.recorder || null;
}

/** React: the recorder's id (re-renders when the server's answer changes). */
export function useRecorderMxid(): string {
  return useSyncExternalStore(onServerOffer, recorderMxid, recorderMxid);
}

/**
 * Ask the server again (at most every 10 min unless `force`). A 200 answer is the truth (without
 * the key = today's behaviour), a 404 too (no discovery document = an older server); a network error, another status
 * or a body that isn't JSON keeps the last answer.
 */
export function refreshServerOffer(force = false): Promise<void> {
  if (SELFHOST_PREVIEW) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastRead < REFRESH_MS) return Promise.resolve();
  lastRead = Date.now();
  inFlight = (async () => {
    try {
      const r = await fetch(`${MATRIX_ORIGIN}/.well-known/matrix/client`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return set(NO_OFFER);
      if (!r.ok) return log.warn(`HTTP ${r.status} — keeping the last answer`);
      set(parseOffer(await r.json()));
    } catch (e) {
      lastRead = 0; // try again on the next occasion
      log.warn("couldn't read the server's offer — keeping the last answer", e);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The sign-in screen's "Forgot your password?": does this server say its owner resets passwords (it sends no email)?
 * Asked fresh each time (nobody is signed in); "" on anything but a clear yes (no document, another answer, a network
 * error, 10 s without one) = the email form, as before.
 */
export async function askPasswordReset(): Promise<"owner" | ""> {
  try {
    const r = await fetch(`${MATRIX_ORIGIN}/.well-known/matrix/client`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10000) });
    return r.ok ? parseOffer(await r.json()).passwordReset : "";
  } catch {
    return "";
  }
}

/** Test hook (gates, screenshots in DEV): lay an offer over the live one. */
export function setServerOfferForTest(o: ServerOffer): void {
  set(o);
}



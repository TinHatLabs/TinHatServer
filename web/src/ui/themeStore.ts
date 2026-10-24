// themeStore.ts — which theme, sound pack and icon style this device shows (THEMES-SYNC.md §7–§8), and the device
// side of the theme sync protocol (§3.5, §4.6: `dev.tinhat.theme` = the choice, `dev.tinhat.themes` = My themes).
//
//   effective = the device override ("Use a different theme on this device", §7)
//             → the account's choice (the best one this device knows, projected: §3.4)
//             → signed in: the device's 10.x theme (pref `theme-legacy`, captured once from pref `theme`: goose → Goose
//               + the Goose sounds, else OLED) · signed out: the last theme shown (the mirrors below)
//
// Everything is local-first: an apply paints at once and persists here; the account-data I/O (reading the two keys,
// the PUTs with retries, re-asserts) is features/settings/themeSync.ts, which drives the pure protocol through the
// functions at the end of this file. Persisted per account in the blob `theme-sync` (removed at sign-out). Mirrors for
// the parts of the app that must not wait for this module (device prefs, survive sign-out): `theme` (the shown theme's
// id — index.html's boot script), `theme-cache` ({id, doc} of a theme that is not a built-in, for the next start),
// `theme-boot` (themes.ts), `sound-pack` (core/sounds.ts), `icon-style` (+ <html data-icons>, ui/Icon).
//
// Gate mode `?themesync=0` (THEMES-SYNC §9): the account is neither read nor written; the device prefs `theme` (any
// library id), `sound-pack`, `icon-style` ARE the state, applies write them, nothing is offered.
//
// The ☰ Theme menu's recent themes (THEMES-UI §12, src/theme/recent.ts): device pref `theme-recent`, updated by a
// person's action that changes the theme (applyChoice with a theme: picks, import "Save and use", Undo; and "Keep ‹old›
// here"); a theme another device chose is shown by the menu but never recorded. Gate mode keeps them for this page load.
import { useSyncExternalStore } from "react";
import { BUILTINS, NO_TOKENS, resolveTheme, type Theme } from "../theme/engine";
import * as S from "../theme/sync";
import { readRecent, recentMenu, recordPick, writeRecent } from "../theme/recent";
import { getBlob, getPrefRaw, onBlobChange, onPrefChange, setBlob, setPrefRaw } from "../core/prefs";
import { applyThemeDoc, currentColours, normalizeTheme, resolveColours, type ThemeColours } from "./themes";
import { libraryDoc, libraryNow, loadLibrary } from "./themeLibrary";

const BLOB = "theme-sync";
const OFFERS_PREF = "theme-offers";

export type Source = "device" | "account" | "legacy" | "last" | "local";
export type Key = "choice" | "themes";

export interface Offer {
  pack: S.SoundPack;
  themeId: string;
  themeName: string;
  /** where the apply came from: the settings show the offer inline, anywhere else gets a toast */
  inSettings: boolean;
}
export interface RemoteChange {
  fromContent: S.JObj;
  fromName: string;
  toName: string;
}
export interface ThemeState {
  /** where the shown theme comes from */
  source: Source;
  /** the content shown (theme, doc?, overrides?, sounds, icons) */
  content: S.JObj;
  /** the resolved theme on screen */
  colours: ThemeColours;
  sounds: S.SoundPack;
  icons: S.IconStyle;
  /** the device override is on */
  override: boolean;
  /** the account's choice as this device knows it (null: none yet) — "Everywhere else" */
  account: S.JObj | null;
  /** the account's choice was written by a newer app: applies stay on this device (§7) */
  readOnly: boolean;
  /** My themes (newest first); `usable` = the engine accepts it */
  myThemes: MyTheme[];
  myThemesReadOnly: boolean;
  /** a save is waiting for the server since (ms) */
  pendingSince: number | null;
  /** notices */
  unknownTheme: string | null;
  overridesRefused: boolean;
  /** the content shown before the last apply (Undo), null when there is nothing to undo */
  undo: S.JObj | null;
  offer: Offer | null;
  /** gate mode (?themesync=0) */
  local: boolean;
}
export interface MyTheme {
  id: string;
  doc: Theme;
  usable: boolean;
  savedAt: number;
}

// ---- persisted state -----------------------------------------------------------------------------------------------
interface Persisted {
  v: 1;
  choice: S.ChoiceState;
  themes: S.ThemesState;
  /** the local choice while the override is on */
  device: S.JObj | null;
  pendingSince: number | null;
}
const emptyPersisted = (): Persisted => ({ v: 1, choice: S.emptyChoiceState(), themes: S.emptyThemesState(), device: null, pendingSince: null });

function loadPersisted(): Persisted | null {
  const raw = getBlob<unknown>(BLOB, null);
  const v = S.asData(raw);
  if (!S.isObj(v) || v.v !== 1) return null;
  const p = emptyPersisted();
  const c = v.choice;
  if (S.isObj(c)) {
    p.choice.known = S.isObj(c.known) ? (c.known as S.JObj) : null;
    p.choice.raw = c.raw === undefined ? null : (c.raw as S.Json);
    p.choice.readOnly = c.readOnly === true;
    p.choice.wantPut = c.wantPut === true;
  }
  const t = v.themes;
  if (S.isObj(t)) {
    if (S.isObj(t.known)) for (const k of Object.keys(t.known)) if (S.isObj(t.known[k])) p.themes.known[k] = t.known[k] as S.JObj;
    p.themes.raw = t.raw === undefined ? null : (t.raw as S.Json);
    p.themes.readOnly = t.readOnly === true;
    p.themes.wantPut = t.wantPut === true;
    p.themes.justSaved = typeof t.justSaved === "string" ? t.justSaved : null;
  }
  p.device = S.isObj(v.device) ? (v.device as S.JObj) : null;
  p.pendingSince = typeof v.pendingSince === "number" ? v.pendingSince : null;
  return p;
}

// ---- module state ----------------------------------------------------------------------------------------------------
const LOCAL = (() => {
  try {
    return typeof location !== "undefined" && /[?&]themesync=0\b/.test(location.search + location.hash);
  } catch {
    return false;
  }
})();
let p: Persisted = emptyPersisted();
let hasBlob = false;
/** the device had theme state when this page started (not a fresh sign-in) */
let bootHadState = false;
/** a change from another device whose notice waits until its theme is on screen */
let pendingRemote: { fromContent: S.JObj; fromName: string; toId: string } | null = null;
let signedIn = false;
let deviceId = "";
let undo: S.JObj | null = null;
let offer: Offer | null = null;
let state: ThemeState | null = null;
let libWanted = false;
let persistedText = "";
/** THEMES-UI.md §13.4 / §14.4: a theme painted without saving anything (the theme editor's working document, a Try) */
let preview: { owner: PreviewOwner; doc: Theme } | null = null;
/** the resolved effective choice (what is on screen whenever no preview is) */
let effective: ThemeColours | null = null;
const previewListeners = new Set<() => void>();
const appliedListeners = new Set<() => void>();
const listeners = new Set<() => void>();
const wantListeners = new Set<(key: Key) => void>();
const remoteListeners = new Set<(r: RemoteChange) => void>();
const offerListeners = new Set<(o: Offer) => void>();

function persist(): void {
  if (LOCAL) return;
  const text = JSON.stringify(p);
  if (text === persistedText) return;
  persistedText = text;
  hasBlob = true;
  if (!setBlob(BLOB, p)) {
    // over the 64 KB blob cap (a My-themes document near its limit): keep the protocol state, drop the raw copies —
    // they come back with the next account-data event
    const slim = { ...p, choice: { ...p.choice, raw: null }, themes: { ...p.themes, raw: null } };
    setBlob(BLOB, slim);
  }
}

// ---- the effective choice ----------------------------------------------------------------------------------------------
const resolves = (t: S.JObj): boolean => resolveTheme(t, NO_TOKENS).ok === true;

function cachedDoc(id: string): Theme | undefined {
  const raw = getPrefRaw("theme-cache");
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { id?: string; doc?: Theme };
    return v && v.id === id && S.isObj(v.doc) ? v.doc : undefined;
  } catch {
    return undefined;
  }
}
/** A library theme's document: the built-ins and the loaded library, else the cached copy of the last shown theme. */
function lookup(id: string): S.JObj | undefined {
  return (libraryDoc(id) ?? cachedDoc(id)) as S.JObj | undefined;
}

function mirrorContent(): S.JObj {
  const theme = getPrefRaw("theme");
  const id = theme && /^[a-z0-9.:-]{1,64}$/.test(theme) ? theme : "oled";
  const sounds = getPrefRaw("sound-pack");
  const icons = getPrefRaw("icon-style");
  return S.clone({
    theme: id,
    sounds: sounds && S.isPackId(sounds) ? sounds : id === "goose" ? "goose" : "default",
    icons: icons && S.isPackId(icons) ? icons : "duotone",
  });
}
function legacyContent(): S.JObj {
  return S.legacyChoice(getPrefRaw("theme-legacy") ?? normalizeTheme(getPrefRaw("theme")));
}
function accountDoc(): S.JObj | null {
  // read-only (a newer format): rendered best-effort (§3.2); else the best ok choice known
  if (p.choice.readOnly) {
    const r = S.readChoice(p.choice.raw);
    if (r.kind === "newer" && typeof r.doc.theme === "string") return r.doc;
  }
  const k = p.choice.known ? S.readChoice(p.choice.known) : null;
  return k && k.kind === "ok" ? k.doc : null;
}

interface Picked {
  source: Source;
  content: S.JObj;
  /** null = the theme's document is in the library chunk that is still loading: keep what is on screen meanwhile */
  projection: S.ChoiceProjection | null;
  unknownTheme: string | null;
}
function pick(): Picked {
  const project = (c: S.JObj) => S.projectChoice(c, lookup, resolves);
  const candidates: [Source, S.JObj][] = [];
  if (LOCAL) candidates.push(["local", mirrorContent()]);
  else {
    if (p.device) candidates.push(["device", p.device]);
    const acct = accountDoc();
    if (acct) candidates.push(["account", S.choiceContent(acct)]);
    candidates.push(signedIn || hasBlob ? ["legacy", legacyContent()] : ["last", mirrorContent()]);
  }
  let unknownTheme: string | null = null;
  for (const [source, content] of candidates) {
    const pr = project(content);
    if (pr.source !== "none") return { source, content, projection: pr, unknownTheme };
    // an id this device can't find yet: the library may still be loading — keep the screen as it is until it is in
    if (pr.themeId && !libraryNow() && !pr.theme) {
      wantLibrary();
      return { source, content, projection: null, unknownTheme: null };
    }
    if (source === "account" || source === "device") unknownTheme = pr.themeId;
  }
  const oled = S.legacyChoice("oled");
  return { source: "legacy", content: oled, projection: project(oled), unknownTheme };
}

function wantLibrary(): void {
  if (libWanted || libraryNow()) return;
  libWanted = true;
  void loadLibrary()
    .then(() => recompute())
    .catch(() => {
      libWanted = false;
    });
}

function myThemesList(): { list: MyTheme[]; readOnly: boolean } {
  const doc = S.mergeThemes(p.themes.raw, p.themes.known).doc;
  const list = S.listThemes(doc).map((e) => {
    const t = e.theme as unknown as Theme;
    return { id: e.id as string, doc: t, usable: resolves(e.theme as S.JObj), savedAt: S.orderKey(e)[0] };
  });
  return { list, readOnly: p.themes.readOnly };
}

function recompute(): void {
  const pk = pick();
  let colours = effective ?? currentColours();
  if (pk.projection?.theme) {
    // under a preview the effective choice is resolved (the settings' state) but not painted
    const doc = pk.projection.theme as unknown as Theme;
    const r = preview ? resolveColours(doc) : applyThemeDoc(doc);
    if (!("error" in r)) colours = r;
  }
  effective = colours;
  const packs = pk.projection ?? S.projectChoice(pk.content, () => undefined, () => false);
  const sounds = packs.sounds;
  const icons = packs.icons;
  // mirrors (never in gate mode: there the prefs ARE the state)
  if (!LOCAL) {
    if (pk.projection) setIf("theme", colours.theme);
    setIf("sound-pack", sounds);
    setIf("icon-style", icons);
    if (pk.projection && !colours.builtin) setIf("theme-cache", JSON.stringify({ id: colours.theme, doc: colours.doc }));
  }
  if (typeof document !== "undefined") {
    if (icons === "mono") document.documentElement.dataset.icons = "mono";
    else delete document.documentElement.dataset.icons;
  }
  const mine = myThemesList();
  const acct = accountDoc();
  state = {
    source: pk.source,
    content: pk.content,
    colours,
    sounds,
    icons,
    override: !!p.device && !LOCAL,
    account: acct ? S.choiceContent(acct) : null,
    readOnly: p.choice.readOnly,
    myThemes: mine.list,
    myThemesReadOnly: mine.readOnly,
    pendingSince: p.pendingSince,
    unknownTheme: pk.unknownTheme,
    overridesRefused: pk.projection?.overrides === "refused",
    undo,
    offer,
    local: LOCAL,
  };
  for (const l of listeners) l();
  flushRemote();
}
function flushRemote(): void {
  const pr = pendingRemote;
  if (!pr || !state) return;
  if (state.content.theme !== pr.toId) {
    pendingRemote = null; // superseded (another change came first)
    return;
  }
  if (state.colours.theme !== pr.toId) return; // not painted yet (library loading)
  pendingRemote = null;
  for (const l of remoteListeners) l({ fromContent: pr.fromContent, fromName: pr.fromName, toName: state.colours.name });
}
function setIf(key: string, value: string): void {
  if (getPrefRaw(key) !== value) setPrefRaw(key, value);
}

// ---- boot ----------------------------------------------------------------------------------------------------------------
let booted = false;
/** Paint the right theme before the first render (main.tsx) and follow every change from here on (other tabs too). */
export function bootTheme(): void {
  if (booted) return;
  booted = true;
  if (!LOCAL && getPrefRaw("theme-legacy") === null) setPrefRaw("theme-legacy", normalizeTheme(getPrefRaw("theme")));
  const loaded = LOCAL ? null : loadPersisted();
  hasBlob = !!loaded;
  // a device that showed a theme before (its sync state, or a 10.x theme) is told when another device changes it
  bootHadState = !!loaded || getPrefRaw("theme") !== null;
  p = loaded ?? emptyPersisted();
  persistedText = loaded ? JSON.stringify(p) : "";
  recompute();
  // another tab changed the state (its own applies, its sync), or the gate's storage-event switch (gate mode)
  onBlobChange(BLOB, () => {
    if (LOCAL) return;
    const next = loadPersisted();
    const text = next ? JSON.stringify(next) : "";
    if (text === persistedText) return;
    persistedText = text;
    hasBlob = !!next;
    p = next ?? emptyPersisted();
    recompute();
  });
  for (const k of ["theme", "sound-pack", "icon-style"]) onPrefChange(k, () => LOCAL && recompute());
  // test hook (dev builds / the rigs set __TW_DEBUG__): tools/themes-web-peer.mjs drives THIS instance
  const w = typeof window !== "undefined" ? (window as unknown as { __TW_DEBUG__?: boolean; __twThemes?: unknown }) : null;
  if (w && (import.meta.env?.DEV || w.__TW_DEBUG__)) {
    w.__twThemes = { getThemeState, applyChoice, chooseTheme, undoLast, setDeviceOverride, saveMyTheme, removeMyTheme, newMyThemeId, recentThemes };
  }
}

// ---- previews (THEMES-UI.md §13.4, §14.4) -------------------------------------------------------------------------------
export type PreviewOwner = "editor" | "try";
/**
 * Paint a theme document WITHOUT saving anything — no account write, no My-themes write, no boot cache, the choice
 * unchanged — until clearThemePreview(owner). One owner at a time: another owner's preview → "busy". A theme the engine
 * refuses → its error, nothing changes. While a preview is on, changes of the effective choice (another device, an
 * apply elsewhere) update the state but are painted only when the preview ends.
 */
export function setThemePreview(owner: PreviewOwner, doc: Theme): string | null {
  if (preview && preview.owner !== owner) return "busy";
  if (!effective) effective = currentColours();
  const r = applyThemeDoc(doc, { boot: false });
  if ("error" in r) return r.error;
  const was = preview;
  preview = { owner, doc };
  if (!was) for (const l of previewListeners) l();
  return null;
}
/** End `owner`'s preview: the effective choice is painted again. */
export function clearThemePreview(owner: PreviewOwner): void {
  if (!preview || preview.owner !== owner) return;
  preview = null;
  if (effective) applyThemeDoc(effective.doc);
  recompute();
  for (const l of previewListeners) l();
}
export const themePreviewOwner = (): PreviewOwner | null => preview?.owner ?? null;
export function subscribePreview(cb: () => void): () => void {
  previewListeners.add(cb);
  return () => previewListeners.delete(cb);
}
export function usePreviewOwner(): PreviewOwner | null {
  return useSyncExternalStore(subscribePreview, themePreviewOwner, themePreviewOwner);
}
/** After every real apply (a card, the menu, Keep, Save …): the Try ends without going back. */
export function onThemeApplied(cb: () => void): () => void {
  appliedListeners.add(cb);
  return () => appliedListeners.delete(cb);
}
/** My themes as the store knows them (the editor's Save / Keep: taken ids, "the same theme"). */
export function myThemeDocs(): Theme[] {
  return getThemeState().myThemes.map((m) => m.doc);
}

// ---- React -----------------------------------------------------------------------------------------------------------------
export function subscribeThemeState(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getThemeState(): ThemeState {
  if (!state) recompute();
  return state!;
}
export function useThemeState(): ThemeState {
  return useSyncExternalStore(subscribeThemeState, getThemeState, getThemeState);
}

// ---- applying --------------------------------------------------------------------------------------------------------------
export type Patch = { theme?: string; doc?: Theme | null; overrides?: S.JObj | null; sounds?: string; icons?: string };
export interface ApplyOptions {
  /** the apply comes from the settings (the offer shows inline) */
  inSettings?: boolean;
  /** internal: an Undo (no new undo entry, no offer) */
  isUndo?: boolean;
}
/**
 * Apply a change of theme / sound pack / icon style. Returns the protocol's answer: `saved` (account), `device` (the
 * override or read-only), `local` (gate mode), `noop`, or an error code (THEMES-UI.md §6.1).
 */
export function applyChoice(patch: Patch, opts: ApplyOptions = {}): string {
  const before = getThemeState();
  const beforeContent = S.clone(before.content);
  const pj = S.clone(patch as unknown as S.Json) as S.JObj;
  let result: string;
  if (LOCAL) {
    const next = S.applyPatch(mirrorContent(), pj);
    if (S.sameJson(next, mirrorContent())) result = "noop";
    else {
      setPrefRaw("theme", next.theme as string);
      setPrefRaw("sound-pack", next.sounds as string);
      setPrefRaw("icon-style", next.icons as string);
      result = "local";
    }
  } else if (p.device || p.choice.readOnly) {
    const start = p.device ?? before.content;
    const next = S.applyPatch(start, pj);
    const bad = S.checkContent(next);
    if (bad) return bad;
    if (p.device && S.sameJson(next, p.device)) result = "noop";
    else {
      p.device = next;
      result = "device";
    }
  } else {
    result = S.choiceApply(p.choice, pj, before.source === "account" ? null : before.content, Date.now(), deviceId || "web");
    if (result === "saved") {
      p.pendingSince ??= Date.now();
      for (const l of wantListeners) l("choice");
    }
  }
  if (result !== "saved" && result !== "device" && result !== "local") return result;
  persist();
  // THEMES-UI §12: a person's apply that changes the theme goes first in the ☰ menu's recents (an Undo too)
  if (typeof patch.theme === "string" && patch.theme !== beforeContent.theme) notePick(before.colours.theme, patch.theme);
  if (!opts.isUndo) undo = beforeContent;
  else undo = null;
  recompute();
  // a real apply ends a Try without going back (THEMES-UI.md §14.4)
  for (const l of appliedListeners) l();
  if (!opts.isUndo && typeof patch.theme === "string") maybeOffer(!!opts.inSettings);
  return result;
}

/** Undo the last apply (THEMES-UI §3.2): the content shown before it, applied as a new apply. */
export function undoLast(): string {
  if (!undo) return "noop";
  const u = undo;
  const patch: Patch = {
    theme: u.theme as string,
    doc: S.isObj(u.doc) ? (u.doc as unknown as Theme) : null,
    overrides: S.isObj(u.overrides) ? (u.overrides as S.JObj) : null,
  };
  if (typeof u.sounds === "string") patch.sounds = u.sounds;
  if (typeof u.icons === "string") patch.icons = u.icons;
  const r = applyChoice(patch, { isUndo: true });
  undo = null;
  offer = null;
  recompute();
  return r;
}

/** Choose a theme document: a library theme goes by its id, any other (My themes, an import) with its document. */
export function chooseTheme(doc: Theme, opts: ApplyOptions = {}): string {
  const libDoc = libraryNow()?.byId.get(doc.id)?.doc ?? (Object.prototype.hasOwnProperty.call(BUILTINS, doc.id) ? BUILTINS[doc.id] : undefined);
  const isLibrary = !!libDoc && S.sameJson(doc as unknown as S.JObj, libDoc as unknown as S.JObj);
  return applyChoice(isLibrary ? { theme: doc.id } : { theme: doc.id, doc }, opts);
}

/** The settings sheet closed: Undo and an unanswered offer end with it (THEMES-UI §3.2, §10.6). */
export function endThemeSession(): void {
  if (offer) markOffered(offer);
  if (!undo && !offer) return;
  undo = null;
  offer = null;
  recompute();
}

// ---- the offer (THEMES-UI §10.6) -------------------------------------------------------------------------------------------
function offersSeen(): string[] {
  try {
    const v = JSON.parse(getPrefRaw(OFFERS_PREF) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
const offerKey = (o: { themeId: string; pack: string }) => `${o.themeId}:sounds:${o.pack}`;
function markOffered(o: Offer): void {
  const seen = offersSeen();
  if (!seen.includes(offerKey(o))) setPrefRaw(OFFERS_PREF, JSON.stringify([...seen, offerKey(o)].slice(-200)));
}
function maybeOffer(inSettings: boolean): void {
  if (LOCAL) return;
  const st = getThemeState();
  const suggested = (st.colours.doc as { sounds?: unknown }).sounds;
  if (typeof suggested !== "string" || !S.isPackId(suggested) || suggested === st.sounds) {
    offer = null;
    return;
  }
  if (suggested !== "default" && suggested !== "goose") return;
  const o: Offer = { pack: suggested, themeId: st.colours.theme, themeName: st.colours.name, inSettings };
  if (offersSeen().includes(offerKey(o))) return;
  if (inSettings) {
    offer = o;
    recompute();
  } else {
    markOffered(o);
    for (const l of offerListeners) l(o);
  }
}
export function acceptOffer(o: Offer | null = offer): void {
  if (!o) return;
  markOffered(o);
  offer = null;
  applyChoice({ sounds: o.pack }, { inSettings: true });
}
export function dismissOffer(): void {
  if (!offer) return;
  markOffered(offer);
  offer = null;
  recompute();
}
/** An offer made outside the settings (a toast with the action): the wiring shows it. */
export function onOffer(cb: (o: Offer) => void): () => void {
  offerListeners.add(cb);
  return () => offerListeners.delete(cb);
}

// ---- the device override (§7) ------------------------------------------------------------------------------------------
export function setDeviceOverride(on: boolean): void {
  if (LOCAL) return;
  if (on === !!p.device) return;
  p.device = on ? S.clone(getThemeState().content) : null;
  undo = null;
  offer = null;
  persist();
  recompute();
}
/** "Keep ‹old› here" of the changed-on-another-device notice: the override on, with the content shown before. */
export function keepOnThisDevice(content: S.JObj): void {
  if (LOCAL) return;
  const before = getThemeState();
  p.device = S.clone(content);
  persist();
  // the person chose to keep that theme here: a pick for the ☰ menu's recents (THEMES-UI §12)
  if (typeof content.theme === "string" && content.theme !== before.content.theme) notePick(before.colours.theme, content.theme);
  recompute();
}

// ---- the ☰ Theme menu's recent themes (THEMES-UI §12) ----------------------------------------------------------------------
const RECENT_PREF = "theme-recent";
/** gate mode: the recents live for this page load only (like the desktop's gate and TINHAT_THEME runs), never stored */
let recentMem: string[] = [];
function recentHistory(): string[] {
  return LOCAL ? recentMem : readRecent(getPrefRaw(RECENT_PREF));
}
/** Can the menu apply this theme: one of My themes the engine accepts, or a library theme (the built-ins answer before
 *  the library chunk is in; until then any other id is given the benefit of the doubt, so nothing is dropped early). */
function themeUsable(id: string): boolean {
  const mine = getThemeState().myThemes.find((m) => m.id === id);
  if (mine) return mine.usable;
  if (libraryDoc(id)) return true;
  return !libraryNow();
}
/** A person's action on this device put `picked` on screen while `shown` was there. */
function notePick(shown: string, picked: string): void {
  const next = recordPick(recentHistory(), shown, picked, themeUsable);
  if (LOCAL) {
    recentMem = next;
    return;
  }
  const text = writeRecent(next);
  if (getPrefRaw(RECENT_PREF) !== text) setPrefRaw(RECENT_PREF, text);
}

/** One row of the ☰ Theme menu. */
export interface RecentTheme {
  id: string;
  /** the display name ("Catppuccin Latte") */
  name: string;
  /** the document a pick applies (chooseTheme) and the swatch is painted from */
  doc: Theme;
  /** a library theme exactly as shipped (its miniature is cached by id) */
  library: boolean;
  /** the theme on screen (the row's check; a click on it does nothing) */
  current: boolean;
}
/**
 * The ☰ Theme menu's theme rows, top to bottom (THEMES-UI §12): the recents (recent.ts recentMenu) for the theme on
 * screen. A library theme other than the built-ins shows once the library chunk is in (its name and colours come from
 * it — the menu loads it with useLibrary()).
 */
export function recentThemes(): RecentTheme[] {
  const st = getThemeState();
  const current = st.colours.theme;
  const rows: RecentTheme[] = [];
  for (const id of recentMenu(recentHistory(), current, themeUsable)) {
    const mine = st.myThemes.find((m) => m.id === id);
    const lib = mine ? undefined : libraryDoc(id);
    if (id === current) rows.push({ id, name: st.colours.name, doc: st.colours.doc, library: false, current: true });
    else if (mine) rows.push({ id, name: mine.doc.name, doc: mine.doc, library: false, current: false });
    else if (lib) rows.push({ id, name: lib.name, doc: lib, library: true, current: false });
  }
  return rows;
}

// ---- My themes -----------------------------------------------------------------------------------------------------------
/** Save (add or replace) one of My themes. */
export function saveMyTheme(doc: Theme): string {
  const r = S.themesSave(p.themes, { id: doc.id, theme: S.clone(doc as unknown as S.Json), now: Date.now(), by: deviceId || "web" });
  if (r === "saved") {
    p.pendingSince ??= Date.now();
    persist();
    for (const l of wantListeners) l("themes");
    recompute();
  }
  return r;
}
export function removeMyTheme(id: string): string {
  const r = S.themesSave(p.themes, { id, deleted: true, now: Date.now(), by: deviceId || "web" });
  if (r === "saved") {
    p.pendingSince ??= Date.now();
    persist();
    for (const l of wantListeners) l("themes");
    recompute();
  }
  return r;
}
/** An id for a new My theme (THEMES-SYNC §4.1): not a library id, not one in use. */
export function newMyThemeId(slug: string): string {
  return S.uniqueThemeId(slug, themeIdTaken);
}
/** A library id or a My-themes id (live or tombstoned) — what a new My theme's id must not be. */
export function themeIdTaken(id: string): boolean {
  if (Object.prototype.hasOwnProperty.call(p.themes.known, id)) return true;
  if (S.entriesOf(S.mergeThemes(p.themes.raw, p.themes.known).doc).has(id)) return true;
  return libraryDoc(id) !== undefined || (libraryNow()?.byId.has(id) ?? false);
}

// ---- the wiring's side (features/settings/themeSync.ts) ------------------------------------------------------------------
export const themeSyncEnabled = (): boolean => !LOCAL;
/** Signed in on a device: sync state belongs to this account from here on. */
export function attachSync(id: string): void {
  signedIn = true;
  deviceId = id;
  recompute();
}
/** Signed out (the account's blob is gone with the session). */
export function detachSync(): void {
  signedIn = false;
  deviceId = "";
  hasBlob = false;
  p = emptyPersisted();
  persistedText = "";
  undo = null;
  offer = null;
  recompute();
}
/**
 * An account-data document arrived (the echo of this device's PUT included). Returns the protocol's answer. When it
 * changes the theme on screen and another device wrote it, the "changed on another device" notice goes out — except for
 * the first read of a device that had no theme state yet (a fresh sign-in simply takes the account's theme).
 */
export function receive(key: Key, value: unknown, opts: { initial?: boolean } = {}): string {
  if (LOCAL) return "ignored";
  const before = getThemeState();
  const beforeContent = S.clone(before.content);
  const beforeId = before.content.theme;
  const beforeName = before.colours.name;
  const hadOverride = !!p.device;
  const r = key === "choice" ? S.choiceReceive(p.choice, value) : S.themesReceive(p.themes, value);
  persist();
  recompute();
  if (key === "choice" && (r === "changed" || r === "new") && !hadOverride && !(opts.initial && !bootHadState)) {
    const by = S.isObj(p.choice.known) ? p.choice.known.by : null;
    const toId = getThemeState().content.theme;
    // the notice names the new theme once it is on screen (a library theme may wait for the library chunk)
    if (by !== deviceId && typeof toId === "string" && toId !== beforeId) {
      pendingRemote = { fromContent: beforeContent, fromName: beforeName, toId };
      flushRemote();
    }
  }
  if (r === "reassert") for (const l of wantListeners) l(key);
  return r;
}
/** The document to PUT for `key` now (the protocol's put: `wantPut` cleared), or null. */
export function takePut(key: Key): S.JObj | null {
  const doc = key === "choice" ? S.choicePut(p.choice) : S.themesPut(p.themes);
  if (doc) persist();
  return doc;
}
/** The PUT failed: want it again (the wiring retries). */
export function putFailed(key: Key): void {
  if (key === "choice") p.choice.wantPut = true;
  else p.themes.wantPut = true;
  persist();
}
/** The PUT succeeded. */
export function putDone(): void {
  if (!p.choice.wantPut && !p.themes.wantPut && p.pendingSince !== null) {
    p.pendingSince = null;
    persist();
    recompute();
  }
}
export function wantsPut(key: Key): boolean {
  return key === "choice" ? p.choice.wantPut && !p.choice.readOnly : p.themes.wantPut && !p.themes.readOnly;
}
export function onWantPut(cb: (key: Key) => void): () => void {
  wantListeners.add(cb);
  return () => wantListeners.delete(cb);
}
export function onRemoteChange(cb: (r: RemoteChange) => void): () => void {
  remoteListeners.add(cb);
  return () => remoteListeners.delete(cb);
}

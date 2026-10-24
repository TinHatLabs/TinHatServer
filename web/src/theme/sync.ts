// sync.ts — THEMES-SYNC.md (the shared contract): the two account-data documents
// `dev.tinhat.theme` (the choice) and `dev.tinhat.themes` (My themes) — reading, saving, merging — and the device
// protocol as a deterministic state machine. The TypeScript REFERENCE: the desktop ports it and runs the shared vectors
// (testvectors/themes-sync/, tools/theme-lib/gen-sync-vectors.mjs) byte for byte.
//
// Pure: no DOM, no clock, no I/O — `now` and the device id are arguments. Every object that can hold a key taken from
// user data is created without a prototype, so `__proto__` / `constructor` are ordinary own keys (ENGINE.md §9, Q1).
import { canonJson, cmpCodePoint } from "./canon";
import { isJsonData, isThemeId, utf8Length } from "./limits";

export const CHOICE_TYPE = "dev.tinhat.theme";
export const THEMES_TYPE = "dev.tinhat.themes";
export const CHOICE_FORMAT = "tinhat-theme-choice";
export const THEMES_FORMAT = "tinhat-my-themes";
export const MAX_THEMES = 50;
export const MAX_TOMBSTONES = 64;
export const MAX_DOC_BYTES = 65_536;
export const MAX_THEME_BYTES = 8_192;
export const MAX_REV = 2_147_483_647;
export const MAX_SAVED_AT = 9_007_199_254_740_991;
export const SOUND_PACKS = ["default", "goose"] as const;
export const ICON_STYLES = ["duotone", "mono"] as const;
export type SoundPack = (typeof SOUND_PACKS)[number];
export type IconStyle = (typeof ICON_STYLES)[number];
/** The content keys a save sets (THEMES-SYNC §3.1); every other content key is an unknown one and is carried. */
export const PATCH_KEYS = ["theme", "doc", "overrides", "sounds", "icons"] as const;
const CHOICE_META = new Set(["format", "v", "savedAt", "rev", "by", "previous"]);

// ---- JSON data ----------------------------------------------------------------------------------------------------
export type Json = null | boolean | number | string | Json[] | JObj;
export interface JObj {
  [k: string]: Json;
}
export const isObj = (v: unknown): v is JObj => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** An OWN property, never an inherited one. */
export const get = (o: JObj, k: string): Json | undefined => (has(o, k) ? o[k] : undefined);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
function obj(): JObj {
  return Object.create(null) as JObj;
}
/** Deep copy into prototype-less objects; a non-finite number becomes null (what JSON prints for it). */
export function clone<T extends Json | undefined>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (v !== null && typeof v === "object") {
    const o = obj();
    for (const k of Object.keys(v)) o[k] = clone((v as JObj)[k]);
    return o as T;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null as T;
  return v;
}
/** Account-data content as the contract reads it (ENGINE.md §9): JSON data only (nesting ≤ 128, no lone surrogate). */
export function asData(v: unknown): Json | undefined {
  if (v === undefined) return undefined;
  return isJsonData(v) ? clone(v as Json) : undefined;
}
export const canon = (v: Json | undefined): string => (v === undefined ? "" : canonJson(v));
export const sameJson = (a: Json | undefined, b: Json | undefined): boolean => canon(a) === canon(b);
export const bytesOf = (v: Json): number => utf8Length(canonJson(v));
export const isPackId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v);

// ---- the order key (§2) --------------------------------------------------------------------------------------------
export type OrderKey = [savedAt: number, rev: number, by: string];
export function orderKey(e: JObj): OrderKey {
  const at = get(e, "savedAt");
  const rev = get(e, "rev");
  const by = get(e, "by");
  return [
    isInt(at) && at >= 0 && at <= MAX_SAVED_AT ? at : 0,
    isInt(rev) && rev >= 0 && rev <= MAX_REV ? rev : 0,
    typeof by === "string" && by.length <= 64 ? by : "",
  ];
}
export function cmpKey(a: JObj, b: JObj): number {
  const x = orderKey(a);
  const y = orderKey(b);
  return x[0] - y[0] || x[1] - y[1] || cmpCodePoint(x[2], y[2]);
}
/** The total order: the key, then the canonical text (code-point order). */
export function cmpDoc(a: JObj, b: JObj): number {
  return cmpKey(a, b) || cmpCodePoint(canon(a), canon(b));
}
export function higher(a: JObj | null | undefined, b: JObj | null | undefined): JObj | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return cmpDoc(a, b) >= 0 ? a : b;
}
/** The stamps of a save based on `base` (§2). */
export function stamps(base: JObj | null, now: number, by: string): { savedAt: number; rev: number; by: string } {
  if (!base) return { savedAt: Math.min(Math.max(0, now), MAX_SAVED_AT), rev: 1, by };
  const [at, rev] = orderKey(base);
  return { savedAt: Math.min(Math.max(now, at + 1), MAX_SAVED_AT), rev: Math.min(rev + 1, MAX_REV), by };
}
function fillKey(o: JObj): void {
  const [at, rev, by] = orderKey(o);
  o.savedAt = at;
  o.rev = rev;
  o.by = by;
}

export type Read = { kind: "ignore" } | { kind: "newer"; doc: JObj } | { kind: "ok"; doc: JObj };

// ---- dev.tinhat.theme (§3) ----------------------------------------------------------------------------------------
/** §3.2: ignore | newer (render best-effort, never write) | ok — `doc` is a defaults-filled copy. */
export function readChoice(value: unknown): Read {
  const v = asData(value);
  if (!isObj(v) || get(v, "format") !== CHOICE_FORMAT) return { kind: "ignore" };
  const ver = get(v, "v");
  if (typeof ver !== "number") return { kind: "ignore" };
  if (ver > 1) return { kind: "newer", doc: fillChoice(v) };
  if (ver !== 1) return { kind: "ignore" };
  const theme = get(v, "theme");
  if (typeof theme !== "string" || !isThemeId(theme)) return { kind: "ignore" };
  return { kind: "ok", doc: fillChoice(v) };
}
function fillChoice(v: JObj): JObj {
  const d = clone(v);
  fillKey(d);
  if (has(d, "previous") && !isObj(d.previous)) delete d.previous;
  return d;
}
/** The content of a choice (§3.1): every key but format, v, savedAt, rev, by, previous. */
export function choiceContent(doc: JObj): JObj {
  const c = obj();
  for (const k of Object.keys(doc)) if (!CHOICE_META.has(k)) c[k] = clone(doc[k]);
  return c;
}
export type SaveChoice = { entry: JObj } | { noop: true } | { error: string };
/** §3.3 — a new choice document from `patch` over the current one (or over `fallback` = what the device renders). */
export function saveChoice(raw: unknown, known: JObj | null, patch: unknown, fallback: unknown, now: number, by: string): SaveChoice {
  const r = readChoice(raw);
  if (r.kind === "newer") return { error: "newer-format" };
  const k = known ? readChoice(known) : ({ kind: "ignore" } as Read);
  const base = higher(k.kind === "ok" ? k.doc : null, r.kind === "ok" ? r.doc : null);
  const p = asData(patch);
  if (!isObj(p) || Object.keys(p).some((key) => !(PATCH_KEYS as readonly string[]).includes(key))) return { error: "bad-request" };
  const start: JObj = base ? choiceContent(base) : isObj(fallback) ? choiceContent(clone(fallback as JObj)) : obj();
  const next = applyPatch(start, p);
  const bad = checkContent(next);
  if (bad) return { error: bad };
  if (sameJson(next, start)) return { noop: true };
  const entry = obj();
  for (const key of Object.keys(next)) entry[key] = next[key];
  entry.format = CHOICE_FORMAT;
  entry.v = 1;
  Object.assign(entry, stamps(base, now, by));
  if (base) {
    const prev = clone(base);
    delete prev.previous;
    delete prev.format;
    delete prev.v;
    entry.previous = prev;
  }
  if (bytesOf(entry) > MAX_DOC_BYTES) {
    delete entry.previous;
    if (bytesOf(entry) > MAX_DOC_BYTES) return { error: "too-large" };
  }
  return { entry };
}
/**
 * A choice content with a patch applied (§3.3): a present key sets that content key (`null` removes it); a patch that
 * sets `theme` to another id also removes `doc` and `overrides` unless it sets them. Keys outside PATCH_KEYS are ignored
 * here (saveChoice refuses them). A copy; the device override (§7) uses the same rule.
 */
export function applyPatch(start: JObj, patch: JObj): JObj {
  const next = clone(start);
  if (has(patch, "theme") && patch.theme !== get(start, "theme")) {
    if (!has(patch, "doc")) delete next.doc;
    if (!has(patch, "overrides")) delete next.overrides;
  }
  for (const key of PATCH_KEYS) {
    if (!has(patch, key)) continue;
    if (patch[key] === null) delete next[key];
    else next[key] = clone(patch[key]);
  }
  return next;
}
/** The content's check (§3.3): null when it is a valid choice content, else the error code. */
export function checkContent(c: JObj): string | null {
  const theme = get(c, "theme");
  if (typeof theme !== "string" || !isThemeId(theme)) return "bad-request";
  const doc = get(c, "doc");
  if (doc !== undefined && (!isObj(doc) || get(doc, "id") !== theme)) return "bad-request";
  const ov = get(c, "overrides");
  if (ov !== undefined) {
    if (!isObj(ov)) return "bad-request";
    for (const part of ["roles", "tokens"]) {
      const m = get(ov, part);
      if (m === undefined) continue;
      if (!isObj(m) || Object.keys(m).some((key) => typeof m[key] !== "string")) return "bad-request";
    }
  }
  for (const key of ["sounds", "icons"]) {
    const v = get(c, key);
    if (v !== undefined && !isPackId(v)) return "bad-request";
  }
  if (doc !== undefined && bytesOf(doc) > MAX_THEME_BYTES) return "theme-too-large";
  return null;
}

export type ChoiceSource = "doc" | "library" | "none";
export interface ChoiceProjection {
  source: ChoiceSource;
  /** the theme document to resolve (overrides laid over when `overrides` = "applied"), null when source = "none" */
  theme: JObj | null;
  themeId: string | null;
  overrides: "applied" | "none" | "refused";
  sounds: SoundPack;
  icons: IconStyle;
  /** the pack ids as stored (an unknown id is kept on the next save and rendered as the default) */
  soundsRaw: string | null;
  iconsRaw: string | null;
}
/**
 * §3.4 — what a device renders for a choice (ok or newer) or any content object (a local choice, the legacy choice).
 * `library(id)` = the built-in library's document; `resolves(theme)` = the engine accepts it (resolveForApp ok).
 */
export function projectChoice(content: JObj, library: (id: string) => JObj | undefined, resolves: (theme: JObj) => boolean): ChoiceProjection {
  const id = get(content, "theme");
  const themeId = typeof id === "string" && isThemeId(id) ? id : null;
  const doc = get(content, "doc");
  const soundsRaw = isPackId(get(content, "sounds")) ? (get(content, "sounds") as string) : null;
  const iconsRaw = isPackId(get(content, "icons")) ? (get(content, "icons") as string) : null;
  const out: ChoiceProjection = {
    source: "none",
    theme: null,
    themeId,
    overrides: "none",
    sounds: soundsRaw === "goose" ? "goose" : "default",
    icons: iconsRaw === "mono" ? "mono" : "duotone",
    soundsRaw,
    iconsRaw,
  };
  let base: JObj | undefined;
  if (isObj(doc)) {
    base = doc;
    out.source = "doc";
  } else if (themeId && library(themeId)) {
    base = library(themeId);
    out.source = "library";
  }
  if (!base) return out;
  const ov = get(content, "overrides");
  const layered = isObj(ov) ? layOverrides(base, ov) : null;
  if (layered && resolves(layered)) {
    out.theme = layered;
    out.overrides = "applied";
    return out;
  }
  if (resolves(base)) {
    out.theme = clone(base);
    out.overrides = layered ? "refused" : "none";
    return out;
  }
  out.source = "none";
  out.overrides = layered ? "refused" : "none";
  return out;
}
/** The theme with `overrides.roles` / `.tokens` string values laid over its own (null when there is nothing to lay). */
export function layOverrides(theme: JObj, ov: JObj): JObj | null {
  let any = false;
  const t = clone(theme);
  for (const part of ["roles", "tokens"]) {
    const m = get(ov, part);
    if (!isObj(m)) continue;
    const own = get(t, part);
    const into = isObj(own) ? own : obj();
    for (const key of Object.keys(m)) {
      if (typeof m[key] !== "string") continue;
      into[key] = m[key];
      any = true;
    }
    t[part] = into;
  }
  return any ? t : null;
}

// ---- dev.tinhat.themes (§4) ---------------------------------------------------------------------------------------
export const isLive = (e: JObj): boolean => get(e, "deleted") !== true;
export function entryId(e: unknown): string | null {
  if (!isObj(e)) return null;
  const id = get(e, "id");
  return typeof id === "string" && isThemeId(id) ? id : null;
}
/** §4.2 defaults filled (a copy). */
export function fillEntry(e: JObj): JObj {
  const d = clone(e);
  fillKey(d);
  if (get(d, "deleted") === true) {
    delete d.theme;
    delete d.previous;
    return d;
  }
  if (has(d, "deleted")) delete d.deleted;
  const prev = get(d, "previous");
  if (prev !== undefined) {
    if (!isObj(prev) || !isObj(get(prev, "theme"))) delete d.previous;
    else if (has(prev, "previous")) delete prev.previous;
  }
  return d;
}
/** §4.3: ignore | newer | ok. */
export function readThemes(value: unknown): Read {
  const v = asData(value);
  if (!isObj(v) || get(v, "format") !== THEMES_FORMAT) return { kind: "ignore" };
  const ver = get(v, "v");
  if (typeof ver !== "number") return { kind: "ignore" };
  if (ver > 1) return { kind: "newer", doc: v };
  if (ver !== 1) return { kind: "ignore" };
  return { kind: "ok", doc: v };
}
/** The entries of a document (any object's `themes` array): valid ids, defaults filled, the higher per repeated id. */
export function entriesOf(doc: unknown): Map<string, JObj> {
  const out = new Map<string, JObj>();
  if (!isObj(doc)) return out;
  const arr = get(doc, "themes");
  if (!Array.isArray(arr)) return out;
  for (const e of arr) {
    const id = entryId(e);
    if (!id) continue;
    out.set(id, higher(out.get(id), fillEntry(e as JObj))!);
  }
  return out;
}
/** §4.3 the list the UI shows: live entries whose theme object carries the entry's id, newest first. */
export function listThemes(doc: unknown): JObj[] {
  const live = [...entriesOf(doc).values()].filter((e) => isLive(e) && isObj(get(e, "theme")) && get(get(e, "theme") as JObj, "id") === get(e, "id"));
  return live.sort((a, b) => orderKey(b)[0] - orderKey(a)[0] || cmpCodePoint(get(a, "id") as string, get(b, "id") as string));
}
export type KnownThemes = Record<string, JObj>;
/** The valid entries of a `known` map (every value whose `id` is valid, under that id — the map's own keys unused). */
function knownEntries(known: KnownThemes | null | undefined): JObj[] {
  if (!known) return [];
  const out: JObj[] = [];
  for (const k of Object.keys(known)) {
    const e = known[k];
    if (entryId(e)) out.push(fillEntry(e));
  }
  return out;
}
/** §4.5 — the join of raw's entries and known's, raw's unknown top-level keys kept, tombstones ≤ 64, size rule. */
export function mergeThemes(raw: unknown, known: KnownThemes | null | undefined, justSaved?: string | null): { doc: JObj; tooLarge: boolean } {
  const r = asData(raw);
  const byId = entriesOf(r);
  for (const e of knownEntries(known)) {
    const id = get(e, "id") as string;
    byId.set(id, higher(byId.get(id), e)!);
  }
  const tombs = [...byId.values()].filter((e) => !isLive(e)).sort(cmpDoc);
  for (const t of tombs.slice(0, Math.max(0, tombs.length - MAX_TOMBSTONES))) byId.delete(get(t, "id") as string);
  const doc = obj();
  if (isObj(r)) for (const k of Object.keys(r)) if (k !== "format" && k !== "v" && k !== "themes") doc[k] = clone(r[k]);
  doc.format = THEMES_FORMAT;
  doc.v = 1;
  const ids = [...byId.keys()].sort(cmpCodePoint);
  const entries = ids.map((id) => byId.get(id)!);
  doc.themes = entries;
  if (bytesOf(doc) <= MAX_DOC_BYTES) return { doc, tooLarge: false };
  const victims = entries
    .filter((e) => isLive(e) && has(e, "previous"))
    .sort((a, b) => {
      const ja = get(a, "id") === justSaved ? 1 : 0;
      const jb = get(b, "id") === justSaved ? 1 : 0;
      return ja - jb || cmpDoc(a, b);
    });
  for (const e of victims) {
    delete e.previous;
    if (bytesOf(doc) <= MAX_DOC_BYTES) return { doc, tooLarge: false };
  }
  return { doc, tooLarge: true };
}
export type SaveTheme = { entry: JObj; doc: JObj } | { noop: true } | { error: string };
export interface SaveThemeRequest {
  id: string;
  theme?: Json;
  deleted?: boolean;
  now: number;
  by: string;
}
/** §4.4 — a new entry (a save or a delete) and the document to put. */
export function saveTheme(raw: unknown, known: KnownThemes | null | undefined, req: SaveThemeRequest): SaveTheme {
  const r = readThemes(raw);
  if (r.kind === "newer") return { error: "newer-format" };
  const q = req as unknown as JObj;
  const id = get(q, "id");
  if (typeof id !== "string" || !isThemeId(id)) return { error: "bad-request" };
  const del = get(q, "deleted") === true;
  const theme = asData(get(q, "theme"));
  if (!del && (!isObj(theme) || get(theme, "id") !== id)) return { error: "bad-request" };
  if (!del && bytesOf(theme as JObj) > MAX_THEME_BYTES) return { error: "theme-too-large" };
  const now = get(q, "now") as number;
  const by = get(q, "by") as string;
  const knownE = knownEntries(known).filter((e) => get(e, "id") === id);
  const base = higher(knownE.reduce<JObj | null>((a, e) => higher(a, e), null), entriesOf(r.kind === "ok" ? r.doc : undefined).get(id) ?? null);
  const unknownKeys = (e: JObj): JObj => {
    const o = obj();
    for (const k of Object.keys(e)) if (!["id", "savedAt", "rev", "by", "theme", "deleted", "previous"].includes(k)) o[k] = clone(e[k]);
    return o;
  };
  let entry: JObj;
  if (del) {
    if (!base || !isLive(base)) return { noop: true };
    entry = Object.assign(unknownKeys(base), { id, ...stamps(base, now, by), deleted: true });
  } else {
    if (base && isLive(base) && sameJson(get(base, "theme"), theme)) return { noop: true };
    if (!base || !isLive(base)) {
      const merged = mergeThemes(raw, known).doc;
      const others = entriesOf(merged);
      let live = 0;
      for (const [k, e] of others) if (k !== id && isLive(e)) live++;
      if (live >= MAX_THEMES) return { error: "too-many" };
    }
    entry = Object.assign(unknownKeys(base ?? obj()), { id, ...stamps(base, now, by), theme: clone(theme as JObj) });
    if (base && isLive(base) && isObj(get(base, "theme"))) {
      const [at, rev, b] = orderKey(base);
      const prev = obj();
      prev.savedAt = at;
      prev.rev = rev;
      prev.by = b;
      prev.theme = clone(get(base, "theme") as JObj);
      entry.previous = prev;
    }
  }
  const nextKnown: KnownThemes = Object.create(null);
  for (const e of knownEntries(known)) nextKnown[get(e, "id") as string] = higher(nextKnown[get(e, "id") as string], e)!;
  nextKnown[id] = entry;
  const m = mergeThemes(raw, nextKnown, id);
  if (m.tooLarge) return { error: "too-large" };
  return { entry, doc: m.doc };
}
/** A My-themes id for a new theme: `base` (a slug) made unique against the library and the ids in use (§4.1). */
export function uniqueThemeId(base: string, taken: (id: string) => boolean): string {
  const b = isThemeId(base) ? base : "theme";
  if (!taken(b)) return b;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const id = b.slice(0, 64 - tail.length).replace(/-+$/, "") + tail;
    if (isThemeId(id) && !taken(id)) return id;
  }
}

// ---- the device protocol (§3.5, §4.6) ------------------------------------------------------------------------------
export interface ChoiceState {
  known: JObj | null;
  raw: Json | null;
  readOnly: boolean;
  wantPut: boolean;
}
export interface ThemesState {
  known: KnownThemes;
  raw: Json | null;
  readOnly: boolean;
  wantPut: boolean;
  justSaved: string | null;
}
export const emptyChoiceState = (): ChoiceState => ({ known: null, raw: null, readOnly: false, wantPut: false });
export const emptyThemesState = (): ThemesState => ({ known: Object.create(null), raw: null, readOnly: false, wantPut: false, justSaved: null });

/** apply(patch): `saved` | `noop` | `read-only` | an error code. Mutates `s`. */
export function choiceApply(s: ChoiceState, patch: unknown, fallback: unknown, now: number, by: string): string {
  if (s.readOnly) return "read-only";
  const r = saveChoice(s.raw, s.known, patch, fallback, now, by);
  if ("error" in r) return r.error;
  if ("noop" in r) return "noop";
  s.known = r.entry;
  s.wantPut = true;
  return "saved";
}
/** put: the document to PUT (and `wantPut` cleared), or null (`idle`). */
export function choicePut(s: ChoiceState): JObj | null {
  if (!s.wantPut || s.readOnly || !s.known) return null;
  s.wantPut = false;
  return clone(s.known);
}
/** receive(D): `ignored` | `read-only` | `new` (the first choice this device knows) | `changed` | `reassert` | `ok`. */
export function choiceReceive(s: ChoiceState, value: unknown): string {
  const r = readChoice(value);
  if (r.kind === "ignore") return "ignored";
  if (r.kind === "newer") {
    s.readOnly = true;
    s.raw = asData(value) ?? null;
    return "read-only";
  }
  s.readOnly = false;
  s.raw = asData(value) ?? null;
  const d = r.doc;
  const k = s.known ? readChoice(s.known) : ({ kind: "ignore" } as Read);
  const known = k.kind === "ok" ? k.doc : null;
  if (!known) {
    s.known = d;
    return "new";
  }
  if (cmpDoc(d, known) > 0) {
    const changed = !sameJson(choiceContent(d), choiceContent(known));
    s.known = d;
    return changed ? "changed" : "ok";
  }
  if (cmpDoc(known, d) > 0) {
    s.wantPut = true;
    return "reassert";
  }
  return "ok";
}

/** save / delete of one of My themes: `saved` | `noop` | `read-only` | an error code. Mutates `s`. */
export function themesSave(s: ThemesState, req: SaveThemeRequest): string {
  if (s.readOnly) return "read-only";
  const r = saveTheme(s.raw, s.known, req);
  if ("error" in r) return r.error;
  if ("noop" in r) return "noop";
  s.known[req.id] = r.entry;
  s.wantPut = true;
  s.justSaved = req.id;
  return "saved";
}
export function themesPut(s: ThemesState): JObj | null {
  if (!s.wantPut || s.readOnly) return null;
  const doc = mergeThemes(s.raw, s.known, s.justSaved).doc;
  s.wantPut = false;
  s.justSaved = null;
  return doc;
}
export function themesReceive(s: ThemesState, value: unknown): string {
  const r = readThemes(value);
  if (r.kind === "ignore") return "ignored";
  if (r.kind === "newer") {
    s.readOnly = true;
    s.raw = asData(value) ?? null;
    return "read-only";
  }
  s.readOnly = false;
  s.raw = r.doc;
  for (const [id, e] of entriesOf(r.doc)) s.known[id] = higher(s.known[id] ? fillEntry(s.known[id]) : null, e)!;
  if (!sameJson(mergeThemes(r.doc, s.known).doc, r.doc)) {
    s.wantPut = true;
    return "reassert";
  }
  return "ok";
}
/** The re-assert delay (§6): 0–2000 ms from a hash of the device id (FNV-1a over UTF-16 code units). */
export function reassertDelayMs(deviceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2001;
}
/** The retry schedule (§6): 1, 2, 4 … s, capped at 5 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(Math.max(0, attempt), 20), 300_000);
}

// ---- the legacy choice (§8) ----------------------------------------------------------------------------------------
/** The device's pre-11.0 theme setting as a choice content: "goose" → Goose + its sounds, anything else → OLED. */
export function legacyChoice(saved: string | null | undefined): JObj {
  const c = obj();
  const goose = saved === "goose";
  c.theme = goose ? "goose" : "oled";
  c.sounds = goose ? "goose" : "default";
  c.icons = "duotone";
  return c;
}

// ---- the vector simulator (THEMES-SYNC §10 "sync") -----------------------------------------------------------------
export interface SimDevice {
  choice: ChoiceState;
  themes: ThemesState;
  legacy: JObj;
}
export interface SimResult {
  log: string[];
  server: JObj;
  devices: JObj;
}
/** Plays a `sync` vector: devices (their id = their name) and one server holding the two documents. */
export function simulate(vector: unknown): SimResult {
  const v = asData(vector) as JObj;
  const names = (Array.isArray(get(v, "devices")) ? (get(v, "devices") as Json[]) : []).filter((n): n is string => typeof n === "string");
  const legacy = isObj(get(v, "legacy")) ? (get(v, "legacy") as JObj) : obj();
  const dev = new Map<string, SimDevice>();
  for (const n of names) dev.set(n, { choice: emptyChoiceState(), themes: emptyThemesState(), legacy: legacyChoice(typeof legacy[n] === "string" ? (legacy[n] as string) : null) });
  const srv = isObj(get(v, "server")) ? (get(v, "server") as JObj) : obj();
  const server: Record<"choice" | "themes", Json | null> = {
    choice: get(srv, "choice") !== undefined ? clone(get(srv, "choice") as Json) : null,
    themes: get(srv, "themes") !== undefined ? clone(get(srv, "themes") as Json) : null,
  };
  const log: string[] = [];
  const steps = Array.isArray(get(v, "steps")) ? (get(v, "steps") as Json[]) : [];
  steps.forEach((raw, i) => {
    const st = isObj(raw) ? raw : obj();
    const name = typeof get(st, "device") === "string" ? (get(st, "device") as string) : null;
    const ev = typeof get(st, "event") === "string" ? (get(st, "event") as string) : "";
    const keyArg = get(st, "key");
    const key: "choice" | "themes" | null = keyArg === "choice" || keyArg === "themes" ? keyArg : null;
    const d = name ? dev.get(name) : undefined;
    const line = (k: string, result: string) => log.push(`${i} ${name ?? "-"} ${ev} ${k}: ${result}`);
    const now = get(st, "now") as number;
    if (ev === "serverPut" && key) {
      server[key] = clone((get(st, "doc") ?? null) as Json);
      return line(key, "set");
    }
    if (!d) return line(key ?? "-", "bad-step");
    switch (ev) {
      case "apply":
        return line("choice", choiceApply(d.choice, get(st, "patch"), get(st, "fallback") ?? d.legacy, now, name!));
      case "saveTheme":
        return line("themes", themesSave(d.themes, { id: get(st, "id") as string, theme: get(st, "theme") as Json, now, by: name! }));
      case "deleteTheme":
        return line("themes", themesSave(d.themes, { id: get(st, "id") as string, deleted: true, now, by: name! }));
      case "put": {
        if (!key) return line("-", "bad-step");
        const doc = key === "choice" ? choicePut(d.choice) : themesPut(d.themes);
        if (!doc) return line(key, "idle");
        server[key] = doc;
        return line(key, "put");
      }
      case "deliver":
        if (!key) return line("-", "bad-step");
        return line(key, key === "choice" ? choiceReceive(d.choice, server.choice) : themesReceive(d.themes, server.themes));
      case "incoming":
        if (!key) return line("-", "bad-step");
        return line(key, key === "choice" ? choiceReceive(d.choice, get(st, "doc")) : themesReceive(d.themes, get(st, "doc")));
      default:
        return line(key ?? "-", "bad-step");
    }
  });
  const devices = obj();
  for (const [n, d] of dev) {
    const known = obj();
    for (const id of Object.keys(d.themes.known).sort(cmpCodePoint)) known[id] = clone(d.themes.known[id]);
    const c = obj();
    c.known = clone(d.choice.known);
    c.raw = clone(d.choice.raw);
    c.readOnly = d.choice.readOnly;
    c.wantPut = d.choice.wantPut;
    const t = obj();
    t.known = known;
    t.raw = clone(d.themes.raw);
    t.readOnly = d.themes.readOnly;
    t.wantPut = d.themes.wantPut;
    t.justSaved = d.themes.justSaved;
    const o = obj();
    o.choice = c;
    o.themes = t;
    devices[n] = o;
  }
  const s = obj();
  s.choice = server.choice;
  s.themes = server.themes;
  return { log, server: s, devices };
}

// themeLibrary.ts — the built-in theme library (src/theme/themes-library.json = contract themes-library.json: 1,190
// themes — iTerm2-Color-Schemes + tinted-theming base16/base24 + OLED and Goose; licences THIRD-PARTY.md), loaded on
// demand as its own chunk (≈ 490 KB, never in the boot path: the active theme's document is cached by the theme store).
//
// Per theme a small index entry for the gallery: name, author, variant (dark ⇔ Y(bg) < Y(fg), ENGINE §5 — computed from
// the palette without a full resolve), whether it is a favourite, the lower-cased search text. Card miniatures resolve
// only their roles (miniRoles: resolveTheme(theme, NO_TOKENS), ~0.1 ms) when a card is drawn, cached.
import { useSyncExternalStore } from "react";
import { BUILTINS, NO_TOKENS, resolveTheme, type Theme, type Variant } from "../theme/engine";
import { canonJson, cmpCodePoint } from "../theme/canon";
import { parseLiteral } from "../theme/literal";
import { luminance } from "../theme/maths";
import { cssColour } from "./themeNames";

export interface LibraryEntry {
  id: string;
  name: string;
  author: string | null;
  variant: Variant;
  favourite: boolean;
  /** lower-cased "name author id" for the search (THEMES-UI.md §4) */
  search: string;
  doc: Theme;
}
export interface Library {
  /** every theme, sorted by name (lower-cased, code-point order), then id */
  all: LibraryEntry[];
  /** the favourites in the library's order */
  favourites: LibraryEntry[];
  byId: Map<string, LibraryEntry>;
}

let lib: Library | null = null;
let loading: Promise<Library> | null = null;
const listeners = new Set<() => void>();

/** A document's variant as the engine decides it (ENGINE §4/§5), without resolving: the theme's own, else palette
 *  luminance (bg vs fg), else a full roles-only resolve (roles-only themes without a variant). */
export function variantOf(doc: Theme): Variant {
  if (doc.variant === "dark" || doc.variant === "light") return doc.variant;
  const bg = doc.palette ? parseLiteral(doc.palette.bg) : null;
  const fg = doc.palette ? parseLiteral(doc.palette.fg) : null;
  if (bg && fg) return luminance(bg) < luminance(fg) ? "dark" : "light";
  const r = resolveTheme(doc, NO_TOKENS);
  return r.ok ? r.variant : "dark";
}

export function entryOf(doc: Theme, favourite = false): LibraryEntry {
  const author = typeof doc.author === "string" && doc.author.trim() ? doc.author.trim() : null;
  return {
    id: doc.id,
    name: doc.name,
    author,
    variant: variantOf(doc),
    favourite,
    search: `${doc.name} ${author ?? ""} ${doc.id}`.toLowerCase(),
    doc,
  };
}

export function sortByName(a: LibraryEntry, b: LibraryEntry): number {
  return cmpCodePoint(a.name.toLowerCase(), b.name.toLowerCase()) || cmpCodePoint(a.id, b.id);
}

/** Load the library (once; the same promise for every caller). */
export function loadLibrary(): Promise<Library> {
  if (lib) return Promise.resolve(lib);
  if (!loading) {
    loading = import("../theme/themes-library.json")
      .then((m) => {
        const data = (m as { default: { themes: Theme[]; favourites: string[] } }).default;
        const fav = new Set(data.favourites);
        const byId = new Map<string, LibraryEntry>();
        for (const t of data.themes) byId.set(t.id, entryOf(t, fav.has(t.id)));
        const all = [...byId.values()].sort(sortByName);
        const favourites = data.favourites.map((id) => byId.get(id)).filter((e): e is LibraryEntry => !!e);
        lib = { all, favourites, byId };
        for (const l of listeners) l();
        return lib;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

/** The library if it is loaded (null until then). */
export function libraryNow(): Library | null {
  return lib;
}

/** A library theme's document — the built-ins answer before the library chunk is loaded. */
export function libraryDoc(id: string): Theme | undefined {
  if (lib) return lib.byId.get(id)?.doc;
  return Object.prototype.hasOwnProperty.call(BUILTINS, id) ? BUILTINS[id] : undefined;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!lib) void loadLibrary().catch(() => {});
  return () => listeners.delete(cb);
}
const snapshot = () => lib;

/** React: the library (starts loading it; null until it is in). */
export function useLibrary(): Library | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ---- card miniatures ----------------------------------------------------------------------------------------------

/** The 17 roles a card miniature paints (THEMES-UI.md §5.1), as CSS colours. */
export const MINI_ROLES = [
  "surface.window",
  "surface.island",
  "surface.raised",
  "surface.selected",
  "border.subtle",
  "text.primary",
  "text.secondary",
  "text.onAccent",
  "accent.base",
  "accent.bright",
  "name.1",
  "name.2",
  "name.3",
  "name.4",
  "name.5",
] as const;
export type MiniRole = (typeof MINI_ROLES)[number];
export interface Mini {
  ok: boolean;
  /** role → CSS colour (empty when the engine refuses the theme) */
  roles: Record<MiniRole, string>;
  variant: Variant;
  adjusted: number;
  error: string | null;
}

const miniCache = new Map<string, Mini>();
/** A card's colours: roles only, cached per document (library themes by id, others by their canonical text). */
export function miniRoles(doc: Theme, libraryTheme = false): Mini {
  const key = libraryTheme ? `lib:${doc.id}` : canonJson(doc);
  let m = miniCache.get(key);
  if (!m) {
    const r = resolveTheme(doc, NO_TOKENS);
    if (r.ok) {
      const roles = {} as Record<MiniRole, string>;
      for (const id of MINI_ROLES) roles[id] = cssColour(r.roles[id]);
      m = { ok: true, roles, variant: r.variant, adjusted: r.adjusted.length, error: null };
    } else m = { ok: false, roles: {} as Record<MiniRole, string>, variant: "dark", adjusted: 0, error: r.error };
    if (miniCache.size > 4000) miniCache.clear();
    miniCache.set(key, m);
  }
  return m;
}

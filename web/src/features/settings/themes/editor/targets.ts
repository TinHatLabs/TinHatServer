// targets.ts — what a swatch / row of the theme editor edits (THEMES-UI.md §13.7–§13.9): the stored value in the
// working document, its resolved colour, the base's value (Reset), the op that sets it, and whether it changed.
import type { EditOp } from "@/theme/editor";
import type { JObj } from "@/theme/sync";
import { paletteLabel, roleLabel, tokenLabel } from "@/theme/labels";
import { BLACK, formatColour, parseLiteral } from "@/theme/literal";
import { sourceValue } from "@/theme/palette";

export type ColourTarget =
  | { kind: "background" }
  | { kind: "accent" }
  | { kind: "palette"; id: string }
  | { kind: "role"; id: string }
  | { kind: "token"; id: string }
  /** Simple (palette.ts): a swatch, by its first source; `whole` = move its group (the lead only) */
  | { kind: "swatch"; id: string; group: string; whole: boolean; label: string };

export type Resolved = { roles: Record<string, string>; tokens: Record<string, string> };

const isObj = (v: unknown): v is JObj => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const hasPalette = (doc: JObj): boolean => isObj(doc.palette);

/** The value the document stores for a target (a literal or an expression), or null when it has none of its own. */
export function storedValue(doc: JObj, t: ColourTarget): string | null {
  switch (t.kind) {
    case "background":
      return hasPalette(doc) ? String((doc.palette as JObj).bg) : storedValue(doc, { kind: "role", id: "surface.island" });
    case "accent":
      return hasPalette(doc) ? (typeof doc.accent === "string" ? doc.accent : null) : storedValue(doc, { kind: "role", id: "accent.base" });
    case "palette": {
      const p = doc.palette;
      if (!isObj(p)) return null;
      const m = /^c(\d{1,2})$/.exec(t.id);
      if (m) {
        const a = p.ansi;
        return Array.isArray(a) && typeof a[Number(m[1])] === "string" ? (a[Number(m[1])] as string) : null;
      }
      return has(p, t.id) && typeof p[t.id] === "string" ? (p[t.id] as string) : null;
    }
    case "swatch":
      return sourceValue(doc, t.id);
    case "role":
    case "token": {
      const o = doc[t.kind === "role" ? "roles" : "tokens"];
      return isObj(o) && has(o, t.id) && typeof o[t.id] === "string" ? (o[t.id] as string) : null;
    }
  }
}

/** The resolved (canonical) colour a target paints with in the working document. */
export function resolvedValue(res: Resolved, doc: JObj, t: ColourTarget): string {
  switch (t.kind) {
    case "background":
      return res.roles["surface.island"];
    case "accent":
      return res.roles["accent.base"];
    case "palette":
      return storedValue(doc, t) ?? formatColour(BLACK);
    case "role":
      return res.roles[t.id];
    case "token":
      return res.tokens[t.id];
    case "swatch": {
      const c = parseLiteral(sourceValue(doc, t.id) ?? "");
      return c ? formatColour(c) : formatColour(BLACK);
    }
  }
}

/** The op that sets a target (null clears it where that is allowed). */
export function opFor(t: ColourTarget, value: string | null): EditOp {
  switch (t.kind) {
    case "background":
      return { op: "background", value: value ?? "" };
    case "accent":
      return { op: "accent", value: value ?? "" };
    case "palette":
      return { op: "palette", slot: t.id, value };
    case "role":
      return { op: "role", id: t.id, value };
    case "token":
      return { op: "token", id: t.id, value };
    case "swatch":
      return t.whole ? { op: "group", id: t.group, value: value ?? "" } : { op: "swatch", id: t.id, value: value ?? "" };
  }
}

/** Reset (§13.9): back to the base's value — its own, or none (then the default / the derivation). */
export function resetOp(base: JObj, t: ColourTarget): EditOp {
  // a swatch resets on its own (its group stays where it is)
  if (t.kind === "swatch") {
    // Simple edits colour only: the base's RGB (its alpha stays the source's own, editor.ts writeSwatch)
    const c = parseLiteral(storedValue(base, t) ?? "");
    return opFor({ ...t, whole: false }, c ? formatColour({ ...c, a: 1 }) : null);
  }
  return opFor(t, storedValue(base, t));
}

export const isChanged = (doc: JObj, base: JObj, t: ColourTarget): boolean => storedValue(doc, t) !== storedValue(base, t);

/** "Use default" is offered for an override of a token, or of a role of a palette theme. */
export const canUseDefault = (doc: JObj, t: ColourTarget): boolean =>
  (t.kind === "token" || (t.kind === "role" && hasPalette(doc))) && storedValue(doc, t) !== null;

/** Colours only: palette slots, the background and the accent must be opaque; roles and tokens may be translucent. */
export const alphaAllowed = (t: ColourTarget): boolean => t.kind === "role" || t.kind === "token";

export function targetLabel(t: ColourTarget): string {
  switch (t.kind) {
    case "background":
      return "Background";
    case "accent":
      return "Accent";
    case "palette":
      return paletteLabel(t.id);
    case "role":
      return roleLabel(t.id);
    case "token":
      return tokenLabel(t.id);
    case "swatch":
      return t.label;
  }
}
export const targetId = (t: ColourTarget): string => (t.kind === "background" ? "palette bg" : t.kind === "accent" ? "accent" : t.id);
export const targetKey = (t: ColourTarget): string => `${t.kind}:${"id" in t ? t.id : ""}`;

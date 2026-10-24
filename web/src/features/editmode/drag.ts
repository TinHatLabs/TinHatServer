// drag.ts — a move in progress (EDITMODE-UI §5, §11): the dragged island (placed, or hidden — from the Add island drawer),
// its drop zones (LAYOUT §8.3: `hit` order for the pointer, `keys` order for the arrow keys) computed ONCE at the start,
// the zone under the pointer / the keyboard's current zone, and the landing preview (the working copy with that zone's
// operation applied, solved with the same inputs) computed when the zone changes — never per pointer move.
import { create } from "zustand";
import { applyOp, dropZones, solve, type JObj, type Json, type Zone } from "@/layout";
import { get, isObj } from "@/layout/json";
import type { Rect } from "@/layout/solve";
import { editApply, useEdit } from "./store";
import { islandText } from "./names";
import { isKnownRef } from "@/layout/schema";

/** The solve inputs of the rendered working copy (the dock host's last solve). */
export interface SolveCtx {
  size: { w: number; h: number };
  unitPm: number;
  shape: Json | null;
  content: Json;
  view: Json | null;
}

export interface DragState {
  ref: string;
  /** "pointer": `hit` order, hover by position · "keys": `keys` order, hover by the arrows */
  mode: "pointer" | "keys";
  zones: Zone[];
  hover: number;
  preview: Rect | null;
  /** the pointer (client px) — the ghost */
  px: number;
  py: number;
  ctx: SolveCtx;
  form: JObj;
}

export const useDrag = create<{ drag: DragState | null; announce: string }>()(() => ({ drag: null, announce: "" }));

const ctxJson = (c: SolveCtx): Json => {
  const o: JObj = Object.create(null);
  o["size"] = { w: c.size.w, h: c.size.h } as unknown as Json;
  o["unitPm"] = c.unitPm;
  if (c.shape) o["shape"] = c.shape;
  o["content"] = c.content;
  if (c.view) o["view"] = c.view;
  return JSON.parse(JSON.stringify(o)) as Json;
};

/** Start a move of `ref` (a placed island or a hidden one). Answers false when it has no zones. */
export function beginDrag(ref: string, mode: "pointer" | "keys", ctx: SolveCtx, px = 0, py = 0): boolean {
  const st = useEdit.getState();
  const s = st.session;
  if (!s || st.readOnly || s.kind !== "desktop") return false;
  const z = dropZones(s.form, ctxJson(ctx), ref);
  const zones = mode === "keys" ? z.keys : z.hit;
  if (!zones.length) return false;
  const d: DragState = { ref, mode, zones, hover: -1, preview: null, px, py, ctx, form: s.form };
  useDrag.setState({ drag: d, announce: `${islandText(ref).name} picked up` });
  if (mode === "keys") setHover(0);
  return true;
}

function previewFor(d: DragState, i: number): Rect | null {
  const z = d.zones[i];
  if (!z) return null;
  const r = applyOp(d.form, z.op);
  if (!r.ok) return null;
  const o = solve(r.form, d.ctx.size as never, d.ctx.unitPm, d.ctx.shape ?? undefined, d.ctx.content, d.ctx.view ?? undefined);
  const ir = o.islands[d.ref];
  return ir && ir.w > 0 && ir.h > 0 ? { x: ir.x, y: ir.y, w: ir.w, h: ir.h } : null;
}

export function setHover(i: number): void {
  const d = useDrag.getState().drag;
  if (!d || i === d.hover) return;
  const preview = i >= 0 ? previewFor(d, i) : null;
  useDrag.setState({ drag: { ...d, hover: i, preview }, announce: i >= 0 ? zoneText(d.zones[i]) : "" });
}

/** The pointer moved (host-relative x, y; client px for the ghost). `skip` = a rect the hit test ignores (the toolbar). */
export function movePointer(x: number, y: number, cx: number, cy: number, skip?: Rect | null): void {
  const d = useDrag.getState().drag;
  if (!d) return;
  let hit = -1;
  const inSkip = !!skip && x >= skip.x && y >= skip.y && x < skip.x + skip.w && y < skip.y + skip.h;
  if (!inSkip)
    for (let i = 0; i < d.zones.length; i++) {
      const r = d.zones[i].rect;
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) {
        hit = i;
        break;
      }
    }
  if (hit !== d.hover) setHover(hit);
  const nd = useDrag.getState().drag;
  if (nd) useDrag.setState({ drag: { ...nd, px: cx, py: cy } });
}

/** Arrow keys: the previous / next zone in `keys` order (wraps). */
export function stepHover(dir: 1 | -1): void {
  const d = useDrag.getState().drag;
  if (!d || !d.zones.length) return;
  const n = d.zones.length;
  setHover(d.hover < 0 ? 0 : (d.hover + dir + n) % n);
}

/** Drop on the current zone (none → nothing). */
export function dropDrag(): boolean {
  const d = useDrag.getState().drag;
  if (!d) return false;
  const z = d.hover >= 0 ? d.zones[d.hover] : null;
  useDrag.setState({ drag: null });
  if (!z) {
    useDrag.setState({ announce: "Cancelled" });
    return false;
  }
  const r = editApply(z.op);
  useDrag.setState({ announce: r.ok ? "Dropped" : "Cancelled" });
  return r.ok;
}

export function cancelDrag(): void {
  if (!useDrag.getState().drag) return;
  useDrag.setState({ drag: null, announce: "Cancelled" });
}

const SIDE_TEXT: Record<string, string> = { left: "left of", right: "right of", top: "above", bottom: "below" };
const CORNER_TEXT: Record<string, string> = { tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right" };

/** What the live region says for a zone (EDITMODE-UI §11). */
export function zoneText(z: Zone | undefined): string {
  if (!z) return "";
  let op = z.op;
  if (get(op, "op") === "restore" && isObj(get(op, "to"))) op = get(op, "to") as JObj;
  const tk = String(get(op, "target") ?? "");
  const t = isKnownRef(tk) ? islandText(tk).name : "the group";
  switch (z.kind) {
    case "edge":
      return `Dock ${SIDE_TEXT[String(get(op, "side"))] ?? "beside"} ${t}`;
    case "centre":
      return `Stack with ${t} as a tab`;
    case "window":
      return `New ${get(op, "side") === "left" || get(op, "side") === "right" ? "column" : "row"} on the ${String(get(op, "side"))}`;
    case "corner":
      return `Float in the ${CORNER_TEXT[String(get(op, "anchor"))] ?? ""} corner`;
  }
  return "";
}

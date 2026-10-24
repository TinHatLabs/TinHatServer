// dropzones.ts — LAYOUT.md §8.9: the drop zones of a drag, in hit-test order and in keyboard order. A zone is listed
// only when its operation succeeds on the form (so no zone ever promises a drop that would be refused).
import type { JObj, Json } from "./json";
import { clampInt, cmpCp, fdiv, get, isInt, isJsonValue, isObj, isStr, mk, obj } from "./json";
import { findKey, hiddenIndex, isIsland, islandsIn, nodesIn, keyOf } from "./form";
import { applyOp, ctxSolve } from "./ops";
import type { Rect } from "./solve";

export interface Zone {
  kind: "corner" | "window" | "edge" | "centre";
  rect: Rect;
  op: JObj;
}
const CAT = { corner: 0, window: 1, edge: 2, centre: 3 };
const SIDE_ORDER: Record<string, number> = { left: 0, right: 1, top: 2, bottom: 3, tl: 0, tr: 1, bl: 2, br: 3 };

export function dropZones(form: JObj, ctx: Json | undefined, dragged: Json | undefined): { hit: Zone[]; keys: Zone[] } {
  const none = { hit: [], keys: [] };
  // §1.4: a form or ctx outside the input domain → no zones (a missing ctx is a 0 × 0 window: no zones either)
  if (!isStr(dragged) || !isObj(form) || !isJsonValue(form) || (ctx !== undefined && !isJsonValue(ctx))) return none;
  const hidden = hiddenIndex(form, dragged) >= 0;
  const l = findKey(form, dragged);
  if (!l && !hidden) return none;
  const excluded = new Set<string>(l ? nodesIn(l.node).map((n) => keyOf(n) ?? "").concat(islandsIn(l.node)) : [dragged]);
  const det = ctxSolve(form, ctx);
  const c = isObj(ctx) ? ctx : obj();
  const size = get(c, "size");
  const W = isObj(size) && isInt(get(size, "w")) ? clampInt(get(size, "w") as number, 0, 16384) : 0;
  const H = isObj(size) && isInt(get(size, "h")) ? clampInt(get(size, "h") as number, 0, 16384) : 0;
  const host = det.host;
  type Cand = Zone & { target: string; side: string };
  const cands: Cand[] = [];
  const wrap = (op: JObj): JObj => {
    if (!hidden) return op;
    const to = obj();
    for (const k of Object.keys(op)) if (k !== "ref") to[k] = op[k];
    return mk([["op", "restore"], ["ref", dragged], ["to", to]]);
  };
  const add = (kind: Zone["kind"], rect: Rect, op: JObj, target: string, side: string) => {
    if (rect.w <= 0 || rect.h <= 0) return;
    const full = wrap(op);
    if (!applyOp(form, full, ctx).ok) return;
    cands.push({ kind, rect, op: full, target, side });
  };
  const cw = Math.min(48, host.w);
  const chh = Math.min(48, host.h);
  const corners: [string, number, number][] = [
    ["tl", host.x, host.y],
    ["tr", host.x + host.w - cw, host.y],
    ["bl", host.x, host.y + host.h - chh],
    ["br", host.x + host.w - cw, host.y + host.h - chh],
  ];
  for (const [a, x, y] of corners)
    add("corner", { x, y, w: cw, h: chh }, mk([["op", "float"], ["ref", dragged], ["anchor", a], ["dx", 8], ["dy", 8]]), "", a);
  const bw = Math.min(24, W);
  const bh = Math.min(24, H);
  const edges: [string, Rect][] = [
    ["left", { x: 0, y: 0, w: bw, h: H }],
    ["right", { x: W - bw, y: 0, w: bw, h: H }],
    ["top", { x: 0, y: 0, w: W, h: bh }],
    ["bottom", { x: 0, y: H - bh, w: W, h: bh }],
  ];
  for (const [s, r] of edges) add("window", r, mk([["op", "edge"], ["ref", dragged], ["side", s]]), "", s);
  const refs = Object.keys(det.out.islands).sort(cmpCp);
  for (const ref of refs) {
    const t = det.out.islands[ref];
    if (t.z !== 0 || !t.vis || excluded.has(ref)) continue;
    const tl = findKey(form, ref);
    if (!tl || !isIsland(tl.node)) continue;
    const d = Math.min(48, fdiv(t.w, 4));
    const dv = Math.min(48, fdiv(t.h, 4));
    const bands: [string, Rect][] = [
      ["left", { x: t.x, y: t.y, w: d, h: t.h }],
      ["right", { x: t.x + t.w - d, y: t.y, w: d, h: t.h }],
      ["top", { x: t.x, y: t.y, w: t.w, h: dv }],
      ["bottom", { x: t.x, y: t.y + t.h - dv, w: t.w, h: dv }],
    ];
    for (const [s, r] of bands) add("edge", r, mk([["op", "dockBeside"], ["ref", dragged], ["target", ref], ["side", s]]), ref, s);
    add("centre", { x: t.x + d, y: t.y + dv, w: t.w - 2 * d, h: t.h - 2 * dv }, mk([["op", "stackAsTab"], ["ref", dragged], ["target", ref]]), ref, "");
  }
  const area = (z: Cand) => z.rect.w * z.rect.h;
  const tie = (p: Cand, q: Cand) => cmpCp(p.target, q.target) || (SIDE_ORDER[p.side] ?? 0) - (SIDE_ORDER[q.side] ?? 0);
  const hit = cands
    .slice()
    .sort((p, q) => CAT[p.kind] - CAT[q.kind] || area(p) - area(q) || p.rect.y - q.rect.y || p.rect.x - q.rect.x || tie(p, q));
  const keys = cands
    .slice()
    .sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x || CAT[p.kind] - CAT[q.kind] || area(p) - area(q) || tie(p, q));
  const strip = (z: Cand): Zone => ({ kind: z.kind, rect: z.rect, op: z.op });
  return { hit: hit.map(strip), keys: keys.map(strip) };
}

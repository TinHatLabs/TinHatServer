// pick.ts — the Pick tool's sampling on the web (THEMES-UI.md §15.2): the elements under a point (the editor panel and
// the pick overlay left out), the top one and its ancestors (≤ 8 layers); each one's colour properties read in a real
// pass and in a PROBE pass (every `--th-*` variable set to its probe colour, src/theme/probe.ts) inside one task —
// styles are recalculated but never painted in between; transitions and animations are off for the pass and the real
// values are recomputed before they come back on, so nothing animates from a probe colour. A property counts when its
// probe value differs from its real value and decodes to an id.
import { pickList, probeColours, probeIds, probeIndex, type PickHit, type PickKind, type PickLayer } from "@/theme/probe";
import { varName } from "@/ui/themeNames";
import { APP_SPEC } from "./editorStore";

const PROPS: readonly (readonly [string, PickKind])[] = [
  ["color", "text"],
  ["background-color", "fill"],
  ["background-image", "fill"],
  ["border-top-color", "border"],
  ["border-right-color", "border"],
  ["border-bottom-color", "border"],
  ["border-left-color", "border"],
  ["outline-color", "border"],
  ["fill", "icon"],
  ["stroke", "icon"],
  ["box-shadow", "shadow"],
  ["text-decoration-color", "other"],
  ["caret-color", "other"],
];
const MAX_LAYERS = 8;

/** Every sRGB colour in a computed value: rgb()/rgba() with 0–255 channels, or color(srgb r g b) with 0–1 ones. */
export function coloursIn(value: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  const re = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)|color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m[1] !== undefined) out.push([Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))]);
    else out.push([Math.round(Number(m[4]) * 255), Math.round(Number(m[5]) * 255), Math.round(Number(m[6]) * 255)]);
  }
  return out;
}

function read(el: Element): string[] {
  const cs = getComputedStyle(el);
  return PROPS.map(([p]) => cs.getPropertyValue(p));
}

/** A short name for an element (debugging, the layer's `element`). */
function describe(el: Element): string {
  const c = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
  return `${el.tagName.toLowerCase()}${c}`;
}

/** The elements a point hits, nearest first, without the editor's own UI. */
export function chainAt(x: number, y: number, exclude: readonly Element[]): Element[] {
  const top = document.elementsFromPoint(x, y).find((e) => !exclude.some((x) => x === e || x.contains(e)));
  const chain: Element[] = [];
  for (let e: Element | null = top ?? null; e && e !== document.documentElement && chain.length < MAX_LAYERS; e = e.parentElement) chain.push(e);
  return chain;
}

/** Sample the colours at a point (§15.2): the layers, nearest first. */
export function sampleAt(x: number, y: number, exclude: readonly Element[]): PickLayer[] {
  const chain = chainAt(x, y, exclude);
  if (!chain.length) return [];
  const real = chain.map(read);
  const root = document.documentElement;
  const ids = probeIds(APP_SPEC);
  const probe = probeColours(APP_SPEC);
  const saved: [string, string, string][] = [];
  root.classList.add("th-probing");
  void root.offsetHeight; // the class is in before any value changes (no transition can start)
  for (const id of ids) {
    const name = varName(id);
    saved.push([name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]);
    root.style.setProperty(name, probe[id]);
  }
  const probed = chain.map(read);
  for (const [name, value, prio] of saved) {
    if (value) root.style.setProperty(name, value, prio);
    else root.style.removeProperty(name);
  }
  void root.offsetHeight; // the real values computed again while transitions are still off
  root.classList.remove("th-probing");
  return chain.map((el, i) => {
    const hits: PickHit[] = [];
    PROPS.forEach(([, kind], j) => {
      if (real[i][j] === probed[i][j]) return; // does not depend on the theme
      for (const [r, g, b] of coloursIn(probed[i][j])) {
        const k = probeIndex(r, g, b, ids.length);
        if (k >= 0 && !hits.some((h) => h.id === ids[k])) hits.push({ id: ids[k], kind });
      }
    });
    return { element: describe(el), hits };
  });
}

/** The Pick list of a point (§15.3). */
export function pickAt(x: number, y: number, exclude: readonly Element[]): PickHit[] {
  return pickList(sampleAt(x, y, exclude));
}

// editorStore.ts — the theme editor's state (THEMES-UI.md §13): the session (base, working document, undo / redo), the
// target (one of My themes, or a new theme), the mode, readability, the Pick tool's result, the save error. Every change
// of the working document is painted through the theme store's preview (setThemePreview: nothing is saved) and ends with
// Save (My themes + applied), Save as, or Cancel (the preview ends, the effective theme comes back).
// The pure rules are src/theme/editor.ts; this file only holds the state and the side effects.
import { create } from "zustand";
import type { Theme, TokensSpec } from "@/theme/engine";
import * as E from "@/theme/editor";
import type { JObj } from "@/theme/sync";
import type { PickHit } from "@/theme/probe";
import { showToast } from "@/ui";
import tokenSpec from "@/ui/tokenSpec.gen.json" with { type: "json" };
import { canonicalColours, resolveColours, type ThemeColours } from "@/ui/themes";
import { chooseTheme, clearThemePreview, saveMyTheme, setThemePreview, themeIdTaken, themePreviewOwner } from "@/ui/themeStore";
import { refusalText } from "../text";

export const APP_SPEC = tokenSpec as unknown as TokensSpec;

export type Resolved = { roles: Record<string, string>; tokens: Record<string, string> };
export type EditTarget = { kind: "mine"; id: string } | { kind: "new" };
export type EditorMode = "simple" | "advanced";

export interface EditorState {
  open: boolean;
  session: E.EditSession | null;
  target: EditTarget;
  /** the name of the theme the editor started from ("A new theme from ‹name›") */
  baseName: string;
  mode: EditorMode;
  /** the working document resolved for the web (what the preview paints) */
  colours: ThemeColours | null;
  /** its canonical roles + tokens (readability checks) */
  resolved: Resolved | null;
  /** readability issues of the base (§13.5: only what the edits break is shown) */
  baseIssues: E.ContrastIssue[];
  saveError: string | null;
  pickArmed: boolean;
  /** the Pick tool's last result (the "Picked" group), null when none */
  picked: PickHit[] | null;
  /** Advanced: search text, the Changed filter, open groups */
  query: string;
  changedOnly: boolean;
  /** Simple: a lead swatch's popover moves its whole group (else just that colour) — kept for the session */
  swatchWhole: boolean;
  /** Advanced: only these ids (Simple's "set by hand" link), null = all */
  onlyIds: string[] | null;
  openGroups: Record<string, boolean>;
  /** the Cancel confirmation is showing */
  confirmDiscard: boolean;
  /** Save as: the prompt is showing */
  saveAsOpen: boolean;
}

const initial: EditorState = {
  open: false,
  session: null,
  target: { kind: "new" },
  baseName: "",
  mode: "simple",
  colours: null,
  resolved: null,
  baseIssues: [],
  saveError: null,
  pickArmed: false,
  picked: null,
  query: "",
  changedOnly: false,
  onlyIds: null,
  swatchWhole: true,
  openGroups: {},
  confirmDiscard: false,
  saveAsOpen: false,
};

export const useEditor = create<EditorState>()(() => ({ ...initial }));

let gestureSeq = 0;
/** A new gesture id: one drag / one focus session = one undo step (§13.3). */
export const newGesture = (): number => ++gestureSeq;

function resolvedOf(doc: JObj): { colours: ThemeColours; resolved: Resolved } | null {
  const t = resolveColours(doc as unknown as Theme);
  return "error" in t ? null : { colours: t, resolved: canonicalColours(t) };
}

/** Paint the working document (the theme store's preview; resolveColours has it cached by then). */
function paint(doc: JObj): void {
  const err = setThemePreview("editor", doc as unknown as Theme);
  if (err) console.warn(`theme editor: preview refused (${err})`);
}

/**
 * Open the editor (§13.1): `mine` edits one of My themes in place; `new` starts from a copy ("‹name› (edited)").
 * A Try in progress ends (the editor takes the screen). An open editor without changes switches to this theme; one
 * with changes stays, with a toast (§13.1). Returns false then, or when the theme cannot be used.
 */
export function openEditor(doc: Theme, target: EditTarget, opts: { force?: boolean } = {}): boolean {
  const st = useEditor.getState();
  if (st.open && st.session && E.isDirty(st.session) && !opts.force) {
    showToast(`Finish editing ${String(st.session.doc.name ?? "")} first — save it or cancel.`, "long");
    return false;
  }
  const start = target.kind === "new" ? E.startCopy(doc as unknown as JObj) : (doc as unknown as JObj);
  const res = resolvedOf(start);
  if (!res) {
    showToast(`${doc.name} can't be edited by this version of Tin Hat.`, "long");
    return false;
  }
  if (themePreviewOwner() === "try") endTrialForEditor();
  const session = E.openSession(start);
  useEditor.setState({
    ...initial,
    open: true,
    session,
    target,
    baseName: doc.name,
    mode: st.mode,
    colours: res.colours,
    resolved: res.resolved,
    baseIssues: E.contrastIssues(res.resolved),
  });
  paint(session.doc);
  return true;
}

/** Set by the share cards' trial (ending it without going back when the editor opens). */
let endTrialForEditor: () => void = () => clearThemePreview("try");
export function onEditorOpensDuringTrial(cb: () => void): void {
  endTrialForEditor = cb;
}

function commit(session: E.EditSession): void {
  const res = resolvedOf(session.doc);
  useEditor.setState({ session, colours: res?.colours ?? null, resolved: res?.resolved ?? null, saveError: null });
  paint(session.doc);
}

/** One edit (§13.2). Returns the refusal code, or null. `gesture`: continue that gesture's undo step. */
export function edit(op: E.EditOp, gesture: number | null = null): string | null {
  const s = useEditor.getState().session;
  if (!s) return "closed";
  const r = E.sessionEdit(s, op, APP_SPEC, gesture);
  if (!r.ok) return r.error;
  if (r.result === "edited") commit(r.session);
  return null;
}

export function undo(): void {
  const s = useEditor.getState().session;
  if (!s) return;
  const r = E.sessionUndo(s);
  if (r.result !== "noop") commit(r.session);
}
export function redo(): void {
  const s = useEditor.getState().session;
  if (!s) return;
  const r = E.sessionRedo(s);
  if (r.result !== "noop") commit(r.session);
}
export function resetAll(): void {
  const s = useEditor.getState().session;
  if (!s) return;
  const r = E.sessionReset(s);
  if (r.result !== "noop") commit(r.session);
}

/** The readability issues the editor shows (§13.5): what the edits broke. */
export function shownIssues(st: EditorState): E.ContrastIssue[] {
  if (!st.resolved) return [];
  return E.newIssues(E.contrastIssues(st.resolved), st.baseIssues);
}

function close(): void {
  useEditor.setState({ ...initial, mode: useEditor.getState().mode });
  clearThemePreview("editor");
}

/** Save (§13.4): My themes + applied, the editor closes. `asNew` = Save as with that name. */
export function save(asNew?: string): boolean {
  const st = useEditor.getState();
  if (!st.session) return false;
  let doc = st.session.doc;
  let target = st.target;
  if (asNew !== undefined) {
    const r = E.applyEdit(doc, { op: "name", value: asNew }, APP_SPEC);
    if (!r.ok) {
      useEditor.setState({ saveError: refusalText(r.error) });
      return false;
    }
    doc = r.doc;
    target = { kind: "new" };
  }
  const out = E.saveDoc(doc, target, themeIdTaken) as unknown as Theme;
  const r = saveMyTheme(out);
  if (r !== "saved" && r !== "noop") {
    useEditor.setState({ saveError: refusalText(r) });
    return false;
  }
  chooseTheme(out);
  close();
  showToast(`${out.name} saved to My themes`, "short");
  return true;
}

/** Cancel (§13.4): with changes the caller shows the confirmation first (`confirmDiscard`). */
export function cancel(force = false): void {
  const st = useEditor.getState();
  if (!st.open) return;
  if (!force && st.session && E.isDirty(st.session)) {
    useEditor.setState({ confirmDiscard: true });
    return;
  }
  close();
}

/** Export (§13.4): the working document as `<slug>.tinhat-theme.json` (a download). */
export function exportFile(): void {
  const s = useEditor.getState().session;
  if (!s) return;
  const blob = new Blob([E.exportText(s.doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = E.exportFileName(s.doc);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The working document (for Share to a room…). */
export function workingDoc(): Theme | null {
  const s = useEditor.getState().session;
  return s ? (s.doc as unknown as Theme) : null;
}

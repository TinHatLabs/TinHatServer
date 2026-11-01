// store.ts — edit mode's React state (EDITMODE-UI §1): the open session (session.ts — the pure rules), a version counter
// that re-renders on every change, the drag / keyboard-move state the edit layer draws, and the actions the toolbar,
// the island chrome, the shortcuts and the settings call. Done saves once through layoutDoc.ts (the synced document);
// Cancel throws the session away. The shell renders `session.form` while a desktop session is open.
import { create } from "zustand";
import { showToast } from "@/ui";
import { getFormFactor } from "@/core/device";
import type { JObj, Json } from "@/layout";
import { EditSession, dockFloat, drawerTargets, floatIsland, newActionButton, newButtonIsland, newDrawer, removeButtonIslandFrom, resetIsland, type FormKind, type Step } from "./session";
import { closeDrawer } from "./drawerRun";
import { beginSession, clearOverride, endSession, getRendered, readOverride, saveLayout, setOverride } from "./layoutDoc";

/** Reset layout on this device (EDITMODE-UI §9): the device-local override, at once. */
export function resetOnThisDevice(): void {
  if (useEdit.getState().session) cancelEdit();
  setOverride();
  showToast("Layout reset on this device.", 3000);
}

export interface EditState {
  session: EditSession | null;
  /** bumps on every change of the session (undo, redo, apply …) */
  v: number;
  /** the document is from a newer Tin Hat: look, don't touch (EDITMODE-UI §13) */
  readOnly: boolean;
  /** a live result that is not a step yet (a gap drag in progress) — the shell renders it instead of session.form */
  preview: JObj | null;
  /** the tuple of the entry the session started from ([0, 0, ""] = none) — a different current entry at Done = a
   *  remote change arrived meanwhile */
  startTuple: [number, number, string];
}

export const useEdit = create<EditState>()(() => ({ session: null, v: 0, readOnly: false, preview: null, startTuple: [0, 0, ""] }));

export function setPreview(form: JObj | null): void {
  useEdit.setState({ preview: form });
}

const bump = () => useEdit.setState((s) => ({ v: s.v + 1 }));

export function isEditing(kind?: FormKind): boolean {
  const s = useEdit.getState().session;
  return !!s && (!kind || s.kind === kind);
}

/** Open a session on the layout this device renders (the reset override included). */
export function openEdit(kind: FormKind = "desktop"): void {
  if (useEdit.getState().session) return;
  closeDrawer(); // an open drawer closes when edit mode opens (EDITMODE-UI §7.3)
  const r = getRendered();
  const s = new EditSession({ id: r.id, name: r.name, desktop: r.desktop, phone: r.phone }, kind);
  // LAYOUT §9.7 begin: the save builds on this start (a reset override edits from Classic, still on the same entry)
  const startTuple = beginSession(r.id);
  useEdit.setState((st) => ({ session: s, v: st.v + 1, readOnly: r.readOnly, preview: null, startTuple }));
}

/** Done (EDITMODE-UI §1, §16): save once when something changed, then close. Answers false when the save failed (the
 *  session stays open). */
export function doneEdit(): boolean {
  const st = useEdit.getState();
  const s = st.session;
  if (!s) return true;
  if (st.readOnly) {
    s.cancel();
    endSession(s.id);
    useEdit.setState((x) => ({ session: null, v: x.v + 1, preview: null }));
    return true;
  }
  const ov = readOverride();
  const startTuple = st.startTuple;
  const current = getRendered().tuple;
  const remoteMeanwhile = current.join("\u0000") !== startTuple.join("\u0000");
  const res = s.finish();
  if (res) {
    const ed: JObj = Object.create(null);
    ed["name"] = res.name;
    ed["desktop"] = res.desktop;
    ed["phone"] = res.phone;
    const out = saveLayout(res.id, ed, true);
    if (out !== "saved" && out !== "noop") {
      // the session goes on exactly as it was (start, undo history, dirty): nothing is lost, Done can be tried again
      s.reopen();
      useEdit.setState((x) => ({ v: x.v + 1 }));
      showToast(
        out === "bad-layout: too large"
          ? "This layout is too big to save (64 KB). Hide or remove something and try again."
          : out === "read-only"
            ? "Saved by a newer Tin Hat — update to edit layouts."
            : `The layout couldn't be saved (${out}).`,
        6000,
      );
      return false;
    }
    if (ov && ov.id === res.id) clearOverride();
    if (remoteMeanwhile) showToast("Saved. A change from your other device is kept as the previous version.", 6000);
  } else endSession(s.id); // nothing changed: nothing saved (a reset override stays)
  useEdit.setState((x) => ({ session: null, v: x.v + 1, preview: null }));
  return true;
}

export function cancelEdit(): void {
  const s = useEdit.getState().session;
  if (!s) return;
  s.cancel();
  endSession(s.id);
  useEdit.setState((x) => ({ session: null, v: x.v + 1, preview: null }));
}

const ERR: Record<string, string> = {
  "bad-op: required island": "That island can't be hidden or put there — the app needs it.",
  "bad-op: locked group": "The room's header, messages and composer stay together.",
  "bad-op: not stackable": "That island can't share a spot as a tab.",
  "bad-op: not floatable": "That island can't float.",
  "bad-op: not hideable": "That island can't be hidden.",
};
export function explain(error: string): string | null {
  if (error === "bad-op: no room" || error === "closed") return null;
  if (error.startsWith("bad-layout:")) return "That would make the layout too big.";
  return ERR[error] ?? "That move isn't possible.";
}
function report(r: Step): Step {
  if (!r.ok) {
    const m = explain(r.error);
    if (m) showToast(m, 3000);
  } else bump();
  return r;
}

export function editApply(op: Json, ctx?: Json): Step {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return { ok: false, error: "closed" };
  return report(s.apply(op, ctx));
}
/** A form computed elsewhere (a gap drag's last result, a multi-step host command) as one undo step. */
export function editCommit(form: JObj): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  if (s.commit(form)) bump();
}
export function editUndo(): void {
  if (useEdit.getState().session?.undo()) bump();
}
export function editRedo(): void {
  if (useEdit.getState().session?.redo()) bump();
}
export function editPreset(name: string): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  report(name === "previous" ? s.previous() : s.preset(name));
}
export function editReset(): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  report(s.reset());
}
export function editPhone(form: JObj): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  report(s.setPhone(form));
}
export function editRename(name: string): void {
  const s = useEdit.getState().session;
  if (!s) return;
  s.rename(name);
  bump();
}

/** Host commands of the island menu (EDITMODE-UI §4.1, §4.3). */
export function editFloat(ref: string, rect: { x: number; y: number; w: number; h: number }, host: { w: number; h: number }): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  const r = floatIsland(s.form, ref, rect, host);
  if (!r.ok) report(r);
  else if (s.commit(r.form)) bump();
}
export function editDock(ref: string): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  const r = dockFloat(s.form, ref);
  if (!r.ok) report(r);
  else if (s.commit(r.form)) bump();
}
export function editResetIsland(ref: string): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  const r = resetIsland(s.form, ref);
  if (!r.ok) {
    showToast("Can't reset this island here.", 3000);
    return;
  }
  if (s.commit(r.form)) bump();
}

/** A new, empty button island (`buttons:b<n>`, EDITMODE-UI §7): placed by its home rule (the bottom edge), one step. */
export function editNewButtons(): string | null {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly || s.kind !== "desktop") return null;
  const r = newButtonIsland(s.form);
  if (!r.ok) {
    showToast(r.error === "too-many" ? "You have 8 button islands — that's the most a layout holds." : "A button island doesn't fit here.", 4000);
    return null;
  }
  if (s.commit(r.form)) bump();
  return r.ref;
}
/** Add button (EDITMODE-UI §7.2): a new button island holding one action of the catalogue (`item` = {a, target?}), with
 *  its look (icon | iconLabel | label) — one step. Answers the new island's ref. */
export function editNewActionButton(item: Json, look: string): string | null {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly || s.kind !== "desktop") return null;
  const r = newActionButton(s.form, item, look);
  if (!r.ok) {
    if (r.error === "too-many") showToast("You can have 8 button islands.", 3000);
    else report(r);
    return null;
  }
  if (s.commit(r.form)) bump();
  return r.ref;
}
/** Add drawer (§7.3): `ref` goes into a drawer (hidden when placed) that a new one-button island opens
 *  (`layout.drawer.toggle`, target {island, icon}) — one step. Answers the button island's ref. */
export function editNewDrawer(ref: string, icon: string): string | null {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly || s.kind !== "desktop") return null;
  const r = newDrawer(s.form, ref, icon);
  if (!r.ok) {
    if (r.error === "too-many") showToast("You can have 8 button islands.", 3000);
    else report(r);
    return null;
  }
  if (s.commit(r.form)) bump();
  return r.ref;
}
/** The islands that may go into a drawer (placed or hidden) in the open desktop session — the Add drawer panel. */
export function editDrawerTargets(): string[] {
  const s = useEdit.getState().session;
  return s && s.kind === "desktop" ? drawerTargets(s.form) : [];
}

/** Remove a button island for good (its place and its buttons), one step. */
export function editRemoveButtons(ref: string): void {
  const s = useEdit.getState().session;
  if (!s || useEdit.getState().readOnly) return;
  const r = removeButtonIslandFrom(s.form, ref);
  if (r && s.commit(r)) bump();
}

/** The `layout.edit` action (Ctrl+E, a button, Ctrl+K): Done while a session is open, else open edit mode on the form
 *  this device shows (phones: the phone editor). */
export function toggleEditMode(): void {
  if (useEdit.getState().session) {
    doneEdit();
    return;
  }
  openEdit(getFormFactor() === "mobile" ? "phone" : "desktop");
}

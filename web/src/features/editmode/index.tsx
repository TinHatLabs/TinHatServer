// features/editmode — Tin Hat 11.0 edit mode (step 4; contract modular/contract/EDITMODE-UI.md, LAYOUT.md §8-§9):
// rearrange the live app in place, OBS style, and save the layout to the account (`dev.tinhat.layouts`).
//
//   session.ts     the pure edit session (undo / redo, Cancel, Done once) + the host logic that chooses operations
//   store.ts       its React state and actions (the toolbar, the chrome, the shortcuts call them)
//   drag.ts        a move in progress: drop zones, hover, landing preview
//   EditLayer.tsx  the chrome over the dock host (chips, ⋯ menus, gap handles, zones, ghost) + Toolbar.tsx
//   layoutDoc.ts   which layout this device renders + the device side of the sync (persisted per account)
//   layoutSync.ts  the account-data I/O (reads, PUTs with retries, re-asserts)
//   tabs.ts        which tab of a stack is shown (device-local)
//   PhoneEditor    the phone form's editor (Settings → Appearance → Layout on phones)
//   LayoutSection  Settings → Appearance → Layout: edit, reset, named layouts, previous version
// The shell renders `useRendered().desktop` (or the open session's working copy) and mounts the EditLayer as the dock
// host's chrome; Banners.tsx shows the reset / conflict notices.
//
// Contributions: r.appMenu "Edit layout…" · r.overlays the phone editor sheet · r.onReady `?layout=reset` + the sync.
// Test hook (dev / __TW_DEBUG__): window.__twEdit.
import type { FeatureModule } from "@/core/registry";
import { showToast } from "@/ui";
import { getFormFactor } from "@/core/device";
import { bus } from "@/core/bus";
import { canon, type JObj, type Json } from "@/layout";
import { cancelEdit, doneEdit, editApply, editCommit, editPhone, editPreset, editRedo, editUndo, openEdit, useEdit } from "./store";
import { beginDrag, dropDrag, setHover, useDrag } from "./drag";
import { currentCtx } from "./EditLayer";
import { debugState, getRendered, readOverride, saveLayout, setOverride, subscribeRendered } from "./layoutDoc";
import { setFormSource } from "@/actions/layoutStore";
import { installLayoutSync } from "./layoutSync";
import { PhoneEditorHost, openPhoneEditor } from "./PhoneEditor";

export { EditLayer } from "./EditLayer";
export { IslandPlaceholder } from "./Placeholder";
export { Toolbar as EditToolbar } from "./Toolbar";
export { islandText } from "./names";
export { openEdit, doneEdit, cancelEdit, useEdit, isEditing, resetOnThisDevice } from "./store";
export { useRendered, getRendered } from "./layoutDoc";
export { useTabs, setTab } from "./tabs";
export { LayoutSection } from "./LayoutSection";
export { openPhoneEditor } from "./PhoneEditor";

/** `?layout=reset` (EDITMODE-UI §9): applied once, then removed from the URL. */
function resetFromUrl(): void {
  if (typeof location === "undefined") return;
  const q = new URLSearchParams(location.search);
  if (q.get("layout") !== "reset") return;
  setOverride();
  q.delete("layout");
  const qs = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

export const feature: FeatureModule = {
  id: "editmode",
  setup(r) {
    installLayoutSync();
    resetFromUrl();
    // the buttons' layout store (button rows, your own button islands) reads and writes through the synced layout from
    // here on: the open edit session's working copy (a change = one undo step), else the layout this device renders
    // (a change = one save) — until the first save it stays the device prefs (EDITMODE-UI §16)
    setFormSource({
      get: (kind) => {
        const st = useEdit.getState();
        if (st.session && st.session.kind === kind) return st.preview ?? st.session.form;
        return getRendered()[kind];
      },
      set: (kind, form) => {
        const st = useEdit.getState();
        if (st.session && st.session.kind === kind) {
          if (kind === "desktop") editCommit(form);
          else editPhone(form);
          return true;
        }
        const rd = getRendered();
        if (st.session && st.session.id === rd.id) {
          // the other form of a layout that is being edited: only the session's Done may save it (LAYOUT §9.7)
          showToast("Finish editing the layout first (Done or Cancel).", 4000);
          return true;
        }
        if (rd.source !== "doc") return false;
        const ed: JObj = Object.create(null);
        ed["name"] = rd.name;
        ed["desktop"] = kind === "desktop" ? form : rd.desktop;
        ed["phone"] = kind === "phone" ? form : rd.phone;
        saveLayout(rd.id, ed);
        return true;
      },
      subscribe: (cb) => {
        const a = subscribeRendered(cb);
        const b = useEdit.subscribe(cb);
        return () => {
          a();
          b();
        };
      },
    });
    r.appMenu.add({
      id: "layout-edit",
      order: 55, // after Settings… (50), before Theme (60) — 2026-09-29
      label: "Edit layout…",
      icon: "window-symbolic",
      run: () => (getFormFactor() === "mobile" ? openPhoneEditor() : openEdit("desktop")),
    });
    r.overlays.add({ id: "layout-phone-editor", order: 95, component: PhoneEditorHost });
    const w = window as unknown as { __TW_DEBUG__?: boolean; __twEdit?: unknown };
    const q = new URLSearchParams(location.search);
    if (q.get("editmode") === "1") {
      // captures: open edit mode once the first layout is on screen
      const t = window.setInterval(() => {
        if (document.querySelector("[data-dock-host] [data-island]")) {
          window.clearInterval(t);
          window.setTimeout(() => openEdit("desktop"), 300);
        }
      }, 200);
      bus.once("loggedOut", () => window.clearInterval(t));
    }
    if (import.meta.env.DEV || w.__TW_DEBUG__)
      w.__twEdit = {
        open: (kind?: "desktop" | "phone") => (kind === "phone" ? openPhoneEditor() : openEdit(kind ?? "desktop")),
        done: doneEdit,
        cancel: cancelEdit,
        undo: editUndo,
        redo: editRedo,
        apply: (op: Json) => editApply(op),
        preset: editPreset,
        state: () => {
          const s = useEdit.getState().session;
          return s
            ? { open: true, kind: s.kind, dirty: s.dirty, undo: s.undoDepth, redo: s.redoDepth, form: JSON.parse(canon(s.form)) as JObj, name: s.name }
            : { open: false };
        },
        rendered: () => JSON.parse(JSON.stringify(getRendered())) as unknown,
        override: readOverride,
        device: debugState,
        /** a scripted move: pick up `ref`, hover zone `i` of the keyboard order, drop */
        drag: (ref: string, i: number) => {
          const ctx = currentCtx();
          if (!ctx || !beginDrag(ref, "keys", ctx)) return false;
          setHover(i);
          return dropDrag();
        },
        zones: () => useDrag.getState().drag?.zones.map((z) => ({ kind: z.kind, rect: z.rect, op: z.op })) ?? null,
        hover: () => {
          const d = useDrag.getState().drag;
          return d ? { hover: d.hover, zone: d.zones[d.hover] ?? null, preview: d.preview } : null;
        },
      };
  },
};

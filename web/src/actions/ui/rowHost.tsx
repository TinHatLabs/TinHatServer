// rowHost.tsx — how today's surfaces draw their button rows from the actions table (11.0 buttons, ACTIONS.md §9; the
// desktop's RowModel.qml + the hosts' Repeaters):
//
//   const row = useRow("header", "main", { form: "desktop", context });   // the stored row, else the preset's default
//   {row.out.items.map((it, i) => it.state === "hidden" ? null : bespoke(it) ?? <RowButton row={row} item={it} … />)}
//
// A host keeps drawing TODAY's element for an action it has one for (the header's round buttons, the composer's Send,
// the call bar's buttons — "bespoke"), in the order and with the visibility the row resolves to, so the default rows
// paint exactly what 10.8 painted. An item the host has no element for (added from the editor), or every item once the
// row's look / size is not the row kind's default, is drawn by the generic ActionButton in the row's style and runs
// through the one run path (run.ts). `EditableRow` gives an editable row its right-click "Edit buttons…" menu.
import { useMemo, useState, type ReactNode } from "react";
import type { JObj, Json } from "../../layout/json";
import { Menu, MenuItem } from "@/ui";
import { TABLE, reg, type RowKind } from "../table";
import { evalRow, type ItemOut, type RowOut } from "../evaluate";
import { defaultRowValue, rowKindOf } from "../rows";
import { useActionsSnapshot } from "../snapshot";
import { runAction, type Handler, type RunSource } from "../run";
import { storedRow, useForm, type FormKind } from "../layoutStore";
import { openRowEditor } from "./editorStore";
import { ActionButton } from "./ActionButton";
import ab from "./ActionButton.module.css";

export interface RowState {
  /** the island ref and row id of opts.<island>.rows.<row> */
  island: string;
  rowId: string;
  form: FormKind;
  /** the row kind (ACTIONS.md §9.1) */
  kind: string;
  /** what the row draws: the stored value, else the preset's default row */
  value: Json | null;
  stored: boolean;
  out: RowOut;
  /** the row's look and size are the row kind's defaults: hosts may draw their own elements */
  defaultLook: boolean;
  context: JObj | undefined;
}

/** The row an island draws (stored in the device's layout form, else the preset's default), resolved against the live
 *  snapshot (or `snapshot`). Pass a memoized `context` (the host's subjects: a composer's room, the call's room). */
export function useRow(island: string, rowId: string, o: { form?: FormKind; context?: JObj; snapshot?: JObj } = {}): RowState {
  const form = o.form ?? "desktop";
  const f = useForm(form);
  const stored = storedRow(f, island, rowId);
  const live = useActionsSnapshot();
  const snap = o.snapshot ?? live;
  const kind = rowKindOf(island, rowId);
  const value = stored !== undefined ? stored : defaultRowValue(island, rowId, form);
  const out = useMemo(() => evalRow("web", snap, kind, value ?? null, o.context), [snap, kind, value, o.context]);
  const rk = reg(TABLE.rows, kind) as RowKind | undefined;
  return {
    island,
    rowId,
    form,
    kind,
    value,
    stored: stored !== undefined,
    out,
    defaultLook: !!rk && out.look === rk.look && out.scale === rk.scale,
    context: o.context,
  };
}

/** The items a host draws (hidden ones left out), with their index in the row. */
export function shownItems(row: RowState): { item: ItemOut; i: number }[] {
  return row.out.items.map((item, i) => ({ item, i })).filter(({ item }) => item.state !== "hidden");
}

/** May the host draw its own element for this item? Its look / size are the row kind's and the item carries no stored
 *  target (a targeted button — "Join Valheim" — is always the generic one). */
export function bespokeOk(row: RowState, item: ItemOut): boolean {
  return row.defaultLook && item.known && item.target === null;
}

/** Run a row item through the one run path (its stored target, the row's context, the button as the anchor). */
export function runRowItem(row: RowState, item: ItemOut, anchor: HTMLElement | null, extra: { source?: RunSource; handler?: Handler; hold?: "down" | "up" } = {}): void {
  void runAction(item.a, { source: extra.source ?? "button", target: item.target, context: row.context ?? null, anchor, handler: extra.handler, hold: extra.hold });
}

/** The generic button of a row item (ActionButton in the row's style). `handlers` = the surface's own commands for its
 *  context-only actions (the composer's Send, attach …), passed to the run path. */
export function RowButton({ row, item, handlers, className }: { row: RowState; item: ItemOut; handlers?: Record<string, Handler>; className?: string }) {
  return (
    <ActionButton
      item={item}
      rowStyle={row.out.style}
      scale={row.out.scale}
      className={className}
      onRun={(el) => runRowItem(row, item, el, { handler: handlers?.[item.a] })}
      onHold={(el, down) => runRowItem(row, item, el, { handler: handlers?.[item.a], hold: down ? "down" : "up" })}
    />
  );
}

/** A host's own element while its action does not apply: dimmed and inert, like the generic button (only for elements
 *  that do not draw an unavailable state themselves). */
export function Dim({ children }: { children: ReactNode }) {
  return (
    <span className={ab.dimWrap} aria-disabled="true">
      {children}
    </span>
  );
}

/** An editable row's right-click menu ("Edit buttons…" opens the row editor; `extra` adds the host's own items). Wraps
 *  the row's buttons in a `display: contents` element — no box, so nothing moves. A text field's own menu wins. */
export function EditableRow({ row, title, children, extra }: { row: RowState; title: string; children: ReactNode; extra?: (close: () => void) => ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = () => setAt(null);
  if (!row.out.editable) return <>{children}</>;
  return (
    <span
      style={{ display: "contents" }}
      data-button-row={row.kind}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable=true]")) return;
        e.preventDefault();
        e.stopPropagation();
        setAt({ x: e.clientX, y: e.clientY });
      }}
    >
      {children}
      {at && (
        <Menu open onClose={close} anchor={at} width={220}>
          <MenuItem text="Edit buttons…" icon="document-edit-symbolic" onTriggered={() => openRowEditor({ island: row.island, row: row.rowId, form: row.form, title })} />
          {extra?.(close)}
        </Menu>
      )}
    </span>
  );
}

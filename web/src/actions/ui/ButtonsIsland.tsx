// ButtonsIsland.tsx — one of your own button islands (`buttons:<n>`, 11.0 buttons; DESIGN.md "Your own button islands:
// drop a buttons island anywhere and fill it, Stream Deck style"; the desktop's ButtonsIsland.qml): its row
// (opts.<ref>.rows.main, row kind buttons.main) drawn with ButtonRow — wrapping onto more lines when the island is
// narrow, toggles reading on / off (checked) — and its right-click menu (Edit buttons…, Remove this island). An empty
// island says so and offers the editor. It reports its natural size to the dock host: the one-line width of its
// buttons (a floating island is as wide as they are) and the height at the width it got.
import { useLayoutEffect, useRef, useState } from "react";
import { ConfirmDialog, Button, MenuItem, useIsland } from "@/ui";
import { buttonIslandName, removeButtonIsland, useForm } from "../layoutStore";
import { openRowEditor } from "./editorStore";
import { ButtonRow } from "./ButtonRow";
import { EditableRow, useRow } from "./rowHost";
import s from "./ButtonsIsland.module.css";

const GAP = 4; // ButtonRow's gap (Kirigami smallSpacing)

export function ButtonsIsland({ islandRef }: { islandRef: string }) {
  const form = useForm("desktop");
  const title = buttonIslandName(form, islandRef);
  const row = useRow(islandRef, "main", { form: "desktop" });
  const isl = useIsland();
  const report = isl?.report;
  const box = useRef<HTMLDivElement>(null);
  const [ask, setAsk] = useState(false);
  const shown = row.out.items.filter((it) => it.state !== "hidden").length;
  const edit = () => openRowEditor({ island: islandRef, row: "main", form: "desktop", title });

  // natural size: the buttons on one line (their widths + the gaps + the padding), the height they take now
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !report) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const rowEl = el.querySelector<HTMLElement>("[role=toolbar]");
      let w = 0;
      if (rowEl) {
        const cells = Array.from(rowEl.children) as HTMLElement[];
        w = cells.reduce((a, c) => a + c.getBoundingClientRect().width, 0) + Math.max(0, cells.length - 1) * GAP;
      } else {
        const hint = el.firstElementChild as HTMLElement | null;
        w = hint ? hint.scrollWidth : 0;
      }
      report({ w: Math.ceil(w + pad), h: Math.ceil(el.getBoundingClientRect().height) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const rowEl = el.querySelector("[role=toolbar]");
    if (rowEl) for (const c of Array.from(rowEl.children)) ro.observe(c);
    measure();
    return () => ro.disconnect();
  }, [report, row.out]);

  return (
    <div ref={box} className={s.island} data-buttons-island={islandRef}>
      <EditableRow
        row={row}
        title={title}
        extra={(close) => <MenuItem text="Remove this island…" icon="edit-delete-symbolic" onTriggered={() => (close(), setAsk(true))} />}
      >
        {shown > 0 ? (
          <ButtonRow row="buttons.main" value={row.value ?? undefined} wrap />
        ) : (
          <div className={s.empty}>
            <span className={s.emptyText}>No buttons yet</span>
            <Button flat text="Add buttons…" icon="list-add-symbolic" onClick={edit} />
          </div>
        )}
      </EditableRow>
      <ConfirmDialog
        open={ask}
        onClose={() => setAsk(false)}
        dialogTitle={`Remove ${title}?`}
        message={shown > 0 ? `Its ${shown} button${shown === 1 ? "" : "s"} go with it. You can make a new one in Settings → Appearance → Buttons.` : "You can make a new one in Settings → Appearance → Buttons."}
        confirmText="Remove"
        destructive
        onConfirmed={() => void removeButtonIsland(islandRef)}
      />
    </div>
  );
}

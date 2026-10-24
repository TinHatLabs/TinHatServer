// LayoutSection.tsx — Settings → Appearance → Layout (EDITMODE-UI §9, §13): which layout this device uses, Edit layout,
// Reset layout (device-local first), New / Rename / Delete, Restore previous version. Rows of the Settings window's
// "Layout" card since 2026-09-29 (SETTINGS-WINDOW.md; the settings feature's rows.tsx shapes). Every change here is one save of the
// synced document (layoutDoc.ts) — never per click of anything else.
import { useState } from "react";
import { bus } from "@/core/bus";
import { useFormFactor } from "@/core/device";
import { Button, PromptDialog, TextField, showToast } from "@/ui";
import { Buttons, ComboRow, Row } from "@/features/settings/rows";
import { classicDesktop, classicPhone, type JObj } from "@/layout";
import { newLayoutId, previousOf, saveLayout, setActive, useRendered } from "./layoutDoc";
import { openEdit, resetOnThisDevice } from "./store";
import { openPhoneEditor } from "./PhoneEditor";

function edit(name: string, desktop: JObj, phone: JObj): JObj {
  const e: JObj = Object.create(null);
  e["name"] = name;
  e["desktop"] = desktop;
  e["phone"] = phone;
  return e;
}
function outcome(r: string, ok: string): void {
  if (r === "saved") showToast(ok, 3000);
  else if (r === "noop") return;
  else if (r === "read-only") showToast("Saved by a newer Tin Hat — update to edit layouts.", 5000);
  else if (r === "busy") showToast("Finish editing the layout first (Done or Cancel).", 4000);
  else if (r === "bad-save: too many layouts") showToast("You have 12 layouts — delete one first.", 5000);
  else showToast(`That didn't work (${r}).`, 5000);
}

export function LayoutSection() {
  const r = useRendered();
  const phone = useFormFactor() === "mobile";
  const [prompt, setPrompt] = useState<null | "new" | "rename">(null);
  const [text, setText] = useState("");
  const list = r.layouts.length ? r.layouts : [{ id: "main", name: "Main" }];
  const idx = Math.max(0, list.findIndex((l) => l.id === r.id));
  const ro = r.readOnly;

  const accept = () => {
    const name = [...text.trim()].slice(0, 40).join("");
    if (!name) return;
    if (prompt === "new") {
      const id = newLayoutId();
      const res = saveLayout(id, edit(name, r.desktop, r.phone));
      if (res === "saved") setActive(id);
      outcome(res, `“${name}” saved — this device uses it now.`);
    } else if (prompt === "rename") outcome(saveLayout(r.id, edit(name, r.desktop, r.phone)), "Renamed.");
    setPrompt(null);
  };

  // Settings window (SETTINGS-WINDOW.md §5): rows of Appearance's "Layout" card (rows.tsx — the settings shapes)
  return (
    <>
      <ComboRow
        label="Layout on this device"
        description={ro ? "Saved by a newer Tin Hat — update to edit layouts." : "Your layouts follow you to every device."}
        model={list}
        textRole="name"
        currentIndex={idx}
        onActivated={(_, l) => setActive(l.id)}
      />
      <Row
        label="Edit layout"
        description="Move and resize the islands. Ctrl+E or right-clicking a gap between islands opens edit mode anywhere."
        attrs={{ "data-layout-settings": "" }}
        control={
          <Buttons>
            <Button text="Reset layout" icon="view-refresh-symbolic" onClick={resetOnThisDevice} tip="Classic on this device first — then keep it for all devices or restore" />
            <Button
              text="Edit layout"
              icon="window-symbolic"
              highlighted
              onClick={() => {
                bus.emit("closeSettings", {});
                if (phone) openPhoneEditor();
                else window.setTimeout(() => openEdit("desktop"), 0);
              }}
            />
          </Buttons>
        }
      />
      <Row label="Your layouts" description="Save the layout you see as a new one, rename it, or go back a version.">
        <Buttons>
          <Button
            text="New layout…"
            disabled={ro}
            onClick={() => {
              setText(`Layout ${list.length + 1}`);
              setPrompt("new");
            }}
          />
          <Button
            text="Rename…"
            disabled={ro}
            onClick={() => {
              setText(r.name);
              setPrompt("rename");
            }}
          />
          {r.id !== "main" && r.source === "doc" && (
            <Button
              text="Delete"
              danger
              disabled={ro}
              onClick={() => {
                const del: JObj = Object.create(null);
                del["deleted"] = true;
                outcome(saveLayout(r.id, del), `“${r.name}” deleted.`);
                setActive("main");
              }}
            />
          )}
          {r.hasPrevious && (
            <Button
              text="Restore previous version"
              icon="edit-undo-symbolic"
              disabled={ro}
              onClick={() => {
                const p = previousOf(r.id);
                if (p) outcome(saveLayout(r.id, edit(r.name, p.desktop, p.phone)), "The previous version is back (the one it replaced is kept as the previous).");
              }}
            />
          )}
        </Buttons>
        <PromptDialog
          open={prompt !== null}
          onClose={() => setPrompt(null)}
          title={prompt === "new" ? "New layout" : "Rename layout"}
          subtitle={prompt === "new" ? "A copy of the layout you see now." : undefined}
          standardButtons={["save", "cancel"]}
          onAccepted={accept}
          preferredWidth={360}
        >
          <TextField value={text} maxLength={40} aria-label="Layout name" onChange={(e) => setText(e.target.value)} onAccepted={accept} />
        </PromptDialog>
      </Row>
    </>
  );
}

/** Classic forms (the reset's). */
export const classicForms = () => ({ desktop: classicDesktop(), phone: classicPhone() });

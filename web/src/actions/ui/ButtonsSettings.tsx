// ButtonsSettings.tsx — Settings → Appearance → Buttons (11.0 buttons; the desktop's AppearancePane.qml "Buttons"
// section; cards of the Settings window since 2026-09-29, SETTINGS-WINDOW.md): every editable row of today's surfaces with "Edit…" (the row editor; a row you changed also offers "Reset"),
// your own button islands (Edit… / Remove) and "Add a button island" with where it goes. Phones list the phone's rows
// (the header, the message box, the account card, the call bar); button islands are a desktop-layout thing.
import { useState } from "react";
import { Button, ComboBox, ConfirmDialog, useIsMobile } from "@/ui";
import { Buttons, Chip, Hint, Row, Section } from "@/features/settings/rows";
import { PLACEMENTS, addButtonIsland, buttonIslandName, buttonIslands, getForm, removeButtonIsland, setRow, storedRow, useForm, type Placement } from "../layoutStore";
import { openRowEditor } from "./editorStore";
import { EDITABLE_ROWS } from "./RowEditor";
import s from "./ButtonsSettings.module.css";

export const PHONE_ROWS: readonly { island: string; row: string; title: string; hint: string }[] = [
  { island: "header", row: "phoneEnd", title: "Room header", hint: "The call, then the ⋯ menu: game reel, calendar, Memories, call settings, room info" },
  { island: "composer", row: "end", title: "Message box", hint: "Emoji, Send" },
  { island: "account", row: "main", title: "Your account card", hint: "Report a problem, the menu" },
  { island: "call", row: "phoneBar", title: "Call controls", hint: "Mute, camera, flip, share, deafen, soundboard, Leave" },
];

export function ButtonsSettings() {
  const mobile = useIsMobile();
  const kind = mobile ? "phone" : "desktop";
  const form = useForm(kind);
  const islands = mobile ? [] : buttonIslands(form);
  const [place, setPlace] = useState<Placement>("roomColumn");
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rows = mobile ? PHONE_ROWS : EDITABLE_ROWS;
  // Settings window (SETTINGS-WINDOW.md §5): Appearance's "Buttons" card (+ "Your button islands" on the desktop layout),
  // rows of the settings feature's shapes (rows.tsx)
  return (
    <>
      <Section
        title="Buttons"
        id="buttons"
        hint={
          mobile
            ? "Choose the buttons of the header, the message box, your account card and the call — hide the ones you never use, reorder them, add others."
            : "Choose the buttons of the room header, the message box, your account card and the call controls — hide, reorder or add. You can also right-click any of these rows to edit it there."
        }
      >
        {rows.map((r) => {
          const changed = storedRow(form, r.island, r.row) !== undefined;
          return (
            <Row
              key={`${r.island}.${r.row}`}
              attrs={{ "data-row": `${r.island}.${r.row}`, "data-buttons-settings": "" }}
              label={
                <>
                  {r.title}
                  {changed && <Chip>changed</Chip>}
                </>
              }
              description={r.hint}
              control={
                <Buttons>
                  {changed && <Button flat text="Reset" onClick={() => setRow(kind, r.island, r.row, null)} />}
                  <Button text="Edit…" onClick={() => openRowEditor({ island: r.island, row: r.row, form: kind, title: r.title })} />
                </Buttons>
              }
            />
          );
        })}
      </Section>
      {!mobile && (
        <Section title="Your button islands" hint="A row of buttons of your own, anywhere in the window — join a room's call, play a sound, set a status, switch theme… (up to 8).">
          {islands.map((ref) => {
            const name = buttonIslandName(form, ref);
            return (
              <Row
                key={ref}
                attrs={{ "data-island": ref }}
                label={name}
                control={
                  <Buttons>
                    <Button flat text="Remove" onClick={() => setRemoving(ref)} />
                    <Button text="Edit…" onClick={() => openRowEditor({ island: ref, row: "main", form: "desktop", title: name })} />
                  </Buttons>
                }
              />
            );
          })}
          <Row label="Add a button island" description={islands.length >= 8 ? "You have 8 button islands already." : "Pick where it goes, then choose its buttons."}>
            <div className={s.addRow}>
              <ComboBox
                className={s.place}
                model={PLACEMENTS}
                textRole="label"
                currentIndex={PLACEMENTS.findIndex((p) => p.id === place)}
                onActivated={(_, it) => setPlace(it.id)}
                aria-label="Where the new island goes"
              />
              <Button
                highlighted
                icon="list-add-symbolic"
                text="Add a button island"
                disabled={islands.length >= 8}
                onClick={() => {
                  const r = addButtonIsland(place);
                  if (!r.ok) {
                    setError(r.error === "too-many" ? "You have 8 button islands already." : "That place has no room for it — try another.");
                    return;
                  }
                  setError("");
                  openRowEditor({ island: r.ref, row: "main", form: "desktop", title: buttonIslandName(getForm("desktop"), r.ref) });
                }}
              />
            </div>
            {error && <Hint tone="danger">{error}</Hint>}
          </Row>
        </Section>
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        dialogTitle={removing ? `Remove ${buttonIslandName(form, removing)}?` : ""}
        message="Its buttons go with it."
        confirmText="Remove"
        destructive
        onConfirmed={() => removing && void removeButtonIsland(removing)}
      />
    </>
  );
}

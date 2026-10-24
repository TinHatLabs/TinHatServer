// PhoneEditor.tsx — edit mode on a phone (EDITMODE-UI §12): the phone form's sections (Left column = rail, Right column =
// list) in a full-screen sheet — reorder within a column (↑ / ↓), show / hide (the eye), Widgets…, Reset — with the same
// session rules as the desktop editor (undo, Cancel asks, Done saves once). No docking on a phone.
import { useRef, useState } from "react";
import { get, isArr } from "@/layout/json";
import { REGISTRY } from "@/layout";
import { kindOf } from "@/layout/schema";
import { registries } from "@/core/registry";
import { Button, Icon, OverlaySheet, ToolButton, cx } from "@/ui";
import { islandText } from "./names";
import { PHONE_ROWS } from "@/actions/ui/ButtonsSettings";
import { openRowEditor } from "@/actions/ui/editorStore";
import { phoneMove, phoneToggle } from "./session";
import { cancelEdit, doneEdit, editPhone, editPreset, editRedo, editUndo, openEdit, useEdit } from "./store";
import s from "./PhoneEditor.module.css";

export function openPhoneEditor(): void {
  openEdit("phone");
}

export function PhoneEditorHost() {
  const session = useEdit((x) => x.session);
  useEdit((x) => x.v);
  const [confirm, setConfirm] = useState(false);
  // where a section hidden in this session was, so showing it puts it back there (the phone form keeps no position)
  const hiddenAt = useRef(new Map<string, number>());
  if (!session || session.kind !== "phone") return null;
  const f = session.form;
  const col = (k: "rail" | "list") => {
    const a = get(f, k);
    return isArr(a) ? (a.filter((x) => typeof x === "string") as string[]) : [];
  };
  const hidden = (() => {
    const a = get(f, "hidden");
    return isArr(a) ? (a.filter((x) => typeof x === "string") as string[]) : [];
  })();
  const hiddenIn = (k: "rail" | "list") => hidden.filter((r) => REGISTRY[kindOf(r)]?.phone === k);
  const cancel = () => {
    if (session.dirty) setConfirm(true);
    else cancelEdit();
  };
  const row = (ref: string, k: "rail" | "list", i: number, n: number, isHidden: boolean) => {
    const t = islandText(ref);
    return (
      <div key={ref} className={cx(s.row, isHidden && s.hiddenRow)} data-phone-section={ref}>
        <Icon name={t.icon} size={20} color="var(--th-text-primary)" />
        <span className={s.text}>
          <b>{t.name}</b>
          <span>{isHidden ? "Hidden" : t.about}</span>
        </span>
        {!isHidden && (
          <>
            <ToolButton iconName="go-up-symbolic" aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(ref, -1)} />
            <ToolButton iconName="go-down" aria-label={`Move ${t.name} down`} disabled={i === n - 1} onClick={() => move(ref, 1)} />
          </>
        )}
        <ToolButton
          iconName={isHidden ? "view-hidden-symbolic" : "view-visible-symbolic"}
          aria-label={isHidden ? `Show ${t.name}` : `Hide ${t.name}`}
          aria-pressed={!isHidden}
          onClick={() => toggle(ref)}
        />
      </div>
    );
    void k;
  };
  const move = (ref: string, d: -1 | 1) => {
    const next = phoneMove(session.form, ref, d);
    if (next) editPhone(next);
  };
  const toggle = (ref: string) => {
    const rail = col("rail");
    const list = col("list");
    const shownIn = rail.includes(ref) ? rail : list.includes(ref) ? list : null;
    if (shownIn) hiddenAt.current.set(ref, shownIn.indexOf(ref));
    const next = phoneToggle(session.form, ref, shownIn ? undefined : hiddenAt.current.get(ref));
    if (next) editPhone(next);
  };
  const section = (title: string, k: "rail" | "list") => {
    const c = col(k);
    return (
      <div className={s.section}>
        <div className={s.sectionTitle}>{title}</div>
        {c.map((r, i) => row(r, k, i, c.length, false))}
        {hiddenIn(k).map((r) => row(r, k, 0, 0, true))}
      </div>
    );
  };
  return (
    <OverlaySheet
      open
      onClose={cancel}
      showCloseButton={false}
      header={
        <div className={s.header}>
          <Button text="Cancel" flat onClick={cancel} />
          <span className={s.title}>Edit layout</span>
          <Button text="Done" highlighted onClick={() => void doneEdit()} />
        </div>
      }
    >
      <div className={s.body} data-phone-editor="">
        <div className={s.tools}>
          <ToolButton iconName="edit-undo-symbolic" aria-label="Undo" disabled={!session.canUndo} onClick={editUndo} />
          <ToolButton iconName="edit-redo-symbolic" aria-label="Redo" disabled={!session.canRedo} onClick={editRedo} />
        </div>
        {section("Left column", "rail")}
        {section("Right column", "list")}
        {/* EDITMODE-UI §12: the phone's button rows — the row editor; its changes are steps of this session */}
        <div className={s.section}>
          <div className={s.sectionTitle}>Buttons</div>
          {PHONE_ROWS.map((r) => (
            <button
              key={`${r.island}.${r.row}`}
              type="button"
              className={s.link}
              data-phone-row={`${r.island}.${r.row}`}
              onClick={() => openRowEditor({ island: r.island, row: r.row, form: "phone", title: r.title })}
            >
              <Icon name="document-edit-symbolic" size={20} color="var(--th-text-primary)" />
              <span>{r.title}…</span>
            </button>
          ))}
        </div>
        <div className={s.section}>
          <button
            type="button"
            className={s.link}
            onClick={() => {
              const item = registries.appMenu.list().find((m) => m.id === "widgets-add");
              (item as unknown as { run?: (c: unknown) => void } | undefined)?.run?.({});
            }}
          >
            <Icon name="list-add-symbolic" size={20} color="var(--th-text-primary)" />
            <span>Widgets…</span>
          </button>
          <button type="button" className={cx(s.link, s.danger)} onClick={() => editPreset("classic")}>
            <Icon name="view-refresh-symbolic" size={20} color="var(--th-state-danger-bright)" />
            <span>Reset to Classic</span>
          </button>
        </div>
        {confirm && (
          <div className={s.confirm} role="alertdialog" aria-label="Discard changes">
            <span>Discard your layout changes?</span>
            <div className={s.confirmRow}>
              <Button text="Keep editing" onClick={() => setConfirm(false)} />
              <Button
                text="Discard"
                danger
                onClick={() => {
                  setConfirm(false);
                  cancelEdit();
                }}
              />
            </div>
          </div>
        )}
      </div>
    </OverlaySheet>
  );
}

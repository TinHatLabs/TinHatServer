// ThemeEditor.tsx — THEMES-UI.md §13.6: the theme editor panel — non-modal, docked to the window's right edge (phones:
// a bottom sheet over the lower 60 %) — its header (Undo, Redo, Pick, More, Close), the Simple / Advanced switch, the
// body and the footer (Cancel, Save), plus the discard confirmation and Save as. Mounted by the settings feature's
// overlays; everything else lives in editorStore.ts.
import { useEffect, useRef, useState } from "react";
import { isDirty } from "@/theme/editor";
import { BasicToolButton, ConfirmDialog, Button, Icon, InlineMessage, Menu, MenuItem, MenuSeparator, PromptDialog, ScrollArea, TextField, useIsMobile, useMenu, useTip } from "@/ui";
import { copyName } from "@/theme/editor";
import { cancel, exportFile, redo, resetAll, save, undo, useEditor, workingDoc } from "./editorStore";
import { SimpleMode } from "./Simple";
import { AdvancedMode } from "./Advanced";
import { PickOverlay, togglePick } from "./PickOverlay";
import { openShareRoom } from "../share/shareStore";
import s from "./editor.module.css";

function HeaderButton({ icon, tip, onClick, disabled, pressed, mirror }: { icon: string; tip: string; onClick: () => void; disabled?: boolean; pressed?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, tip);
  return (
    <button ref={ref} type="button" className={s.iconBtn} aria-label={tip} aria-pressed={pressed === undefined ? undefined : pressed} disabled={disabled} onClick={onClick}>
      <span className={mirror ? s.mirror : undefined}>
        <Icon name={icon} size={16} color="var(--th-settings-fg)" />
      </span>
    </button>
  );
}

const inText = (el: Element | null) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);

function EditorPanel() {
  const mobile = useIsMobile();
  const st = useEditor();
  const more = useMenu();
  const panelRef = useRef<HTMLDivElement>(null);
  const session = st.session;
  const dirty = session ? isDirty(session) : false;

  // keys (§13.3, §15.3): Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside text fields; Esc and P while the panel has the focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inText(document.activeElement)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !e.altKey && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      const inside = panelRef.current?.contains(document.activeElement) ?? false;
      if (!inside || mod || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        togglePick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!session) return null;
  const meta = st.target.kind === "mine" ? "One of My themes" : `A new theme from ${st.baseName}`;
  return (
    <div ref={panelRef} className={s.panel} data-mobile={mobile ? "" : undefined} role="dialog" aria-label="Edit theme" aria-modal="false">
      <div className={s.header}>
        <div className={s.titles}>
          <span className={s.title}>Edit theme</span>
          <span className={s.meta}>{meta}</span>
        </div>
        <HeaderButton icon="edit-undo-symbolic" tip="Undo" disabled={session.past.length === 0} onClick={undo} />
        <HeaderButton icon="edit-redo-symbolic" tip="Redo" disabled={session.future.length === 0} onClick={redo} />
        <HeaderButton icon="color-picker" tip="Pick a colour from the app" pressed={st.pickArmed} onClick={togglePick} />
        <button
          type="button"
          className={s.iconBtn}
          aria-label="More"
          title="More"
          aria-haspopup="menu"
          aria-expanded={more.open}
          onClick={(e) => more.openAt(e.currentTarget)}
        >
          <Icon name="view-more-symbolic" size={16} color="var(--th-settings-fg)" />
        </button>
        <HeaderButton icon="window-close-symbolic" tip="Close" onClick={() => cancel()} />
      </div>
      {more.open && (
        <Menu {...more.props} title="More">
          <MenuItem text="Save as a new theme…" icon="list-add-symbolic" onTriggered={() => (more.close(), useEditor.setState({ saveAsOpen: true }))} />
          <MenuItem text="Export…" icon="document-save-symbolic" onTriggered={() => (more.close(), exportFile())} />
          <MenuItem
            text="Share to a room…"
            icon="document-send-symbolic"
            onTriggered={() => {
              more.close();
              const d = workingDoc();
              if (d) openShareRoom(d);
            }}
          />
          <MenuSeparator />
          <MenuItem text="Reset all changes" icon="edit-undo-symbolic" disabled={!dirty} onTriggered={() => (more.close(), resetAll())} />
        </Menu>
      )}
      <div className={s.modeRow} role="radiogroup" aria-label="Mode">
        {(["simple", "advanced"] as const).map((m) => (
          <BasicToolButton
            key={m}
            display="textOnly"
            text={m === "simple" ? "Simple" : "Advanced"}
            checked={st.mode === m}
            role="radio"
            aria-checked={st.mode === m}
            aria-pressed={undefined}
            onClick={() => useEditor.setState({ mode: m })}
          />
        ))}
        <span className={s.spacer} />
        {dirty && <span className={s.dirty}>Not saved</span>}
      </div>
      <div className={s.body}>
        {st.mode === "simple" ? (
          <ScrollArea style={{ height: "100%" }} contentClassName={s.bodyInner}>
            <SimpleMode />
          </ScrollArea>
        ) : (
          <div className={s.advBody}>
            <AdvancedMode />
          </div>
        )}
      </div>
      <div className={s.footer}>
        {st.saveError && <InlineMessage type="error" text={st.saveError} />}
        <div className={s.footerButtons}>
          <Button text="Cancel" onClick={() => cancel()} />
          <Button text="Save" highlighted disabled={st.target.kind === "mine" && !dirty} onClick={() => save()} />
        </div>
      </div>
    </div>
  );
}

function SaveAsDialog() {
  const open = useEditor((st) => st.saveAsOpen);
  const session = useEditor((st) => st.session);
  const target = useEditor((st) => st.target);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open && session) {
      const n = String(session.doc.name ?? "");
      setName(target.kind === "mine" ? copyName(n) : n);
    }
  }, [open, session, target]);
  const accept = () => {
    const n = name.trim();
    if (!n || [...n].length > 80) return;
    useEditor.setState({ saveAsOpen: false });
    save(n);
  };
  return (
    <PromptDialog open={open} onClose={() => useEditor.setState({ saveAsOpen: false })} title="Save as a new theme" standardButtons={["save", "cancel"]} onAccepted={accept} preferredWidth={360}>
      <TextField value={name} maxLength={80} aria-label="Theme name" onChange={(e) => setName(e.target.value)} onAccepted={accept} />
    </PromptDialog>
  );
}

/** The editor's overlay host (settings feature overlays): the panel, its dialogs and the Pick tool. */
export function ThemeEditorHost() {
  const open = useEditor((st) => st.open);
  const confirm = useEditor((st) => st.confirmDiscard);
  const name = useEditor((st) => String(st.session?.doc.name ?? ""));
  const pickArmed = useEditor((st) => st.pickArmed);
  if (!open) return null;
  return (
    <>
      <EditorPanel />
      {pickArmed && <PickOverlay />}
      <SaveAsDialog />
      <ConfirmDialog
        open={confirm}
        onClose={() => useEditor.setState({ confirmDiscard: false })}
        dialogTitle="Discard changes?"
        message={`Discard your changes to ${name}?`}
        confirmText="Discard"
        cancelText="Keep editing"
        destructive
        onConfirmed={() => cancel(true)}
      />
    </>
  );
}


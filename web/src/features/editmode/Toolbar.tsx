// Toolbar.tsx — edit mode's toolbar (EDITMODE-UI §3, §7, §8, §9, §11): a 52 px strip above the dock host (the host is
// that much shorter while editing, so the bar never covers an island's handle), the bar centred in it.
// Editing: ‹name› · Undo · Redo · Presets ▾ · Add island ▾ · Add widget · Reset · Cancel · Done. The keyboard shortcuts of
// a session live here too (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; Ctrl+E and Ctrl+Enter = Done — Ctrl+E is the shell's).
import { useMemo, useRef, useState, type ReactNode } from "react";
import { presetDesktop, solve, type JObj } from "@/layout";
import { registries } from "@/core/registry";
import { useShortcut } from "@/core/shortcuts";
import { Icon, Popover, cx, useTip } from "@/ui";
import { canon } from "@/layout";
import { cancelDrag, useDrag, type SolveCtx } from "./drag";
import { islandText } from "./names";
import { hiddenRefs } from "./session";
import { cancelEdit, doneEdit, editApply, editNewButtons, editPreset, editRedo, editReset, editUndo, useEdit } from "./store";
import { openRowEditor } from "@/actions/ui/editorStore";
import { trackPointer } from "./EditLayer";
import s from "./Toolbar.module.css";

export const PRESETS: readonly { id: string; name: string; line: string }[] = [
  { id: "classic", name: "Classic", line: "Spaces and rooms on the left, the room on the right." },
  { id: "compact", name: "Compact", line: "Tighter gaps and a narrower room list." },
  { id: "callFirst", name: "Call-first", line: "The call takes the big spot; chat sits beside it." },
  { id: "sideMonitor", name: "Side monitor", line: "For a tall, narrow window: spaces across the top." },
  { id: "handheld", name: "Handheld", line: "Rooms and widgets share a column as tabs." },
];

function TBtn({ icon, label, showLabel = true, onClick, disabled, tip, accent, btnRef, badge, data }: {
  icon?: string;
  label: string;
  showLabel?: boolean;
  onClick: () => void;
  disabled?: boolean;
  tip?: string;
  accent?: boolean;
  btnRef?: (el: HTMLButtonElement | null) => void;
  badge?: number;
  data?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useTip(ref, tip ?? (showLabel ? undefined : label), { placement: "below" });
  return (
    <button
      type="button"
      ref={(el) => {
        ref.current = el;
        btnRef?.(el);
      }}
      className={cx(s.btn, accent && s.accent, !showLabel && s.iconOnly)}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      data-edit-tool={data}
    >
      {icon && <Icon name={icon} size={16} color={accent ? "var(--th-text-on-accent)" : "var(--th-text-primary)"} />}
      {showLabel && <span>{label}</span>}
      {!!badge && <span className={s.badge}>{badge}</span>}
    </button>
  );
}

export function Toolbar({ hostW, ctx }: { hostW: number; ctx?: SolveCtx | null }) {
  const session = useEdit((x) => x.session);
  useEdit((x) => x.v);
  const readOnly = useEdit((x) => x.readOnly);
  const [presetsAt, setPresetsAt] = useState<HTMLElement | null>(null);
  const [addAt, setAddAt] = useState<HTMLElement | null>(null);
  const [confirmAt, setConfirmAt] = useState<HTMLElement | null>(null);
  const presetBtn = useRef<HTMLButtonElement | null>(null);
  const addBtn = useRef<HTMLButtonElement | null>(null);
  const cancelBtn = useRef<HTMLButtonElement | null>(null);

  useShortcut("Ctrl+Z", () => (useDrag.getState().drag ? false : (editUndo(), true)), { whenTyping: true, priority: 50 });
  useShortcut(["Ctrl+Shift+Z", "Ctrl+Y"], () => (useDrag.getState().drag ? false : (editRedo(), true)), { whenTyping: true, priority: 50 });
  useShortcut("Ctrl+Enter", () => (doneEdit(), true), { whenTyping: true, priority: 50 });

  if (!session) return null;
  const hidden = hiddenRefs(session.form);
  const labels = hostW >= 980;
  const nameChip = hostW >= 760;
  const dirty = session.dirty;
  const cancel = () => {
    cancelDrag();
    if (session.dirty && !readOnly) setConfirmAt(cancelBtn.current);
    else cancelEdit();
  };

  return (
    <div className={s.strip}>
    <div className={s.bar} role="toolbar" aria-label="Edit layout" data-edit-toolbar="">
      {nameChip && (
        <span className={s.name}>
          {readOnly ? "Viewing" : "Editing"}: <b>{session.name}</b>
        </span>
      )}
      {!readOnly && (
        <>
          <span className={s.sep} />
          <TBtn icon="edit-undo-symbolic" label="Undo" showLabel={false} tip="Undo (Ctrl+Z)" onClick={editUndo} disabled={!session.canUndo} data="undo" />
          <TBtn icon="edit-redo-symbolic" label="Redo" showLabel={false} tip="Redo (Ctrl+Shift+Z)" onClick={editRedo} disabled={!session.canRedo} data="redo" />
          <span className={s.sep} />
          <TBtn
            icon="view-grid-symbolic"
            label="Presets"
            showLabel={labels}
            btnRef={(el) => (presetBtn.current = el)}
            onClick={() => setPresetsAt(presetBtn.current)}
            data="presets"
          />
          <TBtn
            icon="window-new"
            label="Add island"
            showLabel={labels}
            badge={hidden.length}
            btnRef={(el) => (addBtn.current = el)}
            onClick={() => setAddAt(addBtn.current)}
            data="add-island"
          />
          <TBtn icon="list-add-symbolic" label="Add widget" showLabel={labels} onClick={addWidget} data="add-widget" />
          <span className={s.sep} />
          <TBtn icon="view-refresh-symbolic" label="Reset" showLabel={labels} tip="Reset to Classic" onClick={editReset} data="reset" />
          <span className={s.sep} />
          <TBtn label="Cancel" onClick={cancel} btnRef={(el) => (cancelBtn.current = el)} data="cancel" />
        </>
      )}
      <TBtn label={readOnly ? "Close" : "Done"} accent onClick={() => void doneEdit()} data="done" tip={readOnly ? undefined : dirty ? "Save and close (Ctrl+E)" : "Close (Ctrl+E)"} />

      {presetsAt && <PresetsMenu anchor={presetsAt} form={session.form} start={session.start} ctx={ctx ?? undefined} onClose={() => setPresetsAt(null)} />}
      {addAt && <AddIslandPopover anchor={addAt} hidden={hidden} onClose={() => setAddAt(null)} />}
      {confirmAt && (
        <Popover open anchor={confirmAt} placement="below" align="end" onClose={() => setConfirmAt(null)} aria-label="Discard changes">
          <div className={s.confirm}>
            <span>Discard your layout changes?</span>
            <div className={s.confirmRow}>
              <button type="button" className={s.btn} onClick={() => setConfirmAt(null)}>
                Keep editing
              </button>
              <button
                type="button"
                className={cx(s.btn, s.danger)}
                data-edit-tool="discard"
                onClick={() => {
                  setConfirmAt(null);
                  cancelEdit();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </Popover>
      )}
    </div>
    </div>
  );
}

/** Add widget (EDITMODE-UI §7): the widget gallery; a hidden widgets island comes back first (one undo step). */
function addWidget(): void {
  const s = useEdit.getState().session;
  if (s && hiddenRefs(s.form).includes("widgets")) editApply({ op: "restore", ref: "widgets" });
  const item = registries.appMenu.list().find((m) => m.id === "widgets-add");
  (item as unknown as { run?: (c: unknown) => void } | undefined)?.run?.({});
}

function PresetsMenu({ anchor, form, start, ctx, onClose }: { anchor: HTMLElement; form: JObj; start: JObj; ctx?: SolveCtx; onClose: () => void }) {
  const current = typeof form["preset"] === "string" ? (form["preset"] as string) : null;
  const changed = canon(form) !== canon(start);
  const pick = (id: string) => {
    onClose();
    editPreset(id);
  };
  const row = (id: string, name: string, line: string, thumb: ReactNode) => (
    <div
      key={id}
      className={cx(s.row, s.presetRow)}
      role="menuitemradio"
      aria-checked={current === id}
      tabIndex={0}
      data-edit-preset={id}
      onClick={() => pick(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick(id);
        }
      }}
    >
      {thumb}
      <span className={s.rowText}>
        <b>{name}</b>
        <span>{line}</span>
      </span>
      <span className={s.check} aria-hidden>
        {current === id && <Icon name="checkmark-symbolic" size={16} color="var(--th-accent-bright)" />}
      </span>
    </div>
  );
  return (
    <Popover open anchor={anchor} placement="below" align="start" onClose={onClose} aria-label="Presets" padding={4}>
      <div className={s.drawer} role="menu" style={{ width: 360 }}>
        {PRESETS.map((p) => row(p.id, p.name, p.line, <PresetThumb id={p.id} ctx={ctx} />))}
        {changed && row("previous", "Previous", "What you had when you opened edit mode.", <PresetThumb id="previous" ctx={ctx} form={start} />)}
      </div>
    </Popover>
  );
}

/** A preset's static schematic (EDITMODE-UI §8): its desktop form solved at the host's size, drawn as rounded rects. */
export function PresetThumb({ id, ctx, form }: { id: string; ctx?: SolveCtx; form?: JObj }) {
  const rects = useMemo(() => {
    const f = form ?? presetDesktop(id);
    if (!f || !ctx) return null;
    const o = solve(f, ctx.size as never, ctx.unitPm, ctx.shape ?? undefined, ctx.content, ctx.view ?? undefined);
    return Object.entries(o.islands)
      .filter(([, r]) => r.vis !== false && r.w > 0 && r.h > 0 && (r.z ?? 0) < 20)
      .map(([ref, r]) => ({ ref, ...r }));
  }, [id, ctx, form]);
  if (!rects || !ctx) return null;
  const W = 96;
  const H = 60;
  const k = Math.min(W / Math.max(1, ctx.size.w), H / Math.max(1, ctx.size.h));
  return (
    <span className={s.thumb} style={{ width: W, height: H }} aria-hidden>
      {rects.map((r) => (
        <i
          key={r.ref}
          className={cx(s.ti, (r.ref === "call" || r.ref === "timeline") && s.tiMain)}
          style={{ left: Math.round(r.x * k), top: Math.round(r.y * k), width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) }}
        />
      ))}
    </span>
  );
}

function AddIslandPopover({ anchor, hidden, onClose }: { anchor: HTMLElement; hidden: string[]; onClose: () => void }) {
  const rows: ReactNode[] = hidden.map((ref) => {
    const t = islandText(ref);
    return (
      <div
        key={ref}
        className={s.row}
        role="button"
        tabIndex={0}
        data-edit-hidden={ref}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // a click restores it (its `from`, else the home rules); a drag moves it into a zone
          trackPointer(
            ref,
            e,
            () => {
              editApply({ op: "restore", ref });
              onClose();
            },
            onClose,
          );
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            editApply({ op: "restore", ref });
            onClose();
          }
        }}
      >
        <Icon name={t.icon} size={20} color="var(--th-text-primary)" />
        <span className={s.rowText}>
          <b>{t.name}</b>
          <span>{t.about}</span>
        </span>
        <button
          type="button"
          className={s.btn}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            editApply({ op: "restore", ref });
            onClose();
          }}
        >
          Restore
        </button>
      </div>
    );
  });
  return (
    <Popover open anchor={anchor} placement="below" align="center" onClose={onClose} aria-label="Hidden islands" padding={4}>
      <div className={s.drawer}>
        {rows.length ? rows : <div className={s.empty}>Nothing hidden. Hide an island from its ⋯ menu to keep it here.</div>}
        <div
          className={s.row}
          role="button"
          tabIndex={0}
          data-edit-new-buttons=""
          onClick={() => {
            onClose();
            const ref = editNewButtons();
            if (ref) openRowEditor({ island: ref, row: "main", form: "desktop", title: islandText(ref).name });
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).click();
          }}
        >
          <Icon name="list-add-symbolic" size={20} color="var(--th-text-primary)" />
          <span className={s.rowText}>
            <b>New button island</b>
            <span>A row of buttons of your own, Stream Deck style</span>
          </span>
        </div>
      </div>
    </Popover>
  );
}

// EditLayer.tsx — edit mode's chrome over the dock host (EDITMODE-UI §2-§6, §11): drawn inside the host (the islands'
// coordinate space) above every island (z band 30), it takes the pointer so island contents don't react while editing.
// Per visible island: the veil + outline, the handle chip (drag source, focus stop) and the ⋯ menu — in the islands' z
// order (zorder.ts: a float's chrome above the docked ones'). The placeholders of islands whose real content is absent
// are drawn by the islands' own frames (Placeholder.tsx via the shell), so a float covers them (§20). The gaps become
// resize handles. While a move is in progress: the hovered zone, the landing preview and the ghost above every island's
// chrome — nothing else draws, nothing loops (§15). The toolbar sits on top (Toolbar.tsx).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { applyOp, REGISTRY, type JObj, type SolveOut } from "@/layout";
import { get, isObj } from "@/layout/json";
import type { GapOut, Rect } from "@/layout/solve";
import { kindOf, isKnownRef } from "@/layout/schema";
import { Icon, Menu, MenuItem, MenuSeparator } from "@/ui";
import { openRowEditor } from "@/actions/ui/editorStore";
import { EDITABLE_ROWS } from "@/actions/ui/RowEditor";
import { beginDrag, cancelDrag, dropDrag, movePointer, stepHover, useDrag, type SolveCtx } from "./drag";
import { islandText } from "./names";
import { floatOf } from "./session";
import { doneEdit, editApply, editCommit, editDock, editFloat, editRemoveButtons, editResetIsland, setPreview, useEdit } from "./store";
import { setTab } from "./tabs";
import { GAP_Z, GHOST_Z, LAYER_Z, PREVIEW_Z, ZONE_Z, chromeRefs, chromeZ, tabChipsZ } from "./zorder";
import s from "./EditLayer.module.css";

/** The layer element (host coordinates) — the Add island drawer starts drags against it. */
let layerEl: HTMLDivElement | null = null;
let lastCtx: SolveCtx | null = null;
/** The solve inputs of the rendered working copy (the test hook's scripted moves use them). */
export const currentCtx = (): SolveCtx | null => lastCtx;

function hostPoint(cx: number, cy: number): { x: number; y: number } {
  const r = layerEl?.getBoundingClientRect();
  return r ? { x: Math.round(cx - r.left), y: Math.round(cy - r.top) } : { x: cx, y: cy };
}

/**
 * Track a pointer that went down on a drag source (a chip, a tab, a drawer row): past 4 px it becomes a move of `ref`;
 * released without moving it is a click (`onClick`). Window listeners, so the source may unmount (the drawer closes).
 */
export function trackPointer(ref: string, e: { clientX: number; clientY: number; pointerId: number; button: number }, onClick?: () => void, onStart?: () => void): void {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4 || !lastCtx) return;
      if (!beginDrag(ref, "pointer", lastCtx, ev.clientX, ev.clientY)) {
        stop();
        return;
      }
      dragging = true;
      onStart?.();
    }
    const p = hostPoint(ev.clientX, ev.clientY);
    movePointer(p.x, p.y, ev.clientX, ev.clientY);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    stop();
    if (dragging) dropDrag();
    else onClick?.();
  };
  const cancel = () => {
    stop();
    if (dragging) cancelDrag();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && dragging) {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    }
  };
  function stop() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key, true);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key, true);
}

const rectStyle = (r: { x: number; y: number; w: number; h: number }): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

export function EditLayer({ out, ctx, form }: { out: SolveOut; ctx: SolveCtx; form: JObj }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const readOnly = useEdit((x) => x.readOnly);
  const drag = useDrag((x) => x.drag);
  const announce = useDrag((x) => x.announce);
  const [menu, setMenu] = useState<{ ref: string; anchor: HTMLElement | { x: number; y: number } } | null>(null);
  const [focusRef, setFocusRef] = useState<string | null>(null);
  lastCtx = ctx;

  useEffect(() => {
    layerEl = rootRef.current;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      layerEl = null;
      cancelDrag();
      setPreview(null);
    };
  }, []);

  // keyboard moves (EDITMODE-UI §11): arrows between zones, Enter drops, Esc cancels
  useEffect(() => {
    if (!drag || drag.mode !== "keys") return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowUp") stepHover(-1);
      else if (k === "ArrowRight" || k === "ArrowDown") stepHover(1);
      else if (k === "Enter" || k === " ") dropDrag();
      else if (k === "Escape") cancelDrag();
      else if (k !== "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "Tab") cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag?.mode, drag?.ref]); // eslint-disable-line react-hooks/exhaustive-deps

  // the islands with chrome, in the region order (Tab order), then button islands in ref order
  const refs = useMemo(() => chromeRefs(out), [out]);
  const buttonIndex = useMemo(() => {
    const b = refs.filter((r) => kindOf(r) === "buttons").sort();
    return (ref: string) => b.indexOf(ref) + 1;
  }, [refs]);

  const openMenu = useCallback((ref: string, anchor: HTMLElement | { x: number; y: number }) => {
    if (useEdit.getState().readOnly) return;
    setMenu({ ref, anchor });
  }, []);

  const host = ctx.size;
  const dragging = drag?.ref ?? null;
  const hz = drag && drag.hover >= 0 ? drag.zones[drag.hover] : null;

  return (
    <div
      ref={rootRef}
      className={s.layer}
      style={{ zIndex: LAYER_Z }}
      data-edit-layer=""
      role="application"
      aria-label="Edit layout"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        // the layer itself (over island contents): nothing to click through to
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      {refs.map((ref) => {
        const r = out.islands[ref];
        const t = islandText(ref, kindOf(ref) === "buttons" ? buttonIndex(ref) : undefined);
        const narrow = r.w < 132;
        const short = r.h < 72;
        const unknown = !isKnownRef(ref);
        const selected = dragging === ref || focusRef === ref;
        return (
          <div
            key={ref}
            className={s.island}
            style={{ ...rectStyle(r), zIndex: chromeZ(r.z) }}
            data-short={short ? "" : undefined}
            data-edit-island={ref}
            data-selected={selected ? "" : undefined}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!unknown) openMenu(ref, { x: e.clientX, y: e.clientY });
            }}
          >
            <button
              type="button"
              className={s.chip}
              data-narrow={narrow ? "" : undefined}
              data-edit-chip={ref}
              aria-label={unknown ? t.name : `Move ${t.name}`}
              title={narrow ? t.name : undefined}
              disabled={unknown || readOnly}
              onFocus={() => setFocusRef(ref)}
              onBlur={() => setFocusRef((f) => (f === ref ? null : f))}
              onPointerDown={(e: RPointerEvent<HTMLButtonElement>) => {
                if (e.button !== 0) return;
                e.preventDefault();
                (e.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
                const el = e.currentTarget;
                trackPointer(ref, e, narrow ? () => openMenu(ref, el) : undefined);
              }}
              onKeyDown={(e) => {
                if (drag) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  beginDrag(ref, "keys", ctx);
                } else if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  const d = REGISTRY[kindOf(ref)];
                  if (d?.hideable && !d.required) editApply({ op: "hide", ref });
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  openMenu(ref, e.currentTarget);
                }
              }}
            >
              <span className={s.grip} aria-hidden>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <i key={i} />
                ))}
              </span>
              {!narrow && <span className={s.chipName}>{t.name}</span>}
            </button>
            {!narrow && !unknown && (
              <button
                type="button"
                className={s.more}
                aria-label={`${t.name} options`}
                disabled={readOnly}
                onClick={(e) => openMenu(ref, e.currentTarget)}
              >
                <Icon name="view-more-horizontal-symbolic" size={16} color="var(--th-editmode-handle-fg)" />
              </button>
            )}
          </div>
        );
      })}

      {/* stacks: their tabs as chips over the strip — click shows that tab, drag moves that island (EDITMODE-UI §4.2) */}
      {Object.entries(out.stacks).map(([id, st]) =>
        st.vis && st.tab > 0 && (st.z ?? 0) < LAYER_Z ? (
          <div key={`tabs:${id}`} className={s.tabChips} style={{ left: st.x, top: st.y, width: st.w, height: st.tab, zIndex: tabChipsZ(st.z) }} data-edit-stack={id}>
            {st.tabs.map((ref) => (
              <button
                key={ref}
                type="button"
                className={s.tabChip}
                data-active={ref === st.active ? "" : undefined}
                data-edit-tab={ref}
                aria-label={`Move ${islandText(ref).name} (tab)`}
                disabled={readOnly}
                style={{ maxWidth: Math.max(40, Math.floor(st.w / Math.max(1, st.tabs.length)) - 4) }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  trackPointer(ref, e, () => setTab(id, ref));
                }}
                onKeyDown={(e) => {
                  if (drag) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    beginDrag(ref, "keys", ctx);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenu(ref, { x: e.clientX, y: e.clientY });
                }}
              >
                <span className={s.grip} aria-hidden>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <i key={i} />
                  ))}
                </span>
                <span className={s.chipName}>{islandText(ref).name}</span>
              </button>
            ))}
          </div>
        ) : null,
      )}

      {!drag && !readOnly && out.gaps.map((g) => <GapHandle key={g.id} gap={g} ctx={ctx} form={form} />)}

      {hz && <ZoneMark rect={hz.rect} kind={hz.kind} op={hz.op} />}
      {drag?.preview && <div className={s.preview} style={{ ...rectStyle(drag.preview), zIndex: PREVIEW_Z }} />}
      {drag && drag.mode === "pointer" && (
        <div className={s.ghost} style={{ left: drag.px + 12, top: drag.py + 12, zIndex: GHOST_Z }} aria-hidden>
          <span className={s.grip}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <i key={i} />
            ))}
          </span>
          <span className={s.chipName}>{islandText(drag.ref).name}</span>
        </div>
      )}

      <div className={s.sr} aria-live="polite">
        {announce}
      </div>

      {menu && (
        <IslandMenu
          islandRef={menu.ref}
          anchor={menu.anchor}
          form={form}
          rect={out.islands[menu.ref]}
          host={host}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function IslandMenu({
  islandRef: ref,
  anchor,
  form,
  rect,
  host,
  onClose,
}: {
  islandRef: string;
  anchor: HTMLElement | { x: number; y: number };
  form: JObj;
  rect: { x: number; y: number; w: number; h: number } | undefined;
  host: { w: number; h: number };
  onClose: () => void;
}) {
  const d = REGISTRY[kindOf(ref)];
  if (!d) return null;
  const floating = floatOf(form, ref) !== null;
  const hideable = d.hideable && !d.required;
  // the island's button rows (EDITMODE-UI §4.1: the row editor; its changes are steps of this session)
  const rows = kindOf(ref) === "buttons" ? [{ island: ref, row: "main", title: islandText(ref).name }] : EDITABLE_ROWS.filter((r) => r.island === ref);
  return (
    <Menu open onClose={onClose} anchor={anchor} width={240}>
      {rows.map((r) => (
        <MenuItem
          key={`${r.island}.${r.row}`}
          text={rows.length > 1 ? `Buttons: ${r.title}…` : "Edit buttons…"}
          icon="document-edit-symbolic"
          onTriggered={() => openRowEditor({ island: r.island, row: r.row, form: "desktop", title: r.title })}
        />
      ))}
      {rows.length > 0 && <MenuSeparator />}
      {hideable && <MenuItem text="Hide" icon="view-hidden-symbolic" shortcut="Del" onTriggered={() => editApply({ op: "hide", ref })} />}
      {d.floatable && !floating && rect && <MenuItem text="Float" icon="window-pin-symbolic" onTriggered={() => editFloat(ref, rect, host)} />}
      {floating && <MenuItem text="Dock" icon="view-restore-symbolic" onTriggered={() => editDock(ref)} />}
      {hideable && kindOf(ref) !== "buttons" && (
        <>
          <MenuSeparator />
          <MenuItem text="Reset this island" icon="view-refresh-symbolic" onTriggered={() => editResetIsland(ref)} />
        </>
      )}
      {kindOf(ref) === "buttons" && (
        <>
          <MenuSeparator />
          <MenuItem text="Remove this button island" icon="edit-delete-symbolic" danger onTriggered={() => editRemoveButtons(ref)} />
        </>
      )}
      {!hideable && !d.floatable && <MenuItem text="This island stays where the room is" disabled onTriggered={() => undefined} />}
    </Menu>
  );
}

/** The hovered drop zone: its band + the bar on the target's (or the window's) edge; a centre shows the tab glyph. */
function ZoneMark({ rect, kind, op }: { rect: Rect; kind: string; op: JObj }) {
  const o = get(op, "op") === "restore" && isObj(get(op, "to")) ? (get(op, "to") as JObj) : op;
  const side = String(get(o, "side") ?? "");
  const anchor = String(get(o, "anchor") ?? "");
  const bars: string[] = kind === "corner" ? [anchor.includes("t") ? "top" : "bottom", anchor.includes("l") ? "left" : "right"] : kind === "centre" ? [] : [side];
  return (
    <div className={s.zone} style={{ ...rectStyle(rect), zIndex: ZONE_Z }} data-zone={kind}>
      {bars.map((b) => (
        <span key={b} className={s.bar} data-side={b} />
      ))}
      {kind === "centre" && <Icon name="window-duplicate-symbolic" size={24} color="var(--th-editmode-zone-edge)" />}
    </div>
  );
}

/** A gap as a resize handle (EDITMODE-UI §6): drag = resize against the form at drag start (4 px grid by the engine),
 *  release = one undo step; double-click = resetSizes; arrows ±4 px (Shift ±32), Enter = reset. */
function GapHandle({ gap: g, ctx, form }: { gap: GapOut; ctx: SolveCtx; form: JObj }) {
  const [pressed, setPressed] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const band = 8;
  const style: CSSProperties =
    g.axis === "x"
      ? { left: g.x + g.w / 2 - Math.max(band, g.w) / 2, top: g.y, width: Math.max(band, g.w), height: g.h, zIndex: GAP_Z }
      : { left: g.x, top: g.y + g.h / 2 - Math.max(band, g.h) / 2, width: g.w, height: Math.max(band, g.h), zIndex: GAP_Z };
  const ctxJ = () => JSON.parse(JSON.stringify({ size: ctx.size, unitPm: ctx.unitPm, ...(ctx.shape ? { shape: ctx.shape } : {}), content: ctx.content, ...(ctx.view ? { view: ctx.view } : {}) }));
  const resizeBy = (start: JObj, c: unknown, delta: number) => {
    const r = applyOp(start, { op: "resize", a: g.a, b: g.b, delta, into: true }, c as never);
    return r.ok ? r.form : null;
  };
  return (
    <div
      className={s.gap}
      style={style}
      data-axis={g.axis}
      data-pressed={pressed ? "" : undefined}
      data-edit-gap={g.id}
      role="separator"
      aria-orientation={g.axis === "x" ? "vertical" : "horizontal"}
      aria-label={`Resize between ${g.a} and ${g.b}`}
      tabIndex={0}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={() => editApply({ op: "resetSizes", a: g.a, b: g.b }, ctxJ())}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const start = form;
        const c = ctxJ();
        const x0 = e.clientX;
        const y0 = e.clientY;
        let last: JObj | null = null;
        setPressed(true);
        const move = (ev: PointerEvent) => {
          const delta = Math.round(g.axis === "x" ? ev.clientX - x0 : ev.clientY - y0);
          const f = resizeBy(start, c, delta);
          if (f) {
            last = f;
            setPreview(f);
          }
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          setPressed(false);
          setPreview(null);
          if (last) editCommit(last);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 4;
        let delta = 0;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") delta = -step;
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") delta = step;
        else if (e.key === "Enter") {
          e.preventDefault();
          editApply({ op: "resetSizes", a: g.a, b: g.b }, ctxJ());
          return;
        } else return;
        e.preventDefault();
        const f = resizeBy(form, ctxJ(), delta);
        if (f) editCommit(f);
      }}
    >
      {menuAt && (
        <Menu open onClose={() => setMenuAt(null)} anchor={menuAt} width={220}>
          <MenuItem text="Reset these sizes" icon="view-refresh-symbolic" onTriggered={() => editApply({ op: "resetSizes", a: g.a, b: g.b }, ctxJ())} />
          <MenuItem text="Done editing" icon="checkmark-symbolic" shortcut="Ctrl+E" onTriggered={() => void doneEdit()} />
        </Menu>
      )}
    </div>
  );
}

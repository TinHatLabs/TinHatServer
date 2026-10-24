// Frame.tsx — one widget island (contract WIDGETS-UI.md §2): the 30 px header (icon, title, live dot, the extra slot,
// ⋯) over the body; collapsed / Small = the header with the one-line summary. Clicking the header collapses /
// expands; dragging it reorders (Stack.tsx owns the drag); ⋯ = Size, Collapse, Settings…, Move up / down, Add widget…,
// Remove. A widget id this app doesn't know shows "Needs a newer Tin Hat" (kept, never dropped).
import { memo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { CheckBox, ComboBox, Dialog, Icon, Menu, MenuItem, MenuSectionLabel, MenuSeparator, cx, useAnimate, useTip } from "@/ui";
import { SIZES, settingsOf, sizeOf, widgetDef, type WidgetItem, type WidgetSize } from "@/widgets/registry";
import { widgetImpl, type WidgetCtx, type WidgetImpl } from "./impl";
import { useMockModel } from "./mock";
import { moveWidget, removeWidget, setCollapsed, setSetting, setSize } from "./store";
import s from "./Frame.module.css";

const SIZE_LABEL: Record<WidgetSize, string> = { S: "Small", M: "Medium", L: "Large" };

export interface FrameProps {
  item: WidgetItem;
  index: number;
  count: number;
  mobile: boolean;
  /** folded by the stack because space ran out (not saved) */
  autoFolded: boolean;
  /** the header was clicked while auto-folded: the stack keeps this one open */
  onPin: (w: string) => void;
  onOpenGallery: () => void;
  /** drag reorder (desktop): the stack's pointer handlers for the header */
  onDragStart?: (w: string, e: RPointerEvent<HTMLElement>) => void;
  dragOffset?: number;
  dragging?: boolean;
  /** measured height reporter (the stack's auto-fold keeps each widget's open height) */
  frameRef?: (el: HTMLElement | null) => void;
  /** a drag just ended on this header: swallow the click */
  consumeClick?: () => boolean;
  enter?: boolean;
}

export const WidgetFrame = memo(function WidgetFrame(p: FrameProps) {
  const impl = widgetImpl(p.item.w);
  const def = widgetDef(p.item.w);
  if (!impl || !def) return <UnknownFrame {...p} />;
  return <KnownFrame {...p} impl={impl} />;
});

function KnownFrame(p: FrameProps & { impl: WidgetImpl<unknown> }) {
  const { item, impl } = p;
  const def = widgetDef(item.w)!;
  const size = sizeOf(item);
  const ctx: WidgetCtx = { id: item.w, size, settings: settingsOf(item), mobile: p.mobile, preview: false };
  const liveModel = impl.useModel(ctx);
  const mocked = useMockModel(item.w);
  const model = mocked ?? liveModel;
  const userCollapsed = !!item.collapsed;
  const folded = size === "S" || userCollapsed || p.autoFolded;
  const live = impl.live(model);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const animate = useAnimate();
  const [justOpened, setJustOpened] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  useTip(menuBtn, menu ? "" : "Widget options");

  const toggle = () => {
    if (p.consumeClick?.()) return;
    if (size === "S") {
      setSize(item.w, def.default === "S" ? "M" : def.default);
      setJustOpened(animate);
      return;
    }
    if (p.autoFolded) {
      p.onPin(item.w);
      setJustOpened(animate);
      return;
    }
    setCollapsed(item.w, !userCollapsed);
    if (userCollapsed) setJustOpened(animate);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  const Summary = impl.Summary;
  const Extra = impl.HeaderExtra;
  const Body = impl.Body;
  const maxH = !p.mobile ? def.maxH[size] : undefined;
  return (
    <section
      ref={p.frameRef}
      className={cx(s.frame, p.enter && "tw-enter-up")}
      data-widget={item.w}
      data-size={size}
      data-folded={folded ? "" : undefined}
      data-mobile={p.mobile ? "" : undefined}
      data-dragging={p.dragging ? "" : undefined}
      style={{ transform: p.dragOffset ? `translateY(${p.dragOffset}px)` : undefined, maxHeight: folded ? undefined : maxH }}
      aria-label={def.title}
    >
      <div
        className={s.header}
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        onClick={toggle}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (p.mobile || e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, a, [data-no-drag]")) return;
          p.onDragStart?.(item.w, e);
        }}
      >
        <Icon name={def.icon} size={p.mobile ? 18 : 16} color="var(--th-widget-header-icon)" className={s.icon} staticOnly />
        <span className={s.title}>{def.title}</span>
        {live && <span className={s.live} aria-label="live" />}
        <span className={s.extra}>{folded ? <Summary model={model} ctx={ctx} /> : Extra ? <Extra model={model} ctx={ctx} /> : null}</span>
        <button
          ref={menuBtn}
          type="button"
          className={s.menuBtn}
          aria-label={`${def.title} options`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          data-no-drag=""
          onClick={(e) => {
            e.stopPropagation();
            setMenu(menu ? null : e.currentTarget);
          }}
        >
          <Icon name="overflow-menu-symbolic" size={16} color="var(--th-widget-menu-icon)" staticOnly />
        </button>
      </div>
      {!folded && (
        <div className={s.body} data-opening={justOpened ? "" : undefined} onAnimationEnd={(e) => e.target === e.currentTarget && setJustOpened(false)}>
          <Body model={model} ctx={ctx} />
        </div>
      )}
      {menu && (
        <Menu open onClose={() => setMenu(null)} anchor={menu} placement="below" title={def.title} width={200}>
          {def.sizes.length > 1 && <MenuSectionLabel text="Size" />}
          {def.sizes.length > 1 &&
            SIZES.filter((z) => def.sizes.includes(z)).map((z) => (
              <MenuItem key={z} text={SIZE_LABEL[z]} checkable checked={size === z} onTriggered={() => setSize(item.w, z)} />
            ))}
          {def.sizes.length > 1 && <MenuSeparator />}
          {size !== "S" && <MenuItem text={folded ? "Expand" : "Collapse"} icon={folded ? "view-restore-symbolic" : "window-minimize-symbolic"} onTriggered={toggle} />}
          {def.settings.length > 0 && <MenuItem text="Settings…" icon="configure-symbolic" onTriggered={() => setSettingsOpen(true)} />}
          <MenuItem text="Move up" icon="go-up-symbolic" disabled={p.index === 0} onTriggered={() => moveWidget(item.w, p.index - 1)} />
          <MenuItem text="Move down" icon="go-down-symbolic" disabled={p.index >= p.count - 1} onTriggered={() => moveWidget(item.w, p.index + 1)} />
          <MenuSeparator />
          <MenuItem text="Add widget…" icon="list-add-symbolic" onTriggered={p.onOpenGallery} />
          <MenuItem text="Remove" icon="list-remove-symbolic" danger onTriggered={() => removeWidget(item.w)} />
        </Menu>
      )}
      {settingsOpen && <SettingsDialog item={item} onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}

function SettingsDialog({ item, onClose }: { item: WidgetItem; onClose: () => void }) {
  const def = widgetDef(item.w)!;
  const values = settingsOf(item);
  return (
    <Dialog open onClose={onClose} title={`${def.title} — settings`} standardButtons={["close"]} width={360}>
      <div className={s.settings}>
        {def.settings.map((st) => {
          if (st.type === "bool") return <CheckBox key={st.id} text={st.label} checked={values[st.id] === true} onToggled={(v) => setSetting(item.w, st.id, v)} />;
          const opts: number[] = [];
          for (let v = st.min; v <= st.max; v++) opts.push(v);
          const cur = Number(values[st.id]);
          const unit = (v: number) => (st.unit ? `${v} ${v === 1 && st.unit.endsWith("s") ? st.unit.slice(0, -1) : st.unit}` : String(v));
          return (
            <label key={st.id} className={s.setting}>
              <span>{st.label}</span>
              <ComboBox model={opts} textRole={unit} currentIndex={Math.max(0, opts.indexOf(cur))} onActivated={(_, v) => setSetting(item.w, st.id, v)} aria-label={st.label} />
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}

function UnknownFrame(p: FrameProps) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <section ref={p.frameRef} className={s.frame} data-widget={p.item.w} data-unknown="" data-mobile={p.mobile ? "" : undefined} aria-label="Widget">
      <div className={cx(s.header, s.headerStatic)}>
        <Icon name="help-about-symbolic" size={p.mobile ? 18 : 16} color="var(--th-widget-header-icon)" className={s.icon} staticOnly />
        <span className={s.title}>Widget</span>
        <span className={s.extra} />
        <button type="button" className={s.menuBtn} aria-label="Widget options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
          <Icon name="overflow-menu-symbolic" size={16} color="var(--th-widget-menu-icon)" staticOnly />
        </button>
      </div>
      <div className={cx(s.body, s.unknown)}>Needs a newer Tin Hat</div>
      {menu && (
        <Menu open onClose={() => setMenu(null)} anchor={menu} placement="below" title="Widget" width={200}>
          <MenuItem text="Move up" icon="go-up-symbolic" disabled={p.index === 0} onTriggered={() => moveWidget(p.item.w, p.index - 1)} />
          <MenuItem text="Move down" icon="go-down-symbolic" disabled={p.index >= p.count - 1} onTriggered={() => moveWidget(p.item.w, p.index + 1)} />
          <MenuSeparator />
          <MenuItem text="Remove" icon="list-remove-symbolic" danger onTriggered={() => removeWidget(p.item.w)} />
        </Menu>
      )}
    </section>
  );
}

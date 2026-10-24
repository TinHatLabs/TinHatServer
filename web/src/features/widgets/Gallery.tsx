// Gallery.tsx — "Add a widget" (contract WIDGETS-UI.md §7): one card per registry widget with a live preview (the real
// widget at M with real data, else its sample state and a PREVIEW badge), its description and Add / Added · Remove.
// Phones: the house Dialog is a full-screen sheet.
import { useMemo } from "react";
import { Button, Dialog, Icon, useIsMobile } from "@/ui";
import { gateOfWidget, useOffered } from "@/core/server";
import { REGISTRY, settingsOf, type WidgetDef } from "@/widgets/registry";
import { widgetImpl, type WidgetCtx, type WidgetImpl } from "./impl";
import { useMockModel } from "./mock";
import { addWidget, removeWidget, useWidgetItems } from "./store";
import f from "./Frame.module.css";
import s from "./Gallery.module.css";

export function Gallery({ onClose }: { onClose: () => void }) {
  const items = useWidgetItems();
  const mobile = useIsMobile();
  const offered = useOffered(gateOfWidget);
  return (
    <Dialog open onClose={onClose} title="Add a widget" standardButtons={["close"]} width={mobile ? undefined : 600} bodyClassName={s.body}>
      <div className={s.list} data-mobile={mobile ? "" : undefined} data-widget-gallery="">
        {REGISTRY.widgets.map((def) => {
          const impl = widgetImpl(def.id);
          if (!impl || !offered(def.id)) return null; // selfhost/firstrun item 1: not on a server without the feature
          return <Card key={def.id} def={def} impl={impl} added={items.some((i) => i.w === def.id)} mobile={mobile} />;
        })}
      </div>
    </Dialog>
  );
}

function Card({ def, impl, added, mobile }: { def: WidgetDef; impl: WidgetImpl<unknown>; added: boolean; mobile: boolean }) {
  const ctx: WidgetCtx = useMemo(() => ({ id: def.id, size: "M", settings: settingsOf({ w: def.id }), mobile: false, preview: true }), [def.id]);
  const live = impl.useModel(ctx);
  const mocked = useMockModel(def.id);
  const real = mocked !== undefined || impl.hasData(live);
  const sample = useMemo(() => impl.samples.preview(), [impl]);
  const model = mocked ?? (real ? live : sample);
  const Extra = impl.HeaderExtra;
  const Body = impl.Body;
  return (
    <div className={s.card} data-widget-card={def.id}>
      <div className={s.preview}>
        <section className={f.frame} data-size="M" data-preview="" aria-hidden="true" inert>
          <div className={f.header}>
            <Icon name={def.icon} size={16} color="var(--th-widget-header-icon)" className={f.icon} staticOnly />
            <span className={f.title}>{def.title}</span>
            {impl.live(model) && <span className={f.live} />}
            <span className={f.extra}>{Extra ? <Extra model={model} ctx={ctx} /> : null}</span>
          </div>
          <div className={f.body}>
            <Body model={model} ctx={ctx} />
          </div>
        </section>
      </div>
      <div className={s.text}>
        {/* 11.1.1: the PREVIEW badge (no real data: the preview shows the sample state) sits after the title, not over
            the preview's own header, where it covered the widget's name (both apps) */}
        <div className={s.title}>
          <span className={s.titleText}>{def.title}</span>
          {!real && <span className={s.badge}>Preview</span>}
        </div>
        <div className={s.desc}>{def.description}</div>
        <div className={s.sizes}>{def.sizes.map((z) => ({ S: "Small", M: "Medium", L: "Large" })[z]).join(" · ")}</div>
        <div className={s.actions}>
          {added ? (
            <>
              <span className={s.added}>
                <Icon name="checkmark-symbolic" size={mobile ? 16 : 14} color="currentColor" staticOnly />
                Added
              </span>
              <Button flat text="Remove" onClick={() => removeWidget(def.id)} />
            </>
          ) : (
            <Button highlighted text="Add" icon="list-add-symbolic" onClick={() => addWidget(def.id)} />
          )}
        </div>
      </div>
    </div>
  );
}

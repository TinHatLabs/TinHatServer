// impl.ts — what one widget implementation provides to the frame (Frame.tsx): a data hook and the three parts the
// frame places (the collapsed / S summary, the M/L header extra, the body). The registry data (id, title, icon,
// sizes, settings, max heights) comes from the contract's widgets.json (src/widgets/registry.ts). The parts render
// from the model only (names and avatars excepted), so a sample model shows exactly what live data would.
import type { ComponentType } from "react";
import type { WidgetSize } from "@/widgets/registry";

export interface WidgetCtx {
  id: string;
  size: WidgetSize;
  settings: Record<string, number | boolean>;
  mobile: boolean;
  /** rendered in the gallery: not interactive, sample data allowed */
  preview: boolean;
}

export interface PartProps<M> {
  model: M;
  ctx: WidgetCtx;
}

export interface WidgetImpl<M = unknown> {
  id: string;
  /** called once per render of the frame (a React hook) */
  useModel(ctx: WidgetCtx): M;
  /** the static live dot after the title */
  live(m: M): boolean;
  /** the one-line summary in the header of a collapsed / Small widget */
  Summary: ComponentType<PartProps<M>>;
  /** the header's right-hand extra at M / L (optional) */
  HeaderExtra?: ComponentType<PartProps<M>>;
  Body: ComponentType<PartProps<M>>;
  /** the gallery shows the real widget when this is true, else `samples.preview` with a PREVIEW badge */
  hasData(m: M): boolean;
  /** sample states built with the page's clock (sample people and rooms live on `sample.invalid`, never fetched):
   *  `preview` = the gallery's; the others are the review screenshots' / gates' states (the dev hook's `scenario`) */
  samples: { preview: () => M } & Record<string, () => M>;
}

const impls = new Map<string, WidgetImpl<unknown>>();

export function defineWidget<M>(impl: WidgetImpl<M>): WidgetImpl<M> {
  impls.set(impl.id, impl as WidgetImpl<unknown>);
  return impl;
}

export function widgetImpl(id: string): WidgetImpl<unknown> | undefined {
  return impls.get(id);
}

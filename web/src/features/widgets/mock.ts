// mock.ts — dev / test only (window.__twWidgets with the debug flag): a widget id → a fixed model the frame shows
// instead of its live one. The review screenshots and the GPU gate drive every widget state through it (each
// widget's `samples`, built in the page with the page's clock) without writing anything to the server. Nothing sets
// it in normal use, so the live model is always shown.
import { useSyncExternalStore } from "react";

const models = new Map<string, unknown>();
let rev = 0;
const listeners = new Set<() => void>();

function emit(): void {
  rev++;
  for (const l of [...listeners]) l();
}

/** Show `model` in every frame of widget `id` (null = back to the live model). */
export function setMock(id: string, model: unknown): void {
  if (model === null || model === undefined) models.delete(id);
  else models.set(id, model);
  emit();
}

export function clearMocks(): void {
  if (!models.size) return;
  models.clear();
  emit();
}

export function mockedIds(): string[] {
  return [...models.keys()];
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const getRev = () => rev;

/** React: the mocked model of widget `id`, if any. */
export function useMockModel<M>(id: string): M | undefined {
  useSyncExternalStore(subscribe, getRev, getRev);
  return models.get(id) as M | undefined;
}

// particlesWords.ts — the ☰ Particles rows' visible words (the shared words; effects by their shared names). The
// desktop's ambience_ctl.rs particles_label is the same table (particles.test.ts / particles_labels mirror it).
import { EFFECT_NAMES, type Effect } from "./core";
import { AMBIENCE_WORDS as AW } from "./words";

export function particlesLabel(id: string): string {
  if (id.startsWith("effect:")) return EFFECT_NAMES[id.slice(7) as Effect] ?? "";
  if (id.startsWith("note:")) return (AW as Record<string, string>)[id.slice(5)] ?? "";
  return ({ background: AW.menu, effects: AW.effects, pause: AW.pause, settings: AW.effectsSettings } as Record<string, string>)[id] ?? "";
}

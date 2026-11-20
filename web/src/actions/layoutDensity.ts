// layoutDensity.ts — P22 round 2 (12.1.17): the layout form's own `density` (LAYOUT.md; the Handheld preset sets
// "touch") is drawn while that layout is on, instead of the person's density (src/theme/personal.ts effectiveDensity;
// the desktop: Main.qml binds LayoutStore.form.density into AppCore.layoutDensity). This wires the form this device
// renders (desktop or phone form, by the form factor) into textSize.ts and repaints when either changes.
import { getFormFactor, onFormFactorChange } from "@/core/device";
import { applyPersonal, setLayoutDensitySource } from "@/ui/textSize";
import { getForm, subscribeForm, type FormKind } from "./layoutStore";

const kindNow = (): FormKind => (getFormFactor() === "mobile" ? "phone" : "desktop");

/** The density the rendered layout names ("" / undefined = none). */
export function layoutDensityNow(): unknown {
  return getForm(kindNow()).density;
}

let installed = false;
export function installLayoutDensity(): void {
  if (installed) return;
  installed = true;
  setLayoutDensitySource(layoutDensityNow);
  let last = layoutDensityNow();
  const check = () => {
    const d = layoutDensityNow();
    if (d === last) return;
    last = d;
    applyPersonal();
  };
  subscribeForm("desktop", check);
  subscribeForm("phone", check);
  onFormFactorChange(check);
  applyPersonal();
}

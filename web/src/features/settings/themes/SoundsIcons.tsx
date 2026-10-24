// SoundsIcons.tsx — THEMES-UI.md §11: Settings → Appearance → Sounds and icons, as a card of rows (SETTINGS-WINDOW.md
// §5). The sound pack and the icon style are their own settings since 11.0 (they used to follow the theme's name); they
// sync with the theme (THEMES-SYNC §3.1) or stay on this device with the override on. Two choices each: a combo (no
// radio groups for settings, §3).
import { previewSound } from "@/core/sounds";
import { ToolButton } from "@/ui";
import { applyChoice, useThemeState } from "@/ui/themeStore";
import { ComboRow, Section } from "../rows";

const PACKS = [
  { id: "default", label: "Tin Hat" },
  { id: "goose", label: "Goose" },
];
const ICONS = [
  { id: "duotone", label: "Two-tone" },
  { id: "mono", label: "One colour" },
];

export function SoundsIcons() {
  const st = useThemeState();
  const pick = (patch: { sounds?: string; icons?: string }) => applyChoice(patch, { inSettings: true });
  return (
    <Section title="Sounds and icons">
      <ComboRow
        id="appearance.sound-pack"
        label="Sound pack"
        description="Goose swaps the chimes you hear when someone joins or leaves a call. Every other sound stays the same."
        model={PACKS}
        textRole="label"
        currentIndex={st.sounds === "goose" ? 1 : 0}
        onActivated={(_i, it) => pick({ sounds: it.id })}
        // the pack in use plays its join chime (a second click while it plays stops it — previewSound)
        after={<ToolButton iconName="media-playback-start" tip="Hear the join chime" onClick={() => previewSound("join")} />}
      />
      <ComboRow
        id="appearance.icon-pack"
        label="Icon pack"
        description="Two-tone icons light up in the theme's accent colour when you point at them or turn them on."
        model={ICONS}
        textRole="label"
        currentIndex={st.icons === "mono" ? 1 : 0}
        onActivated={(_i, it) => pick({ icons: it.id })}
      />
    </Section>
  );
}

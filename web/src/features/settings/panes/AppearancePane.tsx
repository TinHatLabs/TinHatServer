// Appearance pane — SETTINGS-WINDOW.md §5 (Main.qml Appearance + the web-only form factor / font set rows; since step 1b
// (THEMES-UI.md) the Theme section — favourites, My themes, the device override — Sounds and icons, and the "Themes"
// gallery page). Theme keeps its gallery full width in its section (no card); every other section is a card of rows.
import { useState } from "react";
import { setPref, usePref } from "@/core/prefs";
import { DENSITIES } from "@/theme/look";
import { PREF_DENSITY, PREF_TEXT_SIZE, TEXT_SIZES, densityLabel, parseDensity, readPersonal } from "@/theme/personal";
import { useForm } from "@/actions/layoutStore";
import { useFormFactor } from "@/core/device";
import { PREF_FOLLOW_OS, followsOs, osFollowEligible, useOsTextPercent } from "@/ui/textSize";
import { useIsMobile } from "@/ui/formFactor";
import { UNFOCUSED_SAVER_PREF, unfocusedSaverOn } from "@/core/lowgpu";
import { PREF_BACKGROUNDS, PREF_EFFECTS, PREF_PAUSE_UNFOCUSED, pauseRow, prefOn } from "@/features/chat/ambience/core";
import { AMBIENCE_WORDS as AW } from "@/features/chat/ambience/words";
import { PromptDialog, TextField, showToast } from "@/ui";
import { chooseTheme, getThemeState, removeMyTheme, saveMyTheme, type MyTheme } from "@/ui/themeStore";
import type { Theme } from "@/theme/engine";
import { closeSettings, useSettingsUi } from "../store";
import { ButtonsSettings } from "@/actions/ui/ButtonsSettings";
import { openEditor } from "../themes/editor/editorStore";
import { openShareRoom } from "../themes/share/shareStore";
import { ImportDialog, type ImportSeed } from "../themes/ImportDialog";
import { SoundsIcons } from "../themes/SoundsIcons";
import { ThemeGallery } from "../themes/ThemeGallery";
import { ThemeSection, type MyThemeActions } from "../themes/ThemeSection";
import { refusalText } from "../themes/text";
import { ComboRow, Row, Section, SwitchRow } from "../rows";
import { GAMEBG_WORDS as GW, PREF_GAME_ART } from "@/features/chat/gamebg";
// ADDITIVE (editmode, 11.0): Settings → Appearance → Layout
import { LayoutSection } from "@/features/editmode/LayoutSection";

/** THEMES-UI.md §13.1: Edit… (one of My themes: Save replaces it) / New theme from this… (any other: a copy) — the editor
 *  works on the live app, so the settings sheet makes room for it. */
function editTheme(doc: Theme, mine: boolean): void {
  if (openEditor(doc, mine ? { kind: "mine", id: doc.id } : { kind: "new" })) closeSettings();
}

/** Customize… (§3.2 by §13.1) — the theme on screen: one of My themes → Edit…, any other → New theme from this. Also the
 *  ☰ Theme menu's "Edit current theme…" (§12 amendment 2026-09-28, bus `editCurrentTheme`, SettingsSheet hosts it).
 *  The desktop's AppearancePane.customize(). */
export function editCurrentTheme(): void {
  const st = getThemeState();
  editTheme(st.colours.doc, st.myThemes.some((m) => m.id === st.colours.theme));
}

export function AppearancePane() {
  const sub = useSettingsUi((s) => s.subPage);
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<ImportSeed | null>(null);
  const [renaming, setRenaming] = useState<MyTheme | null>(null);
  const [newName, setNewName] = useState("");

  const openImport = (seed?: ImportSeed) => {
    setImportSeed(seed ?? null);
    setImportOpen(true);
  };
  const actions: MyThemeActions = {
    rename: (m) => {
      setNewName(m.doc.name);
      setRenaming(m);
    },
    edit: editTheme,
    customize: editCurrentTheme,
    share: (doc) => openShareRoom(doc),
    remove: (m) => {
      const r = removeMyTheme(m.id);
      if (r === "saved")
        showToast(`${m.doc.name} removed`, 8000, {
          label: "Undo",
          run: () => void saveMyTheme(m.doc),
        });
      else if (r !== "noop") showToast(refusalText(r), "long");
    },
  };
  const doRename = () => {
    const m = renaming;
    const name = newName.trim();
    if (!m) return;
    // A25.6: an empty name used to close the dialog silently (the desktop's AppearancePane.qml: the same words)
    if (!name) return void showToast(`A theme needs a name — it keeps “${m.doc.name}”.`, "long");
    if ([...name].length > 80 || name === m.doc.name) return;
    const doc = { ...m.doc, name };
    const r = saveMyTheme(doc);
    if (r !== "saved") {
      showToast(refusalText(r), "long");
      return;
    }
    // the shown theme is this one: show (and sync) the new name too
    if (getThemeState().colours.theme === m.id) chooseTheme(doc, { inSettings: true });
  };

  const dialogs = (
    <>
      <ImportDialog open={importOpen} seed={importSeed} onClose={() => setImportOpen(false)} />
      <PromptDialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename theme"
        standardButtons={["save", "cancel"]}
        onAccepted={doRename}
        preferredWidth={360}
      >
        <TextField
          value={newName}
          maxLength={80}
          aria-label="Theme name"
          onChange={(e) => setNewName(e.target.value)}
          onAccepted={() => {
            doRename();
            setRenaming(null);
          }}
        />
      </PromptDialog>
    </>
  );

  if (sub === "themes") {
    return (
      <>
        <ThemeGallery onBack={() => useSettingsUi.setState({ subPage: null })} onImport={openImport} actions={actions} />
        {dialogs}
      </>
    );
  }
  return (
    <>
      <Section title="Theme" bare id="theme">
        <ThemeSection onBrowse={() => useSettingsUi.setState({ subPage: "themes" })} onImport={() => openImport()} actions={actions} />
      </Section>
      <AppSizeSection />
      <SoundsIcons />
      <OtherSections />
      {dialogs}
    </>
  );
}

const LOOKS = [
  { id: "islands", label: "Islands" },
  { id: "flat", label: "Flat" },
];
const NAV = [
  { id: "persistent", label: "Sidebar (always visible)" },
  { id: "corner", label: "Corner dock (OLED-friendly)" },
];
const CLOCK = [
  { id: "system", label: "System" },
  { id: "12", label: "12-hour" },
  { id: "24", label: "24-hour" },
];
const FORM = [
  { id: "auto", label: "Automatic" },
  { id: "desktop", label: "Desktop" },
  { id: "mobile", label: "Mobile" },
];
const FONTSET = [
  { id: "auto", label: "Automatic" },
  { id: "plasma", label: "Plasma" },
  { id: "rig", label: "Rig" },
];
const at = (list: ReadonlyArray<{ id: string }>, v: string) => Math.max(0, list.findIndex((x) => x.id === v));

/** Size (2026-10-31, SETTINGS-WINDOW.md §5 card Size): the desktop app's App size slider (Ctrl+= / Ctrl+- / Ctrl+0) is
 *  the browser's own zoom here — the page never takes those keys (docs/WEB-EXCEPTIONS.md "App size"). */
export function AppSizeSection() {
  return (
    <Section title="Size">
      <Row
        id="appearance.app-size"
        label="App size"
        description="Use your browser's zoom: Ctrl and + or − make Tin Hat bigger or smaller, Ctrl and 0 sets it back (⌘ on a Mac). On a phone, pinch or use the browser's text size."
      />
      <PersonalLookRows />
    </Section>
  );
}

/** P22 (12.1.17): the text size and the density are the PERSON's, the same on every theme (they used to live in the
 *  theme: switching theme changed your size). Steps, words and keys: src/theme/personal.ts + the shared vectors
 *  testvectors/personal/ (the desktop's AppearancePane.qml shows the same two rows). Phones whose browser tells us the
 *  phone's text size (iPhone / iPad) also offer "Match my phone" (textSize.ts; docs/WEB-EXCEPTIONS.md). */
function PersonalLookRows() {
  const sizePref = usePref(PREF_TEXT_SIZE, "");
  const densityPref = usePref(PREF_DENSITY, "");
  const followPref = usePref(PREF_FOLLOW_OS, "");
  useIsMobile(); // re-render when the layout switches (osFollowEligible reads it)
  const os = useOsTextPercent();
  const eligible = osFollowEligible(os);
  const follow = followsOs(followPref || null, sizePref || null, os);
  const p = readPersonal(sizePref, densityPref);
  const sizes = [
    ...(eligible ? [{ id: "os", label: "Match my phone" }] : []),
    ...TEXT_SIZES.map((n) => ({ id: String(n), label: `${n}%` })),
  ];
  const dens = DENSITIES.map((d) => ({ id: d, label: densityLabel(d) }));
  // round 2: a layout that names its own density (the Handheld preset) is drawn with it; say so (AppearancePane.qml)
  const form = useForm(useFormFactor() === "mobile" ? "phone" : "desktop");
  const layoutDensity = parseDensity(typeof form.density === "string" ? form.density : null);
  return (
    <>
      <ComboRow
        id="appearance.text-size"
        label="Text size"
        description="Makes the words bigger or smaller, the same on every theme. App size makes everything bigger."
        model={sizes}
        textRole="label"
        currentIndex={follow ? 0 : at(sizes, String(p.size))}
        onActivated={(_i, it) => {
          if (it.id === "os") {
            setPref(PREF_FOLLOW_OS, "1");
            return;
          }
          setPref(PREF_FOLLOW_OS, "0"); // a size the person picks always wins over the phone's
          setPref(PREF_TEXT_SIZE, it.id);
        }}
      />
      <ComboRow
        id="appearance.density"
        label="Density"
        description={
          "How much room the room list and the chat leave between lines. Compact fits more; Comfortable is easier to tap." +
          (layoutDensity ? ` Your current layout uses ${densityLabel(layoutDensity)}; your choice here applies on your other layouts.` : "")
        }
        model={dens}
        textRole="label"
        currentIndex={at(dens, p.density)}
        onActivated={(_i, it) => setPref(PREF_DENSITY, it.id)}
      />
    </>
  );
}

/** Layout (10.8) + Buttons (11.0) · Navigation · Motion · Performance (10.8.1) · Clock · This browser (web only). Every
 *  choice of two or three is a combo (SETTINGS-WINDOW.md §3: no radio groups). */
function OtherSections() {
  const style = usePref("layout-style", "islands");
  const nav = usePref("nav_mode", "persistent");
  const reduce = usePref("reduce-motion", "0");
  const gifs = usePref("gif-autoplay", "1");
  const saver = usePref(UNFOCUSED_SAVER_PREF, "0");
  // chat backgrounds + particle effects (docs/AMBIENCE.md; the desktop's AppearancePane.qml has the same rows)
  const bgs = prefOn(usePref(PREF_BACKGROUNDS, ""), true);
  const gameArt = prefOn(usePref(PREF_GAME_ART, ""), true); // sun-gamebg: "Game art backgrounds", default ON
  const fx = prefOn(usePref(PREF_EFFECTS, ""), true);
  const pause = pauseRow(prefOn(usePref(PREF_PAUSE_UNFOCUSED, ""), true), unfocusedSaverOn(saver));
  const clock = usePref("clock", "system");
  const ff = usePref("formFactor", "auto");
  const fontset = usePref("fontset", "auto");
  return (
    <>
      {/* 10.8: islands or the flat look (per device) — "people can swap back"; 11.0 (EDITMODE-UI §13): edit,
          reset, named layouts, previous version */}
      <Section title="Layout">
        <ComboRow
          id="appearance.style"
          label="Style"
          description="Islands gives every part of the window its own rounded card. Flat puts them edge to edge, the way Tin Hat looked before."
          model={LOOKS}
          textRole="label"
          currentIndex={style === "flat" ? 1 : 0}
          onActivated={(_i, it) => setPref("layout-style", it.id)}
        />
        <LayoutSection />
      </Section>

      {/* 11.0: the button rows and your own button islands (src/actions/ui/ButtonsSettings.tsx) */}
      <ButtonsSettings />

      <Section id="navigation">
        <ComboRow
          id="appearance.navigation"
          label="Navigation"
          description="Corner dock hides the room list until you hover the corner — nice for dark themes and small screens."
          model={NAV}
          textRole="label"
          currentIndex={nav === "corner" ? 1 : 0}
          onActivated={(_i, it) => setPref("nav_mode", it.id)}
        />
      </Section>

      <Section title="Motion">
        <SwitchRow
          id="appearance.reduce-motion"
          label="Reduce motion"
          description="Slides and fades become instant, and the game reel jumps straight to its result."
          checked={reduce === "1" || reduce === "true"}
          onToggled={(on) => setPref("reduce-motion", on ? "1" : "0")}
        />
        {/* GPU.md §2.6 (both apps): the pref `gif-autoplay`, default on */}
        <SwitchRow
          id="appearance.gif-autoplay"
          label="Play GIFs automatically"
          description="GIFs play up to three times, then rest on their first frame. Hover one to play it again."
          checked={gifs !== "0"}
          onToggled={(on) => setPref("gif-autoplay", on ? "1" : "0")}
        />
      </Section>

      {/* 10.8.1 (GPU.md §1 amendment, both apps): the unfocused rules' master switch — the pref `call-unfocused-saver`, default OFF */}
      <Section title="Performance">
        <SwitchRow
          id="appearance.gpu-saver"
          label="Save GPU while Tin Hat isn't focused"
          description="For lower-end PCs: while Tin Hat isn't the active window it pauses animations, previews and GIFs and shows cameras small."
          checked={unfocusedSaverOn(saver)}
          onToggled={(on) => setPref(UNFOCUSED_SAVER_PREF, on ? "1" : "0")}
        />
        <SwitchRow id="appearance.chat-backgrounds" label={AW.backgrounds} description={AW.backgroundsHelp} checked={bgs} onToggled={(on) => setPref(PREF_BACKGROUNDS, on ? "1" : "0")} />
        <SwitchRow id="appearance.chat-game-art" label={GW.gameArt} description={GW.gameArtHelp} checked={bgs && gameArt} disabled={!bgs} onToggled={(on) => setPref(PREF_GAME_ART, on ? "1" : "0")} />
        <SwitchRow id="appearance.chat-effects" label={AW.effects} description={AW.effectsHelp} checked={bgs && fx} disabled={!bgs} onToggled={(on) => setPref(PREF_EFFECTS, on ? "1" : "0")} />
        <SwitchRow
          id="appearance.chat-effects-pause"
          label={AW.pause}
          description={pause.enabled ? AW.pauseHelp : AW.pauseSaver}
          checked={pause.checked}
          disabled={!pause.enabled || !bgs || !fx}
          onToggled={(on) => setPref(PREF_PAUSE_UNFOCUSED, on ? "1" : "0")}
        />
      </Section>

      <Section id="clock">
        <ComboRow
          id="appearance.clock"
          label="Clock"
          description={`Message times in chat. "System" follows your device's setting.`}
          model={CLOCK}
          textRole="label"
          currentIndex={at(CLOCK, clock === "12" || clock === "24" ? clock : "system")}
          onActivated={(_i, it) => setPref("clock", it.id)}
        />
      </Section>

      {/* web only (docs/WEB-EXCEPTIONS.md): the form factor and the font set */}
      <Section title="This browser">
        <ComboRow
          label="Desktop or phone"
          description="Automatic picks the phone layout on phones and the desktop layout everywhere else."
          model={FORM}
          textRole="label"
          currentIndex={at(FORM, ff === "desktop" || ff === "mobile" ? ff : "auto")}
          onActivated={(_i, it) => setPref("formFactor", it.id)}
        />
        <ComboRow
          label="Font sizes"
          description="Plasma matches Tin Hat on a KDE desktop; Rig matches the Windows app. Automatic picks Rig on Windows, Plasma elsewhere."
          model={FONTSET}
          textRole="label"
          currentIndex={at(FONTSET, fontset === "plasma" || fontset === "rig" ? fontset : "auto")}
          onActivated={(_i, it) => setPref("fontset", it.id)}
        />
      </Section>
    </>
  );
}

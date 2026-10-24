// ThemeSection.tsx — THEMES-UI.md §3: Settings → Appearance → Theme. Notices, the summary (name · meta · Undo, the
// adjusted note, the pending line), Favourites + the All themes tile, My themes + the Import tile, the device override.
import { useEffect, useState, type ReactNode } from "react";
import { BUILTINS, type Theme } from "@/theme/engine";
import { Button, HintLabel, Icon, InlineMessage, MenuItem, MenuSeparator, useIsMobile } from "@/ui";
import { Card, SwitchRow } from "../rows";
import { useLibrary } from "@/ui/themeLibrary";
import { acceptOffer, chooseTheme, dismissOffer, setDeviceOverride, undoLast, useThemeState, type MyTheme, type ThemeState } from "@/ui/themeStore";
import { ThemeCard, ThemeTile } from "./ThemeCard";
import { ThemeGrid, type CellRender } from "./ThemeGrid";
import { adjustedText, packName } from "./text";
import t from "./themes.module.css";

/** The notices of §3.1 (also shown at the top of the gallery page). */
export function ThemeNotices({ st }: { st: ThemeState }) {
  const out: ReactNode[] = [];
  if (st.offer?.inSettings) {
    const o = st.offer;
    out.push(
      <InlineMessage
        key="offer"
        type="information"
        text={`${o.themeName} comes with its own sounds. Use ${packName(o.pack)} sounds too?`}
        actions={[
          { text: `Use ${packName(o.pack)} sounds`, onTriggered: () => acceptOffer() },
          { text: "No thanks", onTriggered: () => dismissOffer() },
        ]}
      />,
    );
  }
  if (st.readOnly)
    out.push(
      <InlineMessage
        key="ro"
        type="warning"
        text="A newer version of Tin Hat saved your theme settings. What you change here stays on this device until you update."
      />,
    );
  if (st.unknownTheme)
    out.push(
      <InlineMessage
        key="unknown"
        type="warning"
        text={`Your account uses a theme this version of Tin Hat doesn't have (“${st.unknownTheme}”). This device keeps ${st.colours.name} until you update.`}
      />,
    );
  if (st.overridesRefused)
    out.push(<InlineMessage key="ov" type="information" text="Some of your colour changes need a newer Tin Hat and are left out here." />);
  return <>{out}</>;
}

/** §3.2 the summary line, its adjusted note and the pending line. */
export function ThemeSummary({ st, compact, onCustomize }: { st: ThemeState; compact?: boolean; onCustomize?: () => void }) {
  const c = st.colours;
  const [now, setNow] = useState(() => Date.now());
  // the "saved on this device" line appears 10 s after a save that is still waiting (one timer, no polling)
  useEffect(() => {
    if (st.pendingSince === null) return;
    const due = st.pendingSince + 10_000 - Date.now();
    if (due <= 0) return;
    const h = window.setTimeout(() => setNow(Date.now()), due + 50);
    return () => window.clearTimeout(h);
  }, [st.pendingSince]);
  const pendingLong = st.pendingSince !== null && now - st.pendingSince >= 10_000;
  const meta = `${c.variant === "light" ? "Light" : "Dark"} theme${c.author ? ` · by ${c.author}` : ""}${st.override ? " · on this device" : ""}`;
  return (
    <>
      <div className={t.summary} data-setting={compact ? undefined : "appearance.theme"}>
        <span className={t.themeName}>{c.name}</span>
        <span className={t.meta}>{meta}</span>
        <span className={t.spacer} />
        {onCustomize && (
          <span data-setting="appearance.customize-theme" className={t.flashWrap}>
            <Button flat icon="document-edit-symbolic" text="Customize…" tip="Change this theme's colours, fonts and look" onClick={onCustomize} />
          </span>
        )}
        {st.undo && <Button flat icon="edit-undo-symbolic" text="Undo" tip="Go back to the theme you had before" onClick={() => undoLast()} />}
      </div>
      {!compact && c.adjusted.length > 0 && (
        <div className={t.note}>
          <Icon name="help-about-symbolic" size={16} color="var(--th-settings-theme-note-icon)" />
          <span>{adjustedText(c.adjusted.length)}</span>
        </div>
      )}
      {pendingLong && <div className={t.pending}>Saved on this device — it syncs when you're back online.</div>}
    </>
  );
}

export interface MyThemeActions {
  rename: (m: MyTheme) => void;
  remove: (m: MyTheme) => void;
  /** THEMES-UI.md §13.1: Edit… (one of My themes) / New theme from this… (any other) */
  edit: (doc: Theme, mine: boolean) => void;
  /** Customize… (§3.2 by §13.1): the theme on screen — the ☰ Theme menu's "Edit current theme…" runs the same (§12) */
  customize: () => void;
  /** §14.5: Share to a room… */
  share: (doc: Theme) => void;
}

/** The ⋯ menu of a My-theme card (§5.2). */
export function myThemeMenu(m: MyTheme, active: boolean, actions: MyThemeActions) {
  return (close: () => void) => (
    <>
      <MenuItem
        text="Use"
        icon="dialog-ok-apply-symbolic"
        disabled={active || !m.usable}
        onTriggered={() => {
          close();
          chooseTheme(m.doc, { inSettings: true });
        }}
      />
      <MenuItem
        text="Edit…"
        icon="document-edit-symbolic"
        disabled={!m.usable}
        onTriggered={() => {
          close();
          actions.edit(m.doc, true);
        }}
      />
      <MenuItem
        text="Rename…"
        icon="document-edit-symbolic"
        onTriggered={() => {
          close();
          actions.rename(m);
        }}
      />
      <MenuItem
        text="Share to a room…"
        icon="document-send-symbolic"
        disabled={!m.usable}
        onTriggered={() => {
          close();
          actions.share(m.doc);
        }}
      />
      <MenuSeparator />
      <MenuItem
        text="Remove"
        icon="edit-delete-symbolic"
        danger
        onTriggered={() => {
          close();
          actions.remove(m);
        }}
      />
    </>
  );
}

/** The ⋯ menu of any other card (§13.1): Use · New theme from this… */
export function libraryThemeMenu(doc: Theme, active: boolean, usable: boolean, actions: MyThemeActions) {
  return (close: () => void) => (
    <>
      <MenuItem
        text="Use"
        icon="dialog-ok-apply-symbolic"
        disabled={active || !usable}
        onTriggered={() => {
          close();
          chooseTheme(doc, { inSettings: true });
        }}
      />
      <MenuItem
        text="New theme from this…"
        icon="list-add-symbolic"
        disabled={!usable}
        onTriggered={() => {
          close();
          actions.edit(doc, false);
        }}
      />
    </>
  );
}

export function ThemeSection({ onBrowse, onImport, actions }: { onBrowse: () => void; onImport: () => void; actions: MyThemeActions }) {
  const st = useThemeState();
  const lib = useLibrary();
  const mobile = useIsMobile();
  const activeId = st.colours.theme;
  const favs: Theme[] = lib ? lib.favourites.map((e) => e.doc) : [BUILTINS.oled, BUILTINS.goose];
  const count = lib ? lib.all.length : 1190;

  const favCells: CellRender[] = [
    ...favs.map<CellRender>((doc) => (p) => (
      <ThemeCard
        key={doc.id}
        doc={doc}
        library
        active={doc.id === activeId}
        onPick={() => chooseTheme(doc, { inSettings: true })}
        menu={libraryThemeMenu(doc, doc.id === activeId, true, actions)}
        {...p}
      />
    )),
    (p) => <ThemeTile key="all" icon="view-grid-symbolic" label={`All ${count.toLocaleString("en-US")} themes`} onClick={onBrowse} {...p} />,
  ];
  const mineCells: CellRender[] = [
    ...st.myThemes.map<CellRender>((m) => (p) => (
      <ThemeCard
        key={m.id}
        doc={m.doc}
        active={m.id === activeId}
        onPick={() => chooseTheme(m.doc, { inSettings: true })}
        menu={myThemeMenu(m, m.id === activeId, actions)}
        {...p}
      />
    )),
    ...(st.myThemesReadOnly ? [] : [(p: Parameters<CellRender>[0]) => <ThemeTile key="import" icon="document-open-symbolic" label="Import a theme" onClick={onImport} {...p} />]),
  ];
  const accountName = st.account ? (lib?.byId.get(st.account.theme as string)?.name ?? (st.account.doc as { name?: string } | undefined)?.name ?? String(st.account.theme)) : null;
  // the Settings window's Section "Theme" is the heading (SETTINGS-WINDOW.md §5: the gallery full width, not in a card)
  return (
    <>
      <ThemeNotices st={st} />
      <ThemeSummary st={st} onCustomize={actions.customize} />
      <div className={t.subLabel}>Favourites</div>
      <ThemeGrid cells={favCells} label="Favourite themes" strip={mobile} />
      <div className={t.subLabel}>
        My themes{st.myThemes.length ? <span> · {st.myThemes.length}</span> : null}
      </div>
      <ThemeGrid cells={mineCells} label="My themes" strip={mobile} />
      {st.myThemesReadOnly && <HintLabel>A newer Tin Hat manages My themes — update to add or remove themes.</HintLabel>}
      {!st.myThemesReadOnly && st.myThemes.length === 0 && <HintLabel>Themes you import are saved here and follow you to every device.</HintLabel>}
      {!st.local && (
        <Card className={t.overrideCard}>
          <SwitchRow
            label="Use a different theme on this device"
            description={
              st.override
                ? `This device: ${st.colours.name}. Everywhere else: ${accountName ?? "each device's own theme"}.`
                : "Your theme, sounds and icon style follow your account to every device. Turn this on to choose them separately here."
            }
            checked={st.override}
            onToggled={(on) => setDeviceOverride(on)}
          />
        </Card>
      )}
    </>
  );
}

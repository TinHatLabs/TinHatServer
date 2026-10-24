// Gallery.tsx — #/__gallery: every @/ui primitive in every state (normal / hover / pressed / focus /
// disabled / checked …, pinned with the `force` prop) on BOTH themes side by side, plus live
// popups, and "replica" sections that rebuild a native screen region 1:1 so a web capture can be
// diffed against the native reference (tools/ui-compare.sh):
//   #/__gallery                 all primitives, oled | goose
//   #/__gallery/icons           the whole icon pack (static + motion, hover to play)
//   #/__gallery/mobile          the phone presentations (open with ?ff=mobile)
//   #/__gallery/replica-menu    the app menu exactly where the native opened it (ui-appmenu)
//   #/__gallery/replica-confirm the sign-out ConfirmDialog (ui-confirm-signout)
//   #/__gallery/replica-banner  the verify banner strip (ui-shell-noverify top 58 px)
//   #/__gallery/replica-about   the About OverlaySheet (ui-sheet-about)
//   #/__gallery/replica-prompt  the "Join a space" PromptDialog (ui-prompt-joinspace)
//   #/__gallery/replica-tooltip the bug-button tooltip (ui-tooltip-bug)
//   #/__gallery/startup         the Startup card (stage cycling; ?stage=N pins one)
//   #/__gallery/actions         11.0 buttons: rows, button islands, the Ctrl+K palette (?q= / ?stage=)
//   #/__gallery/theme-editor    the theme editor panel (THEMES-UI.md §13; ?theme=&mode=&query=&ops=)
//   #/__gallery/theme-share     theme share cards + the Try bar (THEMES-UI.md §14; ?theme=&try=1)
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Avatar,
  BasicButton,
  BasicCheckBox,
  BasicRadioButton,
  BasicTextField,
  BasicToolButton,
  BusyIndicator,
  Button,
  CheckBox,
  CheckMenuItem,
  ComboBox,
  ConfirmDialog,
  ContextMenu,
  Dialog,
  EmptyState,
  GlowButton,
  HeaderIconButton,
  HintLabel,
  Heading,
  Icon,
  InlineMessage,
  Label,
  Menu,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
  OverlaySheet,
  Popover,
  PromptDialog,
  RadioButton,
  ScrollArea,
  SearchField,
  SectionLabel,
  Separator,
  Slider,
  SubMenu,
  Switch,
  TextArea,
  TextField,
  TinHatLoader,
  ToolButton,
  Tooltip,
  UnreadBadge,
  AppWindow,
  showToast,
  themeVars,
  useIconIndex,
  useMenu,
  useIsMobile,
  type ThemeName,
} from "@/ui";
import { Startup } from "./Startup";
import { ActionsGallery } from "@/actions/ui/ActionsGallery";
import { ThemeEditorPage, ThemeSharePage } from "./GalleryThemeEditor";
import { BannerStripView } from "./Banners";
import { GuestsGallery } from "@/features/guests/gallery";
import s from "./Gallery.module.css";

export function Gallery({ section }: { section?: string }) {
  switch (section) {
    case "icons":
      return <IconsPage />;
    case "replica-menu":
      return <ReplicaMenu />;
    case "replica-confirm":
      return <ReplicaConfirm />;
    case "replica-banner":
      return <ReplicaBanner />;
    case "replica-about":
      return <ReplicaAbout />;
    case "replica-prompt":
      return <ReplicaPrompt />;
    case "replica-tooltip":
      return <ReplicaTooltip />;
    case "startup":
      return <StartupDemo />;
    case "mobile":
      return <MobilePage />;
    case "actions":
      return <ActionsGallery />;
    case "theme-editor":
      return <ThemeEditorPage />;
    case "theme-share":
      return <ThemeSharePage />;
    case "guests":
      return <GuestsGallery />;
    default:
      return <AllPage />;
  }
}

// ---- the overview ----------------------------------------------------------------------------

function Themed({ theme, children }: { theme: ThemeName; children: ReactNode }) {
  const vars = themeVars(theme) as CSSProperties;
  return (
    <div className={s.themed} data-theme={theme} style={vars}>
      <div className={s.themeName}>{theme}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowLabel}>{label}</div>
      <div className={s.rowItems}>{children}</div>
    </div>
  );
}

function AllPage() {
  return (
    <div className={s.page}>
      <div className={s.top}>
        <Heading level={1}>Tin Hat Web — UI gallery</Heading>
        <span className={s.links}>
          {["", "icons", "mobile", "startup", "actions", "replica-menu", "replica-confirm", "replica-banner", "replica-about", "replica-prompt", "replica-tooltip"].map((k) => (
            <a key={k} href={`#/__gallery${k ? "/" + k : ""}`}>
              {k || "all"}
            </a>
          ))}
        </span>
      </div>
      <div className={s.columns}>
        <Themed theme="oled">
          <Primitives />
        </Themed>
        <Themed theme="goose">
          <Primitives />
        </Themed>
      </div>
      <LivePopups />
    </div>
  );
}

function Primitives() {
  const [txt, setTxt] = useState("jamie");
  const [search, setSearch] = useState("gen");
  const [combo, setCombo] = useState(1);
  const [edit, setEdit] = useState("Valheim");
  const [cb, setCb] = useState(true);
  const [rb, setRb] = useState(0);
  const [sw, setSw] = useState(false);
  const [sl, setSl] = useState(0.35);
  const games = ["Valheim", "Project Zomboid", "Satisfactory", "Palworld", "Abiotic Factor"];
  return (
    <div className={s.stack}>
      <SectionLabel>Buttons — ThButton</SectionLabel>
      <Row label="plain">
        <Button text="Save" />
        <Button text="Hover" force="hover" />
        <Button text="Pressed" force="pressed" />
        <Button text="Focus" force="focus" />
        <Button text="Disabled" disabled />
        <Button text="Icon" icon="document-save-symbolic" />
      </Row>
      <Row label="highlighted">
        <Button text="Save" highlighted />
        <Button text="Hover" highlighted force="hover" />
        <Button text="Pressed" highlighted force="pressed" />
        <Button text="Disabled" highlighted disabled />
      </Row>
      <Row label="flat / danger">
        <Button text="Flat" flat />
        <Button text="Flat hover" flat force="hover" />
        <Button text="Flat focus" flat force="focus" />
        <Button text="Remove" danger />
        <Button text="Hover" danger force="hover" />
        <Button text="Delete" danger icon="edit-delete-symbolic" />
      </Row>
      <SectionLabel>Controls.Button (Basic)</SectionLabel>
      <Row label="basic">
        <BasicButton text="Change avatar…" icon="insert-image-symbolic" />
        <BasicButton text="Pressed" force="pressed" />
        <BasicButton text="Focus" force="focus" />
        <BasicButton text="Checked" checked />
        <BasicButton text="Flat" flat />
      </Row>
      <SectionLabel>Tool buttons</SectionLabel>
      <Row label="ThToolButton">
        <ToolButton iconName="tools-report-bug-symbolic" tip="Report a problem" />
        <ToolButton iconName="sidebar-collapse-left-symbolic" force="hover" tip="hover (story plays)" />
        <ToolButton iconName="settings-configure-symbolic" force="pressed" />
        <ToolButton iconName="audio-input-microphone-symbolic" active tip="active (end pose)" />
        <ToolButton iconName="emblem-music-symbolic" label="Music" />
        <ToolButton iconName="list-add-symbolic" force="focus" />
        <ToolButton iconName="list-add-symbolic" disabled />
      </Row>
      <Row label="Basic ToolButton">
        <BasicToolButton iconName="view-refresh-symbolic" display="iconOnly" tip="Refresh" />
        <BasicToolButton text="Verify…" />
        <BasicToolButton iconName="edit-copy-symbolic" text="Copy" checked />
      </Row>
      <Row label="HeaderIconButton">
        <HeaderIconButton iconName="applications-games-symbolic" tip="What do we play tonight?" />
        <HeaderIconButton iconName="view-calendar-symbolic" force="hover" />
        <HeaderIconButton iconName="camera-video-symbolic" force="pressed" />
        <HeaderIconButton iconName="call-start-symbolic" accent tip="In the call" />
        <HeaderIconButton iconName="configure-symbolic" force="focus" />
        <HeaderIconButton iconName="documentinfo-symbolic" disabled />
      </Row>
      <Row label="GlowButton">
        <GlowButton text="Sign in" />
        <GlowButton text="Hover" force="hover" />
        <GlowButton text="Pressed" force="pressed" />
        <GlowButton text="Focus" force="focus" />
        <GlowButton text="Disabled" disabled />
        <GlowButton text="Busy" busy />
        <GlowButton text="Send" icon="document-send-symbolic" />
      </Row>
      <SectionLabel>Text fields</SectionLabel>
      <Row label="ThTextField">
        <TextField style={{ width: 160 }} value={txt} onChange={(e) => setTxt(e.target.value)} />
        <TextField style={{ width: 160 }} placeholder="Placeholder" />
        <TextField style={{ width: 160 }} placeholder="Hover" force="hover" />
        <TextField style={{ width: 160 }} placeholder="Focus" force="focus" />
        <TextField style={{ width: 160 }} placeholder="Disabled" disabled />
      </Row>
      <Row label="ThTextArea">
        <TextArea style={{ width: 330 }} placeholder="Notes (optional)" defaultValue={"Bring snacks.\nVoice in #general."} />
      </Row>
      <Row label="Basic / Search">
        <BasicTextField style={{ width: 170 }} placeholder="Say something about yourself" />
        <BasicTextField style={{ width: 170 }} placeholder="Focus" force="focus" />
        <SearchField style={{ width: 200 }} placeholder="Filter rooms…" value="" onValueChange={() => {}} />
        <SearchField style={{ width: 200 }} value={search} onValueChange={setSearch} />
      </Row>
      <SectionLabel>Combo boxes</SectionLabel>
      <Row label="ThComboBox">
        <ComboBox style={{ width: 170 }} model={games} currentIndex={combo} onActivated={(i) => setCombo(i)} />
        <ComboBox style={{ width: 170 }} model={games} currentIndex={0} force="hover" />
        <ComboBox style={{ width: 170 }} model={games} currentIndex={0} force="focus" />
        <ComboBox style={{ width: 170 }} model={games} currentIndex={0} disabled />
        <ComboBox style={{ width: 170 }} model={games} currentIndex={-1} editable editText={edit} onEditTextChanged={setEdit} onActivated={() => {}} />
      </Row>
      <Row label="Basic ComboBox">
        <ComboBox variant="basic" style={{ width: 200 }} model={["No join sound", "Airhorn", "Bonk"]} currentIndex={0} onActivated={() => {}} />
      </Row>
      <SectionLabel>Checks, radios, switches, sliders</SectionLabel>
      <Row label="ThCheckBox">
        <CheckBox text="Checked" checked={cb} onToggled={setCb} />
        <CheckBox text="Unchecked" checked={false} />
        <CheckBox text="Hover" checked={false} force="hover" />
        <CheckBox text="Focus" checked={false} force="focus" />
        <CheckBox text="Disabled" checked disabled />
      </Row>
      <Row label="ThRadioButton">
        {["Everyone", "Mentions", "Off"].map((t, i) => (
          <RadioButton key={t} name="gallery-rb" text={t} checked={rb === i} onToggled={() => setRb(i)} />
        ))}
        <RadioButton text="Hover" checked={false} force="hover" />
      </Row>
      <Row label="Basic check / radio">
        <BasicCheckBox text="Checked" checked />
        <BasicCheckBox text="Partial" checked partial />
        <BasicCheckBox text="Off" checked={false} />
        <BasicRadioButton text="System" checked />
        <BasicRadioButton text="12-hour" checked={false} />
      </Row>
      <Row label="Switch / Slider">
        <Switch text="Reduce motion" checked={sw} onToggled={setSw} />
        <Switch text="On" checked />
        <Slider value={sl} onMoved={setSl} aria-label="Volume" />
        <Slider value={0.7} force="focus" />
        <Slider value={0.4} disabled />
      </Row>
      <SectionLabel>Text</SectionLabel>
      <Row label="type">
        <Heading level={1}>Heading 1</Heading>
        <Heading level={2}>Heading 2</Heading>
        <Heading level={3}>Heading 3</Heading>
        <Heading level={4}>Heading 4</Heading>
        <Label>Label 12 px</Label>
        <Label dim>dim</Label>
        <SectionLabel>SECTION LABEL</SectionLabel>
      </Row>
      <HintLabel>HintLabel — a dim wrapped caption under a control, in the small font.</HintLabel>
      <Separator />
      <SectionLabel>Badges, avatars, icons</SectionLabel>
      <Row label="UnreadBadge">
        <UnreadBadge count={1} />
        <UnreadBadge count={12} />
        <UnreadBadge count={120} />
        <UnreadBadge count={3} highlight />
      </Row>
      <Row label="Avatar">
        <Avatar name="jamie" seed="@jamie:example.com" size={40} />
        <Avatar name="Alex" seed="@alex:example.com" size={40} showDot />
        <Avatar name="#general" seed="!abc:example.com" size={32} />
        <Avatar name="Jordan" seed="@jordan:example.com" size={24} />
        <Avatar name="Goose" seed="!goose" size={48} radius={14} />
        <Avatar name="Riley" seed="@riley:example.com" size={64} showDot dotColor="var(--th-state-success)" />
      </Row>
      <Row label="Icon (static / motion)">
        <Icon name="go-home-symbolic" size={22} />
        <Icon name="go-home-symbolic" size={22} hovered />
        <Icon name="audio-input-microphone-symbolic" size={22} active />
        <Icon name="view-calendar-symbolic" size={16} />
        <Icon name="settings-configure" size={32} />
        <Icon name="emblem-warning" size={22} isMask={false} />
        <Icon name="security-medium-symbolic" size={22} color="var(--th-state-warning)" />
        <HoverIcon name="call-start-symbolic" />
        <HoverIcon name="dialog-messages-symbolic" />
        <HoverIcon name="edit-delete-symbolic" />
      </Row>
      <Row label="Busy / loader">
        <BusyIndicator size={36} color="var(--th-text-secondary)" />
        <TinHatLoader size={64} running />
        <TinHatLoader size={64} running={false} />
      </Row>
      <SectionLabel>Messages</SectionLabel>
      <InlineMessage type="warning" text="This device isn't verified, so encrypted messages can't be read." actions={[{ text: "Verify…", onTriggered: () => {} }]} />
      <InlineMessage type="information" text="Update available: v10.5.0 → v10.5.1" actions={[{ text: "What's new", onTriggered: () => {} }]} />
      <InlineMessage type="positive" text="Update installed (v10.5.1) — restart to apply." />
      <InlineMessage type="error" text="Can't reach the server." showCloseButton onClose={() => {}} />
      <div style={{ height: 300, border: "1px dashed var(--th-border-subtle)" }}>
        <EmptyState iconName="dialog-messages-symbolic" title="Pick a room to start" explanation="Your rooms are on the left. Ctrl+K jumps to any of them, Alt+↑/↓ steps through the list." />
      </div>
      <SectionLabel>ScrollArea (FoxScrollBar)</SectionLabel>
      <ScrollArea style={{ height: 160, border: "1px solid var(--th-border-subtle)" }} edgeHover={24} gutter={16}>
        {Array.from({ length: 30 }, (_, i) => (
          <div key={i} style={{ padding: "4px 8px" }}>
            Row {i + 1} — scroll me, hover the right edge
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}

function HoverIcon({ name }: { name: string }) {
  const [h, setH] = useState(false);
  return (
    <span onPointerEnter={() => setH(true)} onPointerLeave={() => setH(false)} style={{ display: "inline-flex", padding: 4, border: "1px dashed var(--th-border-subtle)" }} title={`${name} — hover`}>
      <Icon name={name} size={22} hovered={h} />
    </span>
  );
}

// ---- live popups (the overview's bottom bar) ---------------------------------------------------

function LivePopups() {
  const menu = useMenu();
  const [confirm, setConfirm] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [pop, setPop] = useState<HTMLElement | null>(null);
  const [win, setWin] = useState(false);
  return (
    <div className={s.live}>
      <SectionLabel>Live (current theme)</SectionLabel>
      <div className={s.rowItems}>
        <BasicButton text="Menu" onClick={(e) => menu.openAt(e.currentTarget)} />
        <BasicButton text="ConfirmDialog" onClick={() => setConfirm(true)} />
        <BasicButton text="Dialog" onClick={() => setDialog(true)} />
        <BasicButton text="PromptDialog" onClick={() => setPrompt(true)} />
        <BasicButton text="OverlaySheet" onClick={() => setSheet(true)} />
        <BasicButton text="Popover" onClick={(e) => setPop(pop ? null : e.currentTarget)} />
        <BasicButton text="Toast" onClick={() => showToast("Room link copied — they will still need an invite", 4000)} />
        <BasicButton text="Toast + action" onClick={() => showToast("Removed from Favourites", "short", { label: "Undo", run: () => showToast("Restored") })} />
        <BasicButton text="AppWindow" onClick={() => setWin(true)} />
        <Tooltip text="A Controls.ToolTip: 400 ms, centred above, 6 px inside the window">
          <BasicButton text="Tooltip (hover)" />
        </Tooltip>
        <ContextMenu
          menu={() => (
            <>
              <MenuItem text="Copy link" icon="link-symbolic" />
              <MenuItem text="Mark as read" icon="checkmark-symbolic" />
              <MenuSeparator />
              <MenuItem text="Leave" icon="system-log-out-symbolic" danger />
            </>
          )}
        >
          <span className={s.ctxArea}>Right-click / long-press me</span>
        </ContextMenu>
      </div>
      <Menu {...menu.props}>
        <MenuItem text="New chat…" icon="document-edit-symbolic" />
        <MenuItem text="New room…" icon="folder-new-symbolic" />
        <MenuSeparator />
        <MenuSectionLabel text="Theme" />
        <SubMenu title="Theme" icon="preferences-desktop-color">
          <CheckMenuItem text="OLED" checked />
          <CheckMenuItem text="Goose" checked={false} />
        </SubMenu>
        <CheckMenuItem text="Tuck nav into corner (OLED)" icon="view-left-close-symbolic" checked={false} />
        <MenuItem text="Disabled item" icon="view-refresh-symbolic" disabled />
        <MenuItem text="Sign out" icon="system-log-out-symbolic" />
      </Menu>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        dialogTitle="Leave space?"
        confirmText="Leave"
        destructive
        askReason
        message={'Leave "Example Squad"? Its rooms stay joined; you\'ll need a new invite to get the space (and its calendar) back.'}
      />
      <Dialog open={dialog} onClose={() => setDialog(false)} title="Verify this device" standardButtons={["close"]} width={468}>
        Verifying proves this really is you, so encrypted messages can be read here and others stop seeing warnings about you.
      </Dialog>
      <PromptDialog
        open={prompt}
        onClose={() => setPrompt(false)}
        title="New chat"
        subtitle="Start a direct chat with someone by their user id."
        standardButtons={["cancel"]}
        actions={[{ text: "Start chat", icon: "document-edit-symbolic", onClick: () => setPrompt(false) }]}
      >
        <BasicTextField placeholder="@someone:example.com" />
      </PromptDialog>
      <OverlaySheet open={sheet} onClose={() => setSheet(false)} title="About Tin Hat" preferredWidth={396}>
        <Heading level={2}>Tin Hat</Heading>
        <Label dim>Native Matrix client · web</Label>
      </OverlaySheet>
      <Popover open={!!pop} onClose={() => setPop(null)} anchor={pop} placement="above" gap={4}>
        <Label>A Basic Popup (palette.window, padding 12).</Label>
      </Popover>
      {win && (
        <AppWindow id="gallery-demo" title="Calendar — Example Squad" onClose={() => setWin(false)} defaultSize={{ width: 640, height: 420 }}>
          <EmptyState iconName="view-calendar-symbolic" title="An in-app window" explanation="Drag the title bar, resize from any edge, double-click to maximise. Geometry is remembered." />
        </AppWindow>
      )}
    </div>
  );
}

// ---- icons ------------------------------------------------------------------------------------

function IconsPage() {
  const idx = useIconIndex();
  const [filter, setFilter] = useState("");
  if (!idx) return <div className={s.page}>Loading the icon pack…</div>;
  const names = [...new Set([...Object.keys(idx.motion), ...Object.keys(idx.static), ...Object.keys(idx.breeze)])].sort().filter((n) => n.includes(filter));
  return (
    <div className={s.page}>
      <div className={s.top}>
        <Heading level={1}>Icon pack</Heading>
        <SearchField style={{ width: 260 }} value={filter} onValueChange={setFilter} />
        <Label dim>
          {Object.keys(idx.motion).length} motion · {Object.keys(idx.static).length} static · {Object.keys(idx.breeze).length} Breeze — hover a tile to play its story
        </Label>
      </div>
      <div className={s.iconGrid}>
        {names.map((n) => (
          <IconTile key={n} name={n} kind={idx.motion[n] ? "motion" : idx.static[n] ? "static" : "breeze"} />
        ))}
      </div>
    </div>
  );
}

function IconTile({ name, kind }: { name: string; kind: string }) {
  const [h, setH] = useState(false);
  const mask = !/^(emblem-|data-|dialog-(information|positive|error)$|window-close$|image-missing)/.test(name);
  return (
    <div className={s.iconTile} onPointerEnter={() => setH(true)} onPointerLeave={() => setH(false)} title={`${name} (${kind})`}>
      <div className={s.iconSizes}>
        <Icon name={name} size={16} hovered={h} isMask={mask} />
        <Icon name={name} size={22} hovered={h} isMask={mask} />
        <Icon name={name} size={32} hovered={h} isMask={mask} />
      </div>
      <div className={s.iconName}>{name}</div>
      <div className={s.iconKind}>{kind}</div>
    </div>
  );
}

// ---- mobile ------------------------------------------------------------------------------------

function MobilePage() {
  const menu = useMenu();
  const [pop, setPop] = useState(false);
  const [win, setWin] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [c, setC] = useState(0);
  const mobile = useIsMobile();
  return (
    <div className={s.page} style={{ padding: 12 }}>
      <Heading level={2}>Phone presentations</Heading>
      {!mobile && (
        <HintLabel>
          Open this page with ?ff=mobile (<a href="#/__gallery/mobile?ff=mobile">#/__gallery/mobile?ff=mobile</a>) or on a phone to see the bottom sheets.
        </HintLabel>
      )}
      <div className={s.mobileCol}>
        <BasicButton text="Menu → bottom sheet" onClick={(e) => menu.openAt(e.currentTarget)} />
        <BasicButton text="Popover → bottom sheet" onClick={() => setPop(true)} />
        <ComboBox aria-label="Game" model={["Valheim", "Project Zomboid", "Satisfactory"]} currentIndex={c} onActivated={setC} />
        <BasicButton text="AppWindow → full-screen sheet" onClick={() => setWin(true)} />
        <BasicButton text="OverlaySheet → full screen" onClick={() => setSheet(true)} />
        <TextField placeholder="Inputs are 16 px here (no iOS zoom)" />
        <CheckBox text="Touch-sized check box" checked />
        <ContextMenu menu={() => <MenuItem text="Copy" icon="edit-copy-symbolic" />}>
          <span className={s.ctxArea}>Long-press me</span>
        </ContextMenu>
      </div>
      <Menu {...menu.props} title="Tin Hat">
        <MenuItem text="New chat…" icon="document-edit-symbolic" />
        <MenuItem text="Settings…" icon="settings-configure" />
        <SubMenu title="Theme" icon="preferences-desktop-color">
          <CheckMenuItem text="OLED" checked />
          <CheckMenuItem text="Goose" checked={false} />
        </SubMenu>
        <MenuSeparator />
        <MenuItem text="Sign out" icon="system-log-out-symbolic" />
      </Menu>
      <Popover open={pop} onClose={() => setPop(false)} title="Call options">
        <Switch text="Noise suppression" checked />
        <Slider value={0.6} style={{ width: "100%" }} />
      </Popover>
      {win && (
        <AppWindow id="gallery-mobile" title="Calendar" onClose={() => setWin(false)}>
          <EmptyState iconName="view-calendar-symbolic" title="Full-screen sheet" explanation="The back chevron closes it." />
        </AppWindow>
      )}
      <OverlaySheet open={sheet} onClose={() => setSheet(false)} title="Settings">
        <Label>Sheet content</Label>
      </OverlaySheet>
    </div>
  );
}

// ---- startup ------------------------------------------------------------------------------------

const STAGES = [
  { stage: "Starting up", percent: 5 },
  { stage: "Loading the interface", percent: 40 },
  { stage: "Restoring your session", percent: 55 },
  { stage: "Loading your rooms", detail: "@jamie:example.com", percent: 80 },
  { stage: "Catching up on messages", percent: 90 },
];

function StartupDemo() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const pinned = q.get("stage");
  const [i, setI] = useState(pinned ? Number(pinned) : 0);
  useEffect(() => {
    if (pinned) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % STAGES.length), 1500);
    return () => window.clearInterval(t);
  }, [pinned]);
  const st = STAGES[i] ?? STAGES[0];
  return <Startup stage={st.stage} detail={st.detail} percent={st.percent} />;
}

// ---- replicas of native screen regions (compare with tools/ui-compare.sh) ------------------------

/** the app menu as captured in ui-appmenu: popup at (308, 374), its bottom at the window edge */
function ReplicaMenu() {
  return (
    <div className={s.replica}>
      <Menu open onClose={() => {}} anchor={{ x: 308, y: 374 }}>
        <MenuItem text="New chat…" icon="document-edit-symbolic" />
        <MenuItem text="New room…" icon="folder-new-symbolic" />
        <MenuItem text="Space settings…" icon="configure-symbolic" />
        <MenuSeparator />
        <MenuItem text="What do we play tonight?" icon="applications-games-symbolic" />
        <MenuItem text="Settings…" icon="settings-configure" />
        <SubMenu title="Theme" icon="preferences-desktop-color">
          <CheckMenuItem text="OLED" checked />
          <CheckMenuItem text="Goose" checked={false} />
        </SubMenu>
        <CheckMenuItem text="Tuck nav into corner (OLED)" icon="view-left-close-symbolic" checked={false} />
        <MenuItem text="Refresh rooms" icon="view-refresh-symbolic" />
        <MenuItem text="Check for updates" icon="system-software-update" />
        <MenuItem text="Verify this device…" icon="security-low-symbolic" />
        <MenuSeparator />
        <MenuItem text="Keyboard shortcuts…" icon="input-keyboard-symbolic" />
        <MenuItem text="Help & tour" icon="help-hint-symbolic" />
        <MenuItem text="About Tin Hat" icon="help-about-symbolic" />
        <MenuItem text="Sign out" icon="system-log-out-symbolic" force="hover" />
      </Menu>
    </div>
  );
}

function ReplicaConfirm() {
  return (
    <div className={s.replica}>
      <ConfirmDialog
        open
        onClose={() => {}}
        dialogTitle="Sign out?"
        confirmText="Sign out anyway"
        destructive
        message="Sign out of @jamie:example.com? This account has no key backup. Signing out deletes this device's encryption keys, so the encrypted messages you can read now will become unreadable — here and on any new device. To keep them, set up recovery first (Settings → Security)."
      />
    </div>
  );
}

function ReplicaBanner() {
  return (
    <div className={s.replica}>
      <BannerStripView verify />
    </div>
  );
}

function ReplicaAbout() {
  return (
    <div className={s.replica}>
      <OverlaySheet open onClose={() => {}} header={<Heading level={1}>About Tin Hat</Heading>} preferredWidth={396}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, height: 400 }}>
          <div>
            <Heading level={2}>Tin Hat</Heading>
            <Label dim as="div">
              Native Matrix client · KDE/Kirigami + Rust
            </Label>
            <Label as="div" style={{ fontSize: "var(--th-font-h2)", lineHeight: "var(--th-line-h2)" }}>
              Tin Hat 10.5.0 (4fb85cc)
            </Label>
          </div>
        </div>
      </OverlaySheet>
    </div>
  );
}

function ReplicaPrompt() {
  return (
    <div className={s.replica}>
      <PromptDialog
        open
        onClose={() => {}}
        title="Join a space"
        actions={[
          { text: "Make a space instead", icon: "folder-new-symbolic", onClick: () => {} },
          { text: "Join", icon: "go-next-symbolic", onClick: () => {} },
        ]}
      >
        <BasicTextField placeholder="Paste an invite link" autoFocus />
        <HintLabel style={{ color: "var(--th-text-primary)" }}>Anything works: an invite link, a matrix.to link, or an address like #general:example.com.</HintLabel>
        <HintLabel style={{ color: "var(--th-text-primary)" }}>Haven't got a link? Make your own space and invite people to it.</HintLabel>
      </PromptDialog>
    </div>
  );
}

function ReplicaTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // "hover" the stand-in for the room-list bug button (native 220..260 × 907..947)
    const t = window.setTimeout(() => ref.current?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })), 50);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={s.replica}>
      <Tooltip text="Report a problem (sends your note + current session log)" delay={0}>
        <div ref={ref} style={{ position: "absolute", left: 220, top: 907, width: 40, height: 40 }} />
      </Tooltip>
    </div>
  );
}

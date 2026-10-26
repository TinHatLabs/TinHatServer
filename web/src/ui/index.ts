// @/ui — Tin Hat Web's house controls, one-to-one with the native QML (same names minus `Th`;
// `Basic*` = the stock Qt Quick Controls Basic look the native uses where it didn't restyle).
// Colours: one CSS variable --th-<id> per role and element token of src/theme/tokens.json (tokens.css defaults,
// applyTheme() sets the active theme); JS reads the same values via themeColours() / useThemeColours(); cssVar(id) is
// the typed var(). How to use them: src/theme/MIGRATING.md. Qt colour maths in color.ts.
//
//   Native                     Web
//   ThButton                 Button
//   Controls.Button            BasicButton
//   ThToolButton             ToolButton
//   Controls.ToolButton        BasicToolButton
//   HeaderIconButton           HeaderIconButton
//   GlowButton                 GlowButton
//   ThTextField / TextArea   TextField / TextArea
//   Controls.TextField         BasicTextField
//   Kirigami.SearchField       SearchField
//   ThComboBox               ComboBox            (variant="basic" = Controls.ComboBox)
//   ThCheckBox / RadioButton CheckBox / RadioButton
//   Controls.CheckBox / Radio  BasicCheckBox / BasicRadioButton
//   Controls.Switch / Slider   Switch / Slider
//   Controls.Menu + items      Menu, MenuItem, CheckMenuItem, SubMenu, MenuSeparator, MenuSectionLabel
//   right-click menus          ContextMenu, useMenu
//   Controls.Popup             Popover
//   Controls.ToolTip           Tooltip, useTip, TooltipHost
//   Controls.Dialog            Dialog
//   ConfirmDialog              ConfirmDialog
//   Kirigami.OverlaySheet      OverlaySheet
//   Kirigami.PromptDialog      PromptDialog
//   Kirigami.InlineMessage     InlineMessage
//   showPassiveNotification    Toast (showToast / ToastHost; or toast() from @/core/bus)
//   secondary OS windows       AppWindow (+ WindowHost in @/app)
//   FoxScrollBar               ScrollArea
//   Avatar / UnreadBadge       Avatar / UnreadBadge
//   SectionLabel / HintLabel   SectionLabel / HintLabel
//   EmptyState                 EmptyState
//   Controls.Label / Heading   Label / Heading;  Kirigami.Separator → Separator
//   Controls.BusyIndicator     BusyIndicator
//   ThIcon / Kirigami.Icon   Icon
//   TinHatLoader               TinHatLoader
import "./tokens.css";

export * from "./Button";
export * from "./HeaderIconButton";
export * from "./GlowButton";
export * from "./TextField";
export * from "./ComboBox";
export * from "./CheckBox";
export * from "./Slider";
export * from "./Menu";
export * from "./touchPress";
export * from "./Popover";
export * from "./Tooltip";
export * from "./Dialog";
export * from "./OverlaySheet";
export * from "./InlineMessage";
export * from "./Toast";
export * from "./AppWindow";
export * from "./ScrollArea";
export * from "./Avatar";
export { avatarSeed, personSeed } from "./avatarSeed";
export * from "./UnreadBadge";
export * from "./Label";
export * from "./EmptyState";
export * from "./BusyIndicator";
export { AnimatedImage, type AnimatedImageProps } from "./AnimatedImage";
export { meterDriver, levelAmp, useMeter, type MeterDriver } from "./meter";
export * from "./Icon";
export * from "./TinHatLoader";
export { AppErrorBoundary, OverlayBoundary, showFatalCard, shortError, CrashProbe, armCrashProbe } from "./ErrorBoundary";
export { useHoverPress, cx, mergeRefs, type ForceState } from "./hooks";
export { useIsMobile, useIsTouch, setFormFactorAttrs } from "./formFactor";
export { OverlayPortal, closeTopPopup, placePopup, rectOf, usePopupStack, type Rect, type Placement } from "./overlay";
export { IslandContext, useIsland, type IslandCtx, type IslandReport } from "./island";
export {
  THEME_NAMES,
  themeColours,
  useThemeColours,
  cssVar,
  themeVars,
  applyTheme,
  applyReducedMotion,
  currentTheme,
  useTheme,
  useReducedMotion,
  durMs,
  senderColor,
  contentInk,
  useContentInk,
  localpart,
  hash31,
  normalizeTheme,
  type ThemeName,
  type ThemeColours,
  type ThemeColourId,
  type RoleId,
  type TokenId,
} from "./themes";
export { qtLighter, qtDarker, qtAlpha, qtRgba, qtHsla, mix, over, parseColor, formatColor } from "./color";
export { loadIconIndex, useIconIndex, resolveIcon } from "./iconpack";
export { animate, useAnimate, onMotionChange, installMotion, caretWake, animateFor, ringOn, ringHigh, RING_LIMIT_MS, RING_STEP_MS, RING_OPACITY, DUR, type DurStep } from "./motion";

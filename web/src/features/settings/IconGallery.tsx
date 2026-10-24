// IconGallery.tsx — IconGalleryWindow.qml as an in-app window (r.windows "iconGallery"): header
// (Heading-2, pack info, Reload pack), filter / size / Play all / Active state / count, a grid of
// 160 × 126 cells (hover = the motion story). Opened from ☰ "Icon gallery" with ?dev=1 (native
// --tinhat-dev) or ?icongallery=1 (TINHAT_GUI_ICONGALLERY). Animated = motion record present (native
// counted `.anim` only and always showed 0 — docs/native-bugs/settings.md).
import { useMemo, useState } from "react";
import { BasicButton, BasicCheckBox, BasicTextField, ComboBox, Heading, Icon, loadIconIndex, useIconIndex, cx } from "@/ui";
import s from "./IconGallery.module.css";

export const GALLERY_NAMES = [
  "audio-input-microphone-symbolic",
  "microphone-sensitivity-muted-symbolic",
  "audio-volume-high-symbolic",
  "audio-volume-low-symbolic",
  "audio-volume-muted-symbolic",
  "audio-speakers-symbolic",
  "camera-video-symbolic",
  "monitor-symbolic",
  "window-symbolic",
  "window-duplicate-symbolic",
  "video-display-brightness-symbolic",
  "video-television-symbolic",
  "call-start-symbolic",
  "call-stop-symbolic",
  "emblem-music-symbolic",
  "folder-music-symbolic",
  "link-symbolic",
  "media-record-symbolic",
  "layer-visible-off-symbolic",
  "layer-visible-on-symbolic",
  "view-fullscreen-symbolic",
  "view-restore-symbolic",
  "window-new",
  "applications-games-symbolic",
  "view-statistics-symbolic",
  "checkmark-symbolic",
  "dialog-ok-symbolic",
  "media-playback-stop-symbolic",
  "edit-undo-symbolic",
  "appointment-missed-symbolic",
  "configure-symbolic",
  "settings-configure-symbolic",
  "view-more-symbolic",
  "mail-message-symbolic",
  "mail-message-new-symbolic",
  "mail-reply-sender-symbolic",
  "list-add-symbolic",
  "list-add-user",
  "contact-new-symbolic",
  "insert-image-symbolic",
  "edit-copy-symbolic",
  "edit-delete-symbolic",
  "delete-symbolic",
  "edit-delete-remove",
  "edit-clear-symbolic",
  "edit-clear-all-symbolic",
  "document-edit-symbolic",
  "document-save-symbolic",
  "document-open-symbolic",
  "document-send-symbolic",
  "folder-new-symbolic",
  "folder-symbolic",
  "go-home-symbolic",
  "go-next-symbolic",
  "go-previous-symbolic",
  "rating",
  "starred-symbolic",
  "non-starred-symbolic",
  "dialog-close-symbolic",
  "dialog-cancel-symbolic",
  "dialog-ok-apply-symbolic",
  "dialog-messages-symbolic",
  "view-list-details-symbolic",
  "documentinfo-symbolic",
  "view-left-close-symbolic",
  "sidebar-collapse-left-symbolic",
  "sidebar-expand-left-symbolic",
  "application-menu-symbolic",
  "view-refresh-symbolic",
  "window-close-symbolic",
  "window-minimize-symbolic",
  "window-pin-symbolic",
  "user-symbolic",
  "user-identity",
  "system-users-symbolic",
  "im-kick-user-symbolic",
  "im-ban-user-symbolic",
  "channel-secure-symbolic",
  "channel-insecure-symbolic",
  "lock-symbolic",
  "view-visible-symbolic",
  "view-hidden-symbolic",
  "network-server-symbolic",
  "network-connect",
  "network-disconnect",
  "network-disconnect-symbolic",
  "media-playback-start",
  "media-playback-start-symbolic",
  "media-playback-pause",
  "media-playback-stop",
  "media-skip-forward",
  "media-skip-backward",
  "media-playlist-append",
  "list-add",
  "list-remove-symbolic",
  "view-preview-symbolic",
  "video-x-generic",
  "audio-x-generic",
  "application-pdf",
  "application-x-archive",
  "application-octet-stream",
  "security-high-symbolic",
  "security-low-symbolic",
  "backup-symbolic",
  "dialog-warning",
  "computer-symbolic",
  "smartphone-symbolic",
  "help-about-symbolic",
  "help-hint-symbolic",
  "tools-report-bug-symbolic",
  "system-log-out-symbolic",
  "system-software-update",
  "system-software-install",
  "preferences-desktop-color",
  "settings-configure",
  "contrast-symbolic",
  "view-private-symbolic",
  "view-calendar-symbolic",
  "view-calendar-month-symbolic",
  "view-calendar-list-symbolic",
  "view-calendar-upcoming-events-symbolic",
  "appointment-new-symbolic",
  "notifications",
  "notifications-disabled-symbolic",
  "image-x-generic",
  "text-x-generic",
  "face-smile-symbolic",
  "headphones-symbolic",
  "bookmark-new-symbolic",
  "view-grid-symbolic",
];

const SIZES = [16, 22, 32, 48, 64];

// Text.ElideMiddle at the cell's label width (160 − 2×8 margins), smallFont.
let measureCtx: CanvasRenderingContext2D | null = null;
/** smallFont in px as the page resolves it: `--th-font-size-small` is a calc() (× the theme's text scale, ENGINE.md
 *  §10), which getPropertyValue returns unresolved — a probe element's computed font-size is the real number. */
function smallFontPx(): number {
  const el = document.createElement("span");
  el.style.cssText = "position:absolute;visibility:hidden;font-size:var(--th-font-size-small)";
  document.body.appendChild(el);
  const px = parseFloat(getComputedStyle(el).fontSize);
  el.remove();
  return Number.isFinite(px) && px > 0 ? px : 16;
}
function elideMiddle(text: string, maxPx: number): string {
  if (typeof document === "undefined") return text;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (!ctx) return text;
  const cs = getComputedStyle(document.documentElement);
  ctx.font = `${smallFontPx()}px ${cs.getPropertyValue("--th-font") || "sans-serif"}`;
  const w = (t: string) => ctx.measureText(t).width;
  if (w(text) <= maxPx) return text;
  let keep = text.length - 1;
  while (keep > 1) {
    const head = Math.ceil(keep / 2);
    const cand = text.slice(0, head) + "…" + text.slice(text.length - (keep - head));
    if (w(cand) <= maxPx) return cand;
    keep--;
  }
  return "…";
}

function Cell({ name, size, animated, active, playing }: { name: string; size: number; animated: boolean; active: boolean; playing: boolean }) {
  const [hov, setHov] = useState(false);
  return (
    <div className={s.cell} onPointerEnter={() => setHov(true)} onPointerLeave={() => setHov(false)}>
      <div className={cx(s.frame, animated && s.animated, hov && s.hover)} />
      <div className={s.iconBand}>
        <Icon name={name} size={size} color="var(--th-icon-gallery-icon)" hovered={hov} active={active} playing={playing} />
      </div>
      <div className={s.name} title={name}>
        {elideMiddle(name, 144)}
      </div>
      {animated && <div className={s.anim}>animated · hover</div>}
    </div>
  );
}

export function IconGallery() {
  const idx = useIconIndex();
  const [filter, setFilter] = useState("");
  const [size, setSize] = useState(2);
  const [playAll, setPlayAll] = useState(false);
  const [active, setActive] = useState(false);
  const [gen, setGen] = useState(0);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? GALLERY_NAMES.filter((n) => n.includes(f)) : GALLERY_NAMES;
  }, [filter]);
  const isAnim = (n: string) => !!idx?.motion?.[n];
  const animCount = GALLERY_NAMES.filter(isAnim).length;
  return (
    <div className={s.root} key={gen}>
      <div className={s.header}>
        <div className={s.row}>
          <Heading level={2}>Icon gallery</Heading>
          <span className={s.info}>
            {idx
              ? `Pack: iconpack/web (bundled)  ·  ${animCount} of ${GALLERY_NAMES.length} animated  ·  static theme from the pack`
              : "No icon pack found — showing Breeze. Reload to try again."}
          </span>
          <BasicButton text="Reload pack" icon="view-refresh-symbolic" onClick={() => void loadIconIndex().finally(() => setGen((g) => g + 1))} />
        </div>
        <div className={cx(s.row, s.wrap)}>
          <BasicTextField style={{ width: 260 }} placeholder="Filter names…" aria-label="Filter names" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className={s.dim}>Size</span>
          <ComboBox variant="basic" aria-label="Size" model={SIZES.map(String)} currentIndex={size} onActivated={setSize} style={{ width: 100 }} />
          <BasicCheckBox text="Play all" checked={playAll} onToggled={setPlayAll} />
          <BasicCheckBox text="Active state" checked={active} onToggled={setActive} />
          <span className={s.spacer} />
          <span className={s.dim}>{shown.length} icons</span>
        </div>
      </div>
      <div className={s.grid}>
        {shown.map((n) => (
          <Cell key={n} name={n} size={SIZES[size]} animated={isAnim(n)} active={active} playing={playAll} />
        ))}
      </div>
    </div>
  );
}

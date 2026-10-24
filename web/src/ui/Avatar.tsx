// Avatar.tsx — Avatar.qml. A disc in a deterministic warm hue from `seed` (hash31: 80 % red→gold
// band 0.02 + (h % 56)/360, 20 % teal 0.45 + (h % 22)/360; hsla(hue, 0.52, 0.46)) drawn as a
// vertical gradient lighter×1.35 → darker×1.18 with a soft drop shadow (max(2, size·0.12) px,
// black .35, y+1); the first visible character (sigil-stripped, uppercased) in bold white at
// round(size·0.44) with a 1 px raised shadow. An image (mxc:// via @/core/matrix useMxcUrl, or a
// plain URL) replaces it, circle-cropped with a 1 px white .12 ring; a dead image falls back to the
// letter. Optional call dot bottom-right (max(8, size·0.28), panel-coloured cut ring drawn inside it).
// REACH §2.6 presence dot (`presenceColor` set; replaces the call dot on its corner, as on the desktop
// Avatar.qml): the dot is max(8, size·0.28) and its "cut" ring max(1.5, size·0.05) is drawn OUTSIDE it in the
// colour of the surface behind (`presenceRing`), so it bites into the avatar edge; a white headset glyph
// (the pack's headphones-symbolic) when the dot is ≥ 12 px and `presenceGlyph`; `presenceLabel` = its text
// alternative (A2.14); `presenceLeft` = bottom-left (the DM strip, where the badge owns bottom-right).
import { useMemo, useState, type CSSProperties } from "react";
import { useMxcUrl } from "@/core/matrix";
import { qtDarker, qtHsla, qtLighter } from "./color";
import { Icon } from "./Icon";
import { hash31 } from "./themes";
import s from "./Avatar.module.css";

export interface AvatarProps {
  /** mxid or display name (the initial) */
  name?: string;
  /** stable identity for the hue (mxid / room id / participant); default = name */
  seed?: string;
  size?: number;
  /** mxc:// or http(s)/blob:/data: URL */
  imageSource?: string | null;
  showDot?: boolean;
  dotColor?: string;
  /** REACH §2.6: the presence dot's colour (set = shown) */
  presenceColor?: string;
  /** the surface behind the avatar (the cut ring), default the panel */
  presenceRing?: string;
  /** the white headset glyph (in a call) — drawn when the dot is ≥ 12 px */
  presenceGlyph?: boolean;
  /** the text alternative ("Online", "Away", "In a call", or the status label) */
  presenceLabel?: string;
  presenceLeft?: boolean;
  presenceSize?: number;
  presenceRingWidth?: number;
  /** corner radius (default = circle) — the spaces rail morphs to a squircle */
  radius?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
}

export function avatarHue(seed: string): string {
  const h = hash31(seed || "");
  const pick = h % 100;
  const hue = pick < 80 ? 0.02 + (h % 56) / 360 : 0.45 + (h % 22) / 360;
  return qtHsla(hue, 0.52, 0.46, 1);
}

export function avatarInitial(name: string | undefined): string {
  const t = (name || "").replace(/^[@#!+]/, "").trim();
  if (!t) return "?";
  const first = Array.from(t)[0];
  return first.toUpperCase();
}

export function Avatar({
  name = "",
  seed,
  size = 40,
  imageSource,
  showDot,
  dotColor,
  presenceColor,
  presenceRing,
  presenceGlyph,
  presenceLabel,
  presenceLeft,
  presenceSize,
  presenceRingWidth,
  radius,
  className,
  style,
  title,
  onClick,
}: AvatarProps) {
  const key = seed || name;
  const colors = useMemo(() => {
    const base = avatarHue(key);
    return { top: qtLighter(base, 1.35), bottom: qtDarker(base, 1.18) };
  }, [key]);
  const decodePx = Math.min(512, 64 * Math.ceil(Math.max(1, size * 2) / 64));
  const isMxc = !!imageSource && imageSource.startsWith("mxc://");
  const mxcUrl = useMxcUrl(isMxc ? imageSource : null, { width: decodePx, height: decodePx, method: "crop" });
  const url = isMxc ? mxcUrl : imageSource || undefined;
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = !!url && failed !== url;
  const r = radius ?? size / 2;
  const dot = Math.max(8, size * 0.28);
  const pDot = presenceSize ?? dot;
  const pRing = presenceRingWidth ?? Math.max(1.5, size * 0.05);
  return (
    <span
      className={`${s.avatar} ${className ?? ""}`}
      style={{ width: size, height: size, ...style }}
      title={title}
      role={onClick ? "button" : "img"}
      aria-label={title ?? name}
      onClick={onClick}
    >
      <span
        className={s.disc}
        style={{
          borderRadius: r,
          background: `linear-gradient(${colors.top}, ${colors.bottom})`,
          boxShadow: `0 1px ${Math.max(2, size * 0.12)}px rgba(0, 0, 0, 0.35)`,
        }}
      >
        {!showImg && (
          <span className={s.initial} style={{ fontSize: Math.round(size * 0.44), lineHeight: `${size}px` }}>
            {avatarInitial(name)}
          </span>
        )}
      </span>
      {showImg && (
        <>
          <img className={s.photo} style={{ borderRadius: r }} src={url} alt="" draggable={false} onError={() => setFailed(url!)} />
          <span className={s.ring} style={{ borderRadius: r }} />
        </>
      )}
      {showDot && !presenceColor && (
        <span
          className={s.dot}
          data-dot=""
          style={{
            width: dot,
            height: dot,
            background: dotColor ?? "var(--th-avatar-dot)",
            boxShadow: `0 0 0 ${Math.max(1.5, size * 0.05)}px var(--th-avatar-dot-ring) inset`,
          }}
        />
      )}
      {presenceColor && (
        <span
          className={s.cut}
          role="img"
          aria-label={presenceLabel}
          data-dot=""
          data-presence-dot=""
          style={{
            width: pDot + 2 * pRing,
            height: pDot + 2 * pRing,
            bottom: -pRing,
            ...(presenceLeft ? { left: -pRing } : { right: -pRing }),
            background: presenceRing ?? "var(--th-presence-ring)",
          }}
        >
          <span className={s.pdot} style={{ width: pDot, height: pDot, background: presenceColor }}>
            {presenceGlyph && pDot >= 12 && <Icon name="headphones-symbolic" size={Math.round(pDot * 0.72)} color="var(--th-presence-incall-icon)" />}
          </span>
        </span>
      )}
    </span>
  );
}

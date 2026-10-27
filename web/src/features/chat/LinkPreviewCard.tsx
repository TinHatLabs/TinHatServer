// LinkPreviewCard.qml — SITE / title (link, 2 lines) / description (3 lines) / wide image or 64 px thumb.
import { useMxcUrl } from "@/core/matrix";
import { AnimatedImage, cx } from "@/ui";
import { useLinkPreview } from "./lib/linkpreview";
import s from "./Bubble.module.css";
import { openExternal } from "@/core/openlink";

export function LinkPreviewCard({ url, maxW, mine, enabled }: { url: string; maxW: number; mine: boolean; enabled: boolean }) {
  const p = useLinkPreview(url, enabled);
  const img = useMxcUrl(p?.image || null);
  if (!p) return null;
  const w = Math.min(maxW, 420);
  const thumb = !!p.image && p.imageW > 0 && p.imageW <= 240 && Math.abs(p.imageW - p.imageH) < p.imageW / 2;
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    openExternal(p.url);
  };
  const imgW = w - 24;
  const imgH = p.imageW && p.imageH ? Math.min(220, Math.round((imgW * p.imageH) / p.imageW)) : undefined;
  return (
    <div className={cx(s.lp, mine && s.lpMine)} style={{ width: w }}>
      <span className={s.lpBar} />
      <div className={s.lpRow}>
        <div className={s.lpCol}>
          {(p.site || p.host) && <span className={s.lpSite}>{(p.site || p.host).toUpperCase()}</span>}
          {p.title && (
            <span className={s.lpTitle} onClick={open} role="link">
              {p.title}
            </span>
          )}
          {p.description && <span className={s.lpDesc}>{p.description}</span>}
          {img && !thumb && (
            <AnimatedImage className={s.lpImage} src={img} alt="" style={{ maxWidth: imgW, maxHeight: 220, height: imgH }} clickPlays={false} onClick={open} draggable={false} />
          )}
        </div>
        {img && thumb && <AnimatedImage className={s.lpThumb} src={img} alt="" clickPlays={false} onClick={open} draggable={false} />}
      </div>
    </div>
  );
}

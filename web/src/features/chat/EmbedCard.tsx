// EmbedCard.tsx — ThEmbedCard.qml: click-to-play poster card (nothing third-party loads except the
// YouTube poster until clicked); playing = a sandboxed iframe / <video> in place with ↗ / ✕ overlay;
// image mode (a .gif link) shows the animation clipped to its 300 px box (D3/D5). Fullscreen = the
// player's own button (browser Fullscreen API).
import { useRef, useState } from "react";
import { toast } from "@/core/bus";
import { AnimatedImage, Icon, useTip, cx } from "@/ui";
import { useC } from "@/features/callui/store";
import { addLinkToParty } from "@/features/media";
import type { Embed } from "./lib/embeds";
import s from "./Bubble.module.css";
import { openExternal } from "@/core/openlink";

/** Media Party 11.4 (DESIGN §2.2): while I'm in THIS room's call, a music / video link card offers "Add to Media
 *  Party" and "Play now" (the card is added through the party's link pipeline — a Spotify / Apple song becomes its
 *  YouTube upload; joins the party first when needed). */
function PartyActions({ roomId, url }: { roomId: string; url: string }) {
  const inCall = useC("inCall");
  const callRoom = useC("callRoomId");
  const [busy, setBusy] = useState(false);
  if (!inCall || !roomId || callRoom !== roomId) return null;
  const run = async (playNow: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await addLinkToParty(roomId, url, playNow);
      toast(r.status === "queued" ? `Added to the Media Party${r.item.title ? ` — ${r.item.title}` : ""}` : r.status === "playing" ? `Playing in the Media Party${r.item.title ? ` — ${r.item.title}` : ""}` : r.status === "card" || r.status === "error" ? r.message : "Open the Media Party to add this.", { timeoutMs: 3500 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.embedParty} onClick={(ev) => ev.stopPropagation()}>
      <button type="button" className={s.embedPartyBtn} disabled={busy} onClick={() => void run(false)} data-testid="embed-add-party">
        <Icon name="video-television-symbolic" size={14} color="var(--th-embed-overlay-fg)" />
        Add to Media Party
      </button>
      <button type="button" className={s.embedPartyBtn} disabled={busy} onClick={() => void run(true)} aria-label="Play now in the Media Party" title="Play now in the Media Party">
        <Icon name="media-playback-start" size={14} color="var(--th-embed-overlay-fg)" />
      </button>
    </div>
  );
}

export function EmbedCard({ e, maxW, onOpenImage, roomId = "" }: { e: Embed; maxW: number; onOpenImage?: (src: string, w: number, h: number) => void; roomId?: string }) {
  const w = Math.min(maxW, 400);
  const [on, setOn] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const imgH = nat ? Math.round((w * nat.h) / Math.max(1, nat.w)) : null;
  const cardRef = useRef<HTMLDivElement>(null);
  useTip(cardRef, !on && e.mode !== "image" ? "Play" : "", { delay: 400 });
  // M9 (security review 2026-10-26; ThEmbedCard.qml imageWaits): a GIF from a host other than Giphy waits for a click —
  // nothing is fetched until then (an embed without the field waits too)
  if (e.mode === "image" && e.autoload !== true && !on) {
    return (
      <div
        className={cx(s.embed, s.embedIdle)}
        style={{ width: w, height: 160 }}
        data-embed="gif-wait"
        role="button"
        tabIndex={0}
        onClick={(ev) => {
          ev.stopPropagation();
          setOn(true);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            setOn(true);
          }
        }}
      >
        <div className={s.embedGrad} />
        <div className={cx(s.embedScrim, s.embedGifWaitScrim)} />
        <div className={s.embedGifWait}>
          <Icon name="image-x-generic" size={18} color="var(--th-embed-overlay-fg)" />
          <span>{`GIF from ${e.host || "another site"} — click to show`}</span>
        </div>
      </div>
    );
  }
  if (e.mode === "image") {
    return (
      <div className={s.embed} style={{ width: w, height: imgH == null ? 160 : Math.min(300, imgH) }}>
        {/* GPU.md §2.6: ≤ 3 loops or 15 s while focused + in view, then its first frame; a hover replays */}
        <AnimatedImage
          className={s.embedGif}
          src={e.src}
          mime="image/gif"
          alt="GIF"
          referrerPolicy="no-referrer"
          draggable={false}
          clickPlays={false}
          onReady={(w, h) => setNat({ w, h })}
          onClick={(ev) => {
            ev.stopPropagation();
            onOpenImage?.(e.src, nat?.w ?? 0, nat?.h ?? 0);
          }}
        />
      </div>
    );
  }
  const h = e.layout === "audioSm" ? 160 : e.layout === "audioLg" ? 352 : Math.round((w * 9) / 16);
  return (
    <div
      ref={cardRef}
      data-embed={e.platform}
      className={cx(s.embed, !on && s.embedIdle)}
      style={{ width: w, height: h }}
      onClick={(ev) => {
        ev.stopPropagation();
        if (!on) setOn(true);
      }}
    >
      {!on ? (
        <>
          {e.poster ? <img className={s.embedPoster} src={e.poster} alt="" referrerPolicy="no-referrer" draggable={false} /> : <div className={s.embedGrad} />}
          <div className={s.embedScrim} />
          <div className={s.embedPlay}>
            <Icon name="media-playback-start" size={22} color="var(--th-embed-overlay-fg)" />
          </div>
          <span className={s.embedChip}>{e.label}</span>
          {["youtube", "spotify", "apple", "media"].includes(e.platform) && <PartyActions roomId={roomId} url={e.url} />}
        </>
      ) : (
        <>
          {e.mode === "video" ? (
            <video className={s.embedSurface} src={e.src} autoPlay controls playsInline />
          ) : (
            <iframe
              className={s.embedSurface}
              src={e.src}
              title={e.label}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"
              allowFullScreen
              referrerPolicy="origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            />
          )}
          <div className={s.embedCtl}>
            <EmbedBtn tip="Open link" onClick={() => openExternal(e.url)}>
              ↗
            </EmbedBtn>
            <EmbedBtn tip="Dismiss" onClick={() => setOn(false)}>
              <Icon name="window-close-symbolic" size={12} color="var(--th-embed-overlay-fg)" />
            </EmbedBtn>
          </div>
        </>
      )}
    </div>
  );
}

function EmbedBtn({ tip, onClick, children }: { tip: string; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, tip, { delay: 400 });
  return (
    <button
      ref={ref}
      type="button"
      className={s.embedBtn}
      aria-label={tip}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

// ProfileCard.tsx — RightPanel.qml's profile card ("View profile" in the room member menu): 340 px,
// padding 18, radius 14, panel fill, 1 px border in the person's accent colour (else white 12 %);
// avatar 64 · name (defaultFont + 2 pt, bold) · mxid (small, dim) · accent dot 18; the bio with
// links (accentBright, open in a new tab); "Loading…" / "No profile set yet."; "Play join sound"
// (LOCAL preview only — never into a call) and "Close". A slower fetch for someone else never
// overwrites the card (keyed by mxid).
import { useEffect, useRef, useState } from "react";
import { Avatar, BasicButton, Popover, localpart, useIsMobile } from "@/ui";
import { PresenceLine } from "@/features/presence";
import { fetchMedia } from "@/core/matrix";
import { playClip, type ClipHandle } from "@/core/sounds";
import { fetchProfileCard, linkify, type ProfileCard } from "./roomActions";
import s from "./ProfileCard.module.css";

let preview: ClipHandle | null = null;

/** myinstants / relative URLs go through the same-origin clip cache (media.md clipUrlFor): Web Audio has to
 *  fetch the bytes, which a cross-origin host without CORS wouldn't give. */
function sameOriginClip(u: string): string {
  const s = u.trim();
  if (!s || (!s.startsWith("/") && !s.includes("myinstants.com/")) || s.startsWith("/api/")) return s;
  return `/api/soundboard/clip?url=${encodeURIComponent(s)}`;
}

/** Local preview of someone's join sound (never into a call), ≤ 3 s like the native cap. REACH A5.8: through
 *  the one Web Audio context (core/sounds playClip) — an <audio> element is media playback on iOS (the
 *  Dynamic Island). mxc:// → authenticated fetch. */
async function playJoinSoundLocally(url: string) {
  preview?.stop();
  preview = null;
  try {
    const src: string | Blob = url.startsWith("mxc://") ? await fetchMedia(url) : sameOriginClip(url);
    preview = await playClip(src, { channel: "preview", maxMs: 3000 });
  } catch {
    /* unplayable / blocked — nothing to show, like the native no-op */
  }
}

export function ProfileCardPopup({ mxid, name, avatar, onClose }: { roomId?: string; mxid: string; name: string; avatar: string | null; onClose: () => void }) {
  const [card, setCard] = useState<ProfileCard>({ mxid, bio: "", accent: "", joinSound: "", loading: true });
  const current = useRef(mxid);
  useEffect(() => {
    current.current = mxid;
    setCard({ mxid, bio: "", accent: "", joinSound: "", loading: true });
    void fetchProfileCard(mxid).then((c) => {
      if (current.current === c.mxid) setCard(c);
    });
  }, [mxid]);
  const shownName = name || localpart(mxid) || mxid;
  const mobile = useIsMobile();
  return (
    <Popover
      open
      onClose={onClose}
      modal
      plain
      className={mobile ? undefined : s.card}
      style={mobile ? undefined : { borderColor: card.accent || "var(--th-profile-card-border)" }}
      aria-label={`Profile of ${shownName}`}
    >
      <div className={s.col}>
        <div className={s.top}>
          <Avatar size={64} name={shownName} seed={mxid} imageSource={avatar} />
          <div className={s.names}>
            <div className={s.name}>{shownName}</div>
            {/* REACH §2.6 place 4: a line under the name, led by the dot (nothing while absent) */}
            <PresenceLine mxid={mxid} />
            <div className={s.mxid}>{mxid}</div>
          </div>
          <span className={s.fill} />
          {card.accent && <span className={s.dot} style={{ background: card.accent }} />}
        </div>
        {card.bio && <div className={s.bio} dangerouslySetInnerHTML={{ __html: linkify(card.bio) }} />}
        {card.loading && <div className={s.dim}>Loading…</div>}
        {!card.loading && !card.bio && <div className={s.dimSmall}>No profile set yet.</div>}
        <div className={s.buttons}>
          {card.joinSound && (
            <BasicButton
              text="Play join sound"
              icon="media-playback-start"
              onClick={() => void playJoinSoundLocally(card.joinSound)}
            />
          )}
          <span className={s.fill} />
          <BasicButton text="Close" onClick={onClose} />
        </div>
      </div>
    </Popover>
  );
}

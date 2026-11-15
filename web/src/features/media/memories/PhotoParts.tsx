// memories/PhotoParts.tsx — Memories photos in the window (docs/MEMORIES-PHOTOS.md §6): the photo
// card in the timeline, the photo viewer (Previous / Next, comments, Show in chat, Save, Remove), the remove dialog and
// "Add photos" (picker, paste, drop). Same words as the desktop's MemoriesWindow.qml.
import { useEffect, useRef, useState } from "react";
import { jumpToEvent, openThread, toast } from "@/core/bus";
import { peekClient, useMessageMedia } from "@/core/matrix";
import { BusyIndicator, CheckBox, Dialog, GlowButton, HeaderIconButton, Icon, cx, useIsMobile } from "@/ui";
import { redactMessage, saveMedia, sendAttachment } from "@/features/chat/actions";
import type { MediaRef } from "@/features/chat/lib/model";
import { fmtDate, fmtDateLong, shortName } from "../shared/format";
import { Pill } from "./Pill";
import { commentsFace } from "./photos";
import { MEMORIES_WORDS, addToMemories, canAddHere, iModerate, removeFromMemories, takeDown, type MemoryPhoto } from "./photosStore";
import s from "./Memories.module.css";

/** The words (the desktop uses the same). */
export const PHOTO_WORDS = {
  add: "Add photos",
  addTip: "Add photos or screenshots to this room's Memories. They're also posted in the chat.",
  unencrypted: "This room isn't encrypted: the server can see these photos.",
  sharedBy: (who: string) => `shared by ${who}`,
  comments: (n: number) => (n === 0 ? "Comment" : n === 1 ? "1 comment" : `${n} comments`),
  showInChat: "Show in chat",
  save: "Save",
  remove: "Remove from Memories",
  removeTitle: "Remove from Memories?",
  removeText: "The photo stays in the chat.",
  alsoDelete: "Also delete it from the chat",
  previous: "Previous photo",
  next: "Next photo",
  back: "Back to Memories",
  unavailable: (n: number) => `${n} ${n === 1 ? "photo" : "photos"} can't be shown on this device yet.`,
  added: "Added to Memories",
};

function mediaRefOf(p: MemoryPhoto): MediaRef {
  const c = p.content as Record<string, unknown>;
  const info = (c.info && typeof c.info === "object" ? c.info : {}) as Record<string, unknown>;
  return {
    kind: "image",
    url: typeof c.url === "string" ? c.url : undefined,
    file: c.file && typeof c.file === "object" ? (c.file as MediaRef["file"]) : undefined,
    mimetype: typeof info.mimetype === "string" ? info.mimetype : "",
    size: typeof info.size === "number" ? info.size : 0,
    w: typeof info.w === "number" ? info.w : 0,
    h: typeof info.h === "number" ? info.h : 0,
    duration: 0,
    name: typeof c.body === "string" && c.body ? c.body : "photo",
  };
}

/** The photo's own image, decrypted on this device (the thumbnail when the message carries one, for the card). */
function usePhotoUrl(p: MemoryPhoto, thumb: boolean): string | undefined {
  const c = p.content as Record<string, unknown>;
  const info = (c.info && typeof c.info === "object" ? c.info : {}) as Record<string, unknown>;
  const th = thumb && (info.thumbnail_file || info.thumbnail_url) ? { file: info.thumbnail_file as never, url: info.thumbnail_url as string | undefined, info: { mimetype: (info.thumbnail_info as { mimetype?: string } | undefined)?.mimetype } } : null;
  return useMessageMedia((th ?? { file: c.file as never, url: c.url as string | undefined, info: { mimetype: info.mimetype as string | undefined } }) as never);
}

export function PhotoCard({ p, onOpen }: { p: MemoryPhoto; onOpen: () => void }) {
  const src = usePhotoUrl(p, true);
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={s.card}
      role="button"
      tabIndex={0}
      aria-label={`Photo ${PHOTO_WORDS.sharedBy(shortName(p.owner))}, ${fmtDate(p.ts)}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={s.poster}>
        {!loaded && <span className={s.posterGlyph}>🖼</span>}
        {src && <img className={cx(s.posterImg, loaded && s.posterShown)} src={src} alt="" onLoad={() => setLoaded(true)} />}
      </div>
      <div className={s.cardText}>
        <div className={s.cardRow}>
          <span className={s.cardDate}>{fmtDate(p.ts)}</span>
          <Pill text="📷 photo" />
        </div>
        <div className={s.cardSub}>{PHOTO_WORDS.sharedBy(shortName(p.owner))}</div>
        {(commentsFace(p.event_id, p.content, p.comments).count ?? 0) > 0 && (
          <div className={s.countsRow}>
            <Pill text={`💬 ${commentsFace(p.event_id, p.content, p.comments).button}`} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The photo viewer: the image fitted to the window, Previous / Next (← / →), Esc back. */
export function PhotoViewer({ roomId, p, onBack, onStep, hasPrev, hasNext }: { roomId: string; p: MemoryPhoto; onBack: () => void; onStep: (dir: 1 | -1) => void; hasPrev: boolean; hasNext: boolean }) {
  const mobile = useIsMobile();
  const src = usePhotoUrl(p, false);
  const [confirm, setConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const me = peekClient()?.getUserId() ?? "";
  const mine = p.owner === me;
  const canRemove = mine || iModerate(roomId);
  useEffect(() => rootRef.current?.focus(), [p.event_id]);
  return (
    <div
      ref={rootRef}
      className={cx(s.root, s.photoViewer, mobile && s.mobile)}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && hasPrev) {
          e.preventDefault();
          onStep(-1);
        } else if (e.key === "ArrowRight" && hasNext) {
          e.preventDefault();
          onStep(1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onBack();
        }
      }}
    >
      <div className={s.header}>
        <HeaderIconButton iconName="go-previous-symbolic" tip={PHOTO_WORDS.back} aria-label={PHOTO_WORDS.back} onClick={onBack} />
        <div className={s.titleCol}>
          <div className={s.cardDate}>{fmtDateLong(p.ts)}</div>
          <div className={s.cardSub}>{PHOTO_WORDS.sharedBy(shortName(p.owner))}</div>
        </div>
        <span className={s.spacer} />
        <HeaderIconButton iconName="go-up-symbolic" tip={PHOTO_WORDS.previous} aria-label={PHOTO_WORDS.previous} disabled={!hasPrev} onClick={() => onStep(-1)} />
        <HeaderIconButton iconName="go-down-symbolic" tip={PHOTO_WORDS.next} aria-label={PHOTO_WORDS.next} disabled={!hasNext} onClick={() => onStep(1)} />
      </div>
      <div className={s.photoStage}>
        {src ? <img className={s.photoFull} src={src} alt={`Photo ${PHOTO_WORDS.sharedBy(shortName(p.owner))}`} /> : <BusyIndicator size={32} />}
        {hasPrev && (
          <button type="button" className={cx(s.photoNav, s.photoNavPrev)} aria-label={PHOTO_WORDS.previous} onClick={() => onStep(-1)}>
            <Icon name="go-previous-symbolic" size={24} />
          </button>
        )}
        {hasNext && (
          <button type="button" className={cx(s.photoNav, s.photoNavNext)} aria-label={PHOTO_WORDS.next} onClick={() => onStep(1)}>
            <Icon name="go-next-symbolic" size={24} />
          </button>
        )}
      </div>
      <div className={s.photoBar}>
        {/* 2-8: a photo inside a thread → that thread, no count ("Comments in thread"; memories/photos.ts commentsFace) */}
        <GlowButton text={`💬 ${commentsFace(p.event_id, p.content, p.comments).button}`} onClick={() => openThread(roomId, commentsFace(p.event_id, p.content, p.comments).root)} />
        <GlowButton text={PHOTO_WORDS.showInChat} icon="mail-reply-sender-symbolic" onClick={() => jumpToEvent(roomId, p.event_id)} />
        <GlowButton text={PHOTO_WORDS.save} icon="document-save-symbolic" onClick={() => void saveMedia(mediaRefOf(p))} />
        <span className={s.spacer} />
        {canRemove && <GlowButton text={PHOTO_WORDS.remove} icon="delete-symbolic" onClick={() => setConfirm(true)} />}
      </div>
      <RemoveDialog roomId={roomId} p={p} mine={mine} open={confirm} onClose={() => setConfirm(false)} onDone={onBack} />
    </div>
  );
}

function RemoveDialog({ roomId, p, mine, open, onClose, onDone }: { roomId: string; p: MemoryPhoto; mine: boolean; open: boolean; onClose: () => void; onDone: () => void }) {
  const [alsoDelete, setAlsoDelete] = useState(false);
  useEffect(() => {
    if (open) setAlsoDelete(false);
  }, [open]);
  const run = async () => {
    onClose();
    // R3-2 (review): the whole removal belongs to the account that started it (an account switch meanwhile stops it,
    // silently: the optional delete never runs as the next account)
    const owner = peekClient();
    try {
      if (mine) await removeFromMemories(roomId, p.event_id, owner);
      else await takeDown(roomId, p.event_id, owner);
      if (peekClient() !== owner) return;
      if (mine && alsoDelete) await redactMessage(roomId, p.event_id);
      if (peekClient() !== owner) return;
      onDone();
    } catch (e) {
      if ((e as Error)?.name !== "StaleSession" && peekClient() === owner) toast((e as Error)?.message || "Couldn't remove it");
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={PHOTO_WORDS.removeTitle}
      buttons={[
        { text: "Cancel", role: "reject", onClick: onClose },
        { text: "Remove", role: "destructive", onClick: () => void run() },
      ]}
      width={380}
    >
      <div className={s.dialogText}>{PHOTO_WORDS.removeText}</div>
      {/* only my own message: the chat lets people delete only their own */}
      {mine && <CheckBox text={PHOTO_WORDS.alsoDelete} checked={alsoDelete} onToggled={setAlsoDelete} />}
    </Dialog>
  );
}

// ---- Add photos -------------------------------------------------------------------------------------------------

/** May I add photos here (my list is writable, or I'm an admin whose app makes it writable)? */
export function mayAddPhotos(roomId: string): boolean {
  const c = peekClient();
  const me = c?.getUserId() ?? "";
  const r = c?.getRoom(roomId);
  return !!r && (canAddHere(roomId) || r.currentState.maySendStateEvent("m.room.power_levels", me));
}

/** Send `files` (images only) to the room's chat and add each to my Memories once it is sent. */
export function addPhotoFiles(roomId: string, files: File[]): number {
  const imgs = files.filter((f) => f.type.startsWith("image/") && f.type !== "image/svg+xml");
  // R3-2: the account these photos are queued for (their Memories write never runs under another)
  const owner = peekClient();
  for (const f of imgs)
    void sendAttachment(roomId, f, null, (eventId) => {
      // R3-2: bound to the account that queued the photo (a switch meanwhile drops it, silently)
      addToMemories(roomId, eventId, Date.now(), owner).then(
        () => {
          if (peekClient() === owner) toast(PHOTO_WORDS.added);
        },
        (e) => {
          if ((e as Error)?.name !== "StaleSession") toast((e as Error)?.message || MEMORIES_WORDS.forbidden);
        },
      );
    });
  return imgs.length;
}

/** Is this room unencrypted (the "Add photos" sheet says the server can see them)? */
export function roomUnencrypted(roomId: string): boolean {
  const r = peekClient()?.getRoom(roomId);
  return !!r && !r.hasEncryptionStateEvent();
}

/** The "Add photos" button: opens the picker (after the unencrypted-room line, when it applies). */
export function AddPhotosButton({ roomId, onFiles }: { roomId: string; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  if (!mayAddPhotos(roomId)) return null;
  return (
    <>
      <GlowButton text={PHOTO_WORDS.add} icon="list-add-symbolic" title={PHOTO_WORDS.addTip} onClick={() => input.current?.click()} />
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** The unencrypted-room line before sending (encrypted rooms send at once). */
export function UnencryptedConfirm({ files, onSend, onCancel }: { files: File[] | null; onSend: () => void; onCancel: () => void }) {
  return (
    <Dialog
      open={!!files}
      onClose={onCancel}
      title={PHOTO_WORDS.add}
      buttons={[
        { text: "Cancel", role: "reject", onClick: onCancel },
        { text: PHOTO_WORDS.add, role: "accept", onClick: onSend },
      ]}
      width={380}
    >
      <div className={s.dialogText}>{PHOTO_WORDS.unencrypted}</div>
    </Dialog>
  );
}

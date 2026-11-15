// MemoriesWindow.tsx — MemoriesWindow.qml: the Memories library of a room's recorded calls and the
// relive player. 864×720 (min 480×420), remembered as "memories". The window keeps ITS room.
import { useCallback, useEffect, useRef, useState } from "react";
import { openWindow } from "@/core/bus";
import { CLIP_TYPE, getStateAll, useRoomName } from "@/core/matrix";
import { loadResume, saveResume, useClips, type ResumeMap } from "./prefs";
import { Avatar, EmptyState, GlowButton, Heading, HeaderIconButton, Icon, ScrollArea, avatarSeed, cx, useIsMobile } from "@/ui";
import { fmtBytes, fmtDate, fmtDateLong, fmtTime, shortError, shortName } from "../shared/format";
import { countKinds, fetchSessions, peopleOf, posterUrl, type VodSession } from "./model";
import { lazyPart } from "@/ui/lazy";
import { Pill } from "./Pill";
import { countText, step, timeline, windowMode, type Filter } from "./photos";
import { useServerFeature } from "@/core/server";
import { refreshPhotos, useMemoryPhotos } from "./photosStore";
import { AddPhotosButton, PHOTO_WORDS, PhotoCard, PhotoViewer, UnencryptedConfirm, addPhotoFiles, mayAddPhotos, roomUnencrypted } from "./PhotoParts";
import s from "./Memories.module.css";

// web-perf 2026-11-07: the player (+ its remuxer) is its own chunk (ui/lazy.tsx), fetched after the start
const MemoriesPlayer = lazyPart("MemoriesPlayer", () => import("./MemoriesPlayer").then((m) => m.MemoriesPlayer));

// ---- the window ----------------------------------------------------------------------------------

export function MemoriesWindow({ roomId, open: openId }: { roomId: string; open?: string }) {
  const mobile = useIsMobile();
  const roomName = useRoomName(roomId);
  const [memories, setMemories] = useState<VodSession[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<VodSession | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "live" | "warn" } | null>(null);
  const [resume, setResume] = useState<ResumeMap>(() => loadResume());
  const clips = useClips(roomId);
  const loadSeq = useRef(0);
  // Memories photos (docs/MEMORIES-PHOTOS.md): the room's photos as I may see them, one timeline with the recordings
  // a server without a call recorder: photos only (no recordings fetched, no Recordings filter, no recording words)
  const recordsHere = useServerFeature("memories");
  const mode = windowMode(recordsHere);
  const [photoTick, setPhotoTick] = useState(0);
  const photos = useMemoryPhotos(roomId, photoTick);
  const [filter, setFilter] = useState<Filter>("all");
  const [selPhoto, setSelPhoto] = useState("");
  // "Add photos" in an unencrypted room waits for the line about the server: the files remember THEIR room
  const [pending, setPending] = useState<{ roomId: string; files: File[] } | null>(null);
  const items = timeline(memories ?? [], photos.photos, filter);
  const addFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/") && f.type !== "image/svg+xml");
    if (!imgs.length || !mayAddPhotos(roomId)) return;
    if (roomUnencrypted(roomId)) setPending({ roomId, files: imgs });
    else addPhotoFiles(roomId, imgs);
  };

  const refresh = useCallback(async () => {
    refreshPhotos(roomId);
    setPhotoTick((t) => t + 1);
    const seq = ++loadSeq.current;
    if (!recordsHere) {
      setMemories([]);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    const cap = window.setTimeout(() => seq === loadSeq.current && setLoading(false), 8000);
    try {
      const list = await fetchSessions(roomId);
      if (seq !== loadSeq.current) return;
      setMemories(list);
      setError("");
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // a failed refresh keeps whatever list we already have
      setError(shortError(e));
    } finally {
      window.clearTimeout(cap);
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [roomId, recordsHere]);

  // the window's room changed: back to the list and reload
  useEffect(() => {
    setSel(null);
    setSelPhoto("");
    setPending(null);
    setMemories(null);
    setError("");
    void refresh();
  }, [roomId, refresh]);

  // window title: "Memories 📼" / "<date> · <room> · Memories — Tin Hat"
  useEffect(() => {
    const title = sel ? `${fmtDate(sel.start_ms)}${sel.room_name || roomName ? ` · ${sel.room_name || roomName}` : ""} · Memories — Tin Hat` : "Memories 📼";
    const el = document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Memories"], [role="dialog"][data-mem-title]');
    void el;
    setWindowTitle(title);
  }, [sel, roomName]);

  // auto-refresh every 20 s while any card is live / processing and the list is showing
  const anyPending = !sel && !!memories?.some((m) => !m.end_ms || (m.ready === false && !m.empty));
  useEffect(() => {
    if (!anyPending) return;
    const t = window.setInterval(() => void refresh(), 20000);
    return () => window.clearInterval(t);
  }, [anyPending, refresh]);

  // notices clear after 6 s
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // gate hook: open=<id|latest>
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !openId || !memories?.length) return;
    opened.current = true;
    const m = openId === "latest" ? memories.find((x) => x.end_ms && x.ready !== false && !x.empty) : memories.find((x) => x.id === openId);
    if (m) setSel(m);
  }, [openId, memories]);

  const tryOpen = (m: VodSession) => {
    if (!m.end_ms) {
      setNotice({ kind: "live", text: "This call is still being recorded — come back after it ends to relive it." });
      return;
    }
    if (m.empty) {
      setNotice({ kind: "warn", text: "Nothing was captured in this session (nobody had a stream or mic on)." });
      return;
    }
    if (m.ready === false) {
      const mins = m.end_ms ? Math.round((Date.now() - Number(m.end_ms)) / 60000) : 0;
      setNotice({
        kind: "warn",
        text:
          mins > 10
            ? `This memory has been processing for ${mins} minutes — the recorder probably failed on it. It stays listed, and the server's owner can check the recorder's log.`
            : "This memory is still processing (building lipsync and the timeline). It'll be ready in a moment.",
      });
      return;
    }
    setNotice(null);
    setSel(m);
  };

  if (sel) {
    return (
      <MemoriesPlayer
        key={sel.id}
        roomId={roomId}
        roomName={roomName}
        session={sel}
        clips={clips}
        resumeAt={resume[sel.id] ?? 0}
        onBack={(pos, dur) => {
          if (pos > 5 && pos < dur - 5) {
            const next = { ...resume, [sel.id]: pos };
            setResume(next);
            saveResume(next);
          }
          setSel(null);
          void refresh();
        }}
      />
    );
  }

  const viewing = selPhoto ? photos.photos.find((p) => p.event_id === selPhoto) : undefined;
  if (viewing) {
    const prev = step(items, viewing.event_id, -1);
    const next = step(items, viewing.event_id, 1);
    return (
      <PhotoViewer
        key={viewing.event_id}
        roomId={roomId}
        p={viewing}
        hasPrev={!!prev}
        hasNext={!!next}
        onStep={(d) => {
          const to = d === 1 ? next : prev;
          if (to) setSelPhoto(to);
        }}
        onBack={() => setSelPhoto("")}
      />
    );
  }

  const n = memories?.length ?? 0;
  const np = photos.photos.length;
  const shownCount = items.length;
  const photoById = new Map(photos.photos.map((p) => [p.event_id, p]));
  const recIncluded = mode.recordings && filter !== "photos";
  const recFailed = memories === null && !!error;
  const recLoading = !recFailed && (memories === null || (loading && n === 0));
  const recById = new Map((memories ?? []).map((m) => [m.id, m]));
  return (
    <div
      className={cx(s.root, mobile && s.mobile)}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.some((f) => f.type.startsWith("image/"))) {
          e.preventDefault();
          addFiles(files);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      <div className={s.header}>
        <div className={s.titleCol}>
          <Heading level={1} className={s.heading}>
            Memories
          </Heading>
          <div className={s.subtitle}>{`${roomName ? `${roomName} · ` : ""}${n + np === 0 ? mode.subtitle_empty : countText(n, np)}`}</div>
        </div>
        <span className={s.spacer} />
        {mode.filters.length > 0 && (
          <div className={s.filterRow} role="group" aria-label="Show">
            {mode.filters.map((f) => (
              <button key={f} type="button" className={cx(s.filterBtn, filter === f && s.filterOn)} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "recordings" ? "Recordings" : "Photos"}
              </button>
            ))}
          </div>
        )}
        <AddPhotosButton roomId={roomId} onFiles={addFiles} />
        <HeaderIconButton iconName="view-refresh-symbolic" tip="Refresh the list" onClick={() => void refresh()} />
      </div>
      <UnencryptedConfirm
        files={pending && pending.roomId === roomId ? pending.files : null}
        onCancel={() => setPending(null)}
        onSend={() => {
          if (pending && pending.roomId === roomId) addPhotoFiles(pending.roomId, pending.files);
          setPending(null);
        }}
      />
      {notice && (
        <div className={cx(s.notice, notice.kind === "live" && s.noticeLive, notice.kind === "warn" && s.noticeWarn)}>
          {`${notice.kind === "live" ? "🔴 " : notice.kind === "warn" ? "⏳ " : ""}${notice.text}`}
        </div>
      )}
      <ScrollArea className={s.library} contentClassName={s.libraryScroll}>
        <div className={s.libCol}>
          {shownCount === 0 && recIncluded && recFailed ? (
            <div className={s.stateBox}>
              <EmptyState
                iconName="network-disconnect-symbolic"
                title="Couldn't load memories"
                explanation={`The recordings server didn't answer (${error}). Your list is safe — try again in a moment.`}
              />
              <GlowButton className={s.tryAgain} text="Try again" icon="view-refresh-symbolic" onClick={() => void refresh()} />
            </div>
          ) : shownCount === 0 && ((recIncluded && recLoading) || (filter !== "recordings" && photos.loading)) ? (
            <div className={s.stateBox}>
              <EmptyState loading title="Loading memories…" />
            </div>
          ) : shownCount === 0 ? (
            <div className={s.stateBox}>
              {filter === "photos" ? (
                <EmptyState
                  iconName="image-x-generic"
                  title={photos.loading ? "Loading photos…" : mode.photos_empty_title}
                  loading={photos.loading}
                  explanation={mode.photos_empty_text}
                />
              ) : (
                <EmptyState
                  iconName={mode.recordings ? "camera-video-symbolic" : "image-x-generic"}
                  title={mode.empty_title}
                  explanation={mode.empty_text}
                />
              )}
            </div>
          ) : (
            items.map((it, i) => {
              const day = dayLabel(it.at);
              const head = i === 0 || dayLabel(items[i - 1].at) !== day;
              const rec = it.kind === "recording" ? recById.get(it.id) : undefined;
              const ph = it.kind === "photo" ? photoById.get(it.id) : undefined;
              return (
                <div key={`${it.kind}:${it.id}`} className={s.itemCol}>
                  {head && <div className={s.dayHead}>{day}</div>}
                  {rec && <SessionCard m={rec} index={i} resumeAt={resume[rec.id] ?? 0} onOpen={() => tryOpen(rec)} />}
                  {ph && <PhotoCard p={ph} onOpen={() => setSelPhoto(ph.event_id)} />}
                </div>
              );
            })
          )}
          {photos.unavailable > 0 && filter !== "recordings" && <div className={s.footNote}>{PHOTO_WORDS.unavailable(photos.unavailable)}</div>}
        </div>
      </ScrollArea>
    </div>
  );
}

/** A day heading: "Today", "Yesterday", else "Saturday, November 14" (+ ", 2025" in another year; the desktop says the
 *  same). */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const t = new Date(now);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(t) - midnight(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const long = fmtDateLong(ms);
  const cut = long.lastIndexOf(" · ");
  const base = cut > 0 ? long.slice(0, cut) : long;
  return d.getFullYear() === t.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

// title plumbing: the WindowHost reads the registry title function with the window props; we keep
// the current title in a module variable and re-render the host via openWindow(props) (raises too).
let currentTitle = "Memories 📼";
let lastProps: Record<string, unknown> = {};
export function memoriesTitle(props: Record<string, unknown>): string {
  lastProps = props;
  return (props._title as string) || currentTitle;
}
function setWindowTitle(t: string) {
  if (t === currentTitle) return;
  currentTitle = t;
  openWindow("memories", { ...lastProps, _title: t });
}

function SessionCard({ m, index, resumeAt, onOpen }: { m: VodSession; index: number; resumeAt: number; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const live = !m.end_ms;
  const processing = !live && m.ready === false && !m.empty;
  const stuck = processing && !!m.end_ms && Date.now() - Number(m.end_ms) > 10 * 60000;
  const openable = !live && !m.empty && m.ready !== false;
  const people = peopleOf(m);
  const kinds = countKinds(m);
  const dur = m.end_ms && m.start_ms ? Math.max(1, (Number(m.end_ms) - Number(m.start_ms)) / 1000) : 0;
  const poster = usePoster(m, index);
  // GPU.md §2.2: the "● LIVE" pill is static (it blinked every 1.2 s while recording)
  const glyph = live ? "🔴" : m.empty ? "∅" : processing ? "⏳" : "📼";
  const names = people.slice(0, 3).map(shortName);
  if (people.length > 3) names.push(`+${people.length - 3} more`);
  return (
    <div
      className={cx(s.card, m.empty && s.cardEmpty)}
      role="button"
      tabIndex={0}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={s.poster}>
        {!poster.loaded && <span className={s.posterGlyph}>{glyph}</span>}
        {poster.src && <img className={cx(s.posterImg, poster.loaded && s.posterShown)} src={poster.src} alt="" onLoad={poster.onLoad} onError={poster.onError} />}
        {dur > 0 && !m.empty && (
          <span className={s.durPill}>
            <Pill text={fmtTime(dur)} fg="var(--th-memories-card-duration-fg)" bg="var(--th-memories-card-duration-bg)" bold />
          </span>
        )}
      </div>
      <div className={s.cardText}>
        <div className={s.cardRow}>
          <span className={s.cardDate}>{fmtDate(Number(m.start_ms))}</span>
          {live && <Pill text="● LIVE" fg="var(--th-memories-card-live-fg)" bg="var(--th-memories-card-live-bg)" bold />}
          {processing && (
            <Pill
              text={stuck ? "⏳ Processing — stuck?" : "⏳ Processing"}
              fg={stuck ? "var(--th-memories-card-processing-fg-error)" : "var(--th-memories-card-processing-fg)"}
              bg={stuck ? "var(--th-memories-card-processing-bg-error)" : "var(--th-memories-card-processing-bg)"}
            />
          )}
          {m.empty && <Pill text="nothing captured" />}
        </div>
        <div className={s.cardSub}>{`${m.room_name ? `${m.room_name} · ` : ""}started by ${shortName(m.started_by ?? "")}`}</div>
        {people.length > 0 && (
          <div className={s.peopleRow}>
            <span className={s.avatars}>
              {people.slice(0, 5).map((p) => (
                <Avatar key={p} name={shortName(p)} seed={avatarSeed(p)} size={22} className={s.stackAvatar} />
              ))}
            </span>
            <span className={s.cardSub}>{names.join(", ")}</span>
          </div>
        )}
        <div className={s.countsRow}>
          {kinds.streams > 0 && <Pill text={`🖥 ${kinds.streams} ${kinds.streams === 1 ? "stream" : "streams"}`} />}
          {kinds.cams > 0 && <Pill text={`📷 ${kinds.cams} ${kinds.cams === 1 ? "camera" : "cameras"}`} />}
          {kinds.voices > 0 && <Pill text={`🎙 ${kinds.voices} ${kinds.voices === 1 ? "voice" : "voices"}`} />}
          {Number(m.bytes ?? 0) > 0 && <Pill text={fmtBytes(Number(m.bytes))} />}
          <span className={s.spacer} />
          {openable && resumeAt > 5 && <span className={s.resume}>{`resume at ${fmtTime(resumeAt)}`}</span>}
        </div>
      </div>
      {openable && <Icon name="media-playback-start-symbolic" size={32} color={hover ? "var(--th-memories-card-icon-hover)" : "var(--th-memories-card-icon)"} className={s.cardPlay} />}
    </div>
  );
}

/** Staggered poster fetch (250 + 350·i ms), retry ×3 after 2500 + 300·i ms with &r=n, fade-in 180 ms. */
function usePoster(m: VodSession, index: number) {
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState("");
  const [loaded, setLoaded] = useState(false);
  const url = posterUrl(m, attempt);
  useEffect(() => {
    if (!url) return;
    const t = window.setTimeout(() => setSrc(url), attempt === 0 ? 250 + 350 * index : 0);
    return () => window.clearTimeout(t);
  }, [url, attempt, index]);
  return {
    src,
    loaded,
    onLoad: () => setLoaded(true),
    onError: () => {
      if (attempt >= 3) return;
      window.setTimeout(() => setAttempt((a) => a + 1), 2500 + 300 * index);
    },
  };
}

/** Open (or raise) the Memories window for `roomId` (native: fetches sessions + clips on open). */
export function openMemoriesWindow(roomId: string, open?: string): void {
  // re-read clips now (native re-reads on open)
  void getStateAll(roomId, CLIP_TYPE);
  currentTitle = "Memories 📼";
  openWindow("memories", { roomId, ...(open ? { open } : {}) });
}

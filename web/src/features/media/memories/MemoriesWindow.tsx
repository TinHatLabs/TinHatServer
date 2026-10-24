// MemoriesWindow.tsx — MemoriesWindow.qml: the Memories library of a room's recorded calls and the
// relive player. 864×720 (min 480×420), remembered as "memories". The window keeps ITS room.
import { useCallback, useEffect, useRef, useState } from "react";
import { openWindow } from "@/core/bus";
import { CLIP_TYPE, getStateAll, useRoomName } from "@/core/matrix";
import { loadResume, saveResume, useClips, type ResumeMap } from "./prefs";
import { Avatar, EmptyState, GlowButton, Heading, HeaderIconButton, Icon, ScrollArea, avatarSeed, cx, useIsMobile } from "@/ui";
import { fmtBytes, fmtDate, fmtTime, shortError, shortName } from "../shared/format";
import { countKinds, fetchSessions, peopleOf, posterUrl, type VodSession } from "./model";
import { MemoriesPlayer } from "./MemoriesPlayer";
import { Pill } from "./Pill";
import s from "./Memories.module.css";

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

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
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
  }, [roomId]);

  // the window's room changed: back to the list and reload
  useEffect(() => {
    setSel(null);
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

  const n = memories?.length ?? 0;
  return (
    <div className={cx(s.root, mobile && s.mobile)}>
      <div className={s.header}>
        <div className={s.titleCol}>
          <Heading level={1} className={s.heading}>
            Memories
          </Heading>
          <div className={s.subtitle}>{`${roomName ? `${roomName} · ` : ""}${n === 0 ? "recordings of this room's calls" : `${n} ${n === 1 ? "memory" : "memories"}`}`}</div>
        </div>
        <span className={s.spacer} />
        <HeaderIconButton iconName="view-refresh-symbolic" tip="Refresh the list" onClick={() => void refresh()} />
      </div>
      {notice && (
        <div className={cx(s.notice, notice.kind === "live" && s.noticeLive, notice.kind === "warn" && s.noticeWarn)}>
          {`${notice.kind === "live" ? "🔴 " : notice.kind === "warn" ? "⏳ " : ""}${notice.text}`}
        </div>
      )}
      <ScrollArea className={s.library} contentClassName={s.libraryScroll}>
        <div className={s.libCol}>
          {memories === null && error ? (
            <div className={s.stateBox}>
              <EmptyState
                iconName="network-disconnect-symbolic"
                title="Couldn't load memories"
                explanation={`The recordings server didn't answer (${error}). Your list is safe — try again in a moment.`}
              />
              <GlowButton className={s.tryAgain} text="Try again" icon="view-refresh-symbolic" onClick={() => void refresh()} />
            </div>
          ) : memories === null || (loading && n === 0) ? (
            <div className={s.stateBox}>
              <EmptyState loading title="Loading memories…" />
            </div>
          ) : n === 0 ? (
            <div className={s.stateBox}>
              <EmptyState
                iconName="camera-video-symbolic"
                title="No memories here yet"
                explanation="Press ⏺ Rec in a call and every stream and voice is saved for reliving later — with 🔖 Clip to bookmark the good bits."
              />
            </div>
          ) : (
            memories.map((m, i) => <SessionCard key={m.id} m={m} index={i} resumeAt={resume[m.id] ?? 0} onOpen={() => tryOpen(m)} />)
          )}
        </div>
      </ScrollArea>
    </div>
  );
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

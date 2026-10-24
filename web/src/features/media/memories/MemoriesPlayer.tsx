// MemoriesPlayer.tsx — the relive player of MemoriesWindow.qml (stage + side rail + transport +
// points of view + clips + sync with the call). Native = two mpv surfaces + GStreamer side tiles;
// web = plain media elements (Chromium plays the recorder's H.264/Opus Matroska files):
//   stage   <video> on the focused POV's combined file (video + aligned mixed audio = lipsync) —
//           older sessions without one: <video muted> on the track + <audio> on mixed_url aligned
//   audio   <audio> on mixed_url = the clock while no video is focused / the focused POV hasn't
//           started yet (P4 "joins later" veil)
//   tiles   5 live <video muted> + 3 snapshot-only (thumbnail) slots, sticky slot assignment
// Timing constants are the native ones (250 ms tick, 10 s load timeout, 3 s wait watchdog,
// 1.2 s shared-seek throttle, 2 s follower tolerance, 60 s stale clock, 0.75 s tile drift, …).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BasicButton, Avatar, Button, GlowButton, Heading, HeaderIconButton, Icon, Slider, cx, useIsMobile, useTip } from "@/ui";
import { useCallAny, isInCall } from "../shared/call";
import { sameOrigin } from "../shared/clip";
import { fmtDateLong, fmtTime, shortName, userIdOf } from "../shared/format";
import { leaveParty, onDesiredSeek, pause as wpPause, play as wpPlay, reportPosition, seek as wpSeek, syncStartMemory, useWatchParty } from "../watchparty/engine";
import {
  assignSlots as computeSlots,
  earliestVideo,
  kindGlyph,
  peopleOf,
  povDescr,
  povGroupsOf,
  railOrderedFiles,
  railRank,
  thumbUrl,
  trackEnd,
  trackOffset,
  videoTracksOf,
  type Pov,
  type PovGroup,
  type VodSession,
  type VodTrack,
} from "./model";
import { loadResume, loadVolume, saveResume, saveVolume, type Clip } from "./prefs";
import { Pill } from "./Pill";
import { canRemux, setRecordingSource, wantRemux } from "./remux";
import s from "./Memories.module.css";

export interface MemoriesPlayerProps {
  roomId: string;
  roomName: string;
  session: VodSession;
  clips: Clip[];
  resumeAt: number;
  onBack: (pos: number, dur: number) => void;
}

const LIVE_SLOTS = 5;

/** Can this browser play the recorder's Matroska files? (Chromium: yes; Firefox/Safari: usually not — D17) */
export function canPlayRecordings(): boolean {
  try {
    const v = document.createElement("video");
    return v.canPlayType('video/x-matroska; codecs="avc1.42E01E, opus"') !== "" || v.canPlayType("video/x-matroska") !== "";
  } catch {
    return false;
  }
}
const memDebug = typeof location !== "undefined" && /[?&#](memdebug|tinhat-mem-debug)=?1?/.test(location.search + location.hash);

/** A media element's duration if known (> 0). */
function durOf(el: HTMLMediaElement | null): number {
  if (!el) return 0;
  const d = el.duration;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function MemoriesPlayer({ roomId, roomName, session, clips, resumeAt, onBack }: MemoriesPlayerProps) {
  const mobile = useIsMobile();
  const inCall = useCallAny((c) => isInCall(c));
  const wpInParty = useWatchParty((w) => w.inParty);
  const wpUrl = useWatchParty((w) => w.playback?.url ?? "");

  // ---- derived session facts -------------------------------------------------------------------
  const vts = useMemo(() => videoTracksOf(session), [session]);
  const groups = useMemo(() => povGroupsOf(session), [session]);
  const { audioUrl, audioOffset } = useMemo(() => {
    let minA = -1;
    let first = "";
    for (const t of session.tracks) {
      if (t.kind === "audio" && (minA < 0 || Number(t.start_ms) < minA)) {
        minA = Number(t.start_ms);
        first = t.url;
      }
    }
    const url = session.mixed_url || first;
    return { audioUrl: url ? sameOrigin(url) : "", audioOffset: url && minA >= 0 && session.start_ms ? Math.max(0, (minA - Number(session.start_ms)) / 1000) : 0 };
  }, [session]);
  const [audioDur, setAudioDur] = useState(0);
  const durSecs = session.end_ms && session.start_ms ? Math.max(1, (Number(session.end_ms) - Number(session.start_ms)) / 1000) : Math.max(1, audioDur + audioOffset);
  const memUrl = `tinhat-memory://${roomId}/${session.id}`;
  const synced = inCall && wpInParty && wpUrl === memUrl;

  // ---- React state (what renders) ---------------------------------------------------------------
  const [focusedFile, setFocusedFileState] = useState<string>(() => earliestVideo(session.tracks)?.file ?? "");
  const [playing, setPlayingState] = useState(false);
  const [g, setG] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const [hidden, setHidden] = useState<Record<string, true>>({});
  const [slots, setSlots] = useState<string[]>(["", "", "", "", "", "", "", ""]);
  const [railOrder, setRailOrder] = useState<string[]>([]);
  const [toast, setToastText] = useState("");
  const [flash, setFlash] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const [theater, setTheater] = useState(false);
  const [chromeIdle, setChromeIdle] = useState(false);
  const [vol, setVol] = useState(() => loadVolume());
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [decoderBroken, setDecoderBroken] = useState(false);
  const [resyncSeq, setResyncSeq] = useState(0);
  const mkvOk = useMemo(() => canPlayRecordings(), []);
  // Firefox / Safari (and ?remux=1): the stage + voices are remuxed to fMP4 in the page (D17); side
  // tiles then run on snapshots to keep the download load bounded
  const remux = useMemo(() => wantRemux(), []);
  const playable = mkvOk || canRemux();
  const liveTiles = mkvOk && !remux;
  const onRemuxError = (msg: string) => {
    dbg(`remux: ${msg}`);
    showToast("Couldn't load this stream — try another point of view");
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transportHover = useRef(false);

  // ---- the controller (mutable, read by timers/handlers) ----------------------------------------
  const m = useRef({
    focusedFile,
    playing: false,
    g: 0,
    atEnd: false,
    userChoseAudioOnly: false,
    hidden: {} as Record<string, true>,
    slots: ["", "", "", "", "", "", "", ""] as string[],
    slotHint: {} as Record<string, number>,
    railSig: "",
    mainLoaded: "",
    audLoaded: "",
    loadPending: false,
    loadTarget: "",
    loadTicks: 0,
    pendingSeek: -1,
    audioLoadPending: false,
    audioPendingSeek: -1,
    lastMainSeekPos: -1,
    lastMainSeekAt: 0,
    waitLastG: -1,
    waitStall: 0,
    lastSyncSeekAt: 0,
    prevWaiting: false,
    lastSeekAt: 0,
    /** per file: the earliest session time its file can really show (first keyframe) */
    floorG: {} as Record<string, number>,
    vol,
    synced,
    playReqAt: 0,
    toastTimer: 0,
  }).current;
  m.synced = synced;
  m.vol = vol;

  const trackByFile = useCallback((f: string): VodTrack | null => vts.find((t) => t.file === f) ?? null, [vts]);
  const focusedTrack = trackByFile(focusedFile);
  const focusedOffset = trackOffset(session, focusedTrack);
  const focusWaitingNow = (gg: number, f = m.focusedFile) => {
    const t = trackByFile(f);
    return !!t && audioUrl.length > 0 && gg < trackOffset(session, t) - 0.3;
  };
  const extMode = (f = m.focusedFile) => {
    const t = trackByFile(f);
    return !!t && !t.combined_url && audioUrl.length > 0;
  };

  const showToast = useCallback(
    (t: string) => {
      setToastText(t);
      window.clearTimeout(m.toastTimer);
      m.toastTimer = window.setTimeout(() => setToastText(""), 3200);
    },
    [m],
  );
  const dbg = (msg: string) => {
    if (memDebug) console.log(`[memories] ${msg}`);
  };

  // ---- surfaces --------------------------------------------------------------------------------
  const applyVolume = () => {
    const v = videoRef.current;
    const a = audioRef.current;
    const level = Math.max(0, Math.min(1, m.vol.volume / 100));
    if (v) {
      v.volume = level;
      v.muted = m.vol.muted || extMode();
    }
    if (a) {
      a.volume = level;
      a.muted = m.vol.muted;
    }
  };

  const tryPlay = (el: HTMLMediaElement | null) => {
    if (!el || !el.getAttribute("src")) return;
    m.playReqAt = Date.now();
    el.play().then(
      () => setBlocked(false),
      (e: DOMException) => {
        if (e?.name === "NotAllowedError") setBlocked(true);
      },
    );
  };

  const setPlaying = (on: boolean) => {
    if (on !== m.playing) dbg(`${on ? "play" : "pause"} at g=${m.g.toFixed(2)}`);
    m.playing = on;
    setPlayingState(on);
    const v = videoRef.current;
    const a = audioRef.current;
    const waiting = focusWaitingNow(m.g);
    if (v) {
      if (!on || waiting || !trackByFile(m.focusedFile)) v.pause();
      else tryPlay(v);
    }
    if (a) {
      if (!on || !a.getAttribute("src")) a.pause();
      else tryPlay(a);
    }
  };

  // Audio surface: the clock when no video is focused OR the focused POV hasn't started yet; also
  // the external audio of a combined-less POV (follower of the video).
  const applyAud = () => {
    const a = audioRef.current;
    if (!a) return;
    const f = m.focusedFile;
    const want = (!trackByFile(f) || focusWaitingNow(m.g, f) || extMode(f)) && audioUrl ? audioUrl : "";
    if (want === m.audLoaded) return;
    m.audLoaded = want;
    if (want) {
      setRecordingSource(a, want, onRemuxError);
      applyVolume();
      if (m.playing) tryPlay(a);
    } else setRecordingSource(a, "");
  };

  const applyMain = () => {
    const v = videoRef.current;
    if (!v) return;
    const t = trackByFile(m.focusedFile);
    const url = t ? sameOrigin(t.combined_url || t.url) : "";
    if (url === m.mainLoaded) {
      applyAud();
      return;
    }
    m.mainLoaded = url;
    if (url) {
      setRecordingSource(v, url, onRemuxError);
      applyVolume();
      m.loadPending = true;
      m.loadTicks = 0;
      m.loadTarget = url;
      if (m.playing && !focusWaitingNow(m.g)) tryPlay(v);
      else v.pause();
    } else {
      setRecordingSource(v, "");
      m.loadPending = false;
      m.loadTarget = "";
    }
    applyAud();
  };

  const seekMain = (pos: number) => {
    const v = videoRef.current;
    if (!v) return;
    const now = Date.now();
    if (Math.abs(pos - m.lastMainSeekPos) < 0.05 && now - m.lastMainSeekAt < 400) return;
    if (Math.abs(v.currentTime - pos) < 0.05 && !v.seeking && m.lastMainSeekPos >= 0) return;
    m.lastMainSeekPos = pos;
    m.lastMainSeekAt = now;
    m.lastSeekAt = now;
    v.currentTime = pos;
    const a = audioRef.current;
    if (a && extMode() && durOf(a) > 0) a.currentTime = Math.max(0, pos + trackOffset(session, trackByFile(m.focusedFile)) - audioOffset);
  };

  const masterPos = (): number => {
    if (m.loadPending) return -1;
    const t = trackByFile(m.focusedFile);
    const useAudio = !t || focusWaitingNow(m.g);
    const el = useAudio ? audioRef.current : videoRef.current;
    if (!el || !el.getAttribute("src") || el.readyState < 1) return -1;
    const off = useAudio ? audioOffset : trackOffset(session, t);
    const tp = el.currentTime;
    return Number.isFinite(tp) ? tp + off : -1;
  };

  // the first moment anything was captured (the recorder joins a few seconds before any stream
  // lands): seeks never land in that dead pre-roll, where no surface has a clock to follow
  const contentStart = useMemo(() => {
    let st = Infinity;
    for (const t of vts) st = Math.min(st, trackOffset(session, t));
    if (audioUrl) st = Math.min(st, audioOffset);
    return Number.isFinite(st) ? st : 0;
  }, [vts, session, audioUrl, audioOffset]);

  const seekMaster = (gg: number) => {
    const asked = gg;
    gg = Math.max(contentStart, Math.min(gg, durSecs));
    // waiting for a POV while the voices haven't started either: skip the dead air
    const ft = trackByFile(m.focusedFile);
    if (ft && audioUrl && gg < trackOffset(session, ft) - 0.3 && gg < audioOffset) gg = Math.min(trackOffset(session, ft), audioOffset);
    if (asked !== gg) dbg(`seek ${asked.toFixed(2)} clamped to ${gg.toFixed(2)}`);
    m.g = gg;
    setG(gg);
    if (m.atEnd && gg < durSecs - 1) m.playing = true;
    m.atEnd = false;
    setAtEnd(false);
    if (m.loadPending) {
      m.pendingSeek = gg;
      return;
    }
    const t = trackByFile(m.focusedFile);
    if (t && !focusWaitingNow(gg)) {
      if (durOf(videoRef.current) > 0) seekMain(Math.max(0, gg - trackOffset(session, t)));
    } else {
      const a = audioRef.current;
      if (a && durOf(a) > 0) a.currentTime = Math.max(0, gg - audioOffset);
      else {
        m.audioPendingSeek = gg;
        m.audioLoadPending = true;
      }
      if (t && videoRef.current) {
        // P4: hold the not-yet-started video at its first frame
        videoRef.current.pause();
        if (durOf(videoRef.current) > 0) videoRef.current.currentTime = 0;
      }
    }
    queueMicrotask(() => setPlaying(m.playing));
  };

  const sideResync = () => setResyncSeq((n) => n + 1);

  // ---- rail ------------------------------------------------------------------------------------
  const sideTracks = useMemo(() => vts.filter((t) => t.file !== focusedFile && !hidden[t.file]), [vts, focusedFile, hidden]);
  const sideRef = useRef(sideTracks);
  sideRef.current = sideTracks;

  const assignRail = () => {
    const side = sideRef.current;
    const order = railOrderedFiles(session, side, m.g);
    const next = computeSlots(m.slots, order, m.slotHint, (f) => railRank(session, trackByFile(f), m.g));
    m.slotHint = {};
    m.slots = next;
    setSlots(next);
    setRailOrder(order);
  };
  // membership changes (focus / hide) re-assign at once
  useEffect(() => {
    m.railSig = "";
    assignRail();
  }, [sideTracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- focus / hide ----------------------------------------------------------------------------
  const focusTrack = (f: string) => {
    if (m.focusedFile === f) return;
    const gg = m.g;
    dbg(`focus -> ${f || "audio-only"} at g=${gg.toFixed(2)}`);
    m.atEnd = false;
    setAtEnd(false);
    m.userChoseAudioOnly = f === "";
    const vacated = m.slots.indexOf(f);
    m.slotHint = m.focusedFile && vacated >= 0 ? { [m.focusedFile]: vacated } : {};
    m.focusedFile = f;
    setFocusedFileState(f);
    const nt = trackByFile(f);
    setFlash((x) => ({ text: nt ? `▶ ${povDescr(groups, nt)} on stage` : "🎧 voices only", n: x.n + 1 }));
    m.prevWaiting = focusWaitingNow(gg, f);
    if (nt && !m.prevWaiting) {
      m.pendingSeek = gg;
      applyMain();
    } else {
      m.audioPendingSeek = gg;
      m.audioLoadPending = true;
      m.audLoaded = "";
      m.pendingSeek = -1;
      applyMain();
      if (nt) showToast(`${kindGlyph(nt.kind)} ${shortName(nt.identity)} joins at ${fmtTime(trackOffset(session, nt))} — the replay keeps going until then`);
    }
  };

  const toggleHidden = (f: string) => {
    const h = { ...m.hidden };
    if (h[f]) delete h[f];
    else h[f] = true;
    m.hidden = h;
    setHidden(h);
    if (h[f] && m.focusedFile === f) {
      const next = vts.find((t) => t.file !== f && !h[t.file]);
      focusTrack(next?.file ?? "");
    }
  };

  // ---- transport actions -------------------------------------------------------------------------
  const togglePlay = () => {
    if (m.synced) {
      if (m.playing) wpPause();
      else wpPlay();
      return;
    }
    if (m.atEnd) {
      m.atEnd = false;
      setAtEnd(false);
      if (m.g >= durSecs - 1.5) seekMaster(0);
      setPlaying(true);
      return;
    }
    setPlaying(!m.playing);
  };
  const commitSeek = (gg: number) => {
    dbg(`seek -> ${gg.toFixed(2)} (from ${m.g.toFixed(2)})`);
    if (m.synced) {
      m.lastSyncSeekAt = Date.now();
      reportPosition(gg);
      wpSeek(gg);
    }
    seekMaster(gg);
    sideResync();
  };
  const userSeek = (gg: number) => {
    seekMaster(gg);
    const now = Date.now();
    if (m.synced && now - m.lastSyncSeekAt > 1200) {
      m.lastSyncSeekAt = now;
      wpSeek(gg);
    }
  };
  const skipBy = (d: number) => {
    const to = Math.max(0, Math.min(durSecs, m.g + d));
    commitSeek(to);
    showToast(`${d < 0 ? "⏪ " : "⏩ "}${fmtTime(to)}`);
  };
  const setVolume = (volume: number, muted: boolean) => {
    const next = { volume, muted };
    m.vol = next;
    setVol(next);
    saveVolume(volume, muted);
    applyVolume();
  };

  const toggleTheater = () => {
    const win = (rootRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? rootRef.current;
    if (!win) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void win.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const on = () => {
      const fs = !!document.fullscreenElement && !!rootRef.current && document.fullscreenElement.contains(rootRef.current);
      setTheater(fs);
      setChromeIdle(false);
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  // theater: transport fades 2.5 s after the pointer stops (not while hovering it)
  const idleTimer = useRef(0);
  const touchChrome = () => {
    setChromeIdle(false);
    window.clearTimeout(idleTimer.current);
    if (!theater) return;
    idleTimer.current = window.setTimeout(() => {
      if (!transportHover.current) setChromeIdle(true);
    }, 2500);
  };
  useEffect(() => {
    touchChrome();
    return () => window.clearTimeout(idleTimer.current);
  }, [theater]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => {
    leftVia.current = true;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (m.synced) leaveParty();
    videoRef.current?.pause();
    audioRef.current?.pause();
    onBack(m.g, durSecs);
  };
  const backRef = useRef(back);
  backRef.current = back;

  // ---- open the session (once) ---------------------------------------------------------------------
  useEffect(() => {
    const first = earliestVideo(session.tracks);
    m.focusedFile = first?.file ?? "";
    m.userChoseAudioOnly = false;
    const off = first ? trackOffset(session, first) : 0;
    m.g = first && off > 0.3 ? off : 0;
    setG(m.g);
    m.prevWaiting = focusWaitingNow(m.g);
    m.mainLoaded = "";
    m.audLoaded = "";
    dbg(`open id=${session.id} vts=${vts.length} focused=${m.focusedFile || "audio-only"} at=${m.g.toFixed(1)} dur=${durSecs.toFixed(1)}`);
    if (first) m.pendingSeek = m.g;
    else {
      m.audioPendingSeek = m.g;
      m.audioLoadPending = true;
    }
    applyMain();
    assignRail();
    const r = Number(resumeAt || 0);
    if (r > 5 && r < durSecs - 5) {
      if (first) m.pendingSeek = r;
      else {
        m.audioPendingSeek = r;
        m.audioLoadPending = true;
      }
      showToast(`Resumed from ${fmtTime(r)}`);
    }
    setPlaying(true);
    rootRef.current?.focus({ preventScroll: true });
    const v = videoRef.current;
    const a = audioRef.current;
    return () => {
      // detach (a remuxing source also stops its download)
      if (v) setRecordingSource(v, "");
      if (a) setRecordingSource(a, "");
      m.mainLoaded = "";
      m.audLoaded = "";
      window.clearTimeout(m.toastTimer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the window closed with the player open (MED-96): save the resume point, leave a synced replay
  const leftVia = useRef(false);
  useEffect(
    () => () => {
      if (leftVia.current) return;
      if (m.synced) leaveParty();
      if (m.g > 5 && m.g < durSecs - 5) {
        const map = loadResume();
        map[session.id] = m.g;
        saveResume(map);
      }
    },
    [m], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- the 250 ms tick -------------------------------------------------------------------------------
  // The intervals are created ONCE and call the latest render's closures through `fns` (an interval
  // re-created on every render would be reset by the 4 Hz re-renders and never fire).
  const fns = useRef<{ tick: () => void; follow: () => void }>({ tick: () => {}, follow: () => {} });
  useEffect(() => {
    const t = window.setInterval(() => fns.current.tick(), 250);
    return () => window.clearInterval(t);
  }, []);
  fns.current.tick = () => {
      const v = videoRef.current;
      const a = audioRef.current;
      // load latch: land the queued seek once the new file reports a duration
      if (m.loadPending && v) {
        m.loadTicks++;
        if (v.currentSrc && durOf(v) > 0 && v.readyState >= 1) {
          m.loadPending = false;
          m.loadTicks = 0;
          const ps = m.pendingSeek;
          m.pendingSeek = -1;
          if (ps >= 0) seekMaster(ps);
          else setPlaying(m.playing);
          sideResync();
        } else if (m.loadTicks > 40 || (v.error && v.getAttribute("src"))) {
          dbg(`load timeout/error for ${m.loadTarget}`);
          m.loadPending = false;
          m.loadTicks = 0;
          m.pendingSeek = -1;
          showToast("Couldn't load this stream — try another point of view");
        }
      }
      // audio latch
      if (m.audioLoadPending && a) {
        const useAud = !trackByFile(m.focusedFile) || focusWaitingNow(m.g);
        if (!a.getAttribute("src") && !useAud) {
          m.audioLoadPending = false;
          m.audioPendingSeek = -1;
        } else if (durOf(a) > 0) {
          m.audioLoadPending = false;
          const aps = m.audioPendingSeek;
          m.audioPendingSeek = -1;
          if (aps >= 0) seekMaster(aps);
          else setPlaying(m.playing);
        } else if (!audioUrl) {
          m.audioLoadPending = false;
        }
      }
      const mp = m.atEnd ? -1 : masterPos();
      if (mp >= 0 && mp - m.g > 1.5 && Date.now() - m.lastSeekAt < 1500 && trackByFile(m.focusedFile) && !focusWaitingNow(m.g)) {
        // a seek landed LATER than asked: the file can't show anything before its first keyframe
        // (stream-copied combined files) — remember that floor so a synced follower doesn't bounce
        m.floorG[m.focusedFile] = mp;
        dbg(`clock floor for ${m.focusedFile.slice(0, 24)} at ${mp.toFixed(2)} (asked ${m.g.toFixed(2)})`);
      }
      if (mp >= 0) {
        const gg = Math.min(mp, durSecs);
        m.g = gg;
        setG(gg);
      }
      // P4 hand-over edges
      const waiting = focusWaitingNow(m.g);
      if (waiting !== m.prevWaiting && trackByFile(m.focusedFile)) {
        m.prevWaiting = waiting;
        if (waiting) {
          v?.pause();
          m.audioPendingSeek = m.g;
          m.audioLoadPending = true;
          m.audLoaded = "";
          applyAud();
        } else {
          applyAud();
          if (!m.loadPending && durOf(v) > 0) seekMain(Math.max(0, m.g - trackOffset(session, trackByFile(m.focusedFile))));
          setPlaying(m.playing);
          sideResync();
        }
      }
      // rail order follows track boundaries (signature per tick)
      const sig = sideRef.current.map((tr) => railRank(session, tr, m.g)).join("");
      if (sig !== m.railSig) {
        m.railSig = sig;
        assignRail();
      }
      // P4 wait watchdog: the audio clock stuck ~3 s → skip to the POV's start
      if (waiting && m.playing && !m.audioLoadPending && !m.loadPending) {
        if (Math.abs(m.g - m.waitLastG) < 0.01) m.waitStall++;
        else m.waitStall = 0;
        m.waitLastG = m.g;
        if (m.waitStall >= 12) {
          m.waitStall = 0;
          const off = trackOffset(session, trackByFile(m.focusedFile));
          showToast(`Skipped ahead to ${fmtTime(off)}`);
          commitSeek(off);
        }
      } else {
        m.waitStall = 0;
        m.waitLastG = -1;
      }
      // external audio follows the video (combined-less POVs)
      if (extMode() && !waiting && a && v && durOf(a) > 0 && !m.loadPending) {
        const want = v.currentTime + trackOffset(session, trackByFile(m.focusedFile)) - audioOffset;
        if (Math.abs(a.currentTime - want) > 0.25) a.currentTime = Math.max(0, want);
        if (m.playing && a.paused && !v.paused) tryPlay(a);
        if (v.paused && !a.paused) a.pause();
      }
      // ended-state machine
      if (m.playing && !m.loadPending && !m.audioLoadPending) {
        const ft = trackByFile(m.focusedFile);
        const eofSrc = ft && !waiting ? v : a;
        const gNow = m.g;
        if (eofSrc?.ended && ft && !waiting && gNow < durSecs - 1.5) {
          // The focused POV's own file ended before the session did (they left the call). Native
          // ends the whole replay here; the web hands over to a POV still on at this moment, else
          // to the voices (logged in docs/native-bugs/media.md).
          const next = vts.find((tr) => {
            const e = trackEnd(session, tr);
            return tr.file !== ft.file && !m.hidden[tr.file] && railRank(session, tr, gNow) === 0 && (e < 0 || e > gNow + 1);
          });
          dbg(`focused POV ended at ${gNow.toFixed(1)} → ${next ? next.file : audioUrl ? "voices" : "end"}`);
          if (next) focusTrack(next.file);
          else if (audioUrl) focusTrack("");
          else {
            setPlaying(false);
            m.atEnd = true;
            setAtEnd(true);
          }
        } else if (eofSrc?.ended) {
          setPlaying(false);
          m.atEnd = true;
          setAtEnd(true);
          m.g = durSecs;
          setG(durSecs);
          dbg(`replay ended at ${durSecs.toFixed(1)}`);
        }
      }
      // self-heal: never sit in unlabelled audio-only when video exists and nobody chose it
      if (m.focusedFile === "" && !m.userChoseAudioOnly && !m.loadPending && vts.length > 0) {
        const heal = earliestVideo(session.tracks);
        if (heal) focusTrack(heal.file);
      }
      // autoplay block: asked to play but the master stays paused > 1.5 s
      const master = trackByFile(m.focusedFile) && !waiting ? v : a;
      if (m.playing && master && master.getAttribute("src") && master.paused && !m.loadPending && Date.now() - m.playReqAt > 1500) {
        if (!master.ended) tryPlay(master);
      }
      const ad = durOf(a);
      if (ad > 0 && Math.abs(ad - audioDur) > 0.5) setAudioDur(ad);
  };

  // ---- sync with the call ------------------------------------------------------------------------------
  // follower: mirror the shared clock every second (>2 s drift → seek; >60 s stale → pause)
  useEffect(() => {
    if (!synced) return;
    const t = window.setInterval(() => fns.current.follow(), 1000);
    return () => window.clearInterval(t);
  }, [synced]);
  fns.current.follow = () => {
      const pb = useWatchParty.getState().playback;
      if (!pb) return;
      if (Date.now() - Number(pb.updatedAt || 0) > 60_000) {
        if (m.playing) setPlaying(false);
        return;
      }
      let target = Number(pb.positionSecs || 0);
      if (pb.playing) target += (Date.now() - Number(pb.updatedAt || Date.now())) / 1000;
      const floor = Math.max(contentStart, m.floorG[m.focusedFile] ?? 0);
      const inFloor = target < floor && Math.abs(m.g - floor) < 2.0; // the file can't go earlier
      if (Number.isFinite(target) && Math.abs(target - m.g) > 2.0 && !inFloor) {
        seekMaster(Math.min(target, durSecs));
        sideResync();
      }
      if (!!pb.playing !== m.playing) setPlaying(!!pb.playing);
  };
  // report our clock while synced + playing
  useEffect(() => {
    if (!synced || !playing) return;
    const t = window.setInterval(() => reportPosition(m.g), 1000);
    return () => window.clearInterval(t);
  }, [synced, playing, m]);
  // a remote seek routed to us (MED-92): only while synced to THIS memory
  useEffect(
    () =>
      onDesiredSeek((pos, url) => {
        if (!m.synced || url !== memUrl) return;
        if (Number.isFinite(pos) && pos >= 0) {
          seekMaster(Math.min(pos, durSecs));
          sideResync();
        }
      }),
    [memUrl], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // the call ended → stop syncing (only this Memories replay party is left — D6)
  const wasInCall = useRef(inCall);
  useEffect(() => {
    if (wasInCall.current && !inCall && useWatchParty.getState().inParty && (useWatchParty.getState().playback?.url ?? "").startsWith("tinhat-memory://")) leaveParty();
    wasInCall.current = inCall;
  }, [inCall]);

  // ---- keyboard ------------------------------------------------------------------------------------
  const onKey = (e: ReactKeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest("input, textarea, [contenteditable=true]")) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    let handled = true;
    if (k === " " || k === "k" || k === "K") togglePlay();
    else if (k === "ArrowLeft" || k === "j" || k === "J") skipBy(e.shiftKey && k === "ArrowLeft" ? -60 : -10);
    else if (k === "ArrowRight" || k === "l" || k === "L") skipBy(e.shiftKey && k === "ArrowRight" ? 60 : 10);
    else if (k === "m" || k === "M") setVolume(m.vol.volume, !m.vol.muted);
    else if (k === "f" || k === "F") toggleTheater();
    else if (k >= "1" && k <= "9") {
      const n = Number(k);
      for (const gr of groups)
        for (const p of gr.povs)
          if (p.key === n) {
            if (m.hidden[p.file]) toggleHidden(p.file);
            focusTrack(p.file);
          }
    } else if (k === "0") {
      if (audioUrl) focusTrack("");
    } else if (k === "Escape") {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else back();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---- render ------------------------------------------------------------------------------------------
  const people = peopleOf(session);
  const names = people.slice(0, 4).map(shortName).join(", ") + (people.length > 4 ? ` +${people.length - 4}` : "");
  const waiting = !!focusedTrack && audioUrl.length > 0 && g < focusedOffset - 0.3;
  const focusedPov = focusedTrack ? groups.flatMap((gr) => gr.povs.map((p) => ({ gr, p }))).find((x) => x.p.file === focusedTrack.file) : undefined;
  const hiddenCount = Object.keys(hidden).length;
  const railW = Math.min(480, Math.max(200, ((rootRef.current?.clientWidth ?? 864) - 16) * 0.24));
  const tileH = Math.round(railW * (9 / 16));
  const shownG = dragPos ?? g;
  const chromeShown = !theater || !chromeIdle;
  const playIcon = atEnd ? "view-refresh-symbolic" : playing ? "media-playback-pause" : "media-playback-start";
  const playTip = synced ? (playing ? "Pause for everyone" : "Play for everyone") : atEnd ? "Watch again (Space)" : playing ? "Pause (Space)" : "Play (Space)";

  return (
    <div
      ref={rootRef}
      className={cx(s.root, theater && s.theater, mobile && s.mobile)}
      tabIndex={-1}
      onKeyDown={onKey}
      onPointerMove={touchChrome}
      data-mem-player=""
    >
      {!theater && (
        <div className={s.header}>
          <HeaderIconButton iconName="go-previous-symbolic" tip="All memories (Esc)" onClick={back} />
          <div className={s.titleCol}>
            <Heading level={1} className={s.heading}>
              {fmtDateLong(Number(session.start_ms))}
            </Heading>
            <div className={s.subtitle}>{`${session.room_name || roomName || ""} · ${fmtTime(durSecs)}${names ? ` · ${names}` : ""}`}</div>
          </div>
          <span className={s.spacer} />
          <span className={s.pillRow}>
            {synced && <Pill text="⟲ synced with the call" fg="var(--th-memories-sync-pill-fg)" bg="var(--th-memories-sync-pill-bg)" />}
            {waiting && focusedTrack && <Pill text={`▶ ${shortName(focusedTrack.identity)} joins at ${fmtTime(focusedOffset)}`} fg="var(--th-memories-wait-pill-fg)" bg="var(--th-memories-wait-pill-bg)" />}
          </span>
          <HeaderIconButton iconName={theater ? "view-restore-symbolic" : "view-fullscreen-symbolic"} tip={theater ? "Leave fullscreen (F)" : "Fullscreen (F)"} onClick={toggleTheater} />
        </div>
      )}
      {mobile && !theater && (
        <div className={s.mobileBar}>
          <Button text="All memories" icon="go-previous-symbolic" onClick={back} />
          <div className={s.subtitle}>{`${fmtTime(durSecs)}${names ? ` · ${names}` : ""}`}</div>
          <HeaderIconButton iconName="view-fullscreen-symbolic" tip="Fullscreen" onClick={toggleTheater} />
        </div>
      )}
      {!playable && !theater && (
        <div className={s.decoder}>⚠️ This browser can't play the call recordings (Matroska video) — open Memories in Chrome or Edge, or in the Tin Hat app. Snapshots still show below.</div>
      )}
      {decoderBroken && playable && !theater && (
        <div className={s.decoder}>⚠️ Live side tiles can't play in this browser, so they're showing snapshots. The main view still plays normally.</div>
      )}

      <div className={s.playerRow}>
        <div
          className={s.stage}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            togglePlay();
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            togglePlay(); // undo the first click's toggle
            toggleTheater();
          }}
        >
          <video ref={videoRef} className={s.stageVideo} playsInline preload="auto" style={{ visibility: focusedTrack && !waiting ? "visible" : "hidden" }} />
          <audio ref={audioRef} preload="auto" />
          {waiting && focusedTrack && (
            <div className={s.waitVeil}>
              <Avatar name={shortName(focusedTrack.identity)} seed={userIdOf(focusedTrack.identity)} size={72} />
              <div className={s.waitName}>{`${povDescr(groups, focusedTrack).replace(/^./, (c) => c)}`}</div>
              <div className={s.waitHint}>{`starts at ${fmtTime(focusedOffset)} · ${fmtTime(focusedOffset - g)} to go`}</div>
              <Button
                text="Skip to it"
                icon="media-skip-forward"
                onClick={(e) => {
                  e.stopPropagation();
                  commitSeek(focusedOffset);
                }}
              />
            </div>
          )}
          {!focusedTrack && (
            <div className={s.audioOnly}>
              <div className={s.audioGlyph}>🎧</div>
              <div className={s.audioTitle}>Audio only</div>
              <div className={s.audioHint}>{vts.length > 0 ? "pick a point of view below to see it" : "this memory has voices only"}</div>
            </div>
          )}
          {focusedTrack && !waiting && focusedPov && (
            <div className={s.caption}>
              <Avatar name={focusedPov.gr.name} seed={focusedPov.gr.user} size={22} />
              <span className={s.captionName}>{focusedPov.gr.name}</span>
              <span className={s.captionKind}>{`${kindGlyph(focusedPov.p.kind)} ${focusedPov.p.label.toLowerCase().replace("camera", "camera")}`}</span>
            </div>
          )}
          <div key={flash.n} className={cx(s.flash, flash.n > 0 && s.flashOn)}>
            {flash.text && <span className={s.flashLabel}>{flash.text}</span>}
          </div>
          {!playing && !atEnd && (
            <div className={s.pausedGlyph}>
              <Icon name="media-playback-start" size={30} color="var(--th-memories-paused-icon)" />
            </div>
          )}
          {toast && <div className={s.toast}>{toast}</div>}
          {atEnd && (
            <div className={s.endOverlay} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <div className={s.endTitle}>That's the end of this one</div>
              <div className={s.endSub}>{`${fmtTime(durSecs)} relived`}</div>
              <div className={s.endRow}>
                <GlowButton text="Watch again" icon="view-refresh-symbolic" onClick={() => togglePlay()} />
                <Button text="All memories" icon="go-previous-symbolic" onClick={back} />
              </div>
            </div>
          )}
          {blocked && playing && !atEnd && (
            <button
              type="button"
              className={s.clickToPlay}
              onClick={(e) => {
                e.stopPropagation();
                setBlocked(false);
                setPlaying(true);
              }}
            >
              <Icon name="media-playback-start" size={22} color="var(--th-memories-click-to-play-fg)" />
              <span>Click to start playback</span>
            </button>
          )}
        </div>

        {railOrder.length > 0 && !theater && (
          <div className={s.rail} style={{ width: railW }}>
            <div className={s.railInner} style={{ height: railOrder.length * (tileH + 4) - 4 }}>
              {railOrder.map((f, rank) => {
                const tr = trackByFile(f);
                if (!tr) return null;
                const slot = slots.indexOf(f);
                return (
                  <SideTile
                    key={f}
                    session={session}
                    groups={groups}
                    track={tr}
                    live={liveTiles && slot >= 0 && slot < LIVE_SLOTS}
                    slot={slot < 0 ? 7 : slot}
                    top={rank * (tileH + 4)}
                    width={railW}
                    height={tileH}
                    g={g}
                    playing={playing}
                    resyncSeq={resyncSeq}
                    onFocus={() => focusTrack(f)}
                    onBroken={() => setDecoderBroken(true)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div
        className={cx(s.transport, theater && !chromeShown && s.transportHidden)}
        onPointerEnter={() => {
          transportHover.current = true;
          setChromeIdle(false);
        }}
        onPointerLeave={() => {
          transportHover.current = false;
          touchChrome();
        }}
      >
        <div className={s.timeline}>
          <Slider
            value={shownG}
            from={0}
            to={durSecs}
            aria-label="Timeline"
            onMoved={(v) => {
              setDragPos(v);
              userSeek(v);
            }}
            onRelease={(v) => {
              setDragPos(null);
              commitSeek(v);
            }}
          />
          {dragPos !== null && (
            <span className={s.dragTip} style={{ left: `${(dragPos / durSecs) * 100}%` }}>
              {fmtTime(dragPos)}
            </span>
          )}
          {clips
            .filter((c) => session.start_ms && c.at >= Number(session.start_ms) && c.at <= Number(session.end_ms || Infinity))
            .map((c) => {
              const off = (c.at - Number(session.start_ms)) / 1000;
              return <ClipMark key={c.at} off={off} dur={durSecs} by={c.by} onSeek={() => commitSeek(off)} />;
            })}
        </div>
        <div className={s.buttons}>
          <HeaderIconButton iconName="media-skip-backward" tip="Back 10s (←)" onClick={() => skipBy(-10)} />
          <PlayButton icon={playIcon} tip={playTip} onClick={togglePlay} />
          <HeaderIconButton iconName="media-skip-forward" tip="Forward 10s (→)" onClick={() => skipBy(10)} />
          <span className={s.time}>{`${fmtTime(shownG)}  /  ${fmtTime(durSecs)}`}</span>
          <span className={s.spacer} />
          <HeaderIconButton
            iconName={vol.muted || vol.volume === 0 ? "audio-volume-muted-symbolic" : vol.volume < 50 ? "audio-volume-low-symbolic" : "audio-volume-high-symbolic"}
            tip={vol.muted ? "Unmute (M)" : "Mute (M)"}
            onClick={() => setVolume(vol.volume, !vol.muted)}
          />
          <VolumeSlider value={vol.volume} onMoved={(v) => setVolume(v, v > 0 ? false : vol.muted)} />
          <BasicButton
            className={s.syncBtn}
            text={synced ? "Stop sync" : "⟲ Sync with call"}
            highlighted={synced}
            disabled={!inCall}
            tip={
              !inCall
                ? "Join the room's call to relive this together — everyone in the call who syncs follows one clock"
                : synced
                  ? "Back to replaying on your own"
                  : "Everyone in the call who opens this memory follows the same clock"
            }
            onClick={() => {
              if (synced) leaveParty();
              else syncStartMemory(roomId, memUrl);
            }}
          />
        </div>
      </div>

      {!theater && vts.length > 0 && (
        <div className={s.pov}>
          <div className={s.povHead}>
            <span className={s.povTitle}>Points of view</span>
            <span className={s.povHint}>{mobile ? "· tap one to put it on stage" : "· click one to put it on stage, or press its number"}</span>
            {hiddenCount > 0 && (
              <Button
                flat
                text={`Show all (${hiddenCount} hidden)`}
                onClick={() => {
                  m.hidden = {};
                  setHidden({});
                }}
              />
            )}
          </div>
          <div className={s.povFlow}>
            {groups.map((gr) => (
              <span key={gr.user} className={s.person}>
                <Avatar name={gr.name} seed={gr.user} size={24} />
                <span className={s.personName}>{gr.name}</span>
                {gr.povs.map((p) => (
                  <PovPill
                    key={p.file}
                    pov={p}
                    onStage={focusedFile === p.file}
                    upcoming={g < p.off - 0.5}
                    gone={p.end > 0 && g > p.end + 0.5}
                    hidden={!!hidden[p.file]}
                    onPick={() => {
                      if (m.hidden[p.file]) toggleHidden(p.file);
                      focusTrack(p.file);
                    }}
                    onEye={() => toggleHidden(p.file)}
                  />
                ))}
              </span>
            ))}
            {audioUrl && <VoicesChip on={!focusedTrack} onPick={() => focusTrack("")} />}
          </div>
        </div>
      )}

      {!theater && clips.some((c) => session.start_ms && c.at >= Number(session.start_ms) && c.at <= Number(session.end_ms || Infinity)) && (
        <div className={s.clips}>
          <span className={s.clipsTitle}>Clips</span>
          <div className={s.clipFlow}>
            {clips
              .filter((c) => c.at >= Number(session.start_ms) && c.at <= Number(session.end_ms || Infinity))
              .sort((a, b) => a.at - b.at)
              .map((c) => {
                const off = (c.at - Number(session.start_ms)) / 1000;
                return (
                  <button key={c.at} type="button" className={s.clipChip} onClick={() => commitSeek(off)}>
                    {`🔖 ${fmtTime(off)} · ${shortName(c.by)}`}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {!theater && !mobile && (
        <div className={s.hint}>
          <span>Space play/pause · ← → 10s · Shift+← → 1 min · 1-9 put a point of view on stage · 0 voices only · M mute · F fullscreen · Esc back</span>
        </div>
      )}
    </div>
  );
}

// ---- pieces ----------------------------------------------------------------------------------------------

function PlayButton({ icon, tip, onClick }: { icon: string; tip: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, tip, { delay: 500 });
  return (
    <button ref={ref} type="button" className={s.playBtn} aria-label={tip} onClick={onClick}>
      <Icon name={icon} size={22} color="var(--th-memories-play-icon)" />
    </button>
  );
}

function VolumeSlider({ value, onMoved }: { value: number; onMoved: (v: number) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, `${Math.round(value)}%`);
  return (
    <span ref={ref} className={s.vol}>
      <Slider value={value} from={0} to={100} aria-label="Volume" onMoved={onMoved} />
    </span>
  );
}

function ClipMark({ off, dur, by, onSeek }: { off: number; dur: number; by: string; onSeek: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, `🔖 ${shortName(by)} · ${fmtTime(off)}`);
  // the house Slider's groove spans the handle-inset track; place relative to the timeline box
  const style: CSSProperties = { left: `clamp(0px, calc(${(off / Math.max(1, dur)) * 100}% - 2px), calc(100% - 4px))` };
  return (
    <span
      ref={ref}
      className={s.clipMark}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
    />
  );
}

function PovPill({
  pov,
  onStage,
  upcoming,
  gone,
  hidden,
  onPick,
  onEye,
}: {
  pov: Pov;
  onStage: boolean;
  upcoming: boolean;
  gone: boolean;
  hidden: boolean;
  onPick: () => void;
  onEye: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const eyeRef = useRef<HTMLButtonElement>(null);
  useTip(
    ref,
    (onStage ? "On stage now" : `Put this on stage (key ${pov.key})`) +
      (upcoming ? ` · joins at ${fmtTime(pov.off)}` : "") +
      (gone ? ` · left at ${fmtTime(pov.end)}` : "") +
      (hidden ? " · hidden from the side rail" : ""),
    { delay: 500 },
  );
  useTip(eyeRef, hidden ? "Show in the side rail" : "Hide from the side rail", { delay: 400 });
  const suffix = onStage ? "· on stage" : upcoming ? `· joins ${fmtTime(pov.off)}` : gone ? `· left ${fmtTime(pov.end)}` : "";
  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      className={cx(s.povPill, onStage && s.povOn, !onStage && gone && s.povGone, hidden && s.povHidden)}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onPick();
      }}
    >
      <span className={s.povGlyph}>{kindGlyph(pov.kind)}</span>
      <span className={s.povLabel}>{pov.label}</span>
      {suffix && <span className={s.povSuffix}>{suffix}</span>}
      <span className={s.povKey}>{pov.key}</span>
      {!onStage && (
        <button
          ref={eyeRef}
          type="button"
          className={cx(s.eye, hidden && s.eyeShown)}
          onClick={(e) => {
            e.stopPropagation();
            onEye();
          }}
        >
          {hidden ? "🚫" : "👁"}
        </button>
      )}
    </span>
  );
}

function VoicesChip({ on, onPick }: { on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, "Just the voices — no video on stage (key 0)", { delay: 500 });
  return (
    <span ref={ref} role="button" tabIndex={0} className={cx(s.povPill, on && s.povOn)} onClick={onPick}>
      <span className={s.povLabel}>{`🎧 Voices only${on ? " · on stage" : ""}  0`}</span>
    </span>
  );
}

// ---- side tile (live <video> or snapshot) ------------------------------------------------------------------

function SideTile({
  session,
  groups,
  track,
  live,
  slot,
  top,
  width,
  height,
  g,
  playing,
  resyncSeq,
  onFocus,
  onBroken,
}: {
  session: VodSession;
  groups: PovGroup[];
  track: VodTrack;
  live: boolean;
  slot: number;
  top: number;
  width: number;
  height: number;
  g: number;
  playing: boolean;
  resyncSeq: number;
  onFocus: () => void;
  onBroken: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const off = trackOffset(session, track);
  const end = trackEnd(session, track);
  const resting = g < off - 0.5 || (end > 0 && g > end + 0.5);
  const tilePos = Math.max(0, Math.min(end > 0 ? end : Infinity, Math.max(g, off)) - off);
  const [snapshot, setSnapshot] = useState(!live);
  const [settled, setSettled] = useState(false);
  const [imgSrc, setImgSrc] = useState("");
  const [imgShown, setImgShown] = useState(false);
  const frames = useRef(0);
  const posRef = useRef(tilePos);
  posRef.current = tilePos;
  const brokenRef = useRef(onBroken);
  brokenRef.current = onBroken;
  const hit = povOfFile(groups, track.file);
  const name = hit?.group.name ?? shortName(track.identity);
  const descr = povDescr(groups, track);
  useTip(ref, `Put ${descr} on stage`, { delay: 700 });

  useEffect(() => setSnapshot(!live), [live]);

  // live: frame counter (requestVideoFrameCallback) + health
  useEffect(() => {
    const v = vid.current;
    if (!v || snapshot) return;
    let handle = 0;
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    const onFrame = () => {
      frames.current++;
      setSettled(true);
      handle = rvfc ? rvfc.call(v, onFrame) : 0;
    };
    if (rvfc) handle = rvfc.call(v, onFrame);
    const onErr = () => {
      if (!v.getAttribute("src")) return;
      setSnapshot(true);
      brokenRef.current();
    };
    v.addEventListener("error", onErr);
    return () => {
      v.removeEventListener("error", onErr);
      const cancel = (v as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback;
      if (handle && cancel) cancel.call(v, handle);
    };
  }, [snapshot]);

  // hard resync on landings (exact seek), settle veil ≤ 3.6 s
  useEffect(() => {
    const v = vid.current;
    if (!v || snapshot) return;
    setSettled(false);
    if (v.readyState >= 1) v.currentTime = posRef.current;
    const t = window.setTimeout(() => setSettled(true), 3600);
    return () => window.clearTimeout(t);
  }, [resyncSeq, snapshot]);

  // play/pause + gentle 5 s drift check (seek only when |drift| > 0.75 s)
  useEffect(() => {
    const v = vid.current;
    if (!v || snapshot) return;
    if (playing && !resting) void v.play().catch(() => {});
    else v.pause();
  }, [playing, resting, snapshot]);
  useEffect(() => {
    if (snapshot) return;
    let zeroSince = 0;
    const t = window.setInterval(() => {
      const v = vid.current;
      if (!v || v.readyState < 1) return;
      if (Math.abs(v.currentTime - posRef.current) > 0.75) v.currentTime = posRef.current;
      // health: zero frames ~6 s while playing → snapshot mode + decoder banner
      if (playing && !resting && typeof (v as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function") {
        if (frames.current === 0) {
          if (!zeroSince) zeroSince = Date.now();
          else if (Date.now() - zeroSince > 6000) {
            setSnapshot(true);
            brokenRef.current();
          }
        } else zeroSince = 0;
      }
      frames.current = 0;
    }, 5000);
    return () => window.clearInterval(t);
  }, [snapshot, playing, resting]);

  // snapshot mode: thumbnail every 3000 + 700·slot ms (first after that delay), no cache
  useEffect(() => {
    if (!snapshot) return;
    let n = 0;
    const load = () => setImgSrc(`${thumbUrl(track.url, posRef.current)}&n=${n++}`);
    const t0 = window.setTimeout(function tick() {
      load();
      t1 = window.setTimeout(tick, 3000 + 700 * slot);
    }, 3000 + 700 * slot);
    let t1 = 0;
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
    };
  }, [snapshot, slot, track.url]);

  const stripH = Math.max(26, Math.round(height * 0.17));
  const restAvatar = Math.max(24, Math.min(40, Math.round(height * 0.24)));
  const kindWord = hit ? hit.pov.label : track.kind === "share" ? "Stream" : "Camera";
  return (
    <div ref={ref} className={s.tile} style={{ top, height }} onClick={onFocus} data-file={track.file}>
      {!snapshot ? (
        <video ref={vid} className={s.tileMedia} muted playsInline preload="auto" src={sameOrigin(track.url)} />
      ) : (
        imgSrc && <img className={cx(s.tileMedia, s.tileImg, imgShown && s.tileImgShown)} src={imgSrc} alt="" onLoad={() => setImgShown(true)} />
      )}
      {!resting && !snapshot && (
        <div className={s.tilePlaceholder} style={{ opacity: settled ? 0 : 1 }}>
          <span>{frames.current > 0 ? "syncing…" : "loading…"}</span>
        </div>
      )}
      {!resting && snapshot && !imgShown && (
        <div className={s.tilePlaceholder}>
          <span>loading…</span>
        </div>
      )}
      {resting && (
        <div className={s.tileRest}>
          <Avatar name={name} seed={userIdOf(track.identity)} size={restAvatar} />
          <span>{g < off ? `joins at ${fmtTime(off)}` : `left at ${fmtTime(end)}`}</span>
        </div>
      )}
      <div className={s.tileStrip} style={{ height: stripH }}>
        <Avatar name={name} seed={userIdOf(track.identity)} size={18} />
        <span className={s.tileName}>{name}</span>
        <span className={s.tileKind}>{`${kindGlyph(track.kind)}${width >= 250 ? ` ${kindWord}` : ""}`}</span>
        {hit && <span className={s.tileKey}>{hit.pov.key}</span>}
      </div>
      <div className={s.tileHover}>
        <span className={s.putOnStage}>▶&nbsp;&nbsp;Put on stage</span>
        <span className={s.tileFs}>
          <Icon name="view-fullscreen-symbolic" size={16} color="var(--th-memories-tile-icon)" />
        </span>
      </div>
      {!resting && (
        <span className={s.tileTag}>
          <Pill text={snapshot ? "snapshots" : "● live"} fg={snapshot ? "var(--th-memories-tile-tag-fg)" : "var(--th-memories-tile-tag-live-fg)"} bg="var(--th-memories-tile-tag-bg)" />
        </span>
      )}
    </div>
  );
}

function povOfFile(groups: PovGroup[], file: string): { group: PovGroup; pov: Pov } | null {
  for (const gr of groups) for (const p of gr.povs) if (p.file === file) return { group: gr, pov: p };
  return null;
}


// WatchPartyWindow.tsx — WatchPartyWindow.qml (576×720, min 360×400, "Media Party — Tin Hat"). 11.4 (DESIGN §2.3):
// now-playing header (art · title · artist/channel · duration · added-by · source badge), buffering spinner, real error
// text that clears on the next success, the one box (a URL adds — words search), who's watching with the host badge.
// 11.3 QOL (the Media Party QOL spec — the desktop's WatchPartyWindow.qml is the twin):
//   §1 layout: ≥ 960 px of window = two columns (stage | draggable divider | side panel 300–560 px, `watchparty-side-w`),
//      the video grows with the window (16:9, height capped so the stage fits, ≥ 200 px, letterboxed); < 960 px = one
//      column with no width cap (video height ≤ max(200, H − 160)); Theater (T, `watchparty-theater`) = the stage only;
//      Fullscreen (F / double-click / button) = the window body; Mini player (I) = a 480×270 video-only window above
//      the other windows (`watchparty-mini-x/-y`), Esc / I / the button restore the exact previous geometry.
//   §2 the video surface: a transparent catcher over the YouTube iframe — click = play/pause for everyone (deferred
//      250 ms), double-click = fullscreen, wheel = my volume ±5; the OSD pill for my keys/clicks/wheel and for what
//      OTHERS do (osd.ts: the playback event's sender). h:mm:ss everywhere (queue.ts fmtTime).
//   §3 transport: play · mute · volume (hidden < 520 px) · scrub (hover time, click jumps) · time (click: elapsed ⇄
//      remaining, `watchparty-time-remaining`) · next · Theater · Mini · Fullscreen · Keys.
//   §4 the 26 keys (shortcuts.ts = the shared vectors), never while typing in the box except Esc there (suggestions →
//      clear → blur; it never closes the window); Esc: fullscreen → mini → close. The keys card (?).
//   §5 the queue (QueueList.tsx) · §6 browse + the box ("/" focuses it) · §7 closing while in a party with something
//      loaded → "You left the Media Party" + Rejoin.
// Closing the window stops the player and leaves the party (always, idempotent). The `window:watchParty` context
// actions (playPause / next / mute / queue / host.toggle) are run HERE (ACTIONS.md §14.1): runWindowAction.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getState, peekClient, sendMessage, useMember, useRoomStateEvents } from "@/core/matrix";
import { useAppWindow } from "@/app/WindowHost";
import { getPref, setPref } from "@/core/prefs";
import { openWindow, toast } from "@/core/bus";
import { Avatar, BasicTextField, BusyIndicator, Button, EmptyState, GlowButton, Heading, Icon, ScrollArea, Slider, ToolButton, animate, cx, useIsMobile, useIsTouch } from "@/ui";
import { shortName } from "../shared/format";
import { useWindowLifetime } from "../shared/lifetime";
import {
  PLAYBACK_EVENT,
  WP_EVENT,
  assignHost,
  desiredClock,
  enqueue,
  fmtTime,
  joinParty,
  leaveParty,
  nextQueueUrl,
  normParty,
  normPlayback,
  onDesiredSeek,
  pause,
  play,
  playUrl,
  reportPosition,
  seek,
  useWatchParty,
  type QueueItem,
} from "./engine";
import { useServerFeature } from "@/core/server";
import { addLink, type LinkMeta } from "./add";
import { BrowsePane } from "./Browse";
import { clearSuggestions, setTab, suggest, useBrowse } from "./browseStore";
import { openInLabel, parseMediaLink, serviceLabel, type MediaLink } from "./links";
import { MP_KEY_GROUPS, keyName, shortcutFor, type MpShortcut } from "./shortcuts";
import { remoteChange, type PbSnap } from "./osd";
import { QueueList } from "./QueueList";
import { WatchPlayer, type WatchPlayerHandle } from "./player";
import s from "./WatchParty.module.css";

/** QOL §1 numbers (the desktop's WatchPartyWindow.qml uses the same) */
export const WIDE_MIN_W = 960;
export const SIDE_W = { def: 380, min: 300, max: 560 };
export const MINI = { w: 480, h: 270, margin: 24, title: 30 };
export const NARROW_W = 520;
const CLICK_DEFER_MS = 250;
const OSD_MS = 1200;
const OSD_FADE_MS = 200;

/** The queue entry of the playing url (or a bare one). */
export function nowItemOf(queue: QueueItem[], url: string): QueueItem | null {
  if (!url) return null;
  return queue.find((q) => q.url === url) ?? { url, title: "", addedBy: "" };
}

/** The side panel's width for a window `w` px wide: the remembered one, clamped to 300 … min(560, 50 %). */
export function clampSide(want: number, w: number): number {
  const max = Math.max(SIDE_W.min, Math.min(SIDE_W.max, Math.floor(w / 2)));
  return Math.round(Math.min(max, Math.max(SIDE_W.min, Number.isFinite(want) ? want : SIDE_W.def)));
}

function memberName(roomId: string, userId: string): string {
  return peekClient()?.getRoom(roomId)?.getMember(userId)?.name || shortName(userId);
}

function UserChip({ roomId, userId, host, size = 20 }: { roomId: string; userId: string; host?: boolean; size?: number }) {
  const m = useMember(roomId, userId);
  return (
    <span className={s.user} title={userId}>
      <Avatar name={m?.name ?? shortName(userId)} seed={userId} size={size} imageSource={m?.avatarMxc ?? ""} />
      <span className={s.userName}>{m?.name ?? shortName(userId)}</span>
      {host && <span className={s.hostBadge}>host</span>}
    </span>
  );
}

interface Osd {
  id: number;
  icon: string;
  text: string;
  out: boolean;
}
let osdSeq = 0;

export function WatchPartyWindow({ roomId }: { roomId?: string }) {
  const mobile = useIsMobile();
  const touch = useIsTouch();
  const win = useAppWindow();
  const st = useWatchParty();
  const myId = peekClient()?.getUserId() ?? "";
  const hostId = st.party.hostId;
  const amHost = !!hostId && hostId === myId;
  const canControl = st.inParty && (!hostId || amHost);
  const hostName = hostId ? shortName(hostId) : "";
  const nowUrl = st.playback?.url ?? "";
  const isPlaying = !!st.playback?.playing;
  const queue = st.party.queue;
  const partyRoom = st.roomId || roomId || "";
  const nowItem = nowItemOf(queue, nowUrl);
  const isMemory = nowUrl.startsWith("tinhat-memory://");

  const root = useRef<HTMLDivElement>(null);
  const catcher = useRef<HTMLDivElement>(null);
  const player = useRef<WatchPlayerHandle>(null);
  const loadedUrl = useRef("");
  const eofSeen = useRef(false);
  const sawPlayback = useRef(false);
  const loadStartedAt = useRef(0);
  const [playbackError, setPlaybackError] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const pausedSince = useRef(0);
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(String(getPref("watchparty-volume", "100")));
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100;
  });
  const [muted, setMuted] = useState(() => getPref("watchparty-muted", false) === true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState("");
  /** a Spotify / Apple link that could not be queued (no YouTube match, an album / playlist): the card stays */
  const [card, setCard] = useState<{ link: MediaLink; meta: LinkMeta | null; message: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const browseTab = useBrowse((b) => b.tab);
  // docs/SELFHOST.md: a server without a YouTube key has no search / browse — pasted links keep working
  const watchOn = useServerFeature("watch");

  // ---- §1 layout: the window body's size decides wide / stacked (a width-only rule: no layout loop) ------------------
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSize((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [theater, setTheater] = useState(() => getPref("watchparty-theater", false) === true);
  const [fullscreen, setFullscreen] = useState(false);
  const [mini, setMini] = useState(false);
  const [chromeIdle, setChromeIdle] = useState(false);
  const idleTimer = useRef(0);
  const [miniHover, setMiniHover] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [remaining, setRemaining] = useState(() => getPref("watchparty-time-remaining", false) === true);
  const [sideWant, setSideWant] = useState(() => {
    const v = Number(getPref("watchparty-side-w", SIDE_W.def));
    return Number.isFinite(v) && v > 0 ? v : SIDE_W.def;
  });
  const theaterOn = theater && !mobile && !mini;
  const wide = !mobile && size.w >= WIDE_MIN_W;
  const narrow = size.w > 0 && size.w < NARROW_W;
  const sideW = clampSide(sideWant, size.w);
  const twoCols = wide && !theaterOn && !mini && !fullscreen;

  // ---- OSD (§2): one pill, the newest replaces the current one, 1.2 s then a 200 ms fade (none with reduced motion) --
  const [osd, setOsd] = useState<Osd | null>(null);
  const osdTimer = useRef(0);
  const showOsd = useCallback((icon: string, text: string) => {
    window.clearTimeout(osdTimer.current);
    const id = ++osdSeq;
    setOsd({ id, icon, text, out: false });
    osdTimer.current = window.setTimeout(() => {
      if (!animate()) return setOsd((o) => (o?.id === id ? null : o));
      setOsd((o) => (o?.id === id ? { ...o, out: true } : o));
      osdTimer.current = window.setTimeout(() => setOsd((o) => (o?.id === id ? null : o)), OSD_FADE_MS);
    }, OSD_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(osdTimer.current), []);
  const denyOsd = useCallback(() => showOsd("user-identity", `Only the host (${hostName}) controls playback`), [showOsd, hostName]);

  // window close = stop + leave (StrictMode-safe); §7: closing (not the Leave button) while in a party with something
  // loaded → a toast in the main window with Rejoin (re-joins and re-opens the window)
  useWindowLifetime(() => {
    const s0 = useWatchParty.getState();
    const room = s0.roomId;
    const hadSomething = s0.inParty && !!(s0.playback?.url || loadedUrl.current);
    player.current?.stop();
    loadedUrl.current = "";
    leaveParty();
    if (document.fullscreenElement && root.current && document.fullscreenElement.contains(root.current)) void document.exitFullscreen().catch(() => {});
    if (hadSomething && room)
      toast("You left the Media Party", {
        timeoutMs: 6000,
        action: {
          label: "Rejoin",
          run: () => {
            if (!useWatchParty.getState().inParty) joinParty(room);
            openWindow("watchparty", { roomId: useWatchParty.getState().roomId || room });
          },
        },
      });
  });

  // opened from anywhere (menu / banner / call bar / the palette): join if not already in a party
  // (joinParty is DESTRUCTIVE — never re-join while watching)
  useEffect(() => {
    if (!useWatchParty.getState().inParty && roomId) joinParty(roomId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // desktop: the box has focus at open (type / paste right away); phones: not (no on-screen keyboard popping up)
  useEffect(() => {
    if (mobile) return;
    const t = window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // volume / mute (only for you), remembered with an 800 ms debounce
  useEffect(() => {
    player.current?.setVolume(Math.round(volume));
    player.current?.setMuted(muted);
    const t = window.setTimeout(() => {
      setPref("watchparty-volume", String(Math.round(volume)));
      setPref("watchparty-muted", muted);
    }, 800);
    return () => window.clearTimeout(t);
  }, [volume, muted]);

  const loadCurrent = (force = false) => {
    if (!force && nowUrl === loadedUrl.current) return;
    loadedUrl.current = nowUrl;
    eofSeen.current = false;
    sawPlayback.current = false;
    loadStartedAt.current = Date.now();
    setPlaybackError("");
    setBuffering(false);
    setBlocked(false);
    setPos(0);
    setDur(0);
    if (!nowUrl || nowUrl.startsWith("tinhat-memory://")) player.current?.stop();
    else player.current?.load(nowUrl);
  };
  useEffect(() => loadCurrent(), [nowUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // mirror the shared play/pause into the player
  useEffect(() => {
    if (!nowUrl) return;
    if (isPlaying) player.current?.play();
    else player.current?.pause();
    pausedSince.current = 0;
    setBlocked(false);
  }, [isPlaying, nowUrl]);

  // remote drift corrections → this surface (never a tinhat-memory clock)
  useEffect(
    () =>
      onDesiredSeek((p, url) => {
        if (url.startsWith("tinhat-memory://") || !loadedUrl.current || loadedUrl.current.startsWith("tinhat-memory://")) return;
        let x = Number.isFinite(p) && p >= 0 ? p : 0;
        const d = player.current?.duration() ?? 0;
        if (d > 0 && x > d) x = Math.max(0, d - 0.5);
        player.current?.seek(x);
      }),
    [],
  );

  // 120 ms poll while something plays: position/duration → reportPosition, EOF latch, load watchdog, autoplay block
  useEffect(() => {
    if (!nowUrl || nowUrl.startsWith("tinhat-memory://")) return;
    const t = window.setInterval(() => {
      const p = player.current;
      if (!p) return;
      const tp = p.time();
      if (Number.isFinite(tp)) {
        setPos(tp);
        if (tp > 0) sawPlayback.current = true;
        reportPosition(tp);
      }
      const d = p.duration();
      if (Number.isFinite(d)) setDur(d);
      if (Number.isFinite(d) && d > 0) sawPlayback.current = true;
      if (!sawPlayback.current && !eofSeen.current && !pausedSince.current && Date.now() - loadStartedAt.current > 20000) {
        setPlaybackError((e) => e || "Playback failed — couldn't load this video. Press Retry.");
      }
      const st2 = useWatchParty.getState();
      if (st2.playback?.playing && p.isPaused()) {
        if (!pausedSince.current) pausedSince.current = Date.now();
        else if (Date.now() - pausedSince.current > 1500 && Date.now() - loadStartedAt.current > 1500) setBlocked(true);
      } else {
        pausedSince.current = 0;
        setBlocked(false);
      }
    }, 120);
    return () => window.clearInterval(t);
  }, [nowUrl]);

  const onEnded = () => {
    if (eofSeen.current) return;
    eofSeen.current = true;
    const s2 = useWatchParty.getState();
    if (!s2.amAdvancer) return;
    const next = nextQueueUrl(s2.party.queue, s2.playback?.url ?? "");
    if (next) playUrl(next);
  };

  // ---- §2 what OTHERS do: the playback state event's SENDER (never me; never the advancer's drift writes) ------------
  const pbEvents = useRoomStateEvents(st.inParty ? partyRoom : "", PLAYBACK_EVENT);
  const pbEv = pbEvents.find((e) => e.stateKey === "");
  const lastPb = useRef<{ id: string; snap: PbSnap | null } | null>(null);
  useEffect(() => {
    if (!st.inParty) {
      lastPb.current = null;
      return;
    }
    const id = pbEv?.eventId ?? "";
    const snap = pbEv ? normPlayback(pbEv.content) : null;
    const prev = lastPb.current;
    lastPb.current = { id, snap };
    if (!prev || prev.id === id) return; // the first clock seen after joining shows nothing
    const sender = pbEv?.sender ?? "";
    const ch = remoteChange(prev.snap, snap, sender, myId);
    if (!ch) return;
    const name = memberName(partyRoom, sender);
    if (ch.kind === "paused") showOsd("media-playback-pause", `${name} paused`);
    else if (ch.kind === "played") showOsd("media-playback-start", `${name} pressed play`);
    else if (ch.kind === "jumped") showOsd("media-skip-forward", `${name} jumped to ${fmtTime(ch.at)}`);
    else {
      const it = normParty(getState(partyRoom, WP_EVENT, "")).queue.find((q) => q.url === ch.url);
      const by = it?.addedBy ? ` · added by ${it.addedBy === myId ? "you" : memberName(partyRoom, it.addedBy)}` : "";
      showOsd("video-television-symbolic", `Now playing: ${it?.title || ch.url}${by}`);
    }
  }, [pbEv?.eventId, st.inParty]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- fullscreen (F / double-click / the button): the window body; the transport fades 2.5 s after the pointer rests
  useEffect(() => {
    const on = () => {
      const el = root.current;
      setFullscreen(!!document.fullscreenElement && !!el && document.fullscreenElement.contains(el));
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      try {
        (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.();
      } catch {
        /* best effort */
      }
      return;
    }
    void el
      .requestFullscreen?.()
      .then(() => {
        // phones: landscape while fullscreen, best effort (catch + ignore)
        if (mobile) void (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      })
      .catch(() => toast("Fullscreen isn't available here"));
  }, [mobile]);
  const poke = useCallback(() => {
    setChromeIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setChromeIdle(true), 2500);
  }, []);
  useEffect(() => {
    if (!fullscreen) {
      setChromeIdle(false);
      window.clearTimeout(idleTimer.current);
      return;
    }
    poke();
    return () => window.clearTimeout(idleTimer.current);
  }, [fullscreen, poke]);

  // ---- theater (T, remembered) and the mini player (I) ------------------------------------------------------------
  const toggleTheater = useCallback(() => {
    if (mobile || mini) return;
    setTheater((t) => {
      setPref("watchparty-theater", !t);
      return !t;
    });
  }, [mobile, mini]);
  const enterMini = useCallback(() => {
    if (mobile || mini) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const outerH = MINI.h + MINI.title;
    const px = Number(getPref("watchparty-mini-x", NaN));
    const py = Number(getPref("watchparty-mini-y", NaN));
    const x = Number.isFinite(px) ? px : vw - MINI.w - MINI.margin;
    const y = Number.isFinite(py) ? py : vh - outerH - MINI.margin;
    win.setFloating({
      x,
      y,
      w: MINI.w,
      h: outerH,
      onTop: true,
      onMove: (nx, ny) => {
        setPref("watchparty-mini-x", nx);
        setPref("watchparty-mini-y", ny);
      },
    });
    win.raise();
    setMini(true);
    setKeysOpen(false);
  }, [mobile, mini, win]);
  const leaveMini = useCallback(() => {
    win.setFloating(null);
    setMini(false);
    setMiniHover(false);
  }, [win]);

  // ---- the window's own actions (window:watchParty context, ACTIONS.md §14.1) ------------------------------------
  const next = nextQueueUrl(queue, nowUrl);
  const togglePlay = (osdToo = false) => {
    if (!nowUrl || !st.inParty) return;
    if (!canControl) {
      if (osdToo) denyOsd();
      return;
    }
    const want = desiredClock();
    if (want && want.url === nowUrl ? want.playing : isPlaying) {
      player.current?.pause();
      pause();
      if (osdToo) showOsd("media-playback-pause", "Paused");
    } else {
      player.current?.play();
      play();
      if (osdToo) showOsd("media-playback-start", "Playing");
    }
  };
  const seekTo = (x0: number) => {
    const d = player.current?.duration() ?? dur;
    let x = Math.max(0, x0);
    if (d > 0) x = Math.min(x, Math.max(0, d - 0.5));
    player.current?.seek(x);
    seek(x);
    setPos(x);
    return x;
  };
  const seekBy = (secs: number, osdToo = false) => {
    if (!nowUrl || !st.inParty || isMemory) return;
    if (!canControl) return osdToo ? denyOsd() : undefined;
    seekTo((player.current?.time() ?? pos) + secs);
    if (osdToo) showOsd(secs < 0 ? "media-skip-backward" : "media-skip-forward", `${secs < 0 ? "−" : "+"}${Math.abs(secs)} s`);
  };
  const jumpPct = (pct: number) => {
    if (!nowUrl || !st.inParty || isMemory) return;
    if (!canControl) return denyOsd();
    const d = player.current?.duration() ?? dur;
    if (!(d > 0)) return;
    const x = seekTo((d * pct) / 100);
    showOsd("media-skip-forward", `Jumped to ${fmtTime(x)}`);
  };
  const volumeOsd = (v: number, m: boolean) => showOsd(m || v === 0 ? "audio-volume-muted-symbolic" : v < 50 ? "audio-volume-low-symbolic" : "audio-volume-high-symbolic", m || v === 0 ? "Muted" : `Volume ${Math.round(v)} %`);
  const nudgeVolume = (step: number) => {
    const v = Math.max(0, Math.min(100, Math.round(volume / 5) * 5 + step));
    setVolume(v);
    const m = muted && step > 0 ? false : muted;
    if (m !== muted) setMuted(m);
    volumeOsd(v, m);
  };
  const toggleMute = (osdToo = false) => {
    setMuted((m) => !m);
    if (osdToo) showOsd(muted ? "audio-volume-high-symbolic" : "audio-volume-muted-symbolic", muted ? "Unmuted" : "Muted");
  };
  const runWindowAction = (id: string, ctx?: { subject?: string; params?: Record<string, string> }): boolean => {
    switch (id) {
      case "watchParty.playPause":
        togglePlay();
        return true;
      case "watchParty.next":
        if (canControl && next) playUrl(next);
        return true;
      case "watchParty.mute":
        setMuted((m) => !m);
        return true;
      case "watchParty.host.toggle":
        if (st.inParty) assignHost(amHost ? "" : myId);
        return true;
      case "watchParty.queue": {
        const url = ctx?.subject ?? "";
        if (!url) return true;
        if (ctx?.params?.op === "playNow") {
          if (canControl) playUrl(url);
        } else enqueue(url, ctx?.params?.title ?? "");
        return true;
      }
    }
    return false;
  };

  // ---- §2 the video surface: click (deferred 250 ms) = play/pause, double-click = fullscreen, wheel = my volume ------
  const clickTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  const onSurfaceClick = (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = 0;
      if (blocked) return startBlocked();
      togglePlay(true);
    }, CLICK_DEFER_MS);
  };
  const onSurfaceDouble = () => {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = 0;
    toggleFullscreen();
  };
  const wheelAcc = useRef(0);
  const volRef = useRef({ volume, muted, nudge: nudgeVolume });
  volRef.current = { volume, muted, nudge: nudgeVolume };
  useEffect(() => {
    const el = catcher.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const notch = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
      wheelAcc.current += notch;
      let steps = 0;
      while (wheelAcc.current <= -1) {
        wheelAcc.current += 1;
        steps += 1;
      }
      while (wheelAcc.current >= 1) {
        wheelAcc.current -= 1;
        steps -= 1;
      }
      if (steps) volRef.current.nudge(steps * 5);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, []);
  const startBlocked = () => {
    player.current?.play();
    setBlocked(false);
    pausedSince.current = 0;
  };

  // ---- §4 keys ------------------------------------------------------------------------------------------------
  const boxEscape = () => {
    if (useBrowse.getState().suggestions.length) clearSuggestions();
    else if (query) {
      setQuery("");
      setAddNote("");
    } else {
      search.current?.blur();
      root.current?.focus({ preventScroll: true });
    }
  };
  const runShortcut = (sc: MpShortcut) => {
    switch (sc.op) {
      case "playPause":
        return togglePlay(true);
      case "seek":
        return seekBy(sc.secs ?? 0, true);
      case "jump":
        return jumpPct(sc.pct ?? 0);
      case "volume":
        return nudgeVolume(sc.step ?? 0);
      case "mute":
        return toggleMute(true);
      case "next":
        if (!st.inParty || !next) return;
        if (!canControl) return denyOsd();
        return void playUrl(next);
      case "fullscreen":
        return toggleFullscreen();
      case "theater":
        return toggleTheater();
      case "mini":
        return mini ? leaveMini() : enterMini();
      case "search":
        // the box lives in the side column: leave fullscreen / the mini player / theater first (as the desktop does)
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        if (mini) leaveMini();
        if (theaterOn) toggleTheater();
        window.setTimeout(() => search.current?.focus({ preventScroll: false }), 0);
        return;
      case "help":
        return setKeysOpen((o) => !o);
      case "escape":
        return;
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    // a menu / popup portalled out of the window bubbles here through React — not ours
    if (!root.current?.contains(t)) return;
    const k = keyName(e);
    if (keysOpen && (k === "Escape" || k === "?")) {
      e.preventDefault();
      e.stopPropagation();
      setKeysOpen(false);
      return;
    }
    const inBox = t === search.current;
    const typing = !!t.closest("input, textarea, [contenteditable=true]");
    if (k === "Escape") {
      if (t.closest("[role=menu], [role=listbox]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (inBox) return boxEscape(); // never closes the window
      if (document.fullscreenElement) toggleFullscreen();
      else if (mini) leaveMini();
      else win.close();
      return;
    }
    if (typing || !k || e.defaultPrevented) return;
    const sc = shortcutFor(k);
    if (!sc) return;
    e.preventDefault();
    runShortcut(sc);
  };

  // ---- §1 the divider: drag resizes the side panel, double-click resets ---------------------------------------
  const divDrag = useRef<{ x0: number; w0: number } | null>(null);
  const onDividerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    divDrag.current = { x0: e.clientX, w0: sideW };
  };
  const onDividerMove = (e: React.PointerEvent) => {
    const d = divDrag.current;
    if (!d) return;
    setSideWant(clampSide(d.w0 - (e.clientX - d.x0), size.w));
  };
  const onDividerUp = () => {
    if (!divDrag.current) return;
    divDrag.current = null;
    setPref("watchparty-side-w", sideW);
  };
  const resetSide = () => {
    setSideWant(SIDE_W.def);
    setPref("watchparty-side-w", SIDE_W.def);
  };

  // ---- the one box: a URL adds (Enter / the Add button), words search ----------------------------------------------
  const pasted = parseMediaLink(query);
  const isLink = pasted.kind !== "text";
  const submitLink = async (playNow: boolean) => {
    if (!isLink || adding) return;
    setAdding(true);
    setAddNote("");
    try {
      const r = await addLink(query, { playNow });
      setCard(null);
      if (r.status === "queued" || r.status === "playing") {
        setQuery("");
        toast(r.status === "playing" ? `Playing ${r.item.title || "now"}` : `Added to the queue${r.item.title ? ` — ${r.item.title}` : ""}`);
      } else if (r.status === "card") {
        setCard({ link: r.link, meta: r.meta, message: r.message });
        setAddNote("");
      } else if (r.status === "search") {
        if (watchOn) setTab(browseTab === "music" ? "music" : "search");
        else setAddNote("Paste a link to a video or song — searching isn't available on this server.");
      } else if (r.status === "browse") {
        setTab("playlists");
      } else setAddNote(r.message);
    } finally {
      setAdding(false);
    }
  };

  const shownPos = scrubbing ?? pos;
  const scrubTo = dur > 0 ? dur : Math.max(600, pos + 60);
  const controlTip = !canControl && st.inParty ? `Only the host (${hostName}) controls playback` : isPlaying ? "Pause for everyone (Space)" : "Play for everyone (Space)";
  const badge = nowItem ? serviceLabel(nowItem.source?.service, nowItem.kind) : "";
  const subtitle = nowItem ? [nowItem.artist, nowItem.durationSec ? fmtTime(nowItem.durationSec) : dur > 0 ? fmtTime(dur) : ""].filter(Boolean).join(" · ") : "";
  const chromeShown = !fullscreen || !chromeIdle;
  const timeText = remaining && dur > 0 ? `−${fmtTime(Math.max(0, dur - shownPos))} / ${fmtTime(dur)}` : fmtTime(shownPos) + (dur > 0 ? ` / ${fmtTime(dur)}` : "");
  const toggleRemaining = () =>
    setRemaining((r) => {
      setPref("watchparty-time-remaining", !r);
      return !r;
    });
  const shareToChat = () => {
    if (!nowItem || !partyRoom) return;
    const link = nowItem.source?.url || nowItem.url;
    const what = [nowItem.title || nowItem.url, nowItem.artist].filter(Boolean).join(" — ");
    void sendMessage(partyRoom, { msgtype: "m.text", body: `🎬 Media Party: ${what}\n${link}` })
      .then(() => toast("Shared to the chat"))
      .catch(() => toast("Couldn't share to the chat"));
  };
  const onScrubMoved = (v: number) => setScrubbing(v);
  const onScrubRelease = (v: number) => {
    setScrubbing(null);
    player.current?.seek(v);
    seek(v);
  };

  return (
    <div
      ref={root}
      className={cx(s.keyRoot, mobile && s.mobile, touch && s.touch, wide ? s.wide : s.stacked, theaterOn && s.theater, fullscreen && s.fs, mini && s.mini, fullscreen && !chromeShown && s.chromeHidden, mini && (miniHover || keysOpen) && s.miniHover)}
      style={{ ["--side-w" as string]: `${sideW}px` }}
      tabIndex={-1}
      onKeyDown={onKey}
      onPointerMove={fullscreen ? poke : undefined}
      onPointerEnter={mini ? () => setMiniHover(true) : undefined}
      onPointerLeave={mini ? () => setMiniHover(false) : undefined}
      data-testid="mp-window"
      data-layout={mini ? "mini" : fullscreen ? "fullscreen" : theaterOn ? "theater" : wide ? "wide" : "stacked"}
    >
      <ScrollArea className={s.scroll} contentClassName={s.scroller} alwaysOn={!wide && !theaterOn && !mini && !fullscreen}>
        <div className={s.layout}>
          <div className={s.stage} data-testid="mp-stage">
            <div className={cx(s.header, s.chrome)}>
              <Heading level={1} className={s.heading}>
                Media Party
              </Heading>
              <span className={s.spacer} />
              {st.inParty && <span className={s.dimSmall}>{`${st.viewers.length} watching${st.amAdvancer ? " · you sync" : ""}${hostId ? ` · host: ${amHost ? "you" : hostName}` : ""}`}</span>}
              {st.inParty && (
                <ToolButton
                  iconName="user-identity"
                  label={amHost ? "Release host" : hostId ? "Take over as host" : "Become host"}
                  tip={amHost ? "Let anyone drive playback again" : "Only the host can play, pause, seek and skip; everyone can still queue"}
                  className={s.hostBtn}
                  onClick={() => runWindowAction("watchParty.host.toggle")}
                />
              )}
            </div>

            {st.error && <div className={cx(s.error, s.chrome)}>{st.error}</div>}

            {/* now playing header (DESIGN §2.3) */}
            {nowItem && !isMemory && (
              <div className={cx(s.nowPlaying, s.chrome)} data-testid="mp-now-playing">
                <span className={s.npArt}>{nowItem.art ? <img src={nowItem.art} alt="" referrerPolicy="no-referrer" draggable={false} /> : <Icon name="video-television-symbolic" size={22} color="var(--th-watchparty-empty-icon)" />}</span>
                <span className={s.npText}>
                  <span className={s.npTitle}>{nowItem.title || nowItem.url}</span>
                  {subtitle && <span className={s.npSub}>{subtitle}</span>}
                </span>
                {nowItem.addedBy && <UserChip roomId={partyRoom} userId={nowItem.addedBy} />}
                {badge && <span className={s.badge}>{badge}</span>}
                {nowItem.source && nowItem.source.service !== "youtube" && (
                  <Button text={openInLabel(nowItem.source.service)} onClick={() => window.open(nowItem.source!.url, "_blank", "noopener,noreferrer")} />
                )}
                <ToolButton iconName="document-share-symbolic" iconSize={16} tip="Share to chat" className={s.rowBtn} onClick={shareToChat} />
              </div>
            )}

            <div className={s.videoBox} data-testid="mp-video">
              <div className={s.surface}>
                <WatchPlayer
                  ref={player}
                  className={s.player}
                  onEnded={onEnded}
                  onPlaying={() => {
                    sawPlayback.current = true;
                    setPlaybackError(""); // errors clear on the next success
                  }}
                  onBuffering={setBuffering}
                  onError={(m) => setPlaybackError(m)}
                />
                {/* the YouTube iframe swallows pointer events: this catcher takes the clicks / double-clicks / wheel; it
                    sits under the click-to-start button and the error overlay, which stay clickable */}
                <div ref={catcher} className={s.catcher} onClick={onSurfaceClick} onDoubleClick={onSurfaceDouble} data-testid="mp-catcher" />
                {!nowUrl && (
                  <div className={s.center}>
                    <EmptyState iconName="video-television-symbolic" title="Nothing playing" explanation={mini ? "" : "Paste a link or search below, then pick what to play."} className={s.empty} />
                  </div>
                )}
                {isMemory && (
                  <div className={s.center}>
                    <Icon name="camera-video-symbolic" size={44} color="var(--th-watchparty-empty-icon)" />
                    <div className={s.centerText}>A synced Memories replay is playing — it plays in the Memories window.</div>
                  </div>
                )}
                {buffering && nowUrl && !playbackError && (
                  <div className={cx(s.center, s.buffering)} data-testid="mp-buffering">
                    <BusyIndicator size={36} color="var(--th-watchparty-busy-fg)" />
                    <div className={s.centerText}>Buffering…</div>
                  </div>
                )}
                {playbackError && nowUrl && !isMemory && (
                  <div className={cx(s.center, s.failure)}>
                    <Icon name="dialog-warning" size={40} color="var(--th-watchparty-failure-icon)" />
                    <div className={s.errorText}>{playbackError}</div>
                    <GlowButton text="Retry" onClick={() => loadCurrent(true)} />
                  </div>
                )}
                {blocked && !playbackError && (
                  <button type="button" className={s.clickToPlay} onClick={startBlocked}>
                    <Icon name="media-playback-start" size={22} color="var(--th-watchparty-click-to-play-fg)" />
                    <span>Click to start playback</span>
                  </button>
                )}
                {osd && (
                  <div key={osd.id} className={cx(s.osd, osd.out && s.osdOut)} role="status" data-testid="mp-osd">
                    <Icon name={osd.icon} size={16} color="var(--th-watchparty-click-to-play-fg)" />
                    <span className={s.osdText}>{osd.text}</span>
                  </div>
                )}
                {mini && (
                  <div className={s.miniBar} data-testid="mp-mini-transport">
                    <ToolButton iconName={isPlaying ? "media-playback-pause" : "media-playback-start"} iconSize={18} disabled={!canControl || !nowUrl} tip={controlTip} className={s.tbtn} onClick={() => togglePlay()} />
                    <ToolButton iconName={muted || volume === 0 ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"} iconSize={18} tip={muted ? "Unmute (M)" : "Mute (M)"} className={s.tbtn} onClick={() => toggleMute()} />
                    <ScrubBar className={s.scrub} pos={shownPos} dur={dur} to={scrubTo} disabled={!canControl || !nowUrl} onMoved={onScrubMoved} onRelease={onScrubRelease} />
                    <button type="button" className={s.time} onClick={toggleRemaining} title="Elapsed / time left">
                      {timeText}
                    </button>
                    <ToolButton iconName="media-skip-forward" iconSize={18} disabled={!canControl || !next} tip="Play next in queue (N)" className={s.tbtn} onClick={() => runWindowAction("watchParty.next")} />
                    <ToolButton iconName="window-duplicate-symbolic" iconSize={18} checked tip="Back to the full window (I)" className={s.tbtn} onClick={leaveMini} />
                  </div>
                )}
              </div>
            </div>

            <div className={cx(s.transport, s.transportBar)} onPointerEnter={fullscreen ? poke : undefined} data-testid="mp-transport">
              <ToolButton iconName={isPlaying ? "media-playback-pause" : "media-playback-start"} disabled={!canControl || !nowUrl} tip={controlTip} className={s.tbtn} onClick={() => togglePlay()} />
              <ToolButton iconName={muted || volume === 0 ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"} tip={muted ? "Unmute the video (only for you) (M)" : "Mute the video (only for you) (M)"} className={s.tbtn} onClick={() => toggleMute()} />
              {!narrow && (
                <Slider
                  className={s.vol}
                  value={volume}
                  from={0}
                  to={100}
                  aria-label="Volume"
                  onMoved={(v) => {
                    setVolume(v);
                    if (muted && v > 0) setMuted(false);
                  }}
                />
              )}
              <ScrubBar className={s.scrub} pos={shownPos} dur={dur} to={scrubTo} disabled={!canControl || !nowUrl} onMoved={onScrubMoved} onRelease={onScrubRelease} />
              <button type="button" className={s.time} onClick={toggleRemaining} title={remaining ? "Show the elapsed time" : "Show the time left"} data-testid="mp-time">
                {timeText}
              </button>
              <ToolButton iconName="media-skip-forward" disabled={!canControl || !next} tip="Play next in queue (N)" className={s.tbtn} onClick={() => runWindowAction("watchParty.next")} />
              {!mobile && <ToolButton iconName="window-symbolic" checked={theaterOn} tip={theaterOn ? "Leave theater (T)" : "Theater (T)"} className={s.tbtn} onClick={toggleTheater} />}
              {!mobile && <ToolButton iconName="window-duplicate-symbolic" tip="Mini player (I)" className={s.tbtn} onClick={enterMini} />}
              <ToolButton iconName={fullscreen ? "view-restore-symbolic" : "view-fullscreen-symbolic"} tip={fullscreen ? "Leave fullscreen (F)" : "Fullscreen (F)"} className={s.tbtn} onClick={toggleFullscreen} />
              {!mobile && <ToolButton iconName="input-keyboard-symbolic" checked={keysOpen} tip="Keys (?)" className={s.tbtn} onClick={() => setKeysOpen((o) => !o)} />}
            </div>

            {st.inParty && st.viewers.length > 0 && (
              <div className={cx(s.watching, s.chrome)} data-testid="mp-watching">
                <span className={s.dimSmall}>Watching</span>
                {st.viewers.map((v) => (
                  <UserChip key={v.userId} roomId={partyRoom} userId={v.userId} host={!!hostId && v.userId === hostId} />
                ))}
              </div>
            )}

            <div className={cx(s.joinRow, s.chrome)}>
              <GlowButton
                text={st.inParty ? "Leave Media Party" : "Join Media Party"}
                icon={st.inParty ? "system-log-out-symbolic" : "media-playlist-append"}
                onClick={() => {
                  if (st.inParty) {
                    player.current?.stop();
                    loadedUrl.current = "";
                    leaveParty();
                  } else if (partyRoom) joinParty(partyRoom);
                }}
              />
              <span className={s.spacer} />
              {!st.inParty && <span className={s.dimSmall}>Join to sync playback with the room.</span>}
            </div>
          </div>

          {twoCols && (
            <div
              className={s.divider}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the side panel (double-click resets)"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
              onDoubleClick={resetSide}
              data-testid="mp-divider"
            />
          )}

          <ScrollArea className={s.side} contentClassName={s.sideScroller} data-testid="mp-side">
            <div className={s.sideCol}>
              {!wide && <div className={s.sep} />}
              <QueueList roomId={partyRoom} queue={queue} nowUrl={nowUrl} inParty={st.inParty} canControl={canControl} hostName={hostName} touch={touch || mobile} labels={(twoCols ? sideW : size.w) - 16 >= 470} notify={showOsd} />

              <div className={s.sep} />
              <div className={s.searchRow}>
                <BasicTextField
                  ref={search}
                  className={s.search}
                  placeholder={watchOn ? "Paste a link, or search YouTube…" : "Paste a link…"}
                  value={query}
                  data-testid="mp-box"
                  onFocus={(e) => {
                    if (!mobile) return;
                    const el = e.currentTarget;
                    window.setTimeout(() => el.scrollIntoView({ block: "start", behavior: animate() ? "smooth" : "auto" }), 350);
                  }}
                  onChange={(e) => {
                    const v = e.target.value;
                    setQuery(v);
                    setAddNote("");
                    const l = parseMediaLink(v);
                    if (l.kind === "text") {
                      if (!watchOn) return; // no search on this server: words wait for a link
                      if (browseTab !== "search" && browseTab !== "music") setTab("search");
                      suggest(v);
                    } else {
                      clearSuggestions();
                      if (l.kind === "playlist" || l.kind === "channel") setTab("playlists");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      clearSuggestions();
                      if (isLink) void submitLink(false);
                    }
                  }}
                />
                {isLink && pasted.kind !== "playlist" && pasted.kind !== "channel" && <Button text="Add" highlighted disabled={adding} onClick={() => void submitLink(false)} />}
                {isLink && pasted.kind !== "playlist" && pasted.kind !== "channel" && <Button text="Play now" disabled={adding || !canControl} onClick={() => void submitLink(true)} />}
                {adding && <BusyIndicator size={27} color="var(--th-watchparty-busy-fg)" />}
              </div>
              {addNote && <div className={cx(s.dimSmall, s.addNote)}>{addNote}</div>}
              {card && <SongCard card={card} onClose={() => setCard(null)} />}
              <BrowsePane
                roomId={partyRoom}
                canControl={canControl}
                inParty={st.inParty}
                watch={watchOn}
                query={isLink ? "" : query}
                link={pasted}
                queue={queue}
                onPick={(t) => {
                  setQuery(t);
                  search.current?.focus({ preventScroll: true });
                }}
              />
            </div>
          </ScrollArea>
        </div>
      </ScrollArea>
      {keysOpen && <KeysCard onClose={() => setKeysOpen(false)} />}
    </div>
  );
}

/** The scrub bar: the Slider + the time under the pointer while hovering (QOL §3); a press on the track jumps there
 *  (the Slider's own press → move → release path, host-gated by `disabled`). */
function ScrubBar({ pos, dur, to, disabled, className, onMoved, onRelease }: { pos: number; dur: number; to: number; disabled: boolean; className?: string; onMoved: (v: number) => void; onRelease: (v: number) => void }) {
  const [tip, setTip] = useState<{ x: number; t: number } | null>(null);
  return (
    <div
      className={cx(s.scrubWrap, className)}
      onPointerMove={(e) => {
        if (!(dur > 0) || e.pointerType === "touch") return;
        const r = e.currentTarget.getBoundingClientRect();
        const avail = r.width - 12 - 28;
        const p = Math.max(0, Math.min(1, (e.clientX - r.left - 6 - 14) / Math.max(1, avail)));
        setTip({ x: Math.max(18, Math.min(r.width - 18, e.clientX - r.left)), t: p * to });
      }}
      onPointerLeave={() => setTip(null)}
    >
      <Slider className={s.scrubSlider} value={pos} from={0} to={to} disabled={disabled} aria-label="Position" onMoved={onMoved} onRelease={onRelease} />
      {tip && (
        <span className={s.scrubTip} style={{ left: tip.x }} data-testid="mp-scrub-tip">
          {fmtTime(tip.t)}
        </span>
      )}
    </div>
  );
}

/** The keys card (? / the Keys button): the shared table grouped Playback · Sound · View · Queue; closes on Esc, a click
 *  outside it, or ? again. */
function KeysCard({ onClose }: { onClose: () => void }) {
  return (
    <div className={s.keysScrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()} data-testid="mp-keys">
      <div className={s.keysCard} role="dialog" aria-label="Media Party keys">
        <div className={s.keysHead}>
          <span className={s.keysTitle}>Keys</span>
          <span className={s.spacer} />
          <ToolButton iconName="window-close-symbolic" iconSize={16} tip="Close (Esc)" className={s.rowBtn} onClick={onClose} />
        </div>
        <div className={s.keysGrid}>
          {MP_KEY_GROUPS.map((g) => (
            <div key={g.title} className={s.keysGroup}>
              <div className={s.keysGroupTitle}>{g.title}</div>
              {g.rows.map((r) => (
                <div key={r.keys} className={s.keysRow}>
                  <span className={s.keysKeys}>
                    {r.keys.split(" / ").map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className={s.keysSlash}>/</span>}
                        <kbd className={s.kbd}>{k}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className={s.keysLabel}>{r.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className={s.keysNote}>Keys work while the window has focus — never while typing in the box (Esc there clears it).</div>
      </div>
    </div>
  );
}

/** A song (or album / playlist) that stays a card (DESIGN §2.5): art · title · artist · source badge · Open in … ·
 *  Preview 30 s (Apple's preview url) · the reason it was not queued. */
function SongCard({ card, onClose }: { card: { link: MediaLink; meta: LinkMeta | null; message: string }; onClose: () => void }) {
  const { link, meta, message } = card;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const title = meta?.title || link.input;
  const badge = serviceLabel(link.service);
  const preview = meta?.preview ?? "";
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a.play().then(() => setPlaying(true)).catch(() => toast("Couldn't play the preview"));
    }
  };
  return (
    <div className={cx(s.nowPlaying, s.songCard)} data-testid="mp-song-card">
      <span className={s.npArt}>{meta?.thumb ? <img src={meta.thumb} alt="" referrerPolicy="no-referrer" draggable={false} /> : <Icon name="emblem-music-symbolic" size={22} color="var(--th-watchparty-empty-icon)" />}</span>
      <span className={s.npText}>
        <span className={s.npTitle}>{title}</span>
        {(meta?.artist || meta?.album) && <span className={s.npSub}>{[meta?.artist, meta?.album].filter(Boolean).join(" · ")}</span>}
        <span className={s.npSub}>{message}</span>
      </span>
      {badge && <span className={s.badge}>{badge}</span>}
      {preview && (
        <>
          <audio ref={audio} src={preview} preload="none" onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
          <Button text={playing ? "Stop preview" : "Preview 30 s"} icon={playing ? "media-playback-stop" : "media-playback-start"} onClick={toggle} />
        </>
      )}
      <Button text={openInLabel(link.service)} highlighted onClick={() => window.open(link.input, "_blank", "noopener,noreferrer")} />
      <ToolButton iconName="window-close-symbolic" iconSize={16} tip="Dismiss" className={s.rowBtn} onClick={onClose} />
    </div>
  );
}

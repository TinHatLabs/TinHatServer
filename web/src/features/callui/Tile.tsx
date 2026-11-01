// Tile.tsx — one call tile (Main.qml:6240-7260): backing + placeholder, the <video> with the native
// zoom/pan/fill geometry (video_bridge.cpp applyVideoGeometry), frame + speaking ring, name strip
// (mic / server-mute / game-chat / aside / hear marks, name, 9-bar waveform), away overlay,
// tuned-in / not-listening pills, the hover button row, zoom pill, r.tileOverlays, context menu,
// adaptive receive (size steering + visibility pauses).
import { enterShareFullscreen, type FsHandle } from "./fullscreen";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useRegistry } from "@/core/registry";
import { peekClient, useUserProfile } from "@/core/matrix";
import { Avatar, Icon, avatarSeed, localpart, meterDriver, useIsTouch, useTip } from "@/ui";
import { winFocused } from "@/core/winstate";
import { act, callStore, getC, isShareTile, SELF_ID, tileMxid, tileName, ui, useC, useCallUi, type Tile as TileT } from "./store";
import { defaultMode, hideTileRemember, loadView, saveView, setSelfViewMode, type ViewMode } from "./memory";
import { REASON_ABOUT_ME, REASON_ABOUT_THEM, snap } from "./hear";
import { openPip } from "./Pip";
import { StreamMenu } from "./menus";
import type { Slot } from "./layout";
import s from "./Tile.module.css";

export interface TileProps {
  tile: TileT;
  slot: Slot;
  hidden: boolean;
  chrome: boolean;
  watched: boolean;
  pinned: boolean;
  animate: boolean;
  afkGrid: boolean;
  roomId: string;
  selfPipMode: "pip" | "grid";
  fake: boolean;
  mobile?: boolean;
  /** mobile grid: tiles flow in CSS (no absolute slot) */
  flow?: boolean;
  /** Pad QOL: a host that runs full screen itself (the Pad's Watch box keeps its own buttons over the share) */
  onFullscreen?: () => void;
  /** that host's full-screen state (the ⛶ shows "Leave full screen") */
  fullscreen?: boolean;
}

function levelKey(identity: string) {
  return `${identity}|mic`;
}

/** A tile's picture (selfhost/firstrun item 6): the person's colour — their Matrix id, never the LiveKit identity with
 *  its device part, so it matches chat, the room list and the DM header; your own tile your initial and colour (it
 *  drew "Y" for "You" in the colour of the word "You"). */
function TileAvatar({ self, name, participant, avatar, size }: { self: boolean; name: string; participant: string; avatar: string; size: number }) {
  if (self) return <SelfTileAvatar avatar={avatar} size={size} />;
  return <Avatar name={name} seed={avatarSeed(participant)} imageSource={avatar || null} size={size} />;
}

function SelfTileAvatar({ avatar, size }: { avatar: string; size: number }) {
  const me = peekClient()?.getUserId() ?? "";
  const prof = useUserProfile(me || null);
  return <Avatar name={prof.displayName || localpart(me)} seed={avatarSeed(me)} imageSource={avatar || prof.avatarUrl || null} size={size} />;
}

export const Tile = memo(function Tile(p: TileProps) {
  const { tile, slot } = p;
  const self = tile.id === SELF_ID;
  const share = isShareTile(tile);
  const mxid = self ? "" : tileMxid(tile.participant);
  const name = tileName(tile);
  const w = p.flow ? 0 : slot.w;
  const h = p.flow ? 0 : slot.h;
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ w: slot.w, h: slot.h });
  const cw = p.flow ? size.w : w;
  const ch = p.flow ? size.h : h;
  const [hov, setHov] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number }>(() => {
    const t = tile as TileT & { vidW?: number; vidH?: number };
    return { w: t.vidW || 0, h: t.vidH || 0 };
  });
  const [hasFrame, setHasFrame] = useState(false);
  const [view, setView] = useState<{ z: number; px: number; py: number; mode: ViewMode }>({ z: 1, px: 0, py: 0, mode: defaultMode(tile) });
  const restored = useRef(false);
  const saveTimer = useRef(0);
  const [streamMenu, setStreamMenu] = useState<HTMLElement | null>(null);
  const overlays = useRegistry("tileOverlays");

  const micMuted = useC("micMuted");
  const serverMutedMe = useC("serverMuted");
  const serverMutedByMe = useC("serverMutedBy");
  const gameChat = useC("gameChat");
  const gcPeers = useC("gameChatPeers");
  const corner = useC("corner");
  const hearRaw = useC("hear");
  const awayUsers = useC("awayUsers");
  const localAfk = useC("localAfk");
  const recFlags = useC("recOnlyFlags");
  const srs = useC("sameRoom");
  const inCall = useC("inCall");
  const popped = useCallUi((x) => x.pips.some((pp) => pp.tileId === tile.id));

  // flow mode measures itself
  useLayoutEffect(() => {
    if (!p.flow || !rootRef.current) return;
    const el = rootRef.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.flow]);

  // ---- video attach (stable across roster changes: keyed by id in the parent) ----
  useEffect(() => {
    const el = videoRef.current;
    act("attachVideo")(tile.id, el);
    return () => act("attachVideo")(tile.id, null);
  }, [tile.id]);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const upd = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setNat({ w: el.videoWidth, h: el.videoHeight });
        setHasFrame(true);
      }
    };
    const gone = () => setHasFrame(false);
    el.addEventListener("loadedmetadata", upd);
    el.addEventListener("resize", upd);
    el.addEventListener("emptied", gone);
    upd();
    return () => {
      el.removeEventListener("loadedmetadata", upd);
      el.removeEventListener("resize", upd);
      el.removeEventListener("emptied", gone);
    };
  }, []);
  // restore view memory once the natural size is known
  useEffect(() => {
    if (restored.current || nat.w <= 0 || self) return;
    restored.current = true;
    setView(loadView(tile));
  }, [nat.w, tile, self]);

  // ---- adaptive receive (CUI-160) ----
  const visible = !p.hidden && cw > 0 && ch > 0;
  useEffect(() => {
    if (self || p.fake) return;
    if (popped) return void act("setTileVideoHidden")(tile.id, false); // a PiP holds it: never SFU-paused
    act("setTileVideoHidden")(tile.id, !visible);
    if (!visible) return;
    const iv = window.setInterval(() => act("setTileVideoHidden")(tile.id, false), 5000);
    return () => window.clearInterval(iv);
  }, [visible, popped, self, tile.id, p.fake]);
  // GPU.md §2.11 (B17): a tile that goes away (the phone's call minimised to the pill, the call collapsed) releases its
  // video at the SFU — unless a pop-out window still shows it; a remount shows it again (the effect above)
  useEffect(
    () => () => {
      if (self || p.fake) return;
      if (!ui().pips.some((pp) => pp.tileId === tile.id)) act("setTileVideoHidden")(tile.id, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tile.id],
  );
  useEffect(() => {
    if (self || p.fake || !visible) return;
    const dpr = window.devicePixelRatio || 1;
    const t = window.setTimeout(() => act("setTileVideoSize")(tile.id, Math.round(cw * dpr), Math.round(ch * dpr)), 400);
    return () => window.clearTimeout(t);
  }, [cw, ch, visible, self, tile.id, p.fake]);

  // ---- view geometry ----
  const vw = nat.w,
    vh = nat.h;
  const known = vw > 0 && vh > 0 && cw > 0 && ch > 0;
  const coverRatio = known ? Math.max(cw / vw, ch / vh) / Math.min(cw / vw, ch / vh) : 1;
  const fill = view.mode === "fill" ? true : view.mode === "fit" ? false : coverRatio <= 1.35;
  const minZoom = fill ? 1 / coverRatio : 1;
  const fitScale = known ? Math.min(cw / vw, ch / vh) : 0;
  const base = known ? (fill ? Math.max(cw / vw, ch / vh) : fitScale) : 0;
  const viewScale = base * Math.max(minZoom, Math.min(6, view.z));
  const zoomPercent = fitScale > 0 ? Math.round((viewScale / fitScale) * 100) : 100;
  const overflowX = viewScale > 0 ? Math.max(0, (vw * viewScale - cw) / 2) : 0;
  const overflowY = viewScale > 0 ? Math.max(0, (vh * viewScale - ch) / 2) : 0;
  let videoStyle: CSSProperties = { left: 0, top: 0, width: "100%", height: "100%", objectFit: "contain" };
  if (known) {
    const iw = Math.round(vw * viewScale),
      ih = Math.round(vh * viewScale);
    const ox = Math.max(0, (iw - cw) / 2),
      oy = Math.max(0, (ih - ch) / 2);
    videoStyle = { left: Math.round((cw - iw) / 2 - view.px * ox), top: Math.round((ch - ih) / 2 - view.py * oy), width: iw, height: ih, objectFit: "fill" };
  }
  // View memory: zoom/pan save 600 ms later, reset / mode save now and cancel a pending save (else the
  // older value would land on top); a pending save is flushed when the tile unmounts.
  const pending = useRef<{ tile: TileT; v: typeof view } | null>(null);
  const saveLater = useCallback(
    (v: typeof view) => {
      window.clearTimeout(saveTimer.current);
      pending.current = { tile, v };
      saveTimer.current = window.setTimeout(() => {
        pending.current = null;
        saveView(tile, v);
      }, 600);
    },
    [tile],
  );
  const saveNow = (v: typeof view) => {
    window.clearTimeout(saveTimer.current);
    pending.current = null;
    saveView(tile, v);
  };
  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      const pnd = pending.current;
      if (pnd) saveView(pnd.tile, pnd.v);
    },
    [],
  );
  const zoomBy = (f: number) => {
    setView((v) => {
      // clamp to the current bounds first (a fill-mode zoom < 1 kept after switching to fit)
      const cur = Math.max(minZoom, Math.min(6, v.z));
      const z = Math.max(minZoom, Math.min(6, cur * f));
      const n = z <= minZoom + 0.001 ? { ...v, z, px: 0, py: 0 } : { ...v, z };
      saveLater(n);
      return n;
    });
  };
  const resetView = () => {
    const n = { ...view, z: 1, px: 0, py: 0 };
    setView(n);
    saveNow(n);
  };
  const setMode = (m: ViewMode) => {
    const n = { ...view, mode: m, z: Math.max(0.01, Math.min(6, view.z)) };
    setView(n);
    saveNow(n);
  };
  // Ctrl+wheel zoom (non-passive so preventDefault works)
  useEffect(() => {
    const el = rootRef.current;
    if (!el || self) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  // drag to pan
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (overflowX <= 0 && overflowY <= 0)) return;
    drag.current = { x: e.clientX, y: e.clientY, px: view.px, py: view.py };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({
      ...v,
      px: overflowX > 0 ? Math.max(-1, Math.min(1, d.px - (e.clientX - d.x) / overflowX)) : 0,
      py: overflowY > 0 ? Math.max(-1, Math.min(1, d.py - (e.clientY - d.y) / overflowY)) : 0,
    }));
  };
  const onPointerUp = () => {
    if (drag.current) {
      drag.current = null;
      saveLater(view);
    }
  };

  // ---- marks ----
  const hear = snap(hearRaw);
  const peerHear = !self && hear ? hear.peers[tile.participant] : undefined;
  const isMuted = self ? micMuted || serverMutedMe : tile.muted || tile.serverMuted;
  const smBy = self ? (serverMutedMe ? serverMutedByMe : "") : tile.serverMuted ? tile.serverMutedBy : "";
  const smOn = self ? serverMutedMe : tile.serverMuted;
  const inGameChat = self ? gameChat && !micMuted : gcPeers.peers.some((pp) => tileMxid(pp) === mxid || pp === tile.participant);
  const gcMutedForMe = !self && gcPeers.muted.some((pp) => tileMxid(pp) === mxid || pp === tile.participant);
  const myCorner = corner.mine && corner.corners[corner.mine] ? corner.corners[corner.mine] : [];
  const inMyCorner = !self && myCorner.some((m) => m === tile.participant || tileMxid(m) === mxid);
  const theirCorner = !self ? Object.entries(corner.corners).find(([, ms]) => ms.some((m) => m === tile.participant || tileMxid(m) === mxid)) : undefined;
  const asideMark = self ? corner.active : !!theirCorner;
  const asideTip = self
    ? `You're aside with ${myCorner.filter((m) => m !== "You" && tileMxid(m) !== (peekClient()?.getUserId() ?? "")).map((m) => nameOf(m)).join(", ") || "them"}`
    : inMyCorner
      ? "Aside with you"
      : `Pulled aside with ${(theirCorner?.[1] ?? []).filter((m) => m !== tile.participant).map((m) => nameOf(m)).join(", ") || "someone"} — you don't hear their mic. Right-click to join them`;
  const away = self ? localAfk : awayUsers.includes(mxid);
  const deafMark = !self && !share && !!peerHear && (peerHear.deaf || peerHear.away);
  const notRecv = !self && !share && !!peerHear && !micMuted && peerHear.notMe !== "" && peerHear.notMe !== undefined;
  const cantHear = !self && !share && !!peerHear && ["silent", "noaudio", "nokey", "stalled"].includes(peerHear.iHear);
  const echo = !self && !share && !!peerHear?.echo;
  // Same room (11.3): linked people share one voice; the dot = whose mic is the room's live mic right now
  const srGroup = share ? null : self ? (srs.linked.length ? { m: [...srs.linked, "You"], mic: srs.live ? "You" : srs.holder } : null) : (srs.groups[tile.participant] ?? null);
  const srMark = !!srGroup;
  const srLive = !!srGroup && (self ? srs.live : srGroup.mic === tile.participant);
  const srOthers = srGroup ? srGroup.m.filter((m) => m !== (self ? "You" : tile.participant)).map((m) => (m === "You" ? "you" : nameOf(m))) : [];
  const srTip = self
    ? `You're in a room with ${srOthers.join(", ")} — Tin Hat sends one voice from your room${srLive ? " (your mic is the room mic right now)" : " (their mic is the room mic right now)"}`
    : `${name} is in a room with ${srOthers.join(", ")} — Tin Hat sends one voice from their room${srLive ? " (their mic is live right now)" : ""}`;
  const [recOnly, tunedIn] = recFlags[tile.id] ?? [!!tile.recordingOnly, !!tile.tunedIn];
  const glyphCount = (isMuted ? 1 : 0) + (inGameChat ? 1 : 0) + (asideMark ? 1 : 0) + (srMark ? 1 : 0) + (deafMark ? 1 : 0) + (notRecv ? 1 : 0) + (cantHear ? 1 : 0) + (echo ? 2 : 0);

  // ---- buttons ----
  const btnShown = (minW: number, minH = 60) => cw > minW && ch > minH;
  const chromeOn = p.chrome || p.mobile;
  const btnOpacity = (on: boolean) => (!chromeOn ? 0 : hov || on ? 1 : 0.5);
  const waveVisible = cw > 120;
  // Native reserves a fixed 60 px for glyphs + 70 px for the zoom pill (Main.qml:6660), so "alex" elides
  // to "al…" on a 212 px strip tile that has neither (docs/native-bugs/callui.md). The web reserves what
  // is actually there: 22 px per shown glyph, the waveform, and the zoom pill only when it can appear.
  const zoomRoom = !self && known && !p.mobile && cw > 140 ? 78 : 8;

  const openMenu = (anchor: { x: number; y: number } | { x: number; y: number; width: number; height: number }) => {
    if (self) return;
    ui().set({ volMenu: { mxid, identity: tile.participant, name, anchor } });
  };

  const rootStyle: CSSProperties = p.flow
    ? {}
    : {
        left: slot.x,
        top: slot.y,
        width: slot.w,
        height: slot.h,
        zIndex: slot.pip ? 20 : 0,
        // the tile move takes the `long` duration step (GPU.md §1: one duration token; was 260 ms) — it snaps whenever
        // the motion switch is off (tokens.css)
        transition: p.animate && !p.hidden ? ["left", "top", "width", "height"].map((k) => `${k} var(--th-dur-long) cubic-bezier(0.33,1,0.68,1)`).join(", ") : "none",
      };
  const avatarSize = Math.max(56, Math.min(320, Math.round(Math.min(ch * 0.55, cw * 0.42))));
  const lp = useRef<number>(0);
  const lpFired = useRef(false);
  // Pad QOL (2026-10-31): full screen for a share on a phone (fullscreen.ts: element → iPhone's video player → fill)
  const [fsh, setFsh] = useState<FsHandle | null>(null);
  const fshRef = useRef<FsHandle | null>(null);
  const alive = useRef(true);
  const isFs = p.onFullscreen ? !!p.fullscreen : !!fsh;
  const toggleFs = () => {
    if (p.onFullscreen) return p.onFullscreen();
    if (fshRef.current) {
      fshRef.current.exit();
      fshRef.current = null;
      setFsh(null);
      return;
    }
    const el = rootRef.current;
    if (!el) return;
    void enterShareFullscreen(el, videoRef.current, () => {
      fshRef.current = null;
      if (alive.current) setFsh(null);
    }).then((h) => {
      if (!alive.current) return h.exit(); // the tile went away while it was entering: undo it
      fshRef.current = h;
      setFsh(h);
    });
  };
  // the share ending (the tile going away) leaves full screen and puts the layout back
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      fshRef.current?.exit();
      fshRef.current = null;
    };
  }, []);
  useEffect(() => () => window.clearTimeout(lp.current), []);

  return (
    <div
      ref={rootRef}
      className={`${s.tile} ${p.flow ? s.flow : ""} ${p.hidden ? s.hiddenTile : ""} ${fsh?.mode === "fill" ? s.fill : fsh?.mode === "element" ? s.fsEl : ""}`}
      style={rootStyle}
      data-tile={tile.id}
      onPointerEnter={() => setHov(true)}
      onPointerLeave={() => setHov(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY });
      }}
      onTouchStart={(e) => {
        window.clearTimeout(lp.current);
        lpFired.current = false;
        const t0 = e.touches[0];
        const x = t0.clientX,
          y = t0.clientY;
        lp.current = window.setTimeout(() => {
          lpFired.current = true;
          openMenu({ x, y });
        }, 500);
      }}
      onTouchMove={() => window.clearTimeout(lp.current)}
      onTouchEnd={(e) => {
        window.clearTimeout(lp.current);
        // The sheet opened under the finger: without this the release's synthetic click lands on
        // whichever row now sits there (Message / Pull aside …) and fires it + closes the sheet.
        if (lpFired.current) e.preventDefault();
        lpFired.current = false;
      }}
      onTouchCancel={() => window.clearTimeout(lp.current)}
      aria-label={share ? `${name} — screen` : name}
    >
      <div className={s.backing}>
        {!hasFrame &&
          (share ? (
            <div className={s.waiting}>
              <Icon name="monitor-symbolic" size={44} color="var(--th-tile-waiting-fg)" />
              <span>Waiting for the first frame…</span>
            </div>
          ) : (
            <TileAvatar self={self} name={name} participant={tile.participant} avatar={tile.avatar} size={p.flow ? Math.max(56, Math.min(160, Math.round(Math.min(size.h * 0.55, size.w * 0.42)))) : avatarSize} />
          ))}
        <video ref={videoRef} className={s.video} style={{ ...videoStyle, visibility: hasFrame ? "visible" : "hidden" }} autoPlay playsInline muted />
      </div>
      <div className={s.viewLayer} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={() => !self && resetView()} style={{ cursor: overflowX > 0 || overflowY > 0 ? "grab" : undefined }} />
      <div className={s.nameStrip}>
        <div className={s.nameRow}>
          {isMuted && (
            <MarkIcon name="microphone-sensitivity-muted-symbolic" color="var(--th-tile-mic-off-icon)" tip={smOn ? `Muted by ${smBy || "a moderator"}` : undefined}>
              {smOn && (
                <span className={s.shield}>
                  <Icon name="security-high-symbolic" size={10} color="var(--th-tile-mic-off-icon)" />
                </span>
              )}
            </MarkIcon>
          )}
          {smOn && cw > 330 && <span className={s.smPill}>Muted by {smBy || "a moderator"}</span>}
          {inGameChat && (
            <MarkIcon
              name="audio-input-microphone-symbolic"
              color="var(--th-tile-game-chat-icon)"
              tip={self ? "You're in game chat" : gcMutedForMe ? "In game chat with you — you hear each other in-game, so their mic is muted here" : "In the game's voice chat"}
            />
          )}
          {asideMark && <MarkIcon name="audio-input-microphone-symbolic" color="var(--th-tile-aside-icon)" tip={asideTip} />}
          {srMark && <MarkIcon name="audio-input-microphone-symbolic" color={srLive ? "var(--th-tile-same-room-live)" : "var(--th-tile-same-room-icon)"} tip={srTip} />}
          {deafMark && (
            <MarkIcon
              name="headphones-symbolic"
              color="var(--th-tile-deafened-icon)"
              tip={peerHear!.deaf ? `${name} is deafened — they can't hear anyone right now` : `${name} is away — they can't hear the call right now`}
            >
              <span className={s.strike} />
            </MarkIcon>
          )}
          {notRecv && <MarkIcon name="audio-volume-muted-symbolic" color="var(--th-tile-not-receiving-icon)" tip={`${name} isn't receiving you — ${REASON_ABOUT_ME[peerHear!.notMe] ?? REASON_ABOUT_ME.other}`} />}
          {cantHear && (
            <MarkIcon
              name="dialog-warning"
              color="var(--th-tile-cant-hear-icon)"
              tip={`You can't hear ${name} — ${REASON_ABOUT_THEM[peerHear!.iHear] ?? ""}. Click to repair.`}
              onClick={() => act("healPeerAudio")(tile.participant)}
            />
          )}
          {echo && <EchoChip name={name} lag={peerHear!.echo!.lag} room={!!(peerHear!.echo as { room?: boolean }).room} />}
          <span className={s.name} style={{ maxWidth: Math.max(40, cw - 8 - glyphCount * 22 - (smOn && cw > 330 ? 130 : 0) - (waveVisible ? 49 : 0) - zoomRoom) }}>
            {share ? `${name} — screen` : name}
          </span>
          {waveVisible && <Waveform identity={self ? "__self" : tile.participant} muted={isMuted} />}
        </div>
      </div>
      <Frame identity={self ? "__self" : tile.participant} self={self} muted={isMuted} />
      {away && (
        <div className={s.away}>
          <span style={{ fontSize: `${Math.max(20, Math.round((p.flow ? size.h : ch) * 0.18))}pt` }}>💤</span>
        </div>
      )}
      {share && recOnly && tunedIn && cw > 160 && (
        <div className={s.tunedPill}>
          <span className={s.tunedText}>{cw <= 430 ? "● tuned in" : "● recording-only · tuned in"}</span>
          <span className={s.tunedLeave} onClick={() => act("setTileTunedIn")(tile.id, false)}>
            Leave
          </span>
        </div>
      )}
      {share && !p.watched && cw > 220 && !p.hidden && (
        <button className={s.notListening} style={{ top: `calc(${recOnly && tunedIn ? 36 : 6}px + var(--fs-safe-top, 0px))` }} onClick={() => ui().set({ listen: [...ui().listen, tile.id] })}>
          <Icon name="audio-volume-muted-symbolic" size={14} color="var(--th-tile-not-listening-fg)" />
          {cw > 430 && <span>not listening · click to listen</span>}
        </button>
      )}
      {/* buttons */}
      {self && !localAfk && btnShown(100, 50) && (
        <TileBtn tileW={cw}
          right={6}
          icon={p.selfPipMode === "pip" ? "view-fullscreen-symbolic" : "view-restore-symbolic"}
          tip={p.selfPipMode === "pip" ? "Show my camera as a normal tile" : "Shrink my camera into a corner"}
          opacity={btnOpacity(false)}
          chrome={!!chromeOn}
          onClick={() => setSelfViewMode(p.selfPipMode === "pip" ? "grid" : "pip")}
        />
      )}
      {/* phones: a share's first slot is Full screen (there are no pop-out windows on a phone) */}
      {!self && !p.fake && share && p.mobile && btnShown(80) && (
        <TileBtn tileW={cw} right={6} icon={isFs ? "view-restore-symbolic" : "view-fullscreen-symbolic"} tip={isFs ? "Leave full screen" : "Full screen"} on={isFs} opacity={1} chrome onClick={toggleFs} />
      )}
      {/* desktop layouts: Full screen on a share (the desktop app's CallIsland ⛶ at the same slot) */}
      {!self && !p.fake && share && !p.mobile && btnShown(370) && (
        <TileBtn tileW={cw} right={210} icon={isFs ? "view-restore-symbolic" : "view-fullscreen-symbolic"} tip={isFs ? "Leave full screen" : "Full screen"} on={isFs} opacity={btnOpacity(isFs)} chrome={!!chromeOn} onClick={toggleFs} />
      )}
      {!self && !p.fake && !(share && p.mobile) && btnShown(80) && (
        <TileBtn tileW={cw} right={6} icon="window-new" tip="Pop out into its own window" opacity={btnOpacity(false)} chrome={!!chromeOn} onClick={() => openPip(tile)} />
      )}
      {!self && btnShown(80) && (
        <TileBtn tileW={cw}
          right={40}
          icon="layer-visible-off-symbolic"
          tip={share ? "Hide this screen share (they keep sharing) — remembered for future calls" : "Hide this tile (they stay in the call) — remembered for future calls"}
          opacity={btnOpacity(false)}
          chrome={!!chromeOn}
          onClick={() => hideTileRemember(tile)}
        />
      )}
      {!self && btnShown(120) && (
        <TileBtn tileW={cw}
          right={74}
          icon="monitor-symbolic"
          tip={streamMenu ? undefined : "Stream controls (quality · volume · mute)"}
          opacity={btnOpacity(!!streamMenu)}
          chrome={!!chromeOn}
          onClick={(el) => setStreamMenu(streamMenu ? null : el)}
        />
      )}
      {!self && btnShown(160) && (
        <TileBtn tileW={cw}
          right={108}
          icon="window-pin-symbolic"
          tip={p.pinned ? "Unpin" : "Pin as the main view"}
          on={p.pinned}
          opacity={btnOpacity(p.pinned)}
          chrome={!!chromeOn}
          onClick={() => ui().set({ pinned: p.pinned ? null : tile.id })}
        />
      )}
      {!self && share && btnShown(200) && (
        <TileBtn tileW={cw}
          right={142}
          icon="headphones-symbolic"
          tip={ui().listen.includes(tile.id) ? "Listening — click to stop" : p.watched ? "You hear this stream (you're watching it)" : "Listen to this stream"}
          on={p.watched}
          opacity={btnOpacity(p.watched)}
          chrome={!!chromeOn}
          onClick={() => toggleListen(tile.id)}
        />
      )}
      {!self && btnShown(330) && (
        <TileBtn tileW={cw}
          right={176}
          icon="overflow-menu-symbolic"
          tip="More — their volume, pull aside…"
          opacity={btnOpacity(false)}
          chrome={!!chromeOn}
          onClick={(el) => {
            const r = el.getBoundingClientRect();
            openMenu({ x: r.left, y: r.bottom, width: 0, height: 0 });
          }}
        />
      )}
      {!self && known && chromeOn && (hov || view.z !== 1) && cw > 140 && ch > 60 && (
        <ZoomPill
          percent={Math.round(zoomPercent / 5) * 5}
          atFloor={view.z <= minZoom + 0.001}
          atMax={view.z >= 5.999}
          hovered={hov}
          onMinus={() => zoomBy(1 / 1.15)}
          onPlus={() => zoomBy(1.15)}
          onReset={resetView}
        />
      )}
      {overlays.map((o) => (
        <div key={o.id} className={s.overlay}>
          <o.component identity={self ? getC().speakers.me : tile.participant} userId={self ? "" : mxid} kind={share ? "screen" : tile.kind === "avatar" ? "avatar" : "camera"} local={self} roomId={p.roomId} />
        </div>
      ))}
      {streamMenu && (
        <StreamMenu
          tile={tile}
          anchor={streamMenu}
          onClose={() => setStreamMenu(null)}
          watched={p.watched}
          view={view.mode}
          viewChanged={view.z !== 1 || view.px !== 0 || view.py !== 0}
          onMode={setMode}
          onReset={resetView}
        />
      )}
      {!inCall && null}
    </div>
  );
});

function nameOf(identity: string): string {
  const tiles = getC().tiles;
  const mx = tileMxid(identity);
  const t = tiles.find((x) => x.participant === identity) ?? tiles.find((x) => tileMxid(x.participant) === mx);
  return t?.name || (mx.startsWith("@") ? mx.slice(1).split(":")[0] : mx);
}

export function toggleListen(id: string) {
  const l = ui().listen;
  ui().set({ listen: l.includes(id) ? l.filter((x) => x !== id) : [...l, id] });
}

function MarkIcon({ name, color, tip, children, onClick }: { name: string; color: string; tip?: string; children?: React.ReactNode; onClick?: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, tip, { delay: 300 });
  return (
    <span ref={ref} className={s.mark} style={{ cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
      <Icon name={name} size={16} color={color} />
      {children}
    </span>
  );
}

function EchoChip({ name, lag, room }: { name: string; lag: number; room: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(
    ref,
    room
      ? `${name}'s mic picks up your voice in the room — everyone else hears you twice (their app has been told)`
      : `You hear yourself through ${name}'s mic, about ${lag} ms later — their app has been told how to fix it`,
    { delay: 300 },
  );
  return (
    <span ref={ref} className={s.echo}>
      echo
    </span>
  );
}

function TileBtn(p: { right: number; tileW: number; icon: string; tip?: string; on?: boolean; opacity: number; chrome: boolean; onClick: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const touch = useIsTouch();
  useTip(ref, p.chrome ? p.tip : undefined, { delay: 400 });
  // Touch: 44 px targets (ARCHITECTURE mobile rules) on the same slots, spaced 48 px instead of 34;
  // a slot that no longer fits the tile is dropped instead of overlapping its neighbour.
  const right = touch ? 6 + Math.round((p.right - 6) / 34) * 48 : p.right;
  if (touch && p.tileW > 0 && right + 44 + 6 > p.tileW) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={p.tip}
      className={`${s.tbtn} ${p.on ? s.tbtnOn : ""}`}
      style={{ right: `calc(${right}px + var(--fs-safe-right, 0px))`, opacity: p.opacity, pointerEvents: p.chrome ? "auto" : "none" }}
      tabIndex={p.chrome ? 0 : -1}
      onClick={(e) => {
        e.stopPropagation();
        p.onClick(e.currentTarget);
      }}
    >
      <Icon name={p.icon} size={16} color={p.on ? "var(--th-tile-button-icon-active)" : "var(--th-tile-button-icon)"} />
    </button>
  );
}

function ZoomPill(p: { percent: number; atFloor: boolean; atMax: boolean; hovered: boolean; onMinus: () => void; onPlus: () => void; onReset: () => void }) {
  return (
    <div className={s.zoomPill} style={{ opacity: p.hovered ? 1 : 0.65 }} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className={s.zbtn} style={{ opacity: p.atFloor ? 0.35 : 1 }} onClick={p.onMinus} aria-label="Zoom out">
        −
      </button>
      <span className={s.zpct} onDoubleClick={p.onReset}>
        {p.percent}%
      </span>
      <button type="button" className={s.zbtn} style={{ opacity: p.atMax ? 0.35 : 1 }} onClick={p.onPlus} aria-label="Zoom in">
        +
      </button>
    </div>
  );
}

// ---- speaking: frame ring + waveform, both driven by a 30 Hz tick outside React --------------------

function levelFor(identity: string): number {
  const st = getC();
  if (identity === "__self") return st.micMuted ? 0 : st.micLevel || 0;
  return st.audioLevels[levelKey(identity)] ?? 0;
}

/** The speaking ring (GPU.md §2.7): lit on a speaking edge (a 450 ms off-hold) while the window is focused; static —
 *  unlit — while it isn't (the engine's level loop stops then, and the ring ignores any level). */
function Frame({ identity, self, muted }: { identity: string; self: boolean; muted: boolean }) {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    let off = 0;
    // start from the current level (a restart — e.g. on mute — must not leave the ring lit)
    let cur = !muted && winFocused() && levelFor(identity) > 0.02;
    setLit(cur);
    const unsub = callStore.subscribe(() => {
      const lv = muted || !winFocused() ? 0 : levelFor(identity);
      if (lv > 0.02) {
        window.clearTimeout(off);
        off = 0;
        if (!cur) {
          cur = true;
          setLit(true);
        }
      } else if (cur && !off) {
        off = window.setTimeout(() => {
          cur = false;
          off = 0;
          setLit(false);
        }, 450);
      }
    });
    return () => {
      unsub();
      window.clearTimeout(off);
    };
  }, [identity, muted]);
  return <div className={s.frame} style={{ border: lit ? "3px solid var(--th-tile-ring-speaking)" : self ? "2px solid var(--th-tile-ring-own)" : "1px solid var(--th-tile-ring)" }} />;
}

/** GPU.md §2.7: the bars move on level changes (≤ 10 updates/s, a short ease that stops at rest) only while the
 *  motion switch is on; flat otherwise. No timer runs while this person is quiet (ui/meter.ts). */
function Waveform({ identity, muted }: { identity: string; muted: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const read = () => (muted ? 0 : levelFor(identity));
    const d = meterDriver(read, (shown, level) => {
      const el = ref.current;
      if (!el) return;
      const speaking = level > 0.02;
      const bars = el.children;
      for (let i = 0; i < bars.length; i++) {
        const bell = 1 - Math.abs(i - 4) * 0.13;
        const ripple = 0.6 + 0.4 * Math.abs(Math.sin(i * 1.3 + level * 22));
        const b = bars[i] as HTMLElement;
        b.style.height = `${2 + Math.min(1, shown) * bell * ripple * 16}px`;
        b.style.background = speaking ? "var(--th-tile-wave-fill-speaking)" : "var(--th-tile-wave-fill)";
        b.style.opacity = speaking ? "0.95" : "0.10";
      }
    });
    const unsub = callStore.subscribe(() => d.wake());
    d.wake();
    return () => {
      unsub();
      d.stop();
    };
  }, [identity, muted]);
  return (
    <span ref={ref} className={s.wave} aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={s.bar} />
      ))}
    </span>
  );
}

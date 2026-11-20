// Mobile.tsx — the phone call (ARCHITECTURE "Mobile layout rules"): a full-screen stage with a
// scrolling tile grid, tap to show/hide the chrome, a bottom call bar (mic, camera, flip camera,
// share only if getDisplayMedia exists, deafen, soundboard, leave), and a draggable minimised call
// pill over the chat. The per-person menu and every popover present as bottom sheets.
import { Fragment, cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRoomName } from "@/core/matrix";
import { openRoom, toast } from "@/core/bus";
import { Icon, Menu, MenuItem, CheckMenuItem, MenuSeparator } from "@/ui";
import { useBackToClose } from "@/ui/backStack";
import { act, isRecorderTile, isShareTile, SELF_ID, SELF_SHARE_ID, ui, useC, useCallUi } from "./store";
import { useHiddenSet, useHideMemorySync, useWatchedPush, useWatchedShares, useHiddenWindowPause, useSelfViewMode } from "./memory";
import { CallButton } from "./CallButton";
import { Tile } from "./Tile";
import { CallOptionsPopover, StreamPopover, HealthPopup, GamePopup } from "./popovers";
import { VolMenuHost, DevicesMenu, HiddenMenu } from "./menus";
import { useSlotItems } from "./CallBar";
import { MIN_SCALE_MOUSE } from "./barfit";
import { ResumeBanner } from "./ResumePill";
import { SameRoomAsk } from "./SameRoomAsk";
import { useUnmuteAsk } from "./UnmuteAsk";
import { callRowSnapshot, recClipRoom } from "@/actions/decisions";
import { useChatStore } from "@/features/chat/store";
import { useActionsSnapshot } from "@/actions/snapshot";
import { Dim, EditableRow, RowButton, bespokeOk, runRowItem, shownItems, useRow } from "@/actions/ui/rowHost";
import { nativeShareOn } from "@/features/native";
import { useFsGhost, usePinCarry } from "./carry";
import { CHROME_IDLE_MS, OPEN_POPUP_SELECTOR, callMenuOpen, chromeAutoHides, isLandscape, phoneCellMaxHeight, phoneOverlay, pillClamp, type Pt, type View } from "./phone";
import s from "./Mobile.module.css";

export function MobileCallStage({ roomId }: { roomId: string }) {
  const min = useCallUi((x) => x.mobileMin);
  const chrome = useCallUi((x) => x.mobileChrome);
  // D02.3: a full-screen share stays mounted through its sharer's blip (carry.ts)
  const { tiles, keyOf } = useFsGhost(useC("tiles"));
  const connecting = useC("connecting");
  const inCall = useC("inCall");
  const fake = useC("fake");
  const localAfk = useC("localAfk");
  const cameraOn = useC("cameraOn");
  const reconnecting = useC("reconnecting");
  const failed = useC("callFailed");
  const failReason = useC("failReason");
  const removedBy = useC("removedBy");
  // media's Rec / Clip ("statusRight" call-bar items) + the REC cue: the phone has no status strip,
  // so they live in the top bar (fix/media wave 2 — they were unreachable on phones)
  const statusRight = useSlotItems("statusRight");
  // 11.4 Media Party: the now-playing strip above the tiles (media's "phoneStrip" item)
  const phoneStrip = useSlotItems("phoneStrip");
  // Rec / Clip act on the call's room — product decision (1), decisions.ts REC_CLIP_ROOM
  const callRoomId = useC("callRoomId");
  const screenRoom = useChatStore((st) => st.mainRoom);
  const recRoom = recClipRoom(callRoomId || roomId, screenRoom) ?? roomId;
  const recActive = useC("recActive");
  const hangingUp = useC("hangingUp");
  const serverMuted = useC("serverMuted");
  const serverMutedBy = useC("serverMutedBy");
  const unmuteAsk = useUnmuteAsk();
  const roomName = useRoomName(roomId);
  const hidden = useHiddenSet();
  const watched = useWatchedShares();
  const pinned = useCallUi((x) => x.pinned);
  usePinCarry(tiles, pinned); // D02.3 (review): the phone layout's pin follows a blip too
  const selfMode = useSelfViewMode();
  useWatchedPush(watched);
  useHideMemorySync();
  useHiddenWindowPause();
  // Phones: what people watch first — shares, then remote cameras, then you, then audio-only people.
  const rank = (t: (typeof tiles)[number]) => (t.id === pinned ? -1 : isShareTile(t) ? 0 : t.id === SELF_ID ? 2 : t.kind === "avatar" ? 3 : 1);
  const gridTiles = tiles
    .filter((t) => t.id !== SELF_SHARE_ID && !isRecorderTile(t) && (!localAfk || t.id === SELF_ID))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
  const visible = gridTiles.filter((t) => !hidden.has(t.id));
  // Your own tile is a "video" tile even with the camera off (native keeps it in the grid as an avatar
  // placeholder); on a phone it sizes like the other audio-only people then, not like a camera.
  const audioOnly = (t: (typeof tiles)[number]) => t.kind === "avatar" || (t.id === SELF_ID && !cameraOn && !localAfk);
  // a share or a camera is on the stage (landscape auto-hide, A37.4)
  const media = visible.some((t) => isShareTile(t) || !audioOnly(t));
  const n = tiles.filter((t) => t.id !== SELF_SHARE_ID).length;
  const [more, setMore] = useState<null | "menu" | "devices" | "health" | "game" | "hidden">(null);
  // A37.3: the full-screen call is a level of the phone back stack, so Back (gesture, browser / Android button)
  // minimises it to the pill like the top-left button, instead of leaving the room page under it
  const minimise = () => ui().set({ mobileMin: true });
  useBackToClose(!min, minimise);
  const [wide, setWide] = useState(() => window.innerWidth >= 700);
  const [landscape, setLandscape] = useState(() => isLandscape(window.innerWidth, window.innerHeight));
  useEffect(() => {
    const f = () => {
      setWide(window.innerWidth >= 700);
      setLandscape(isLandscape(window.innerWidth, window.innerHeight));
    };
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  // A37.4: the tile area's height — in landscape a share / lone / pinned tile takes all of it
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [scrollerH, setScrollerH] = useState(0);
  useEffect(() => {
    if (!scroller) return;
    const f = () => setScrollerH(scroller.clientHeight);
    f();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(f);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller]);
  const cellMax = phoneCellMaxHeight(landscape, scrollerH);
  // A37.4 landscape auto-hide (behaviour change): with a share or a camera on the stage the bars float over the tiles
  // and hide after CHROME_IDLE_MS without a touch; any touch restarts the wait or brings them back; never while a menu,
  // sheet or popover (or a connection / mute / away banner) is open. Portrait is unchanged (tap to show / hide).
  const menus = useCallUi((x) => callMenuOpen({ more, optsFace: x.optsFace, streamPop: x.streamPop, volMenu: x.volMenu, menuHeld: x.menuHeld, soundboardOpen: x.soundboardOpen, ecOpen: x.ecOpen }));
  const overlay = phoneOverlay(landscape, media);
  // a banner in the head (connection, server mute, away, "tap to resume", a same-room ask) holds the chrome too: the
  // head hides as a whole, and one arriving while hidden brings it back (out of the auto-hide case)
  const needsTap = useC("needsTap");
  const sameRoomAsk = useC("sameRoom").ask;
  const alert = reconnecting || failed || serverMuted || localAfk || !!needsTap || !!sameRoomAsk;
  const autoHide = chromeAutoHides(landscape, media, menus || alert);
  const [poke, setPoke] = useState(0);
  const hidByTimer = useRef(false);
  const tapShown = useRef(false);
  useEffect(() => {
    if (chrome) hidByTimer.current = false;
    if (!autoHide || !chrome || min) return;
    const t = window.setTimeout(() => {
      // a popup the store doesn't track (a tile's menu): wait for it to close
      if (document.querySelector(OPEN_POPUP_SELECTOR)) return setPoke((n) => n + 1);
      hidByTimer.current = true;
      ui().set({ mobileChrome: false });
    }, CHROME_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [autoHide, chrome, min, poke]);
  // out of the auto-hide case (turned upright, the share ended, a menu opened): bring back what the timer hid
  useEffect(() => {
    if (!autoHide && hidByTimer.current) {
      hidByTimer.current = false;
      ui().set({ mobileChrome: true });
    }
  }, [autoHide]);
  const onTouch = () => {
    tapShown.current = false;
    if (!autoHide) return;
    if (chrome) return setPoke((n) => n + 1);
    tapShown.current = true; // this touch's own click must not hide them again
    ui().set({ mobileChrome: true });
  };
  const toggleChrome = () => {
    if (tapShown.current) tapShown.current = false;
    else ui().set({ mobileChrome: !chrome });
  };
  if (min) return null;
  // 6-column grid: a share spans the row, cameras sit two per row, audio-only people three per row
  // (a lone tile fills the row, portrait).
  const lone = visible.length <= 1;
  // Nobody on camera and ≤ 4 people: two per row, so the call uses the screen instead of a strip of stamps.
  const allAudio = visible.every((t) => audioOnly(t) && !isShareTile(t)) && visible.length <= 4;
  // Landscape phones and tablets (≥ 700 px): cameras three per row, audio-only people six per row.
  const span = (t: (typeof tiles)[number]) =>
    lone || isShareTile(t) || t.id === pinned ? 6 : audioOnly(t) ? (allAudio ? (wide ? 2 : 3) : wide ? 1 : 2) : wide ? 2 : 3;
  return (
    <div className={`${s.stage} ${overlay ? s.overlay : ""}`} data-testid="mobile-call" onPointerDownCapture={onTouch} onClick={(e) => e.target === e.currentTarget && toggleChrome()}>
      {/* A37.4: the head (top bar, banners, now-playing strip): floats over the tiles in landscape auto-hide (left
          un-indented to keep the diff small) */}
      <div className={overlay ? `${s.head} ${chrome ? "" : s.headHidden}` : s.headFlow}>
      <div className={`${s.top} ${chrome ? "" : s.hideUp}`}>
        <button type="button" className={s.topBtn} aria-label="Minimise the call" onClick={minimise}>
          <Icon name="go-down-symbolic" size={22} color="var(--th-stage-top-button-icon)" />
        </button>
        <div className={s.topText}>
          <div className={s.topTitle}>
            {/* 12.1.13: the desktop strip's rule (and the web's StatusBar): never "In call" after a drop */}
            <span className={s.dot} style={{ background: inCall && !connecting ? "var(--th-call-status-bar-dot-live)" : "var(--th-call-status-bar-dot)" }} />
            {connecting ? "Connecting…" : inCall ? "In call" : reconnecting ? "Reconnecting…" : "Disconnected"}
            {recActive && <span className={s.rec}>· 🔴 REC</span>}
          </div>
          <div className={s.topSub}>
            {roomName} · {n} {n === 1 ? "stream" : "streams"}
          </div>
        </div>
        {hidden.size > 0 && (
          <button type="button" className={s.hiddenChip} onClick={() => setMore("hidden")} data-testid="mobile-hidden-chip">
            {hidden.size} hidden ▾
          </button>
        )}
        {statusRight.map((it) => (
          <it.component key={it.id} roomId={recRoom} />
        ))}
        <button type="button" className={s.topBtn} aria-label="More call options" onClick={() => setMore("menu")} data-testid="mobile-more">
          <Icon name="overflow-menu-symbolic" size={22} color="var(--th-stage-top-button-icon)" />
        </button>
      </div>
      <ResumeBanner className={`${s.banner} ${s.warn}`} />
      {localAfk && (
        <button type="button" className={s.banner} onClick={() => act("setAfk")(false)}>
          💤 You're away (BRB) — tap to return
        </button>
      )}
      {serverMuted && (
        <div className={`${s.banner} ${s.warn}`}>
          {serverMutedBy || "A moderator"} muted your mic for everyone. Ask them to unmute you.
          {/* 12.1.17: the way to ask (rate-limited) */}
          <button type="button" className={s.bannerBtn} disabled={!unmuteAsk.ready} onClick={unmuteAsk.ask} data-testid="unmute-ask">
            {unmuteAsk.label}
          </button>
        </div>
      )}
      <SameRoomAsk />
      {(reconnecting || failed) && (
        <div className={`${s.banner} ${reconnecting ? s.warn : s.bad}`}>
          <b>{reconnecting ? "Reconnecting to the call…" : removedBy ? `${removedBy} disconnected you from the call` : failReason ? "Couldn't join the call" : "Call ended — connection lost"}</b>
          {!reconnecting && (
            <button type="button" className={s.bannerBtn} disabled={hangingUp} onClick={() => act("joinCall")(roomId)}>
              {hangingUp ? "Cleaning up…" : failReason ? "Try again" : "Rejoin"}
            </button>
          )}
        </div>
      )}
      {phoneStrip.map((it) => (
        <it.component key={it.id} roomId={callRoomId || roomId} />
      ))}
      </div>
      <div ref={setScroller} className={s.scroller} onClick={(e) => (e.target as HTMLElement).closest("button") || toggleChrome()}>
        <div className={s.grid} style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
          {gridTiles.map((t) => {
            const isH = hidden.has(t.id);
            const share = isShareTile(t);
            return (
              <div key={keyOf(t)} className={s.cell} style={{ display: isH ? "none" : undefined, gridColumn: `span ${span(t)}`, aspectRatio: share || (lone && wide) ? "16 / 9" : lone ? "3 / 4" : t.id === pinned || (wide && allAudio) ? "4 / 3" : "1 / 1", maxHeight: share || lone || t.id === pinned ? cellMax : undefined, justifySelf: "center", width: "100%" }}>
                <Tile tile={t} slot={{ x: 0, y: 0, w: 0, h: 0 }} flow hidden={isH} chrome={chrome} watched={watched.has(t.id)} pinned={pinned === t.id} animate={false} afkGrid={localAfk} roomId={roomId} selfPipMode={selfMode} fake={fake} mobile />
              </div>
            );
          })}
        </div>
        {gridTiles.length === 0 && (connecting || inCall) && (
          <div className={s.empty}>{connecting ? "Connecting to the call…" : "You're in the call. Turn on your camera or wait for others."}</div>
        )}
      </div>
      <MobileBar roomId={roomId} hide={!chrome} />
      <CallOptionsPopover />
      <StreamPopover anchor={null} />
      <VolMenuHost />
      {/* Menu closes itself right AFTER onTriggered: only clear `more` if no row picked a follow-up sheet
          (before, the close reset the pick, so Game / Stream health / settings / hidden never opened). */}
      <MoreMenu open={more === "menu"} onClose={() => setMore((m) => (m === "menu" ? null : m))} onPick={(k) => setMore(k)} hiddenCount={hidden.size} />
      <DevicesMenu anchor={more === "devices" ? SHEET_ANCHOR : null} onClose={() => setMore(null)} roomId={roomId} />
      <HealthPopup open={more === "health"} onClose={() => setMore(null)} anchor={null} />
      <GamePopup open={more === "game"} onClose={() => setMore(null)} anchor={null} roomId={roomId} />
      <HiddenMenu anchor={more === "hidden" ? SHEET_ANCHOR : null} onClose={() => setMore(null)} hidden={tiles.filter((t) => hidden.has(t.id))} />
    </div>
  );
}

const SHEET_ANCHOR = { x: 0, y: 0, width: 0, height: 0 };

/** Phones: everything the desktop bar has beyond the seven thumb buttons (a bottom sheet). */
function MoreMenu({ open, onClose, onPick, hiddenCount }: { open: boolean; onClose: () => void; onPick: (k: "devices" | "health" | "game" | "hidden") => void; hiddenCount: number }) {
  const gameChat = useC("gameChat");
  const corner = useC("corner");
  const localAfk = useC("localAfk");
  const face = (f: "speaker" | "camera") => ui().set({ optsFace: f, optsAnchor: null, streamPop: false });
  return (
    <Menu open={open} onClose={onClose} anchor={SHEET_ANCHOR} modal title="Call">
      {corner.active ? (
        <MenuItem icon="audio-input-microphone-symbolic" text="Leave the corner — back to everyone" onTriggered={() => act("leaveCorner")()} />
      ) : (
        <CheckMenuItem text="I'm in the game's voice chat" checked={gameChat} onTriggered={() => act("applyGameChat")(!gameChat)} />
      )}
      <CheckMenuItem text="Be right back (BRB)" checked={localAfk} onTriggered={() => act("setAfk")(!localAfk)} />
      <MenuSeparator />
      <MenuItem icon="audio-volume-high-symbolic" text="Speaker & deafen…" onTriggered={() => face("speaker")} />
      <MenuItem icon="camera-video-symbolic" text="Camera options…" onTriggered={() => face("camera")} />
      <MenuItem icon="settings-configure-symbolic" text="Call & device settings…" onTriggered={() => onPick("devices")} />
      <MenuSeparator />
      <MenuItem icon="view-statistics-symbolic" text="Stream health…" onTriggered={() => onPick("health")} />
      <MenuItem icon="applications-games-symbolic" text="Game / join code…" onTriggered={() => onPick("game")} />
      {hiddenCount > 0 && <MenuItem icon="layer-visible-on-symbolic" text={`Hidden streams (${hiddenCount})…`} onTriggered={() => onPick("hidden")} />}
    </Menu>
  );
}

/** 12.1.18 (callbar-1218): the phone bar never folded or scaled, so eight 50 px buttons (406 px) ran past a 360–393 px
 *  screen and cut off Leave. Its buttons now zoom down to the bar's width: CallBar.tsx's phone rule (no More here,
 *  scale 0.7…1). `zoom`, not transform, so the row's layout shrinks with it and each button is hit where it is drawn.
 *  The natural width is measured at zoom 1 (whatever an engine's zoom maths), the property written only when needed. */
function fitPhoneBar(bar: HTMLElement | null) {
  if (!bar) return;
  bar.style.removeProperty("--th-phone-bar-fit");
  const cs = getComputedStyle(bar);
  const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let natural = 0;
  for (const c of bar.children) for (const el of c.hasAttribute("data-button-row") ? c.children : [c]) natural += el.getBoundingClientRect().width;
  if (avail > 0 && natural > avail) bar.style.setProperty("--th-phone-bar-fit", Math.max(MIN_SCALE_MOUSE, avail / natural).toFixed(4));
}

function MobileBar({ roomId, hide }: { roomId: string; hide: boolean }) {
  const micMuted = useC("micMuted");
  const serverMuted = useC("serverMuted");
  const serverMutedBy = useC("serverMutedBy");
  const cameraOn = useC("cameraOn");
  const cameras = useC("cameras");
  const cameraName = useC("cameraName");
  const deafened = useC("deafened");
  const sharing = useC("sharing");
  const hangingUp = useC("hangingUp");
  const optsFace = useCallUi((x) => x.optsFace);
  const items = useSlotItems("controls");
  const sb = items.find((i) => i.order >= 75 && i.order < 85);
  const wp = items.find((i) => i.id === "media-watchparty"); // 11.4 Media Party: media's bespoke button
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === "function" || nativeShareOn();
  const snap = useActionsSnapshot();
  const barSnap = useMemo(() => callRowSnapshot(snap), [snap]);
  const rowCtx = useMemo(() => ({ room: roomId }), [roomId]);
  const row = useRow("call", "phoneBar", { form: "phone", context: rowCtx, snapshot: barSnap });
  const flip = () => {
    if (cameras.length < 2) return toast("Only one camera on this device");
    const i = Math.max(0, cameras.findIndex((c) => c.name === cameraName));
    act("setCamera")(cameras[(i + 1) % cameras.length].id);
  };
  // 11.0 buttons: the phone bar is a row of the actions table (call.phoneBar) — the stored row or the preset's default
  // (today's buttons); share only where the browser can capture the screen (the action's own rule)
  const nodes: Record<string, ReactNode> = {
    "call.mic.toggle": (
      <CallButton
        icon={micMuted || serverMuted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"}
        tip={micMuted ? "Unmute" : "Mute"}
        danger={micMuted || serverMuted}
        hasMenu
        menuOpen={optsFace === "mic"}
        onMenu={(el) => ui().set({ optsFace: optsFace === "mic" ? null : "mic", optsAnchor: el })}
        onClick={() => (serverMuted ? toast(`${serverMutedBy || "A moderator"} muted your mic for everyone`, { timeoutMs: 3000 }) : act("toggleMic")())}
      />
    ),
    "call.camera.toggle": <CallButton icon="camera-video-symbolic" tip={cameraOn ? "Turn camera off" : "Turn camera on"} active={cameraOn} slash={!cameraOn} onClick={() => act("toggleCamera")()} />,
    "call.camera.flip": <CallButton icon="view-refresh-symbolic" tip="Flip camera" live={cameraOn || cameras.length > 1} onClick={flip} />,
    "call.screenShare.toggle": canShare ? <CallButton icon="video-display-brightness-symbolic" tip={sharing ? "Stop sharing" : "Share your screen…"} active={sharing} onClick={() => (sharing ? act("stopScreen")() : nativeShareOn() ? act("shareScreen")() : ui().set({ streamPop: true }))} /> : null,
    "call.deafen.toggle": <CallButton icon={deafened ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"} tip={deafened ? "Undeafen" : "Deafen"} danger={deafened} onClick={() => act("applyDeafen")(!deafened)} />,
    "soundboard.open": sb ? <sb.component roomId={roomId} /> : <CallButton icon="emblem-music-symbolic" tip="Soundboard" onClick={() => toast("The soundboard arrives with the media feature")} />,
    "watchParty.open": wp ? <wp.component roomId={roomId} /> : <CallButton icon="video-television-symbolic" tip="Media Party" onClick={() => toast("The Media Party arrives with the media feature")} />,
    "call.leave": <CallButton icon="call-stop-symbolic" tip="Leave call" danger busy={hangingUp} live={!hangingUp} onClick={() => act("leaveCall")()} />,
  };
  // 12.1.18: the row fits the phone (fitPhoneBar)
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => fitPhoneBar(barRef.current));
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => fitPhoneBar(bar));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={barRef} className={`${s.bar} ${hide ? s.hideDown : ""}`} data-testid="mobile-bar">
      <EditableRow row={row} title="Call controls">
        {shownItems(row).map(({ item: it, i }) => {
          const key = `${it.a}:${i}`;
          if (bespokeOk(row, it) && it.a in nodes) {
            const node = nodes[it.a];
            if (it.state !== "dimmed" || it.a === "call.leave") return <Fragment key={key}>{node}</Fragment>;
            if (isValidElement(node) && node.type === CallButton) return <Fragment key={key}>{cloneElement(node as React.ReactElement<{ live?: boolean }>, { live: false })}</Fragment>;
            return <Dim key={key}>{node}</Dim>;
          }
          const glyph = it.icon ?? it.targetIcon;
          if (row.out.look === "icon" && glyph && !it.emoji && !it.hold && it.known)
            return <CallButton key={key} icon={glyph} tip={it.tip ?? it.label} active={it.active === true} danger={it.danger} live={it.state === "shown"} onClick={(el) => runRowItem(row, it, el)} />;
          return <RowButton key={key} row={row} item={it} />;
        })}
      </EditableRow>
    </div>
  );
}

/** What's visible (the visual viewport: the on-screen keyboard shrinks it), in the pill's fixed coordinates. */
function visibleView(): View {
  const vv = window.visualViewport;
  return vv ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

/** The composer's top edge while one is on screen (the room page), else null. */
function composerTop(): number | null {
  const el = document.querySelector("[data-composer]");
  const r = el?.getBoundingClientRect();
  return r && r.height > 0 ? r.top : null;
}

/** The minimised call: a draggable pill over the chat (tap = back to the call). A37.2: held on screen by its
 *  measured size inside the visual viewport, and above the composer (re-checked on resize / keyboard / room change). */
export function MobileCallPill({ roomId }: { roomId: string }) {
  const micMuted = useC("micMuted");
  const needsTap = useC("needsTap");
  const tiles = useC("tiles");
  const roomName = useRoomName(roomId);
  const [pos, setPos] = useState(() => ({ x: 12, y: Math.max(80, window.innerHeight - 180) }));
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  // `snap`: also keep off the composer (not mid-drag: the pill may pass over it, it snaps above on release)
  const clampTo = (p: Pt, snap = true): Pt => {
    const box = el.current;
    const size = box ? { w: box.offsetWidth, h: box.offsetHeight } : { w: 220, h: 52 };
    const q = pillClamp(p, size, visibleView(), snap ? composerTop() : null);
    return q.x === p.x && q.y === p.y ? p : q;
  };
  const reclamp = useRef(() => {});
  reclamp.current = () => {
    if (!drag.current) setPos((p) => clampTo(p));
  };
  useLayoutEffect(() => {
    const f = () => reclamp.current();
    f();
    const vv = window.visualViewport;
    window.addEventListener("resize", f);
    vv?.addEventListener("resize", f);
    vv?.addEventListener("scroll", f);
    // the pill's own size (its text changes) and the composer's (it grows while typing; a room page comes and goes)
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(f) : null;
    let watched: Element | null = null;
    const watchComposer = () => {
      const c = document.querySelector("[data-composer]");
      if (c === watched) return;
      if (watched) ro?.unobserve(watched);
      watched = c;
      if (c) ro?.observe(c); // observing fires once at once: that's the re-clamp for a new composer
    };
    if (el.current) ro?.observe(el.current);
    watchComposer();
    // the app's router changes rooms without a hashchange: look for a new / gone composer once a second (one query)
    const poll = window.setInterval(() => {
      const c = document.querySelector("[data-composer]");
      if (c === watched) return;
      watchComposer();
      if (!c) f(); // gone: the observer can't tell
    }, 1000);
    return () => {
      window.removeEventListener("resize", f);
      vv?.removeEventListener("resize", f);
      vv?.removeEventListener("scroll", f);
      window.clearInterval(poll);
      ro?.disconnect();
    };
  }, []);
  const n = tiles.filter((t) => t.id !== SELF_SHARE_ID).length;
  return (
    <div
      ref={el}
      className={s.pill}
      style={{ left: pos.x, top: pos.y }}
      data-testid="mobile-call-pill"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-mic]")) return; // the mic toggle handles its own tap
        drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        reclamp.current();
      }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        reclamp.current();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x,
          dy = e.clientY - d.y;
        if (Math.hypot(dx, dy) > 6) d.moved = true;
        if (d.moved) setPos(clampTo({ x: d.px + dx, y: d.py + dy }, false));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) setPos((p) => clampTo(p)); // dropped over the composer: snap above it
        if (d && !d.moved && !(e.target as HTMLElement).closest("[data-mic]")) {
          ui().set({ mobileMin: false });
          if (roomId && !/^#\/room\//.test(location.hash)) openRoom(roomId);
        }
      }}
    >
      <span className={s.dot} style={{ background: "var(--th-call-mini-pill-dot)" }} />
      <span className={s.pillText}>
        {needsTap
          ? needsTap === "mic"
            ? "Mic stopped · tap to turn it on"
            : "Sound paused · tap to resume"
          : ["In call", roomName, `${n} ${n === 1 ? "stream" : "streams"}`].filter(Boolean).join(" · ")}
      </span>
      <button type="button" data-mic className={`${s.pillMic} ${micMuted ? s.pillMicOff : ""}`} aria-label={micMuted ? "Unmute" : "Mute"} onClick={() => act("toggleMic")()}>
        <Icon name={micMuted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"} size={20} color="var(--th-call-mini-pill-mic-icon)" />
      </button>
    </div>
  );
}

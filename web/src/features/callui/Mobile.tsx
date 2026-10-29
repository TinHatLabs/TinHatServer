// Mobile.tsx — the phone call (ARCHITECTURE "Mobile layout rules"): a full-screen stage with a
// scrolling tile grid, tap to show/hide the chrome, a bottom call bar (mic, camera, flip camera,
// share only if getDisplayMedia exists, deafen, soundboard, leave), and a draggable minimised call
// pill over the chat. The per-person menu and every popover present as bottom sheets.
import { Fragment, cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRoomName } from "@/core/matrix";
import { openRoom, toast } from "@/core/bus";
import { Icon, Menu, MenuItem, CheckMenuItem, MenuSeparator } from "@/ui";
import { act, isRecorderTile, isShareTile, SELF_ID, SELF_SHARE_ID, ui, useC, useCallUi } from "./store";
import { useHiddenSet, useHideMemorySync, useWatchedPush, useWatchedShares, useHiddenWindowPause, useSelfViewMode } from "./memory";
import { CallButton } from "./CallButton";
import { Tile } from "./Tile";
import { CallOptionsPopover, StreamPopover, HealthPopup, GamePopup } from "./popovers";
import { VolMenuHost, DevicesMenu, HiddenMenu } from "./menus";
import { useSlotItems } from "./CallBar";
import { ResumeBanner } from "./ResumePill";
import { SameRoomAsk } from "./SameRoomAsk";
import { callRowSnapshot, recClipRoom } from "@/actions/decisions";
import { useChatStore } from "@/features/chat/store";
import { useActionsSnapshot } from "@/actions/snapshot";
import { Dim, EditableRow, RowButton, bespokeOk, runRowItem, shownItems, useRow } from "@/actions/ui/rowHost";
import { nativeShareOn } from "@/features/native";
import s from "./Mobile.module.css";

export function MobileCallStage({ roomId }: { roomId: string }) {
  const min = useCallUi((x) => x.mobileMin);
  const chrome = useCallUi((x) => x.mobileChrome);
  const tiles = useC("tiles");
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
  const roomName = useRoomName(roomId);
  const hidden = useHiddenSet();
  const watched = useWatchedShares();
  const pinned = useCallUi((x) => x.pinned);
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
  const n = tiles.filter((t) => t.id !== SELF_SHARE_ID).length;
  const [more, setMore] = useState<null | "menu" | "devices" | "health" | "game" | "hidden">(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 700);
  useEffect(() => {
    const f = () => setWide(window.innerWidth >= 700);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  if (min) return null;
  // 6-column grid: a share spans the row, cameras sit two per row, audio-only people three per row
  // (a lone tile fills the row, portrait).
  const lone = visible.length <= 1;
  // Your own tile is a "video" tile even with the camera off (native keeps it in the grid as an avatar
  // placeholder); on a phone it sizes like the other audio-only people then, not like a camera.
  const audioOnly = (t: (typeof tiles)[number]) => t.kind === "avatar" || (t.id === SELF_ID && !cameraOn && !localAfk);
  // Nobody on camera and ≤ 4 people: two per row, so the call uses the screen instead of a strip of stamps.
  const allAudio = visible.every((t) => audioOnly(t) && !isShareTile(t)) && visible.length <= 4;
  // Landscape phones and tablets (≥ 700 px): cameras three per row, audio-only people six per row.
  const span = (t: (typeof tiles)[number]) =>
    lone || isShareTile(t) || t.id === pinned ? 6 : audioOnly(t) ? (allAudio ? (wide ? 2 : 3) : wide ? 1 : 2) : wide ? 2 : 3;
  return (
    <div className={s.stage} data-testid="mobile-call" onClick={(e) => e.target === e.currentTarget && ui().set({ mobileChrome: !chrome })}>
      <div className={`${s.top} ${chrome ? "" : s.hideUp}`}>
        <button type="button" className={s.topBtn} aria-label="Minimise the call" onClick={() => ui().set({ mobileMin: true })}>
          <Icon name="go-down-symbolic" size={22} color="var(--th-stage-top-button-icon)" />
        </button>
        <div className={s.topText}>
          <div className={s.topTitle}>
            <span className={s.dot} style={{ background: connecting ? "var(--th-call-status-bar-dot)" : "var(--th-call-status-bar-dot-live)" }} />
            {connecting ? "Connecting…" : "In call"}
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
      {serverMuted && <div className={`${s.banner} ${s.warn}`}>{serverMutedBy || "A moderator"} muted your mic for everyone. Ask them to unmute you.</div>}
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
      <div className={s.scroller} onClick={(e) => (e.target as HTMLElement).closest("button") || ui().set({ mobileChrome: !chrome })}>
        <div className={s.grid} style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
          {gridTiles.map((t) => {
            const isH = hidden.has(t.id);
            const share = isShareTile(t);
            return (
              <div key={t.id} className={s.cell} style={{ display: isH ? "none" : undefined, gridColumn: `span ${span(t)}`, aspectRatio: share || (lone && wide) ? "16 / 9" : lone ? "3 / 4" : t.id === pinned || (wide && allAudio) ? "4 / 3" : "1 / 1", maxHeight: share || lone || t.id === pinned ? "calc(100dvh - 190px)" : undefined, justifySelf: "center", width: "100%" }}>
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
  return (
    <div className={`${s.bar} ${hide ? s.hideDown : ""}`} data-testid="mobile-bar">
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

/** The minimised call: a draggable pill over the chat (tap = back to the call). */
export function MobileCallPill({ roomId }: { roomId: string }) {
  const micMuted = useC("micMuted");
  const needsTap = useC("needsTap");
  const tiles = useC("tiles");
  const roomName = useRoomName(roomId);
  const [pos, setPos] = useState(() => ({ x: 12, y: Math.max(80, window.innerHeight - 180) }));
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  useEffect(() => {
    const f = () => setPos((p) => ({ x: Math.min(p.x, window.innerWidth - 220), y: Math.min(p.y, window.innerHeight - 70) }));
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const n = tiles.filter((t) => t.id !== SELF_SHARE_ID).length;
  return (
    <div
      className={s.pill}
      style={{ left: pos.x, top: pos.y }}
      data-testid="mobile-call-pill"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-mic]")) return; // the mic toggle handles its own tap
        drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerCancel={() => (drag.current = null)}
      onLostPointerCapture={() => (drag.current = null)}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x,
          dy = e.clientY - d.y;
        if (Math.hypot(dx, dy) > 6) d.moved = true;
        if (d.moved) setPos({ x: Math.max(4, Math.min(window.innerWidth - 60, d.px + dx)), y: Math.max(4, Math.min(window.innerHeight - 60, d.py + dy)) });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
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

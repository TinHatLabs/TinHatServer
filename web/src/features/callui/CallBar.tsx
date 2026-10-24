// CallBar.tsx — the control bar (Main.qml:7311-7890): 64 px pill of CallButtons + the registered
// r.callBarItems ("controls" slot) merged by native order, the "You're muted" bubble, and the
// popovers/menus that rise from it.
import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRegistry, type CallBarItemContribution } from "@/core/registry";
import { toast, useBus } from "@/core/bus";
import { getPref } from "@/core/prefs";
import { peekClient, useRoomState } from "@/core/matrix";
import { Button, Icon, ToolButton, useTip } from "@/ui";
import { playMutedCue } from "@/core/sounds";
import { CallButton } from "./CallButton";
import { act, getC, localpartOf, tileMxid, ui, useC, useCallUi } from "./store";
import { setCallBarPinned, useCallBarPinned, useCallBarShown, useChromeStore } from "./chrome";
import { CallOptionsPopover, StreamPopover, HealthPopup, GamePopup, healthWorst } from "./popovers";
import { DevicesMenu } from "./menus";
import { heardSummary } from "./hear";
import type { ItemOut } from "@/actions/evaluate";
import { callRowSnapshot } from "@/actions/decisions";
import { useActionsSnapshot } from "@/actions/snapshot";
import { Dim, EditableRow, RowButton, bespokeOk, runRowItem, shownItems, useRow, type RowState } from "@/actions/ui/rowHost";
import s from "./CallBar.module.css";
import { pttKeys } from "@/actions/shortcutsStore";

export type BarSlot = "statusLeft" | "statusRight" | "controls" | "phoneStrip";
export function slotOf(it: CallBarItemContribution): BarSlot {
  const sl = it.slot;
  if (sl) return sl;
  return it.side === "left" ? "statusLeft" : it.side === "right" ? "statusRight" : "controls";
}

export function useSlotItems(slot: BarSlot): CallBarItemContribution[] {
  const all = useRegistry("callBarItems");
  return useMemo(() => all.filter((i) => slotOf(i) === slot), [all, slot]);
}

interface Entry {
  order: number;
  key: string;
  node: ReactNode;
}

export function CallBar({ roomId, mobile }: { roomId: string; mobile?: boolean }) {
  // 11.0.2: the chrome's rule, or pinned ("Keep call buttons visible")
  const shown = useCallBarShown();
  const pinned = useCallBarPinned();
  const inCall = useC("inCall");
  const micMuted = useC("micMuted");
  const serverMuted = useC("serverMuted");
  const serverMutedBy = useC("serverMutedBy");
  const ptt = useC("pushToTalk");
  const pttSpeaking = useC("pttSpeaking");
  const gameChat = useC("gameChat");
  const corner = useC("corner");
  const deafened = useC("deafened");
  const cameraOn = useC("cameraOn");
  const sharing = useC("sharing");
  const shareRecOnly = useC("shareRecOnly");
  const musicPlaying = useC("musicPlaying");
  const musicSourceName = useC("musicSourceName");
  const localAfk = useC("localAfk");
  const hangingUp = useC("hangingUp");
  const hear = useC("hear");
  const stats = useC("publishStats");
  const tiles = useC("tiles");
  const optsFace = useCallUi((x) => x.optsFace);
  const streamPop = useCallUi((x) => x.streamPop);
  const mutedBubble = useCallUi((x) => x.mutedBubble);
  const items = useSlotItems("controls");
  const snap = useActionsSnapshot();
  const barSnap = useMemo(() => callRowSnapshot(snap), [snap]);
  const rowCtx = useMemo(() => ({ room: roomId }), [roomId]);
  const row = useRow("call", "bar", { form: "desktop", context: rowCtx, snapshot: barSnap });
  const activity = useRoomState(roomId, "dev.tinhat.activity", "") as { game?: string; code?: string } | undefined;

  const [healthOpen, setHealthOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  // 11.0 buttons: stream health and the game popover from a button of your own or the Ctrl+K palette (features/actions)
  useBus("openSurface", (p) => {
    if (p.id === "callHealth") setHealthOpen(true);
    else if (p.id === "gamePopup") setGameOpen(true);
  });
  const [devAnchor, setDevAnchor] = useState<HTMLElement | null>(null);
  const micRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const healthRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<HTMLDivElement>(null);

  // row width → scale to fit (≥ 0.7)
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const wrap = wrapRef.current,
      row = rowRef.current;
    if (!wrap || !row) return;
    const fit = () => {
      const implicitW = row.scrollWidth + 16;
      const pw = wrap.clientWidth;
      setScale(Math.max(0.7, Math.min(1, (pw - 8) / implicitW)));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    ro.observe(row);
    fit();
    return () => ro.disconnect();
  }, []);

  useMutedTalkBubble();

  const hearSnap = hear as { mutedTalk?: boolean; tx?: { state: string } };
  const heard = heardSummary(getC());
  const aside = corner.active;
  const cornerMates = useMemo(() => {
    // AppCore.cornerNames: everyone in the corner except me (any of my devices), ", "-joined.
    const me = peekClient()?.getUserId() ?? "";
    const ids = corner.members.filter((m) => m !== "You" && tileMxid(m) !== me);
    return ids.map((id) => nameFor(id, tiles)).join(", ");
  }, [corner, tiles]);
  const worst = healthWorst(stats);
  const savedSource = getPref("music-source", "");
  const code = (activity?.code ?? "").trim();
  const game = (activity?.game ?? "").trim();

  const micTip = serverMuted
    ? `${serverMutedBy || "A moderator"} muted your mic for everyone — ask them to unmute you`
    : (pttSpeaking ? "Transmitting (push-to-talk)\n" : "") +
      (micMuted ? "Unmute" : "Mute") +
      " — Ctrl+Shift+M" +
      (gameChat ? "\nGame chat: people in the game's voice chat don't hear this mic here; everyone else does" : "") +
      (heard ? "\n" + heard : "");

  const openFace = (face: "mic" | "speaker" | "camera", el: HTMLElement) => {
    const u = ui();
    if (u.optsFace === face) u.set({ optsFace: null });
    else u.set({ optsFace: face, optsAnchor: el, streamPop: false });
  };

  const builtins: Entry[] = [
    {
      order: 10,
      key: "mic",
      node: (
        <CallButton
          ref={micRef}
          data-id="mic"
          icon={micMuted || serverMuted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"}
          tip={micTip}
          danger={micMuted || serverMuted}
          tint={!micMuted && !serverMuted ? (pttSpeaking ? "ptt" : gameChat ? "gameChat" : undefined) : undefined}
          badge={gameChat && !micMuted ? "🎮" : undefined}
          ring={
            micMuted && hearSnap.mutedTalk && !serverMuted
              ? "var(--th-callbar-button-ring-muted)"
              : !micMuted && hearSnap.tx?.state === "notsent"
                ? "var(--th-callbar-button-ring-error)"
                : undefined
          }
          pulse={micMuted && !!hearSnap.mutedTalk && !serverMuted}
          hasMenu
          menuOpen={optsFace === "mic"}
          onMenu={(el) => openFace("mic", el)}
          onClick={() => {
            if (serverMuted) toast(`${serverMutedBy || "A moderator"} muted your mic for everyone`, { timeoutMs: 3000 });
            else act("toggleMic")();
          }}
        >
          {mutedBubble && inCall && <MutedBubble ptt={ptt} />}
        </CallButton>
      ),
    },
    {
      order: 20,
      key: "gamechat",
      node: (
        <CallButton
          data-id="gamechat"
          icon={aside ? "audio-input-microphone-symbolic" : "applications-games-symbolic"}
          tip={
            aside
              ? `Aside with ${cornerMates || "them"} — everyone else is at 10 % and can't hear your mics. Click to go back to everyone`
              : gameChat
                ? "Leave game chat — everyone in the call hears your mic again"
                : "Game chat — I'm in the game's own voice chat: people who are too won't hear my mic twice; everyone else still does"
          }
          tint={aside ? "aside" : gameChat ? "gameChat" : undefined}
          iconColor={aside ? "var(--th-callbar-button-aside-icon)" : undefined}
          badge={aside ? "🤫" : gameChat ? "🎮" : undefined}
          busy={aside && corner.mine !== "" && corner.members.length === 0}
          onClick={() => {
            if (aside) act("leaveCorner")();
            else act("applyGameChat")(!gameChat);
          }}
        />
      ),
    },
    {
      order: 30,
      key: "deafen",
      node: (
        <CallButton
          data-id="deafen"
          icon={deafened ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"}
          tip={deafened ? "Undeafen (restore audio) — Ctrl+Shift+D" : "Deafen (mute all output) — Ctrl+Shift+D"}
          danger={deafened}
          hasMenu
          menuOpen={optsFace === "speaker"}
          onMenu={(el) => openFace("speaker", el)}
          onClick={() => act("applyDeafen")(!deafened)}
        />
      ),
    },
    {
      order: 40,
      key: "camera",
      node: (
        <CallButton
          data-id="camera"
          icon="camera-video-symbolic"
          tip={cameraOn ? "Turn camera off" : "Turn camera on"}
          active={cameraOn}
          slash={!cameraOn}
          hasMenu
          menuOpen={optsFace === "camera"}
          onMenu={(el) => openFace("camera", el)}
          onClick={() => act("toggleCamera")()}
        />
      ),
    },
    {
      order: 50,
      key: "share",
      node: (
        <CallButton
          ref={shareRef}
          data-id="share"
          icon="video-display-brightness-symbolic"
          tip={sharing ? `Stop sharing${shareRecOnly ? " (recording only)" : ""} — ▴ for preview & options` : "Share your screen…"}
          active={sharing}
          hasMenu
          menuOpen={streamPop}
          onMenu={() => ui().set({ streamPop: !ui().streamPop, optsFace: null })}
          onClick={() => {
            if (sharing) act("stopScreen")();
            else ui().set({ streamPop: !ui().streamPop, optsFace: null });
          }}
        />
      ),
    },
    {
      order: 60,
      key: "shareaudio",
      node: (
        <CallButton
          data-id="shareaudio"
          icon="audio-speakers-symbolic"
          tip={
            musicPlaying
              ? `Stop sharing audio (${musicSourceName || "tab/system audio"})`
              : savedSource
                ? `Share audio (${musicSourceName || savedSource})`
                : "Share audio — pick an app in the share popover first"
          }
          active={musicPlaying}
          hasMenu
          menuOpen={streamPop}
          onMenu={() => ui().set({ streamPop: !ui().streamPop, optsFace: null })}
          onClick={() => {
            if (musicPlaying) act("stopMusic")();
            else if (savedSource) act("startMusicSource")(savedSource);
            else ui().set({ streamPop: true, optsFace: null });
          }}
        />
      ),
    },
    {
      order: 70,
      key: "health",
      node: (
        <CallButton
          ref={healthRef}
          data-id="health"
          icon="view-statistics-symbolic"
          tip="Stream health — what you're sending"
          active={healthOpen}
          dot={worst && !healthOpen ? (worst === "bad" ? "var(--th-callbar-health-dot-bad-fill)" : "var(--th-callbar-health-dot-warn-fill)") : undefined}
          onClick={() => setHealthOpen((o) => !o)}
        />
      ),
    },
    {
      order: 90,
      key: "game",
      node: (
        <CallButton
          ref={gameRef}
          data-id="game"
          icon="applications-games-symbolic"
          tip={game ? `Playing ${game}${code ? " — join code shared" : ""}` : "Game / join code"}
          active={!!code}
          onClick={() => setGameOpen((o) => !o)}
        />
      ),
    },
    {
      order: 100,
      key: "brb",
      node: (
        <CallButton
          data-id="brb"
          icon="appointment-missed-symbolic"
          tip={
            localAfk
              ? "I'm back — your mic and what you hear come back (your camera stays off until you turn it on)"
              : "Be right back — mutes your mic, turns your camera off and mutes everyone for you; peers see 💤 on your tile"
          }
          active={localAfk}
          onClick={() => act("setAfk")(!localAfk)}
        />
      ),
    },
    {
      order: 110,
      key: "gear",
      node: (
        <CallButton
          data-id="gear"
          icon="settings-configure-symbolic"
          tip="Call & device settings"
          onClick={(el) => {
            act("refreshInputs")();
            act("refreshOutputs")();
            act("refreshCameras")();
            setDevAnchor(el);
          }}
        />
      ),
    },
  ];
  const foreign: Entry[] = items.map((it) => ({ order: it.order, key: `r:${it.id}`, node: <it.component roomId={roomId} /> }));
  if (!items.length) foreign.push(...fallbackControls(roomId));
  const hangup = (
    <CallButton
      data-id="hangup"
      wide
      icon="call-stop-symbolic"
      tip={hangingUp ? "Hanging up…" : "Leave call"}
      danger
      busy={hangingUp}
      live={!hangingUp}
      onClick={() => act("leaveCall")()}
    />
  );
  // 11.0 buttons: the bar is a row of the actions table (call.bar) — the stored row or the preset's default (today's
  // buttons, same order); each action keeps its element here (CALLBAR_HOSTS: the builtins above, media's soundboard
  // items), anything else is the generic call button. The call's room is the row's context.
  const nodes = new Map<string, ReactNode>([...builtins, ...foreign].map((e) => [e.key, e.node]));
  nodes.set("hangup", hangup);
  const cells: ReactNode[] = [];
  const leftovers = foreign.filter((e) => !MAPPED_KEYS.has(e.key)); // a feature's own item no action maps to
  let placedLeftovers = false;
  const placeLeftovers = () => {
    if (placedLeftovers) return;
    placedLeftovers = true;
    for (const e of leftovers)
      cells.push(
        <div key={e.key} className={s.cell}>
          {e.node}
        </div>,
      );
  };
  for (const { item: it, i } of shownItems(row)) {
    const k = `${it.a}:${i}`;
    if (it.a === "call.leave" || it.sepBefore) placeLeftovers();
    if (it.sepBefore) cells.push(<div key={`sep:${k}`} className={s.sep} />);
    cells.push(
      <div key={k} className={s.cell}>
        {callBarItem(row, it, nodes)}
      </div>,
    );
  }
  placeLeftovers();
  // 11.0.2 (2026-09-28): the bar's own pin — "Keep call buttons visible" (call.bar.pin.toggle, the same preference
  // as Settings → Calls). Not a row item: after the row, behind its own divider, in every stored row; small, so it never
  // reads like a call control. Tooltip = the action's short faces; pressed = pinned. (Main.qml: CallIsland's callBarPin.)
  cells.push(<div key="pin:sep" className={s.sep} />);
  cells.push(
    <div key="pin" className={s.cell}>
      <CallButton
        data-id="pin"
        small
        icon="window-pin-symbolic"
        tip={pinned ? "Let buttons hide" : "Keep buttons visible"}
        active={pinned}
        onClick={() => setCallBarPinned(!pinned)}
      />
    </div>,
  );

  return (
    <div ref={wrapRef} className={s.wrapLine}>
      <div
        className={`${s.bar} ${shown || mobile ? s.shown : ""}`}
        style={{ transform: `${shown || mobile ? "" : "translateY(10px) "}scale(${scale})` }}
        onPointerEnter={() => useChromeStore.getState().set({ barHovered: true })}
        onPointerLeave={() => useChromeStore.getState().set({ barHovered: false })}
        data-testid="call-bar"
      >
        <div ref={rowRef} className={s.row}>
          <EditableRow row={row} title="Call controls">
            {cells}
          </EditableRow>
        </div>
      </div>
      <CallOptionsPopover />
      <StreamPopover anchor={shareRef.current} />
      <HealthPopup open={healthOpen} onClose={() => setHealthOpen(false)} anchor={healthRef.current} />
      <GamePopup open={gameOpen} onClose={() => setGameOpen(false)} anchor={gameRef.current} roomId={roomId} />
      <DevicesMenu anchor={devAnchor} onClose={() => setDevAnchor(null)} roomId={roomId} />
    </div>
  );
}

// ---- the bar's row elements (11.0 buttons) -------------------------------------------------------------------------
// Each action of the table → the element that draws it today: a builtin above (by key) or media's registered item
// (r.callBarItems, else this file's fallbacks) — first present wins. Game chat and "Leave the corner" are one button
// that changes with the corner (the row shows exactly one of the two).
const CALLBAR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "call.mic.toggle": ["mic"],
  "call.gameChat.toggle": ["gamechat"],
  "call.corner.leave": ["gamechat"],
  "call.deafen.toggle": ["deafen"],
  "call.camera.toggle": ["camera"],
  "call.screenShare.toggle": ["share"],
  "call.audioShare.toggle": ["shareaudio"],
  "call.health.open": ["health"],
  "soundboard.open": ["r:media-soundboard", "fb-soundboard"],
  "sound.stop": ["r:media-sound-playing", "fb-nowplaying"],
  "watchParty.open": ["r:media-watchparty", "fb-watchparty"], // 11.4 Media Party: button + now-playing strip (media)
  "room.activity.open": ["game"],
  "call.afk.toggle": ["brb"],
  "call.devices.open": ["gear"],
  "call.leave": ["hangup"],
};
const MAPPED_KEYS: ReadonlySet<string> = new Set(Object.values(CALLBAR_HOSTS).flat());
/** elements that draw their own unavailable state (Leave's "Hanging up…") — never dimmed twice */
const CALLBAR_SELF_DIM: ReadonlySet<string> = new Set(["call.leave"]);

function callBarItem(row: RowState, it: ItemOut, nodes: Map<string, ReactNode>): ReactNode {
  const hostKey = bespokeOk(row, it) ? CALLBAR_HOSTS[it.a]?.find((k) => nodes.has(k)) : undefined;
  if (hostKey) {
    const node = nodes.get(hostKey);
    if (it.state !== "dimmed" || CALLBAR_SELF_DIM.has(it.a)) return node;
    // the call bar's own unavailable look (50 %, inert, the tooltip still shows) where the element is a call button
    return isValidElement(node) && node.type === CallButton ? cloneElement(node as React.ReactElement<{ live?: boolean }>, { live: false }) : <Dim>{node}</Dim>;
  }
  // the generic button: a round call button for an icon (the bar's own look), else the tool button (a label, an emoji,
  // an avatar, press-and-hold)
  const glyph = it.icon ?? it.targetIcon;
  if (row.out.look === "icon" && glyph && !it.emoji && !it.hold && it.known)
    return (
      <CallButton
        data-id={`action:${it.a}`}
        icon={glyph}
        tip={it.tip ?? it.label}
        active={it.active === true}
        danger={it.danger}
        live={it.state === "shown"}
        onClick={(el) => runRowItem(row, it, el)}
      />
    );
  return <RowButton row={row} item={it} />;
}

function nameFor(identity: string, tiles: { participant: string; name: string }[]): string {
  const mx = tileMxid(identity);
  const t = tiles.find((x) => x.participant === identity || tileMxid(x.participant) === mx);
  return t?.name || localpartOf(mx);
}

// ---- fallbacks for media's items (only while no feature registered any "controls" item) ------------

function fallbackControls(roomId: string): Entry[] {
  return [
    { order: 80, key: "fb-soundboard", node: <FallbackSoundboard roomId={roomId} /> },
    { order: 85, key: "fb-nowplaying", node: <NowPlayingPill /> },
    { order: 86, key: "fb-watchparty", node: <FallbackMediaParty /> },
  ];
}

function FallbackMediaParty() {
  return <CallButton data-id="watchparty" icon="video-television-symbolic" tip="Media Party" onClick={() => toast("The Media Party arrives with the media feature")} />;
}

function FallbackSoundboard(_: { roomId: string }) {
  const playing = useC("soundPlaying");
  const open = useCallUi((x) => x.soundboardOpen);
  return (
    <CallButton
      data-id="soundboard"
      icon="emblem-music-symbolic"
      tip={playing ? "Soundboard — playing a sound" : "Soundboard"}
      active={open || playing}
      onClick={() => toast("The soundboard arrives with the media feature")}
    />
  );
}

/** Now-playing pill (Main.qml:7704-7750) — shown while a soundboard clip plays. */
export function NowPlayingPill({ name }: { name?: string }) {
  const playing = useC("soundPlaying");
  // GPU.md §2.2: the now-playing ▶ is static (it blinked every 700 ms while a clip played)
  if (!playing) return null;
  return (
    <div className={s.nowPlaying}>
      <span style={{ display: "flex" }}>
        <Icon name="media-playback-start" size={16} color="var(--th-callbar-now-playing-icon)" />
      </span>
      <span className={s.npName}>{name || "Bruh sound effect #2"}</span>
      <ToolButton iconName="media-playback-stop" iconSize={16} className={s.npStop} tip="Stop the sound (for everyone)" onClick={() => act("stopSound")()} />
    </div>
  );
}

// ---- "You're muted" bubble (CUI-98) ------------------------------------------------------------

let lastShown = 0;
let dismissals = 0;
let lastCue = 0;

function useMutedTalkBubble() {
  const hear = useC("hear") as { mutedTalk?: boolean };
  const micMuted = useC("micMuted");
  const serverMuted = useC("serverMuted");
  const inCall = useC("inCall");
  const now = !!hear.mutedTalk && micMuted && !serverMuted && inCall;
  useEffect(() => {
    if (!inCall) {
      dismissals = 0;
      lastShown = 0;
      ui().set({ mutedBubble: false });
    }
  }, [inCall]);
  useEffect(() => {
    if (!micMuted) ui().set({ mutedBubble: false });
  }, [micMuted]);
  useEffect(() => {
    if (now) {
      const t = Date.now();
      if (!ui().mutedBubble && t - lastShown >= 30000 && dismissals < 2) {
        lastShown = t;
        ui().set({ mutedBubble: true });
        if (getPref("snd.mutedtalk", "0") === "1" && t - lastCue >= 10000) {
          lastCue = t;
          playMutedCue();
        }
      }
      return;
    }
    const tm = window.setTimeout(() => ui().set({ mutedBubble: false }), 3000);
    return () => window.clearTimeout(tm);
  }, [now]);
}

function MutedBubble({ ptt }: { ptt: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, "Dismiss");
  return (
    <div className={s.bubble} role="status" onClick={(e) => e.stopPropagation()}>
      <Icon name="microphone-sensitivity-muted-symbolic" size={16} color="var(--th-callbar-muted-bubble-icon)" />
      <span className={s.bubbleText}>{ptt ? `You're muted — hold ${pttKeys()[0] ?? "Ctrl"} to talk` : "You're muted"}</span>
      {!ptt && (
        <Button
          text="Unmute"
          onClick={(e) => {
            e.stopPropagation();
            ui().set({ mutedBubble: false });
            act("toggleMic")();
          }}
        />
      )}
      <span
        ref={ref}
        className={s.bubbleX}
        role="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismissals++;
          ui().set({ mutedBubble: false });
        }}
      >
        ✕
      </span>
    </div>
  );
}

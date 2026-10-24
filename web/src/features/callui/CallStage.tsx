// CallStage.tsx — the in-call panel of the room page (Main.qml:5324-5950): status bar (48 px) with the
// hear pills, chips and tool buttons; the AFK / server-muted / connection banners; the weighted tile
// grid (+ side seam, self PiP); the empty label; the control bar; the call/chat seam. "Fill the app"
// lays the stage over the whole room page. Phones get MobileCallStage (full screen + pill).
// 11.0 (islands C6/C7): on the desktop the stage is the dock host's `call` island (CallIsland.qml) — sized by its
// island: its natural height (the chrome + the grid the caps allow) goes to the layout through useIsland().report, and
// when the island is shorter (the chat keeps its share) the grid fits what the island leaves; the seam's share and the
// caps are fractions of the main column (`pageH` = the host's height − 2 × margin; was the room page's height). "Fill
// the app" = the layout's maximised call: the island is the whole host and the stage fills it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePref, setPref, getPref } from "@/core/prefs";
import { useRoomName, useRoomState, sendState, peekClient, inviteWithoutHistory } from "@/core/matrix";
import { toast, useBus } from "@/core/bus";
import { useRegistry } from "@/core/registry";
import { recorderMxid } from "@/core/server";
import { BusyIndicator, ConfirmDialog, GlowButton, Icon, InlineMessage, ToolButton, useIsland, useStillLabel, useTip } from "@/ui";
import { act, getC, isRecorderTile, isShareTile, SELF_ID, SELF_SHARE_ID, setUiState, ui, useC, useCallShownFor, useCallUi, type Tile as TileT } from "./store";
import { engineHeight, normalBoxH, normalizeMode, weightedLayout, GAP } from "./layout";
import { useHiddenSet, useHideMemorySync, useSelfViewMode, useWatchedShares, useWatchedPush, useHiddenWindowPause } from "./memory";
import { chromePointerLeave, chromePointerMove, useChromeShown, useWindowFocusTracking } from "./chrome";
import { Tile } from "./Tile";
import { CallBar, useSlotItems } from "./CallBar";
import { HiddenMenu, LayoutMenu, VolMenuHost } from "./menus";
import { HearPills } from "./HearPills";
import { ResumePill } from "./ResumePill";
import { SameRoomAsk } from "./SameRoomAsk";
import { JoinBanner, useHeaderChipsMounted } from "./Incoming";
import { MobileCallStage, MobileCallPill } from "./Mobile";
import { recClipRoom } from "@/actions/decisions";
import { useChatStore } from "@/features/chat/store";
import s from "./CallStage.module.css";

export interface CallStageProps {
  roomId: string;
  mobile?: boolean;
  /** 11.0 (islands C6/C7): the dock host's main column height — the seam's share and the caps are fractions of it */
  pageH?: number;
  /** 10.8: the nav drawer handle's inset on the call island (content px; the emergency arrangement puts the call first
   *  in the column, under the handle) — the status bar starts clear of it */
  leftInset?: number;
}

export function CallStage({ roomId, mobile, pageH, leftInset }: CallStageProps) {
  const shown = useCallShownFor(roomId);
  // The panel follows you into other rooms; everything inside it (Rec/Clip, game popup, tile overlays,
  // Rejoin) acts on the CALL's room, not the room being browsed.
  const callRoom = useC("callRoomId") || roomId;
  const chipsMounted = useHeaderChipsMounted(roomId);
  useWindowFocusTracking();
  if (mobile) {
    return (
      <>
        {!chipsMounted && !shown && <JoinBanner roomId={roomId} />}
        {shown && <MobileCallStage roomId={callRoom} />}
      </>
    );
  }
  return (
    <>
      {!chipsMounted && <JoinBanner roomId={roomId} />}
      {shown && <DesktopStage roomId={callRoom} columnH={pageH} leftInset={leftInset} />}
    </>
  );
}

function DesktopStage({ roomId, columnH, leftInset }: { roomId: string; columnH?: number; leftInset?: number }) {
  const island = useIsland();
  const maximized = useC("maximized");
  const collapsedPref = usePref("ui-call-collapsed", "0") === "1";
  const fracPref = usePref("ui-call-pane-frac", "");
  const savedFrac = (() => {
    const f = parseFloat(fracPref);
    return f >= 0.2 && f <= 0.85 ? f : -1;
  })();
  const [liveFrac, setLiveFrac] = useState<number | null>(null);
  const paneFrac = liveFrac ?? savedFrac;
  const collapsed = collapsedPref && !maximized;
  useEffect(() => setUiState({ collapsed: collapsedPref, paneFrac: savedFrac }), [collapsedPref, savedFrac]);

  const tiles = useC("tiles");
  const localAfk = useC("localAfk");
  const connecting = useC("connecting");
  const inCall = useC("inCall");
  const fake = useC("fake");
  const hidden = useHiddenSet();
  const pinned = useCallUi((x) => x.pinned);
  const sideFrac = useCallUi((x) => x.sideFrac);
  const animate = useCallUi((x) => x.animate);
  const mode = normalizeMode(usePref("call-layout", "auto"));
  const selfMode = useSelfViewMode();
  const watched = useWatchedShares();
  const chrome = useChromeShown();
  useWatchedPush(watched);
  useHideMemorySync();
  useHiddenWindowPause();

  // unpin a pinned tile that left
  useEffect(() => {
    if (pinned && !tiles.some((t) => t.id === pinned)) ui().set({ pinned: null });
  }, [tiles, pinned]);

  const gridTiles = useMemo(() => tiles.filter((t) => t.id !== SELF_SHARE_ID && !isRecorderTile(t)), [tiles]);
  const hasShare = gridTiles.some((t) => isShareTile(t));
  const selfPipEffective = selfMode === "pip" && (hasShare || mode === "speaker");

  // measurements
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bannersRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [domPageH, setPageH] = useState(0);
  const [bannersH, setBannersH] = useState(0);
  // the island: everything but the grid, as laid out (status bar, banners, empty label, call bar, margins, seam)
  const [chromePx, setChromePx] = useState(-1);
  const inIsland = island !== null;
  useLayoutEffect(() => {
    const root = rootRef.current,
      panel = panelRef.current,
      ban = bannersRef.current;
    if (!root || !panel) return;
    // The room page = `[data-room-page]` if chat marks it, else the first ancestor tall enough to be the page
    // (chat may wrap callSlot in its own header column). In the dock host: the main column (columnH).
    let page = inIsland ? null : (root.closest("[data-room-page]") as HTMLElement | null);
    if (!page && !inIsland) {
      page = root.parentElement;
      while (page && page.parentElement && page.clientHeight < Math.min(300, window.innerHeight * 0.5)) page = page.parentElement;
    }
    const measure = () => {
      setW(panel.clientWidth);
      setPageH(maximized ? root.clientHeight : (page?.clientHeight ?? window.innerHeight));
      if (ban) {
        const n = Array.from(ban.children).filter((c) => (c as HTMLElement).offsetHeight > 0).length;
        setBannersH(ban.offsetHeight + n * GAP);
      }
      if (inIsland) setChromePx(Math.max(0, root.getBoundingClientRect().height - (gridRef.current?.getBoundingClientRect().height ?? 0)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    ro.observe(root);
    if (page) ro.observe(page);
    if (ban) ro.observe(ban);
    return () => ro.disconnect();
  }, [maximized, inIsland]);
  const pageH = inIsland && !maximized && columnH !== undefined ? columnH : domPageH;

  const gridW = Math.max(0, W - (maximized ? 16 : 0));
  const chromeH = 48 + 64 + 4 + bannersH + 8 + 8;
  const liveCount = localAfk ? 1 : gridTiles.length;
  const shownTiles = gridTiles.filter((t) => !hidden.has(t.id));
  const boxH = normalBoxH(gridW, liveCount, shownTiles, localAfk);
  // what the grid WANTS: the dragged seam share, else its natural box — in the dock host without the page's no-seam cap
  // (the layout engine applies the conversation's minimum; the desktop's CallIsland wantBudget, 4bbf371f)
  const Hnat = inIsland && !maximized && paneFrac < 0 ? boxH : engineHeight({ maximized, pageH, chromeH, paneFrac, boxH });
  // the island is shorter than the stage wants (the chat keeps its share): the grid fits what the chrome leaves
  const fitCap = island !== null && !maximized && island.visible && chromePx >= 0 ? island.h - chromePx : null;
  const H = fitCap !== null ? Math.max(0, Math.min(Hnat, fitCap)) : Hnat;
  const afkHidden = localAfk ? gridTiles.filter((t) => t.id !== SELF_ID).map((t) => t.id) : [];
  const hiddenArr = useMemo(() => [...hidden, ...afkHidden], [hidden, afkHidden.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  // AFK: the engine places index 0 (self) — reorder so self is first
  const ordered = useMemo(() => {
    if (!localAfk) return gridTiles;
    const self = gridTiles.find((t) => t.id === SELF_ID);
    return self ? [self, ...gridTiles.filter((t) => t !== self)] : gridTiles;
  }, [gridTiles, localAfk]);
  const layout = useMemo(
    () => weightedLayout(gridW, H, ordered, localAfk, hiddenArr, mode, pinned, sideFrac, selfPipEffective),
    [gridW, H, ordered, localAfk, hiddenArr, mode, pinned, sideFrac, selfPipEffective],
  );
  const gridH = maximized ? Math.max(160, pageH - chromeH - 16) : collapsed ? 0 : Math.max(0, layout.bottom);
  const gridVisible = gridTiles.length > 0 && !(collapsed && !maximized);
  // the island's natural height: the chrome + the grid the caps allow (not the fitted one — the layout gives the island
  // what it can, and a fitted grid must never shrink what the stage asks for next time)
  const natLayoutBottom = useMemo(
    () => (H === Hnat ? layout.bottom : weightedLayout(gridW, Hnat, ordered, localAfk, hiddenArr, mode, pinned, sideFrac, selfPipEffective).bottom),
    [H, Hnat, layout, gridW, ordered, localAfk, hiddenArr, mode, pinned, sideFrac, selfPipEffective],
  );
  const natGridH = !gridVisible ? 0 : maximized ? gridH : collapsed ? 0 : Math.max(0, natLayoutBottom);
  const report = island?.report;
  useEffect(() => {
    if (report && chromePx >= 0) report({ h: chromePx + natGridH });
  }, [report, chromePx, natGridH]);

  const onMove = (e: React.PointerEvent) => chromePointerMove(e);
  return (
    <>
      <div ref={rootRef} className={`${s.stage} ${maximized ? s.fill : ""}`} data-in-island={inIsland ? "" : undefined} data-testid="call-stage">
        <div ref={panelRef} className={s.panel} onPointerMove={onMove} onPointerEnter={onMove} onPointerLeave={chromePointerLeave}>
          <StatusBar roomId={roomId} maximized={maximized} collapsed={collapsedPref} hiddenCount={gridTiles.filter((t) => hidden.has(t.id)).length} leftInset={leftInset} />
          <div ref={bannersRef} className={s.banners}>
            <AfkBanner />
            <ServerMutedStrip />
            <SameRoomAsk />
            <ConnBanner roomId={roomId} />
          </div>
          <div
            ref={gridRef}
            className={s.grid}
            style={{ height: gridVisible ? gridH : 0, margin: maximized ? 8 : undefined, display: gridVisible ? undefined : "none" }}
            data-testid="call-grid"
          >
            {ordered.map((t, i) => {
              const slot = layout.slots[i] ?? { x: 0, y: 0, w: 0, h: 0 };
              const isHidden = hiddenArr.includes(t.id) && !slot.pip && slot.w === 0;
              return (
                <Tile
                  key={t.id}
                  tile={t}
                  slot={slot}
                  hidden={isHidden || slot.w <= 0 || !gridVisible}
                  chrome={chrome}
                  watched={watched.has(t.id)}
                  pinned={pinned === t.id}
                  animate={animate}
                  afkGrid={localAfk}
                  roomId={roomId}
                  selfPipMode={selfMode}
                  fake={fake}
                />
              );
            })}
            <SideSeam layout={layout} gridW={gridW} afk={localAfk} />
          </div>
          {gridTiles.length === 0 && (connecting || inCall) && (
            <div className={s.empty}>{connecting ? "Connecting to the call…" : "You're in the call. Turn on your camera or wait for others."}</div>
          )}
          <CallBar roomId={roomId} />
        </div>
        {!maximized && (
          <CallSeam
            collapsed={collapsedPref}
            onFrac={setLiveFrac}
            onRelease={(f) => {
              setLiveFrac(null);
              setPref("ui-call-pane-frac", f.toFixed(3));
            }}
            startFrac={() => {
              if (savedFrac >= 0) return savedFrac;
              const ph = Math.max(1, pageH);
              return Math.max(0.2, Math.min(0.85, (gridH + chromeH) / ph));
            }}
            pageH={pageH}
          />
        )}
      </div>
      {maximized && <div className={s.fillSpacer} />}
      <VolMenuHost />
    </>
  );
}

// ---- status bar -----------------------------------------------------------------------------

function StatusBar({ roomId, maximized, collapsed, hiddenCount, leftInset }: { roomId: string; maximized: boolean; collapsed: boolean; hiddenCount: number; leftInset?: number }) {
  const connecting = useC("connecting");
  const inCall = useC("inCall");
  const reconnecting = useC("reconnecting");
  // D6: native keeps "In call" (it only checks `connecting`) after a terminal drop / failed join while the red
  // banner says the call ended (docs/native-bugs/calls.md). The web says what is true.
  const title = connecting ? "Connecting…" : inCall ? "In call" : reconnecting ? "Reconnecting…" : "Disconnected";
  const live = inCall && !connecting;
  const tiles = useC("tiles");
  const sharing = useC("sharing");
  const shareRecOnly = useC("shareRecOnly");
  const recActive = useC("recActive");
  const outputMissing = useC("outputMissing");
  // Native shows the OPEN room's name here (mRoomName), which reads "In call · <other room>" while you browse
  // another room mid-call (docs/native-bugs/callui.md); the web names the call's room.
  const callRoomId = useC("callRoomId");
  const roomName = useRoomName(callRoomId || roomId);
  const screenRoom = useChatStore((st) => st.mainRoom);
  // GPU.md §2.2: the "live" dot is static (it blinked every 1.2 s for the whole call: ≈ 6 frames/s)
  const dotOn = true;
  const items = useSlotItems("statusRight");
  const leftItems = useSlotItems("statusLeft");
  const pills = useRegistry("callStatusPills");
  const [layoutAnchor, setLayoutAnchor] = useState<HTMLElement | null>(null);
  const [hiddenAnchor, setHiddenAnchor] = useState<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // 11.0 buttons: the hidden streams from a button of your own or the Ctrl+K palette (features/actions)
  useBus("openSurface", (p) => {
    if (p.id === "hiddenStreams" && hiddenCount > 0) setHiddenAnchor(p.anchor ?? barRef.current);
  });
  const hiddenSet = useHiddenSet();
  const n = tiles.filter((t) => t.id !== SELF_SHARE_ID && !isRecorderTile(t)).length;
  const hiddenTiles = tiles.filter((t) => hiddenSet.has(t.id));
  const optOut = usePref("record-optout", "0") === "1";

  const builtins: { order: number; key: string; node: ReactNode }[] = [
    {
      order: 30,
      key: "layout",
      node: (
        <ToolButton
          iconName="view-grid-symbolic"
          label="Layout"
          active={!!layoutAnchor}
          tip={layoutAnchor ? undefined : "How the call grid is arranged"}
          onClick={(e) => setLayoutAnchor(layoutAnchor ? null : e.currentTarget)}
        />
      ),
    },
    {
      order: 40,
      key: "collapse",
      node: !maximized ? (
        <ToolButton
          iconName={collapsed ? "go-down-symbolic" : "go-up-symbolic"}
          active={collapsed}
          tip={collapsed ? "Show the call tiles" : "Collapse the call — the chat gets the room (drag the seam below to resize)"}
          onClick={() => setPref("ui-call-collapsed", collapsed ? "0" : "1")}
          aria-label={collapsed ? "Show the call tiles" : "Collapse the call"}
        />
      ) : null,
    },
    {
      order: 50,
      key: "fill",
      node: (
        <ToolButton
          iconName={maximized ? "view-restore-symbolic" : "view-fullscreen-symbolic"}
          active={maximized}
          tip={maximized ? "Restore layout" : "Fill the app with the call"}
          onClick={() => setUiState({ maximized: !maximized })}
          aria-label={maximized ? "Restore layout" : "Fill the app with the call"}
        />
      ),
    },
  ];
  // Rec / Clip (media's "statusRight" items): product decision (1), decisions.ts REC_CLIP_ROOM — the call's room
  const recRoom = recClipRoom(callRoomId || roomId, screenRoom) ?? roomId;
  const foreign = items.map((it) => ({ order: it.order, key: `r:${it.id}`, node: <it.component roomId={recRoom} /> }));
  if (!items.length) foreign.push({ order: 10, key: "fb-rec", node: <FallbackRec roomId={recRoom} /> }, { order: 20, key: "fb-clip", node: <FallbackClip roomId={recRoom} /> });
  const right = [...builtins, ...foreign].sort((a, b) => a.order - b.order);

  return (
    <div ref={barRef} className={s.status} data-testid="call-status" style={leftInset ? { marginLeft: Math.max(0, leftInset - 4) } : undefined}>
      <span className={s.dot} style={{ background: live ? "var(--th-call-status-bar-dot-live)" : "var(--th-call-status-bar-dot)", opacity: dotOn || (!inCall && !connecting) ? 1 : 0.3 }} />
      <span className={s.stTitle}>{title}</span>
      {roomName && <span className={s.stRoom}>· {roomName}</span>}
      {n > 0 && (
        <span className={s.stCount}>
          · {n} {n === 1 ? "stream" : "streams"}
        </span>
      )}
      <ResumePill />
      <HearPills />
      {outputMissing && <NoOutputChip />}
      {hiddenCount > 0 && <HiddenChip count={hiddenCount} open={!!hiddenAnchor} onOpen={(el) => setHiddenAnchor(hiddenAnchor ? null : el)} />}
      {pills.map((it) => (
        <it.component key={`p:${it.id}`} roomId={roomId} />
      ))}
      {leftItems.map((it) => (
        <it.component key={it.id} roomId={roomId} />
      ))}
      {sharing && <span className={s.stShare}>· sharing screen{shareRecOnly ? " (recording only)" : ""}</span>}
      {recActive && <span className={s.stRec}>· 🔴 REC{optOut ? " (not recording you)" : ""}</span>}
      <span className={s.filler} />
      <div className={s.tools}>
        {right.map((e) => (e.node ? <span key={e.key}>{e.node}</span> : null))}
      </div>
      <LayoutMenu anchor={layoutAnchor} onClose={() => setLayoutAnchor(null)} />
      <HiddenMenu anchor={hiddenAnchor} onClose={() => setHiddenAnchor(null)} hidden={hiddenTiles} />
    </div>
  );
}

function NoOutputChip() {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(
    ref,
    "No usable audio output was found when you joined (the system only offers a dummy output). Nothing can be heard until the sound device is back — check the system sound settings (Linux: wpctl status).",
    { delay: 300 },
  );
  return (
    <span ref={ref} className={`${s.chip} ${s.chipWarn}`}>
      <Icon name="audio-volume-muted-symbolic" size={13} color="var(--th-hear-no-output-chip-fg)" />
      <span>no speaker device</span>
    </span>
  );
}

function HiddenChip({ count, open, onOpen }: { count: number; open: boolean; onOpen: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, open ? undefined : "See who's hidden — show them one by one, or all at once");
  return (
    <button ref={ref} type="button" className={`${s.chip} ${s.chipHidden}`} onClick={(e) => onOpen(e.currentTarget)} data-testid="hidden-chip">
      <Icon name="layer-visible-off-symbolic" size={13} color="var(--th-call-hidden-chip-fg)" />
      <span>{count} hidden ▾</span>
    </button>
  );
}

// ---- Rec / Clip fallbacks (media registers the real ones in "statusRight") ---------------------

const REC_CONFIRM =
  'Calls in this room get recorded for the Memories tab — every stream and voice separately, so replays can switch points of view.\n\nNo extra participant appears: everyone in the call sees a 🔴 REC cue in their call header instead (and anyone who turned on "Never record me" in Settings → Calls is left out of the recording entirely — their cue says so). Stop any time with the ⏹ Rec button.';

function FallbackRec({ roomId }: { roomId: string }) {
  const rec = useRoomState(roomId, "dev.tinhat.record", "") as { active?: boolean } | undefined;
  const on = !!rec?.active;
  const [ask, setAsk] = useState(false);
  const start = async () => {
    const c = peekClient();
    if (!c) return;
    const recorder = recorderMxid(); // the account the server announces (core/server)
    if (!recorder) {
      toast("This server has no call recorder", { timeoutMs: 6000 });
      return;
    }
    try {
      // never the room's history: the recorder records calls (core/matrix inviteWithoutHistory)
      await inviteWithoutHistory(roomId, recorder).catch((e: Error) => {
        if (!/already/i.test(e.message)) throw e;
      });
      await sendState(roomId, "dev.tinhat.record", "", { active: true, by: c.getUserId() });
    } catch (e) {
      const msg = (e as { errcode?: string }).errcode === "M_FORBIDDEN" ? "this room isn't unlocked for member recording yet — a room admin just needs to open the room once on the latest Tin Hat, then try again" : (e as Error).message;
      toast(`Couldn't start recording: ${msg}`, { timeoutMs: 6000 });
    }
  };
  return (
    <>
      <ToolButton
        iconName={on ? "media-playback-stop-symbolic" : "media-record-symbolic"}
        iconColor={on ? "var(--th-call-rec-button-icon-active)" : undefined}
        label="Rec"
        active={on}
        tip={on ? "Stop recording this room's calls" : "Record this room's calls — REC shows for everyone"}
        onClick={() => (on ? void sendState(roomId, "dev.tinhat.record", "", {}).catch((e) => toast(`Couldn't stop recording: ${(e as Error).message}`)) : setAsk(true))}
      />
      <ConfirmDialog open={ask} onClose={() => setAsk(false)} dialogTitle="Record calls in this room?" message={REC_CONFIRM} confirmText="Record" onConfirmed={() => void start()} />
    </>
  );
}

function FallbackClip({ roomId }: { roomId: string }) {
  const recActive = useC("recActive");
  if (!recActive) return null;
  return (
    <ToolButton
      iconName="bookmark-new-symbolic"
      label="Clip"
      tip="Bookmark this moment on the recording's timeline"
      onClick={() => {
        const at = Date.now();
        sendState(roomId, "dev.tinhat.clip", String(at), { at })
          .then(() => toast("Clipped — bookmarked on the Memories timeline"))
          .catch((e) => toast(`Couldn't clip: ${(e as Error).message}`));
      }}
    />
  );
}

// ---- banners --------------------------------------------------------------------------------

function AfkBanner() {
  const afk = useC("localAfk");
  // GPU.md §2.2: the BRB banner is static (it blinked every 1.2 s while away)
  if (!afk) return null;
  return (
    <button type="button" className={s.afk} onClick={() => act("setAfk")(false)} data-testid="afk-banner">
      <Icon name="appointment-missed-symbolic" size={20} color="var(--th-call-afk-banner-icon)" />
      <span className={s.afkText}>💤 You're away (BRB) — click to return</span>
    </button>
  );
}

function ServerMutedStrip() {
  const sm = useC("serverMuted");
  const by = useC("serverMutedBy");
  const inCall = useC("inCall");
  const connecting = useC("connecting");
  if (!sm || !(inCall || connecting)) return null;
  return <InlineMessage type="warning" icon="dialog-warning" text={`${by || "A moderator"} muted your mic for everyone. Ask them to unmute you.`} />;
}

function ConnBanner({ roomId }: { roomId: string }) {
  const reconnecting = useC("reconnecting");
  const failed = useC("callFailed");
  const reason = useC("failReason");
  const removedBy = useC("removedBy");
  const hangingUp = useC("hangingUp");
  const callRoom = useC("callRoomId");
  // GPU.md §2.5: a still busy mark; after 10 s without progress the label changes once
  const reconnectingLabel = useStillLabel("Reconnecting to the call…", reconnecting);
  if (!reconnecting && !failed) return null;
  const title = reconnecting ? reconnectingLabel : removedBy ? `${removedBy} disconnected you from the call` : reason ? "Couldn't join the call" : "Call ended — connection lost";
  const r = !reconnecting && reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : "";
  return (
    <div className={`${s.conn} ${reconnecting ? s.connWarn : s.connBad}`} data-testid="conn-banner">
      {reconnecting && <BusyIndicator size={18} color="var(--th-call-conn-banner-warn-icon)" />}
      <div className={s.connCol}>
        <div className={s.connTitle}>{title}</div>
        {r && <div className={s.connReason}>{r}</div>}
      </div>
      {!reconnecting && (
        <GlowButton
          text={hangingUp ? "Cleaning up…" : reason ? "Try again" : "Rejoin"}
          disabled={hangingUp}
          onClick={() => act("joinCall")(callRoom || roomId)}
        />
      )}
    </div>
  );
}

// ---- seams ----------------------------------------------------------------------------------

function SideSeam({ layout, gridW, afk }: { layout: { sideX: number; sideY: number; bottom: number; splitH?: number }; gridW: number; afk: boolean }) {
  const [act0, setAct] = useState(false);
  const horizontal = layout.sideY > 0;
  if ((layout.sideX <= 0 && layout.sideY <= 0) || afk) return null;
  const style = horizontal
    ? { left: 0, top: layout.sideY - GAP, width: gridW, height: GAP, cursor: "row-resize" }
    : { left: layout.sideX - GAP, top: 0, width: GAP, height: Math.max(0, layout.bottom), cursor: "col-resize" };
  const onMove = (e: React.PointerEvent) => {
    if (!(e.buttons & 1)) return;
    const grid = (e.currentTarget as HTMLElement).parentElement!;
    const r = grid.getBoundingClientRect();
    if (horizontal) ui().set({ sideFrac: Math.max(0.15, Math.min(0.5, 1 - (e.clientY - r.top) / Math.max(1, layout.splitH || layout.bottom || r.height))) });
    else if (r.width > 0) ui().set({ sideFrac: Math.max(0.15, Math.min(0.5, 1 - (e.clientX - r.left) / r.width)) });
  };
  return (
    <div
      className={s.sideSeam}
      style={{ ...style, background: act0 ? "var(--th-call-side-seam-fill-hover)" : "transparent" } as React.CSSProperties}
      onPointerEnter={() => setAct(true)}
      onPointerLeave={(e) => !(e.buttons & 1) && setAct(false)}
      onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), setAct(true))}
      onPointerMove={onMove}
      onPointerUp={() => setAct(false)}
    >
      <span className={horizontal ? s.hitH : s.hitV} />
    </div>
  );
}

function CallSeam({ collapsed, onFrac, onRelease, startFrac, pageH }: { collapsed: boolean; onFrac: (f: number | null) => void; onRelease: (f: number) => void; startFrac: () => number; pageH: number }) {
  const [hov, setHov] = useState(false);
  const drag = useRef<{ y: number; f: number; cur: number } | null>(null);
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.cur !== d.f) onRelease(d.cur);
    else if (d) onFrac(null);
  };
  return (
    <div
      className={s.seam}
      style={{ cursor: collapsed ? "default" : "row-resize" }}
      onPointerEnter={() => setHov(true)}
      onPointerLeave={() => !drag.current && setHov(false)}
      onPointerDown={(e) => {
        if (collapsed || e.button !== 0) return;
        const f = startFrac();
        drag.current = { y: e.clientY, f, cur: f };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.cur = Math.max(0.2, Math.min(0.85, d.f + (e.clientY - d.y) / Math.max(1, pageH)));
        onFrac(d.cur);
      }}
      onPointerUp={() => endDrag()}
      onPointerCancel={() => endDrag()}
      onLostPointerCapture={() => endDrag()}
      onDoubleClick={() => setPref("ui-call-collapsed", getPref("ui-call-collapsed", "0") === "1" ? "0" : "1")}
      data-testid="call-seam"
    >
      <span className={s.grip} style={{ background: (hov || drag.current) && !collapsed ? "var(--th-call-seam-fill-hover)" : "var(--th-call-seam-fill)" }} />
    </div>
  );
}

export { MobileCallPill, getC };

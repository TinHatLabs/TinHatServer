// menus.tsx — the call's menus (house Menu primitives; modal with the window dim like the rig):
//   LayoutMenu (Main.qml:5661-5683), HiddenMenu (5577-5609), StreamMenu (7106-7236),
//   ParticipantVolumeMenu (ParticipantVolumeMenu.qml) and DevicesMenu (Main.qml:4600-4816).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Menu, MenuItem, CheckMenuItem, MenuSeparator, MenuSectionLabel, SubMenu, Slider, ToolButton, ConfirmDialog, Dialog, TextField, useTip, useIsMobile, type Rect } from "@/ui";
import { openRoom, openSettings, toast, bus } from "@/core/bus";
import { getPref, setPref, usePref } from "@/core/prefs";
import { containerOf, getClient, peekClient } from "@/core/matrix";
import { menuValue, useRegistry, type MemberMenuCtx, type MenuContribution } from "@/core/registry";
import { act, cornerLocal, getC, isShareTile, localpartOf, tileMxid, ui, useC, useCallUi, type Tile, type VolMenuState } from "./store";
import { showAllAndForget, showTile, hideTileRemember, recFlags, type ViewMode } from "./memory";
import { useHoldChrome } from "./chrome";
import type { CallCategory } from "@/features/calls/contract";
import type { LayoutMode } from "./layout";
import s from "./menus.module.css";

// D2: menus sized to their content (min 200 px) instead of the rig's fixed 200 px that elides the labels.
const FIT = { width: "max-content", minWidth: 200, maxWidth: "calc(100vw - 12px)" } as const;

// ---- Layout menu -----------------------------------------------------------------------------

export function LayoutMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const mode = usePref("call-layout", "auto") as LayoutMode;
  const pinned = useCallUi((x) => x.pinned);
  const animate = useCallUi((x) => x.animate);
  const set = (m: LayoutMode) => setPref("call-layout", m);
  return (
    <Menu open={!!anchor} onClose={onClose} anchor={anchor} offset={{ x: 0, y: 2 }} modal title="Layout" style={FIT}>
      <MenuSectionLabel text="Layout" />
      <CheckMenuItem text="Auto — streams big, cams beside" checked={mode === "auto" || !["gallery", "speaker", "sidebar"].includes(mode)} onTriggered={() => set("auto")} />
      <CheckMenuItem text="Gallery — everyone equal" checked={mode === "gallery"} onTriggered={() => set("gallery")} />
      <CheckMenuItem text="Speaker — one big, the rest below" checked={mode === "speaker"} onTriggered={() => set("speaker")} />
      <CheckMenuItem text="Side strip — streams big, everyone beside" checked={mode === "sidebar"} onTriggered={() => set("sidebar")} />
      <MenuSeparator />
      {pinned ? <MenuItem text="Unpin the main tile" onTriggered={() => ui().set({ pinned: null })} /> : <MenuItem text="Pin: hover a tile and press the pin" disabled />}
      <CheckMenuItem text="Animate layout changes" checked={animate} onTriggered={() => ui().set({ animate: !animate })} />
    </Menu>
  );
}

// ---- Hidden-streams menu ---------------------------------------------------------------------

export function HiddenMenu({ anchor, onClose, hidden }: { anchor: HTMLElement | Rect | null; onClose: () => void; hidden: Tile[] }) {
  const flags = useC("recOnlyFlags");
  const mobile = useIsMobile();
  return (
    <Menu open={!!anchor} onClose={onClose} anchor={anchor} offset={{ x: 0, y: 4 }} modal title="Hidden streams" style={FIT}>
      {/* phones: the sheet header already says it */}
      {!mobile && <MenuSectionLabel text="Hidden streams" />}
      {hidden.map((t) => {
        const [ro, tuned] = recFlags(t, flags);
        const who = t.name || tileMxid(t.participant);
        if (ro && !tuned)
          return <MenuItem key={t.id} icon="media-record-symbolic" text={`Tune in to ${who}'s recording stream`} onTriggered={() => act("setTileTunedIn")(t.id, true)} />;
        const suffix = t.kind === "avatar" ? "" : isShareTile(t) ? " — screen share" : " — camera";
        return <MenuItem key={t.id} icon="layer-visible-on-symbolic" text={`Show ${who}${suffix}`} onTriggered={() => showTile(t)} />;
      })}
      <MenuSeparator />
      <MenuItem icon="edit-undo-symbolic" text="Show all & forget" onTriggered={showAllAndForget} />
      <MenuItem text={<span className={`${s.small} ${s.nowrap}`}>Remembered between calls</span>} disabled />
    </Menu>
  );
}

// ---- volume row (stream menu, per-person menu, the Pad's volume sheet) ---------------------------

/** One volume row as drawn (label · 0–200 % slider · value · mute), controlled. The per-person menu wires it to this
 *  device's audio prefs (VolumeRow below); the Pad's volume sheet (features/pad) wires it to the commands it sends to
 *  the device in the call — the same sheet on both. `pending` = the Pad's press is waiting for its answer. */
export function VolumeSliderRow({
  label,
  value,
  muted,
  pending,
  onMoved,
  onRelease,
  onMute,
}: {
  label?: string;
  value: number;
  muted: boolean;
  pending?: boolean;
  onMoved: (v: number) => void;
  onRelease: (v: number) => void;
  onMute: () => void;
}) {
  const muteRef = useRef<HTMLButtonElement>(null);
  const cap = label ?? "";
  return (
    <div className={s.volRow} data-pending={pending ? "" : undefined} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {label !== undefined && <span className={`${s.volLabel} ${muted ? s.dim : ""}`}>{label}</span>}
      <Slider className={s.volSlider} value={value} from={0} to={2} stepSize={0.01} disabled={muted} onMoved={onMoved} onRelease={onRelease} />
      <span className={s.volPct}>{Math.round(value * 100)}%</span>
      <ToolButton
        ref={muteRef}
        iconName={muted ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"}
        iconSize={16}
        className={s.volMute}
        tip={label !== undefined ? (muted ? `Unmute ${cap}` : `Mute ${cap}`) : muted ? "Unmute this stream" : "Mute this stream (just for you)"}
        onClick={onMute}
      />
    </div>
  );
}

/** The per-person menu's header line ("Volume — name  (only for you)"). */
export function VolumeHead({ children }: { children: ReactNode }) {
  return <div className={s.volHead}>{children}</div>;
}

function VolumeRow({ identity, category, label, onChange }: { identity: string; category: CallCategory; label?: string; onChange?: () => void }) {
  const [v, setV] = useState(() => act("volumeFor")(identity, category));
  const [m, setM] = useState(() => act("mutedFor")(identity, category));
  return (
    <VolumeSliderRow
      label={label}
      value={v}
      muted={m}
      onMoved={(x) => {
        setV(x);
        act("pushVolume")(identity, category, x);
      }}
      onRelease={(x) => {
        setV(x);
        act("setVolume")(identity, category, x);
        onChange?.();
      }}
      onMute={() => {
        act("setMuted")(identity, category, !m);
        setM(!m);
        onChange?.();
      }}
    />
  );
}

// ---- Stream menu (tile monitor button) ---------------------------------------------------------

export function StreamMenu(p: {
  tile: Tile;
  anchor: HTMLElement;
  onClose: () => void;
  watched: boolean;
  view: ViewMode;
  viewChanged: boolean;
  onMode: (m: ViewMode) => void;
  onReset: () => void;
}) {
  const share = isShareTile(p.tile);
  const [q, setQ] = useState(() => act("tileQuality")(p.tile.id) || "auto");
  const listen = useCallUi((x) => x.listen.includes(p.tile.id));
  useHoldChrome(true);
  const pick = (v: string) => {
    act("applyTileQuality")(p.tile.id, v);
    setQ(v);
  };
  return (
    <Menu open onClose={p.onClose} anchor={p.anchor} offset={{ x: 0, y: 2 }} modal width={260} title="Stream controls">
      {share && (
        <>
          <CheckMenuItem
            text="Listen to this stream (audio plays only while watched)"
            checked={listen || p.watched}
            onTriggered={() => {
              const l = ui().listen;
              ui().set({ listen: l.includes(p.tile.id) ? l.filter((x) => x !== p.tile.id) : [...l, p.tile.id] });
            }}
          />
          <MenuSeparator />
        </>
      )}
      <MenuSectionLabel text="Volume" />
      <VolumeRow identity={p.tile.participant} category={share ? "screenshare" : "mic"} />
      <MenuSeparator />
      <MenuSectionLabel text="Quality" />
      {[
        ["auto", "Auto"],
        ["1080", "1080p"],
        ["720", "720p"],
        ["360", "360p"],
        ["180", "180p"],
      ].map(([k, l]) => (
        <CheckMenuItem key={k} text={l} checked={q === k} onTriggered={() => pick(k)} />
      ))}
      <MenuSeparator />
      <MenuSectionLabel text="View" />
      <CheckMenuItem text="Auto — fill when the crop is small" checked={p.view === "auto"} onTriggered={() => p.onMode("auto")} />
      <CheckMenuItem text="Fill the tile (crop, no bars)" checked={p.view === "fill"} onTriggered={() => p.onMode("fill")} />
      <CheckMenuItem text="Fit the whole picture (bars)" checked={p.view === "fit"} onTriggered={() => p.onMode("fit")} />
      <MenuItem text="Reset zoom & position" disabled={!p.viewChanged} onTriggered={p.onReset} />
      <MenuItem text={<span className={s.small}>Ctrl+scroll or the − / + pill zooms · drag pans · double-click resets</span>} disabled />
      <MenuSeparator />
      <MenuItem icon="layer-visible-off-symbolic" text="Hide stream (stops its bandwidth)" onTriggered={() => hideTileRemember(p.tile)} />
    </Menu>
  );
}

// ---- Per-person menu (ParticipantVolumeMenu.qml) ---------------------------------------------

export interface ParticipantVolumeMenuProps {
  mxid: string;
  identity?: string;
  name?: string;
  anchor: VolMenuState["anchor"] | HTMLElement;
  onClose: () => void;
  /** the room of the call (moderation / space); defaults to the call's room */
  roomId?: string;
}

function myUserId(): string {
  return peekClient()?.getUserId() ?? "";
}

/** The fake call (?fakecall=1) shows real people's ids on its tiles — never send anything for them. */
export function fakeGuard(): boolean {
  if (!getC().fake || /[?&]fakewrite=1/.test(location.search)) return false;
  toast("Fake call — nothing was sent", { timeoutMs: 2500 });
  return true;
}

/** One r.memberMenu row with its optional tooltip (MenuContribution.tooltip / tooltipDelay). */
function MemberRow({ it, ctx }: { it: MenuContribution<MemberMenuCtx>; ctx: MemberMenuCtx }) {
  const ref = useRef<HTMLDivElement>(null);
  const tip = it.tooltip ? menuValue(it.tooltip, ctx) : "";
  useTip(ref, tip || undefined, { delay: it.tooltipDelay ?? 400 });
  const label = menuValue(it.label, ctx);
  const icon = it.icon ? menuValue(it.icon, ctx) : undefined;
  const enabled = it.enabled ? it.enabled(ctx) : true;
  const run = () => {
    if (fakeGuard()) return;
    it.run(ctx);
  };
  return (
    <div ref={ref}>
      {it.checked ? (
        <CheckMenuItem text={label} icon={icon} checked={it.checked(ctx)} disabled={!enabled} danger={it.danger} onTriggered={run} />
      ) : (
        <MenuItem text={label} icon={icon} disabled={!enabled} danger={it.danger} onTriggered={run} />
      )}
    </div>
  );
}

/** The r.memberMenu rows in [from, to) of `order` — a section label only where the section changes. */
function MemberRows({ items, ctx, from, to }: { items: MenuContribution<MemberMenuCtx>[]; ctx: MemberMenuCtx; from: number; to: number }) {
  const vis = items.filter((it) => it.order >= from && it.order < to && (it.visible ? it.visible(ctx) : true));
  let section = "";
  return (
    <>
      {vis.map((it, i) => {
        const sec = it.section && it.section !== section ? it.section : "";
        if (it.section) section = it.section;
        return (
          <Fragment key={it.id}>
            {it.separatorBefore && i > 0 && <MenuSeparator />}
            {sec && <MenuSectionLabel text={sec} />}
            <MemberRow it={it} ctx={ctx} />
          </Fragment>
        );
      })}
    </>
  );
}

export function ParticipantVolumeMenu(p: ParticipantVolumeMenuProps) {
  const inCall = useC("inCall");
  const tiles = useC("tiles");
  const corner = useC("corner");
  const callRoom = useC("callRoomId");
  const fake = useC("fake");
  const rows = useRegistry("memberMenu");
  const [, bump] = useState(0);
  const me = myUserId();
  const mxid = p.mxid;
  const identity = p.identity || tiles.find((t) => tileMxid(t.participant) === mxid && t.id !== "vid_selfview")?.participant || "";
  const tile = tiles.find((t) => t.participant === identity) ?? tiles.find((t) => tileMxid(t.participant) === mxid);
  const name = p.name || tile?.name || localpartOf(mxid);
  const roomId = p.roomId || callRoom;
  const notMe = mxid !== me;
  // Corner rows only for someone in OUR call (the nav strip also opens this menu for other rooms' calls).
  const inTheCall = (inCall || fake) && notMe && !!identity && (!p.roomId || !callRoom || p.roomId === callRoom || fake);
  const myCorner = corner.mine;
  const theirCorner = Object.entries(corner.corners).find(([, ms]) => ms.some((m) => m === identity || tileMxid(m) === mxid))?.[0] ?? "";
  const cornerItem = !inTheCall ? "" : !theirCorner ? (myCorner ? "Pull into your corner" : "Pull aside") : theirCorner !== myCorner ? "Join their corner" : "Leave the corner";
  // Same room (11.3): link up with someone sitting next to you / unlink
  const srs = useC("sameRoom");
  const srLinked = !!identity && srs.linked.includes(identity);
  const srItem = !inTheCall ? "" : srLinked ? "Unlink — same room" : "We're in the same room";
  const anyVol = (["mic", "screenshare", "music"] as CallCategory[]).some((c) => {
    const id = identity || mxid;
    return act("volumeFor")(id, c) !== 1 || act("mutedFor")(id, c);
  });
  const asideTipRef = useRef<HTMLDivElement>(null);
  useTip(asideTipRef, cornerItem.startsWith("Pull") ? "Just you two (and whoever joins): everyone else drops to 10 % for you both, and nobody else hears your mics. Either of you leaves with the yellow button" : undefined, { delay: 600 });
  const needId = () => {
    if (!identity) toast("They're not in the call", { timeoutMs: 3000 });
    return !!identity;
  };
  const anchor = p.anchor instanceof HTMLElement ? p.anchor : "width" in p.anchor ? (p.anchor as Rect) : p.anchor;
  const id = identity || mxid;
  const ctx: MemberMenuCtx = useMemo(() => ({ userId: mxid, roomId, identity: identity || undefined }), [mxid, roomId, identity]);
  // ParticipantVolumeMenu.qml order: Message · Pull aside / corner rows · [Moderation] mute · disconnect ·
  // kick · ban · roles · Volume. Message / moderation / space rows come from r.memberMenu (spaces owns them).
  return (
    <Menu open onClose={p.onClose} anchor={anchor} modal width={366} title={name}>
      <MemberRows items={rows} ctx={ctx} from={-Infinity} to={50} />
      {cornerItem && (
        <div ref={asideTipRef}>
          <MenuItem
            icon={cornerItem === "Join their corner" ? "list-add-user" : cornerItem === "Leave the corner" ? "go-previous-symbolic" : "audio-input-microphone-symbolic"}
            text={cornerItem}
            onTriggered={() => {
              if (cornerItem === "Leave the corner") return act("leaveCorner")();
              if (!needId()) return;
              cornerLocal.at = Date.now();
              const err = cornerItem === "Join their corner" ? act("joinCorner")(identity) : act("pullAside")(identity);
              if (err) toast(err, { timeoutMs: 3000 });
            }}
          />
        </div>
      )}
      {srItem && (
        <MenuItem
          icon={srLinked ? "go-previous-symbolic" : "audio-input-microphone-symbolic"}
          text={srItem}
          onTriggered={() => {
            if (srLinked) return act("sameRoomUnlink")();
            if (!needId()) return;
            const err = act("sameRoomLink")(identity);
            if (err) toast(err, { timeoutMs: 3000 });
          }}
        />
      )}
      <MemberRows items={rows} ctx={ctx} from={50} to={Infinity} />
      {notMe && <MenuSeparator />}
      <VolumeHead>Volume — {name}{"  "}(only for you)</VolumeHead>
      <VolumeRow identity={id} category="mic" label="Their mic" onChange={() => bump((n) => n + 1)} />
      <VolumeRow identity={id} category="screenshare" label="Their screen share" onChange={() => bump((n) => n + 1)} />
      <VolumeRow identity={id} category="music" label="Their soundboard" onChange={() => bump((n) => n + 1)} />
      <MenuSeparator />
      <MenuItem
        text="Reset all to 100%"
        disabled={!anyVol}
        onTriggered={() => {
          for (const c of ["mic", "screenshare", "music"] as CallCategory[]) {
            act("setVolume")(id, c, 1);
            act("setMuted")(id, c, false);
          }
        }}
      />
    </Menu>
  );
}

/** Host for the per-person menu opened from tiles (state in useCallUi.volMenu). */
export function VolMenuHost() {
  const vm = useCallUi((x) => x.volMenu);
  if (!vm) return null;
  return <ParticipantVolumeMenu key={vm.identity + vm.mxid} mxid={vm.mxid} identity={vm.identity} name={vm.name} anchor={vm.anchor} onClose={() => ui().set({ volMenu: null })} />;
}

// ---- Devices menu (gear ▾) ---------------------------------------------------------------------

// AppCore.qml:878-905 — Resolution × Frame rate × Bandwidth; kbps = base(res) × tier factor.
export const SHARE_RES: { label: string; w: number; h: number; base: number }[] = [
  { label: "Auto — fit my connection", w: 0, h: 0, base: 12000 },
  { label: "720p", w: 1280, h: 720, base: 4000 },
  { label: "1080p", w: 1920, h: 1080, base: 8000 },
  { label: "1440p", w: 2560, h: 1440, base: 12000 },
  { label: "2160p (4K)", w: 3840, h: 2160, base: 16000 },
  { label: "Source (native)", w: 4096, h: 4096, base: 18000 },
];
export const SHARE_BW: { label: string; f: number }[] = [
  { label: "Good — lightest", f: 0.6 },
  { label: "Great — balanced", f: 1.0 },
  { label: "Best — most bandwidth", f: 1.5 },
  { label: "Unleashed — LAN-grade", f: 2.5 },
];
const FPS = [5, 15, 30, 60];
// Encoder tags as stored in the 5th field of shareQuality (native call_ctl: nvenc | vp9 | h264).
const ENC: [string, string][] = [
  ["GPU · best (AV1 on RTX 40+, else H.264)", "nvenc"],
  ["Sharpest · VP9 (CPU) — best for text/docs", "vp9"],
  ["GPU · force H.264 (compat)", "h264"],
];

export function shareCurRes(q: { w: number; h: number }) {
  return SHARE_RES.find((r) => r.w === q.w && r.h === q.h) ?? SHARE_RES[2];
}
export function shareCurTier(q: { w: number; h: number; kbps: number }) {
  const base = shareCurRes(q).base;
  let best = 1,
    bestD = 1e12;
  SHARE_BW.forEach((t, i) => {
    const d = Math.abs(q.kbps - Math.round(base * t.f));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function parseShareQuality(q: string) {
  const [w, h, fps, kbps, enc] = (q || "").split(/\s+/);
  return { w: Number(w) || 0, h: Number(h) || 0, fps: Number(fps) || 30, kbps: Number(kbps) || 0, enc: enc || "auto" };
}

export function DevicesMenu({ anchor, onClose, roomId }: { anchor: HTMLElement | Rect | null; onClose: () => void; roomId: string }) {
  const inputs = useC("inputs");
  const outputs = useC("outputs");
  const cameras = useC("cameras");
  const inputName = useC("inputName");
  const outputName = useC("outputName");
  const cameraName = useC("cameraName");
  const inCall = useC("inCall");
  const musicPlaying = useC("musicPlaying");
  const shareQ = parseShareQuality(useC("shareQuality"));
  const inputPref = usePref("call-input", "");
  const outputPref = usePref("call-output", "");
  const camPref = usePref("call-camera", "");
  const savedSource = usePref("music-source", "");
  const [urlOpen, setUrlOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const roomMenu = useRegistry("roomMenu");
  const callFeatures = useMemo(() => roomMenu.filter((i) => (i as { section?: string }).section === "call" || i.section === "Call features"), [roomMenu]);
  useHoldChrome(!!anchor);
  const sinkOk = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function";
  const cur = (list: { id: string; name: string }[], pref: string, name: string) => list.find((d) => d.id === pref)?.id ?? list.find((d) => d.name === name)?.id ?? "";
  const curIn = cur(inputs, inputPref, inputName);
  const curOut = cur(outputs, outputPref, outputName);
  const curCam = cur(cameras, camPref, cameraName);
  const applyQ = (w: number, h: number, fps: number, kbps: number) => act("applyShareQuality")(w, h, fps, kbps);
  return (
    <>
      <Menu open={!!anchor} onClose={onClose} anchor={anchor} modal width={250} title="Call & device settings">
        <MenuSectionLabel text="Devices" />
        <SubMenu title="Microphone" icon="audio-input-microphone-symbolic" width={300}>
          <CheckMenuItem text="System default" checked={!curIn || curIn === "default"} onTriggered={() => act("setInput")("")} />
          {inputs.filter((d) => d.id && d.id !== "default").map((d) => (
            <CheckMenuItem key={d.id} text={d.name} checked={curIn === d.id} onTriggered={() => act("setInput")(d.id)} />
          ))}
        </SubMenu>
        <SubMenu title="Speaker" icon="audio-volume-high-symbolic" width={300}>
          <CheckMenuItem text="System default" checked={!curOut || curOut === "default"} onTriggered={() => act("setOutput")("")} />
          {sinkOk &&
            outputs.filter((d) => d.id && d.id !== "default").map((d) => (
              <CheckMenuItem key={d.id} text={d.name} checked={curOut === d.id} onTriggered={() => act("setOutput")(d.id)} />
            ))}
        </SubMenu>
        <SubMenu title="Camera" icon="camera-video-symbolic" width={300}>
          <CheckMenuItem text="Default (first camera)" checked={!curCam} onTriggered={() => act("setCamera")("")} />
          {cameras.map((d) => (
            <CheckMenuItem key={d.id} text={d.name} checked={curCam === d.id} onTriggered={() => act("setCamera")(d.id)} />
          ))}
        </SubMenu>
        <MenuSeparator />
        <MenuSectionLabel text="Share audio" />
        <SubMenu title="Share audio output" icon="folder-music-symbolic" width={300}>
          <MenuItem text="Share tab/system audio…" disabled={!inCall} onTriggered={() => act("startMusicSource")(savedSource || "browser")} />
        </SubMenu>
        <MenuItem text="Play music from file…" disabled={!inCall} onTriggered={() => fileRef.current?.click()} />
        <MenuItem icon="link-symbolic" text="Play music from URL…" disabled={!inCall} onTriggered={() => setUrlOpen(true)} />
        <MenuItem icon="media-playback-stop-symbolic" text="Stop sharing audio" disabled={!musicPlaying} onTriggered={() => act("stopMusic")()} />
        <MenuSeparator />
        <MenuSectionLabel text="Quality" />
        <SubMenu title="Screen-share quality" icon="monitor-symbolic" width={330}>
          <MenuSectionLabel text="Resolution" />
          {SHARE_RES.map((r) => (
            <CheckMenuItem
              key={r.label}
              text={r.label}
              checked={shareQ.w === r.w && shareQ.h === r.h}
              onTriggered={() => applyQ(r.w, r.h, shareQ.fps, Math.round(r.base * SHARE_BW[shareCurTier(shareQ)].f))}
            />
          ))}
          <MenuSeparator />
          <MenuSectionLabel text="Frame rate" />
          {FPS.map((f) => (
            <CheckMenuItem key={f} text={`${f} fps`} checked={shareQ.fps === f} onTriggered={() => applyQ(shareQ.w, shareQ.h, f, shareQ.kbps)} />
          ))}
          <MenuSeparator />
          <MenuSectionLabel text="Bandwidth" />
          {SHARE_BW.map((t, i) => {
            const base = shareCurRes(shareQ).base;
            return (
              <CheckMenuItem
                key={t.label}
                text={`${t.label}  (~${Math.round((base * t.f) / 100) / 10} Mbps)`}
                checked={shareCurTier(shareQ) === i}
                onTriggered={() => applyQ(shareQ.w, shareQ.h, shareQ.fps, Math.round(base * t.f))}
              />
            );
          })}
          <MenuSeparator />
          <MenuSectionLabel text="Encoder (advanced)" />
          {ENC.map(([l, k]) => (
            <CheckMenuItem key={k} text={l} checked={shareQ.enc === k || (k === "nvenc" && !["vp9", "h264"].includes(shareQ.enc))} onTriggered={() => act("applyShareEncoder")(k)} />
          ))}
        </SubMenu>
        <MenuItem icon="settings-configure-symbolic" text="All call & quality settings…" onTriggered={() => openSettings("calls")} />
        <MenuSeparator />
        <MenuSectionLabel text="Call features" />
        {callFeatures.length ? (
          callFeatures.map((it) => (
            <MenuItem
              key={it.id}
              icon={typeof it.icon === "function" ? it.icon({ roomId }) : it.icon}
              text={typeof it.label === "function" ? it.label({ roomId }) : it.label}
              onTriggered={() => it.run({ roomId })}
            />
          ))
        ) : (
          <MenuItem icon="video-television-symbolic" text="Media Party" onTriggered={() => bus.emit("openWindow", { id: "watchparty", props: { roomId } })} />
        )}
        <MenuSeparator />
        <MenuItem
          icon="view-refresh-symbolic"
          text="Refresh this room"
          onTriggered={() => {
            const r = peekClient()?.getRoom(roomId);
            void r?.loadMembersIfNeeded();
            toast("Refreshing this room…");
          }}
        />
      </Menu>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        aria-label="Play music in call"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) act("startMusic")(f);
          e.target.value = "";
        }}
      />
      <MusicUrlDialog open={urlOpen} onClose={() => setUrlOpen(false)} />
    </>
  );
}

function MusicUrlDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (open) setUrl(getPref("music-url-last", ""));
  }, [open]);
  const play = () => {
    const u = url.trim();
    if (!u) return;
    setPref("music-url-last", u);
    act("startMusic")(u);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Play music from URL"
      width="min(460px, calc(100vw - 36px))"
      buttons={[
        { text: "Play", role: "accept", onClick: play, disabled: !url.trim() },
        { text: "Cancel", role: "reject", onClick: onClose },
      ]}
    >
      <TextField value={url} placeholder="https://… (an audio file or stream)" onChange={(e) => setUrl(e.target.value)} onAccepted={play} aria-label="Music URL" />
    </Dialog>
  );
}

export function useIsSelf(mxid: string) {
  return mxid === myUserId();
}
export { getC };

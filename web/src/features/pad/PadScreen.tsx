// PadScreen.tsx — the Pad (DESIGN §1 "On the controller"): my phone as a remote for the call ANOTHER device of mine is
// in. Phones: full screen in the phone call screen's visual language (Mobile.tsx: the top bar with its round 44 px
// button, the banners, the scroller); desktop layouts: a panel the size of the soundboard window (SoundboardPopover).
//
//   header      the call's room · "on <device> ▾" (a chooser only when two of my devices are in that call) · the
//               connection dot ("Not reaching <device>" when the PC doesn't answer)
//   my row      Mute/Unmute · Deafen · BRB · Stop sound · Leave (Leave asks first, here) — the call bar's round buttons;
//               in push to talk the mic says "Push to talk is on at <device>" instead of a toggle
//   soundboard  my Favourites (the Soundboard pad's grid, starred order), the call room's sounds, the PC's Recent; the
//               playing one glows, tapping it stops it; the role line under it when the call's roles turned it off
//   people      avatar + talking ring, mic-off, 💤; a tap → "Volume — <name> (on <device>)": the per-person menu's
//               three sliders (VolumeSliderRow), a mute each, "Reset all to 100%"
// Presses are optimistic (the button moves at once, a thin ring until the PC answers, rolled back with its reason).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccountData, useMember, useRoomName } from "@/core/matrix";
import { openRoom } from "@/core/bus";
import { Avatar, BusyIndicator, Button, CheckMenuItem, ConfirmDialog, Icon, Menu, MenuItem, MenuSeparator, OverlayPortal, ScrollArea, cx, useIsMobile, usePopupStack, useTip } from "@/ui";
import { CallButton } from "@/features/callui/CallButton";
import { VolumeHead, VolumeSliderRow } from "@/features/callui/menus";
import { SoundPadButton, SoundPadGrid } from "@/features/widgets/soundpad/SoundPad";
import { PERSONAL_TYPE, useRoomSounds } from "@/features/media/soundboard/data";
import { DEFAULT_EMOJI, padSounds, type PadSound } from "@/widgets/soundpad";
import { whyText, type PadCat } from "@/features/calls/pad/rules";
import type { PadPersonView, PadView } from "@/features/calls/pad/controller";
import { closePad, openPad, padController, useDeviceName, usePadCtrl, usePadDevices, usePadTargets } from "./runtime";
import s from "./PadScreen.module.css";

const PENDING_RING = "var(--th-pad-pending-ring)";
const SHEET_ANCHOR = { x: 0, y: 0, width: 0, height: 0 };

export function PadHost() {
  const open = usePadCtrl((x) => x.open);
  return open ? <PadScreen /> : null;
}

function useNoticeText(): string {
  const notice = usePadCtrl((x) => x.notice);
  const device = useDeviceName(usePadCtrl((x) => x.device));
  return notice ? whyText(notice.code, device, notice.op) : "";
}

function PadScreen() {
  const mobile = useIsMobile();
  const st = usePadCtrl();
  const device = useDeviceName(st.device);
  const view = st.view;
  const room = view?.room || st.room;
  const roomName = useRoomName(room) || "the call";
  const notice = useNoticeText();
  const panel = useRef<HTMLDivElement>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [vol, setVol] = useState<{ u: string; anchor: HTMLElement | null } | null>(null);
  usePopupStack(true, panel, { onEscape: closePad });

  // desktop geometry: the soundboard window's (680 wide at most, bottom 120 px above the window bottom)
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [contentH, setContentH] = useState(0);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const hasView = !!st.view;
  useLayoutEffect(() => {
    if (mobile || !inner.current) return;
    const el = inner.current;
    const ro = new ResizeObserver(() => setContentH(el.scrollHeight));
    ro.observe(el);
    setContentH(el.scrollHeight);
    return () => ro.disconnect();
  }, [mobile, hasView]);
  const width = Math.min(680, win.w - 40);
  const height = Math.min(win.h - 140, Math.max(320, contentH + 72));
  const geo = mobile ? undefined : { left: Math.round((win.w - width) / 2), top: Math.max(16, win.h - height - 120), width, height };

  const live = st.link === "open" || (st.link === "unreachable" && !!view);
  const body = !view ? (
    <PadState link={st.link} device={device} notice={notice} />
  ) : (
    <div ref={inner} className={s.content}>
      <MyRow view={view} device={device} dim={!live} onLeave={() => setLeaveAsk(true)} />
      <Sounds view={view} device={device} mobile={mobile} dim={!live} />
      <People view={view} onPick={(u, el) => setVol({ u, anchor: el })} />
    </div>
  );

  return (
    <OverlayPortal>
      <div ref={panel} role="dialog" aria-label={`Pad — ${roomName} on ${device}`} className={cx(s.pad, mobile ? s.phone : s.panel)} style={geo} data-testid="pad-screen" data-link={st.link}>
        <Header mobile={mobile} roomName={roomName} room={room} device={device} link={st.link} />
        {view && notice && (
          <div className={cx(s.banner, st.link === "ended" ? s.bad : s.warn)} role="status">
            <span className={s.bannerText}>{notice}</span>
            {st.link === "unreachable" ? (
              <button type="button" className={s.bannerBtn} onClick={() => padController()?.retry()}>
                Try again
              </button>
            ) : (
              <button type="button" className={s.bannerX} aria-label="Dismiss" onClick={() => padController()?.dismiss()}>
                <Icon name="window-close-symbolic" size={16} color="var(--th-call-conn-banner-title-fg)" />
              </button>
            )}
          </div>
        )}
        {mobile ? (
          <div className={s.scroller}>{body}</div>
        ) : (
          <ScrollArea className={s.body} contentClassName={s.bodyScroll}>
            {body}
          </ScrollArea>
        )}
      </div>
      {vol && view && <VolumeSheet view={view} u={vol.u} anchor={mobile ? SHEET_ANCHOR : vol.anchor} device={device} onClose={() => setVol(null)} />}
      <ConfirmDialog
        open={leaveAsk}
        onClose={() => setLeaveAsk(false)}
        dialogTitle={`Leave the call on ${device}?`}
        message={`${device} hangs up. You can join again from there, or with Join here.`}
        confirmText="Leave"
        destructive
        onConfirmed={() => padController()?.leave()}
      />
    </OverlayPortal>
  );
}

// ---- header ---------------------------------------------------------------------------------------------------

function Header({ mobile, roomName, room, device, link }: { mobile: boolean; roomName: string; room: string; device: string; link: string }) {
  const targets = usePadTargets(room);
  const cur = usePadCtrl((x) => x.device);
  const [chooser, setChooser] = useState<HTMLElement | null>(null);
  const names = usePadDevices((x) => x.names);
  const choose = targets.length > 1;
  const dot = link === "open" ? "var(--th-pad-dot-live)" : "var(--th-pad-dot)";
  const status = link === "open" ? "Connected" : link === "opening" ? `Connecting to ${device}…` : link === "unreachable" ? `Not reaching ${device}` : "Not connected";
  const short = link === "opening" ? "Connecting…" : link === "unreachable" ? "Not reaching it" : "Not connected";
  const dotRef = useRef<HTMLSpanElement>(null);
  useTip(dotRef, status);
  const onDev = (
    <button type="button" className={cx(s.devBtn, !choose && s.devStatic)} disabled={!choose} onClick={(e) => setChooser(chooser ? null : e.currentTarget)} aria-haspopup={choose ? "menu" : undefined}>
      on <b>{device}</b>
      {choose && <span className={s.caret}>▾</span>}
    </button>
  );
  return (
    <div className={s.top}>
      {mobile && (
        <button type="button" className={s.topBtn} aria-label="Close the Pad" onClick={closePad} data-testid="pad-close">
          <Icon name="go-previous-symbolic" size={22} color="var(--th-stage-top-button-icon)" />
        </button>
      )}
      <div className={s.topText}>
        <div className={s.topTitle}>
          <span ref={dotRef} className={s.dot} style={{ background: dot }} data-testid="pad-dot" aria-label={status} />
          <span className={s.titleText}>Pad</span>
          <span className={s.titleSep}>·</span>
          <button type="button" className={s.roomBtn} onClick={() => room && openRoom(room)} title={`Open ${roomName}`}>
            {roomName}
          </button>
        </div>
        <div className={s.topSub}>
          {onDev}
          {link !== "open" && <span className={cx(s.link, link === "unreachable" && s.linkBad)}>{short}</span>}
        </div>
      </div>
      {!mobile && (
        <button type="button" className={s.closeBtn} aria-label="Close the Pad" title="Close the Pad (Esc)" onClick={closePad} data-testid="pad-close">
          <Icon name="window-close-symbolic" size={16} color="var(--th-soundboard-title-fg)" />
        </button>
      )}
      {choose && (
        <Menu open={!!chooser} onClose={() => setChooser(null)} anchor={mobile ? SHEET_ANCHOR : chooser} modal title="Control the call on…">
          {[...targets].sort((a, b) => Number(b.ready) - Number(a.ready)).map((t) => (
            <CheckMenuItem
              key={t.device}
              text={t.ready ? names[t.device] || t.device : `${names[t.device] || t.device} — ${whyText(t.why, names[t.device] || t.device)}`}
              checked={t.device === cur}
              disabled={!t.ready}
              onTriggered={() => openPad(room, t.device)}
            />
          ))}
        </Menu>
      )}
    </div>
  );
}

// ---- no call to show (connecting, not reaching, ended) -------------------------------------------------------------

function PadState({ link, device, notice }: { link: string; device: string; notice: string }) {
  if (link === "opening")
    return (
      <div className={s.state}>
        <BusyIndicator size={36} />
        <div className={s.stateText}>Connecting to {device}…</div>
      </div>
    );
  if (link === "unreachable")
    return (
      <div className={s.state}>
        <Icon name="network-disconnect-symbolic" size={40} color="var(--th-call-empty-fg)" />
        <div className={s.stateText}>Not reaching {device}</div>
        <div className={s.stateHint}>It may be asleep, offline, or not running Tin Hat any more.</div>
        <Button highlighted text="Try again" onClick={() => padController()?.retry()} />
      </div>
    );
  const code = usePadCtrl((x) => x.notice?.code ?? "");
  return (
    <div className={s.state}>
      <Icon name="call-stop-symbolic" size={40} color="var(--th-call-empty-fg)" />
      <div className={s.stateText}>{notice || `${device} isn't in a call any more.`}</div>
      <div className={s.stateButtons}>
        {(code === "replaced" || code === "unreachable") && <Button highlighted text={code === "replaced" ? "Take it back" : "Try again"} onClick={() => padController()?.retry()} />}
        <Button text="Close" onClick={closePad} />
      </div>
    </div>
  );
}

// ---- my row --------------------------------------------------------------------------------------------------------

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.cell}>
      {children}
      <span className={s.cellLabel}>{label}</span>
    </div>
  );
}

function useRev(): number {
  return usePadCtrl((x) => x.rev);
}

function MyRow({ view, device, dim, onLeave }: { view: PadView; device: string; dim: boolean; onLeave: () => void }) {
  useRev();
  const c = padController();
  const me = view.me;
  const can = (op: string) => !dim && !!c?.canSend(op);
  const pend = (k: string) => (c?.isPending(k) ? PENDING_RING : undefined);
  const mic =
    me.mic === "ptt" ? (
      <Cell label="Push to talk">
        <CallButton icon="audio-input-microphone-symbolic" tip={`Push to talk is on at ${device} — use the key there.`} live={false} />
      </Cell>
    ) : me.mic === "server" ? (
      <Cell label="Muted for all">
        <CallButton icon="microphone-sensitivity-muted-symbolic" tip={whyText("server-muted", device, "mic")} danger live={false} />
      </Cell>
    ) : (
      <Cell label={me.mic === "muted" ? "Unmute" : "Mute"}>
        <CallButton
          data-id="pad-mic"
          icon={me.mic === "muted" ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"}
          tip={me.mic === "muted" ? `Unmute — ${device}'s mic goes live` : "Mute"}
          danger={me.mic === "muted"}
          ring={pend("mic")}
          live={can("mic")}
          onClick={() => c?.setMic(me.mic !== "muted")}
        />
      </Cell>
    );
  return (
    <div className={s.myWrap}>
      <div className={s.myRow} data-testid="pad-my-row">
        {mic}
        <Cell label={me.deaf ? "Undeafen" : "Deafen"}>
          <CallButton data-id="pad-deafen" icon={me.deaf ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"} tip={me.deaf ? "Undeafen" : "Deafen — mute everything for you"} danger={me.deaf} ring={pend("deaf")} live={can("deafen")} onClick={() => c?.setDeafen(!me.deaf)} />
        </Cell>
        <Cell label={me.brb ? "I'm back" : "BRB"}>
          <CallButton data-id="pad-brb" icon="appointment-missed-symbolic" tip={me.brb ? "I'm back" : "Be right back"} active={me.brb} ring={pend("brb")} live={can("brb")} onClick={() => c?.setBrb(!me.brb)} />
        </Cell>
        <Cell label="Stop sound">
          <CallButton data-id="pad-stop" icon="media-playback-stop" tip="Stop the sound (for everyone)" live={can("sound.stop") && !!me.sound} onClick={() => c?.stopSound()} />
        </Cell>
        <Cell label="Leave">
          <CallButton data-id="pad-leave" wide icon="call-stop-symbolic" tip={`Leave the call on ${device}`} danger live={can("leave")} onClick={onLeave} />
        </Cell>
      </div>
      {me.mic === "ptt" && <div className={s.myNote}>Push to talk is on at {device} — use the key there.</div>}
    </div>
  );
}

// ---- soundboard ----------------------------------------------------------------------------------------------------

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className={s.sectionHead}>
      <span className={s.sectionTitle}>{title}</span>
      {hint && <span className={s.sectionHint}>{hint}</span>}
    </div>
  );
}

function Sounds({ view, device, mobile, dim }: { view: PadView; device: string; mobile: boolean; dim: boolean }) {
  useRev();
  const c = padController();
  const favContent = useAccountData(PERSONAL_TYPE);
  const favs = useMemo(() => padSounds(favContent), [favContent]);
  const roomSounds = useRoomSounds(view.room);
  const here: PadSound[] = useMemo(() => roomSounds.map((r) => ({ name: r.name, url: r.sourceUrl, emoji: r.emoji.trim() || DEFAULT_EMOJI })), [roomSounds]);
  const recent: PadSound[] = useMemo(() => view.recent.map((r) => ({ name: r.name || "Sound", url: r.url, emoji: r.emoji.trim() || DEFAULT_EMOJI })), [view.recent]);
  const gate = view.me.gate;
  const can = !dim && gate.allowed && !!c?.canSend("sound.play");
  const pending = !!c?.isPending("sound");
  const cols = mobile ? 3 : 4;
  const grid = (list: PadSound[], key: string) => (
    <SoundPadGrid mobile={mobile} columns={cols}>
      {list.map((d) => {
        const playing = view.me.sound === d.url;
        return <SoundPadButton key={`${key}:${d.url}`} d={d} playing={playing} pending={pending && playing} disabled={!can} onPress={() => (playing ? c?.stopSound() : c?.playSound(d.url))} />;
      })}
    </SoundPadGrid>
  );
  return (
    <section className={s.section} data-testid="pad-sounds">
      <SectionHead title="Soundboard" hint={`plays on ${device}, into the call`} />
      <SectionHead title="Favourites" />
      {favs.length ? grid(favs, "fav") : <div className={s.empty}>Star sounds in the soundboard to pin them here.</div>}
      {here.length > 0 && (
        <>
          <SectionHead title="This room" />
          {grid(here, "room")}
        </>
      )}
      {recent.length > 0 && (
        <>
          <SectionHead title={`Recent on ${device}`} />
          {grid(recent, "recent")}
        </>
      )}
      {!gate.allowed && gate.hint && <div className={s.roleLine}>{gate.hint}</div>}
    </section>
  );
}

// ---- people --------------------------------------------------------------------------------------------------------

function People({ view, onPick }: { view: PadView; onPick: (u: string, el: HTMLElement) => void }) {
  const n = view.people.length + view.more;
  return (
    <section className={s.section} data-testid="pad-people">
      <SectionHead title={n ? `In the call · ${n}` : "In the call"} hint={n ? "tap someone for their volumes" : undefined} />
      {view.people.length === 0 ? (
        <div className={s.empty}>Nobody else is in the call yet.</div>
      ) : (
        <div className={s.people}>
          {view.people.map((p) => (
            <PersonRow key={p.u} p={p} room={view.room} onPick={onPick} />
          ))}
          {view.more > 0 && <div className={s.more}>+{view.more} more</div>}
        </div>
      )}
    </section>
  );
}

function custom(p: PadPersonView): string {
  const bits: string[] = [];
  if (p.mute.mic) bits.push("mic muted");
  else if (p.vol.mic !== 1) bits.push(`mic ${Math.round(p.vol.mic * 100)}%`);
  if (p.mute.screenshare) bits.push("share muted");
  else if (p.vol.screenshare !== 1) bits.push(`share ${Math.round(p.vol.screenshare * 100)}%`);
  if (p.mute.music) bits.push("sounds muted");
  else if (p.vol.music !== 1) bits.push(`sounds ${Math.round(p.vol.music * 100)}%`);
  return bits.join(" · ");
}

function PersonRow({ p, room, onPick }: { p: PadPersonView; room: string; onPick: (u: string, el: HTMLElement) => void }) {
  const m = useMember(room, p.u);
  const name = m?.rawName && m.rawName !== p.u ? m.rawName : m?.name || p.u.replace(/^@/, "").split(":")[0];
  const line = custom(p);
  return (
    <button type="button" className={s.person} onClick={(e) => onPick(p.u, e.currentTarget)} data-person={p.u} aria-label={`${name} — volumes`}>
      <span className={cx(s.face, p.talk && s.talking)}>
        <Avatar size={36} name={name} seed={p.u} imageSource={m?.avatarMxc ?? null} />
      </span>
      <span className={s.personText}>
        <span className={s.personName}>{name}</span>
        {line && <span className={s.personSub}>{line}</span>}
      </span>
      {p.away && (
        <span className={s.badge} title="Away (BRB)" aria-label="away">
          💤
        </span>
      )}
      {p.micOff && <Icon name="microphone-sensitivity-muted-symbolic" size={18} color="var(--th-call-volume-label-fg-muted)" aria-label="mic off" />}
      <svg className={s.chev} width="8" height="14" viewBox="0 0 8 14" aria-hidden>
        <path d="M1.5 1.5 L6.5 7 L1.5 12.5" fill="none" stroke="var(--th-call-volume-value-fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// ---- the volume sheet ----------------------------------------------------------------------------------------------

const ROWS: [PadCat, string][] = [
  ["mic", "Their mic"],
  ["screenshare", "Their screen share"],
  ["music", "Their soundboard"],
];

function VolumeSheet({ view, u, anchor, device, onClose }: { view: PadView; u: string; anchor: HTMLElement | typeof SHEET_ANCHOR | null; device: string; onClose: () => void }) {
  useRev();
  const c = padController();
  const p = view.people.find((x) => x.u === u);
  const m = useMember(view.room, u);
  const name = m?.rawName && m.rawName !== u ? m.rawName : m?.name || u.replace(/^@/, "").split(":")[0];
  const [drag, setDrag] = useState<Partial<Record<PadCat, number>>>({});
  useEffect(() => {
    if (!p) onClose();
  }, [p, onClose]);
  if (!p) return null;
  const anyCustom = ROWS.some(([cat]) => p.vol[cat] !== 1 || p.mute[cat]);
  return (
    <Menu open onClose={onClose} anchor={anchor} modal width={366} title={name}>
      <VolumeHead>{`Volume — ${name} (on ${device})`}</VolumeHead>
      {ROWS.map(([cat, label]) => (
        <VolumeSliderRow
          key={cat}
          label={label}
          value={drag[cat] ?? p.vol[cat]}
          muted={p.mute[cat]}
          pending={!!c?.isPending(`vol:${u}:${cat}`) || !!c?.isPending(`mute:${u}:${cat}`)}
          onMoved={(x) => {
            setDrag((d) => ({ ...d, [cat]: x }));
            c?.volume(u, cat, x, true);
          }}
          onRelease={(x) => {
            setDrag((d) => {
              const n = { ...d };
              delete n[cat];
              return n;
            });
            c?.volume(u, cat, x, false);
          }}
          onMute={() => c?.volumeMute(u, cat, !p.mute[cat])}
        />
      ))}
      <MenuSeparator />
      <MenuItem text="Reset all to 100%" disabled={!anyCustom} onTriggered={() => c?.volumeReset(u)} keepOpen />
    </Menu>
  );
}

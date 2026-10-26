// pad/runtime.ts — Pad's wiring into the app (docs/PAD.md; the pure parts live in features/calls/pad/):
//
//   transport   one PadTransport on the signed-in client: ClientEvent.ReceivedToDeviceMessage → the two Pad types
//               (next to keys.ts' call-key intake), the trust cache dropped on every device-list / trust change
//   receiver    one PadReceiver: its snapshot comes from the call store + the soundboard + the audio prefs, its
//               executor calls the very commands the call bar / soundboard / per-person menu call, its pushes follow
//               every store change; the chip's store (usePadReceiver) lists the live sessions with device names
//   controller  at most one PadController (the open Pad screen) + its store (usePadCtrl) for the UI
//   discovery   usePadTargets(room) / useMyCallsElsewhere() from the rooms' call memberships (padTargets); inside
//               the Tin Hat iOS / Android apps the phone's own native call device is never a target (targets.ts;
//               every id the app reported is remembered per account, `tinhat.user.pad-native-devices`)
//   setting     Settings → Calls → Pad (pref `pad-allow`): off → every session ends (`off`) and the membership is
//               re-published without the `pad1` cap
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { ClientEvent, RoomStateEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { getCryptoStatus, getSession, onClientChanged, peekClient, useCryptoStatus, useSession } from "@/core/matrix";
import { getPref, onPrefChange, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { openSettings, toast } from "@/core/bus";
import { republishMembership, useCallStore } from "@/features/calls";
import type { CallStore } from "@/features/calls/contract";
import { sess } from "@/features/calls/session";
import { MEMBER_TYPE, isRecorder, mxidOf } from "@/features/calls/util";
import { PAD_CMD, PAD_STATE, padTargets, type PadCat, type PadTarget } from "@/features/calls/pad/rules";
import { PadTransport, type PadClientLike } from "@/features/calls/pad/transport";
import { PadReceiver, type PadExec, type PadPerson, type PadSnapshot, type PadSoundRef } from "@/features/calls/pad/receiver";
import { PadController, type PadLink, type PadNotice, type PadView } from "@/features/calls/pad/controller";
import { PAD_PREF, padAllowed } from "@/features/calls/pad/prefs";
import { startSound, stopCurrent, useSoundboard } from "@/features/media/soundboard/store";
import { PERSONAL_TYPE, ROOM_TYPE, readSound } from "@/features/media/soundboard/data";
import { padGate, padSounds } from "@/widgets/soundpad";
import { inTinHatApp, nativeCall, onNativeCall, useNativeCall } from "@/features/native";
import { callsNewestFirst } from "./order";
import { NativeDeviceMemory, isNativeDeviceOf, nativeRefusesOpen, withoutNativeDevices } from "./targets";

const log = createLogger("pad");

// ---- shared bits ----------------------------------------------------------------------------------------

const CATS: PadCat[] = ["mic", "screenshare", "music"];

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** 16 base64url characters (12 random bytes). */
export function mintSid(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

const timers = {
  now: () => Date.now(),
  timer: (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms),
  cancel: (h: unknown) => window.clearTimeout(h as number),
};

function call(): CallStore {
  return useCallStore.getState() as unknown as CallStore;
}

// ---- device names + trusted devices (discovery) -----------------------------------------------------------

interface DevStore {
  names: Record<string, string>;
  /** my other devices that are cross-signing trusted */
  trusted: string[];
  rev: number;
}
export const usePadDevices = create<DevStore>()(() => ({ names: {}, trusted: [], rev: 0 }));

/** The name of one of my devices (Settings → Devices & security), else its id. */
export function deviceName(id: string): string {
  return usePadDevices.getState().names[id] || id;
}
export function useDeviceName(id: string): string {
  return usePadDevices((s) => s.names[id] || id);
}

let refreshing = false;
let refreshAgain = false;
async function refreshDevices(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const t = transport;
    if (!t) return;
    const devs = await t.trust.devices(false);
    const names: Record<string, string> = {};
    for (const d of devs) names[d.id] = d.name || d.id;
    const trusted = await t.trust.trustedDevices();
    const cur = usePadDevices.getState();
    if (JSON.stringify(cur.names) !== JSON.stringify(names) || cur.trusted.join("|") !== trusted.join("|")) usePadDevices.setState({ names, trusted, rev: cur.rev + 1 });
  } catch (e) {
    log.warn(`device refresh: ${(e as Error)?.message ?? e}`);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refreshDevices();
    }
  }
}

// ---- the receiver -----------------------------------------------------------------------------------------

const gens = new WeakMap<object, string>();
/** The call generation: one id per call session (a rejoin or a switch is a new one). */
function genOf(s: object): string {
  let g = gens.get(s);
  if (!g) gens.set(s, (g = b64url(crypto.getRandomValues(new Uint8Array(9)))));
  return g;
}

function liveUrl(u: string): boolean {
  return /^(https?:|mxc:)/i.test(u);
}

/** The receiver's snapshot: what its own call bar, soundboard and per-person menus show right now. */
export function padSnapshot(): PadSnapshot {
  const c = call();
  const s = sess();
  const me = peekClient()?.getUserId() ?? "";
  const inCall = !!c.inCall && !c.fake && !!s && !!c.callRoomId && s.roomId === c.callRoomId;
  const sb = useSoundboard.getState();
  const gate = padGate(!!c.inCall, c.callPerms);
  // people: by bare id, devices folded, not me (any of my devices), no recorder
  const talking = new Set((c.speakers?.active ?? []).map(mxidOf));
  const byUser = new Map<string, PadPerson & { ids: Set<string>; mutedIds: Set<string> }>();
  for (const t of c.tiles ?? []) {
    if (t.id === "vid_selfview" || t.participant === "You" || isRecorder(t.participant)) continue;
    const u = mxidOf(t.participant);
    if (!u || u === me || !u.startsWith("@")) continue;
    let p = byUser.get(u);
    if (!p) {
      p = { u, identity: t.participant, talk: false, micOff: false, away: false, vol: { mic: 1, screenshare: 1, music: 1 }, muted: { mic: false, screenshare: false, music: false }, ids: new Set(), mutedIds: new Set() };
      byUser.set(u, p);
    }
    if (!t.screenshare) {
      p.ids.add(t.participant);
      if (t.muted) p.mutedIds.add(t.participant);
    }
    if (talking.has(u)) p.talk = true;
  }
  const away = new Set(c.awayUsers ?? []);
  const people: PadPerson[] = [];
  for (const p of byUser.values()) {
    const vol = { mic: 1, screenshare: 1, music: 1 } as Record<PadCat, number>;
    const muted = { mic: false, screenshare: false, music: false } as Record<PadCat, boolean>;
    for (const cat of CATS) {
      vol[cat] = c.volumeFor(p.identity, cat);
      muted[cat] = c.mutedFor(p.identity, cat);
    }
    people.push({ u: p.u, identity: p.identity, talk: p.talk, micOff: p.ids.size > 0 && p.mutedIds.size === p.ids.size, away: away.has(p.u), vol, muted });
  }
  // sounds this device plays: its favourites (the synced copy, the soundpad's reading and the panel's), the CALL
  // room's sounds, its Recent
  const client = peekClient();
  const favContent = client?.getAccountData(PERSONAL_TYPE as never)?.getContent();
  const favs: PadSoundRef[] = padSounds(favContent);
  const favUrls = new Set(favs.map((f) => f.url));
  for (const raw of Array.isArray((favContent as { sounds?: unknown })?.sounds) ? ((favContent as { sounds: unknown[] }).sounds as unknown[]) : []) {
    const r = readSound(raw);
    if (r && !favUrls.has(r.sourceUrl)) favs.push({ name: r.name, url: r.sourceUrl, emoji: r.emoji }), favUrls.add(r.sourceUrl);
  }
  for (const o of sb.personalOverride ?? []) if (!favUrls.has(o.sourceUrl)) favs.push({ name: o.name, url: o.sourceUrl, emoji: o.emoji }), favUrls.add(o.sourceUrl);
  const roomSounds: PadSoundRef[] = [];
  if (inCall) {
    for (const ev of client?.getRoom(c.callRoomId)?.currentState.getStateEvents(ROOM_TYPE) ?? []) {
      const r = readSound(ev.getContent());
      if (r) roomSounds.push({ name: r.name, url: r.sourceUrl, emoji: r.emoji });
    }
  }
  const recent: PadSoundRef[] = (sb.recent ?? []).filter((r) => !!r.url).map((r) => ({ name: r.name, url: r.url, emoji: r.emoji }));
  return {
    call: inCall && s ? { room: c.callRoomId, gen: genOf(s), since: Math.max(0, Math.trunc(s.createdTs || 0)) } : null,
    me: {
      micMuted: !!c.micMuted,
      ptt: !!c.pushToTalk,
      serverMuted: !!c.serverMuted,
      deaf: !!c.deafened,
      brb: !!c.localAfk,
      talk: !!c.speakers?.me && (c.speakers?.active ?? []).includes(c.speakers.me),
      sound: liveUrl(sb.playingUrl) ? sb.playingUrl : "",
      gate,
    },
    people,
    sounds: { favourites: [...favUrls], roomSounds: inCall ? { [c.callRoomId]: roomSounds.map((r) => r.url) } : {}, recent: recent.map((r) => r.url) },
    named: [...favs, ...roomSounds, ...recent],
    recent,
  };
}

/** The receiver's executor: the commands its own buttons call (call store actions, the soundboard store). */
export const padExec: PadExec = {
  forceMicMuted: (m) => call().forceMicMuted(m),
  toggleMic: () => call().toggleMic(),
  applyDeafen: (on) => call().applyDeafen(on),
  setAfk: (on) => call().setAfk(on),
  leaveCall: () => call().leaveCall(),
  startSound: (url, name, emoji) => startSound(url, name, emoji),
  stopCurrent: () => stopCurrent(),
  setVolume: (id, cat, v) => call().setVolume(id, cat, v),
  pushVolume: (id, cat, v) => call().pushVolume(id, cat, v),
  setMuted: (id, cat, m) => call().setMuted(id, cat, m),
};

/** Tests only (devhooks.ts `__twPad.fakeCall`): a stand-in call — its snapshot and a recording executor. */
export interface PadTestCall {
  snapshot(): PadSnapshot;
  exec: PadExec;
}
let testCall: PadTestCall | null = null;
export function setPadTestCall(c: PadTestCall | null): void {
  testCall = c;
  receiver?.poke();
}
const execProxy: PadExec = new Proxy(padExec, {
  get: (target, k: keyof PadExec) => (testCall ? testCall.exec[k] : target[k]),
});

export interface PadChipSession {
  sid: string;
  device: string;
}
export const usePadReceiver = create<{ sessions: PadChipSession[] }>()(() => ({ sessions: [] }));

const SEEN_PREF = "pad-seen-devices";
function firstFrom(device: string): void {
  const seen = getPref<string[]>(SEEN_PREF, []);
  const list = Array.isArray(seen) ? seen.filter((x) => typeof x === "string") : [];
  if (list.includes(device)) return;
  setPref(SEEN_PREF, [...list, device].slice(-32));
  toast(`${deviceName(device)} is now a Pad for this call`, { timeoutMs: 6000, action: { label: "Settings", run: () => openSettings("calls") } });
}

// ---- the controller (one Pad screen) ----------------------------------------------------------------------

export interface PadCtrlState {
  open: boolean;
  room: string;
  device: string;
  link: PadLink;
  notice: PadNotice | null;
  view: PadView | null;
  rev: number;
}
export const usePadCtrl = create<PadCtrlState>()(() => ({ open: false, room: "", device: "", link: "ended", notice: null, view: null, rev: 0 }));

let ctrl: PadController | null = null;

/** The receiver's last verdicts (the test hook reads them; also handy in a debug console). */
export const verdicts: Array<{ at: number; from: string; op: string; seq: number; ok: boolean; why: string; reason: string; run: boolean }> = [];

function publishCtrl(): void {
  const c = ctrl;
  if (!c) return usePadCtrl.setState({ open: false, link: "ended", view: null, notice: null });
  usePadCtrl.setState((s) => ({ open: !c.isClosed, room: c.room, device: c.device, link: c.link, notice: c.notice, view: c.view(), rev: s.rev + 1 }));
}

/** The open Pad's controller (the UI's commands), null when none. */
export function padController(): PadController | null {
  return ctrl;
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Open the Pad for my device `device` in the call of `room` (closes another one first). A Pad that is already open
 *  (or opening) on that device stays; one that ended (off, closed, replaced, the call ended…) or isn't reaching it
 *  opens afresh — as the desktop's openPad, which always starts a new session (phase 3: after "Pad is turned off",
 *  turned on again, a tap on Pad did nothing until the screen was closed first). */
export function openPad(room: string, device: string): void {
  // never this phone's own native call device (a Tin Hat app; targetsIn leaves it out, this catches a stale target)
  if (nativeRefusesOpen(device, room, nativeNow(), knownNative())) {
    log.warn(`not opening a Pad for ${device} in ${room}: it is (or may be) this phone's own call device (Tin Hat app)`);
    return;
  }
  if (ctrl && !ctrl.isClosed && ctrl.room === room && ctrl.device === device && (ctrl.link === "open" || ctrl.link === "opening")) return publishCtrl();
  ctrl?.close();
  const t = transport;
  if (!t) return;
  const c = new PadController(
    {
      ...timers,
      send: (dev, content) => t.send(PAD_CMD, dev, content),
      sid: mintSid,
      changed: () => ctrl === c && publishCtrl(),
      log,
    },
    device,
    room,
  );
  ctrl = c;
  log.info(`opening a Pad for ${device} in ${room}`);
  c.open();
  if (!pageVisible()) c.setVisible(false);
  publishCtrl();
}

/** Close the Pad screen (sends `close`). */
export function closePad(): void {
  ctrl?.close();
  ctrl = null;
  publishCtrl();
}

// ---- install ----------------------------------------------------------------------------------------------

let transport: PadTransport | null = null;
let receiver: PadReceiver | null = null;
let installed = false;

export function padTransport(): PadTransport | null {
  return transport;
}
export function padReceiver(): PadReceiver | null {
  return receiver;
}

function publishSessions(): void {
  const r = receiver;
  const sessions = r ? r.live() : [];
  const cur = usePadReceiver.getState().sessions;
  if (cur.length === sessions.length && cur.every((x, i) => x.sid === sessions[i].sid && x.device === sessions[i].device)) return;
  usePadReceiver.setState({ sessions });
  if (sessions.some((s) => !usePadDevices.getState().names[s.device])) void refreshDevices();
}

/** × on the chip: end that device's Pad and refuse it for the rest of this call. */
export function refusePadDevice(device: string): void {
  receiver?.refuse(device);
  publishSessions();
}

export function installPad(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // the Tin Hat app's native call device, whenever the app names it (a no-op outside the apps): the call already on
  // when this page starts too, and a Pad already open on a device that turns out to be the phone's own closes
  const onNative = () => {
    noteNativeDevice(nativeNow()?.nativeDeviceId ?? null);
    if (ctrl && !ctrl.isClosed && isNativeDevice(ctrl.device)) {
      log.warn(`closing the Pad for ${ctrl.device}: it is this phone's own call device (Tin Hat app)`);
      closePad();
    }
  };
  onNativeCall(onNative);
  onNative();
  let attached: MatrixClient | null = null;
  let offs: Array<() => void> = [];
  const attach = () => {
    const c = peekClient();
    if (c === attached) return;
    // a session boundary: the native-device memory is read from storage again (sign-out wiped the account's), and the
    // app's current native call is noted for the account now signed in
    nativeMemory.reset();
    onNative();
    for (const o of offs) o();
    offs = [];
    closePad();
    receiver?.reset();
    attached = c;
    transport = null;
    receiver = null;
    usePadDevices.setState({ names: {}, trusted: [], rev: 0 });
    usePadReceiver.setState({ sessions: [] });
    if (!c) return;
    const t = new PadTransport(() => (peekClient() === c ? (c as unknown as PadClientLike) : null), { log });
    transport = t;
    const r = new PadReceiver({
      ...timers,
      send: (dev, content) => t.send(PAD_STATE, dev, content),
      mayReceive: (dev) => t.trust.mayReceive(dev),
      padOn: padAllowed,
      // (tests: __twPad.fakeCall stands in for a call on a lab without an SFU — devhooks.ts)
      snapshot: () => testCall?.snapshot() ?? padSnapshot(),
      exec: execProxy,
      log,
      changed: publishSessions,
      opened: firstFrom,
    });
    receiver = r;
    // (dropped up front by the transport — plaintext, anyone else's, a flood — for the log / test hook)
    t.onDrop = (type, sender, reason) => {
      if (type !== PAD_CMD) return;
      verdicts.push({ at: Date.now(), from: sender || "?", op: "", seq: 0, ok: false, why: "", reason, run: false });
      if (verdicts.length > 128) verdicts.splice(0, verdicts.length - 128);
    };
    offs.push(
      t.on(PAD_CMD, (m) => {
        const v = r.handle(m.type, m.content, m.facts);
        const c = (m.content ?? {}) as { op?: unknown; seq?: unknown; sid?: unknown };
        verdicts.push({ at: Date.now(), from: m.facts.senderDevice || m.facts.olmSender || "?", op: String(c.op ?? ""), seq: Number(c.seq ?? 0), ok: v.ok, why: v.why, reason: v.reason, run: v.run });
        if (verdicts.length > 128) verdicts.splice(0, verdicts.length - 128);
      }),
    );
    offs.push(
      t.on(PAD_STATE, (m) => {
        if (ctrl && !ctrl.isClosed && m.facts.senderDevice === ctrl.device) ctrl.onState(m.content, m.facts);
        else log.debug?.(`state from ${m.facts.senderDevice || "?"} with no Pad open for it — ignored`);
      }),
    );
    const onToDevice = (p: unknown) => void t.receive(p as Parameters<PadTransport["receive"]>[0]);
    c.on(ClientEvent.ReceivedToDeviceMessage, onToDevice as never);
    offs.push(() => c.off(ClientEvent.ReceivedToDeviceMessage, onToDevice as never));
    // trust facts are cached ≤ 60 s and dropped on every device-list / trust change
    const me = c.getUserId();
    const drop = () => {
      t.trust.invalidate();
      void refreshDevices();
    };
    const onDevices = (users: string[]) => me && users.includes(me) && drop();
    const onTrust = (u: string) => u === me && drop();
    c.on(CryptoEvent.DevicesUpdated, onDevices as never);
    c.on(CryptoEvent.UserTrustStatusChanged, onTrust as never);
    c.on(CryptoEvent.KeysChanged, drop as never);
    offs.push(() => {
      c.off(CryptoEvent.DevicesUpdated, onDevices as never);
      c.off(CryptoEvent.UserTrustStatusChanged, onTrust as never);
      c.off(CryptoEvent.KeysChanged, drop as never);
    });
    const tick = window.setInterval(() => void refreshDevices(), 60_000);
    offs.push(() => window.clearInterval(tick));
    void refreshDevices();
    // the receiver follows its own stores (paced pushes, final states on a call change)
    offs.push(useCallStore.subscribe(() => r.poke()));
    offs.push(useSoundboard.subscribe(() => r.poke()));
    offs.push(onPrefChange("audio_prefs", () => r.poke()));
  };
  attach();
  onClientChanged(attach);
  // Settings → Calls → Pad
  let was = padAllowed();
  onPrefChange(PAD_PREF, () => {
    const on = padAllowed();
    if (on === was) return;
    was = on;
    if (!on) receiver?.padOff();
    publishSessions();
    // the cap follows at once (not only at the next 30-min refresh)
    if (call().inCall) void republishMembership();
  });
  document.addEventListener("visibilitychange", () => ctrl?.setVisible(pageVisible()));
}

// ---- discovery (the controller side) ----------------------------------------------------------------------

// The Tin Hat app's native call device(s) (targets.ts): every id the app has reported for this account, so the phone
// stays out of the targets while its membership outlives the app's call state (a slow leave, a crashed app) and after
// a reload. Account data (`tinhat.user.*`, wiped with the session on sign-out). Read / written only inside the apps.
// (localStorage is touched only inside these two, which the memory calls under try: a blocked store never throws here)
const nativeMemory = new NativeDeviceMemory({ get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) });

/** The app's native call (null outside the apps). */
function nativeNow(): ReturnType<typeof nativeCall> {
  return inTinHatApp() ? nativeCall() : null;
}

function knownNative(): string[] {
  return inTinHatApp() ? nativeMemory.known(getSession().userId ?? "") : [];
}

function noteNativeDevice(id: string | null): void {
  if (!inTinHatApp()) return;
  if (nativeMemory.note(getSession().userId ?? "", id)) log.info(`this phone's own call device is ${id} (Tin Hat app): never a Pad target`);
}

/** `device` is this phone's own native call device (a Tin Hat app reported it, now or before). False outside the apps. */
export function isNativeDevice(device: string): boolean {
  if (!inTinHatApp()) return false;
  return isNativeDeviceOf(device, nativeNow(), knownNative());
}

/** My other devices in the call of `roomId` that could be a Pad target (newest first; `why` "" = ready). Never the Tin
 *  Hat app's own native call device (features/native, bridge 2: any id the app has reported, targets.ts), and none in
 *  the room of a native call that hasn't named its device yet: that is this phone, and its room's join banner says
 *  "You're in this call on this phone" instead. Every Pad entry point reads its targets here. */
export function targetsIn(roomId: string, now = Date.now()): PadTarget[] {
  const c = peekClient();
  const s = getSession();
  if (!c || !s.userId || !s.deviceId || !roomId) return [];
  const evs = c.getRoom(roomId)?.currentState.getStateEvents(MEMBER_TYPE) ?? [];
  const raw = evs.map((ev) => ({ sender: ev.getSender() ?? "", state_key: ev.getStateKey() ?? "", origin_server_ts: ev.getTs(), content: ev.getContent() }));
  const { trusted } = usePadDevices.getState();
  // "this device is verified" = crypto.ts isDeviceVerified (all three private cross-signing keys cached), as the banner
  const found = padTargets(s.userId, s.deviceId, now, getCryptoStatus().thisDeviceVerified === true, trusted, raw);
  if (!inTinHatApp()) return found;
  const call = nativeNow();
  noteNativeDevice(call?.nativeDeviceId ?? null);
  return withoutNativeDevices(found, roomId, call, knownNative());
}

/** React: re-render on the room's call memberships, the trust lists and a 30 s expiry tick. */
function useMembershipRev(roomIds: string[] | null): number {
  const [rev, setRev] = useState(0);
  const key = roomIds ? roomIds.join("|") : "*";
  useEffect(() => {
    const c = peekClient();
    if (!c) return;
    const bump = () => setRev((n) => n + 1);
    const want = roomIds ? new Set(roomIds) : null;
    const on = (ev: MatrixEvent) => {
      if (ev.getType() === MEMBER_TYPE && (!want || want.has(ev.getRoomId() ?? ""))) bump();
    };
    c.on(RoomStateEvent.Events, on);
    c.on(ClientEvent.Room, bump);
    const iv = window.setInterval(bump, 30_000);
    return () => {
      c.off(RoomStateEvent.Events, on);
      c.off(ClientEvent.Room, bump);
      window.clearInterval(iv);
    };
    // (key stands for roomIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return rev;
}

function useTrustInputs(): string {
  const st = useCryptoStatus();
  const devRev = usePadDevices((s) => s.rev);
  const sess = useSession();
  // the app's native call (null outside the apps): its room and device id decide what targetsIn leaves out, so the
  // targets are re-read when either changes, whichever of the device's membership and the app's state comes first
  const n = useNativeCall();
  const native = n ? `${n.roomId}:${n.nativeDeviceId ?? ""}` : "";
  return `${st.thisDeviceVerified ? 1 : 0}|${devRev}|${sess.userId}|${sess.deviceId}|${native}`;
}

/** React: the Pad targets in one room's call (empty when this device is in that call itself). */
export function usePadTargets(roomId: string | null | undefined): PadTarget[] {
  const rev = useMembershipRev(roomId ? [roomId] : []);
  const trustKey = useTrustInputs();
  const myCall = useCallStore((s) => ((s as unknown as CallStore).inCall || (s as unknown as CallStore).connecting ? (s as unknown as CallStore).callRoomId : ""));
  return useMemo(() => {
    if (!roomId || myCall === roomId) return [];
    return targetsIn(roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, rev, trustKey, myCall]);
}

export interface CallElsewhere {
  room: string;
  targets: PadTarget[];
}

/** React: the calls (in my joined rooms) that one of my OTHER devices is in and this device isn't — newest first. */
export function useMyCallsElsewhere(): CallElsewhere[] {
  const rev = useMembershipRev(null);
  const trustKey = useTrustInputs();
  const myCall = useCallStore((s) => ((s as unknown as CallStore).inCall || (s as unknown as CallStore).connecting ? (s as unknown as CallStore).callRoomId : ""));
  const [list, setList] = useState<CallElsewhere[]>([]);
  useEffect(() => {
    const c = peekClient();
    const out: CallElsewhere[] = [];
    for (const r of c?.getRooms() ?? []) {
      if (r.getMyMembership() !== "join" || r.roomId === myCall) continue;
      const t = targetsIn(r.roomId);
      if (t.length) out.push({ room: r.roomId, targets: t });
    }
    // newest first, ties by room id (order.ts = the desktop's pad_engine::calls_newest_first)
    const sorted = callsNewestFirst(out);
    setList((cur) => (JSON.stringify(cur) === JSON.stringify(sorted) ? cur : sorted));
  }, [rev, trustKey, myCall]);
  return list;
}

export { padAllowed, PAD_PREF };

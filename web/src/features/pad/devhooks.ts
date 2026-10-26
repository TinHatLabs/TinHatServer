// devhooks.ts — `window.__twPad` for the Pad gates (tools/pad-gate.mjs), with the core dev hook's conditions (dev
// builds, #twdebug, or window.__TW_DEBUG__). A lab homeserver has no SFU, so a receiver can't be in a real call there:
// `fakeCall` stands in for one — this device publishes a well-formed call membership with the `pad1` cap (discovery),
// answers Pad commands from a stand-in snapshot and RECORDS what it would have run (the unit tests prove each op calls
// its button's command). Everything else is real: the Olm to-device transport, the trust facts, the rules, the
// sessions, the controller and the UI.
import { peekClient, getSession } from "@/core/matrix";
import { MEMBER_TYPE } from "@/features/calls/util";
import { dropMembership, membershipContent, putMembership, wantMembership, withdrawMembership } from "@/features/calls/rtc";
import { PAD_CMD } from "@/features/calls/pad/rules";
import type { PadExec, PadSnapshot } from "@/features/calls/pad/receiver";
import { padSounds } from "@/widgets/soundpad";
import { PERSONAL_TYPE, ROOM_TYPE, readSound } from "@/features/media/soundboard/data";
import { setPref } from "@/core/prefs";
import { clientMarker } from "@/features/calls/av1";
import { PAD_PREF } from "@/features/calls/pad/prefs";
import { closePad, openPad, padController, padReceiver, padTransport, setPadTestCall, targetsIn, usePadCtrl, usePadDevices, usePadReceiver, verdicts } from "./runtime";

type Obj = Record<string, unknown>;

function debugOn(): boolean {
  return import.meta.env.DEV || /twdebug/.test(location.hash) || (window as Window & { __TW_DEBUG__?: boolean }).__TW_DEBUG__ === true;
}

const TEST_GEN = -7_001; // a membership "join generation" no real join uses

interface FakeOpts {
  room: string;
  /** false: the membership is there but the stand-in snapshot says "not in a call" */
  inCall?: boolean;
  people?: Array<{ u: string; talk?: boolean; micOff?: boolean; away?: boolean }>;
  recent?: Array<{ name: string; url: string; emoji: string }>;
  me?: Partial<PadSnapshot["me"]>;
  /** advertise `pad1` (default true): false = an "older Tin Hat" */
  cap?: boolean;
}

let fake: { o: FakeOpts; me: PadSnapshot["me"]; vols: Map<string, { vol: Record<string, number>; muted: Record<string, boolean> }>; log: unknown[][]; at: number[]; gen: string; since: number } | null = null;

function fakeSnapshot(): PadSnapshot {
  const f = fake!;
  const c = peekClient();
  const fav = c?.getAccountData(PERSONAL_TYPE as never)?.getContent();
  const favs = padSounds(fav);
  const room = f.o.room;
  const rs = (c?.getRoom(room)?.currentState.getStateEvents(ROOM_TYPE) ?? []).map((e) => readSound(e.getContent())).filter((x) => !!x).map((x) => ({ name: x!.name, url: x!.sourceUrl, emoji: x!.emoji }));
  const recent = f.o.recent ?? [];
  const people = (f.o.people ?? []).map((p) => {
    const v = f.vols.get(p.u) ?? { vol: { mic: 1, screenshare: 1, music: 1 }, muted: { mic: false, screenshare: false, music: false } };
    f.vols.set(p.u, v);
    return { u: p.u, identity: `${p.u}:LABDEV`, talk: !!p.talk, micOff: !!p.micOff, away: !!p.away, vol: { ...v.vol } as never, muted: { ...v.muted } as never };
  });
  return {
    call: f.o.inCall === false ? null : { room, gen: f.gen, since: f.since },
    me: { ...f.me },
    people,
    sounds: { favourites: favs.map((x) => x.url), roomSounds: { [room]: rs.map((x) => x.url) }, recent: recent.map((x) => x.url) },
    named: [...favs, ...rs, ...recent],
    recent,
  };
}

const fakeExec: PadExec = {
  forceMicMuted: (m) => (rec(["forceMicMuted", m]), (fake!.me.micMuted = m)),
  toggleMic: () => (rec(["toggleMic"]), (fake!.me.micMuted = !fake!.me.micMuted)),
  applyDeafen: (on) => (rec(["applyDeafen", on]), (fake!.me.deaf = on)),
  setAfk: (on) => (rec(["setAfk", on]), (fake!.me.brb = on)),
  leaveCall: () => {
    rec(["leaveCall"]);
    fake!.o.inCall = false;
  },
  startSound: (url, name, emoji) => (rec(["startSound", url, name, emoji]), (fake!.me.sound = url)),
  stopCurrent: () => (rec(["stopCurrent"]), (fake!.me.sound = "")),
  setVolume: (id, cat, v) => (rec(["setVolume", id, cat, v]), void (vol(id).vol[cat] = v)),
  pushVolume: (id, cat, v) => (rec(["pushVolume", id, cat, v]), void (vol(id).vol[cat] = v)),
  setMuted: (id, cat, m) => (rec(["setMuted", id, cat, m]), void (vol(id).muted[cat] = m)),
};
function rec(c: unknown[]): void {
  fake!.log.push(c);
  fake!.at.push(Date.now());
}
function vol(identity: string) {
  const u = identity.replace(/:LABDEV$/, "");
  let v = fake!.vols.get(u);
  if (!v) fake!.vols.set(u, (v = { vol: { mic: 1, screenshare: 1, music: 1 }, muted: { mic: false, screenshare: false, music: false } }));
  return v;
}

async function publish(room: string, cap: boolean): Promise<boolean> {
  const s = getSession();
  if (!s.userId || !s.deviceId) return false;
  wantMembership(room, TEST_GEN);
  const content = membershipContent({ roomId: room, userId: s.userId, deviceId: s.deviceId, createdTs: Date.now(), focus: { serviceUrl: "https://lk.lab.test", alias: room } });
  if (!cap) {
    const mk = { ...(content["dev.tinhat.client"] as Obj) };
    mk.caps = ((mk.caps as string[] | undefined) ?? []).filter((x) => x !== "pad1");
    if (!(mk.caps as string[]).length) delete mk.caps;
    content["dev.tinhat.client"] = mk;
  }
  return putMembership(room, content, TEST_GEN);
}

export function installPadDevHooks(): void {
  if (typeof window === "undefined" || !debugOn()) return;
  (window as unknown as { __twPad: unknown }).__twPad = {
    /** stand in for a call in `room` (publishes this device's membership with the pad1 cap) */
    async fakeCall(o: FakeOpts) {
      fake = { o: { ...o }, me: { micMuted: false, ptt: false, serverMuted: false, deaf: false, brb: false, talk: false, sound: "", gate: { allowed: true, hint: "" }, ...(o.me ?? {}) }, vols: new Map(), log: [], at: [], gen: "labGen1", since: Date.now() };
      setPadTestCall({ snapshot: fakeSnapshot, exec: fakeExec });
      return publish(o.room, o.cap !== false);
    },
    /** change the stand-in call (e.g. { me: { serverMuted: true } }, { inCall: false }, a new gen) */
    tweak(p: Partial<FakeOpts> & { gen?: string }) {
      if (!fake) return false;
      if (p.me) fake.me = { ...fake.me, ...p.me };
      if (p.gen) fake.gen = p.gen;
      fake.o = { ...fake.o, ...p, me: undefined };
      padReceiver()?.poke();
      return true;
    },
    async endFakeCall() {
      const room = fake?.o.room;
      fake = null;
      setPadTestCall(null);
      if (!room) return false;
      dropMembership(room, TEST_GEN);
      return withdrawMembership(room);
    },
    execLog: () => fake?.log.slice() ?? [],
    /** when each logged command ran (ms, this page's clock) */
    execTimes: () => fake?.at.slice() ?? [],
    /** the receiver: live sessions, refused devices */
    receiver: () => {
      const r = padReceiver();
      return { sessions: usePadReceiver.getState().sessions, refused: r ? [...r.table.refused] : [], table: r ? r.table.sessions.map((x) => ({ sid: x.sid, device: x.device, lastSeq: x.lastSeq, vis: x.vis })) : [] };
    },
    /** the controller: link, notice, view, sid/seq */
    ctrl: () => {
      const c = padController();
      const st = usePadCtrl.getState();
      return { open: st.open, link: st.link, notice: st.notice, view: st.view, device: st.device, room: st.room, ...(c ? c.debug() : {}) };
    },
    devices: () => usePadDevices.getState(),
    /** discovery: my other devices in `room`'s call (padTargets, newest first) — the app's own module instance */
    targets: (room: string) => targetsIn(room),
    /** open the Pad for `device` in `room`'s call (what the Pad button / the chooser's item does) */
    open: (room: string, device: string) => openPad(room, device),
    /** close the Pad screen (its × / Close) */
    close: () => closePad(),
    /** a controller command as the Pad screen's controls send it (setMic, setDeafen, setBrb, playSound, stopSound, volume, …) */
    press(method: string, ...args: unknown[]) {
      const c = padController() as unknown as Record<string, (...a: unknown[]) => unknown> | null;
      return c && typeof c[method] === "function" ? (c[method](...args) ?? true) : false;
    },
    /** send a crafted Pad command: Olm-encrypted to (user, device) — another account's too — or plaintext */
    async sendRaw(userId: string, deviceId: string, content: Obj, opts: { plaintext?: boolean; type?: string } = {}) {
      const c = peekClient();
      const cr = c?.getCrypto();
      if (!c || !cr) return false;
      const type = opts.type ?? PAD_CMD;
      if (opts.plaintext) {
        await c.sendToDevice(type, new Map([[userId, new Map([[deviceId, content]])]]));
        return true;
      }
      const b = await cr.encryptToDeviceMessages(type, [{ userId, deviceId }], content);
      if (b.batch.length !== 1) return false;
      await c.sendToDevice(b.eventType, new Map([[userId, new Map([[deviceId, b.batch[0].payload]])]]));
      return true;
    },
    transport: () => !!padTransport(),
    /** the receiver's last verdicts ({from, op, seq, ok, why, reason, run}) */
    verdicts: (since = 0) => verdicts.filter((v) => v.at >= since),
    /** Settings → Calls → Pad */
    setAllow: (on: boolean) => setPref(PAD_PREF, on),
    /** the dev.tinhat.client marker this device would publish now */
    marker: () => clientMarker("test", false),
    /** this device's membership in `room`, as the server has it */
    membership(room: string) {
      const s = getSession();
      const ev = peekClient()?.getRoom(room)?.currentState.getStateEvents(MEMBER_TYPE, `_${s.userId}_${s.deviceId}_m.call`);
      return ev ? ev.getContent() : null;
    },
  };
}

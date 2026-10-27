// soundboard/store.ts — the soundboard's state machine (SoundboardPopover.qml + AppCore sb*).
//
//   toggle(s): s.url == playingUrl ? stop() : start(s)
//   start:  stop(); the local copy through core/sounds playClip (REACH A5.8: the one Web Audio context — no
//           <audio>, which iOS shows as media playback; it follows the call's output device like the old element
//           did, calls/audio.ts setUiSink); playingUrl/Name/StartedAt; localNote="";
//           in a call → engine.playSound(url) (published as the "sound" track); pushRecent
//   stop:   local.pause(); engine.stopSound(); clear playing
//   local ended → clear playing (the call track ends on its own at EOF)
//   local error → in call: note "…the call still hears it." (card stays playing) / else note + clear
//   every 300 ms after a 1.5 s grace: clear playing once neither local nor the call track is live
import { create } from "zustand";
import { getPref, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { serverFeatureOn } from "@/core/server";
import { adaptiveInterval } from "@/core/winstate";
import { BUSY_STEP_MS } from "@/core/lowgpu";
import { animate } from "@/ui/motion";
import { FOREIGN_SOUND_NOTE, clipUrlFor } from "../shared/clip";
import { enginePlaySound, engineStopSound, getCall, isInCall, subscribeCall } from "../shared/call";
import { playClip, type ClipHandle } from "@/core/sounds";
import { padGate } from "@/widgets/soundpad";
import {
  addPersonalSound,
  addRoomSound,
  fetchPersonalSounds,
  removePersonalSound,
  removeRoomSound,
  searchSounds,
  uploadClip,
  type Sound,
} from "./data";

const log = createLogger("soundboard");

export interface RecentSound {
  name: string;
  url: string;
  emoji: string;
}

export interface SbState {
  open: boolean;
  /** bumps on every open request (re-focus the search box) */
  openSeq: number;
  query: string;
  web: Sound[];
  searching: boolean;
  playingUrl: string;
  playingName: string;
  playStartedAt: number;
  /** local playback position / duration (0..1) — the card's progress ring */
  progress: number;
  localNote: string;
  errorText: string;
  uploading: boolean;
  recent: RecentSound[];
  /** optimistic favourites after our own write, until the synced account data catches up */
  personalOverride: Sound[] | null;
  /** gate/demo data (?sbdemo=1 — native --tinhat-soundboard + TINHAT_GUI_FAKECALL) */
  demoPersonal: Sound[] | null;
  demoRoom: Sound[] | null;
}

function loadRecent(): RecentSound[] {
  const v = getPref("soundboard-recent", [] as unknown[]) as unknown;
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ name: String(x.name ?? ""), url: String(x.url ?? ""), emoji: String(x.emoji ?? "") }))
    .filter((x) => x.url);
}

export const useSoundboard = create<SbState>()(() => ({
  open: false,
  openSeq: 0,
  query: "",
  web: [],
  searching: false,
  playingUrl: "",
  playingName: "",
  playStartedAt: 0,
  progress: 0,
  localNote: "",
  errorText: "",
  uploading: false,
  recent: loadRecent(),
  personalOverride: null,
  demoPersonal: null,
  demoRoom: null,
}));

const set = useSoundboard.setState;
const get = useSoundboard.getState;

/** Gate/demo: the native screenshot data (4 favourites, 2 room sounds, "MLG Airhorn" playing). */
export function loadDemo(opts: { playing?: boolean } = {}): void {
  const mi = (f: string) => `https://www.myinstants.com/media/sounds/${f}`;
  set({
    demoPersonal: [
      { name: "Bruh", sourceUrl: mi("bruh.mp3"), emoji: "😐", duration: 0 },
      { name: "MLG Airhorn", sourceUrl: mi("airhorn.mp3"), emoji: "📯", duration: 0 },
      { name: "Sad trombone", sourceUrl: mi("sadtrombone.mp3"), emoji: "🎺", duration: 0 },
      { name: "Vine boom", sourceUrl: mi("vine-boom.mp3"), emoji: "💥", duration: 0 },
    ],
    demoRoom: [
      { name: "Emotional damage", sourceUrl: mi("emotional-damage.mp3"), emoji: "😭", duration: 0, setBy: "@x:y", stateKey: "demo1" },
      { name: "Discord call", sourceUrl: mi("discord-call.mp3"), emoji: "📞", duration: 0, setBy: "@x:y", stateKey: "demo2" },
    ],
    // the native demo runs on a fresh profile: no Recent section (in memory only — the pref is untouched)
    recent: [],
    ...(opts.playing === false ? {} : { playingUrl: mi("airhorn.mp3"), playingName: "MLG Airhorn", playStartedAt: Date.now() + 1e9, progress: 0 }),
  });
}

/** Gate: pretend a clip is playing so the call bar's now-playing pill renders (--tinhat-sbpill). */
export function fakePlaying(name = "Bruh sound effect #2"): void {
  set({ playingUrl: "gate://pill", playingName: name, playStartedAt: Date.now() + 1e9 });
}

// ---- open / close ----------------------------------------------------------------------------

/** Open (or raise + refocus) the soundboard popover and refresh the favourites. */
export function openSoundboard(): void {
  if (!serverFeatureOn("soundboard")) return; // selfhost/firstrun item 1: the server has no soundboard
  set((s) => ({ open: true, openSeq: s.openSeq + 1 }));
  void fetchPersonalSounds().then((list) => {
    if (list) set({ personalOverride: list });
  });
}

export function closeSoundboard(): void {
  if (get().open) set({ open: false });
}

export function toggleSoundboard(): void {
  if (get().open) closeSoundboard();
  else openSoundboard();
}

// ---- playback --------------------------------------------------------------------------------

let clip: ClipHandle | null = null;
let clipSeq = 0;
let stopProgress: (() => void) | null = null;
let stopWatchdog: (() => void) | null = null;

function localFailed() {
  const inCall = isInCall(getCall());
  if (inCall) set({ localNote: "Couldn't play that on your speakers — the call still hears it." });
  else set({ localNote: "Couldn't play that sound.", playingUrl: "", playingName: "", progress: 0 });
}

// GPU.md §2.5 (determinate progress): the card's progress ring moves at most 4×/s (it followed every animation frame at
// ≤ 30 Hz) and only while the motion switch is on — still otherwise; §2.8: its timer and the watchdog run at ≥ 1 s
// while the window is not focused (the clip's end is the watchdog's, not the ring's).
function tickProgress() {
  stopProgress?.();
  const step = () => {
    const h = clip;
    if (!get().playingUrl) {
      stopProgress?.();
      stopProgress = null;
      return;
    }
    if (!h || !animate()) return;
    const p = h.duration > 0 && Number.isFinite(h.duration) ? Math.min(1, h.position() / h.duration) : 0;
    if (Math.abs(p - get().progress) > 0.002) set({ progress: p });
  };
  stopProgress = adaptiveInterval(step, BUSY_STEP_MS, 1000);
}

function startWatchdog() {
  stopWatchdog?.();
  stopWatchdog = adaptiveInterval(() => {
    const st = get();
    if (!st.playingUrl) {
      stopWatchdog?.();
      stopWatchdog = null;
      return;
    }
    if (Date.now() - st.playStartedAt < 1500) return;
    const localBusy = !!clip && clip.isPlaying();
    const callPlaying = !!getCall().soundPlaying;
    if (!localBusy && !callPlaying) set({ playingUrl: "", playingName: "", progress: 0 });
  }, 300, 1000);
}

export function pushRecent(name: string, url: string, emoji: string): void {
  const next = [{ name, url, emoji }, ...get().recent.filter((r) => r.url !== url)].slice(0, 8);
  set({ recent: next });
  setPref("soundboard-recent", next);
}

export function startSound(url: string, name: string, emoji: string): void {
  if (!url) return;
  // widgets W2 (the Soundboard pad, WIDGETS.md §22): the advisory `use_soundboard` permission — in a call whose roles
  // turned it off for you nothing plays (not even the local copy); the panel and the pad show the same line
  const gate = padGate(isInCall(getCall()), getCall().callPerms);
  if (!gate.allowed) {
    set({ errorText: gate.hint, localNote: "" });
    return;
  }
  // M9 (core/clipurl.ts): a sound plays only from the clip cache or our own server — neither the local copy nor the call
  const local = clipUrlFor(url);
  if (!local) {
    set({ errorText: FOREIGN_SOUND_NOTE, localNote: "" });
    return;
  }
  stopCurrent();
  const my = ++clipSeq;
  set({ playingUrl: url, playingName: name || "", playStartedAt: Date.now(), localNote: "", errorText: "", progress: 0 });
  void playClip(local, {
    channel: "clip",
    volume: 1, // the local copy at full level, as the element played it (not a UI chime at snd.volume)
    onEnded: () => {
      if (my !== clipSeq) return;
      clip = null;
      set({ playingUrl: "", playingName: "", progress: 0 });
    },
  }).then((h) => {
    if (my !== clipSeq) return h?.stop();
    if (!h) {
      // undecodable / blocked counts as a local failure (the call still gets it)
      log.warn(`local playback failed ${url}`);
      localFailed();
      return;
    }
    clip = h;
  });
  // into the call (the engine publishes the "sound" track; no-op outside a call)
  const c = getCall();
  if (isInCall(c)) {
    if (c.serverMuted) set({ errorText: "Couldn't play the sound into the call" });
    else {
      // The engine's playSound() is fire-and-forget (the store action returns void): watch the call
      // store for its "sound" track going live; no soundPlaying within 8 s (or an engine error) while
      // this sound is still ours = the publish failed (e.g. server-muted → the SFU refused it).
      const started = get().playStartedAt;
      const rev0 = Number(c.errorRev ?? 0);
      let seen = false;
      const off = subscribeCall((cs) => {
        if (cs.soundPlaying) seen = true;
        if (!seen && Number(cs.errorRev ?? 0) !== rev0 && /sound/i.test(String(cs.lastError ?? "")) && get().playStartedAt === started) set({ errorText: "Couldn't play the sound into the call" });
      });
      void enginePlaySound(url);
      window.setTimeout(() => {
        off();
        if (!seen && get().playStartedAt === started && isInCall(getCall())) set({ errorText: "Couldn't play the sound into the call" });
      }, 8000);
    }
  }
  pushRecent(name || "", url, emoji || "");
  tickProgress();
  startWatchdog();
}

export function stopCurrent(): void {
  if (!get().playingUrl) return;
  clipSeq++;
  clip?.stop();
  clip = null;
  engineStopSound();
  stopProgress?.();
  stopProgress = null;
  set({ playingUrl: "", playingName: "", progress: 0 });
}

/** Other features: publish a clip into the call on the "sound" track (maxMs = hard cap). */
export function playIntoCall(url: string, opts: { maxMs?: number } = {}): Promise<boolean> {
  return enginePlaySound(url, opts.maxMs ?? 0);
}

export function toggleSound(url: string, name: string, emoji: string): void {
  if (url && url === get().playingUrl) stopCurrent();
  else startSound(url, name, emoji);
}

// ---- search (450 ms debounce, previous in-flight aborted) -------------------------------------

let searchTimer = 0;
let searchAbort: AbortController | null = null;

export function setQuery(text: string): void {
  set({ query: text });
  const q = text.trim();
  window.clearTimeout(searchTimer);
  searchAbort?.abort();
  searchAbort = null;
  if (q.length < 2) {
    set({ searching: false, web: [] });
    return;
  }
  set({ searching: true, errorText: "" });
  const ctl = new AbortController();
  searchAbort = ctl;
  searchTimer = window.setTimeout(async () => {
    try {
      const res = await searchSounds(q, ctl.signal);
      if (ctl.signal.aborted) return;
      set({ web: res, searching: false });
    } catch (e) {
      if (ctl.signal.aborted || (e as Error)?.name === "AbortError") return;
      log.warn(`search failed: ${(e as Error)?.message ?? e}`);
      set({ web: [], searching: false, errorText: "Couldn't search sounds" });
    }
  }, 450);
}

// ---- data actions ----------------------------------------------------------------------------

async function afterPersonalWrite() {
  const list = await fetchPersonalSounds();
  if (list) set({ personalOverride: list });
}

export async function addFavourite(name: string, url: string, emoji: string, duration = 0): Promise<void> {
  set({ errorText: "" });
  try {
    await addPersonalSound(name || "Sound", url, emoji, duration);
    await afterPersonalWrite();
  } catch (e) {
    log.warn(`add favourite failed: ${(e as Error)?.message ?? e}`);
    set({ errorText: "Couldn't add the sound" });
  }
}

export async function removeFavourite(displayIndex: number): Promise<void> {
  set({ errorText: "" });
  try {
    await removePersonalSound(displayIndex);
    await afterPersonalWrite();
  } catch (e) {
    log.warn(`remove favourite failed: ${(e as Error)?.message ?? e}`);
    set({ errorText: "Couldn't remove the sound" });
  }
}

export async function addToRoom(roomId: string, name: string, url: string, emoji: string): Promise<void> {
  set({ errorText: "" });
  try {
    await addRoomSound(roomId, name || "Sound", url, emoji, 0);
  } catch (e) {
    log.warn(`add room sound failed: ${(e as Error)?.message ?? e}`);
    set({ errorText: "Couldn't add the sound" });
  }
}

export async function removeFromRoom(roomId: string, stateKey: string): Promise<void> {
  set({ errorText: "" });
  try {
    await removeRoomSound(roomId, stateKey);
  } catch (e) {
    log.warn(`remove room sound failed: ${(e as Error)?.message ?? e}`);
    set({ errorText: "Couldn't remove the sound" });
  }
}

export async function upload(file: File, name?: string): Promise<void> {
  if (get().uploading) return;
  set({ uploading: true, errorText: "" });
  try {
    await uploadClip(file, name);
    await afterPersonalWrite();
  } catch (e) {
    set({ errorText: (e as Error)?.message || "Upload failed" });
  } finally {
    set({ uploading: false });
  }
}

/** The synced favourites changed → drop the optimistic override. */
export function clearPersonalOverride(): void {
  if (get().personalOverride) set({ personalOverride: null });
}

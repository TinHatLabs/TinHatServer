// devhooks.tsx — web equivalents of the native media gate hooks (MED-164), as URL query flags
// (search or hash query) evaluated once the session is ready:
//   ?sb=1                open the soundboard for the open room      (--tinhat-soundboard)
//   ?sbdemo=1            + the native screenshot data, "MLG Airhorn" playing
//   ?sbpill=1            pretend a clip plays (call-bar now-playing pill)   (--tinhat-sbpill)
//   ?memories=1          open Memories for the open room            (--tinhat-memories)
//   ?memopen=<id|latest> + open that session                         (--tinhat-memopen)
//   ?watchparty=1        open the watch party for the open room (JOINS it — test rooms only)
//   ?joinsound=1         a dev window hosting JoinSoundSection (settings owns the real placement)
//   ?memdebug=1          [memories] console logs                     (--tinhat-mem-debug)
//   ?memtest=1           with memopen: an in-page player self-test (--tinhat-memtest) → "[memtest] PASS|FAIL …"
//                        console lines + window.__memtest = { done, pass, fail, lines }
// Also `window.__twMedia` (with the core dev hook conditions) for scripted tests.
import { useEffect, useRef } from "react";
import { useSession } from "@/core/matrix";
import { openWindow } from "@/core/bus";
import { openSoundboard, loadDemo, fakePlaying, useSoundboard, toggleSound, stopCurrent } from "./soundboard/store";
import { useOpenRoomId } from "./soundboard/SoundboardPopover";
import { openMemories } from "./memories";
import { openWatchParty } from "./watchparty";
import { useWatchParty } from "./watchparty/engine";
import { clipUrlFor } from "./shared/clip";
import { getCall } from "./shared/call";

function flag(name: string): string | null {
  const q = new URLSearchParams(location.search);
  if (q.has(name)) return q.get(name) ?? "1";
  const h = location.hash;
  const i = h.indexOf("?");
  if (i >= 0) {
    const hq = new URLSearchParams(h.slice(i + 1));
    if (hq.has(name)) return hq.get(name) ?? "1";
  }
  return null;
}

function debugOn(): boolean {
  return (
    import.meta.env.DEV ||
    /twdebug/.test(location.hash) ||
    (typeof window !== "undefined" && (window as Window & { __TW_DEBUG__?: boolean }).__TW_DEBUG__ === true)
  );
}

export function MediaDevHooks() {
  const ready = useSession().state === "ready";
  const roomId = useOpenRoomId();
  const done = useRef(false);

  useEffect(() => {
    if (!debugOn()) return;
    (window as unknown as { __twMedia: unknown }).__twMedia = {
      openSoundboard,
      loadDemo,
      fakePlaying,
      toggleSound,
      stopSound: stopCurrent,
      soundboard: () => useSoundboard.getState(),
      watchParty: () => useWatchParty.getState(),
      openWatchParty,
      openMemories,
      clipUrlFor,
      call: () => getCall(),
    };
  }, []);

  useEffect(() => {
    if (!ready || done.current) return;
    const want = ["sb", "sbdemo", "sbpill", "memories", "memopen", "watchparty", "memtest", "joinsound"].some((f) => flag(f) !== null);
    if (!want) {
      done.current = true;
      return;
    }
    if (!roomId && (flag("memories") !== null || flag("memopen") !== null || flag("watchparty") !== null)) return; // wait for the room
    const t = window.setTimeout(() => {
      done.current = true;
      if (flag("sbdemo") !== null) {
        loadDemo();
        openSoundboard();
      } else if (flag("sb") !== null) openSoundboard();
      if (flag("sbpill") !== null) fakePlaying();
      const mo = flag("memopen");
      if (mo !== null || flag("memories") !== null) openMemories(roomId, mo ?? undefined);
      if (flag("watchparty") !== null) openWatchParty(roomId);
      if (flag("memtest") !== null) void runMemTest();
      if (flag("joinsound") !== null) openWindow("media-joinsound-dev", {});
    }, 600);
    return () => window.clearTimeout(t);
  }, [ready, roomId]);

  return null;
}

// ---- ?memtest=1: the Memories player self-test (web twin of --tinhat-memtest) -------------------------

async function runMemTest(): Promise<void> {
  const res = { done: false, pass: 0, fail: 0, lines: [] as string[] };
  (window as unknown as { __memtest: typeof res }).__memtest = res;
  const say = (ok: boolean, what: string) => {
    const line = `[memtest] ${ok ? "PASS" : "FAIL"} ${what}`;
    res.lines.push(line);
    if (ok) res.pass++;
    else res.fail++;
    console.log(line);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const root = async () => {
    for (let i = 0; i < 120 && !document.querySelector("[data-mem-player]"); i++) await sleep(250);
    return document.querySelector<HTMLElement>("[data-mem-player]");
  };
  const secs = () => {
    const t = document.querySelector("[data-mem-player] span[class*='time']")?.textContent ?? "";
    const m = t.match(/(?:(\d+):)?(\d+):(\d\d)/);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
  };
  const key = (el: HTMLElement, k: string, shift = false) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
  const el = await root();
  if (!el) {
    say(false, "player opened (use ?memopen=<id|latest>&memtest=1)");
    res.done = true;
    return;
  }
  say(true, "player opened");
  await sleep(3000);
  const t0 = secs();
  await sleep(2000);
  const t1 = secs();
  say(t1 > t0, `clock advances while playing (${t0} → ${t1})`);
  key(el, " ");
  await sleep(700);
  const p0 = secs();
  await sleep(1500);
  say(secs() === p0, "Space pauses (clock holds)");
  key(el, " ");
  const hasVideo = !!document.querySelector("[data-mem-player] [class*='povPill']:not([class*='povOn'])") || !!document.querySelector("[data-mem-player] [class*='caption']");
  if (hasVideo && document.body.textContent?.includes("Voices only")) {
    key(el, "0");
    await sleep(1500);
    say(!!document.querySelector("[data-mem-player]")?.textContent?.includes("Audio only"), "0 = voices only on stage");
    key(el, "1");
    await sleep(2500);
    say(!!document.querySelector("[data-mem-player] [class*='caption']"), "1 = point of view 1 back on stage");
  }
  const s0 = secs();
  key(el, "ArrowRight");
  await sleep(1500);
  const s1 = secs();
  say(s1 >= s0 + 8 || !!document.querySelector("[data-mem-player] [class*='endOverlay']"), `→ skips 10 s (${s0} → ${s1})`);
  key(el, "ArrowLeft");
  await sleep(1500);
  const s2 = secs();
  say(s2 <= s1 - 8 || s2 <= 11, `← goes back 10 s (${s1} → ${s2})`);
  res.done = true;
  console.log(`[memtest] done: ${res.pass} pass, ${res.fail} fail`);
}

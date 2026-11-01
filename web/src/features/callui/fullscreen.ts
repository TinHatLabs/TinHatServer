// fullscreen.ts — full screen for a share on a phone (Pad QOL 2026-10-31; docs/WEB-EXCEPTIONS.md "Pad QOL").
// In order, each tried only when the one before is missing OR refused:
//   element   the Fullscreen API on the share's box (keeps our zoom / pan and the overlay buttons); the orientation lock
//             to landscape is a separate best effort (most browsers refuse it outside full screen or without a gesture)
//   video     iPhone Safari has no element full screen: `<video>.webkitEnterFullscreen()` (Apple's player, no overlay)
//   fill      neither: an in-page mode (the box fixed over the whole page, black, safe-area insets, no chrome)
// A handle keeps what was entered (the exact element / video) and calls `onEnd` once when it ends by itself — the
// system's own exit (Esc, the back gesture, Apple's Done) — so the caller's state never goes stale (review #9/#10).
// The desktop app's twin is the share tile's OS full-screen window (CallIsland.qml / Main.qml).
export type FsMode = "element" | "video" | "fill";

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitSupportsFullscreen?: boolean; webkitDisplayingFullscreen?: boolean };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

export interface FsHandle {
  mode: FsMode;
  /** leave (idempotent); `onEnd` is not called for an exit asked for here */
  exit(): void;
}

function lockLandscape(): void {
  try {
    void (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape")?.catch(() => undefined);
  } catch {
    /* best effort */
  }
}
function unlock(): void {
  try {
    (screen.orientation as LockableOrientation | undefined)?.unlock?.();
  } catch {
    /* best effort */
  }
}

/** Enter full screen for `box` (the share's container) / its `<video>`. `onEnd` = it ended by itself. */
export async function enterShareFullscreen(box: HTMLElement, video: HTMLVideoElement | null, onEnd: () => void): Promise<FsHandle> {
  let done = false;
  const finish = (byUs: boolean) => {
    if (done) return false;
    done = true;
    if (!byUs) onEnd();
    return true;
  };
  if (typeof box.requestFullscreen === "function" && document.fullscreenEnabled !== false) {
    try {
      await box.requestFullscreen({ navigationUI: "hide" });
      lockLandscape();
      const onChange = () => {
        if (document.fullscreenElement === box) return;
        document.removeEventListener("fullscreenchange", onChange);
        unlock();
        finish(false);
      };
      document.addEventListener("fullscreenchange", onChange);
      return {
        mode: "element",
        exit: () => {
          document.removeEventListener("fullscreenchange", onChange);
          if (!finish(true)) return;
          if (document.fullscreenElement === box) void document.exitFullscreen().catch(() => undefined);
          unlock();
        },
      };
    } catch {
      /* refused (no gesture, a web view without it): try the next */
    }
  }
  const v = video as WebkitVideo | null;
  if (v && typeof v.webkitEnterFullscreen === "function" && v.webkitSupportsFullscreen !== false) {
    try {
      const onEndVideo = () => {
        v.removeEventListener("webkitendfullscreen", onEndVideo);
        finish(false);
      };
      v.addEventListener("webkitendfullscreen", onEndVideo);
      try {
        v.webkitEnterFullscreen();
      } catch (e) {
        v.removeEventListener("webkitendfullscreen", onEndVideo); // refused: no listener left behind (review pass 2)
        throw e;
      }
      return {
        mode: "video",
        exit: () => {
          v.removeEventListener("webkitendfullscreen", onEndVideo);
          if (!finish(true)) return;
          try {
            if (v.webkitDisplayingFullscreen !== false) v.webkitExitFullscreen?.();
          } catch {
            /* already out */
          }
        },
      };
    } catch {
      /* refused: fill */
    }
  }
  return { mode: "fill", exit: () => void finish(true) };
}

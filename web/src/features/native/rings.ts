// rings.ts — DM ringing inside the Tin Hat apps (caps "rings", share claude/tinhat-android/BRIDGE.md + RINGING.md §4).
// The app rings natively for its server's pushed rings while the page isn't on screen, so the page rings in-app only
// while it is visible. A ring answered on the phone opens the DM and sends the page the window event
// `tinhatnative:call` `{action: "answer", roomId}` once: the page joins the live call there, else just shows the room.
// The same event name carries the iOS app's call-state doorbell (callState.ts; no `action`): only an explicit
// `action: "answer"` is an answer. Pure (imports only ./bridge): unit-tested in native.test.ts.
import { nativeInfo, roomIdOk } from "./bridge";

export const RING_ANSWER_EVENT = "tinhatnative:call";

/** Untrusted detail → the answered room's id, or null (anything but `{action: "answer", roomId: <room id>}`). */
export function parseRingAnswer(detail: unknown): string | null {
  try {
    if (!detail || typeof detail !== "object") return null;
    // each property read once (a getter could answer differently the second time)
    const { action, roomId } = detail as { action?: unknown; roomId?: unknown };
    return action === "answer" && roomIdOk(roomId) ? roomId : null;
  } catch {
    return null;
  }
}

/** The app rings for this page's rings while the page isn't on screen (caps "rings"). */
export function appRings(): boolean {
  return nativeInfo()?.caps.includes("rings") ?? false;
}

/** Ring in-app now? Always outside such an app; inside it only while the page is visible (no double ring). */
export function ringInApp(appRingsCap: boolean, visible: boolean): boolean {
  return !appRingsCap || visible;
}

/** Call `cb(roomId)` for each answer the app sends; a no-op outside an app with caps "rings". Returns the
 *  unsubscribe. (Any script of the page could dispatch the event too; it could equally call the page's own Join.) */
export function onRingAnswer(cb: (roomId: string) => void): () => void {
  if (!appRings()) return () => undefined;
  const w = globalThis as { addEventListener?: (t: string, f: (e: Event) => void) => void; removeEventListener?: (t: string, f: (e: Event) => void) => void };
  const f = (e: Event) => {
    const roomId = parseRingAnswer((e as CustomEvent).detail);
    if (!roomId) return;
    try {
      cb(roomId);
    } catch {
      /* the page's handler failing never throws into the app's evaluateJavascript */
    }
  };
  w.addEventListener?.(RING_ANSWER_EVENT, f);
  return () => w.removeEventListener?.(RING_ANSWER_EVENT, f);
}

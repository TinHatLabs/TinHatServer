// focus.ts — which call service (the LiveKit JWT broker) new calls use: the one the user's server names in its
// .well-known/matrix/client (a Tin Hat Server names its own), else the build's default call service (rtc.ts wellKnownFocusUrl → calls/util defaultFocusUrl). Pure, so
// the desktop replays the same cases: crates/app/src/rtc.rs focus_from_wellknown ↔ focus.test.ts.

/** The call JWT service a .well-known/matrix/client names: its first org.matrix.msc4143.rtc_foci entry of type livekit
 *  with a livekit_service_url, else null. */
export function focusFromWellKnown(wk: unknown): string | null {
  const foci = wk && typeof wk === "object" ? (wk as Record<string, unknown>)["org.matrix.msc4143.rtc_foci"] : undefined;
  if (!Array.isArray(foci)) return null;
  for (const f of foci) {
    if (!f || typeof f !== "object") continue;
    const { type, livekit_service_url: url } = f as Record<string, unknown>;
    if (type === "livekit" && typeof url === "string" && url) return url;
  }
  return null;
}

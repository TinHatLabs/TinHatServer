// meterHint.ts — why the Settings mic meter shows no level (A13.0/A13.2, 2026-11-13; shared vectors meterhint.json = the
// desktop's meter_hint.rs). It used to say "unplugged or in use" for every failure, also when the browser had refused the
// microphone permission or the device was watching a call.
export type MeterWhy = "" | "nosignal" | "blocked" | "unavailable" | "watching";

export function meterHint(reason: string): string {
  switch (reason) {
    case "blocked":
      return "Tin Hat isn't allowed to use the microphone. Allow it in the browser's site settings for this page, then reload.";
    case "unavailable":
      return "The level meter can't run on this computer (a noise-filter part is missing). Your microphone can still work in calls.";
    case "watching":
      return "This device is watching a call, so it doesn't open its microphone. Choose Talk here to use it.";
    default:
      return "No signal from this microphone — it may be unplugged or in use by another app. Pick another one above.";
  }
}

/** A getUserMedia failure's reason: the permission refused (NotAllowedError / SecurityError) = blocked, else nosignal. */
export function meterWhyOf(e: unknown): MeterWhy {
  const n = (e as { name?: unknown } | null)?.name;
  return n === "NotAllowedError" || n === "SecurityError" ? "blocked" : "nosignal";
}

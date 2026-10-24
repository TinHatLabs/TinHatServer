// ResumePill.tsx — "the browser needs a tap" (engine `needsTap`, fix/ios-resume): after an iOS app switch
// the call's sound (or the mic) may only start again inside a tap. Desktop: a pill in the status bar next
// to the hear pills. Phone: a banner at the top of the call (and the minimised call pill says it).
// Any tap anywhere also does it (the engine listens) — these tell the user a tap is what's missing.
import { act, useC } from "./store";
import { HearPill } from "./HearPills";
import type { PillModel } from "./hear";

function model(need: "audio" | "mic"): PillModel {
  return need === "mic"
    ? {
        id: "resume-mic",
        tone: "warn",
        icon: "microphone-sensitivity-muted-symbolic",
        text: "Your mic stopped while Tin Hat was in the background",
        shortText: "Mic stopped",
        action: "Turn it back on",
        shortAction: "Turn on",
        tip: "The browser stopped your microphone while Tin Hat was in the background and needs a click to start it again.",
        run: () => act("resumeFromTap")(),
      }
    : {
        id: "resume-audio",
        tone: "warn",
        icon: "audio-volume-muted-symbolic",
        text: "Call sound is paused",
        shortText: "Sound paused",
        action: "Resume",
        tip: "The browser paused the call's sound (Tin Hat was in the background, or the call started without a click). Click anywhere to hear everyone again.",
        run: () => act("resumeFromTap")(),
      };
}

export function ResumePill() {
  const need = useC("needsTap");
  if (!need) return null;
  return <HearPill p={model(need)} />;
}

/** Phone: the call's top banner (same place as the BRB banner). */
export function ResumeBanner({ className }: { className: string }) {
  const need = useC("needsTap");
  if (!need) return null;
  return (
    <button type="button" className={className} data-testid="resume-tap" onClick={() => act("resumeFromTap")()}>
      {need === "mic" ? "🎙 Your mic stopped in the background — tap to turn it back on" : "🔈 Call sound is paused — tap to hear everyone again"}
    </button>
  );
}

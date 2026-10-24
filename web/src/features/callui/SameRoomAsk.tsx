// SameRoomAsk.tsx — "X says you're in the same room — link up?" (11.3 Same room). Shown in the call's banner
// strip (desktop) and above the phone grid; goes away by itself after 45 s, when answered, or when the asker cancels.
import { InlineMessage } from "@/ui";
import { act, useC } from "./store";

export function SameRoomAsk() {
  const srs = useC("sameRoom");
  const a = srs.ask;
  if (!a) return null;
  return (
    <InlineMessage
      type="information"
      icon="audio-input-microphone-symbolic"
      text={`${a.name} says you're in the same room — link up? One of your mics sends at a time and you won't hear each other through Tin Hat.`}
      actions={[
        { text: "Link up", icon: "dialog-ok", onTriggered: () => act("sameRoomAnswer")(true) },
        { text: "Not now", onTriggered: () => act("sameRoomAnswer")(false) },
      ]}
    />
  );
}

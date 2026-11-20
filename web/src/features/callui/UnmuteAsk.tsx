// UnmuteAsk.tsx — 12.1.17 (D04.6): the server-muted person's "Ask to be unmuted" button state (desktop CallIsland.qml's
// muted banner). The label and the cooldown are the shared rules (features/calls/unmuteask.ts).
import { useEffect, useState } from "react";
import { toast } from "@/core/bus";
import { askLabel, cooldownLeft } from "@/features/calls/unmuteask";
import { act, useC } from "./store";

export function useUnmuteAsk(): { label: string; ready: boolean; ask: () => void } {
  const at = useC("unmuteAskAt") || 0;
  const [, setTick] = useState(0);
  // read the clock at render (a fresh ask is never "in the future"); a clock that went backwards frees the button
  const left = cooldownLeft(at > 0 ? at : null, Date.now());
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setTick((x) => x + 1), left % 1000 || 1000);
    return () => clearTimeout(id);
  });
  return {
    label: askLabel(left),
    ready: left <= 0,
    ask: () => void act("askToUnmute")().then((r) => r && toast(r, { timeoutMs: 3000 })),
  };
}

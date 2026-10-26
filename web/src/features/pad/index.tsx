// features/pad — Pad: my phone as a remote for my call (DESIGN share claude/tinhat-pad/DESIGN.md, the contract
// docs/PAD.md). The rules, the transport, the receiver and the controller live in features/calls/pad (pure, tested);
// this folder wires them into the app (runtime.ts) and draws them: the Pad screen (PadScreen.tsx), the entry points
// beside Join (Entry.tsx), the receiver's chip (PadChip.tsx). Edits outside this folder: CORE-CHANGES.md.
import type { FeatureModule } from "@/core/registry";
import { PadHost } from "./PadScreen";
import { PadStatusPill, PadTopBarChip } from "./PadChip";
import { installPad } from "./runtime";
import { installPadDevHooks } from "./devhooks";

export { PadButton, PadReasonLine, PadRoomListBar, padCallText, pickTarget, pressPad } from "./Entry";
export { usePadTargets, useMyCallsElsewhere, openPad, closePad, deviceName, useDeviceName, padAllowed, PAD_PREF } from "./runtime";

export const feature: FeatureModule = {
  id: "pad",
  setup(r) {
    installPad();
    installPadDevHooks();
    const offs = [
      r.overlays.add({ id: "pad-screen", order: 60, component: PadHost }),
      r.callStatusPills.add({ id: "pad-chip", order: 40, component: PadStatusPill }),
      r.callBarItems.add({ id: "pad-chip-phone", order: 5, slot: "statusRight", component: PadTopBarChip }),
    ];
    return () => offs.forEach((o) => o());
  },
};

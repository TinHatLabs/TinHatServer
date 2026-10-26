// features/actions — 11.0 step 3 (buttons): wires the actions engine (src/actions: the table, availability, rows, the
// Ctrl+K palette) into the app — the snapshot providers (providers.ts: the app's real state), the id → command map
// (exec.ts), the confirm dialog of the run path, and a bridge for the one hook-only source (the crypto status).
// The components (src/actions/ui: ActionButton, ButtonRow) and the palette (features/nav/QuickSwitcher.tsx) read what
// this installs. Desktop counterpart: ActionsHost.qml + ActionsController.
import { useEffect } from "react";
import type { FeatureModule } from "@/core/registry";
import { useCryptoStatus } from "@/core/matrix";
import { snapshotChanged } from "@/actions/snapshot";
import { ActionsConfirmHost } from "@/actions/ui/ConfirmHost";
import { RowEditorHost } from "@/actions/ui/RowEditor";
import { ShortcutsPane } from "@/actions/ui/ShortcutsPane";
import { effectiveNow, defaultLive } from "@/actions/shortcutsStore";
import { parseSequence } from "@/actions/keys";
import { present } from "@/actions/evaluate";
import { getActionsSnapshot } from "@/actions/snapshot";
import { runAction } from "@/actions/run";
import { setActionKeyHook, setDefaultLiveCheck } from "@/core/shortcuts";
import { installProviders } from "./providers";
import { installHandlers } from "./exec";
import { getFormFactor } from "@/core/device";

/**
 * A person's own keys (ACTIONS.md §8.7): the page's one keydown listener asks here first. A key given to an action in
 * Settings → Shortcuts runs that action through the run path when it applies right now (the key is consumed only
 * then); a feature's registered default key fires only while it still belongs to its action (defaultLive). Push to
 * talk's key is watched by the call feature (holds are never matched).
 */
function installKeys(): void {
  // the feature's own registered key, read the engine's way ("Ctrl+Shift+,"); one it can't read stays live
  setDefaultLiveCheck((action, registered) => {
    const p = parseSequence(registered);
    return p.ok ? defaultLive(action, p.text) : true;
  });
  setActionKeyHook((_e, text, typing) => {
    for (const b of effectiveNow().bindings) {
      if (b.key !== text || b.source !== "user" || !b.wins || b.hold || (typing && !b.typing)) continue;
      const p = present({ app: "web", action: b.action, snapshot: getActionsSnapshot() });
      if (!p.visible || !p.enabled) continue;
      void runAction(b.action, { source: "key" });
      return true;
    }
    return false;
  });
}

/** Re-reads the snapshot when the crypto status changes (it has no subscription outside React). */
function ActionsStateBridge() {
  const cs = useCryptoStatus();
  useEffect(() => snapshotChanged(), [cs]);
  return null;
}

export const feature: FeatureModule = {
  id: "actions",
  setup(r) {
    installHandlers();
    installProviders();
    installKeys();
    // Settings → Shortcuts (after Overlay, before the operators' Invites)
    // not on a phone: key bindings need a keyboard (a 7,700-pt list there: iPhone/iPad sweep, 2026-10-25)
    r.settingsPanes.add({ id: "shortcuts", title: "Shortcuts", icon: "input-keyboard-symbolic", order: 85, component: ShortcutsPane, visible: () => getFormFactor() !== "mobile" });
    r.overlays.add({ id: "actions.confirm", order: 90, component: ActionsConfirmHost });
    r.overlays.add({ id: "actions.state", order: 91, component: ActionsStateBridge });
    r.overlays.add({ id: "actions.rowEditor", order: 92, component: RowEditorHost });
  },
};

// features/selfhost — the self-hosted Tin Hat Server's own rules (docs/SELFHOST.md; docs/DESKTOP-PENDING-selfhost-firstrun.md):
//   item 1  hide what the server doesn't offer: the server's `dev.tinhat.server` announcement (core/server) lays the
//           contract's `requires` over the actions it carries (Memories, the soundboard, the GIF picker, Reach statuses,
//           web push, Report a problem) and feeds `server.<feature>` into the actions snapshot; buttons, windows,
//           widgets, settings rows and the tour ask useServerFeature() (the whole gate list: docs/SELFHOST.md)
//   item 2  the calm first run: FirstKeyDialog (the Security Key step, opened by settings' verify host), the three
//           in-context questions (asks.tsx) and the first-message watcher (watch.ts)
import { bus } from "@/core/bus";
import type { FeatureModule } from "@/core/registry";
import { applyActionGates, guestNow, onServerOffer, predicateValues, refreshServerOffer, serverOffer } from "@/core/server";
import { TABLE } from "@/actions/table";
import { registerSnapshotProvider } from "@/actions/snapshot";
import { NotifyAskBanner } from "./asks";
import { FirstKeyPreview } from "./devpreview";
import { watchFirstMessage } from "./watch";

export { TourOfferCard, NotifyAskBanner, StatusAskBanner } from "./asks";
export { FirstKeyDialog } from "./FirstKeyDialog";

export const feature: FeatureModule = {
  id: "selfhost",
  setup(r) {
    const offs: Array<() => void> = [];
    // item 1: before the first render (main.tsx loads the features first), so no row ever draws a gated button
    applyActionGates(TABLE as unknown as Parameters<typeof applyActionGates>[0]);
    offs.push(registerSnapshotProvider("server", () => ({ values: predicateValues(serverOffer(), guestNow()) }), (changed) => onServerOffer(changed)));
    void refreshServerOffer(true);
    offs.push(bus.on("sessionReady", () => void refreshServerOffer(true)));
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshServerOffer();
    };
    document.addEventListener("visibilitychange", onVisible);
    offs.push(() => document.removeEventListener("visibilitychange", onVisible));

    // item 2: the notifications question on the room page, after this device's first message
    offs.push(r.roomBanners.add({ id: "selfhost-notify-ask", order: 90, component: NotifyAskBanner }));
    if (import.meta.env.DEV) offs.push(r.overlays.add({ id: "selfhost-firstkey-preview", order: 99, component: FirstKeyPreview }));
    let watchOff: (() => void) | null = null;
    offs.push(
      r.onReady.add({
        id: "selfhost-first-message",
        order: 0,
        run: () => {
          watchOff?.();
          watchOff = watchFirstMessage();
        },
      }),
    );
    return () => {
      watchOff?.();
      for (const off of offs) off();
    };
  },
};

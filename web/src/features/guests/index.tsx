// features/guests — the guest room (contract docs/GUESTS.md; the desktop's half: docs/DESKTOP-PENDING-guests.md).
// One optional "Guests" room per server: managers turn it on / off and renew its one link; someone with the link knocks
// from a browser page (<server>/call/?g=<key>) and waits at the door until a member lets them in, here or in the
// desktop app.
//   model.ts       the pure rules (state, roles → buttons, the room, the notices' dedupe, the hand-off) + tests
//   store.ts       GET /api/guests + on / off / link / admit / turn-away (the Matrix bearer)
//   GuestsPane     Settings → Guests (r.settingsPanes "guests")
//   GuestsBar      the bar + waiting rows under the Guests room's header (r.roomBanners)
//   CopyLink       "Copy guest link" in the Guests room's menu (r.roomMenu) and header (r.roomHeaderActions)
//   watch.ts       "Ana is waiting to come in as a guest" (r.onReady → sync listener)
// Only while the server's offer doesn't say `guests: false`. The guest room replaced the per-room guest links (core/server
// offer.ts RETIRED_ACTIONS).
import type { FeatureModule } from "@/core/registry";
import { getSession } from "@/core/matrix";
import { GuestsBar } from "./GuestsBar";
import { GuestLinkHeaderButton, guestLinkOffered } from "./CopyLink";
import { GuestsPane } from "./GuestsPane";
import { WORDS, isGuestAccount } from "./model";
import { copyGuestLink, guestRoomOffered, refreshGuests } from "./store";
import { watchGuests } from "./watch";

export { guestRoomOffered, useGuestRoomOffered, refreshGuests, openGuestsRoom } from "./store";

export const feature: FeatureModule = {
  id: "guests",
  setup(r) {
    const offs: Array<() => void> = [];
    offs.push(
      r.settingsPanes.add({
        id: "guests",
        title: "Guests",
        icon: "system-users-symbolic",
        order: 35,
        component: GuestsPane,
        // guests themselves never see it
        visible: () => guestRoomOffered() && !isGuestAccount(getSession().userId),
      }),
    );
    offs.push(r.roomBanners.add({ id: "guests-bar", order: 5, component: GuestsBar }));
    // the Guests room only: right before the room menu's "Copy invite link" (100, the matrix.to one), and in the header
    offs.push(
      r.roomMenu.add({
        id: "guests-copy-link",
        order: 99,
        label: WORDS.copy,
        icon: "link-symbolic",
        visible: (ctx) => guestLinkOffered(ctx.roomId),
        run: () => void copyGuestLink(),
      }),
    );
    offs.push(r.roomHeaderActions.add({ id: "guests-copy-link", order: 15, component: GuestLinkHeaderButton }));
    let stop: (() => void) | null = null;
    offs.push(
      r.onReady.add({
        id: "guests-watch",
        order: 0,
        run: () => {
          stop?.();
          stop = watchGuests();
          if (!isGuestAccount(getSession().userId)) void refreshGuests();
        },
      }),
    );
    return () => {
      stop?.();
      for (const off of offs) off();
    };
  },
};

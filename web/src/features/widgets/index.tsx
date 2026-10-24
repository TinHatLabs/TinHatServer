// features/widgets — the widget stack under the room list (Tin Hat modular UI step 2; contract WIDGETS.md,
// WIDGETS-UI.md; shared logic in src/widgets/). Up next, Call stats, Who's around; widgets W1 (2026-09-28): Pinned,
// Mentions (its tracker records this device's highlights from the session start: r.onReady), Sticky note, Friends'
// clocks; Game servers (11.1, docs/GAMESERVERS.md); widgets W3 (2026-09-28): Dice, Polls (+ their chat cards,
// r.timelineRenderers).
// widgets W2 (2026-09-28): "Is it just me?", Memories, the Soundboard pad, Game night.
//
// Contributions (registry only — the shell never imports this folder):
//   r.railExtras  "widgets" — the stack (the room panel renders rail extras between the list and the account card;
//                 phones: inside the list)
//   r.overlays    the gallery when it is opened from the app menu (the stack may be absent — no widgets)
//   r.appMenu     "Add widget…" (the way back when every widget was removed)
//   r.timelineRenderers  "dice-card" — a roll in the chat (dice/ChatCard.tsx); "poll-card" — a poll (polls/ChatCard.tsx)
// Storage: the device pref `widgets` (store.ts) until the dock host's synced layout carries the list.
// Dev / test hook: window.__twWidgets (dev server, or the debug flag) — the list, the gallery, the receive view, and
// `scenario(id, key)` / `mock(id, model)` / `clearMocks()`: a widget shows one of its sample states (impl.samples)
// instead of live data — the review screenshots and the GPU gate use it; nothing is written anywhere.
import { useEffect, useState } from "react";
import type { FeatureModule } from "@/core/registry";
import { bus } from "@/core/bus";
import { setPref } from "@/core/prefs";
import { useRxStore } from "@/features/calls";
import { Gallery } from "./Gallery";
import { widgetImpl } from "./impl";
import { clearMocks, mockedIds, setMock } from "./mock";
import { WidgetStack } from "./Stack";
import { addWidget, getItems, moveWidget, removeWidget, setCollapsed, setSize, WIDGETS_PREF } from "./store";
import "./upnext/UpNext";
import "./callstats/CallStats";
import "./around/WhosAround";
import { mockStoreWith } from "./gameservers/GameServers";
import "./pinned/Pinned";
import "./mentions/Mentions";
import "./note/Note";
import "./clocks/Clocks";
import "./dice/Dice";
import { DiceChatCard, isDiceEvent } from "./dice/ChatCard";
import "./polls/Polls";
import { PollChatCard, isPollEvent } from "./polls/ChatCard";
import { START_TYPES } from "@/widgets/polls";
import { installMentionTracker } from "./mentions/tracker";
import "./justme/JustMe"; // widgets W2: "Is it just me?"
import "./memories/Memories"; // widgets W2: Memories
import "./soundpad/SoundPad"; // widgets W2: the Soundboard pad
import "./gamenight/GameNight"; // widgets W2: Game night

let openGallery: (() => void) | null = null;

/** Always mounted: the gallery when opened from the app menu (the stack may be absent — no widgets). */
function GalleryHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openGallery = () => setOpen(true);
    return () => {
      openGallery = null;
    };
  }, []);
  return open ? <Gallery onClose={() => setOpen(false)} /> : null;
}

export { WidgetStack } from "./Stack";

export const feature: FeatureModule = {
  id: "widgets",
  setup(r) {
    r.railExtras.add({ id: "widgets", order: 10, component: WidgetStack });
    r.overlays.add({ id: "widgets-gallery", order: 90, component: GalleryHost });
    r.onReady.add({ id: "widgets-mentions", order: 50, run: () => installMentionTracker() });
    // widgets W3: a dice roll in the chat is a card (the body text stays for other clients)
    r.timelineRenderers.add({ id: "dice-card", order: 11, eventTypes: ["m.room.message"], match: isDiceEvent, component: DiceChatCard });
    // widgets W3: a poll start is a card (vote, results, End poll)
    r.timelineRenderers.add({ id: "poll-card", order: 12, eventTypes: [...START_TYPES], match: isPollEvent, component: PollChatCard });
    // not in the ☰ menu since 2026-09-29 (Edit layout has it) — registered hidden: edit mode's toolbar runs it by id
    r.appMenu.add({ id: "widgets-add", order: 45, label: "Add widget…", icon: "list-add-symbolic", visible: () => false, run: () => openGallery?.() });
    const w = window as unknown as { __TW_DEBUG__?: boolean; __twWidgets?: unknown };
    if (import.meta.env.DEV || w.__TW_DEBUG__)
      w.__twWidgets = {
        items: getItems,
        set: (items: unknown) => setPref(WIDGETS_PREF, items as object),
        add: addWidget,
        remove: removeWidget,
        move: moveWidget,
        size: setSize,
        collapse: setCollapsed,
        gallery: () => openGallery?.(),
        /** the Call stats receive view (people → incoming / outgoing / cq) */
        rx: () => useRxStore.getState(),
        /** the sample states a widget offers */
        scenarios: (id: string) => Object.keys(widgetImpl(id)?.samples ?? {}),
        /** show sample state `key` of widget `id` (built now, with the page's clock) */
        scenario: (id: string, key: string) => {
          const make = widgetImpl(id)?.samples[key];
          if (!make) throw new Error(`no scenario ${id}/${key}`);
          setMock(id, make());
        },
        /** show `model` in widget `id` (null = live again) */
        mock: setMock,
        /** the app-wide Game servers status = sample `key` of the widget (Up next / calendar card links); null = live */
        gsStore: mockStoreWith,
        clearMocks,
        mocked: mockedIds,
        bus,
      };
  },
};

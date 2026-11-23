// features/play — Tin Hat mini games v1 on the web (share claude/minigames/GAMES-V1-SPEC.md; desktop twin:
// play_wire/play_net/play_ctl.rs + Play*/Holdem*/Rig*.qml). Texas Hold'em and The Rig, dealt by the room's own Tin Hat
// server over the play API (/api/play/v1): the client + store (net.ts, store.ts, wire.ts), the shared rules
// (rules.ts + testvectors/games/), the game window (the game island's web form, GamesWindow.tsx), the tables
// (HoldemTable.tsx, RigTable.tsx), the call chips (CallChip.tsx), the chat cards (GameCard.tsx), the opt-in line
// (OptIn.tsx), Settings → Games (GamesPane.tsx), the Pad's Games section (PadGames.tsx). The game panel covers the room's
// timeline area (GamePanel.tsx, the shared layout choice until the contract grows a `game` island). The dev gallery
// (#/__gallery/games) plays against the play contract's mock. Edits outside this folder: CORE-CHANGES.md.
import type { FeatureModule } from "@/core/registry";
import { lazyPart } from "@/ui/lazy";
import { GamePhoneStrip, GameStatusPill, GamesCallButton } from "./CallChip";
import { GameCard, hasGameBlock } from "./GameCard";
import { GamesPane } from "./GamesPane";
import { OptInHost } from "./OptIn";
import { CompactHost, TurnWatch } from "./Stage";
import { roomGame } from "./space";
import { openGameWindow, ownServer, ownerState, playFeatures, usePlay } from "./store";


// the panel and everything in it (tables, the contract) is its own chunk, fetched when it first opens
const GamePanelHost = lazyPart("GamePanelHost", () => import("./GamePanel").then((m) => m.GamePanelHost));

export { PadGames } from "./PadGames";
export { usePlay, visibleGame, openGameWindow } from "./store";

export const feature: FeatureModule = {
  id: "play",
  setup(r) {
    const offs = [
      r.roomMenu.add({
        id: "play-games",
        order: 610,
        section: "Call features",
        label: "Games",
        icon: "applications-games-symbolic",
        enabled: (ctx) => !!ctx.roomId,
        // only in a room whose game space's owner plays (asked once; the first menu after a start may still be asking)
        visible: (ctx) => {
          const owner = ctx.roomId ? roomGame(ctx.roomId).owner : null;
          if (!owner) return false;
          void playFeatures(owner);
          return ownerState(owner).features?.play === true;
        },
        run: (ctx) => openGameWindow(ctx.roomId, null),
      }),
      r.callStatusPills.add({ id: "play-chip", order: 45, component: GameStatusPill }),
      r.callBarItems.add({ id: "play-phonestrip", order: 1, slot: "phoneStrip", component: GamePhoneStrip }),
      // the call bar's Games button (a feature item no action maps yet: callui places it after the row)
      r.callBarItems.add({ id: "play-games", order: 87, side: "center", component: GamesCallButton }),
      r.timelineRenderers.add({ id: "game-card", order: 11, eventTypes: ["m.room.message"], match: hasGameBlock, component: GameCard }),
      r.settingsPanes.add({ id: "games", title: "Games", icon: "applications-games-symbolic", order: 75, component: GamesPane, visible: () => ownerState(ownServer()).features?.play === true || Object.values(usePlay.getState().owners).some((x) => (x.wallets?.length ?? 0) > 0) }),
      r.overlays.add({ id: "play-optin", order: 55, component: OptInHost }),
      r.overlays.add({ id: "play-panel", order: 54, component: GamePanelHost }),
      // B4 / B10: the compact table on the Call stage, and the "your turn" watcher
      r.overlays.add({ id: "play-compact", order: 53, component: CompactHost }),
      r.overlays.add({ id: "play-turnwatch", order: 52, component: TurnWatch }),
      r.onReady.add({ id: "play-features", order: 90, run: () => void playFeatures(ownServer()) }),
    ];
    return () => offs.forEach((o) => o());
  },
};

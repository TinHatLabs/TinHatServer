// CallChip.tsx — a table in the call's room shows as a chip in the call (GAMES-V1-SPEC.md §6.4): "♠ Hold'em · 3
// seated · Join" / "🎰 The Rig · round 2 · Join". Desktop: the call's status strip (r.callStatusPills); phones: the
// strip above the tiles (the "phoneStrip" call-bar slot). Being in a call keeps the room's table list live (`sub`).
// The Rig's chips are not drawn where The Rig is hidden (gameVisible).
import { useCallStore } from "@/features/calls";
import { CallRoundButton } from "@/features/media/shared/CallRoundButton";
import { Icon, cx, useIsMobile } from "@/ui";
import { chipLabel, chipWords, GAMES_TIP, w } from "./rules";
import { openGameWindow, useRoomTables, useWalletPoll, visibleGame } from "./store";
import s from "./CallChip.module.css";

function Chips({ roomId, mobile }: { roomId: string; mobile: boolean }) {
  const { features, tables } = useRoomTables(roomId);
  const shown = tables.filter((t) => chipLabel(t) !== null && visibleGame(t.game, features));
  if (!shown.length) return null;
  return (
    <>
      {shown.map((t) => (
        <button key={t.table} type="button" className={cx(s.chip, mobile && s.mobile, t.game === "rig" && s.rig)} onClick={() => openGameWindow(roomId, t.table)} data-testid={`game-chip-${t.game}`}>
          <span className={cx(s.glyph, t.game === "rig" && s.glyphRig)} aria-hidden>
            {t.game === "holdem" ? "♠" : "★"}
          </span>
          <span className={s.text} aria-label={chipWords(t) ?? ""}>
            {(chipWords(t) ?? "").replace(/^\S+\s/, "")}
          </span>
          <span className={s.join}>{w("rig.join")}</span>
        </button>
      ))}
    </>
  );
}

/** r.callStatusPills (desktop). */
export function GameStatusPill({ roomId }: { roomId: string }) {
  const mobile = useIsMobile();
  const room = useCallStore((x) => (x.inCall ? x.callRoomId : "")) || roomId;
  return mobile || !room ? null : <Chips roomId={room} mobile={false} />;
}

/** r.callBarItems slot "phoneStrip" (phones): the open tables' chips, then always a Games chip (the phone's way into
 *  the Games list, your chips and "Open a table": punch list #23), lit while a table is open. Only where the room's
 *  game server plays. */
export function GamePhoneStrip({ roomId }: { roomId: string }) {
  const mobile = useIsMobile();
  const room = useCallStore((x) => (x.inCall ? x.callRoomId : "")) || roomId;
  if (!mobile || !room) return null;
  return (
    <div className={s.strip}>
      <Chips roomId={room} mobile />
      <GamesChip roomId={room} />
    </div>
  );
}

function GamesChip({ roomId }: { roomId: string }) {
  const { features, tables, why, game } = useRoomTables(roomId);
  useWalletPoll(game.owner, game.space, !!features?.play);
  if (!features?.play || why === "owner-unsupported") return null;
  const live = tables.some((t) => chipLabel(t) !== null && visibleGame(t.game, features));
  return (
    <button type="button" className={cx(s.chip, s.mobile, s.games, live && s.gamesLive)} onClick={() => openGameWindow(roomId, null)} aria-label={GAMES_TIP} data-testid="games-chip-new" data-live={live ? "1" : "0"}>
      <Icon name="prestige-symbolic" size={18} color={live ? "var(--th-accent-bright)" : "var(--th-text-secondary)"} />
      <span className={s.text}>{w("chip.new")}</span>
    </button>
  );
}

/** r.callBarItems (controls): the call bar's Games button (the tin hat): opens the game panel on the call's room; lit
 *  while a table is open there. Shown only where the room's space owner plays. */
export function GamesCallButton({ roomId }: { roomId: string }) {
  const room = useCallStore((x) => (x.inCall ? x.callRoomId : "")) || roomId;
  const { features, tables, why, game } = useRoomTables(room);
  // in a call the chips are being earned: keep my wallet fresh while the call bar shows
  useWalletPoll(game.owner, game.space, !!features?.play);
  if (!room || !features?.play || why === "owner-unsupported") return null;
  const live = tables.some((t) => chipLabel(t) !== null && visibleGame(t.game, features));
  return (
    <CallRoundButton
      iconName="prestige-symbolic"
      active={live}
      tip={GAMES_TIP}
      onClick={() => openGameWindow(room, null)}
      data-testid="games-call-button"
    />
  );
}

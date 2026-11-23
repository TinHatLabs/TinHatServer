// GamesWindow.tsx — the game panel (GAMES-V1-SPEC rev 2 §6.4; the web form of the `game` island): an in-app window
// beside the call (`defaultPlacement: "right"`, like Media Party) and a full-screen sheet on phones. Without a table it
// is the Games panel: whose chips are in play (the space's avatar, name and owner), my chips in that space, the room's
// open tables (Join / Watch) and "Open a table". With one it hosts the Hold'em table or The Rig. Opening it is "opening
// a game" (§2.2): the first time per space, the opt-in line is asked. A room that doesn't play says why (no space,
// still loading, a space itself, the owner runs no games or can't be reached) and offers a room admin "Use <space>'s
// chips here" where a space lists the room but the room doesn't name it.
import { useEffect, useState } from "react";
import { useCallStore } from "@/features/calls";
import { useRoomAvatar } from "@/core/matrix";
import { Avatar, Button, cx, useIsMobile } from "@/ui";
import { artVars } from "./art";
import { Chips, PlayerName } from "./bits";
import { TuneInOffer } from "./TuneIn";
import { AdminNotices, ManageChipsButton } from "./AdminChips";
import { HoldemTable } from "./HoldemTable";
import { RigTable } from "./RigTable";
import { CLOSED_WORDS, GAME_WORDS, chipLabel, chipWords, earnLine, w } from "./rules";
import { canLinkParent, childOnlySpaces, linkParent, useRoomGame, useSpaceName } from "./space";
import { validFor, useWalletPoll, createTable, ensureWallet, openGameWindow, refreshMe, usePlay, useRoomTables, useTableView, visibleGame, wkey, type OpenView, type RoomPlayWhy } from "./store";
import { codeWords, type HoldemView, type RigView, type TableItem } from "./wire";
import s from "./Games.module.css";

/** `bare`: no header of its own (the game panel draws back · title · space badge · × in one row). */
export function GamesWindow({ roomId, table, bare }: { roomId?: string; table?: string; bare?: boolean }) {
  const room = roomId ?? "";
  const { game, why, features, tables } = useRoomTables(room);
  const owner = game.owner;
  const space = game.space;
  const ovAny = useTableView(owner, table || null);
  // a cached view of another owner / space (the room moved) is never drawn under this room's badge
  const ov = validFor(ovAny, room, game);
  const dial = usePlay((x) => (table ? x.dial[table] : undefined));
  const status = usePlay((x) => (owner ? x.owners[owner]?.status : undefined));
  useWalletPoll(owner, space, !!features?.play);
  const openErr = usePlay((x) => (table ? x.openErr[table] : undefined));
  // opening the Games panel touches the wallet (top-up check) — and the first time per space asks the opt-in line
  useEffect(() => {
    if (!owner || !space || !features?.play) return;
    void ensureWallet(owner, space, true).then((ok) => ok && void refreshMe(owner, space));
  }, [owner, space, features?.play]);

  const body = () => {
    if (why) return <WhyNot roomId={room} why={why} owner={owner} />;
    if (!owner || !space || !features) return <Empty text={w("lobby.asking")} />;
    if (table) {
      if (!ov && openErr) return <Closed roomId={room} text={codeWords(openErr)} />;
      if (!ov) return <Empty text={status === "live" ? w("lobby.opening") : w("lobby.connecting")} />;
      if (ov.view.status === "closed") return <Closed roomId={room} game={ov.view.game} owner={owner} space={space} text={CLOSED_WORDS[ov.view.closed?.reason ?? "end"]} />;
      if (!visibleGame(ov.view.game, features)) return <Empty text={codeWords("rig-hidden")} />;
      return ov.view.game === "holdem" ? <HoldemTable ov={ov as OpenView & { view: HoldemView }} roomId={room} titled={!bare} /> : <RigTable ov={ov as OpenView & { view: RigView }} roomId={room} dial={dial} titled={!bare} />;
    }
    return <Lobby roomId={room} owner={owner} space={space} tables={tables.filter((t) => visibleGame(t.game, features))} rigShown={visibleGame("rig", features)} />;
  };

  return (
    <div className={s.root} style={artVars()} data-testid="games-window">
      {!bare && (table || (owner && space && !why)) && (
        <div className={s.crumbs}>
          {table ? (
            <button type="button" className={s.back} onClick={() => openGameWindow(room, null)} data-testid="games-back">
              ‹ Games
            </button>
          ) : (
            <span />
          )}
          {owner && space && <SpaceBadge owner={owner} space={space} />}
        </div>
      )}
      <div className={s.content}>{body()}</div>
    </div>
  );
}

/** Whose chips are in play: the space's avatar, name and owner ("Game Night · example.org"), never the name alone; and
 *  my chips there. */
/** `compact` (a phone at a table, #24): the space's name without its server, so the table's head stays on one line.
 *  `tight` (F-W1: that head also carries the Table | Call pill): the wallet chip, and the avatar only when it fits. */
export function SpaceBadge({ owner, space, table, roomId, compact, tight }: { owner: string; space: string; table?: string; roomId?: string; compact?: boolean; tight?: boolean }) {
  const g = useRoomGame(roomId ?? "");
  const ovRaw = usePlay((x) => (table ? x.views[table] : undefined));
  const ov = roomId ? validFor(ovRaw, roomId, g) : null;
  // while seated: my stack at this table (what's in front of me, not my bet); else the wallet
  const myStack = (() => {
    const v = ov?.view;
    if (!v || v.game !== "holdem" || !v.you) return null;
    const seat = v.seats.find((st) => st.seat === v.you!.seat);
    return seat ? seat.stack : null;
  })();
  const name = useSpaceName(space);
  const avatar = useRoomAvatar(space);
  const wal = usePlay((x) => x.wallets[wkey(owner, space)]?.wallet ?? null);
  return (
    <span className={cx(s.spaceBadge, compact && s.compact, tight && s.tight)} data-testid="games-space" title={compact ? `${name} · ${owner}` : undefined}>
      <Avatar name={name} seed={space} size={20} imageSource={avatar} />
      <span className={s.spaceName}>{name}</span>
      {compact ? <span className={s.srOnly}>· {owner}</span> : <span className={s.spaceOwner}>· {owner}</span>}
      {wal && (
        <span className={s.walletChip} title={w(myStack !== null ? "wallet.stack_tip" : "wallet.wallet_tip", { space: name })} data-testid="games-wallet-chip">
          <Chips n={myStack ?? wal.balance} />
          {wal.rank > 0 && <span className={s.rank}>Prestige {wal.rank}</span>}
        </span>
      )}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className={s.empty}>{text}</div>;
}

function WhyNot({ roomId, why, owner }: { roomId: string; why: RoomPlayWhy; owner: string | null }) {
  const text =
    why === "owner-unsupported" ? `${owner ?? "This space's server"} doesn't run games.` : why === "unknown" ? "Opening the room…" : codeWords(why);
  const offers = why === "no-space" && canLinkParent(roomId) ? childOnlySpaces(roomId) : [];
  return (
    <div className={s.empty} data-testid="games-why" data-why={why}>
      <div>{text}</div>
      {offers.map((o) => (
        <UseSpaceChips key={o.space} roomId={roomId} space={o.space} via={o.via} />
      ))}
    </div>
  );
}

/** A room admin's "Use <space>'s chips here" (rev 2 §1.1 step 4): writes the room's m.space.parent for a space that
 *  already lists the room. */
function UseSpaceChips({ roomId, space, via }: { roomId: string; space: string; via: string[] }) {
  const name = useSpaceName(space);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className={s.useSpace}>
      <Button
        highlighted
        text={busy ? w("lobby.linking") : `Use ${name}'s chips here`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setErr("");
          linkParent(roomId, space, via)
            .catch(() => setErr("Couldn't link the room. You may not have the right to change its settings."))
            .finally(() => setBusy(false));
        }}
        data-testid="games-use-space"
      />
      <span className={s.useHint}>This room is listed in {name} but doesn't name it back. Linking it means games here use {name}'s chips.</span>
      {err && <span className={s.useErr}>{err}</span>}
    </div>
  );
}

function Closed({ roomId, text, game, owner, space }: { roomId: string; text?: string; game?: "holdem" | "rig"; owner?: string | null; space?: string | null }) {
  const mine = usePlay((x) => (owner && space ? (x.wallets[wkey(owner, space)]?.wallet?.balance ?? null) : null));
  return (
    <div className={s.empty} data-testid="games-closed">
      {game && (
        <span className={cx(s.gameIcon, s.gameIconBig, game === "rig" && s.gameIconRig)} aria-hidden>
          {game === "holdem" ? "♠" : "★"}
        </span>
      )}
      <div className={s.closedLine}>{text ?? w("table.closed")}</div>
      {mine !== null && <div className={s.walletWords}>{w("lobby.you_have", { n: mine })}</div>}
      <Button highlighted text={w("lobby.closed_back")} onClick={() => openGameWindow(roomId, null)} />
    </div>
  );
}

function Lobby({ roomId, owner, space, tables, rigShown }: { roomId: string; owner: string; space: string; tables: TableItem[]; rigShown: boolean }) {
  const mobile = useIsMobile();
  const inThisCall = useCallStore((x) => x.inCall && x.callRoomId === roomId);
  const sw = usePlay((x) => x.wallets[wkey(owner, space)]);
  const spaceName = useSpaceName(space);
  const wal = sw?.wallet ?? null;
  const [seats, setSeats] = useState(8);
  const [busy, setBusy] = useState("");
  const openOf = (g: string) => tables.find((t) => t.game === g && t.status !== "closed");
  const open = async (game: "holdem" | "rig") => {
    setBusy(game);
    try {
      await createTable(roomId, game, game === "holdem" ? { seats } : { preset: "lite", bankroll: 6, patch: true });
    } finally {
      setBusy("");
    }
  };
  return (
    <div className={cx(s.lobby, mobile && s.mobile)} data-testid="games-lobby">
      <section className={s.wallet} data-testid="games-wallet">
        {wal ? (
          <>
            <div className={s.walletMain}>
              <Chips n={wal.balance} big />
              <span className={s.walletWords}>chips in {spaceName}</span>
              {wal.rank > 0 && <span className={s.rank}>Prestige {wal.rank}</span>}
            </div>
            <div className={s.walletRows}>
              <span>
                {w("lobby.cap")} <b>{wal.cap}</b>
              </span>
              <span>
                {w("lobby.earned_today")} <b>{wal.earned_today}</b> of {wal.day_max}
              </span>
              <span data-testid="games-earn-line">{wal.chip_s > 0 ? earnLine(wal.chip_s, wal.day_max) : w("lobby.per_hour")}</span>
            </div>
            {wal.holdings >= wal.cap && !wal.at_table && <div className={s.capLine}>{w("wallet.at_cap_idle")}</div>}
            {wal.topup.available && <div className={s.capLine}>{w("wallet.topup")}</div>}
            <AdminNotices owner={owner} space={space} />
            <TuneInOffer owner={owner} space={space} />
            <ManageChipsButton owner={owner} space={space} spaceName={spaceName} />
          </>
        ) : sw?.has === false ? (
          <div className={s.walletWords}>You haven't opened a game in {spaceName} yet. Nothing is counted until you do.</div>
        ) : (
          <div className={s.walletWords}>Connecting to {owner}…</div>
        )}
      </section>

      <section className={s.section}>
        <div className={s.sectionHead}>{w("lobby.in_this_call")}</div>
        {tables.length === 0 ? (
          <div className={s.none}>{w("lobby.no_tables")}</div>
        ) : (
          tables.map((t) => (
            <div key={t.table} className={s.tableRow} data-testid={`games-table-${t.game}`}>
              <span className={cx(s.gameIcon, t.game === "rig" && s.gameIconRig)} aria-hidden>
                {t.game === "holdem" ? "♠" : "★"}
              </span>
              <div className={s.tableText}>
                <span className={s.tableName}>{GAME_WORDS[t.game]}</span>
                <span className={s.tableMeta}>
                  <span>{chipWords(t)?.replace(/^\S+ [^·]+· /, "") ?? w("rig.phases.end")}</span>
                  {t.host && (
                    <>
                      <span>{w("lobby.host")}</span>
                      <PlayerName mxid={t.host} roomId={roomId} />
                    </>
                  )}
                </span>
              </div>
              {chipLabel(t) === null ? (
                // an ended table (still listed until it closes): its results, never a Join (the shared chip rule)
                <Button flat text={w("chip.open")} onClick={() => openGameWindow(roomId, t.table)} data-testid={`games-ended-${t.game}`} />
              ) : (
                <Button highlighted={inThisCall} text={inThisCall ? w("rig.join") : w("card.watch")} onClick={() => openGameWindow(roomId, t.table)} data-testid={`games-open-${t.game}`} />
              )}
            </div>
          ))
        )}
      </section>

      <section className={s.section}>
        <div className={s.sectionHead}>{w("lobby.open_a_table")}</div>
        {!inThisCall && <div className={s.none}>{w("lobby.join_call_first")}</div>}
        <div className={s.newGrid}>
          <div className={s.newCard}>
            <div className={s.newTitle}>
              <span className={s.gameIcon}>♠</span> {w("games.holdem")}
            </div>
            <div className={s.newSub}>{w("lobby.holdem_blurb")}</div>
            <div className={s.newRow}>
              <span className={s.newLabel}>{w("lobby.seats")}</span>
              <div className={s.seg}>
                {[2, 4, 6, 8].map((n) => (
                  <button key={n} type="button" className={cx(s.segBtn, seats === n && s.segOn)} onClick={() => setSeats(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {openOf("holdem") ? (
              <Button text={w("lobby.table_open_join")} onClick={() => openGameWindow(roomId, openOf("holdem")!.table)} />
            ) : (
              <Button highlighted text={busy === "holdem" ? w("lobby.opening_short") : w("lobby.open_holdem")} disabled={!inThisCall || !!busy} onClick={() => void open("holdem")} data-testid="games-new-holdem" />
            )}
          </div>
          {rigShown && (
            <div className={s.newCard}>
              <div className={s.newTitle}>
                <span className={cx(s.gameIcon, s.gameIconRig)}>★</span> {w("games.rig")}
              </div>
              <div className={s.newSub}>{w("lobby.rig_blurb")}</div>
              {openOf("rig") ? (
                <Button text={w("lobby.table_open_join")} onClick={() => openGameWindow(roomId, openOf("rig")!.table)} />
              ) : (
                <Button highlighted text={busy === "rig" ? w("lobby.opening_short") : w("lobby.open_rig")} disabled={!inThisCall || !!busy} onClick={() => void open("rig")} data-testid="games-new-rig" />
              )}
            </div>
          )}
        </div>
      </section>
      <div className={s.footnote}>Play money only: chips can't be bought, sold, cashed out or sent anywhere, and they stay in {spaceName}.</div>
    </div>
  );
}

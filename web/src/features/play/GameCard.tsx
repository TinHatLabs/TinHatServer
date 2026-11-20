// GameCard.tsx — the chat card for a `dev.tinhat.game` message (GAMES-V1-SPEC.md §6.6). The card is drawn from the
// SERVER'S record, never from the event: it asks the room's own server (rankServerFor) and checks that the table's
// recorded room is this room; a card naming another server is "Couldn't load this game" and nothing is fetched from
// the server it names. The Rig where it's hidden (a phone app with the switch off) is the neutral one line. Readers
// show the first card per (table, kind, round) and ignore repeats.
import { useEffect, useState } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import type { TimelineRendererProps } from "@/core/registry";
import { Button, cx } from "@/ui";
import { artVars } from "./art";
import { PlayerName } from "./bits";
import { cardAction, GAME_WORDS, w } from "./rules";
import { useRoomGame } from "./space";
import { fetchSummary, joinCallForGame, openGameWindow, useRoomTables, visibleGame } from "./store";
import { useCallStore } from "@/features/calls";
import { isRoomId, isTableId, type Game, type Summary } from "./wire";
import s from "./GameCard.module.css";

export interface GameBlock {
  kind: "invite" | "result" | "summary";
  game: Game;
  server: string;
  space: string;
  table: string;
  round?: number;
}

/** The `dev.tinhat.game` block, checked (null = not a game card). */
export function readGameBlock(content: unknown): GameBlock | null {
  const c = content && typeof content === "object" ? (content as Record<string, unknown>)["dev.tinhat.game"] : undefined;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.kind !== "invite" && o.kind !== "result" && o.kind !== "summary") return null;
  if (o.game !== "holdem" && o.game !== "rig") return null;
  if (typeof o.server !== "string" || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(o.server) || !isTableId(o.table) || !isRoomId(o.space)) return null;
  const b: GameBlock = { kind: o.kind, game: o.game, server: o.server, space: o.space, table: o.table };
  if (typeof o.round === "number" && Number.isSafeInteger(o.round) && o.round >= 0) b.round = o.round;
  return b;
}

export function hasGameBlock(ev: MatrixEvent): boolean {
  return ev.getType() === "m.room.message" && readGameBlock(ev.getContent()) !== null;
}

// the first card per (room, table, kind, round): its event id
const firsts = new Map<string, { id: string; ts: number }>();
function isFirst(roomId: string, b: GameBlock, ev: MatrixEvent): boolean {
  const k = `${roomId}|${b.table}|${b.kind}|${b.round ?? 0}`;
  const id = ev.getId() ?? "";
  const ts = ev.getTs();
  const cur = firsts.get(k);
  if (!cur || ts < cur.ts || (ts === cur.ts && id < cur.id)) {
    firsts.set(k, { id, ts });
    return true;
  }
  return cur.id === id;
}

export function GameCard({ roomId, event }: TimelineRendererProps) {
  const b = readGameBlock(event.getContent());
  // the card must name the room's own game space and its owner (rev 2 §6.6); anything else fetches nothing
  const g = useRoomGame(roomId);
  const own = g.owner;
  const matches = !!b && !!own && b.server === own && b.space === g.space;
  const { features, tables, loaded } = useRoomTables(roomId, !!b && b.kind === "invite" && matches);
  const [sum, setSum] = useState<Summary | null | "none">(null);
  const inCall = useCallStore((x) => x.inCall && x.callRoomId === roomId);
  const wrongServer = !!b && !!own && !matches;
  useEffect(() => {
    if (!b || !matches || !own || b.kind === "invite") return;
    let dead = false;
    void fetchSummary(own, b.table).then((r) => {
      // the record must be this room's and this space's (a forged card fakes nothing)
      if (!dead) setSum(r && r.table === b.table && r.room === roomId && r.space === b.space && r.owner === own ? r : "none");
    });
    return () => {
      dead = true;
    };
  }, [b?.table, b?.kind, own, roomId, matches]);
  if (!b) return null;
  if (wrongServer || (g.why !== "" && g.why !== "unknown")) return <div className={cx(s.card, s.quiet)}>Couldn't load this game.</div>;
  if (!own) return <div className={cx(s.card, s.quiet)}>{w("card.loading")}</div>;
  if (!matches) return <div className={cx(s.card, s.quiet)}>{w("card.loading")}</div>;
  // the first valid card per (table, kind, round) only (checked after the card proved itself this room's)
  if (!isFirst(roomId, b, event)) return null;
  // which game it is and who opened it come from the SERVER's record (the listing / the summary), never the event:
  // until a record says, the card stays neutral
  const live = b.kind === "invite" ? tables.find((t) => t.table === b.table && t.status !== "closed") : undefined;
  const recGame = b.kind === "invite" ? live?.game : sum && sum !== "none" ? sum.game : undefined;
  if (b.kind === "invite" && !live) return <div className={cx(s.card, s.quiet)}>{loaded ? w("table.closed") : w("card.loading")}</div>;
  if (sum === "none") return <div className={cx(s.card, s.quiet)}>{w("card.gone")}</div>;
  if (!recGame) return <div className={cx(s.card, s.quiet)}>{w("card.loading")}</div>;
  if (features && !visibleGame(recGame, features)) return <div className={cx(s.card, s.quiet)}>{w("card.neutral")}</div>;
  if (b.kind === "invite" && live) {
    const gm = live.game;
    const host = live.host;
    // the shared rule (both apps): Open in this room's call, Join the call outside it, an ended table's results only in it
    const action = cardAction("invite", live.status, inCall);
    return (
      <div className={cx(s.card, recGame === "rig" && s.rig)} style={artVars()} data-testid="game-card-invite">
        <span className={cx(s.icon, recGame === "rig" && s.iconRig)} aria-hidden>
          {recGame === "holdem" ? "♠" : "★"}
        </span>
        <div className={s.text}>
          <span className={s.title}>
            <PlayerName mxid={host} roomId={roomId} /> {w(gm === "holdem" ? "card.opened_holdem" : "card.opened_rig")}
          </span>
          <span className={s.sub}>{live.status === "end" ? w("rig.phases.end") : w(gm === "holdem" ? "card.seated_line" : "card.joined_line", { n: live.seated })}</span>
        </div>
        {action === "open" && <Button highlighted text={w("chip.open")} onClick={() => openGameWindow(roomId, b.table)} data-testid="game-card-open" />}
        {action === "join_call" && <Button highlighted text={w("card.join_call")} onClick={() => joinCallForGame(roomId, b.table)} data-testid="game-card-join-call" />}
      </div>
    );
  }
  if (!sum) return <div className={cx(s.card, s.quiet)}>{w("card.loading")}</div>;
  const sg = sum.game;
  const rows = (sum.leaderboard.length ? sum.leaderboard : Object.entries(sum.net).map(([u, net]) => ({ u, net }))).slice().sort((a, z) => z.net - a.net);
  return (
    <div className={cx(s.card, s.result, recGame === "rig" && s.rig)} style={artVars()} data-testid="game-card-result">
      <div className={s.resultHead}>
        <span className={cx(s.icon, recGame === "rig" && s.iconRig)} aria-hidden>
          {recGame === "holdem" ? "♠" : "★"}
        </span>
        <span className={s.title}>
          {w(sum.status === "closed" ? "card.closed_title" : "card.results_title", { game: GAME_WORDS[sg] })}
        </span>
        <span className={s.sub}>
          {sg === "holdem" ? (sum.hands ? w("card.hands", { n: sum.hands }) : "") : sum.rounds ? w("card.rounds", { n: sum.rounds }) : ""}
          {sum.biggest_pot ? ` · ${w("card.biggest_pot_short", { n: sum.biggest_pot })}` : ""}
        </span>
      </div>
      {rows.map((p) => (
        <div key={p.u} className={s.row}>
          {/^~/.test(p.u) ? <span className={s.rowName}>{w("rig.someone")}</span> : <PlayerName mxid={p.u} roomId={roomId} className={s.rowName} />}
          <span className={cx(s.net, p.net > 0 ? s.up : p.net < 0 ? s.down : "")}>{p.net > 0 ? `+${p.net}` : p.net}</span>
        </div>
      ))}
    </div>
  );
}

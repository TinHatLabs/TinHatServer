// PadGames.tsx — games on the Pad (GAMES-V1-SPEC.md §4.4, §5.4): the phone is the same person, so it plays with its
// own play session, straight to the play server. The Pad screen shows "Games · Texas Hold'em · Open" while the call
// room it controls has a table; opening it draws the table inside the Pad (the phone layout: my cards big, the board
// and pot, the action bar). The computer then shows my cards face down (`you.screens` has `pad`) while this table shows and the page is
// visible (store.ts usePadTableView; B2). Where The Rig is
// hidden (a phone app with the switch off) it isn't offered here.
import { useEffect, useState } from "react";
import { cx } from "@/ui";
import { artVars } from "./art";
import { HoldemTable } from "./HoldemTable";
import { TuneInOffer } from "./TuneIn";
import { RigTable } from "./RigTable";
import { GAME_WORDS, chipWords, w } from "./rules";
import { usePadClaim, usePadTableView, useRoomTables, validFor, visibleGame, usePlay, type OpenView } from "./store";
import { useRoomGame } from "./space";
import { codeWords, type HoldemView, type RigView } from "./wire";
import s from "./PadGames.module.css";

export function PadGames({ room, dim }: { room: string; dim?: boolean }) {
  const { game, features, tables } = useRoomTables(room);
  const server = game.owner;
  const [open, setOpen] = useState("");
  // a table belongs to its room and owner: another call (or owner) starts from the list again
  useEffect(() => setOpen(""), [room, server]);
  const shown = tables.filter((t) => t.status !== "closed" && visibleGame(t.game, features));
  const sideOffer = !open && <TuneInOffer owner={server} space={game.space} />;
  if (!shown.length && !open) return sideOffer ? <section className={cx(s.section, dim && s.dim)} style={artVars()}>{sideOffer}</section> : null;
  return (
    <section className={cx(s.section, dim && s.dim)} data-testid="pad-games" style={artVars()}>
      <div className={s.head}>
        <span className={s.title}>{w("chip.new")}</span>
        {open && (
          <button type="button" className={s.back} onClick={() => setOpen("")} data-testid="pad-games-back">
            ‹ All games
          </button>
        )}
      </div>
      {sideOffer}
      {open ? (
        <PadTable server={server} table={open} room={room} />
      ) : (
        shown.map((t) => (
          <button key={t.table} type="button" className={s.row} onClick={() => setOpen(t.table)} data-testid={`pad-game-${t.game}`}>
            <span className={cx(s.icon, t.game === "rig" && s.iconRig)} aria-hidden>
              {t.game === "holdem" ? "♠" : "★"}
            </span>
            <span className={s.text}>
              <span className={s.name}>{GAME_WORDS[t.game]}</span>
              <span className={s.meta}>{chipWords(t)?.replace(/^\S+ [^·]+· /, "") ?? w("rig.phases.end")}</span>
            </span>
            <span className={s.open}>{w("chip.open")}</span>
          </button>
        ))
      )}
    </section>
  );
}

function PadTable({ server, table, room }: { server: string | null; table: string; room: string }) {
  const g = useRoomGame(room);
  const ov = validFor(usePadTableView(server, table), room, g);
  usePadClaim(!!ov);
  const dial = usePlay((x) => x.dial[table]);
  const err = usePlay((x) => x.openErr[table]);
  if (!ov && err) return <div className={s.wait}>{codeWords(err)}</div>;
  if (!ov) return <div className={s.wait}>{w("lobby.opening")}</div>;
  return (
    <div className={s.table}>
      {ov.view.game === "holdem" ? <HoldemTable ov={ov as OpenView & { view: HoldemView }} roomId={room} onPad /> : <RigTable ov={ov as OpenView & { view: RigView }} roomId={room} dial={dial} pad />}
    </div>
  );
}

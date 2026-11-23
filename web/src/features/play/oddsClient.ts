// oddsClient.ts — F6 "your odds" for the table on screen (GAMES-V1.1-ADDENDUM §3): ONLY my own hole cards, the board
// and the number of live opponents go in (never another seat's cards, never `shown`); the worker computes; each answer is
// cached by its canonical input and drawn only while its tag (table, hand, input) is still the current one, so a new
// street / hand / opponent count clears the line at once and a late answer never paints old numbers.
import { useEffect, useState } from "react";
import { canonical, liveOpponents, oddsVisible, odds as oddsNow, type Odds, type OddsIn } from "./odds";
import type { HoldemView } from "./wire";

/** The odds question of a view, or null (not a valid question). Its ONLY inputs: you.cards, hand.board, the seats'
 *  public states. */
export function oddsQuestion(v: Pick<HoldemView, "you" | "hand" | "seats">): OddsIn | null {
  const hole = v.you?.cards ?? [];
  const board = v.hand?.board ?? [];
  const n = liveOpponents(v.seats, v.you?.seat ?? null);
  const q = { hole: [...hole], board: [...board], n };
  return canonical(q) ? q : null;
}

const cache = new Map<string, Odds>();
const CACHE_MAX = 64;
let worker: Worker | null = null;
let workerDead = false;
let nextId = 1;
const waiting = new Map<number, (r: Odds | null) => void>();

function ask(q: OddsIn): Promise<Odds | null> {
  if (!workerDead && typeof Worker !== "undefined") {
    try {
      worker ??= new Worker(new URL("./odds.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (ev: MessageEvent<{ id: number; r: Odds | null }>) => {
        const w = waiting.get(ev.data.id);
        waiting.delete(ev.data.id);
        w?.(ev.data.r);
      };
      worker.onerror = () => {
        workerDead = true;
        for (const w of waiting.values()) w(null);
        waiting.clear();
      };
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        worker!.postMessage({ id, q });
      });
    } catch {
      workerDead = true;
    }
  }
  // no worker (very old browser): compute after a frame (still never blocks a click)
  return new Promise((resolve) => setTimeout(() => resolve(oddsNow(q)), 0));
}

export interface OddsLine {
  odds: Odds | null;
  /** the made hand now (drawn while the numbers compute) */
  pending: boolean;
}

/** The odds for the table on screen, or null while hidden (odds_visible). */
export function useOdds(v: HoldemView, face: string, setting: unknown): Odds | null {
  const q = oddsQuestion(v);
  const visible =
    !!q &&
    oddsVisible({ setting, youState: v.you?.state ?? null, street: v.hand?.street ?? null, result: v.result ?? null, face, opponents: q.n });
  const tag = visible && q ? `${v.table}|${v.hand?.n}|${canonical(q)!.key}` : "";
  const [got, setGot] = useState<{ tag: string; odds: Odds | null }>({ tag: "", odds: null });
  useEffect(() => {
    if (!tag || !q) return;
    const key = canonical(q)!.key;
    const hit = cache.get(key);
    if (hit) {
      setGot({ tag, odds: hit });
      return;
    }
    let live = true;
    void ask(q).then((r) => {
      if (r) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, r);
      }
      if (live) setGot({ tag, odds: r });
    });
    return () => {
      live = false;
    };
    // the tag carries every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);
  return tag && got.tag === tag ? got.odds : null;
}

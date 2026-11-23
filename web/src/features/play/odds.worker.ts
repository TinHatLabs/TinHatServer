// odds.worker.ts — F6's odds off the UI thread (GAMES-V1.1-ADDENDUM §3.3: web = a Web Worker). One question in, one
// answer out, tagged with the caller's id; the method is odds.ts (pure, the vectors' integers).
import { odds, type OddsIn } from "./odds";

self.onmessage = (ev: MessageEvent<{ id: number; q: OddsIn }>) => {
  const { id, q } = ev.data;
  let r = null;
  try {
    r = odds(q);
  } catch {
    r = null;
  }
  (self as unknown as Worker).postMessage({ id, r });
};

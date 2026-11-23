// side.ts — F9 "Tune In" (GAMES-V1.1-ADDENDUM §6): the two calls. The play server holds the secret and judges every
// try; the app only draws what it answers. /me.side says whether it is offered (the apps never guess eligibility).
import { PlayHttpError } from "./net";
import { conn, refreshMe } from "./store";
import { newOp } from "./wire";
import { parseAnswer, parseRun, type TuneAnswer, type TuneRun } from "./sideRules";

export * from "./sideRules";

export async function startTune(owner: string, space: string): Promise<TuneRun | string> {
  const c = await conn(owner);
  if (!c) return "off";
  try {
    return parseRun(await c.post("/side/tune", { space })) ?? "bad";
  } catch (e) {
    return e instanceof PlayHttpError ? e.code : "network";
  }
}
export async function tune(owner: string, space: string, run: string, guess: number): Promise<TuneAnswer | string> {
  const c = await conn(owner);
  if (!c) return "off";
  try {
    const a = parseAnswer(await c.post(`/side/tune/${encodeURIComponent(run)}`, { op: newOp(), guess }));
    if (a?.paid) void refreshMe(owner, space);
    return a ?? "bad";
  } catch (e) {
    const code = e instanceof PlayHttpError ? e.code : "network";
    if (code === "no-run") void refreshMe(owner, space); // a restart lost the run: the money, if paid, is in /me
    return code;
  }
}

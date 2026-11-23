// admin.ts — F8 (GAMES-V1.1-ADDENDUM §5.3): the admin routes, through the owner's play connection (the same play
// session; only the server that keeps the space answers). Every write carries a fresh op (durable idempotency).
import { PlayHttpError } from "./net";
import { conn, refreshMe } from "./store";
import { newOp } from "./wire";
import { parseAdminSpace, parseLog, type AdminAction, type AdminSpace, type EconomyKey, type LogEntry } from "./adminRules";

export * from "./adminRules";

const base = (space: string) => `/admin/spaces/${encodeURIComponent(space)}`;
const codeOf = (e: unknown) => (e instanceof PlayHttpError ? e.code : "network");

export async function adminSpace(owner: string, space: string): Promise<AdminSpace | string> {
  const c = await conn(owner);
  if (!c) return "off";
  try {
    return parseAdminSpace(await c.get(base(space))) ?? "bad";
  } catch (e) {
    return codeOf(e);
  }
}
export interface WalletsAnswer {
  done: { u: string }[];
  skipped: { u: string; code: string }[];
}
export async function adminWallets(owner: string, space: string, action: AdminAction, who: string[] | "everyone", amount: number | null, reason: string): Promise<WalletsAnswer | string> {
  const c = await conn(owner);
  if (!c) return "off";
  const body: Record<string, unknown> = { op: newOp(), action, who };
  if (action !== "reset") body.amount = amount;
  if (reason) body.reason = reason;
  try {
    const j = (await c.post(`${base(space)}/wallets`, body)) as { done?: unknown; skipped?: unknown };
    void refreshMe(owner, space); // my own wallet may be among them
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is { u: string; code?: string } => !!x && typeof x === "object" && typeof (x as { u?: unknown }).u === "string") : []);
    return { done: list(j?.done), skipped: list(j?.skipped).map((x) => ({ u: x.u, code: typeof x.code === "string" ? x.code : "at-table" })) };
  } catch (e) {
    return codeOf(e);
  }
}
export async function adminEconomy(owner: string, space: string, set: Partial<Record<EconomyKey, number | boolean>>, reset: EconomyKey[], reason: string): Promise<AdminSpace["economy"] | string> {
  const c = await conn(owner);
  if (!c) return "off";
  try {
    const j = (await c.put(`${base(space)}/economy`, { op: newOp(), set, reset, ...(reason ? { reason } : {}) })) as { economy?: unknown };
    return parseAdminSpace({ you: { admin: true }, economy: j?.economy, wallets: [] })?.economy ?? "bad";
  } catch (e) {
    return codeOf(e);
  }
}
export async function adminLog(owner: string, space: string, before?: number): Promise<LogEntry[] | string> {
  const c = await conn(owner);
  if (!c) return "off";
  try {
    return parseLog(await c.get(`${base(space)}/log?limit=50${before ? `&before=${before}` : ""}`)) ?? "bad";
  } catch (e) {
    return codeOf(e);
  }
}
/** §5.5 notices: acknowledge my wallet's admin notices up to this id */
export async function noticesSeen(owner: string, space: string, upto: number): Promise<void> {
  const c = await conn(owner);
  try {
    await c?.post("/me/notices/seen", { space, upto });
  } catch {
    /* shown again next time: harmless */
  }
}

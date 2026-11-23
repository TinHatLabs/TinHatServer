// adminRules.ts — F8 the admin money screen (GAMES-V1.1-ADDENDUM §5): the answers' shapes (read tolerantly until the
// contract carries them), the economy keys and their bounds (the apps mirror them; the server is the word), and the
// confirm sentence that says exactly what will happen. Pure: no React, no app imports.

export const ECONOMY_KEYS = ["chip_minutes", "day_max", "start", "topup_to", "cap_base", "cap_per_rank", "side_day_max", "side_on"] as const;
export type EconomyKey = (typeof ECONOMY_KEYS)[number];
export const ECONOMY_BOUNDS: Readonly<Record<Exclude<EconomyKey, "side_on">, [number, number]>> = {
  chip_minutes: [2, 60],
  day_max: [1, 200],
  start: [0, 500],
  topup_to: [0, 100],
  cap_base: [20, 100_000],
  cap_per_rank: [0, 100_000],
  side_day_max: [0, 100],
};
export const ADMIN_MAX_DELTA = 10_000;
export const ADMIN_MAX_SET = 100_000;
export const ADMIN_MAX_TARGETS = 100;
export const ADMIN_RANK_MAX = 50;

export type Source = "default" | "server" | "space";
export interface EconomyEntry {
  value: number | boolean;
  source: Source;
}
export interface AdminWallet {
  u: string;
  balance: number | null;
  rank: number;
  cap: number;
  open: boolean;
}
export interface AdminSpace {
  admin: boolean;
  why: "space-admin" | "server-owner" | null;
  economy: Partial<Record<EconomyKey, EconomyEntry>>;
  wallets: AdminWallet[];
}
export type AdminAction = "grant" | "remove" | "set" | "reset" | "rank";
export interface LogEntry {
  id: number;
  at: number;
  by: string;
  action: string;
  who: string;
  amount: number | null;
  reason: string | null;
  count: number;
}
export interface Notice {
  id: number;
  at: number;
  action: AdminAction;
  amount: number | null;
  reason: string | null;
}

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseAdminSpace(v: unknown): AdminSpace | null {
  if (!isObj(v) || !isObj(v.you) || typeof v.you.admin !== "boolean") return null;
  const why = v.you.why === "space-admin" || v.you.why === "server-owner" ? v.you.why : null;
  const economy: Partial<Record<EconomyKey, EconomyEntry>> = {};
  if (isObj(v.economy))
    for (const k of ECONOMY_KEYS) {
      const e = v.economy[k];
      if (!isObj(e) || !(e.source === "default" || e.source === "server" || e.source === "space")) continue;
      if (k === "side_on" ? typeof e.value === "boolean" : int(e.value)) economy[k] = { value: e.value as number | boolean, source: e.source };
    }
  const wallets: AdminWallet[] = [];
  if (Array.isArray(v.wallets))
    for (const w of v.wallets) {
      if (!isObj(w) || typeof w.u !== "string" || !int(w.rank) || !int(w.cap) || typeof w.open !== "boolean") continue;
      // a person with open money never shows a balance (§5.3: no hidden game information)
      wallets.push({ u: w.u, balance: w.open ? null : int(w.balance) ? w.balance : null, rank: w.rank, cap: w.cap, open: w.open });
    }
  return { admin: v.you.admin, why, economy, wallets };
}
export function parseLog(v: unknown): LogEntry[] | null {
  if (!isObj(v) || !Array.isArray(v.entries)) return null;
  const out: LogEntry[] = [];
  for (const e of v.entries) {
    if (!isObj(e) || !int(e.id) || !int(e.at) || typeof e.by !== "string" || typeof e.action !== "string" || typeof e.who !== "string") continue;
    out.push({ id: e.id, at: e.at, by: e.by, action: e.action, who: e.who, amount: int(e.amount) ? e.amount : null, reason: typeof e.reason === "string" ? e.reason : null, count: int(e.count) ? e.count : 1 });
  }
  return out;
}
export function parseNotices(v: unknown): { items: Notice[]; more: number } {
  const items: Notice[] = [];
  if (!isObj(v) || !Array.isArray(v.items)) return { items, more: 0 };
  for (const n of v.items) {
    if (!isObj(n) || !int(n.id) || !int(n.at) || !["grant", "remove", "set", "reset", "rank"].includes(String(n.action))) continue;
    items.push({ id: n.id, at: n.at, action: n.action as AdminAction, amount: int(n.amount) ? n.amount : null, reason: typeof n.reason === "string" ? n.reason : null });
  }
  return { items, more: int(v.more) ? v.more : 0 };
}

/** The amount an action takes, and whether it's inside the bounds (null = the action takes none). */
export function amountOk(action: AdminAction, n: number | null): boolean {
  if (action === "reset") return true;
  if (n === null || !Number.isInteger(n)) return false;
  if (action === "grant" || action === "remove") return n >= 1 && n <= ADMIN_MAX_DELTA;
  if (action === "set") return n >= 0 && n <= ADMIN_MAX_SET;
  return n >= 0 && n <= ADMIN_RANK_MAX;
}
export function economyOk(k: EconomyKey, v: number | boolean): boolean {
  if (k === "side_on") return typeof v === "boolean";
  const [lo, hi] = ECONOMY_BOUNDS[k];
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}
/** The why-text (§5.4): 1–140 characters, no control characters, no links, nothing that looks like a Matrix id. */
export function reasonOk(r: string): boolean {
  if (r === "") return true;
  // eslint-disable-next-line no-control-regex
  return r.length <= 140 && !/[\u0000-\u001f\u007f]/.test(r) && !/https?:\/\/|www\./i.test(r) && !/@[^\s:]+:\S+/.test(r);
}
/** Who a named selection may be: 1–100 distinct ids, or everyone. */
export function targetsOk(who: string[] | "everyone"): boolean {
  return who === "everyone" || (who.length >= 1 && who.length <= ADMIN_MAX_TARGETS && new Set(who).size === who.length);
}

/** Split a selection by what will happen (§5.2 table): open money is fine for a grant (lands before the next hand),
 *  refused for the rest (a named list is all-or-nothing; everyone skips them). */
export function plan(action: AdminAction, chosen: AdminWallet[], everyone: boolean): { apply: AdminWallet[]; atTable: AdminWallet[]; blocked: boolean } {
  const atTable = chosen.filter((w) => w.open);
  if (action === "grant") return { apply: chosen, atTable, blocked: false };
  const apply = chosen.filter((w) => !w.open);
  return { apply, atTable, blocked: !everyone && atTable.length > 0 };
}

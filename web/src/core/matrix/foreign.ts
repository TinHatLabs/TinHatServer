// foreign.ts — rooms that live on another server (share claude/tinhat-server/MATRIX-FRONTEND-DESIGN.md B0/B1/B5, the
// must-fix round). The rules, pure. The desktop's foreign_room.rs applies the same rules and
// both replay testvectors/foreign-room.json (owned here, copied byte for byte).
//
//   serverPart(id)                 "@a:example.org" / "!x:example.org" / "#r:example.org" → "example.org"; v12 "!opaque" → ""
//   roomOrigin(create)             the m.room.create sender's server, or null
//   isManaged(create, ownServer)   may Tin Hat change this room's power levels? (create sender + every v12
//                                  additional_creators entry on my own server)
//   pickVia({target, linkVia, childVia, hints})   the servers a join asks through (never from a v12 opaque id)
//   plWritePlan({create, own, pl, types, canEdit, done})   the one power-level write ensureWritable may make (or why not)
//
// Pure (no client import: the node unit test loads it as is); the store reads are in foreignHere.ts.

const HOST = /^[A-Za-z0-9.-]+$/;
/** matrix-js-sdk sends only the first 3 `via`s; the desktop sends the same 3 */
const MAX_VIA = 3;

/** An IPv6 address as Rust's std::net::Ipv6Addr reads it (the desktop's check): 8 groups of 1–4 hex digits, one `::`
 *  standing for at least one zero group, an optional dotted IPv4 tail counting as two groups. */
export function validIpv6(a: string): boolean {
  const v4 = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
  const count = (part: string): number => {
    if (part === "") return 0;
    const gs = part.split(":");
    let n = 0;
    for (let i = 0; i < gs.length; i++) {
      if (i === gs.length - 1 && gs[i].includes(".")) {
        if (!v4.test(gs[i])) return -1;
        n += 2;
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(gs[i])) n += 1;
      else return -1;
    }
    return n;
  };
  const halves = a.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 1) return count(a) === 8;
  const [l, r] = halves;
  if (l.includes(".")) return false; // an IPv4 tail only at the very end
  const nl = count(l);
  const nr = count(r);
  return nl >= 0 && nr >= 0 && nl + nr <= 7;
}

/** A valid server name: a hostname or a bracketed IPv6 literal, an optional port 1–65535 (foreign_room.rs valid_server). */
export function validServer(s: unknown): s is string {
  if (typeof s !== "string") return false;
  let host = s;
  let port: string | undefined;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0 || !validIpv6(s.slice(1, end))) return false;
    const after = s.slice(end + 1);
    if (after !== "") {
      if (!after.startsWith(":")) return false;
      port = after.slice(1);
    }
    host = "x";
  } else {
    const i = s.indexOf(":");
    if (i >= 0) {
      host = s.slice(0, i);
      port = s.slice(i + 1);
    }
  }
  if (!HOST.test(host)) return false;
  return port === undefined || (/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
}

/** The server part of a user id, pre-v12 room id or alias (after the first `:`); "" for none or an invalid name. */
export function serverPart(id: unknown): string {
  if (typeof id !== "string") return "";
  const i = id.indexOf(":");
  if (i < 0) return "";
  const s = id.slice(i + 1);
  return validServer(s) ? s : "";
}

type CreateLike = { sender?: unknown; content?: unknown } | null | undefined;

/** Where a room is from: the m.room.create sender's server. A label only (B0 (1)): it carries no trust. */
export function roomOrigin(create: CreateLike): string | null {
  if (!create || typeof create !== "object") return null;
  const sender = create.sender;
  if (typeof sender !== "string" || !sender.startsWith("@")) return null;
  return serverPart(sender) || null;
}

/** B0 `tinhatManaged`: Tin Hat may change power levels here only when every creator is on my own server. */
export function isManaged(create: CreateLike, ownServer: string): boolean {
  if (!ownServer) return false;
  if (roomOrigin(create) !== ownServer) return false;
  const content = create && typeof create.content === "object" && create.content ? (create.content as Record<string, unknown>) : {};
  if (!Object.prototype.hasOwnProperty.call(content, "additional_creators")) return true;
  const extra = content.additional_creators;
  if (!Array.isArray(extra)) return false;
  return extra.every((u) => typeof u === "string" && u.startsWith("@") && serverPart(u) === ownServer);
}

export interface ViaInput {
  /** the room id or alias being joined */
  target: string;
  /** the link's `via=` values */
  linkVia?: unknown[];
  /** the space child's `via` (m.space.child content) */
  childVia?: unknown[];
  /** last resort: the inviter's / the child event sender's server */
  hints?: unknown[];
}

/** B1 `pickVia` (joining): link via, space-child via, the target's own server part, hints. Deduped, valid, ≤ 3. */
export function pickVia(o: ViaInput): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (out.length >= MAX_VIA || !validServer(v) || out.includes(v)) return;
    out.push(v);
  };
  for (const v of Array.isArray(o.linkVia) ? o.linkVia : []) add(v);
  for (const v of Array.isArray(o.childVia) ? o.childVia : []) add(v);
  add(serverPart(o.target));
  for (const v of Array.isArray(o.hints) ? o.hints : []) add(v);
  return out;
}

/** The types ensureWritable may ever lower: Tin Hat's own state and call membership — never a Matrix type. */
export function lowerable(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("dev.tinhat.") || type === "org.matrix.msc3401.call.member" || type === "m.call.member");
}

/** A power level as the room holds it: a number, or (older room versions) an integer string like "50" / "-10". */
export function level(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^[+-]?[0-9]+$/.test(v)) return Number(v); // no whitespace: the desktop's exact rule
  return null;
}

export interface PlanInput {
  /** the room's m.room.create event ({sender, content}), or null */
  create: CreateLike;
  /** my own server */
  own: string;
  /** the room's current m.room.power_levels content, or null */
  pl: Record<string, unknown> | null | undefined;
  /** the types a feature (or the room open) asks for */
  types: readonly unknown[];
  /** may I send m.room.power_levels here? */
  canEdit: boolean;
  /** types already lowered (or refused) in this room this session */
  done?: readonly string[];
}
export type PlanReason = "foreign" | "no-power-levels" | "nothing-to-do" | "not-allowed" | "write";
export interface Plan {
  reason: PlanReason;
  /** the types this write lowers to 0 (empty unless reason = "write") */
  types: string[];
  /** the whole new m.room.power_levels content (null unless reason = "write") */
  content: Record<string, unknown> | null;
}

/**
 * B0/B5 rule 1 as one pure decision (ensureWritable's; appstate.rs pl_write_plan is the same): a room on another
 * server never gets a write; else lower each allowed, not-yet-done type whose effective level (events[t], else
 * state_default, else 50) is above 0 — a level at or below 0 is left as it is.
 */
export function plWritePlan(o: PlanInput): Plan {
  const none = (reason: PlanReason): Plan => ({ reason, types: [], content: null });
  if (!isManaged(o.create, o.own)) return none("foreign");
  const pl = o.pl && typeof o.pl === "object" && !Array.isArray(o.pl) ? o.pl : null;
  if (!pl) return none("no-power-levels");
  const events = (pl.events && typeof pl.events === "object" && !Array.isArray(pl.events) ? pl.events : {}) as Record<string, unknown>;
  const sd = level(pl.state_default) ?? 50;
  const done = new Set(o.done ?? []);
  const types: string[] = [];
  for (const t of Array.isArray(o.types) ? o.types : []) {
    if (!lowerable(t) || done.has(t as string) || types.includes(t as string)) continue;
    if ((level(events[t as string]) ?? sd) > 0) types.push(t as string);
  }
  if (types.length === 0) return none("nothing-to-do");
  if (!o.canEdit) return none("not-allowed");
  const nextEvents: Record<string, unknown> = { ...events };
  for (const t of types) nextEvents[t] = 0;
  return { reason: "write", types, content: { ...pl, events: nextEvents } };
}

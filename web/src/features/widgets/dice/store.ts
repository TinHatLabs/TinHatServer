// dice/store.ts — the Dice roller's device side (contract WIDGETS.md §16): rolling with the browser's CSPRNG
// (crypto.getRandomValues — every die by rejection sampling through the shared dieFromU32, so every face is exactly as
// likely), sending a roll into the open room (the shared diceContent: m.notice + HTML + `dev.tinhat.dice`; js-sdk
// encrypts it in an encrypted room and shows the local echo at once), and the private rolls — this device only, never
// sent anywhere — in localStorage `tinhat.user.dice` = {me, list} (an account-scoped key: signing out removes it;
// another account's list is ignored and replaced; shared normalizePrivate / addPrivate). Rolls are made on the roller's
// device: an honour system, like dice on a real table (the receiver re-adds the numbers, it can't re-roll them).
import { useSyncExternalStore } from "react";
import { peekClient } from "@/core/matrix";
import {
  addPrivate,
  diceContent,
  dieFromU32,
  evaluateDice,
  normalizePrivate,
  parseDice,
  type DiceResult,
  type PrivateRoll,
} from "@/widgets/dice";

export const DICE_KEY = "tinhat.user.dice";

let me = "";
let list: PrivateRoll[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

function read(): void {
  let v: unknown = null;
  try {
    v = JSON.parse(localStorage.getItem(DICE_KEY) ?? "null");
  } catch {
    v = null;
  }
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as { me?: unknown; list?: unknown }) : null;
  list = o && o.me === me ? normalizePrivate(o.list) : [];
}

function save(): void {
  try {
    localStorage.setItem(DICE_KEY, JSON.stringify({ me, list }));
  } catch {
    /* storage full / blocked: the list lives for this page */
  }
}

function ensure(): void {
  const id = peekClient()?.getUserId() ?? "";
  if (id === me) return;
  me = id;
  read();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
function getList(): PrivateRoll[] {
  ensure();
  return list;
}

/** React: this device's private rolls (newest first), live. */
export function usePrivateRolls(): PrivateRoll[] {
  return useSyncExternalStore(subscribe, getList, getList);
}

/** "Clear private rolls". */
export function clearPrivateRolls(): void {
  ensure();
  if (!me || !list.length) return;
  list = [];
  save();
  emit();
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === DICE_KEY && me) {
      read();
      emit();
    }
  });

// ---- the roll I just made (the card's one landing) -----------------------------------------------------------------

export interface JustRolled {
  /** a fresh token per click: the card lands once per token */
  key: number;
  expr: string;
  rolls: number[];
  at: number;
}
let just: JustRolled | null = null;
let seq = 0;
const justListeners = new Set<() => void>();
export function useJustRolled(): JustRolled | null {
  return useSyncExternalStore(
    (cb) => {
      justListeners.add(cb);
      return () => void justListeners.delete(cb);
    },
    () => just,
    () => just,
  );
}

// ---- rolling ---------------------------------------------------------------------------------------------------------

/** One uniformly random 32-bit word from the browser's CSPRNG. */
function word(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

/** Roll `expr` on this device: the shared parser, then each die from CSPRNG words (rejection sampling). */
export function rollDice(expr: string): { ok: true; result: DiceResult } | { ok: false; message: string } {
  const p = parseDice(expr);
  if (!p.ok) return { ok: false, message: p.message };
  const raw: number[] = [];
  for (const t of p.terms) {
    if (t.kind !== "dice") continue;
    for (let d = 0; d < t.count; d++) {
      let v: number | null = null;
      while (v === null) v = dieFromU32(word(), t.sides);
      raw.push(v);
    }
  }
  return { ok: true, result: evaluateDice(p, raw)! };
}

/** May I send messages (m.room.message) in this room? */
export function canRollIn(roomId: string): boolean {
  const c = peekClient();
  const room = roomId ? c?.getRoom(roomId) : null;
  if (!c || !room || room.getMyMembership() !== "join") return false;
  return room.currentState.maySendMessage(c.getUserId() ?? "");
}

export type RollTarget = { room: string } | { private: true };

/**
 * Roll `expr` and put it where it goes: into the room (the message; js-sdk's local echo shows it at once, a failure
 * stays as the chat's own "Not sent" row with Retry) or into this device's private list. Returns the error text of an
 * expression that doesn't parse ("" = rolled).
 */
export function rollTo(expr: string, target: RollTarget): string {
  const r = rollDice(expr);
  if (!r.ok) return r.message;
  just = { key: ++seq, expr: r.result.expr, rolls: [...r.result.rolls], at: Date.now() };
  for (const l of [...justListeners]) l();
  if ("room" in target) {
    const c = peekClient();
    if (!c) return "Not signed in";
    c.sendMessage(target.room, diceContent(r.result) as never).catch(() => {
      /* the chat shows the failed row (Retry / Delete) */
    });
    return "";
  }
  ensure();
  if (!me) return "Not signed in";
  const roll: PrivateRoll = { id: `p-${Date.now().toString(36)}-${word().toString(36)}`, ts: Date.now(), expr: r.result.expr, rolls: [...r.result.rolls], total: r.result.total };
  list = addPrivate(list, roll);
  save();
  emit();
  return "";
}

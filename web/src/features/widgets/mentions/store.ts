// mentions/store.ts — this device's Mentions list (contract WIDGETS.md §13): the ids of the recent events the push rules
// highlighted — never their text — in localStorage `tinhat.user.mentions` = {me, list} (an account-scoped key: signing
// out removes it; another account's list is ignored and replaced). Every change goes through the shared rules
// (src/widgets/mentions.ts: normalize, add, mark seen). React reads it with useMentions(); another tab's change follows
// through the storage event.
import { useSyncExternalStore } from "react";
import { addMention, markSeen, normalizeMentions, type Mention } from "@/widgets/mentions";

export const MENTIONS_KEY = "tinhat.user.mentions";

let me = "";
let list: Mention[] = [];
let existed = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

function read(): void {
  let v: unknown = null;
  try {
    v = JSON.parse(localStorage.getItem(MENTIONS_KEY) ?? "null");
  } catch {
    v = null;
  }
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as { me?: unknown; list?: unknown }) : null;
  existed = !!o && o.me === me;
  list = existed ? normalizeMentions(o!.list) : [];
}

function save(): void {
  try {
    localStorage.setItem(MENTIONS_KEY, JSON.stringify({ me, list }));
  } catch {
    /* storage full / blocked: the list lives for this page */
  }
}

/** Load the list of `userId` (at session start). */
export function loadMentions(userId: string): void {
  me = userId;
  read();
  emit();
}

/** A list for this account already existed on this device (else the first sync's highlights arrive seen). */
export function hadMentions(): boolean {
  return existed;
}

/** The first sync of a device is in: write the list (even empty), so the next start knows new from old. */
export function settleMentions(): void {
  if (!me || existed) return;
  existed = true;
  save();
}

export function recordMention(m: Mention): void {
  if (!me) return;
  const next = addMention(list, m);
  if (JSON.stringify(next) === JSON.stringify(list)) return;
  list = next;
  existed = true;
  save();
  emit();
}

/** Mark seen: one event (`e`), a room's entries up to a time (`r`, `upTo`), or everything ({}). */
export function markMentionsSeen(sel: { e?: string; r?: string; upTo?: number }): void {
  if (!me) return;
  const next = markSeen(list, sel);
  if (JSON.stringify(next) === JSON.stringify(list)) return;
  list = next;
  save();
  emit();
}

export function getMentions(): Mention[] {
  return list;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** React: the list (newest first), live. */
export function useMentions(): Mention[] {
  return useSyncExternalStore(subscribe, getMentions, getMentions);
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === MENTIONS_KEY && me) {
      read();
      emit();
    }
  });

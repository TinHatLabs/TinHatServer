// store.ts — the guest room's API side (docs/GUESTS.md "The server's API"; the rules: ./model.ts). The doc (GET
// /api/guests: the room, the link, this user's roles) is read when the app is ready, when Settings → Guests or the
// Guests room's bar shows, when the room's on/off state changes, and after every action of ours — never on a timer:
// on/off and who waits come through sync (the room state the server keeps). Self-hosted builds only (features/guests).
import { create } from "zustand";
import { ApiError, apiJson } from "@/core/api";
import { openRoom, toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import { onClientChanged, peekClient } from "@/core/matrix";
import { serverFeatureOn, useServerFeature } from "@/core/server";
import { copyText } from "@/features/nav/actions";
import { parseDoc, type GuestsDoc, type Waiter } from "./model";

const log = createLogger("guests");

/** a doc younger than this is fresh enough to copy its link at once (a new link writes no room state) */
const FRESH_MS = 30_000;

export interface GuestsStore {
  doc: GuestsDoc | null;
  /** the first answer (or failure) is in */
  loaded: boolean;
  /** when the doc was read (ms) */
  at: number;
  /** why there is no doc (the server's words, or ours) */
  error: string;
  /** a turn on / off / new link is on its way */
  busy: boolean;
  /** waiting ids whose Let in / Turn away is on its way */
  pending: string[];
}

const EMPTY: GuestsStore = { doc: null, loaded: false, at: 0, error: "", busy: false, pending: [] };
export const useGuests = create<GuestsStore>()(() => ({ ...EMPTY }));
const set = (p: Partial<GuestsStore>) => useGuests.setState(p);

/** The guest room is part of this app: the server doesn't say `guests: false`. */
export function guestRoomOffered(): boolean {
  return serverFeatureOn("guests");
}
export function useGuestRoomOffered(): boolean {
  return useServerFeature("guests");
}

// a sign-out / account switch: forget the doc, and drop answers that arrive for the old session
let gen = 0;
let inflight: Promise<void> | null = null;
onClientChanged(() => {
  gen++;
  inflight = null;
  useGuests.setState({ ...EMPTY }, true);
});

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This server doesn't have the guest room yet.";
    if (e.status === 0) return "Couldn't reach the server — try again in a moment.";
    return e.message;
  }
  return (e as Error)?.message ?? String(e);
}

/** Read the doc again (one request at a time). */
export function refreshGuests(): Promise<void> {
  if (!guestRoomOffered() || !peekClient()) return Promise.resolve();
  if (inflight) return inflight;
  const g = gen;
  const read = async () => {
    try {
      const v = await apiJson<unknown>("/guests", { auth: true });
      if (g !== gen) return;
      const doc = parseDoc(v);
      set({ doc, loaded: true, at: Date.now(), error: doc ? "" : "The server sent something unexpected." });
    } catch (e) {
      if (g !== gen) return;
      log.info(`GET /guests: ${errorText(e)}`);
      set({ loaded: true, error: errorText(e) });
    }
  };
  const p: Promise<void> = read().finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

// ---- manage: turn on / off, new link ------------------------------------------------------------------------------

const MANAGE_DONE = {
  on: "The guest room is on — copy the guest link to send it to someone",
  off: "The guest room is off — whoever waited was turned away and the guests are gone",
  link: "New guest link — the old one stopped working",
} as const;
const MANAGE_FAIL = { on: "Couldn't turn the guest room on", off: "Couldn't turn the guest room off", link: "Couldn't make a new link" } as const;

async function manage(what: "on" | "off" | "link"): Promise<void> {
  if (useGuests.getState().busy) return;
  const g = gen;
  set({ busy: true });
  try {
    const v = await apiJson<unknown>(`/guests/${what}`, { method: "POST", auth: true, json: {}, timeoutMs: 20_000 });
    if (g !== gen) return;
    const doc = parseDoc(v);
    if (doc) set({ doc, loaded: true, at: Date.now(), error: "" });
    toast(MANAGE_DONE[what], { kind: "success", timeoutMs: 5000 });
  } catch (e) {
    if (g === gen) toast(`${MANAGE_FAIL[what]}: ${errorText(e)}`, { kind: "error", timeoutMs: 6000 });
  } finally {
    if (g === gen) set({ busy: false });
  }
}

export const turnGuestRoomOn = () => manage("on");
export const turnGuestRoomOff = () => manage("off");
export const newGuestLink = () => manage("link");

// ---- admit: let in / turn away ------------------------------------------------------------------------------------

async function decide(what: "admit" | "turn-away", w: Waiter): Promise<void> {
  if (useGuests.getState().pending.includes(w.id)) return;
  const g = gen;
  set({ pending: [...useGuests.getState().pending, w.id] });
  try {
    await apiJson<unknown>(`/guests/${what}`, { method: "POST", auth: true, json: { id: w.id }, timeoutMs: 20_000 });
    if (g === gen) toast(what === "admit" ? `${w.name} is coming in` : `${w.name} was turned away`, { timeoutMs: 4000 });
  } catch (e) {
    if (g === gen) toast(`${what === "admit" ? `Couldn't let ${w.name} in` : `Couldn't turn ${w.name} away`}: ${errorText(e)}`, { kind: "error", timeoutMs: 6000 });
  } finally {
    if (g === gen) set({ pending: useGuests.getState().pending.filter((x) => x !== w.id) });
  }
}

export const letGuestIn = (w: Waiter) => decide("admit", w);
export const turnGuestAway = (w: Waiter) => decide("turn-away", w);

// ---- the link, the room -------------------------------------------------------------------------------------------

/** Copy the guest link: the doc's when it is fresh (the clipboard wants the click's moment), else ask the server first
 *  — someone may have made a new link, which shows in no room state. */
export async function copyGuestLink(): Promise<void> {
  const st = useGuests.getState();
  if (!st.doc?.link || Date.now() - st.at > FRESH_MS) await refreshGuests();
  const now = useGuests.getState();
  const link = now.doc?.link;
  if (!link) {
    toast(now.error || (now.doc && !now.doc.on ? "The guest room is off — there's no guest link right now." : "There's no guest link for you to copy."), { timeoutMs: 5000 });
    return;
  }
  if (await copyText(link)) toast("Guest link copied — whoever opens it waits at the door until someone lets them in", { timeoutMs: 5000 });
  else toast("Couldn't copy — the guest link is shown in Settings → Guests", { kind: "error", timeoutMs: 6000 });
}

/** Open the Guests room — joining it first when this user isn't in it yet (its join rule is public). */
export async function openGuestsRoom(): Promise<boolean> {
  const room = useGuests.getState().doc?.room;
  const c = peekClient();
  if (!room || !c) return false;
  if (c.getRoom(room)?.getMyMembership() !== "join") {
    try {
      await c.joinRoom(room);
    } catch (e) {
      toast(`Couldn't open the Guests room: ${(e as { data?: { error?: string } })?.data?.error ?? errorText(e)}`, { kind: "error", timeoutMs: 6000 });
      return false;
    }
    void refreshGuests();
  }
  openRoom(room);
  return true;
}

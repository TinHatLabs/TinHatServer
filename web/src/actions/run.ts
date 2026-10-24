// run.ts — running an action from any surface (ACTIONS.md §14.1): a row button, the Ctrl+K palette, a host. One path
// for all of them, so the rules are the same everywhere:
//   1. present the action against the live snapshot (snapshot.ts): not visible / not enabled → nothing runs;
//   2. it picks (no stored target, absent = pick) → the palette opens at stage 2 for it (§10.6);
//   3. it confirms → the confirm dialog (ACTIONS.md §7.4; the text comes from the table) — cancelled → nothing runs;
//   4. the handler registered for the id runs with the resolved subject and params.
// Handlers are registered by exec.ts (the id → command map). No handler → nothing runs (logged once): an action the
// table lists for the web must have one (actions.test.ts checks the map covers every web action).
import type { JObj } from "../layout/json";
import { clone } from "../layout/json";
import type { ConfirmOut } from "./evaluate";
import { present } from "./evaluate";
import { choiceEntries } from "./palette";
import { actionById } from "./table";
import { getActionsSnapshot } from "./snapshot";

export type RunSource = "button" | "menu" | "key" | "palette" | "host";

/** How an action is being run. */
export interface Invocation {
  source: RunSource;
  /** the row item's / palette choice's target (normalized or not: it is validated again) */
  target?: JObj | null;
  /** the subjects the surface supplies (a composer's room, the call's room, a message …) */
  context?: JObj | null;
  /** invocation params (a host's) */
  params?: JObj | null;
  /** the element the button is (menus and popovers anchor to it); null from the palette or a key */
  anchor?: HTMLElement | null;
  /** a hold action's press ("down") or release ("up") — push to talk from a button */
  hold?: "down" | "up";
  /** the surface's own command for a context-only action (a composer's Send, a message's Reply); wins over the map */
  handler?: Handler;
}

/** What a handler gets: the invocation plus the resolved subject and params. */
export interface RunCtx extends Invocation {
  id: string;
  /** the resolved subject id of the action's target kind (a room id, a user id, a theme id …), or null */
  subject: string | null;
  /** the resolved params (a listed value such as a rail entry or a status preset, enum choices, texts) */
  params: JObj;
}
export type Handler = (ctx: RunCtx) => void | Promise<void>;
export type RunResult = "ran" | "unavailable" | "picked" | "cancelled" | "unhandled" | "failed";

const handlers = new Map<string, Handler>();
const missing = new Set<string>();

/** Register the command of an action id (exec.ts). Returns a remover. An id the table does not have is a bug. */
export function registerActionHandler(id: string, fn: Handler): () => void {
  if (!actionById(id)) throw new Error(`actions: no action ${id} in actions.json`);
  handlers.set(id, fn);
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id);
  };
}

export function hasActionHandler(id: string): boolean {
  return handlers.has(id);
}

// ---- hosts the run path needs (installed by the UI: ui/ConfirmHost.tsx, the palette) ----------------------------------
type ConfirmHost = (c: ConfirmOut) => Promise<boolean>;
type PickHost = (actionId: string) => void;
let confirmHost: ConfirmHost | null = null;
let pickHost: PickHost | null = null;
/** The confirm dialog (§7.4). */
export function setConfirmHost(fn: ConfirmHost | null): void {
  confirmHost = fn;
}
/** Stage 2 of the palette for an action that picks (§10.6). */
export function setPickHost(fn: PickHost | null): void {
  pickHost = fn;
}

/** Present + run (see the file comment). Never throws. */
export async function runAction(id: string, inv: Invocation): Promise<RunResult> {
  const p = present({
    app: "web",
    action: id,
    snapshot: getActionsSnapshot(),
    target: inv.target ?? undefined,
    context: inv.context ?? undefined,
    params: inv.params ?? undefined,
    transient: inv.source === "palette",
  });
  if (!p.visible || !p.enabled) return "unavailable";
  // it picks: the palette's stage 2 when the palette can list its choices, else the handler with no subject opens the
  // app's own picker (the hidden streams menu, the status popover …) — ACTIONS.md §14.1
  if (p.pick && pickHost && choiceEntries("web", getActionsSnapshot(), id) !== null) {
    pickHost(id);
    return "picked";
  }
  if (p.confirm) {
    if (!confirmHost) return "cancelled";
    const ok = await confirmHost(p.confirm);
    if (!ok) return "cancelled";
  }
  const fn = inv.handler ?? handlers.get(id);
  if (!fn) {
    if (!missing.has(id)) {
      missing.add(id);
      console.warn(`[actions] no handler for ${id}`);
    }
    return "unhandled";
  }
  try {
    await fn({ ...inv, id, subject: p.subject, params: clone(p.params) as JObj });
    return "ran";
  } catch (e) {
    console.error(`[actions] ${id} failed`, e);
    return "failed";
  }
}

/** The web actions without a registered handler (the coverage test). */
export function unhandledActions(ids: string[]): string[] {
  return ids.filter((id) => !handlers.has(id));
}

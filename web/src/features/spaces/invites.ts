// invites.ts — invite codes for server operators (native invites.rs + the Main.qml helpers
// inviteSummary / inviteBlip / inviteMessage). Talks to the server's Tin Hat API `/api/admin/invites` (same origin,
// bearer = the caller's Matrix token, 12 s timeout — core apiJson).
//
//   useInviteCodes() → {isOperator, probed, busy, invites, server, create, revoke, refresh}
//   probeInvites()   once after sign-in (quiet: 401/403 = not an operator, anything else logged)
//   resetInvites()   on sign-out
// Every failure other than the quiet probe toasts (6 s); 401/403 → "Only a server admin can manage
// invite codes", the operator flag drops and the list clears. Success notes toast 4 s.
//
// NOTE (DECISIONS D18): the Settings → Invites pane belongs to features/settings. This module is
// the data layer + a ready pane (InvitesPane.tsx) integration can mount if settings uses it.
import { create } from "zustand";
import { ApiError, apiJson } from "@/core/api";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import type { Invite } from "./invitesModel";
export { formatMonthDay, inviteBlip, inviteMessage, inviteSummary, type Invite } from "./invitesModel";

const log = createLogger("spaces.invites");


interface ListResp {
  invites?: Invite[];
  server?: string;
  now?: number;
}

export interface InviteState {
  isOperator: boolean;
  probed: boolean;
  busy: boolean;
  invites: Invite[];
  server: string;
}

const INITIAL: InviteState = { isOperator: false, probed: false, busy: false, invites: [], server: "" };
export const useInviteStore = create<InviteState>()(() => ({ ...INITIAL }));
const set = useInviteStore.setState;
const get = useInviteStore.getState;

const DENIED = "Only a server admin can manage invite codes";

// ---- API ---------------------------------------------------------------------------------------------------

function isDenied(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

function fail(e: unknown) {
  if (isDenied(e)) {
    set({ isOperator: false, invites: [] });
    toast(DENIED, { kind: "error", timeoutMs: 6000 });
    return;
  }
  const msg = e instanceof ApiError ? e.message : `Couldn't reach the server: ${(e as Error)?.message ?? e}`;
  log.warn(msg);
  toast(msg, { kind: "error", timeoutMs: 6000 });
}

async function load(): Promise<void> {
  const r = await apiJson<ListResp>("/admin/invites");
  set({ isOperator: true, invites: Array.isArray(r?.invites) ? r.invites : [], server: typeof r?.server === "string" ? r.server : "" });
}

/** Quiet operator probe after sign-in (invites.rs probe). */
export async function probeInvites(): Promise<void> {
  if (get().busy) return;
  set({ busy: true });
  try {
    await load();
  } catch (e) {
    if (isDenied(e)) set({ isOperator: false, invites: [] });
    else log.info(`invite probe: ${(e as Error)?.message ?? e}`);
  } finally {
    set({ busy: false, probed: true });
  }
}

export function resetInvites() {
  set({ ...INITIAL });
}

export async function refreshInvites(): Promise<void> {
  if (get().busy) return;
  set({ busy: true });
  try {
    await load();
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: false });
  }
}

/** uses ∈ {1,5,10,0}, days ∈ {7,30,90,0} (0 = unlimited / never). */
export async function createInvite(uses: number, days: number): Promise<void> {
  if (get().busy) return;
  set({ busy: true });
  try {
    const u = Math.max(0, Math.min(1000, Math.floor(uses)));
    const d = Math.max(0, Math.min(3650, Math.floor(days)));
    const r = await apiJson<{ invite?: Invite }>("/admin/invites", { method: "POST", json: { uses: u, days: d } });
    await load();
    if (r?.invite?.code) toast(`Invite ${r.invite.code} created`, { kind: "success", timeoutMs: 4000 });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: false });
  }
}

export async function revokeInvite(code: string): Promise<void> {
  if (get().busy || !/^[A-Za-z0-9._~-]+$/.test(code)) return;
  set({ busy: true });
  try {
    try {
      await apiJson(`/admin/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone = done
    }
    await load();
    toast(`Revoked ${code}`, { kind: "success", timeoutMs: 4000 });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: false });
  }
}

/** React: the invite-code store + actions. */
export function useInviteCodes() {
  const st = useInviteStore();
  return { ...st, create: createInvite, revoke: revokeInvite, refresh: refreshInvites };
}

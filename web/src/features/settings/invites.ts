// invites.ts — InvitesController (invites.rs) on the server's Tin Hat API (/api/admin/invites, D18).
// Operator probe once per sign-in (200 → operator; 401/403 → not; network errors quiet), one busy
// flag for every action, reset on sign-out. `?mockinvites=1` swaps in an in-memory server so the
// pane can be exercised without making a test account an operator.
import { webAppUrl } from "@/core/api";
import { create } from "zustand";
import { apiFetch, ApiError } from "@/core/api";
import { SERVER_LABEL } from "@/core/bearer";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";

const log = createLogger("invites");

export interface Invite {
  code: string;
  usesAllowed: number | null;
  pending: number;
  completed: number;
  expiresAt: number | null;
  active: boolean;
}

interface InvitesState {
  operator: boolean;
  probed: boolean;
  busy: boolean;
  invites: Invite[];
  server: string;
}

export const useInvites = create<InvitesState>()(() => ({ operator: false, probed: false, busy: false, invites: [], server: "" }));
const set = (p: Partial<InvitesState>) => useInvites.setState(p);

export function resetInvites(): void {
  useInvites.setState({ operator: false, probed: false, busy: false, invites: [], server: "" }, true);
}

// ---- transport (real or mock) -----------------------------------------------------------------

const mock = (() => {
  try {
    return /[?&]mockinvites=1\b/.test(location.search + location.hash);
  } catch {
    return false;
  }
})();

const mockDb: Invite[] = [];
function mockCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
  return `TH-${pick()}-${pick()}`;
}
if (mock) {
  const now = Date.now();
  mockDb.push(
    { code: "TH-UD4D-7G3Q", usesAllowed: 1, pending: 0, completed: 0, expiresAt: now + 7 * 864e5, active: true },
    { code: "TH-K2PA-9XWM", usesAllowed: 5, pending: 1, completed: 2, expiresAt: null, active: true },
    { code: "TH-QQ7R-B3NE", usesAllowed: 1, pending: 0, completed: 1, expiresAt: now - 3 * 864e5, active: false },
  );
}

async function call(method: "GET" | "POST" | "DELETE", path: string, json?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (mock) {
    await new Promise((r) => setTimeout(r, 250));
    if (method === "GET") return { status: 200, body: { invites: mockDb.map((x) => ({ ...x })), server: SERVER_LABEL, now: Date.now() } };
    if (method === "POST") {
      const { uses, days } = json as { uses: number; days: number };
      const inv: Invite = { code: mockCode(), usesAllowed: uses || null, pending: 0, completed: 0, expiresAt: days ? Date.now() + days * 864e5 : null, active: true };
      mockDb.unshift(inv);
      return { status: 200, body: { invite: inv } };
    }
    const code = decodeURIComponent(path.split("/").pop() ?? "");
    const i = mockDb.findIndex((x) => x.code === code);
    if (i < 0) return { status: 404, body: { error: "not found" } };
    if (mockDb[i].active) mockDb[i] = { ...mockDb[i], active: false };
    else mockDb.splice(i, 1);
    return { status: 200, body: { ok: true } };
  }
  const r = await apiFetch(path, { method, json, auth: true, timeoutMs: 12000 });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body };
}

function failToast(e: unknown) {
  const msg =
    e instanceof ApiError
      ? e.message || `The server said ${e.status}`
      : (e as Error)?.name === "AbortError" || /timeout|timed out/i.test(String((e as Error)?.message))
        ? "The server didn't answer in time"
        : `Couldn't reach the server: ${(e as Error)?.message ?? e}`;
  toast(msg, { timeoutMs: 6000 });
}

function lostOperator() {
  set({ operator: false });
  toast("Only a server admin can manage invite codes");
}

async function load(): Promise<void> {
  const r = await call("GET", "/admin/invites");
  if (r.status === 401 || r.status === 403) {
    lostOperator();
    return;
  }
  if (r.status !== 200) throw new ApiError(String(r.body.error ?? `The server said ${r.status}`), r.status, r.body);
  set({ invites: (r.body.invites as Invite[]) ?? [], server: String(r.body.server ?? "") });
}

/** Probe once per sign-in (quiet on network errors, 401/403 = not an operator). */
export async function probeOperator(): Promise<void> {
  if (useInvites.getState().probed) return;
  try {
    const r = await call("GET", "/admin/invites");
    const op = r.status === 200;
    set({ probed: true, operator: op });
    if (op) set({ invites: (r.body.invites as Invite[]) ?? [], server: String(r.body.server ?? "") });
  } catch (e) {
    log.debug("operator probe failed", e);
    set({ probed: true });
  }
}

async function withBusy(fn: () => Promise<void>) {
  if (useInvites.getState().busy) return;
  set({ busy: true });
  try {
    await fn();
  } catch (e) {
    failToast(e);
  } finally {
    set({ busy: false });
  }
}

export const refreshInvites = () => withBusy(load);

export function createInvite(uses: number, days: number): Promise<void> {
  return withBusy(async () => {
    const r = await call("POST", "/admin/invites", { uses: Math.max(0, Math.min(1000, uses)), days: Math.max(0, Math.min(3650, days)) });
    if (r.status === 401 || r.status === 403) return lostOperator();
    if (r.status !== 200) throw new ApiError(String(r.body.error ?? `The server said ${r.status}`), r.status, r.body);
    const code = String((r.body.invite as Invite | undefined)?.code ?? "");
    await load();
    toast(`Invite ${code} created`);
  });
}

export function revokeInvite(code: string): Promise<void> {
  if (!/^[A-Za-z0-9._~-]+$/.test(code)) return Promise.resolve();
  return withBusy(async () => {
    const r = await call("DELETE", `/admin/invites/${encodeURIComponent(code)}`);
    if (r.status === 401 || r.status === 403) return lostOperator();
    if (r.status !== 200 && r.status !== 404) throw new ApiError(String(r.body.error ?? `The server said ${r.status}`), r.status, r.body);
    await load();
    toast(`Revoked ${code}`);
  });
}

// ---- formatting (Main.qml inviteBlip / inviteSummary / inviteMessage) -------------------------

export function inviteBlip(code: string): string {
  return String(code).replace(/^TH-/i, "");
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function inviteSummary(inv: Invite, now = Date.now()): string {
  const parts: string[] = [];
  parts.push(inv.usesAllowed === null || inv.usesAllowed === 0 ? "unlimited uses" : `${inv.completed} of ${inv.usesAllowed} used`);
  if (inv.pending > 0) parts.push(`+ ${inv.pending} signing up`);
  if (inv.expiresAt === null) parts.push("never expires");
  else {
    const d = new Date(inv.expiresAt);
    parts.push(`${inv.expiresAt < now ? "expired" : "expires"} ${MON[d.getMonth()]} ${d.getDate()}`);
  }
  if (!inv.active) parts.push("no longer works");
  return parts.join(" · ");
}

/** The ready-to-paste instructions — the same shape as spaces/invitesModel.ts inviteMessage without a download site
 *  (docs/SELFHOST.md): a Tin Hat Server's leads with its own web address. */
export function inviteMessage(inv: Invite, server: string): string {
  const srv = server || SERVER_LABEL;
  const until = inv.expiresAt !== null ? (() => {
    const d = new Date(inv.expiresAt!);
    return ` It's good until ${MONTH[d.getMonth()]} ${d.getDate()}.`;
  })() : "";
  const webUrl = webAppUrl();
  const steps = `1. Open ${webUrl} in your browser (or install the Tin Hat app).\n` + `2. Pick "Create an account" under the sign-in button.\n`;
  return `You're invited to ${srv} on Tin Hat.\n` + steps + `3. Server: ${srv} — invite code: ${inviteBlip(inv.code)}.${until}`;
}

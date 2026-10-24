// update.ts — the web's updater state for the ☰ update row and the About/What's-new surfaces
// (spec §5: poll ./version.json every 30 min and on focus; newer build → "Reload to update…").
// `version.json` = { version, build, notes } written by the deploy script (D16). The first answer
// is the running build's baseline; a later, different `build` means a newer deploy is live.
import { create } from "zustand";
import { toast } from "@/core/bus";

export interface UpdateState {
  available: boolean;
  current: string;
  next: string;
  notes: string;
  checking: boolean;
  /** last successful check (ms) */
  checkedAt: number;
}

export const useUpdate = create<UpdateState>()(() => ({ available: false, current: "", next: "", notes: "", checking: false, checkedAt: 0 }));
export const updateState = () => useUpdate.getState();

/** The running bundle's build id (the deploy sets VITE_BUILD_HASH to what it writes into version.json's
 *  `build`); without it the first answer is the baseline. */
const RUNNING_BUILD = (import.meta.env.VITE_BUILD_HASH as string | undefined) ?? "";
const RUNNING_VERSION = (import.meta.env.VITE_TINHAT_VERSION as string | undefined) ?? (import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev";
let baseline: string | null = null;
let inflight: Promise<void> | null = null;

async function fetchVersion(): Promise<{ version?: string; build?: string; notes?: string } | null> {
  try {
    const r = await fetch(location.pathname.replace(/[^/]*$/, "") + "version.json", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as { version?: string; build?: string; notes?: string };
  } catch {
    return null;
  }
}

export function checkForUpdates(manual = false): Promise<void> {
  // one check at a time (startup, focus and the ☰ row can overlap); a manual one still toasts
  if (inflight) return manual ? inflight.then(() => toastResult()) : inflight;
  inflight = runCheck(manual).finally(() => (inflight = null));
  return inflight;
}

function toastResult(): void {
  const u = useUpdate.getState();
  if (u.available) toast(`Update available: v${u.current} → v${u.next}`, { timeoutMs: 4000 });
  else if (u.checkedAt) toast("You're on the newest Tin Hat Web", { timeoutMs: 4000 });
}

async function runCheck(manual: boolean): Promise<void> {
  useUpdate.setState({ checking: true });
  const v = await fetchVersion();
  useUpdate.setState({ checking: false, ...(v ? { checkedAt: Date.now() } : {}) });
  if (!v) {
    if (manual) toast("Couldn't check for updates right now", { timeoutMs: 4000 });
    return;
  }
  const id = `${v.version ?? ""}+${v.build ?? ""}`;
  if (RUNNING_BUILD) {
    // compare with what is actually running (a deploy between load and the first check still counts)
    const newer = !!v.build && v.build !== RUNNING_BUILD;
    useUpdate.setState(newer ? { available: true, next: v.version ?? "", notes: v.notes ?? "" } : { available: false, next: "", notes: "" });
    useUpdate.setState({ current: RUNNING_VERSION });
    if (manual) toastResult();
    return;
  }
  if (baseline === null) {
    baseline = id;
    useUpdate.setState({ current: v.version ?? "" });
    if (manual) toast("You're on the newest Tin Hat Web", { timeoutMs: 4000 });
    return;
  }
  if (id !== baseline) {
    useUpdate.setState({ available: true, next: v.version ?? "", notes: v.notes ?? "" });
    if (manual) toast(`Update available: v${useUpdate.getState().current} → v${v.version ?? "?"}`, { timeoutMs: 4000 });
  } else {
    // back on the running build (a rollback): nothing to offer any more
    useUpdate.setState({ available: false, next: "", notes: "" });
    if (manual) toast("You're on the newest Tin Hat Web", { timeoutMs: 4000 });
  }
}

let installed = false;
export function installUpdateWatch(): void {
  if (installed || import.meta.env.DEV) return;
  installed = true;
  void checkForUpdates();
  window.setInterval(() => void checkForUpdates(), 30 * 60 * 1000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void checkForUpdates());
}

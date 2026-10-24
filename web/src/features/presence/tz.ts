// tz.ts — REACH A7 (2026-09-28: "You can have timezone not be secret. It can be opt out."): the time zone
// Friends' clocks shows, in the global account data `dev.tinhat.presence_tz` = {share, tz, auto, v: 1}.
//
//   Opt-OUT, unlike presence: a device that finds the key absent (after the first NETWORK sync, never from a cached
//   copy) writes {share: true, tz: <this device's IANA zone>, auto: true, v: 1} itself.
//   While `auto` is true the device keeps `tz` in step with its zone: on start, and on focus / coming back to view when
//   the zone changed — at most one automatic write per device per 10 minutes, and only on a real change. Two devices
//   in two zones: the one used last wins (each writes when it is started or focused and differs).
//   A manual pick writes auto: false (it sticks); "Automatic" writes auto: true with the device's zone.
//   Off: share: false FIRST, then DELETE /api/presence?what=tz (the server drops its cached copy at once).
// The rules are pure and shared (src/widgets/clocks.ts, vectors clocks/*); the desktop's twin is presence.rs.
import { create } from "zustand";
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { apiFetch } from "@/core/api";
import { createLogger } from "@/core/log";
import { getSession, onClientChanged, peekClient, useSessionStore } from "@/core/matrix";
import { onWinState } from "@/core/winstate";
import { TZ_TYPE, readTzPref, tzAutoWrite, validZone, type TzPref } from "@/widgets/clocks";

const log = createLogger("presence-tz");

export interface TzStore {
  /** the account data is known (the first network sync is in) */
  known: boolean;
  /** the stored pref (null = absent / unreadable) */
  pref: TzPref | null;
  /** this device's zone ("" = unknown) */
  device: string;
  busy: boolean;
  error: string;
}

export const useTzStore = create<TzStore>()(() => ({ known: false, pref: null, device: deviceZone(), busy: false, error: "" }));
const patch = (p: Partial<TzStore>) => useTzStore.setState(p);

/** This device's IANA zone, or "" when the browser doesn't say (or says something the server wouldn't accept). */
export function deviceZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validZone(z) ? z : "";
  } catch {
    return "";
  }
}

/** Sharing my zone as far as this device knows (the stored pref; absent = not yet — the first run writes it). */
export function tzSharingNow(): boolean {
  return useTzStore.getState().pref?.share === true;
}

// ---- this device's last automatic write (per account, survives reloads) --------------------------------------------

const LAST_KEY = "tinhat.user.clocks";
function lastAutoAt(me: string): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as { me?: unknown; autoAt?: unknown } | null;
    return v && v.me === me && typeof v.autoAt === "number" ? v.autoAt : null;
  } catch {
    return null;
  }
}
function setLastAutoAt(me: string, at: number): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ me, autoAt: at }));
  } catch {
    /* private mode: the 10-minute gap then only holds for this page */
  }
}

// ---- reading -----------------------------------------------------------------------------------------------------

const stored = (c: MatrixClient | null): unknown => c?.getAccountData(TZ_TYPE as never)?.getContent();

function syncFromAccountData(): void {
  const c = peekClient();
  patch({ pref: readTzPref(stored(c)), device: deviceZone() });
}

// ---- writing -----------------------------------------------------------------------------------------------------

let inflight = false;

async function write(c: MatrixClient, content: TzPref): Promise<void> {
  // an unconditional PUT (like presence's consent): setAccountData() waits for the /sync echo
  await c.setAccountDataRaw(TZ_TYPE as never, content as never);
  if (peekClient() === c) patch({ pref: { ...content } });
}

/** Start / focus: the first-run write (absent → sharing on) or keeping an automatic zone in step. */
export async function tzCheck(why: string): Promise<void> {
  const c = peekClient();
  const me = c?.getUserId();
  if (!c || !me || inflight || !getSession().liveSyncDone) return;
  const dev = deviceZone();
  patch({ device: dev });
  const want = tzAutoWrite(stored(c), dev, Date.now(), lastAutoAt(me));
  if (!want) return;
  inflight = true;
  setLastAutoAt(me, Date.now());
  try {
    await write(c, want);
    log.info(`time zone written automatically (${why})`);
  } catch (e) {
    log.warn(`automatic time-zone write failed: ${(e as Error)?.message ?? e}`);
  } finally {
    inflight = false;
  }
}

async function removeFromServer(): Promise<void> {
  for (const wait of [0, 2_000, 5_000, 15_000]) {
    if (wait) await new Promise((r) => window.setTimeout(r, wait));
    try {
      const res = await apiFetch("/presence?what=tz", { method: "DELETE", auth: true, timeoutMs: 12_000 });
      if (res.status === 204 || res.ok) return;
    } catch {
      /* retried */
    }
  }
  log.warn("the time zone's DELETE never answered 204 (the server's 20 s cache still ends it)");
}

/** The switch (Settings → Privacy, the widget's "Share again"). Off: share:false first, then the DELETE. */
export async function setTzShare(on: boolean): Promise<boolean> {
  const c = peekClient();
  if (!c) return false;
  const cur = readTzPref(stored(c)) ?? useTzStore.getState().pref;
  const dev = deviceZone();
  const auto = cur ? cur.auto : true;
  const tz = auto ? dev || cur?.tz || "" : cur?.tz || dev;
  if (!validZone(tz)) {
    patch({ error: "Tin Hat can't tell this device's time zone — pick one below." });
    return false;
  }
  patch({ busy: true, error: "" });
  try {
    await write(c, { share: on, tz, auto, v: 1 });
    if (!on) void removeFromServer();
    return true;
  } catch (e) {
    patch({ error: `Couldn't save: ${(e as Error)?.message ?? e}` });
    return false;
  } finally {
    patch({ busy: false });
  }
}

/** The zone picker: "" = Automatic (this device's zone, kept in step), else a zone by hand (auto: false). */
export async function pickTz(zone: string): Promise<boolean> {
  const c = peekClient();
  if (!c) return false;
  const cur = readTzPref(stored(c)) ?? useTzStore.getState().pref;
  const auto = zone === "";
  const tz = auto ? deviceZone() : zone;
  if (!validZone(tz)) {
    patch({ error: "Tin Hat can't tell this device's time zone — pick one." });
    return false;
  }
  patch({ busy: true, error: "" });
  try {
    await write(c, { share: cur ? cur.share : true, tz, auto, v: 1 });
    if (auto) setLastAutoAt(c.getUserId() ?? "", Date.now());
    return true;
  } catch (e) {
    patch({ error: `Couldn't save: ${(e as Error)?.message ?? e}` });
    return false;
  } finally {
    patch({ busy: false });
  }
}

// ---- wiring ------------------------------------------------------------------------------------------------------

let installed = false;
let detach: (() => void) | null = null;

export function installTz(): void {
  if (installed) return;
  installed = true;
  const rebind = () => {
    detach?.();
    detach = null;
    inflight = false;
    const c = peekClient();
    useTzStore.setState({ known: false, pref: null, device: deviceZone(), busy: false, error: "" }, true);
    if (!c) return;
    const onAccount = (ev: MatrixEvent) => {
      if (ev.getType() === TZ_TYPE) patch({ pref: readTzPref(ev.getContent()) });
    };
    c.on(ClientEvent.AccountData, onAccount);
    detach = () => c.off(ClientEvent.AccountData, onAccount);
    if (getSession().liveSyncDone) {
      syncFromAccountData();
      patch({ known: true });
      void tzCheck("start");
    }
  };
  onClientChanged(rebind);
  rebind();
  // the first NETWORK sync: the account data is the server's now (never a cached copy)
  useSessionStore.subscribe((s) => {
    if (s.liveSyncDone && !useTzStore.getState().known && peekClient()) {
      syncFromAccountData();
      patch({ known: true });
      void tzCheck("start");
    }
  });
  // back in view / focused: the system zone may have changed (travel, a manual change)
  onWinState((st) => {
    if (st !== "hidden") void tzCheck("focus");
  });
}

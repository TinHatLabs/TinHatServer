// themeSync.ts — the account-data side of the theme sync (THEMES-SYNC.md §3.5, §4.6, §6): reads `dev.tinhat.theme`
// and `dev.tinhat.themes` once the first sync from the network is done and on every change, hands them to the theme
// store (ui/themeStore.ts: the pure protocol + what is shown), and PUTs what the store wants put — at once after a
// save, 0–2 s after a re-assert (a hash of the device id), retried after 1, 2, 4 … s (≤ 5 min) while signed in, and
// right away when the browser comes back online. Nothing here runs in gate mode (?themesync=0).
//
// Notices it turns into toasts (THEMES-UI.md §7, §10.6): the choice changed on another device ("Keep ‹old› here"),
// a sound-pack offer made outside the settings.
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { onClientChanged, peekClient, useSessionStore } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { showToast } from "@/ui";
import { CHOICE_TYPE, THEMES_TYPE, reassertDelayMs, retryDelayMs } from "@/theme/sync";
import {
  acceptOffer,
  attachSync,
  detachSync,
  keepOnThisDevice,
  onOffer,
  onRemoteChange,
  onWantPut,
  putDone,
  putFailed,
  receive,
  takePut,
  themeSyncEnabled,
  wantsPut,
  type Key,
} from "@/ui/themeStore";

const log = createLogger("themesync");
const TYPE: Record<Key, string> = { choice: CHOICE_TYPE, themes: THEMES_TYPE };

let installed = false;
let client: MatrixClient | null = null;
let gen = 0;
let live = false;
const timers: Record<Key, number> = { choice: 0, themes: 0 };
const inFlight: Record<Key, boolean> = { choice: false, themes: false };
const attempts: Record<Key, number> = { choice: 0, themes: 0 };

function schedule(key: Key, delayMs: number): void {
  if (!client || !live) return; // before the first live sync: the reads that follow decide (a stale cache must not win)
  window.clearTimeout(timers[key]);
  timers[key] = window.setTimeout(() => void put(key), Math.max(0, delayMs));
}

async function put(key: Key): Promise<void> {
  const c = client;
  const g = gen;
  if (!c || inFlight[key]) return;
  const doc = takePut(key);
  if (!doc) return;
  inFlight[key] = true;
  try {
    // an unconditional PUT that returns at the server's answer (presence/pref.ts): setAccountData() would wait for the
    // /sync echo and skip a write equal to its cached copy — a re-assert IS such a write
    // a plain object: the store's documents are prototype-less (own keys only, ENGINE §9), which the SDK's fetch body
    // conversion can't stringify ("Cannot convert object to primitive value")
    await c.setAccountDataRaw(TYPE[key] as never, JSON.parse(JSON.stringify(doc)) as never);
    if (g !== gen) return;
    attempts[key] = 0;
    putDone();
  } catch (e) {
    if (g !== gen) return;
    putFailed(key);
    const ms = retryDelayMs(attempts[key]++);
    log.info(`PUT ${TYPE[key]} failed (${(e as Error)?.message ?? e}) — again in ${ms / 1000} s`);
    schedule(key, ms);
  } finally {
    if (g === gen) inFlight[key] = false;
    // saved again while the PUT was on its way
    if (g === gen && wantsPut(key)) schedule(key, 0);
  }
}

function readNow(c: MatrixClient): void {
  for (const key of ["choice", "themes"] as Key[]) {
    const ev = c.getAccountData(TYPE[key] as never);
    const r = receive(key, ev ? ev.getContent() : undefined, { initial: true });
    if (r === "reassert") schedule(key, reassertDelayMs(c.getDeviceId() ?? ""));
    else if (wantsPut(key)) schedule(key, 0); // a save made before this start that never reached the server
  }
}

let detach: (() => void) | null = null;

function bind(): void {
  const c = peekClient();
  if (c === client) return;
  gen++;
  detach?.();
  detach = null;
  for (const key of ["choice", "themes"] as Key[]) {
    window.clearTimeout(timers[key]);
    inFlight[key] = false;
    attempts[key] = 0;
  }
  if (client) detachSync(); // signed out, or another account took over: that account's state is gone
  client = c;
  live = false;
  if (!c) return;
  attachSync(c.getDeviceId() ?? "");
  const onAccount = (ev: MatrixEvent) => {
    if (!live) return;
    const t = ev.getType();
    const key: Key | null = t === CHOICE_TYPE ? "choice" : t === THEMES_TYPE ? "themes" : null;
    if (!key) return;
    const r = receive(key, ev.getContent());
    if (r === "reassert") schedule(key, reassertDelayMs(c.getDeviceId() ?? ""));
  };
  c.on(ClientEvent.AccountData, onAccount);
  const myGen = gen;
  const goLive = () => {
    if (myGen !== gen || live) return;
    live = true;
    readNow(c);
  };
  if (useSessionStore.getState().liveSyncDone) goLive();
  const unsub = useSessionStore.subscribe((s) => {
    if (s.liveSyncDone) goLive();
  });
  detach = () => {
    c.off(ClientEvent.AccountData, onAccount);
    unsub();
  };
}

/** The settings feature installs it once at start. */
export function installThemeSync(): void {
  if (installed || !themeSyncEnabled()) return;
  installed = true;
  onClientChanged(bind);
  bind();
  onWantPut((key) => schedule(key, 0));
  window.addEventListener("online", () => {
    for (const key of ["choice", "themes"] as Key[]) if (wantsPut(key)) schedule(key, 0);
  });
  onRemoteChange((r) =>
    showToast(`Your theme was changed to ${r.toName} on another device.`, 8000, {
      label: `Keep ${r.fromName} here`,
      run: () => keepOnThisDevice(r.fromContent),
    }),
  );
  onOffer((o) =>
    showToast(`${o.themeName} comes with its own sounds. Use ${o.pack === "goose" ? "Goose" : "Tin Hat"} sounds too?`, 8000, {
      label: `Use ${o.pack === "goose" ? "Goose" : "Tin Hat"} sounds`,
      run: () => acceptOffer(o),
    }),
  );
}

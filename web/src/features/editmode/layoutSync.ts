// layoutSync.ts — the account-data side of the layout sync (LAYOUT.md §9.7, EDITMODE-UI §16): reads
// `dev.tinhat.layouts` once the first sync from the network is done and on every change, hands it to the device state
// (layoutDoc.ts), and PUTs what the device wants put — at once after a save, 0–2 s after a re-assert (a hash of the
// device id), retried after 1, 2, 4 … s (≤ 5 min) while signed in, and right away when the browser comes back online.
// The pattern of features/settings/themeSync.ts. Nothing here runs in gate mode (?layoutsync=0).
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { onClientChanged, peekClient, useSessionStore } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { showToast } from "@/ui";
import { reassertDelayMs, retryDelayMs } from "@/theme/sync";
import { attach, detach, layoutSyncEnabled, onWantPut, putDone, putFailed, receive, takePut, wantsPut, getRendered } from "./layoutDoc";
import { cancelEdit, useEdit } from "./store";

export const LAYOUTS_TYPE = "dev.tinhat.layouts";
const log = createLogger("layoutsync");

let installed = false;
let client: MatrixClient | null = null;
let gen = 0;
let live = false;
let timer = 0;
let inFlight = false;
let attempts = 0;

function schedule(delayMs: number): void {
  if (!client || !live) return; // before the first live sync the reads that follow decide
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void put(), Math.max(0, delayMs));
}

async function put(): Promise<void> {
  const c = client;
  const g = gen;
  if (!c || inFlight) return;
  const doc = takePut();
  if (!doc) return;
  inFlight = true;
  let failed = false;
  try {
    // an unconditional PUT that returns at the server's answer (themeSync.ts); a plain object (the engine's documents
    // are prototype-less)
    await c.setAccountDataRaw(LAYOUTS_TYPE as never, JSON.parse(JSON.stringify(doc)) as never);
    if (g !== gen) return;
    attempts = 0;
    putDone();
  } catch (e) {
    if (g !== gen) return;
    failed = true;
    putFailed();
    const ms = retryDelayMs(attempts++);
    log.info(`PUT ${LAYOUTS_TYPE} failed (${(e as Error)?.message ?? e}) — again in ${ms / 1000} s`);
    schedule(ms);
  } finally {
    if (g === gen) inFlight = false;
    // saved again while the PUT was on its way → at once; a failure keeps its backoff (scheduled above)
    if (g === gen && !failed && wantsPut()) schedule(0);
  }
}

function handle(content: unknown, c: MatrixClient): void {
  const before = getRendered();
  const r = receive(content as never);
  if (r.startsWith("lost")) {
    const ids = r.split(",").map((x) => x.replace(/^lost /, ""));
    if (ids.includes(before.id))
      showToast("Your layout change was replaced by a newer one from another device.", 8000, {
        label: "Layout settings",
        run: () => void import("@/core/bus").then((b) => b.openSettings("appearance")),
      });
  }
  if (wantsPut()) schedule(reassertDelayMs(c.getDeviceId() ?? ""));
}

function readNow(c: MatrixClient): void {
  const ev = c.getAccountData(LAYOUTS_TYPE as never);
  if (ev) handle(ev.getContent(), c);
  else if (wantsPut()) schedule(0); // a save made before this start that never reached the server
}

let unbind: (() => void) | null = null;

function bind(): void {
  const c = peekClient();
  if (c === client) return;
  gen++;
  unbind?.();
  unbind = null;
  window.clearTimeout(timer);
  inFlight = false;
  attempts = 0;
  if (client) {
    // another account (or signed out): an open edit session belongs to the old one — never save it into the new
    if (useEdit.getState().session) cancelEdit();
    detach();
  }
  client = c;
  live = false;
  if (!c) return;
  const uid = c.getUserId();
  if (!uid) return;
  attach(uid, c.getDeviceId() ?? "");
  const onAccount = (ev: MatrixEvent) => {
    if (!live || ev.getType() !== LAYOUTS_TYPE) return;
    handle(ev.getContent(), c);
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
  unbind = () => {
    c.off(ClientEvent.AccountData, onAccount);
    unsub();
  };
}

/** The edit-mode feature installs it once at start. In gate mode the device state still works (local only). */
export function installLayoutSync(): void {
  if (installed) return;
  installed = true;
  if (!layoutSyncEnabled()) {
    // gate mode: attach the device state so saves work in this page, never touch the account
    const attachLocal = () => {
      const c = peekClient();
      if (c?.getUserId()) attach(`${c.getUserId()}#gate`, c.getDeviceId() ?? "");
      else detach();
    };
    onClientChanged(attachLocal);
    attachLocal();
    return;
  }
  onClientChanged(bind);
  bind();
  onWantPut(() => schedule(0));
  window.addEventListener("online", () => {
    if (wantsPut()) schedule(0);
  });
}

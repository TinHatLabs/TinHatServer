// active.ts — REACH §3.4 + A2.12, web half: "this person is at this device right now", so the gateway can
// keep a quiet phone silent. Never shown to anyone (server memory, 35 s TTL).
//
//   own pushkey (A6)    push ON here: this device reports its own foreground — {pushkey: <own>, visible: true}
//                       every 15 s while its page is on screen and its sync is healthy, whether or not any quiet
//                       registration exists (turning on its push is the consent); {visible: false} on hide
//   user-level (A2.12)  push off here, a computer: {pushkey: null} "at a computer" pings ONLY with consent — the
//                       account has a registration with quietWhileActive (GET /api/push/quiet-wanted, checked at
//                       start, after every registration change and every 10 min; a ping's answer wanted: false
//                       revokes at once; a failed check = no consent, retried after 60 s — web review #2, parity
//                       item g) — and with its notifications on; while visible with input < 3 min, or in a call.
//                       A phone never sends user-level activity (web review #13: a phone hidden in a call is
//                       not "at a computer")
//   decision            model.ts pingKeyFor (unit-tested); machine.ts ActivitySender runs the cadence per kind
//   sessions            every answer belongs to the session (and check) that asked; sign-out stops the pings
//                       while the token still works (web review #3)
//   identity            `instance` = a random id per app start (visible:false clears only this instance)
import { ClientEvent, type MatrixClient } from "matrix-js-sdk";
import { apiFetch } from "@/core/api";
import { bus } from "@/core/bus";
import { getFormFactor, onFormFactorChange } from "@/core/device";
import { getSession, onClientChanged, onSessionEnding, peekClient } from "@/core/matrix";
import { getPref, onPrefChange } from "@/core/prefs";
import { serverFeatureOn } from "@/core/server";
import { useCallStore } from "@/features/calls";
import { ActivitySender, type Clock, type PingKind } from "@/features/presence/machine";
import { QUIET_WANTED_EVERY_MS, QUIET_WANTED_RETRY_MS, parseQuietWanted, pingBody, pingKeyFor } from "@/features/presence/model";
import { usePushStore } from "./client";

function randomInstance(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A2.12 identity: one random id per app start. */
export const INSTANCE = randomInstance();

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** Bumps on every client change and on sign-out: an answer of an older session never lands. */
let gen = 0;
let quietWanted = false;
let qwSeq = 0;
let qwRetry = 0;
let lastSyncAt = 0;

const isPhone = () => getFormFactor() === "mobile";

/** The pushkey a ping carries: this device's (push on here), null (user-level), or undefined = don't ping. */
export function pingKey(): string | null | undefined {
  const push = usePushStore.getState();
  return pingKeyFor({
    signedIn: getSession().state === "ready",
    phone: isPhone(),
    pushkey: push.phase === "on" ? push.pushkey : "",
    quietWanted,
    sinceSyncMs: lastSyncAt ? Date.now() - lastSyncAt : null,
    canNotify: getPref("desktop-notifications", "1") !== "0" && typeof Notification !== "undefined" && Notification.permission === "granted",
  });
}

/** The key the sender runs with now (its kind follows it: a string = own foreground, null = user-level). */
let curKey: string | null | undefined;

const kindNow = (): PingKind => (typeof curKey === "string" ? "foreground" : "activity");

const sender = new ActivitySender(
  clock,
  {
    active: async (visible, keepalive) => {
      // {visible: false} clears this instance's entry whatever it said before — sent without a pushkey, which the
      // server always accepts (a pushkey whose push was just switched off would be refused)
      const key = visible ? pingKey() : null;
      if (key === undefined) return;
      const myGen = gen;
      try {
        const r = await apiFetch("/push/active", { method: "POST", auth: true, json: pingBody(visible, INSTANCE, key), keepalive, timeoutMs: keepalive ? 0 : 8_000 });
        // the answer carries the consent too: a dropped quietWhileActive registration stops the pings at once
        if (r.ok && visible && myGen === gen) {
          const j = await r.json().catch(() => null);
          if (myGen === gen && j && typeof j === "object" && (j as { wanted?: unknown }).wanted === false) {
            quietWanted = false;
            reevaluate();
          }
        }
      } catch {
        /* the TTL covers a lost ping */
      }
    },
  },
  () => (isPhone() ? "phone" : "desktop"),
  kindNow,
);

/** This device told the gateway its own app is on screen (A6: the gateway holds this device's pushes then). */
export function reportsForeground(): boolean {
  return kindNow() === "foreground" && sender.reportingVisible;
}

function reevaluate(): void {
  const key = pingKey();
  if (key === undefined) {
    curKey = undefined;
    void sender.stop();
    return;
  }
  const changed = key !== curKey;
  curKey = key;
  if (!sender.isRunning) sender.start(document.visibilityState === "hidden");
  else if (changed) sender.nudge(); // push switched on/off here: the new key (and kind) at once
}

/** GET /api/push/quiet-wanted — bound to the session and to the newest check (web review #3). */
async function checkQuietWanted(): Promise<void> {
  if (getSession().state !== "ready") return;
  if (!serverFeatureOn("push")) return; // docs/SELFHOST.md: no web push on this server → no registrations, no pings
  const myGen = gen;
  const seq = ++qwSeq;
  window.clearTimeout(qwRetry);
  let wanted = false;
  let failed = false;
  try {
    const r = await apiFetch("/push/quiet-wanted", { auth: true, timeoutMs: 8_000 });
    if (r.ok) wanted = parseQuietWanted(await r.json());
    else failed = true;
  } catch {
    failed = true;
  }
  if (myGen !== gen || seq !== qwSeq) return; // an older session's / an older check's answer
  quietWanted = wanted && !failed; // parity item g: a failed check is no consent …
  if (failed) qwRetry = window.setTimeout(() => void checkQuietWanted(), QUIET_WANTED_RETRY_MS); // … retried in 60 s
  reevaluate();
}

function forget(): void {
  gen++;
  qwSeq++;
  window.clearTimeout(qwRetry);
  quietWanted = false;
  lastSyncAt = 0;
  curKey = undefined;
}

let installed = false;
export function installActivity(): void {
  if (installed) return;
  installed = true;
  const input = () => sender.input();
  for (const ev of ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"]) window.addEventListener(ev, input, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => sender.setHidden(document.visibilityState === "hidden"));
  window.addEventListener("pagehide", () => sender.setHidden(true));
  sender.setInCall(useCallStore.getState().inCall);
  useCallStore.subscribe((st) => sender.setInCall(st.inCall));

  // sync health (A2.12: < 60 s since the last good sync)
  let attached: MatrixClient | null = null;
  const onSync = (state: string) => {
    if (state === "PREPARED" || state === "SYNCING") lastSyncAt = Date.now();
  };
  const bind = () => {
    attached?.off(ClientEvent.Sync, onSync);
    attached = peekClient();
    attached?.on(ClientEvent.Sync, onSync);
    // the old session's instance entry expires by its TTL (its token is gone); nothing is sent for it now
    forget();
    void sender.stop(true);
  };
  onClientChanged(bind);
  bind();
  // sign-out: the last {visible: false} goes out while the token still works; nothing of this session after it
  onSessionEnding(async () => {
    const last = sender.stop();
    forget();
    await last;
  });

  bus.on("sessionReady", () => void checkQuietWanted());
  window.setInterval(() => void checkQuietWanted(), QUIET_WANTED_EVERY_MS);
  window.setInterval(reevaluate, 15_000); // sync health / permission drift
  usePushStore.subscribe((st, prev) => {
    // the consent can change with this device's registration (on, off, quiet saved): ask again after it landed
    if (st.phase !== prev.phase || st.regAt !== prev.regAt) void checkQuietWanted();
    if (st.phase !== prev.phase || st.pushkey !== prev.pushkey) reevaluate();
  });
  onFormFactorChange(reevaluate);
  onPrefChange("desktop-notifications", reevaluate);
}

/** QA hook. */
export function activityDebug() {
  return { instance: INSTANCE, quietWanted, key: pingKey(), running: sender.isRunning, active: sender.isActive(), foreground: reportsForeground() };
}

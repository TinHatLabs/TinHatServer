// trustGlue.ts — the page's half of "trust the phone's native device" (caps "trust"; docs/TRUST.md): when the page is
// signed in with crypto ready — on load, on the app's "tinhatnative:trust" event, and once more after this device gets
// verified when the last answer was "keys-locked" — ask the app which device waits (pending), run the rule
// (trust.ts trustDevice) with the real matrix-js-sdk 42 calls, and report (result). It never signs on any other
// trigger, and never a device pending() didn't name. Outside the apps (no "trust" cap) nothing here runs.
//
// The Devices fallback (Settings → Devices & security → a phone device's "Trust…") uses trustLookupFor() too, so the
// sheet and the bridge share every check.
import { ClientEvent, type MatrixClient } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { getCryptoStatus, onClientChanged, onCryptoStatus, peekClient, refreshCryptoStatus } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { hasNativeCap, nativeTrust } from "./bridge";
import { parsePending, parseTrustAnswer, trustDevice, TrustAttempts, type TrustLookup, type TrustResult, type TrustTrigger } from "./trust";

const log = createLogger("trust");

/** The crypto facts for `client`'s own account (matrix-js-sdk 42, rust crypto). `alive` = the session that started is
 *  still the page's (default: `client` is still the page's client, same account): a switch mid-run never signs. */
export function trustLookupFor(client: MatrixClient, alive?: () => boolean): TrustLookup {
  const me = client.getSafeUserId();
  const stillOurs = alive ?? (() => peekClient() === client && client.getUserId() === me);
  const crypto = () => {
    const c = client.getCrypto();
    if (!c) throw new Error("crypto is not ready");
    return c;
  };
  const fingerprint = async (deviceId: string): Promise<string | null> => {
    const d = (await crypto().getUserDeviceInfo([me], true)).get(me)?.get(deviceId);
    return d ? (d.getFingerprint() ?? "") : null;
  };
  return {
    ownDeviceId: () => client.getDeviceId() ?? "",
    deviceKey: fingerprint,
    nextDeviceUpdate(deviceId, ms) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          client.off(CryptoEvent.DevicesUpdated, onDevices);
          resolve();
        };
        const onDevices = (users: string[]) => {
          if (users.includes(me)) done();
        };
        const timer = setTimeout(done, ms);
        client.on(CryptoEvent.DevicesUpdated, onDevices);
        // listed already (the update landed between the two looks)
        void fingerprint(deviceId).then((k) => k !== null && done(), () => undefined);
      });
    },
    async crossSigned(deviceId) {
      return !!(await crypto().getDeviceVerificationStatus(me, deviceId))?.crossSigningVerified;
    },
    async signing() {
      const c = crypto();
      const [identity, s] = await Promise.all([c.userHasCrossSigningKeys(me, true), c.getCrossSigningStatus()]);
      return { identity, selfSigningKeyHere: !!s.privateKeysCachedLocally.selfSigningKey };
    },
    async sign(deviceId, ed25519) {
      // right at the signature: the same session, and the device the store holds under that id has exactly that key
      // (crossSignDevice takes only an id; rust crypto never swaps a known device's ed25519 key in place)
      if (!stillOurs()) throw new Error("the session changed");
      if ((await fingerprint(deviceId)) !== ed25519) throw new Error("the device's key changed");
      if (!stillOurs()) throw new Error("the session changed");
      await crypto().crossSignDevice(deviceId);
    },
  };
}

/** per account + device of this page, for the whole page lifetime (switching away and back keeps the limits) */
const attemptsBy = new Map<string, TrustAttempts>();
let running = false;
let queued: TrustTrigger | null = null;

async function run(trigger: TrustTrigger): Promise<void> {
  if (!hasNativeCap("trust")) return;
  const client = peekClient();
  const st = getCryptoStatus();
  const me = client?.getUserId();
  if (!client || !me || st.loading || !st.cryptoReady || client.isGuest()) return;
  const key = `${me}|${client.getDeviceId() ?? ""}`;
  let attempts = attemptsBy.get(key);
  if (!attempts) attemptsBy.set(key, (attempts = new TrustAttempts()));
  if (running) {
    // one kept trigger: an event / verified outranks a load
    if (queued === null || queued === "load") queued = trigger;
    return;
  }
  running = true;
  try {
    const p = parsePending(await nativeTrust.pendingRaw(me));
    if (!p || peekClient() !== client || !attempts.allow(trigger, p.deviceId)) return;
    const r: TrustResult = await trustDevice(trustLookupFor(client), p.deviceId, p.ed25519);
    if (peekClient() !== client) return; // signed out / switched account meanwhile: the app hears nothing
    attempts.note(p.deviceId, r);
    log.info(`[trust] ${trigger}: ${p.deviceId} → ${r}`);
    if (r === "signed") void refreshCryptoStatus();
    const app = parseTrustAnswer(await nativeTrust.resultRaw(me, p.deviceId, r));
    log.info(`[trust] the app says ${app ?? "(no answer)"}`);
  } catch (e) {
    log.warn("[trust] run failed", e);
  } finally {
    running = false;
    const q = queued;
    queued = null;
    if (q) void run(q);
  }
}

let installed = false;

/** Once, at start-up (features/native/index.ts). A no-op outside the apps: every run checks the cap first. */
export function installTrustBridge(): void {
  if (installed || typeof addEventListener !== "function") return;
  installed = true;
  addEventListener("tinhatnative:trust", () => void run("event"));
  const loadedFor = new Set<string>();
  let wasVerified = false;
  // the load attempt: crypto ready AND the first sync in — whichever comes last (the status may not change at the
  // first sync, so the sync itself is watched too), and right now for a page that is already there
  const check = () => {
    const client = peekClient();
    const st = getCryptoStatus();
    if (!client || st.loading || !st.cryptoReady) {
      wasVerified = false;
      return;
    }
    const key = `${client.getUserId() ?? ""}|${client.getDeviceId() ?? ""}`;
    if (!loadedFor.has(key) && client.isInitialSyncComplete()) {
      loadedFor.add(key);
      wasVerified = st.thisDeviceVerified;
      void run("load");
      return;
    }
    if (st.thisDeviceVerified && !wasVerified) void run("verified");
    wasVerified = st.thisDeviceVerified;
  };
  onCryptoStatus(check);
  let watched: MatrixClient | null = null;
  const onSync = (state: string) => {
    if (state === "PREPARED" || state === "SYNCING") check();
  };
  const watch = () => {
    watched?.off(ClientEvent.Sync, onSync);
    watched = peekClient();
    watched?.on(ClientEvent.Sync, onSync);
    check();
  };
  onClientChanged(watch);
  watch();
}

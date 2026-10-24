// crypto.ts — E2EE status, Security Key recovery, emoji (SAS) self-verification, "Set up
// recovery". Port of the native bridge.rs check_verified / verify / start_device_verification /
// accept_device_verification / confirm_sas_match / cancel_device_verification / set_up_recovery
// (+ sas_test.rs semantics), on matrix-js-sdk's Rust crypto.
//
//   const st = useCryptoStatus();          // { thisDeviceVerified, backupEnabled, … }
//   await restoreFromSecurityKey(key);     // throws Error("Verification failed: …")
//   const v = useVerification();           // { sasState, sasEmoji, sasNote, … } — the dialog state
//   startDeviceVerification(); acceptDeviceVerification(); confirmSasMatch();
//   cancelDeviceVerification(); setUpRecovery(password);
//
// "Verified" means what the native means (bridge.rs is_device_verified): the three PRIVATE
// cross-signing keys are in this device's store — i.e. this device can vouch for others and read
// history via key backup. Merely being signed by our own key is `deviceCrossSigned`.
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { ClientEvent, type MatrixClient, type MatrixEvent, type SecretStorage } from "matrix-js-sdk";
import {
  CryptoEvent,
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type GeneratedSecretStorageKey,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { onClientChanged, peekClient, secretStorageKeyCache } from "./client";
import {
  FIRST_DEVICE_MAX_WAIT_MS,
  FIRST_DEVICE_NOTE,
  firstDeviceSetup,
  KNOWN_METHODS,
  SAS_AUTO_START_SETTLE_MS,
  SAS_NO_SAS_NOTE,
  SAS_VERIFIER_DONE_NOTE,
  sasCancelText,
  sasStartPolicy,
  sasWaitNote,
  type SasStart,
} from "./sasPolicy";
import { createLogger } from "@/core/log";
import { isGuestAccount } from "@/core/server/offer";
import { setPref, usePref } from "@/core/prefs";

const log = createLogger("e2ee");

// =============================================================================================
// Status
// =============================================================================================

export interface CryptoStatus {
  /** First computation still running (all flags false until then). */
  loading: boolean;
  /** Rust crypto is initialised for this client. */
  cryptoReady: boolean;
  /** crypto.isCrossSigningReady(): public keys trusted + private keys available. */
  crossSigningReady: boolean;
  /** NATIVE semantics: private master/self/user-signing keys are cached on this device. */
  thisDeviceVerified: boolean;
  /** This device is signed by our self-signing key (other devices trust it). */
  deviceCrossSigned: boolean;
  /** The account has a cross-signing identity on the server. */
  hasCrossSigningIdentity: boolean;
  /** Secret storage (4S) holds every secret under the default key. */
  secretStorageReady: boolean;
  /** Default 4S key id — non-null = "recovery is set up" on this account. */
  secretStorageKeyId: string | null;
  /** Server-side key backup version (null = no backup on the server). */
  backupVersion: string | null;
  /** Key backup is active on THIS device (native backup_ready; the sign-out dialog uses it). */
  backupEnabled: boolean;
  /** The server backup carries a valid signature from a trusted device. */
  backupTrusted: boolean;
  /** This device holds the backup decryption key. */
  backupKeyCached: boolean;
  /**
   * F1: the first-device check (and, for a brand-new account, the setup itself) is still running — the verify banner
   * and the sign-in prompt wait for it (at most FIRST_DEVICE_MAX_WAIT_MS). Desktop: LoginController.firstDevicePending.
   */
  firstDevicePending: boolean;
}

const EMPTY_STATUS: CryptoStatus = {
  loading: true,
  cryptoReady: false,
  crossSigningReady: false,
  thisDeviceVerified: false,
  deviceCrossSigned: false,
  hasCrossSigningIdentity: false,
  secretStorageReady: false,
  secretStorageKeyId: null,
  backupVersion: null,
  backupEnabled: false,
  backupTrusted: false,
  backupKeyCached: false,
  firstDevicePending: false,
};

let status: CryptoStatus = EMPTY_STATUS;
const statusListeners = new Set<() => void>();

/** Tests only (devhook `__tw.crypto.pinStatus`): fields laid over every computed status. */
let statusPin: Partial<CryptoStatus> | null = null;
export function pinCryptoStatusForTest(p: Partial<CryptoStatus> | null): Promise<CryptoStatus> {
  statusPin = p;
  return refreshCryptoStatus(0);
}

function setStatus(computed: CryptoStatus) {
  const s = statusPin && !computed.loading ? { ...computed, ...statusPin } : computed;
  const same = (Object.keys(s) as Array<keyof CryptoStatus>).every((k) => s[k] === status[k]);
  if (same) return;
  status = s;
  for (const l of statusListeners) l();
}

/** bridge.rs is_device_verified: all three private cross-signing keys are cached locally. */
export async function isDeviceVerified(client: MatrixClient | null = peekClient()): Promise<boolean> {
  const crypto = client?.getCrypto();
  if (!crypto) return false;
  try {
    const s = await crypto.getCrossSigningStatus();
    const k = s.privateKeysCachedLocally;
    return !!(k.masterKey && k.selfSigningKey && k.userSigningKey);
  } catch {
    return false;
  }
}

async function computeStatus(client: MatrixClient): Promise<CryptoStatus> {
  const crypto = client.getCrypto();
  if (!crypto) return { ...EMPTY_STATUS, loading: false };
  const me = client.getSafeUserId();
  const dev = client.getDeviceId() ?? "";
  const safe = async <T,>(p: Promise<T>, d: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      log.debug("status probe failed", e);
      return d;
    }
  };
  const [crossSigningReady, thisDeviceVerified, devStatus, hasIdentity, ssReady, keyId, backupInfo, activeVersion, backupKey] =
    await Promise.all([
      safe(crypto.isCrossSigningReady(), false),
      isDeviceVerified(client),
      safe(crypto.getDeviceVerificationStatus(me, dev), null),
      safe(crypto.userHasCrossSigningKeys(me), false),
      safe(crypto.isSecretStorageReady(), false),
      safe(client.secretStorage.getDefaultKeyId(), null),
      safe(crypto.getKeyBackupInfo(), null),
      safe(crypto.getActiveSessionBackupVersion(), null),
      safe(crypto.getSessionBackupPrivateKey(), null),
    ]);
  const trust = backupInfo ? await safe(crypto.isKeyBackupTrusted(backupInfo), null) : null;
  return {
    loading: false,
    cryptoReady: true,
    crossSigningReady,
    thisDeviceVerified,
    deviceCrossSigned: !!devStatus?.crossSigningVerified,
    hasCrossSigningIdentity: hasIdentity,
    secretStorageReady: ssReady,
    secretStorageKeyId: keyId,
    backupVersion: backupInfo?.version ?? null,
    backupEnabled: activeVersion !== null,
    backupTrusted: !!trust?.trusted,
    backupKeyCached: backupKey !== null,
    firstDevicePending,
  };
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshSeq = 0;

/** Recompute the crypto status now-ish (debounced 250 ms). Returns when it has been applied. */
export function refreshCryptoStatus(delayMs = 250): Promise<CryptoStatus> {
  return new Promise((resolve) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      const c = peekClient();
      const seq = ++refreshSeq;
      if (!c) {
        setStatus(EMPTY_STATUS);
        return resolve(status);
      }
      const s = await computeStatus(c);
      if (seq === refreshSeq && peekClient() === c) setStatus(s);
      resolve(status);
    }, delayMs);
  });
}

export function getCryptoStatus(): CryptoStatus {
  return status;
}

function subscribeStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/** React: live E2EE status of this device / account. */
export function useCryptoStatus(): CryptoStatus {
  return useSyncExternalStore(subscribeStatus, getCryptoStatus, getCryptoStatus);
}

const WATCH_ACCOUNT_DATA = /^(m\.secret_storage\.|m\.cross_signing\.|m\.megolm_backup\.v1)/;

let unwatch: (() => void) | null = null;

function watchClient(c: MatrixClient | null) {
  unwatch?.();
  unwatch = null;
  setFirstPending(false);
  status = EMPTY_STATUS;
  for (const l of statusListeners) l();
  resetVerification();
  if (!c) return;
  const me = c.getUserId();
  const bump = () => void refreshCryptoStatus();
  const onTrust = (userId: string) => {
    if (userId === me) bump();
  };
  const onDevices = (users: string[]) => {
    if (me && users.includes(me)) bump();
  };
  const onAccountData = (ev: MatrixEvent) => {
    if (WATCH_ACCOUNT_DATA.test(ev.getType())) bump();
  };
  const onToDevice = (ev: MatrixEvent) => {
    // The private cross-signing keys arrive by m.secret.send gossip AFTER a self-verification —
    // re-check so the verify banner clears live (as the desktop does).
    if (ev.getType() === "m.secret.send") bump();
    noteVerificationToDevice(ev);
  };
  let prepared = false;
  const onSync = (state: string) => {
    if (!prepared && state === "PREPARED") {
      prepared = true;
      bump();
      void setUpFirstDevice(c);
    }
  };
  const onRequest = (req: VerificationRequest) => onIncomingRequest(req);
  c.on(CryptoEvent.KeysChanged, bump);
  c.on(CryptoEvent.UserTrustStatusChanged, onTrust);
  c.on(CryptoEvent.KeyBackupStatus, bump);
  c.on(CryptoEvent.KeyBackupDecryptionKeyCached, bump);
  c.on(CryptoEvent.DevicesUpdated, onDevices);
  c.on(CryptoEvent.VerificationRequestReceived, onRequest);
  c.on(ClientEvent.AccountData, onAccountData);
  c.on(ClientEvent.ToDeviceEvent, onToDevice);
  c.on(ClientEvent.Sync, onSync);
  unwatch = () => {
    c.off(CryptoEvent.KeysChanged, bump);
    c.off(CryptoEvent.UserTrustStatusChanged, onTrust);
    c.off(CryptoEvent.KeyBackupStatus, bump);
    c.off(CryptoEvent.KeyBackupDecryptionKeyCached, bump);
    c.off(CryptoEvent.DevicesUpdated, onDevices);
    c.off(CryptoEvent.VerificationRequestReceived, onRequest);
    c.off(ClientEvent.AccountData, onAccountData);
    c.off(ClientEvent.ToDeviceEvent, onToDevice);
    c.off(ClientEvent.Sync, onSync);
  };
  // a Matrix guest, or a Tin Hat Server's temporary guest account (@guest-…, docs/GUESTS.md): no first-device set-up
  setFirstPending(!c.isGuest() && !isGuestAccount(c.getUserId()));
  // imported / re-watched after the first sync already landed: no PREPARED event is coming
  if (c.isInitialSyncComplete()) {
    prepared = true;
    void setUpFirstDevice(c);
  }
  bump();
}

onClientChanged(() => watchClient(peekClient()));
// Imported after a client already exists (HMR / late import): start watching it now.
queueMicrotask(() => {
  if (peekClient() && !unwatch) watchClient(peekClient());
});

// =============================================================================================
// F1 — the first device of a brand-new account sets up its encryption itself
// =============================================================================================
//
// 2026-09-29: a new account (invite link) was greeted with "verify with another device" — but there is no other
// device, and no identity to verify against. So the first device of an account that has never had encryption creates
// it: the cross-signing identity (this device holds its private keys, so it is verified and verifies the others) plus
// secret storage and a key backup, and shows the new Security Key once (F2). The server lets an account upload its
// FIRST cross-signing keys without a password (MSC3967, Synapse 1.145), so this needs nothing from the user. Every
// other case (keys exist / a backup exists / a guest / the upload refused) falls through to the usual verify prompt.
// Desktop twin: bridge.rs set_up_first_device. Spec: docs/VERIFY-SAS.md "First device".

let firstDevicePending = false;
let firstPendingTimer: ReturnType<typeof setTimeout> | null = null;
let firstCheckedFor: MatrixClient | null = null;

function setFirstPending(p: boolean) {
  if (firstPendingTimer) clearTimeout(firstPendingTimer);
  firstPendingTimer = p ? setTimeout(() => setFirstPending(false), FIRST_DEVICE_MAX_WAIT_MS) : null;
  if (firstDevicePending === p) return;
  firstDevicePending = p;
  setStatus({ ...status, firstDevicePending: p });
}

async function setUpFirstDevice(c: MatrixClient): Promise<void> {
  if (firstCheckedFor === c) return;
  firstCheckedFor = c;
  const live = () => peekClient() === c;
  const crypto = c.getCrypto();
  try {
    if (!crypto) return;
    const me = c.getSafeUserId();
    const [hasCrossSigning, backup] = await Promise.all([crypto.userHasCrossSigningKeys(me, true), crypto.getKeyBackupInfo()]);
    const guest = c.isGuest() || isGuestAccount(me);
    log.info(`[first-device] check: guest=${guest} cross_signing_on_server=${hasCrossSigning} backup_on_server=${!!backup}`);
    if (!live() || !firstDeviceSetup({ guest, hasCrossSigning, backupOnServer: !!backup })) return;
    log.info("[first-device] new account: setting up cross-signing + recovery on this device");
    // no password: the server accepts an account's first cross-signing keys without one (MSC3967)
    await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: (makeRequest) => makeRequest(null) });
    log.info("[first-device] cross-signing bootstrapped");
    void markFirstDevice(c);
    if (!live()) return;
    let generated: GeneratedSecretStorageKey | null = null;
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => (generated = await crypto.createRecoveryKeyFromPassphrase()),
      setupNewSecretStorage: true,
      setupNewKeyBackup: true,
    });
    await crypto.checkKeyBackupAndEnable();
    const key = (generated as GeneratedSecretStorageKey | null)?.encodedPrivateKey ?? "";
    log.info(`[first-device] recovery on; device_verified=${await isDeviceVerified(c)} key=${key ? "shown" : "none"}`);
    if (!live() || !key) return;
    // F2: the one-time Security Key, in the verify dialog's recovery-done screen (the host opens it)
    if (!getVerification().sasState) vset({ ...IDLE, sasState: "recovery-done", recoveryKey: key, sasNote: FIRST_DEVICE_NOTE, firstDevice: true });
  } catch (e) {
    log.warn("[first-device] setup failed — falling back to the verify prompt", e);
  } finally {
    secretStorageKeyCache.clear();
    if (live()) {
      await refreshCryptoStatus(0);
      if (live()) setFirstPending(false);
    }
  }
}

// selfhost/firstrun item 3 — "this device is the account's first device": F1 set up the encryption here AND no other
// device of the account existed then, so a message this device can't read because it predates the device predates
// the person's first sign-in (chat/lib/utd.ts: "Sent before you first signed in, so it can't be unlocked."). A device
// pref "<user>|<device>", so a later sign-in (another device id) never inherits it. Desktop twin: the same marker.
const FIRST_DEVICE_PREF = "first-device";

async function markFirstDevice(c: MatrixClient): Promise<void> {
  try {
    const me = c.getDeviceId();
    const { devices } = await c.getDevices();
    const alone = !!me && devices.every((d) => d.device_id === me);
    log.info(`[first-device] devices on the account: ${devices.length} — ${alone ? "this is the first one" : "not alone"}`);
    if (alone && peekClient() === c) setPref(FIRST_DEVICE_PREF, `${c.getSafeUserId()}|${me}`);
  } catch (e) {
    log.warn("[first-device] couldn't list the devices — the plain words then", e);
  }
}

/** Is this device the account's first device (see markFirstDevice)? */
export function useIsFirstDevice(): boolean {
  const v = usePref(FIRST_DEVICE_PREF, "");
  const c = peekClient();
  return !!v && !!c && v === `${c.getUserId()}|${c.getDeviceId()}`;
}

// =============================================================================================
// Security Key (recovery) → verify this device
// =============================================================================================

async function withSecretStorageKey<T>(keyId: string, key: Uint8Array<ArrayBuffer>, fn: () => Promise<T>): Promise<T> {
  secretStorageKeyCache.set(keyId, key);
  try {
    return await fn();
  } finally {
    secretStorageKeyCache.delete(keyId);
  }
}

/** Turn what the user typed (Security Key, or the passphrase it was made from) into the raw key. */
async function keyFromInput(
  client: MatrixClient,
  input: string,
): Promise<{ keyId: string; key: Uint8Array<ArrayBuffer> }> {
  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) throw new Error("this account has no recovery set up yet");
  const tuple = await client.secretStorage.getKey(keyId);
  if (!tuple) throw new Error("the recovery key description is missing on the server");
  const info = tuple[1] as SecretStorage.SecretStorageKeyDescriptionAesV1;
  let key: Uint8Array<ArrayBuffer> | null = null;
  try {
    key = decodeRecoveryKey(input.trim());
  } catch {
    if (info.passphrase?.salt && info.passphrase.iterations) {
      key = await deriveRecoveryKeyFromPassphrase(input, info.passphrase.salt, info.passphrase.iterations);
    }
  }
  if (!key) throw new Error("that doesn't look like a Security Key");
  if (!(await client.secretStorage.checkKey(key, info))) throw new Error("that Security Key doesn't match this account");
  return { keyId, key };
}

export interface RecoverResult {
  verified: boolean;
  backupEnabled: boolean;
}

/**
 * Verify this device with the Security Key (native "Verify with Security Key" / recover()):
 * open secret storage, import the cross-signing keys (this also cross-signs THIS device), load
 * the key-backup key, enable backup, then pull every room key from the backup in the background
 * so history decrypts everywhere. Throws Error("Verification failed: …").
 */
export async function restoreFromSecurityKey(
  securityKey: string,
  opts: { onBackupProgress?: (done: number, total: number) => void } = {},
): Promise<RecoverResult> {
  const client = peekClient();
  const crypto = client?.getCrypto();
  if (!client || !crypto) throw new Error("Verification failed: not signed in");
  if (!securityKey.trim()) throw new Error("Verification failed: enter your Security Key");
  try {
    const { keyId, key } = await keyFromInput(client, securityKey);
    await withSecretStorageKey(keyId, key, async () => {
      await crypto.bootstrapCrossSigning({});
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      } catch (e) {
        log.warn("[verify] no backup key in secret storage", e);
      }
    });
    await crypto.checkKeyBackupAndEnable();
    const verified = await isDeviceVerified(client);
    const backupEnabled = (await crypto.getActiveSessionBackupVersion()) !== null;
    log.info(`[verify] recover OK; device verified=${verified} backup_enabled=${backupEnabled}`);
    void refreshCryptoStatus(0);
    if (backupEnabled) {
      // Pull megolm keys for all rooms from backup (background) — native downloads per room.
      void crypto
        .restoreKeyBackup({
          progressCallback: (p) => {
            if (p.stage === "load_keys") opts.onBackupProgress?.(p.successes + p.failures, p.total);
          },
        })
        .then((r) => log.info(`[verify] backup key download complete: ${r.imported}/${r.total}`))
        .catch((e) => log.warn("[verify] backup key download failed", e));
    }
    return { verified, backupEnabled };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log.warn("[verify] failed", msg);
    throw new Error(`Verification failed: ${msg}`);
  }
}

// =============================================================================================
// Emoji (SAS) self-verification + Set up recovery — the VerifyDeviceDialog state
// =============================================================================================

export type SasState = "" | "waiting" | "emoji" | "confirming" | "done" | "cancelled" | "recovery-working" | "recovery-done";

export interface VerificationInfo {
  /** Native sasState: "" idle | waiting | emoji | confirming | done | cancelled | recovery-working | recovery-done */
  sasState: SasState;
  /** The request came FROM another of our devices (show Accept; title "Verify the other device"). */
  sasIncoming: boolean;
  /** The seven emoji (+ names) to compare, in order. */
  sasEmoji: Array<{ e: string; name: string }>;
  /** The other device's display name (or id). */
  sasPeer: string;
  /** The sentence under the dialog title (native wording). */
  sasNote: string;
  /** Nothing can vouch for this device → offer "Set up encryption here" (needs the password). */
  sasCanBootstrap: boolean;
  /** Freshly generated Security Key — shown ONCE after Set up recovery, never stored. */
  recoveryKey: string;
  /**
   * S2 (docs/VERIFY-SAS.md): we sent the request, the other device is ready and offers QR, so its user
   * chooses the method — we wait, and offer "Start emoji comparison" (manual start through the S3 guard).
   * Desktop twin: the `sasCanStart` qproperty.
   */
  sasCanStart: boolean;
  /** F2: the recovery-done screen is the first device's new Security Key (title FIRST_DEVICE_TITLE). */
  firstDevice: boolean;
}

const IDLE: VerificationInfo = {
  sasState: "",
  sasIncoming: false,
  sasEmoji: [],
  sasPeer: "",
  sasNote: "",
  sasCanBootstrap: false,
  recoveryKey: "",
  sasCanStart: false,
  firstDevice: false,
};

export const useVerificationStore = create<VerificationInfo>()(() => IDLE);

/** React: the verification dialog state. */
export function useVerification(): VerificationInfo {
  return useVerificationStore();
}

export function getVerification(): VerificationInfo {
  return useVerificationStore.getState();
}

const vset = (p: Partial<VerificationInfo>) => useVerificationStore.setState(p);
const vstate = (sasState: SasState, sasNote: string) => vset({ sasState, sasNote });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Active {
  req: VerificationRequest | null;
  verifier: Verifier | null;
  sas: ShowSasCallbacks | null;
  offReq: (() => void) | null;
  /** S3: the request we already started a SAS for — never a second start on it. */
  startedFor: VerificationRequest | null;
  /** S5: the emoji we put on screen for `sas` ("" until ShowSas). */
  shownEmoji: string;
  /** Bumped by every dropActive(): an await that resumes into a newer generation must not touch the flow. */
  gen: number;
  /** An accept() is in flight (a second tap on Accept is a no-op, not a false "cancelled"). */
  accepting: boolean;
}
const active: Active = { req: null, verifier: null, sas: null, offReq: null, startedFor: null, shownEmoji: "", gen: 0, accepting: false };

function dropActive() {
  active.gen++;
  active.accepting = false;
  active.offReq?.();
  active.req = null;
  active.verifier = null;
  active.sas = null;
  active.offReq = null;
  active.startedFor = null;
  active.shownEmoji = "";
}

/** Forget any flow and return the dialog to idle (does not cancel on the wire). */
export function resetVerification(): void {
  dropActive();
  useVerificationStore.setState(IDLE, true);
}

async function peerName(client: MatrixClient, deviceId: string | undefined): Promise<string> {
  if (!deviceId) return "";
  try {
    const me = client.getSafeUserId();
    const map = await client.getCrypto()!.getUserDeviceInfo([me]);
    return map.get(me)?.get(deviceId)?.displayName || deviceId;
  } catch {
    return deviceId;
  }
}

/** After SAS done the private keys arrive by gossip; poll as a backstop (native: 40 × 3 s). */
function pollUntilVerified(client: MatrixClient) {
  let n = 0;
  const tick = async () => {
    if (peekClient() !== client) return;
    if (await isDeviceVerified(client)) {
      log.info("[sas] secrets landed — fully verified");
      void refreshCryptoStatus(0);
      return;
    }
    if (++n >= 40) {
      log.warn("[sas] secrets never arrived after SAS done (other device too old to gossip them?)");
      return;
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// ---- the request's own state ------------------------------------------------------------------------------

/**
 * js-sdk's `phase` getter THROWS ("inner phase == Transitioned but no verifier!") once the SDK cache has dropped the
 * request's comparison, and otherwise reports the COMPARISON's phase for a transitioned request — so a request whose
 * comparison was cancelled reads "Cancelled" while the Rust request is still open. Never let the getter escape.
 */
function phaseOf(req: VerificationRequest): VerificationPhase | undefined {
  try {
    return req.phase;
  } catch {
    return undefined;
  }
}

/** Is the Rust request itself still open (not done / cancelled)? Reads the inner request (runtime-checked). */
function requestOpen(req: VerificationRequest): boolean {
  const inner = (req as unknown as { inner?: { isDone?: () => boolean; isCancelled?: () => boolean } }).inner;
  try {
    if (inner && typeof inner.isDone === "function" && typeof inner.isCancelled === "function") return !inner.isDone() && !inner.isCancelled();
  } catch {
    /* a freed wasm handle — fall back to the phase */
  }
  const p = phaseOf(req);
  return p !== VerificationPhase.Cancelled && p !== VerificationPhase.Done;
}

/**
 * End an open request (cancel on the wire). matrix-sdk-crypto cancels EVERY new verification request of this account
 * at birth while an older one is still open (VerificationMachine::insert_request — and that new request even goes out
 * with the SDK's default QR methods), and its cache cancels a comparison without its request (a start race, a
 * comparison timeout). So a comparison that ends cancelled must take its request with it, or "Try again" dies at once
 * for up to ten minutes (adversarial review 2026-09-25, reproduced).
 */
let ending: Promise<void> = Promise.resolve();
function endRequest(req: VerificationRequest | null, why: string) {
  if (!req || !requestOpen(req)) return;
  log.info(`[sas] ending the open request (${why})`);
  ending = (async () => {
    // the SDK queued its own cancel of the comparison (with the specific code, e.g. m.mismatched_sas / m.timeout):
    // send that first, so the other device shows the right sentence and not our request's plain m.user
    await flushOutgoing();
    if (requestOpen(req)) await req.cancel().catch((e: unknown) => log.debug("[sas] end request", e));
  })();
}

/** Send the crypto layer's queued outgoing requests now (js-sdk internal, runtime-checked; resume.ts uses it too). */
async function flushOutgoing(): Promise<void> {
  const crypto = peekClient()?.getCrypto();
  const orm = crypto ? (Reflect.get(crypto, "outgoingRequestsManager") as { doProcessOutgoingRequests?: () => Promise<void> } | undefined) : undefined;
  try {
    await orm?.doProcessOutgoingRequests?.();
  } catch (e) {
    log.debug("[sas] flush outgoing", e);
  }
}

// ---- S1: what the other side offers ---------------------------------------------------------------------

/**
 * m.key.verification.ready `methods` straight off the wire, by transaction id. Only a fallback: the Rust
 * getter behind otherPartySupportsMethod() throws when the ready lists a method it doesn't know.
 */
const readyMethods = new Map<string, string[]>();
function noteVerificationToDevice(ev: MatrixEvent) {
  if (ev.getType() !== "m.key.verification.ready") return;
  const c = ev.getContent() as { transaction_id?: unknown; methods?: unknown };
  if (typeof c?.transaction_id !== "string" || !Array.isArray(c.methods)) return;
  if (readyMethods.size > 50) readyMethods.clear();
  readyMethods.set(
    c.transaction_id,
    c.methods.filter((m): m is string => typeof m === "string"),
  );
}

/** The other side's advertised methods (names only), or null when the SDK can't say and the wire hasn't told us. */
function theirMethodsOf(req: VerificationRequest): string[] | null {
  try {
    return KNOWN_METHODS.filter((m) => req.otherPartySupportsMethod(m));
  } catch {
    return (req.transactionId && readyMethods.get(req.transactionId)) || null;
  }
}

/** The cancel code of a flow: the request's, else the one inside a verifier rejection / cancel event. */
function cancelCodeOf(req: VerificationRequest | null, e?: unknown, v?: Verifier | null): string | null {
  const sc = sasCancelCodeOf(v ?? verifierOf(req));
  if (sc) return sc;
  if (req?.cancellationCode) return req.cancellationCode;
  try {
    const content = (e as { getContent?: () => { code?: unknown } } | null)?.getContent?.();
    if (typeof content?.code === "string") return content.code;
  } catch {
    /* not an event */
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = /with code (\S+?):/.exec(msg) ?? /\b(m\.[a-z_]+)\b/.exec(msg);
  return m ? m[1] : null;
}

function verifierOf(req: VerificationRequest | null): Verifier | undefined {
  try {
    return req?.verifier;
  } catch {
    return undefined;
  }
}

/** The cancel code of a verifier's comparison (the Rust SAS behind it), if it was cancelled — runtime-checked. */
function sasCancelCodeOf(v: Verifier | null | undefined): string | null {
  const inner = (v as unknown as { inner?: { cancelInfo?: () => { cancelCode?: () => string } | undefined } } | null | undefined)?.inner;
  try {
    const code = inner?.cancelInfo?.()?.cancelCode?.();
    return typeof code === "string" && code ? code : null;
  } catch {
    return null;
  }
}

// ---- S5: a SAS replaced after its emoji were shown ------------------------------------------------------

/** The Rust SAS behind a js-sdk RustSASVerifier (runtime-checked: `inner` is not public API). */
interface RustSasLike {
  canBePresented(): boolean;
  haveWeConfirmed(): boolean;
  isDone(): boolean;
  isCancelled(): boolean;
  emoji(): Array<{ symbol: string; description: string }> | undefined;
}
function innerSas(v: Verifier): RustSasLike | null {
  const inner = (v as unknown as { inner?: Partial<RustSasLike> }).inner;
  if (!inner) return null;
  const fns: Array<keyof RustSasLike> = ["canBePresented", "haveWeConfirmed", "isDone", "isCancelled", "emoji"];
  return fns.every((f) => typeof inner[f] === "function") ? (inner as RustSasLike) : null;
}
const emojiKey = (list: Array<{ e: string; name: string }>) => list.map((x) => `${x.e}${x.name}`).join(" ");

/**
 * js-sdk 42 swaps the Rust SAS under a live verifier (RustSASVerifier.replaceInner: glare lost, or the other
 * side's second start with a smaller device id) but never re-emits ShowSas — the old emoji stay on screen
 * while "They match" would confirm the NEW SAS. After our emoji were shown, a SAS that has no keys yet, or
 * other emoji, is a replacement. (The original only moves on: presented → confirmed → done / cancelled.)
 */
function sasReplaced(v: Verifier): boolean {
  const inner = innerSas(v);
  if (!inner || !active.shownEmoji) return false;
  try {
    if (inner.isCancelled() || inner.isDone() || inner.haveWeConfirmed()) return false;
    if (!inner.canBePresented()) return true;
    const now = (inner.emoji() ?? []).map((x) => ({ e: x.symbol, name: x.description }));
    return emojiKey(now) !== active.shownEmoji;
  } catch {
    return false; // a freed wasm handle etc. — no claim
  }
}

function onSasReplaced(req: VerificationRequest | null) {
  log.warn("[sas] the comparison was replaced after its emoji were shown — cancelling (never confirm stale emoji)");
  const sas = active.sas;
  active.sas = null;
  active.shownEmoji = "";
  vset({ sasState: "cancelled", sasCanStart: false, sasEmoji: [], sasNote: sasCancelText("m.unexpected_message") });
  try {
    sas?.cancel(); // acts on the CURRENT (new) Rust SAS
  } catch (e) {
    log.debug("[sas] cancel replaced", e);
  }
  endRequest(req, "replaced comparison");
}

function attachVerifier(client: MatrixClient, req: VerificationRequest, v: Verifier) {
  if (active.verifier === v) return;
  active.verifier = v;
  if (getVerification().sasCanStart) vset({ sasCanStart: false });
  v.on(VerifierEvent.ShowSas, (sas) => {
    if (active.verifier !== v) return;
    active.sas = sas;
    const emoji = (sas.sas.emoji ?? []).map(([e, name]) => ({ e, name }));
    active.shownEmoji = emojiKey(emoji);
    vset({
      sasEmoji: emoji,
      sasState: "emoji",
      sasCanStart: false,
      sasNote: "Do these seven emoji match, in this order, on your other device?",
    });
  });
  // (matrix-js-sdk 42's Rust verifier never emits this; kept for other backends — never throws)
  v.on(VerifierEvent.Cancel, (e) => {
    const note = sasCancelText(cancelCodeOf(req, e, v));
    endRequest(req, "comparison cancelled");
    if (active.verifier !== v) return;
    if (getVerification().sasState !== "cancelled") vstate("cancelled", note);
    active.sas = null;
  });
  // For a start the OTHER side sent, verify() is also our accept (Element X auto-starts).
  v.verify()
    .then(async () => {
      if (active.verifier !== v) return;
      if (!req.initiatedByMe) {
        // S7: we vouched for the OTHER device; this one was verified already
        vstate("done", SAS_VERIFIER_DONE_NOTE);
        active.sas = null;
        return;
      }
      const verified = await isDeviceVerified(client);
      if (active.verifier !== v) return; // a newer flow took over while we looked
      vstate("done", "This device is verified — decrypting your messages…");
      void refreshCryptoStatus(0);
      if (!verified) pollUntilVerified(client);
      active.sas = null;
    })
    .catch((e: unknown) => {
      // the sentence first: once we end the request ourselves it reads m.user
      const note = sasCancelText(cancelCodeOf(req, e, v));
      // the comparison ended cancelled — its request may still be open (see endRequest); unless a newer comparison
      // already runs on it (js-sdk swaps the inner SAS under the same verifier, so a different one means a new flow)
      const cur = verifierOf(req);
      if (!cur || cur === v) endRequest(req, "comparison cancelled");
      if (active.verifier !== v) return;
      if (getVerification().sasState !== "cancelled") vstate("cancelled", note);
    });
}

/**
 * A local failure the sheet shows as cancelled ("Could not start: …", no emoji offered): end the flow and cancel it
 * on the wire too, so the other device is not left waiting for ten minutes — the desktop's sas_driver fail() does
 * the same (parity, adversarial review 2026-09-25). Only for a request that exists; the note is shown as is.
 */
function failFlow(note: string) {
  const { sas, req } = active;
  dropActive();
  vset({ sasState: "cancelled", sasCanStart: false, sasNote: note });
  try {
    sas?.cancel();
  } catch (e) {
    log.debug("[sas] fail: cancel sas", e);
  }
  endRequest(req, note);
}

/**
 * S3 — the ONLY way we start a SAS (auto on Ready, or the "Start emoji comparison" button): right before the
 * start, the request must still be Ready, have no verifier, and not have been started by us. A start on a
 * request the other side already moved on (their start landed) makes the Rust SDK cancel BOTH flows.
 */
async function startSasGuarded(client: MatrixClient, req: VerificationRequest, why: "auto" | "manual"): Promise<void> {
  const skip =
    active.req !== req
      ? "not the active request"
      : !req.initiatedByMe
        ? "we did not send the request"
        : phaseOf(req) !== VerificationPhase.Ready
          ? `request phase is ${VerificationPhase[phaseOf(req) ?? -1] ?? "unknown"}, not Ready`
          : req.verifier
            ? "a comparison already exists"
            : active.startedFor === req
              ? "already started one for this request"
              : "";
  if (skip) {
    log.info(`[sas] ${why} start skipped: ${skip}`);
    return;
  }
  active.startedFor = req;
  vset({ sasCanStart: false });
  log.info(`[sas] ${why} start`);
  try {
    const v = await req.startVerification("m.sas.v1");
    if (active.req !== req) return;
    attachVerifier(client, req, v);
  } catch (e) {
    if (active.req !== req) return;
    failFlow(`Could not start: ${(e as Error)?.message ?? e}`);
  }
}

/** S2 — "Start emoji comparison": the requester's manual start while a QR-capable peer lets its user choose. */
export async function startSasComparison(): Promise<void> {
  const client = peekClient();
  const req = active.req;
  if (!client || !req) return;
  await startSasGuarded(client, req, "manual");
}

function drive(client: MatrixClient, req: VerificationRequest) {
  active.offReq?.();
  active.req = req;
  let readyHandled = false;

  const onReady = async () => {
    // The name only decorates the dialog — never await it before a start (the field's 94 ms window, S3).
    const nameP = peerName(client, req.otherDeviceId).then((p) => {
      if (active.req === req) vset({ sasPeer: p });
      return p;
    });
    let theirs = theirMethodsOf(req);
    if (theirs === null) {
      await sleep(300); // the ready's to-device event is emitted just after the request changes
      theirs = (req.transactionId && readyMethods.get(req.transactionId)) || null;
    }
    const policy: SasStart = theirs === null ? "start" : sasStartPolicy(theirs);
    log.info(
      `[sas] ready — their methods: ${theirs === null ? "unknown" : theirs.join(",") || "none"}${req.initiatedByMe ? ` → ${policy}` : " (they asked; we never start)"}`,
    );
    // Only the side that sent the request starts, or both would start and the flows cancel each other
    // (native drive_verification). A responder waits for the requester's start.
    if (!req.initiatedByMe || active.req !== req) return;
    if (policy === "no-sas") {
      if (getVerification().sasState !== "cancelled") failFlow(SAS_NO_SAS_NOTE);
      return;
    }
    if (policy === "start") {
      // S3 settle (= the desktop's AUTO_START_SETTLE): after a phone resumes, the peer's ready AND its own start
      // (Element X starts right after its ready) arrive in ONE catch-up batch; the SDK reports Ready while that
      // start is still being processed, and js-sdk's startVerification() awaits the device lookup before the Rust
      // start — a start in that window made the SDK cancel BOTH comparisons (reproduced 3 of 7 runs: Element X
      // persona + a 6 s app switch right after asking). After the settle the guard sees their start and we accept
      // it instead. Narrows the window; the SDK offers no atomic "start only if still Ready".
      await sleep(SAS_AUTO_START_SETTLE_MS);
      await startSasGuarded(client, req, "auto");
      return;
    }
    // "wait": a QR-capable peer (Element Classic, Element Web) lets its user choose — starting now raced
    // Element Classic's chooser into a double cancel (docs/VERIFY-SAS.md). Its start is accepted as usual.
    const peer = (await nameP) || req.otherDeviceId || "Your other device";
    if (active.req !== req || phaseOf(req) !== VerificationPhase.Ready || req.verifier || active.startedFor === req) return;
    vset({ sasState: "waiting", sasCanStart: true, sasNote: sasWaitNote(peer) });
  };

  const onChange = () => {
    if (active.req !== req) return;
    const st = getVerification().sasState;
    if (active.sas && active.verifier && (st === "emoji" || st === "confirming") && sasReplaced(active.verifier)) {
      onSasReplaced(req);
      return;
    }
    switch (phaseOf(req)) {
      case VerificationPhase.Requested:
        if (!req.initiatedByMe) vstate("waiting", "Another device is asking to verify. Accept to compare emoji.");
        break;
      case VerificationPhase.Ready:
        if (!readyHandled) {
          readyHandled = true;
          void onReady();
        }
        break;
      case VerificationPhase.Started:
        if (getVerification().sasCanStart) vset({ sasCanStart: false });
        if (req.verifier) attachVerifier(client, req, req.verifier);
        break;
      case VerificationPhase.Done:
        if (getVerification().sasState !== "done") {
          vstate("done", req.initiatedByMe ? "This device is verified." : SAS_VERIFIER_DONE_NOTE);
          void refreshCryptoStatus(0);
        }
        break;
      case VerificationPhase.Cancelled: {
        const note = sasCancelText(cancelCodeOf(req)); // before we end the request (then it reads m.user)
        endRequest(req, "phase cancelled"); // a transitioned request reads Cancelled when only its comparison is
        if (getVerification().sasState !== "cancelled") {
          vset({ sasState: "cancelled", sasCanStart: false, sasNote: note });
        }
        break;
      }
      case undefined:
        // the getter threw: the request is transitioned but the SDK has dropped its comparison (its cache cancelled
        // it) — nothing can continue on this request; end it so a retry is not cancelled at birth
        endRequest(req, "comparison gone");
        if (getVerification().sasState !== "cancelled" && getVerification().sasState !== "done") {
          vset({ sasState: "cancelled", sasCanStart: false, sasNote: sasCancelText(null) });
        }
        break;
    }
  };
  req.on(VerificationRequestEvent.Change, onChange);
  active.offReq = () => req.off(VerificationRequestEvent.Change, onChange);
  // Seed with the CURRENT phase: a transition that landed before we subscribed is otherwise lost.
  onChange();
}

function onIncomingRequest(req: VerificationRequest) {
  // Only surface our OWN devices: this dialog is "verify this device", not "verify a contact".
  if (!req.isSelfVerification || req.initiatedByMe) return;
  const client = peekClient();
  if (!client) return;
  log.info("[sas] incoming self-verification request");
  dropActive();
  vset({
    sasIncoming: true,
    sasState: "waiting",
    sasEmoji: [],
    sasCanBootstrap: false,
    sasCanStart: false,
    sasNote: "Another of your devices wants to verify. Accept to compare emoji.",
  });
  active.req = req;
  // Watch it now so a cancel from the other side shows even before we accept.
  drive(client, req);
}

/** Ask our other signed-in (verified) devices to verify this one by comparing emoji. */
export async function startDeviceVerification(): Promise<void> {
  const client = peekClient();
  const crypto = client?.getCrypto();
  if (!client || !crypto) return;
  dropActive();
  const attempt = active.gen; // taken BEFORE the wait: a second tap meanwhile moves it on and this one yields
  await Promise.race([ending, sleep(3000)]); // a previous flow's open request must be gone first (see endRequest)
  if (active.gen !== attempt) return;
  vset({
    sasState: "waiting",
    sasEmoji: [],
    sasIncoming: false,
    sasCanBootstrap: false,
    sasCanStart: false,
    recoveryKey: "",
    sasNote: "Open Tin Hat on a device you're already signed in to — it will ask you to compare emoji.",
  });
  const gen = active.gen;
  const me = client.getSafeUserId();
  const myDevice = client.getDeviceId();
  // The SDK only sends the request to devices already signed by our self-signing key; with none,
  // it "succeeds" and reaches nobody. Detect that up front and say so (as the desktop does).
  try {
    const devs = (await crypto.getUserDeviceInfo([me], true)).get(me);
    const eligible: string[] = [];
    for (const d of devs?.values() ?? []) {
      if (d.deviceId === myDevice) continue;
      const s = await crypto.getDeviceVerificationStatus(me, d.deviceId);
      if (s?.signedByOwner) eligible.push(d.deviceId);
    }
    if (active.gen !== gen) return; // cancelled / replaced while we looked
    log.info(`[sas] own devices=${devs?.size ?? 0} eligible(verified)=${eligible.length}`);
    if (eligible.length === 0) {
      vset({
        sasState: "cancelled",
        sasCanBootstrap: true,
        sasNote:
          "None of your other devices is verified yet, so there's nothing that can vouch for this one. Set up encryption here with your account password — this device then becomes the one that verifies the others.",
      });
      return;
    }
  } catch (e) {
    log.warn("[sas] could not list own devices", e);
  }
  try {
    const hasKeys = await crypto.userHasCrossSigningKeys(me, true);
    if (active.gen !== gen) return;
    if (!hasKeys) {
      vset({
        sasState: "cancelled",
        sasCanBootstrap: true,
        sasNote:
          "This account has no encryption set up yet, so there's nothing that can vouch for this device. Set it up here and this device becomes the one that verifies the rest.",
      });
      return;
    }
    const req = await crypto.requestOwnUserVerification();
    log.info(`[sas] request sent (self=${req.isSelfVerification})`);
    if (active.gen !== gen) {
      // dismissed while the request went out: withdraw it instead of reviving the flow
      req.cancel().catch(() => undefined);
      return;
    }
    drive(client, req);
  } catch (e) {
    if (active.gen === gen) vstate("cancelled", `Could not start: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Emoji-verify ONE specific device of ours (e.g. from the sessions list), regardless of whether
 * anything is cross-signed yet. Same dialog states as startDeviceVerification. On completion
 * each device trusts the other locally; the private cross-signing keys only travel if the
 * other device has them.
 */
export async function startDeviceVerificationWith(deviceId: string): Promise<void> {
  const client = peekClient();
  const crypto = client?.getCrypto();
  if (!client || !crypto || !deviceId) return;
  dropActive();
  const gen = active.gen; // taken BEFORE the wait: a second tap meanwhile moves it on and this one yields
  await Promise.race([ending, sleep(3000)]); // a previous flow's open request must be gone first (see endRequest)
  if (active.gen !== gen) return;
  vset({
    sasState: "waiting",
    sasEmoji: [],
    sasIncoming: false,
    sasCanBootstrap: false,
    sasCanStart: false,
    recoveryKey: "",
    sasPeer: deviceId,
    sasNote: "Open Tin Hat on that device — it will ask you to compare emoji.",
  });
  void peerName(client, deviceId).then((p) => {
    if (active.gen === gen) vset({ sasPeer: p });
  });
  try {
    const req = await crypto.requestDeviceVerification(client.getSafeUserId(), deviceId);
    if (active.gen !== gen) {
      req.cancel().catch(() => undefined);
      return;
    }
    drive(client, req);
  } catch (e) {
    if (active.gen === gen) vstate("cancelled", `Could not start: ${(e as Error)?.message ?? e}`);
  }
}

/** Accept a verification request that arrived from another of our devices. */
export async function acceptDeviceVerification(): Promise<void> {
  const client = peekClient();
  const req = active.req;
  if (!client || !req) return;
  // a second tap (or a tap after the ready went out) is a no-op — js-sdk would throw and we'd show "cancelled"
  const ph = phaseOf(req);
  if (active.accepting || ph !== VerificationPhase.Requested) {
    log.info(`[sas] accept ignored (${active.accepting ? "already accepting" : `request ${VerificationPhase[ph ?? -1] ?? "unknown"}`})`);
    return;
  }
  const gen = active.gen;
  active.accepting = true;
  vset({ sasNote: "Accepting…" });
  try {
    await req.accept();
    if (active.gen !== gen || active.req !== req) return; // another request took over meanwhile
    drive(client, req);
  } catch (e) {
    if (active.gen === gen && active.req === req) failFlow(`Could not accept: ${(e as Error)?.message ?? e}`);
  } finally {
    if (active.gen === gen) active.accepting = false;
  }
}

/** "The emoji match" — completes verification on this side. */
export async function confirmSasMatch(): Promise<void> {
  const { sas, verifier, req } = active;
  // S5: never confirm a comparison whose emoji are not the ones on screen
  if (sas && verifier && sasReplaced(verifier)) {
    onSasReplaced(req);
    return;
  }
  vstate("confirming", "Waiting for your other device to confirm…");
  if (!sas) return;
  const gen = active.gen;
  try {
    await sas.confirm();
  } catch (e) {
    if (active.gen === gen) failFlow(`Could not confirm: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * "They don't match" or the dialog was closed. Cancelling is the SAFE outcome — never treat a
 * dismissal as success. `mismatch` sends the protocol's mismatch code instead of a plain cancel.
 * The note is the S6 sentence for the code we send (m.mismatched_sas / m.user).
 */
export async function cancelDeviceVerification(opts: { mismatch?: boolean } = {}): Promise<void> {
  const { sas, verifier, req } = active;
  dropActive();
  // sasIncoming stays: the verifier's title is "Verify the other device" through the whole flow (S7)
  vset({ sasState: "cancelled", sasCanStart: false, sasNote: sasCancelText(opts.mismatch ? "m.mismatched_sas" : "m.user") });
  try {
    if (sas) {
      if (opts.mismatch) sas.mismatch();
      else sas.cancel();
    } else if (verifier) {
      verifier.cancel(new Error("User cancelled"));
    }
    if (req && requestOpen(req)) await req.cancel();
  } catch (e) {
    log.debug("[sas] cancel", e);
  }
}

/** UIA for key uploads: try without auth first (servers may allow the first upload), then password. */
function passwordUia(client: MatrixClient, password: string) {
  return async <T,>(makeRequest: (auth: Record<string, unknown> | null) => Promise<T>): Promise<T> => {
    try {
      return await makeRequest(null);
    } catch (e) {
      const err = e as { httpStatus?: number; data?: { session?: string; flows?: unknown } };
      if (err.httpStatus !== 401 || !err.data?.flows) throw e;
      return makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: client.getSafeUserId() },
        password,
        session: err.data.session,
      });
    }
  };
}

/**
 * Create recovery (and with it cross-signing) for an account that has never had it — the way
 * out of the "nothing can vouch for this device" dead end (native set_up_recovery).
 * Needs the account password (uploading cross-signing keys is a protected action). The new
 * Security Key lands in `recoveryKey` ONCE and is never stored.
 */
export async function setUpRecovery(password: string): Promise<void> {
  const client = peekClient();
  const crypto = client?.getCrypto();
  if (!client || !crypto) return;
  if (!password) {
    vset({ sasNote: "Enter your account password to continue." });
    return;
  }
  vstate("recovery-working", "Setting up recovery — this takes a few seconds…");
  const me = client.getSafeUserId();
  try {
    if (!(await crypto.userHasCrossSigningKeys(me, true))) {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: passwordUia(client, password) as never,
      });
      log.info("[recovery] cross-signing bootstrapped");
    }
  } catch (e) {
    log.warn("[recovery] cross-signing bootstrap failed", e);
    vstate("cancelled", `Could not set up verification: ${(e as Error)?.message ?? e}`);
    return;
  }
  try {
    const keyId = await client.secretStorage.getDefaultKeyId();
    if (keyId && (await crypto.isSecretStorageReady())) {
      const verified = await isDeviceVerified(client);
      log.info(`[recovery] already enabled; device_verified=${verified}`);
      vset({
        sasState: "recovery-done",
        recoveryKey: "",
        sasNote: "This device is verified. Your recovery was already set up, so there's no new key to save.",
      });
      void refreshCryptoStatus(0);
      return;
    }
    if (await crypto.getKeyBackupInfo()) {
      // Same rule as the native Recovery::enable(): it is for accounts WITHOUT a backup.
      vstate(
        "cancelled",
        "Could not set up recovery: a key backup already exists on the server — verify with your Security Key instead.",
      );
      return;
    }
    let generated: GeneratedSecretStorageKey | null = null;
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => (generated = await crypto.createRecoveryKeyFromPassphrase()),
      setupNewSecretStorage: true,
      setupNewKeyBackup: true,
    });
    await crypto.checkKeyBackupAndEnable();
    const key = (generated as GeneratedSecretStorageKey | null)?.encodedPrivateKey ?? "";
    const verified = await isDeviceVerified(client);
    log.info(`[recovery] enabled; device_verified_after=${verified}`);
    vset({
      recoveryKey: key,
      sasState: "recovery-done",
      sasNote: verified
        ? "Recovery is on and this device is verified. Save this key somewhere safe — it is shown once and cannot be retrieved later."
        : "Recovery is on and your key backup is set up — save the key below, it is shown once and cannot be retrieved later. This device still isn't fully verified: close this and open Verify this device again to finish.",
    });
    void refreshCryptoStatus(0);
  } catch (e) {
    log.warn("[recovery] enable failed", e);
    vstate("cancelled", `Could not set up recovery: ${(e as Error)?.message ?? e}`);
  } finally {
    secretStorageKeyCache.clear();
  }
}

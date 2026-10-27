// devhook.ts — `window.__tw` for tests and debugging. Installed in dev builds (import.meta.env.DEV), or when
// `window.__TW_DEBUG__ = true` was set by a test harness (tools/webshot.mjs does that, before the app loads). A URL can
// no longer install it in a production build (the "#twdebug" fragment did until the 2026-10-26 security review: a
// one-call SAS confirm etc. is no business of a link).
//
//   await __tw.login("tester1", "…")               // resolves when the session is "ready"
//   __tw.session() / __tw.client() / await __tw.info()
//   __tw.openRoom("!id:example.com")               // bus → shell
//   await __tw.logout()                            // ends the device on the server too
//
// tools/webshot.mjs drives sign-in through this (the password never enters the repo).
import { openRoom } from "@/core/bus";
import { armCrashProbe } from "@/ui/ErrorBoundary";
import { getFormFactor, isTouch } from "@/core/device";
import { listOwnedDatabases, peekClient } from "@/core/matrix/client";
import {
  acceptDeviceVerification,
  cancelDeviceVerification,
  confirmSasMatch,
  getCryptoStatus,
  getVerification,
  pinCryptoStatusForTest,
  refreshCryptoStatus,
  restoreFromSecurityKey,
  setUpRecovery,
  startDeviceVerification,
  startDeviceVerificationWith,
  startSasComparison,
} from "@/core/matrix/crypto";
import { getSession, loginWithPassword, logout, restoreSession, useSessionStore, DEFAULT_HOMESERVER } from "@/core/matrix/session";

export interface TwDebug {
  login(user: string, pass: string, hs?: string): Promise<{ userId?: string; deviceId?: string }>;
  logout(): Promise<void>;
  restore(): Promise<boolean>;
  client(): ReturnType<typeof peekClient>;
  session(): ReturnType<typeof getSession>;
  waitReady(timeoutMs?: number): Promise<boolean>;
  openRoom(roomId: string): void;
  rooms(): Array<{ roomId: string; name: string; membership: string; space: boolean }>;
  info(): Promise<Record<string, unknown>>;
  /** In-browser unit checks of core (selftest.ts). */
  selfTest(): Promise<Array<{ name: string; ok: boolean; detail?: string }>>;
  formFactor(): { formFactor: string; isTouch: boolean };
  /** Live round trips against the homeserver + the server's Tin Hat API (no room events): upload → download. */
  liveTest(): Promise<Array<{ name: string; ok: boolean; detail?: string }>>;
  /** Tests: throw during render — "app" (the recovery card, W1) or a place that armed a CrashProbe. */
  crashRender(where: string): void;
  /** E2EE helpers for gates (settings agent: VerifyDeviceDialog flows). */
  crypto: {
    status(): ReturnType<typeof getCryptoStatus>;
    refresh(): Promise<ReturnType<typeof getCryptoStatus>>;
    recover(securityKey: string): ReturnType<typeof restoreFromSecurityKey>;
    verification(): ReturnType<typeof getVerification>;
    startSas(): Promise<void>;
    startSasWith(deviceId: string): Promise<void>;
    acceptSas(): Promise<void>;
    confirmSas(): Promise<void>;
    cancelSas(mismatch?: boolean): Promise<void>;
    /** "Start emoji comparison" (S2) — through the S3 start guard. */
    startComparison(): Promise<void>;
    setUpRecovery(password: string): Promise<void>;
    /** Tests: lay fields over the computed status (e.g. { thisDeviceVerified: true }); null = off. */
    pinStatus(p: Partial<ReturnType<typeof getCryptoStatus>> | null): Promise<ReturnType<typeof getCryptoStatus>>;
  };
}

declare global {
  interface Window {
    __tw?: TwDebug;
  }
}

function waitReady(timeoutMs = 60000): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const s = getSession();
      if (s.state === "ready") return true;
      if (s.state === "error" || (s.state === "loggedOut" && s.status)) return false;
      return null;
    };
    const first = check();
    if (first !== null) return resolve(first);
    const t = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = useSessionStore.subscribe(() => {
      const r = check();
      if (r === null) return;
      clearTimeout(t);
      off();
      resolve(r);
    });
  });
}

function install() {
  if (typeof window === "undefined" || window.__tw) return;
  window.__tw = {
    async login(user, pass, hs = DEFAULT_HOMESERVER) {
      await loginWithPassword({ homeserver: hs, username: user, password: pass });
      await waitReady();
      const s = getSession();
      return { userId: s.userId, deviceId: s.deviceId };
    },
    logout: () => logout(),
    restore: () => restoreSession(),
    client: () => peekClient(),
    session: () => getSession(),
    waitReady,
    openRoom: (roomId) => openRoom(roomId),
    rooms: () =>
      (peekClient()?.getRooms() ?? []).map((r) => ({
        roomId: r.roomId,
        name: r.name,
        membership: r.getMyMembership(),
        space: r.isSpaceRoom(),
      })),
    selfTest: async () => (await import("@/core/selftest")).runCoreSelfTest(),
    formFactor: () => ({ formFactor: getFormFactor(), isTouch }),
    liveTest: async () => (await import("@/core/selftest")).runCoreLiveTest(),
    crashRender: (where) => armCrashProbe(where),
    crypto: {
      status: () => getCryptoStatus(),
      refresh: () => refreshCryptoStatus(0),
      recover: (key) => restoreFromSecurityKey(key),
      verification: () => getVerification(),
      startSas: () => startDeviceVerification(),
      startSasWith: (deviceId) => startDeviceVerificationWith(deviceId),
      acceptSas: () => acceptDeviceVerification(),
      confirmSas: () => confirmSasMatch(),
      cancelSas: (mismatch) => cancelDeviceVerification({ mismatch }),
      startComparison: () => startSasComparison(),
      setUpRecovery: (password) => setUpRecovery(password),
      pinStatus: (p) => pinCryptoStatusForTest(p),
    },
    async info() {
      const c = peekClient();
      return {
        session: getSession(),
        crypto: c ? await refreshCryptoStatus(0) : getCryptoStatus(),
        cryptoVersion: c?.getCrypto()?.getVersion(),
        databases: await listOwnedDatabases(),
        rooms: c?.getRooms().length ?? 0,
      };
    },
  };
}

const wanted = () =>
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof window !== "undefined" && (window as Window & { __TW_DEBUG__?: boolean }).__TW_DEBUG__ === true);

if (typeof window !== "undefined") {
  if (wanted()) install();
  else window.addEventListener("hashchange", () => wanted() && install());
}

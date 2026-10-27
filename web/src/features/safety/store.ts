// store.ts — account safety's requests and state (the rules + words: core/safety.ts; docs/ACCOUNT-SAFETY.md).
//   ignored list   m.ignored_user_list from the account data (sync keeps it current); ignore / stop ignoring read the
//                  server's copy first (another device may have changed it) and write it back with withIgnored
//   report         reportPlan: the Tin Hat Server's /api/reports when it takes reports from this account, else the
//                  Matrix report APIs; the first 2xx ends it
//   delete         deleteWith (POST /account/deactivate, erase, the password step), then a local sign-out that forgets
//                  the account (core/matrix logout: the stores, the account's keys)
// The desktop's settings.rs does the same through safety.rs.
import { useEffect, useState } from "react";
import { ClientEvent, type MatrixEvent } from "matrix-js-sdk";
import { create } from "zustand";
import { getAccessToken, getSession, logout, peekClient, useClient } from "@/core/matrix";
import { apiFetch, REPORTS_PATH } from "@/core/api";
import { MATRIX_ORIGIN } from "@/core/bearer";
import { guestNow, serverFeatureOn, serverOffer } from "@/core/server";
import { createLogger } from "@/core/log";
import { APP_VERSION } from "@/features/settings/logs";
import {
  IGNORED_TYPE,
  WORDS,
  abuseReport,
  deleteRefusal,
  deleteWith,
  ignoredUsers,
  reportPlan,
  withIgnored,
  type DeleteOutcome,
  type ReportTarget,
} from "@/core/safety";

const log = createLogger("safety");

/** The session a request belongs to, taken ONCE when an action starts: every request of it goes to that account's
 *  server with that account's token, and its follow-ups run only while that account is still the signed-in one (an
 *  answer that lands after a sign-out never acts for the next account). */
export interface Bound {
  user: string;
  hs: string;
  token: string;
}
export function bind(): Bound {
  const hs = getSession().hsUrl || peekClient()?.getHomeserverUrl() || MATRIX_ORIGIN;
  return { user: me(), hs: hs.replace(/\/+$/, ""), token: getAccessToken() ?? "" };
}
/** Is `b`'s account still the signed-in one? */
export const stillMe = (b: Bound) => !!b.user && me() === b.user && getAccessToken() === b.token;

/** One raw client-server request: {status, body} (null = no answer). Nothing of the body is logged. */
async function raw(b: Bound, method: "GET" | "PUT" | "POST", path: string, body?: unknown, timeoutMs = 20000): Promise<{ status: number; body: string } | null> {
  const token = b.token;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${b.hs}/_matrix/client/v3${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export const me = () => getSession().userId ?? peekClient()?.getUserId() ?? "";
/** The account's server name (the part after the first ":"), for "Reports go to the people who run …". */
export const serverName = () => me().replace(/^@[^:]*:/, "") || location.host;

// ---- ignore -------------------------------------------------------------------------------------------------------------

function ignoredNow(): string[] {
  const c = peekClient();
  return ignoredUsers(c?.getAccountData(IGNORED_TYPE as never)?.getContent());
}

/** The people I ignore (sorted), live. */
export function useIgnored(): string[] {
  const client = useClient();
  const [list, setList] = useState<string[]>(ignoredNow);
  useEffect(() => {
    if (!client) return;
    setList(ignoredNow());
    const on = (ev: MatrixEvent) => {
      if (ev.getType() === IGNORED_TYPE) setList(ignoredNow());
    };
    client.on(ClientEvent.AccountData, on);
    return () => void client.off(ClientEvent.AccountData, on);
  }, [client]);
  return list;
}

export function isIgnored(mxid: string): boolean {
  return ignoredNow().includes(mxid);
}

/** Ignore changes from this tab go one at a time (the GET-edit-PUT of one would undo another's). */
let ignoreChain: Promise<unknown> = Promise.resolve();

/** Ignore / stop ignoring. "" = done, else the words to show. */
export function setIgnored(mxid: string, ignore: boolean, b: Bound = bind()): Promise<string> {
  const run = ignoreChain.then(() => setIgnoredNow(mxid, ignore, b));
  ignoreChain = run.catch(() => undefined);
  return run;
}

async function setIgnoredNow(mxid: string, ignore: boolean, b: Bound): Promise<string> {
  if (!stillMe(b)) return WORDS.ignoreFailed;
  const path = `/user/${encodeURIComponent(b.user)}/account_data/${IGNORED_TYPE}`;
  const now = await raw(b, "GET", path);
  if (!now || (now.status !== 404 && (now.status < 200 || now.status >= 300))) return now ? WORDS.ignoreFailed : WORDS.unreachable;
  let content: unknown = {};
  if (now.status !== 404)
    try {
      content = JSON.parse(now.body);
    } catch {
      content = {};
    }
  const next = withIgnored(content, mxid, ignore);
  if (!stillMe(b)) return WORDS.ignoreFailed;
  const put = await raw(b, "PUT", path, next);
  if (!put) return WORDS.unreachable;
  if (put.status < 200 || put.status >= 300) {
    log.warn(`ignored list: HTTP ${put.status}`);
    return WORDS.ignoreFailed;
  }
  log.info(`ignored list: ${ignore ? "added" : "removed"} one (now ${ignoredUsers(next).length})`);
  return "";
}

// ---- report -------------------------------------------------------------------------------------------------------------

function platformLine(): string {
  const ua = navigator.userAgent;
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown";
  return `web (${br} on ${os})`;
}

/** Send a report; true = someone has it. */
export async function sendReport(target: ReportTarget, category: string, details: string, b: Bound = bind()): Promise<boolean> {
  const report = abuseReport({ reporter: b.user, target, category, details, platform: platformLine(), version: APP_VERSION });
  const plan = reportPlan({ tinhat: serverFeatureOn("reports"), report, target, category, details });
  for (const r of plan) {
    if (r.via === "tinhat") {
      try {
        const a = await apiFetch(REPORTS_PATH, { method: "POST", auth: true, bearer: b.token, json: r.body, timeoutMs: 20000 });
        if (a.ok) {
          log.info("report: taken (tinhat)");
          return true;
        }
        log.info(`report: tinhat said HTTP ${a.status}`);
      } catch {
        log.info("report: tinhat no answer");
      }
      continue;
    }
    const a = await raw(b, "POST", r.path, r.body);
    if (a && a.status >= 200 && a.status < 300) {
      log.info("report: taken (matrix)");
      return true;
    }
    log.info(`report: matrix said ${a ? `HTTP ${a.status}` : "nothing"}`);
  }
  return false;
}

// ---- delete my account ----------------------------------------------------------------------------------------------------

/** Why this account can't be deleted from here ("" = it can). */
export function deleteRefusalNow(): string {
  return deleteRefusal(me(), serverOffer().owner, guestNow());
}

/** Delete the account (erase), every request bound to the account it started in. On "deleted" the caller closes its
 *  dialog, then calls finishDeleted(b). */
export async function deleteMyAccount(password: string, b: Bound = bind()): Promise<DeleteOutcome> {
  if (deleteRefusal(b.user, serverOffer().owner, guestNow())) return { kind: "failed", text: deleteRefusalNow() };
  const out = await deleteWith((body) => raw(b, "POST", "/account/deactivate", body, 60000), b.user, password);
  log.info(`delete: ${out.kind}`);
  return out;
}

/** After a deletion of `b`'s account: every token is dead (the server signed every device out) — end here and forget
 *  the account (the stores, the account's keys); the sign-in screen says "Your account has been deleted." The sync's
 *  rejected token may have signed out first: then only the words change. Never touches another account that signed in
 *  meanwhile. */
export function finishDeleted(b: Bound): Promise<void> {
  const now = me();
  if (now && now !== b.user) return Promise.resolve();
  return logout({ server: false, status: WORDS.deleteDone, byUser: true });
}

// ---- the dialogs' state (SafetyHost renders them) --------------------------------------------------------------------------

export interface SafetyUi {
  ignore: { userId: string; name: string } | null;
  report: { target: ReportTarget; name: string } | null;
  openIgnore: (userId: string, name: string) => void;
  openReport: (target: ReportTarget, name: string) => void;
  close: () => void;
}

export const useSafetyUi = create<SafetyUi>((set) => ({
  ignore: null,
  report: null,
  openIgnore: (userId, name) => set({ ignore: { userId, name }, report: null }),
  openReport: (target, name) => set({ report: { target, name }, ignore: null }),
  close: () => set({ ignore: null, report: null }),
}));

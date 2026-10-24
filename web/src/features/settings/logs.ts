// logs.ts — log sharing (logship.rs), bug reports (settings.rs submit_bug_report + logship.rs) and
// diagnostics reports (diagnostics.rs) for the browser.
//
// The native ships its previous session's log FILE; the web keeps the scrubbed in-app log ring
// (@/core/log) mirrored into IndexedDB `tinhat-web-log` (≤ 2 MB, rotated at start), so the
// previous session's text is there on the next start. Uploads go through the same-origin /api: a Tin Hat Server's
// POST /api/reports (bearer; docs/SELFHOST.md), or the hub's relays (D14: /api/logship/upload/<name> and
// /api/reports/api/reports).
import { getLogLines, onLog, scrub, type LogLine } from "@/core/log";
import { getPref, setPref } from "@/core/prefs";
import { REPORTS_PATH, apiFetch } from "@/core/api";
import { SERVER_LABEL } from "@/core/bearer";
import { getSession } from "@/core/matrix";
import { createLogger } from "@/core/log";

const log = createLogger("logship");
/** the release version (package.json, via vite.config.ts) */
export const APP_VERSION: string = (import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev";
export const BUILD_HASH: string = (import.meta.env.VITE_BUILD_HASH as string | undefined) || "dev";
const MAX_BYTES = 2 * 1024 * 1024;

// ---- scrub (diagnostics redact() + IPs) ------------------------------------------------------

const SECRET_WORDS = /(access_token|password|secret|jwt|recovery|media key|sender_key)/i;

export function redactLine(line: string): string {
  let s = scrub(line);
  const m = SECRET_WORDS.exec(s);
  if (m) s = s.slice(0, m.index + m[0].length) + " [redacted]";
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)*/g, "[redacted]");
  s = s.replace(/\bsyt_[A-Za-z0-9_]+/g, "[redacted]");
  s = s.replace(/\b(?=[A-Za-z0-9+/_-]{24,})(?=[^\s]*\d)(?=[^\s]*[A-Z])[A-Za-z0-9+/_=-]{24,}\b/g, "[redacted]");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]");
  s = s.replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi, (x) => (/[0-9a-f]:[0-9a-f]/i.test(x) && x.split(":").length > 3 ? "[ip]" : x));
  return s;
}

export function formatLines(lines: readonly LogLine[]): string {
  return lines.map((l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.tag}] ${redactLine(l.text)}`).join("\n");
}

// ---- persistence (IndexedDB tinhat-web-log) --------------------------------------------------

const DB = "tinhat-web-log";

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("logs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// Every operation opens, uses and CLOSES its own connection: an open connection would block the
// deleteDatabase() that sign-out runs (wipeLogStore).
async function idbGet(key: string): Promise<string | undefined> {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("logs", "readonly").objectStore("logs").get(key);
    tx.onsuccess = () => (db.close(), res(tx.result as string | undefined));
    tx.onerror = () => (db.close(), res(undefined));
  });
}

async function idbPut(key: string, value: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((res) => {
    const tx = db.transaction("logs", "readwrite");
    tx.objectStore("logs").put(value, key);
    tx.oncomplete = () => (db.close(), res());
    tx.onerror = () => (db.close(), res());
  });
}

let previousLog: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let offLog: (() => void) | null = null;

function capped(text: string): string {
  return text.length > MAX_BYTES ? text.slice(text.length - MAX_BYTES) : text;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void idbPut("current", capped(formatLines(getLogLines()))).catch(() => undefined);
  }, 10000);
}

/** Rotate at start: last session's log → "previous"; mirror this session from now on. */
export async function startLogPersistence(): Promise<void> {
  if (started || typeof indexedDB === "undefined") return;
  started = true;
  try {
    const prev = await idbGet("current");
    previousLog = prev ?? "";
    await idbPut("previous", previousLog);
  } catch (e) {
    log.debug("log store unavailable", e);
  }
  offLog = onLog(persistSoon);
}

addEventListener("pagehide", () => {
  if (started) void idbPut("current", capped(formatLines(getLogLines()))).catch(() => undefined);
});

/** Sign-out: the next person at this browser must not find this account's (scrubbed) log. Stop
 *  mirroring and delete the `tinhat-web-log` database; the next sign-in starts a fresh one. */
export function wipeLogStore(): void {
  started = false;
  previousLog = null;
  offLog?.();
  offLog = null;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  try {
    indexedDB.deleteDatabase(DB);
  } catch {
    /* no IndexedDB */
  }
}

export async function getPreviousLog(): Promise<string> {
  if (previousLog !== null) return previousLog;
  try {
    return (await idbGet("previous")) ?? "";
  } catch {
    return "";
  }
}

// ---- consent (tri-state) ---------------------------------------------------------------------

/** Log shipping needs the same-origin `/api/logship/…` relay. Integration deliberately did NOT add it
 *  (it would open the token-fenced log receiver to anyone — INTEGRATION.md, pending an owner decision), so the web
 *  build ships with log sharing OFF: no consent prompt, no previous-session upload, the Privacy
 *  checkbox is disabled with a one-line reason, and bug reports go out without a log attachment.
 *  Flip to true once the relay exists (docs/web-exceptions/settings.md). */
export const LOGSHIP_ENABLED = false;

/** -1 never asked · 0 no · 1 yes (pref `logship`). */
export function logshipState(): -1 | 0 | 1 {
  const v = getPref("logship", "");
  return v === "1" ? 1 : v === "0" ? 0 : -1;
}
export function applyLogship(on: boolean): void {
  setPref("logship", on ? "1" : "0");
}

function localpartOf(uid: string) {
  return uid.replace(/^@/, "").split(":")[0] || "unknown";
}

function osName(): string {
  const ua = navigator.userAgent;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const plat = uad?.platform || (/Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown");
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `web (${br} on ${plat})`;
}

async function putLog(name: string, body: string): Promise<boolean> {
  const r = await apiFetch(`/logship/upload/${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-TinHat-Version": APP_VERSION },
    timeoutMs: 30000,
  });
  return r.ok;
}

/** SET-70: previous-session upload at start when consent = 1 (fire-and-forget). */
export async function shipPreviousLog(): Promise<void> {
  if (!LOGSHIP_ENABLED || logshipState() !== 1) return;
  const text = await getPreviousLog();
  if (!text.trim()) return;
  const uid = getSession().userId ?? "";
  try {
    const ok = await putLog(`${localpartOf(uid)}-${Math.floor(Date.now() / 1000)}.log`, text);
    log.info(`previous-session log ${ok ? "shipped" : "refused"} (${text.length} bytes)`);
  } catch (e) {
    log.info("previous-session log upload failed", (e as Error)?.message);
  }
}

// ---- bug report (SET-105) --------------------------------------------------------------------

export async function submitBugReport(note: string): Promise<string> {
  const uid = getSession().userId ?? "";
  const os = osName();
  const live = formatLines(getLogLines());
  const prev = await getPreviousLog();
  const provenance = `live ring buffer of this tab (${getLogLines().length} lines)${prev ? " + previous session tail" : ""}`;
  const first = note.trim().split("\n")[0].slice(0, 160);
  let ticket = "";
  try {
    // the Tin Hat Server files the report under the signed-in account (bearer)
    const r = await apiFetch(REPORTS_PATH, {
      method: "POST",
      auth: true,
      json: {
        type: "bug",
        title: `[in-app] ${first}`,
        body: LOGSHIP_ENABLED
          ? `${note}\n\n— submitted from the ${os} app (${APP_VERSION}); full session log attached.\nlog provenance: ${provenance}`
          : `${note}\n\n— submitted from the ${os} app (${APP_VERSION}); no log attached (the web app can't share logs yet).`,
        platform: os,
        version: `U0.1.0 (${APP_VERSION})`,
        reporter: uid,
      },
      timeoutMs: 20000,
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { id?: string };
      ticket = j.id ?? "";
    }
  } catch (e) {
    log.info("report ticket failed", (e as Error)?.message);
  }
  const body =
    `=== BUG REPORT from ${uid} (app v${APP_VERSION}, ${os}) ===\n${note}\n\n` +
    `=== live session log tail (${Math.round(live.length / 1024)} KB, scrubbed; ${provenance}) ===\n${live}` +
    (prev ? `\n\n=== previous session log tail (scrubbed) ===\n${prev.slice(-512 * 1024)}` : "");
  let uploaded = false;
  if (LOGSHIP_ENABLED) try {
    uploaded = await putLog(`${localpartOf(uid)}-bugreport-${Math.floor(Date.now() / 1000)}${ticket ? `-${ticket.replace(/-/g, "")}` : ""}.log`, body);
  } catch (e) {
    log.info("report log upload failed", (e as Error)?.message);
  }
  if (ticket) return `Report sent — tracked as ${ticket} on ${SERVER_LABEL}.`;
  if (uploaded) return "Report sent — thank you! It landed in the problem repo.";
  throw new Error("the report server couldn't be reached");
}

// ---- diagnostics (SET-67) --------------------------------------------------------------------

const CALL_PREFS = [
  "call-input",
  "call-output",
  "call-camera",
  "mic-echo-cancel",
  "mic-agc",
  "mic-ns-mode",
  "push-to-talk",
  "share-quality",
  "cam-quality",
  "recv-quality",
  "music-source",
  "record-optout",
  "snd.volume",
];

function codecs(kind: "audio" | "video"): string {
  try {
    const c = RTCRtpSender.getCapabilities(kind);
    return [...new Set((c?.codecs ?? []).map((x) => x.mimeType.replace(/^.*\//, "")))].join(", ");
  } catch {
    return "unknown";
  }
}

export function buildDiagnosticsReport(): string {
  const uid = getSession().userId ?? "";
  const lines = getLogLines().slice(-3000);
  const env = [
    `app: Tin Hat Web ${APP_VERSION} (${BUILD_HASH})`,
    `user agent: ${navigator.userAgent}`,
    `platform: ${osName()}`,
    `language: ${navigator.language}`,
    `screen: ${screen.width}x${screen.height} @${devicePixelRatio}x, window ${innerWidth}x${innerHeight}`,
    `cores: ${navigator.hardwareConcurrency ?? "?"}  memory: ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "?"} GB`,
    `WebRTC video codecs: ${codecs("video")}`,
    `WebRTC audio codecs: ${codecs("audio")}`,
    `Document Picture-in-Picture: ${"documentPictureInPicture" in window ? "yes" : "no"}`,
    `setSinkId: ${typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype ? "yes" : "no"}`,
    `notifications: ${typeof Notification === "undefined" ? "unsupported" : Notification.permission}`,
  ];
  const calls = CALL_PREFS.map((k) => `${k} = ${String(getPref(k, "")) || "(default)"}`);
  return [
    `=== Tin Hat diagnostics report ===`,
    `created ${new Date().toISOString()} for ${uid}`,
    `Nothing in this file was sent anywhere. Tokens, keys and IP addresses are stripped out.`,
    ``,
    `--- environment ---`,
    ...env,
    ``,
    `--- call settings ---`,
    ...calls,
    ``,
    `--- app log (last ${lines.length} lines, redacted) ---`,
    formatLines(lines),
    ``,
  ].join("\n");
}

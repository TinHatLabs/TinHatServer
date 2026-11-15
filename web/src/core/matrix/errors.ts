// errors.ts — user-presentable wording for Matrix / network failures (ported from the native
// bridge.rs `friendly_login_error` + `matrix_error_message`, 10.1 TH-FIRST-02 / TH-COPY-07).
// Every function returns ONE sentence a person can act on; the raw text goes to the log.
import { createLogger } from "../log"; // (relative: errors.test.ts loads this file in Node)

const log = createLogger("login");

/** errcode + error of a thrown js-sdk MatrixError / fetch failure / anything. */
export function errParts(e: unknown): { errcode: string; message: string; status?: number; body?: unknown } {
  const any = e as { errcode?: string; data?: { errcode?: string; error?: string }; httpStatus?: number; message?: string; name?: string };
  const errcode = any?.errcode ?? any?.data?.errcode ?? "";
  const message = any?.data?.error ?? any?.message ?? String(e);
  return { errcode, message, status: any?.httpStatus, body: any?.data };
}

const hasAny = (l: string, words: string[]) => words.some((w) => l.includes(w));
/** A status as its own number in the text, never part of a longer number, a port (":429", ":4290") nor an address
 *  ("https://host:503/"). */
const hasStatus = (l: string, codes: string[]) =>
  l
    .split(/\s+/)
    .filter((w) => !w.includes("://"))
    .some((w) => [...w.matchAll(/(^|[^0-9])([0-9]+)/g)].some((m) => m[1] !== ":" && codes.includes(m[2]))); // ":429" is a port
const hasServerStatus = (l: string) => hasStatus(l, ["500", "502", "503", "504"]);

/**
 * The sign-in card's sentence for the raw failure text (D08.6 / D08.5; the desktop's login_errors.rs
 * friendly_login_text, the same rules — testvectors/login-errors.json is byte-identical on both sides). Pure.
 * Order matters: a certificate failure is named before the connection words, the server's own gateway errors before
 * the timeout words, and a bare "403 Forbidden" (no Matrix errcode) is not a wrong password. Never the raw text.
 */
export function friendlyLoginText(raw: string): string {
  const l = raw.toLowerCase();
  if (hasAny(l, ["m_forbidden", "invalid username", "invalid password"])) return "Wrong username or password.";
  if (hasAny(l, ["m_limit_exceeded", "too many"]) || hasStatus(l, ["429"])) return "Too many attempts — wait a minute and try again.";
  if (l.includes("m_user_deactivated")) return "That account has been deactivated.";
  if (l.includes("m_user_locked")) return "That account is locked — ask whoever runs the server.";
  if (l.includes("m_user_suspended")) return "That account is suspended — ask whoever runs the server.";
  // a certificate the checks refused; a TLS negotiation failure ("fatal alert: HandshakeFailure") is no trust problem
  // (the server asking for a CLIENT certificate, "CertificateRequired", is no trust problem either)
  if (hasAny(l, ["certificate", "unknownissuer", "notvalidyet"]) && !l.includes("certificaterequired")) {
    return hasAny(l, ["expired", "notvalidyet", "not valid yet", "not yet valid"])
      ? "The server's certificate looks out of date — check that this device's date and time are right."
      : "The server's certificate isn't trusted on this machine.";
  }
  if (hasAny(l, ["dns", "resolve", "no such host", "name_not_resolved", "failed to lookup address"])) return "Can't find that server — check the address.";
  if (hasAny(l, ["bad gateway", "service unavailable", "gateway timeout", "internal server error"])) {
    return "The server is having trouble right now — try again in a few minutes.";
  }
  if (hasAny(l, ["failed to fetch", "networkerror", "load failed", "timed out", "timeout", "connection refused", "unreachable", "connect", "network"])) {
    return "Can't reach the server — check your connection and the address.";
  }
  if (hasServerStatus(l)) return "The server is having trouble right now — try again in a few minutes.";
  if (hasAny(l, ["not a valid homeserver", "well-known", "unsupported", "m_unrecognized"])) return "That doesn't look like a Matrix server.";
  if (l.includes("forbidden")) return "The server refused to sign you in — check the address, or ask whoever runs it.";
  return "Sign-in didn't work — try again in a moment.";
}

/** A14.6: the request never reached `server` (create account, reset): one sentence, the raw failure in the log. */
export function unreachableText(server: string): string {
  const who = server.trim() || "the server";
  return `Couldn't reach ${who} — check your connection and the address.`;
}

/** bridge.rs friendly_login_error — the sign-in card's one-liner (the raw text goes to the log). */
export function friendlyLoginError(e: unknown): string {
  const { errcode, message, status } = errParts(e);
  const raw = `${errcode} ${message} ${status ?? ""}`;
  log.warn(raw);
  return friendlyLoginText(raw);
}

/**
 * bridge.rs matrix_error_message — the `error` of a Matrix error body with the two wordings
 * people actually hit rewritten; undefined when there is no error text (e.g. a UIA challenge).
 */
export function matrixErrorMessage(body: unknown): string | undefined {
  const v = body as { error?: unknown; errcode?: unknown } | null;
  const msg = typeof v?.error === "string" ? v.error.trim() : "";
  if (!msg) return undefined;
  const errcode = typeof v?.errcode === "string" ? v.errcode : "";
  if (msg.includes("validated threepid")) {
    return "Open the link in the email first — including the confirm button on the page it opens — then set your password here.";
  }
  if (errcode === "M_THREEPID_NOT_FOUND") return "No account is using that email address.";
  return msg;
}

/** A thrown Error whose message is safe to show as-is. */
export class UserFacingError extends Error {
  // (a plain field, not a constructor parameter property: errors.test.ts loads this file under Node type stripping)
  readonly errcode?: string;
  constructor(message: string, errcode?: string) {
    super(message);
    this.name = "UserFacingError";
    this.errcode = errcode;
  }
}

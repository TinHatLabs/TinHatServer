// errors.ts — user-presentable wording for Matrix / network failures (ported from the native
// bridge.rs `friendly_login_error` + `matrix_error_message`, 10.1 TH-FIRST-02 / TH-COPY-07).
// Every function returns ONE sentence a person can act on; the raw text goes to the log.
import { createLogger } from "@/core/log";

const log = createLogger("login");

/** errcode + error of a thrown js-sdk MatrixError / fetch failure / anything. */
export function errParts(e: unknown): { errcode: string; message: string; status?: number; body?: unknown } {
  const any = e as { errcode?: string; data?: { errcode?: string; error?: string }; httpStatus?: number; message?: string; name?: string };
  const errcode = any?.errcode ?? any?.data?.errcode ?? "";
  const message = any?.data?.error ?? any?.message ?? String(e);
  return { errcode, message, status: any?.httpStatus, body: any?.data };
}

/** bridge.rs friendly_login_error — the sign-in card's one-liner. */
export function friendlyLoginError(e: unknown): string {
  const { errcode, message, status } = errParts(e);
  const raw = `${errcode} ${message} ${status ?? ""}`;
  log.warn(raw);
  const l = raw.toLowerCase();
  if (l.includes("m_forbidden") || l.includes("invalid username") || l.includes("invalid password") || l.includes("forbidden")) {
    return "Wrong username or password.";
  }
  if (l.includes("m_limit_exceeded") || status === 429 || l.includes("too many")) {
    return "Too many attempts — wait a minute and try again.";
  }
  if (l.includes("m_user_deactivated")) return "That account has been deactivated.";
  if (l.includes("dns") || l.includes("resolve") || l.includes("no such host") || l.includes("name_not_resolved")) {
    return "Can't find that server — check the address.";
  }
  if (
    l.includes("failed to fetch") ||
    l.includes("networkerror") ||
    l.includes("load failed") ||
    l.includes("timed out") ||
    l.includes("timeout") ||
    l.includes("connection refused") ||
    l.includes("unreachable") ||
    l.includes("connect") ||
    l.includes("network")
  ) {
    return "Can't reach the server — check your connection and the address.";
  }
  if (l.includes("certificate") || l.includes("tls") || l.includes("ssl")) {
    return "The server's certificate isn't trusted on this machine.";
  }
  if (l.includes("not a valid homeserver") || l.includes("well-known") || l.includes("unsupported") || l.includes("m_unrecognized")) {
    return "That doesn't look like a Matrix server.";
  }
  return `Sign-in failed: ${message}`;
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
  constructor(message: string, readonly errcode?: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

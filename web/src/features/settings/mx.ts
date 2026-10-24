// mx.ts — raw client-server calls this area makes exactly like the native (settings.rs / bridge.rs):
// extended profile fields (MSC4133 on /v3), 3PIDs, devices, push rules. matrix-js-sdk wraps some
// of these behind unstable prefixes; the native talks plain /_matrix/client/v3, so do we.
import { getAccessToken, getSession, peekClient } from "@/core/matrix";
import { MATRIX_ORIGIN } from "@/core/bearer";

export class MxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errcode: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MxError";
  }
}

function base(): string {
  const hs = getSession().hsUrl || peekClient()?.getHomeserverUrl() || MATRIX_ORIGIN;
  return hs.replace(/\/+$/, "");
}

/** Authenticated request to `/_matrix/client/v3<path>`; JSON in, JSON out; throws MxError. */
export async function mx<T = Record<string, unknown>>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: { prefix?: string; timeoutMs?: number; auth?: boolean } = {},
): Promise<T> {
  const token = getAccessToken();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${base()}${opts.prefix ?? "/_matrix/client/v3"}${path}`, {
      method,
      headers: {
        ...(opts.auth === false || !token ? {} : { Authorization: `Bearer ${token}` }),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      throw new MxError(String(json.error ?? `HTTP ${res.status}`), res.status, String(json.errcode ?? ""), json);
    }
    return json as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new MxError("The server didn't answer in time.", 0, "", {});
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const enc = encodeURIComponent;

export function myUserId(): string {
  return getSession().userId ?? peekClient()?.getUserId() ?? "";
}

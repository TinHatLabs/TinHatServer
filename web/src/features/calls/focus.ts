// focus.ts — which call service (the LiveKit JWT broker) new calls use: the one the user's server names in its
// .well-known/matrix/client (a Tin Hat Server names its own), else the build's default call service (rtc.ts wellKnownFocusUrl → calls/util defaultFocusUrl). Pure, so
// the desktop replays the same cases: crates/app/src/rtc.rs focus_from_wellknown ↔ focus.test.ts.

/** The call JWT service a .well-known/matrix/client names: its first org.matrix.msc4143.rtc_foci entry of type livekit
 *  with a livekit_service_url, else null. */
export function focusFromWellKnown(wk: unknown): string | null {
  const foci = wk && typeof wk === "object" ? (wk as Record<string, unknown>)["org.matrix.msc4143.rtc_foci"] : undefined;
  if (!Array.isArray(foci)) return null;
  for (const f of foci) {
    if (!f || typeof f !== "object") continue;
    const { type, livekit_service_url: url } = f as Record<string, unknown>;
    if (type === "livekit" && typeof url === "string" && url) return url;
  }
  return null;
}

/** 12.1.9: the waits before each .well-known read: now, +1 s, +3 s. Desktop: rtc.rs FOCUS_READ_WAITS_MS. */
export const WELL_KNOWN_WAITS_MS: readonly number[] = [0, 1000, 3000];

/** 12.1.9 (assembly-044 observation): the document in an answer, or null for a failure. Only a 2xx whose body is a JSON
 *  object is a document; any other status (a 404 or 5xx in the middle of a server update too) or a body that isn't a
 *  JSON object is a failure: retried, never remembered as "names no call service". Desktop: rtc.rs focus_read_of. */
export function wellKnownAnswer(status: number, body: unknown): Record<string, unknown> | null {
  if (!(status >= 200 && status < 300)) return null;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** What wellKnownReader needs of an answer (a fetch Response fits). */
export interface WellKnownResponse {
  status: number;
  json(): Promise<unknown>;
}

/** 12.1.9: the page's .well-known reader: a document is kept for the page's life; a failure (wellKnownAnswer, or a body
 *  that doesn't parse) is not, so the next caller asks again. Callers share a read in flight; a failed read never
 *  clears a newer one. Desktop: rtc.rs resolve_focus (its run cache). */
export function wellKnownReader(get: () => Promise<WellKnownResponse>): () => Promise<Record<string, unknown> | null> {
  let memo: Promise<Record<string, unknown> | null> | null = null;
  return () => {
    if (!memo) {
      const p: Promise<Record<string, unknown> | null> = get()
        .then(async (r) => {
          const doc = wellKnownAnswer(r.status, r.status >= 200 && r.status < 300 ? await r.json() : null);
          if (!doc) throw new Error(`well-known ${r.status}`);
          return doc;
        })
        .catch(() => {
          if (memo === p) memo = null;
          return null;
        });
      memo = p;
    }
    return memo;
  };
}

/** 12.1.9: up to waits.length reads, each after its wait; the first document wins, null = every read failed (the
 *  caller falls back, nothing is remembered). Desktop: rtc.rs focus_read_retried. */
export async function firstWellKnown<T>(
  read: () => Promise<T | null>,
  waits: readonly number[],
  sleep: (ms: number) => Promise<unknown>,
): Promise<T | null> {
  for (const wait of waits) {
    if (wait > 0) await sleep(wait);
    const d = await read();
    if (d) return d;
  }
  return null;
}

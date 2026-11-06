// captureflow.ts — Pad Watch Layer 2: the lease-checked shape of the app's capture / publish sequences (engine.ts and
// extras.ts run them with the real platform calls; capturelease-escapes.test.ts drives the same functions through each
// Astra round-3 escape). Rules (DESIGN §2.1): every resource is held by the lease the moment the platform returns it,
// every await is followed by a check, the caller commits synchronously right before it stores the result.
import type { Lease } from "./capturelease";

export const REVOKED_TEXT = "watching — stopped at the Watch press";
export class Revoked extends Error {
  constructor() {
    super(REVOKED_TEXT);
    this.name = "Revoked";
  }
}

/** Throw Revoked unless the lease is still valid (its resources were stopped by the revoke itself). */
export function check(lease: Lease): void {
  if (!lease.valid()) throw new Revoked();
}

/** Await a platform acquisition; what it returns is held by the lease at once — or stopped, and Revoked thrown. */
export async function held<T>(lease: Lease, p: Promise<T>, stop: (t: T) => void): Promise<T> {
  const t = await p;
  if (!lease.hold(() => stop(t))) throw new Revoked();
  return t;
}

/**
 * Start a platform capture under the lease (round 6, parity with the desktop's start_under): the lease is checked and
 * marked IN THE SAME TICK as the platform call — nothing can run between them — so a Watch press any time before means
 * the call is never made; what it returns is held at once (or stopped and Revoked thrown). `beforeStart` (tests: a pause
 * injected where earlier steps end) runs BEFORE the check, never between the check and the call.
 */
export async function startUnder<T>(lease: Lease, start: () => Promise<T>, stop: (t: T) => void, beforeStart?: () => Promise<void>): Promise<T> {
  if (beforeStart) await beforeStart();
  if (!lease.beginStart()) throw new Revoked();
  const p = start();
  const t = await p;
  if (!lease.endStart() || !lease.hold(() => stop(t))) {
    stop(t);
    throw new Revoked();
  }
  return t;
}

/** Await any other step of the operation, then check the lease. */
export async function step<T>(lease: Lease, p: Promise<T>): Promise<T> {
  const v = await p;
  check(lease);
  return v;
}

/** The microphone (call mic and meters): capture → (optional) processor setup. The track comes back held by the lease;
 *  the caller commits it. */
export async function micFlow<T>(lease: Lease, d: { capture(): Promise<T>; stop(t: T): void; setup?(t: T): Promise<void>; beforeStart?(): Promise<void> }): Promise<T> {
  const t = await startUnder(lease, () => d.capture(), d.stop, d.beforeStart);
  if (d.setup) await step(lease, d.setup(t));
  return t;
}

/** A screen share: the picker → fit the track → publish. A revoke during the publish unpublishes it again. */
export async function screenFlow<S, P>(
  lease: Lease,
  d: { display(): Promise<S>; stopAll(s: S): void; fit(s: S): Promise<void>; publish(s: S): Promise<P>; unpublish(p: P): Promise<void> },
): Promise<{ stream: S; pub: P }> {
  const stream = await startUnder(lease, () => d.display(), d.stopAll);
  await step(lease, d.fit(stream));
  const pub = await d.publish(stream);
  if (!lease.hold(() => void d.unpublish(pub).catch(() => undefined))) throw new Revoked();
  return { stream, pub };
}

/** The connection test's probe: uplink → token → connect → publish the pattern. Nothing after a revoke. */
export async function probeFlow<R>(
  lease: Lease,
  d: { uplink(): Promise<void>; token(): Promise<unknown>; connect(tok: unknown): Promise<R>; disconnect(r: R): void; publish(r: R): Promise<void> },
): Promise<R> {
  check(lease);
  await step(lease, d.uplink());
  const tok = await step(lease, d.token());
  const room = await startUnder(lease, () => d.connect(tok), d.disconnect);
  await step(lease, d.publish(room));
  return room;
}

// abortable.ts — voice notes: a startup await that a cancel can end (docs/VOICE-NOTES.md §2 "States"). The recorder's
// start awaits things nobody can interrupt — an unanswered permission prompt, a worklet or RNNoise load — and the
// store's release barrier (the next recording, the call join) waits for the start to let go. On abort the promise
// rejects at once; whatever the platform hands over LATER goes to `lateStop` the moment it arrives, so it is cleaned up
// instead of leaking. Pure (abortable.test.ts).

export class StartCancelled extends Error {
  constructor() {
    super("cancelled while starting");
    this.name = "StartCancelled";
  }
}

export function abortable<T>(p: Promise<T>, signal?: AbortSignal, lateStop?: (t: T) => void): Promise<T> {
  if (!signal) return p;
  const late = (t: T) => {
    try {
      lateStop?.(t);
    } catch {
      /* every late resource gets its stop */
    }
  };
  if (signal.aborted) {
    p.then(late, () => undefined);
    return Promise.reject(new StartCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      reject(new StartCancelled());
      p.then(late, () => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (t) => {
        signal.removeEventListener("abort", onAbort);
        if (done) return; // (already rejected: onAbort's own then() stops it)
        done = true;
        resolve(t);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        if (done) return;
        done = true;
        reject(e);
      },
    );
  });
}

/** The RNNoise fallback: the browser's own noise suppression on the track (the user asked for suppression), as an
 *  abortable await — a constraints change that never answers must not hold the start (and the release barrier). A
 *  failure of the change itself is not fatal (recording goes on without it). */
export function browserNoiseFallback(track: { applyConstraints(c: MediaTrackConstraints): Promise<void> }, signal?: AbortSignal): Promise<void> {
  return abortable(
    track.applyConstraints({ noiseSuppression: true }).catch(() => undefined),
    signal,
  );
}

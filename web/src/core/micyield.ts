// micyield.ts — one owner of the microphone at a time (docs/VOICE-NOTES.md §2 "Calls"): a feature that records outside a
// call (the voice-note recorder) registers how it lets go; the call join awaits releaseMicForCall() — bounded — before it
// opens its own capture. Pure, no imports: features meet here instead of importing each other.
//
//   onMicYield((ms) => stopRecordingIntoReview(ms));   // the recorder (returns the unsubscribe)
//   await releaseMicForCall();                          // the call join, before its microphone
type Yield = (timeoutMs: number) => Promise<void>;
const owners = new Set<Yield>();

export function onMicYield(f: Yield): () => void {
  owners.add(f);
  return () => {
    owners.delete(f);
  };
}

/** Every registered recorder lets go of the microphone; resolves when they all have, or after `timeoutMs`. */
export async function releaseMicForCall(timeoutMs = 2000): Promise<void> {
  if (owners.size === 0) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...owners].map((f) => f(timeoutMs).catch(() => undefined))),
    new Promise<void>((r) => (t = setTimeout(r, timeoutMs))),
  ]);
  if (t) clearTimeout(t);
}

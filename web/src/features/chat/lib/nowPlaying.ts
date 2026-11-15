// nowPlaying.ts — one player at a time (QOL A00.1). A voice note, an audio clip or a video that starts playing pauses
// the one that was playing, and starting a recording pauses whatever plays (timeline audio must not bleed into the mic).
// SHARED LOGIC: npStep is the desktop's NowPlaying.qml npStep, rule for rule; both replay
// testvectors/now-playing/vectors.json. React players use useNowPlaying (./useNowPlaying.ts).

export type NpState = { cur: string | null };
export type NpOp = { play?: string; end?: string; record?: boolean };

/** One step of the rule: {st, pause} where pause = the player id to pause, or null. */
export function npStep(st: NpState, op: NpOp): { st: NpState; pause: string | null } {
  const cur = st && st.cur ? st.cur : null;
  if (op && typeof op.play === "string") return { st: { cur: op.play }, pause: cur && cur !== op.play ? cur : null };
  if (op && typeof op.end === "string") return { st: { cur: cur === op.end ? null : cur }, pause: null };
  if (op && op.record === true) return { st: { cur: null }, pause: cur };
  return { st: { cur }, pause: null };
}

const pausers = new Map<string, () => void>();
let state: NpState = { cur: null };
let seq = 0;

function apply(op: NpOp): void {
  const r = npStep(state, op);
  state = r.st;
  if (r.pause) pausers.get(r.pause)?.();
}

/** A fresh id for one player instance (the same event can be on screen twice). */
export function newPlayerId(kind: string): string {
  return `${kind}:${++seq}`;
}
/** Register how to pause player `id`; the returned function forgets it (unmount). */
export function registerPlayer(id: string, pause: () => void): () => void {
  pausers.set(id, pause);
  return () => {
    pausers.delete(id);
    apply({ end: id });
  };
}
export function playing(id: string): void {
  apply({ play: id });
}
export function stopped(id: string): void {
  apply({ end: id });
}
/** A recording is about to start: pause whatever plays. */
export function recording(): void {
  apply({ record: true });
}
export const nowPlaying = { playing, stopped, recording };

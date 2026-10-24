// elect.ts — Same room (Tin Hat 11.3): the room-mic election and the raw-level tracker. PURE: no DOM, no
// store, no network — the desktop runs the same rules (crates/streamer/src/sameroom/elect.rs) and both run
// the shared vectors.json. See docs/SAME-ROOM.md.
//
// Linked members (two laptops in one room) each measure their RAW mic (before echo cancellation / noise
// suppression / gain) as "signal above the mic's own noise floor" (SNR dB) and exchange it 20× a second
// (`tinhat.sr.lvl`, lossy, group only). Every tick each member runs electTick() on its own fresh level + the
// peers' latest ones; exactly one member — the holder — sends its mic, the others send silence. Rules:
//   • no holder (or the holder left the group) → the lowest identity holds (deterministic, no negotiation);
//   • a member takes the mic when it is speaking (SNR ≥ speechDb) AND beats the holder by ≥ marginDb for
//     winTicks consecutive ticks (hysteresis: a chair creak, a 2 dB wobble or one quiet packet still in flight at a
//     speech onset never flips it); callers pass each peer's level as the max of its packets from the last holdMs;
//   • a peer level older than staleMs counts as silent (−∞): packet loss or a frozen peer cannot hold the
//     mic against someone who is talking; my own level is always fresh;
//   • ties go to the lower identity, so two members comparing the same numbers agree.
// Why RAW levels: a laptop's own speakers are loudest at its own mic, so it keeps the mic for the sound they
// make and its own canceller removes them — the far end's voice never leaks back through the other laptop.

export const SR = {
  speechDb: 6,
  marginDb: 3,
  winTicks: 4, // 200 ms: longer than a level packet's flight, so an onset never flips the mic (rig 2026-10-11)
  staleMs: 400,
  holdMs: 150, // callers feed a peer's level as the max of its packets from this window
  floorRiseDbPerWin: 0.025, // 0.5 dB/s at 20 windows/s: speech pauses pull it back down at once
  floorMinDb: -90,
  floorMaxDb: -20,
  snrMaxDb: 60,
} as const;

export interface Level {
  s: number; // SNR dB (integer on the wire)
  t: number; // ms — the receiver's clock when it arrived (mine: any value, always fresh)
}
export interface Wins {
  who: string;
  n: number;
}
export interface ElectState {
  holder: string;
  wins: Wins;
}
export interface ElectInput {
  me: string;
  members: string[]; // the group, sorted; includes me
  levels: Record<string, Level | undefined>;
  now: number;
}
export interface ElectResult extends ElectState {
  live: boolean; // holder === me → my mic sends
}

export const ELECT_IDLE: ElectState = { holder: "", wins: { who: "", n: 0 } };

export function electTick(st: ElectState, inp: ElectInput): ElectResult {
  const members = [...inp.members].sort();
  if (members.length === 0) return { holder: "", wins: { who: "", n: 0 }, live: false };
  const lvl = (id: string): number => {
    const l = inp.levels[id];
    if (!l) return -Infinity;
    if (id === inp.me) return l.s;
    return inp.now - l.t <= SR.staleMs ? l.s : -Infinity;
  };
  let holder = members.includes(st.holder) ? st.holder : members[0];
  let wins: Wins = st.wins;
  let best = "";
  let bestLvl = -Infinity;
  for (const id of members) {
    if (id === holder) continue;
    const v = lvl(id);
    if (v < SR.speechDb) continue;
    if (v > bestLvl || (v === bestLvl && id < best)) {
      best = id;
      bestLvl = v;
    }
  }
  if (best && bestLvl >= lvl(holder) + SR.marginDb) {
    wins = wins.who === best ? { who: best, n: wins.n + 1 } : { who: best, n: 1 };
    if (wins.n >= SR.winTicks) {
      holder = best;
      wins = { who: "", n: 0 };
    }
  } else if (wins.n !== 0 || wins.who !== "") wins = { who: "", n: 0 };
  return { holder, wins, live: holder === inp.me };
}

/** The raw mic's noise floor + SNR per 50 ms window (identical on both apps — vectors.json "floor"). */
export class FloorTracker {
  floor = NaN;
  /** `db` = the window's level in dBFS. Returns the integer SNR dB to put on the wire. */
  push(db: number): number {
    const d = Number.isFinite(db) ? db : SR.floorMinDb;
    if (Number.isNaN(this.floor) || d < this.floor) this.floor = Math.min(SR.floorMaxDb, Math.max(SR.floorMinDb, d));
    else this.floor = Math.min(SR.floorMaxDb, this.floor + SR.floorRiseDbPerWin);
    const snr = Math.round(d - this.floor);
    return snr < 0 ? 0 : snr > SR.snrMaxDb ? SR.snrMaxDb : snr;
  }
  reset(): void {
    this.floor = NaN;
  }
}

/** dBFS of a window of linear RMS frames (the loudest 10 ms frame), floor −100. */
export function windowDb(frames: number[]): number {
  let m = 0;
  for (const f of frames) if (f > m) m = f;
  return m > 0 ? Math.max(-100, 20 * Math.log10(m)) : -100;
}

/** The group id both sides compute without negotiation. */
export function groupIdOf(members: string[]): string {
  return [...members].sort().join("+");
}

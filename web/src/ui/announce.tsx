// announce.tsx — screen-reader announcements (accessibility round 2, M3; the desktop's Accessible.announce).
//
//   announce(text, { urgent })   say `text`: polite (waits for the reader to finish) or urgent (interrupts)
//   <LiveRegions />              the two live regions, mounted ONCE for the whole app (App.tsx) so they exist before
//                                anything is said (a region created together with its text is not read)
//
// Each announcement is a NEW child of its region (aria-relevant additions, aria-atomic false: status / alert are atomic
// by default, which would re-read the older lines with each new one), so the same words twice are read twice and
// two quick ones are both read (replacing a single text node drops the first). A child goes after CLEAR_MS; at most
// KEEP children stay. The regions are visually hidden (.th-sr-only) and take no pointer or focus.
import { useEffect, useState } from "react";

const CLEAR_MS = 7000;
const KEEP = 4;

interface Said {
  id: number;
  text: string;
}
type Listener = (s: Said, urgent: boolean) => void;
const listeners = new Set<Listener>();
let nextId = 1;
// said before the regions were mounted (the same render that mounts them): read out once they are, if still fresh
const PENDING_MS = 3000;
let pending: Array<{ s: Said; urgent: boolean; at: number }> = [];

/** Say `text` to a screen reader (nothing when it is blank). */
export function announce(text: string, opts?: { urgent?: boolean }): void {
  const t = text.trim();
  if (t.length === 0) return;
  const s = { id: nextId++, text: t };
  if (listeners.size === 0) {
    pending = [...pending, { s, urgent: opts?.urgent === true, at: Date.now() }].slice(-KEEP);
    return;
  }
  for (const f of listeners) f(s, opts?.urgent === true);
}

export function LiveRegions() {
  const [polite, setPolite] = useState<Said[]>([]);
  const [urgent, setUrgent] = useState<Said[]>([]);
  useEffect(() => {
    const timers = new Set<number>();
    const f: Listener = (s, u) => {
      const set = u ? setUrgent : setPolite;
      set((l) => [...l, s].slice(-KEEP));
      const t = window.setTimeout(() => {
        timers.delete(t);
        set((l) => l.filter((x) => x.id !== s.id));
      }, CLEAR_MS);
      timers.add(t);
    };
    listeners.add(f);
    const late = pending.filter((x) => Date.now() - x.at < PENDING_MS);
    pending = [];
    for (const x of late) f(x.s, x.urgent);
    return () => {
      listeners.delete(f);
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);
  return (
    <>
      <div className="th-sr-only" role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions" data-testid="live-polite">
        {polite.map((s) => (
          <div key={s.id}>{s.text}</div>
        ))}
      </div>
      <div className="th-sr-only" role="alert" aria-live="assertive" aria-atomic="false" aria-relevant="additions" data-testid="live-urgent">
        {urgent.map((s) => (
          <div key={s.id}>{s.text}</div>
        ))}
      </div>
    </>
  );
}

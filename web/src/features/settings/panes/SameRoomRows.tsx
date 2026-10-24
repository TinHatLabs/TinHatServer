// SameRoomRows.tsx — Settings › Audio › "Same room" (11.3): link up automatically with remembered people, and the
// list of people you've linked with (Remove forgets them). Reads the engine's remembered pairs through
// @/features/calls (the pref blob `sameroom-pairs`, by bare mxid) and the pref `sameroom-auto` (default on).
import { useSyncExternalStore } from "react";
import { Button } from "@/ui";
import { onBlobChange, usePrefState } from "@/core/prefs";
import { forgetPair, rememberedPairs, SAME_ROOM_PAIRS_KEY } from "@/features/calls";
import { Hint, Row, SwitchRow } from "../rows";
import s from "./SameRoomRows.module.css";

function subscribe(cb: () => void) {
  return onBlobChange(SAME_ROOM_PAIRS_KEY, cb);
}
let snapRaw = "";
let snapVal: string[] = [];
function snapshot(): string[] {
  const p = rememberedPairs();
  const raw = JSON.stringify(p);
  if (raw !== snapRaw) {
    snapRaw = raw;
    snapVal = Object.keys(p).sort();
  }
  return snapVal;
}

export function SameRoomRows() {
  const [auto, setAuto] = usePrefState("sameroom-auto", true);
  const pairs = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <>
      <SwitchRow
        id="audio.same-room-auto"
        label="Link up automatically"
        description="When someone you've linked with before is in the call, link up again without asking. Linked people in one room send one voice and don't play each other through Tin Hat."
        checked={auto}
        onToggled={setAuto}
      />
      <Row id="audio.same-room-pairs" label="People you've linked with" description={pairs.length ? "Remove forgets them — you can link up again any time from their tile." : undefined}>
        {pairs.length === 0 ? (
          <Hint>Nobody yet. In a call, right-click someone sitting next to you → "We're in the same room".</Hint>
        ) : (
          <div className={s.stack}>
            {pairs.map((mxid) => (
              <div key={mxid} className={s.inlineRow}>
                <span className={s.inlineText}>{mxid.startsWith("@") ? mxid.slice(1, mxid.indexOf(":") > 0 ? mxid.indexOf(":") : undefined) : mxid}</span>
                <Button text="Remove" onClick={() => forgetPair(mxid)} />
              </div>
            ))}
          </div>
        )}
      </Row>
    </>
  );
}

// GameReelWindow.tsx — GameReelWindow.qml (CAL-70): the in-app window hosting the panel. Escape
// closes; opening (or raising) refreshes; while open the store polls (5 s fingerprint + state
// subscription + the 30 s calendar write-back timer).
import { useEffect, useRef } from "react";
import { useAppWindow } from "@/app/WindowHost";
import { setSession, setWindowOpen } from "../gamesStore";
import { GameReelPanel } from "./GameReelPanel";

export function GameReelWindow(props: { sessionId?: string }) {
  const win = useAppWindow();
  // openWindow("gameReel", {sessionId}) from anywhere = entry.openGameReel({sessionId})
  useEffect(() => {
    if (props.sessionId) setSession(props.sessionId, true);
  }, [props.sessionId]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setWindowOpen(true);
    ref.current?.focus({ preventScroll: true });
    return () => setWindowOpen(false);
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      style={{ width: "100%", height: "100%", outline: "none", display: "flex" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest("input,textarea")) {
          e.preventDefault();
          e.stopPropagation();
          win.close();
        }
      }}
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest("input,textarea,button")) ref.current?.focus({ preventScroll: true });
      }}
      data-testid="gamereel-window"
    >
      <GameReelPanel />
    </div>
  );
}

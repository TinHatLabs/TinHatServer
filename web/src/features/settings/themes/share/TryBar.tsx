// TryBar.tsx — THEMES-UI.md §14.4: "Trying ‹name› · ‹n› s" + Keep + Undo while a shared theme is on trial. The number
// changes once a second (the only thing that moves); Undo or Esc (with the focus on the bar) goes back now.
import { Button } from "@/ui";
import type { JObj } from "@/theme/sync";
import { endTrial, keepTheme, useTrial } from "./shareStore";
import s from "./share.module.css";

export function TryBar() {
  const trial = useTrial((x) => x.trial);
  if (!trial) return null;
  return (
    <div
      className={s.tryBar}
      role="status"
      aria-live="polite"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          endTrial(true);
        }
      }}
    >
      <span className={s.tryBg} />
      <span className={s.tryText}>
        Trying {trial.doc.name} · {trial.left} s
      </span>
      <Button flat text="Keep" onClick={() => void keepTheme(trial.doc as unknown as JObj)} />
      <Button flat text="Undo" onClick={() => endTrial(true)} />
    </div>
  );
}

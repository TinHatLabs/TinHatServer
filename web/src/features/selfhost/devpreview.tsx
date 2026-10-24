// devpreview.tsx — DEV builds only: ?firstkeypreview=1 shows the calm Security Key step with a made-up key (review,
// screenshots: tools/selfhost-firstrun-shots.mjs). No crypto runs and nothing is stored; production builds never
// register it (features/selfhost/index.tsx).
import { useState } from "react";
import { FirstKeyDialog } from "./FirstKeyDialog";

/** A made-up key in the real key's shape (12 groups of 4) — it unlocks nothing. */
const SAMPLE_KEY = "EsTc 9fQ2 Lm4K 7wZp R2dV 8nYc Hb3T kQ6s Uj1F x5Ga Pe7W cN4r";

export function FirstKeyPreview() {
  const [open, setOpen] = useState(() => {
    try {
      return new URLSearchParams(location.search).get("firstkeypreview") === "1";
    } catch {
      return false;
    }
  });
  if (!open) return null;
  return <FirstKeyDialog open recoveryKey={SAMPLE_KEY} onClose={() => setOpen(false)} />;
}

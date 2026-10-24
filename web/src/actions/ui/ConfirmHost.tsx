// ConfirmHost.tsx — the confirm dialog of the run path (ACTIONS.md §7.4): one always-mounted ConfirmDialog; runAction
// asks through setConfirmHost and waits for the answer. The texts come from the table (both apps show the same).
import { useEffect } from "react";
import { create } from "zustand";
import { ConfirmDialog } from "@/ui";
import type { ConfirmOut } from "../evaluate";
import { setConfirmHost } from "../run";

type Pending = { c: ConfirmOut; resolve: (ok: boolean) => void };
const useAsk = create<{ req: Pending | null; n: number }>()(() => ({ req: null, n: 0 }));

function ask(c: ConfirmOut): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = useAsk.getState().req;
    prev?.resolve(false); // a newer request replaces an open one
    useAsk.setState((s) => ({ req: { c, resolve }, n: s.n + 1 }));
  });
}

export function ActionsConfirmHost() {
  const { req, n } = useAsk();
  useEffect(() => {
    setConfirmHost(ask);
    return () => setConfirmHost(null);
  }, []);
  const close = (ok: boolean) => {
    req?.resolve(ok);
    useAsk.setState({ req: null });
  };
  return (
    <ConfirmDialog
      key={n}
      open={!!req}
      onClose={() => close(false)}
      dialogTitle={req?.c.title}
      message={req?.c.text}
      confirmText={req?.c.confirmLabel}
      destructive={req?.c.kind === "destructive"}
      askReason={req?.c.askReason}
      onConfirmed={() => close(true)}
      onCancelled={() => close(false)}
    />
  );
}

// confirmHost.tsx — one always-mounted ConfirmDialog for confirms requested from non-React code
// (the r.memberMenu entries: Disconnect from the call…, Kick/Ban from space…).
import { create } from "zustand";
import { ConfirmDialog } from "@/ui";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmText: string;
  destructive?: boolean;
  askReason?: boolean;
  onConfirmed: (reason: string) => void;
}

const useConfirm = create<{ req: ConfirmRequest | null; n: number }>()(() => ({ req: null, n: 0 }));

export function askConfirm(req: ConfirmRequest) {
  useConfirm.setState((s) => ({ req, n: s.n + 1 }));
}

export function ConfirmHost() {
  const { req, n } = useConfirm();
  return (
    <ConfirmDialog
      key={n}
      open={!!req}
      onClose={() => useConfirm.setState({ req: null })}
      dialogTitle={req?.title}
      message={req?.message}
      confirmText={req?.confirmText}
      destructive={req?.destructive}
      askReason={req?.askReason}
      onConfirmed={(reason) => req?.onConfirmed(reason)}
    />
  );
}

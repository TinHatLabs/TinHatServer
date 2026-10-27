// linkconfirm.tsx — the dialog of core/linkgate.ts (an overlay of the chat feature): "The text says <claimed>, but this
// link opens <real>." — Open <real> / Cancel. The desktop's LinkGate asks the same.
import { ConfirmDialog } from "@/ui";
import { openConfirmed, useLinkConfirm } from "@/core/linkgate";

export { claimedHost, destinationHost, linkHoverText, openMessageLink } from "@/core/linkgate";

/** The one confirmation (an overlay of the chat feature). */
export function LinkConfirm() {
  const p = useLinkConfirm((s) => s.pending);
  const close = () => useLinkConfirm.setState({ pending: null });
  return (
    <ConfirmDialog
      open={!!p}
      onClose={close}
      dialogTitle={p?.title ?? "Open this link?"}
      message={p?.message ?? ""}
      confirmText={p?.confirmText ?? "Open"}
      cancelText="Cancel"
      onConfirmed={() => {
        if (p) openConfirmed(p);
      }}
    />
  );
}

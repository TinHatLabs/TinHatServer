// FirstKeyDialog.tsx — the calm first run's Security Key step (selfhost/firstrun item 2; rules + words: firstrun.ts).
// Shown instead of the verify dialog's "recovery-done" screen when a brand-new account's first device has just set
// up its encryption (F2). Plain words, the key in unbroken groups,
// Copy (the button says "Copied" for 2 s), Download (tinhat-security-key.txt), a line about a password manager, and
// Done — which asks once ("Close without saving your key?") unless the key was copied or downloaded. No checkbox.
// Esc / the phone's back button = Done. Closing goes straight into the app: nothing else is asked now.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { toast } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { Button, ConfirmDialog, Dialog, cx, useIsMobile } from "@/ui";
import {
  COPIED_MS,
  KEY_COPIED,
  KEY_COPY,
  KEY_COPY_FAILED,
  KEY_DONE,
  KEY_DOWNLOAD,
  KEY_FILE_NAME,
  KEY_HINT,
  KEY_LEAD,
  KEY_SKIP_BACK,
  KEY_SKIP_CONFIRM,
  KEY_SKIP_TEXT,
  KEY_SKIP_TITLE,
  KEY_TITLE,
  keyFileText,
  keyGroups,
  keySaved,
  localDate,
} from "./firstrun";
import s from "./FirstKeyDialog.module.css";

/** Copy text: the async clipboard, else (an insecure origin, an old browser) a hidden textarea + execCommand. */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the old way */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy refused");
}

/** The step is on screen: the first run's other questions wait (asks.tsx) — nothing shows behind the key. */
export const useKeyStepOpen = create<{ open: boolean }>(() => ({ open: false }));

export function FirstKeyDialog({ open, recoveryKey, onClose }: { open: boolean; recoveryKey: string; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    useKeyStepOpen.setState({ open: true });
    return () => useKeyStepOpen.setState({ open: false });
  }, [open]);
  const mobile = useIsMobile();
  const userId = useSession().userId ?? "";
  const [copiedNow, setCopiedNow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [asking, setAsking] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const groups = keyGroups(recoveryKey);

  const copy = () => {
    copyText(groups.join(" ")).then(
      () => {
        setCopied(true);
        setCopiedNow(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopiedNow(false), COPIED_MS);
      },
      () => toast(KEY_COPY_FAILED),
    );
  };
  const download = () => {
    const blob = new Blob([keyFileText({ key: recoveryKey, userId, date: localDate(Date.now()) })], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = KEY_FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setDownloaded(true);
  };
  const done = () => (keySaved({ copied, downloaded }) ? onClose() : setAsking(true));

  return (
    <>
      <Dialog
        open={open}
        onClose={done}
        title={KEY_TITLE}
        width={mobile ? "100%" : "min(468px, calc(100vw - 36px))"}
        className={cx(mobile && s.mobile)}
        closeOnOutside={false}
        buttons={[
          {
            text: KEY_DONE,
            role: "accept",
            onClick: done,
            render: (p) => <Button highlighted text={KEY_DONE} onClick={p.onClick} data-key-done="" style={{ width: "100%" }} />,
          },
        ]}
      >
        <div className={s.col} data-first-key="">
          <p className={s.lead}>{KEY_LEAD}</p>
          <div className={s.key} role="group" aria-label="Security Key" data-security-key="">
            <span className={s.keyText}>
              {groups.map((g, i) => (
                <span key={i}>
                  {i > 0 && " "}
                  <span className={s.group}>{g}</span>
                </span>
              ))}
            </span>
          </div>
          <div className={s.row}>
            <Button icon={copiedNow ? "checkmark-symbolic" : "edit-copy-symbolic"} text={copiedNow ? KEY_COPIED : KEY_COPY} onClick={copy} data-key-copy="" aria-live="polite" />
            <Button icon="document-save-symbolic" text={KEY_DOWNLOAD} onClick={download} data-key-download="" />
          </div>
          <p className={s.hint}>{KEY_HINT}</p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        dialogTitle={KEY_SKIP_TITLE}
        message={KEY_SKIP_TEXT}
        confirmText={KEY_SKIP_CONFIRM}
        cancelText={KEY_SKIP_BACK}
        destructive
        onConfirmed={onClose}
      />
    </>
  );
}

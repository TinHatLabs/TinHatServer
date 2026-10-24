// ui/util.ts — small shared hooks for the calendar + reel UI.
import { useRef } from "react";
import { useTip, type TipOptions } from "@/ui/Tooltip";

/** A ref with a Controls.ToolTip attached (400 ms default; `opts.delay` e.g. 300 / 500). */
export function useTipRef<T extends HTMLElement>(text: string | undefined | null, opts?: TipOptions) {
  const ref = useRef<T>(null);
  useTip(ref, text, opts);
  return ref;
}

/** Copy text to the clipboard (CAL-39) — the web stand-in for the native hidden TextEdit. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// spaceSettingsTitle.ts — the Space settings window's title (moved out of SpaceSettingsWindow.tsx so that window can be
// its own chunk, web-perf 2026-11-07; unchanged).
import { peekClient } from "@/core/matrix";

export function spaceSettingsTitle(props: Record<string, unknown>): string {
  // phones: the sheet header already carries the space name + avatar right below it
  if (typeof document !== "undefined" && document.documentElement.dataset.ff === "mobile") return "Space settings";
  const id = String(props.spaceId ?? "");
  const name = id ? peekClient()?.getRoom(id)?.name : "";
  return name ? `${name} · Space settings` : "Space settings";
}

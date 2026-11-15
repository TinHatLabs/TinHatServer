// paletteChoice.ts — what Enter (or a click) on a Ctrl+K row does (ACTIONS.md §10.1, §10.5), one pure rule; the desktop's
// QuickSwitcher.qml runs the same rule (its `choice` function between the BEGIN choice / END choice markers, checked on
// the same cases by tools/palette-choice-test.mjs; this file's mirror is paletteChoice.test.ts).
//   room → open it (pick mode: hand it to the picker) · invite → show it where it waits · person → message them ·
//   an action that picks its target → stage 2 · find ("Find people named …", P6) → New DM with the query in its field ·
//   an action or a choice → run it · a disabled row → nothing
import type { PaletteItem } from "../../actions/palette";

export type PaletteChoice =
  | { do: "nothing" }
  | { do: "openRoom"; id: string }
  | { do: "pickRoom"; id: string }
  | { do: "showInvite"; id: string }
  | { do: "message"; person: string }
  | { do: "stage"; action: string }
  | { do: "newDm"; text: string }
  | { do: "run"; action: string; target: PaletteItem["target"] };

export function paletteChoice(it: Pick<PaletteItem, "kind" | "id" | "enabled" | "pick" | "a" | "target"> | undefined, picking: boolean): PaletteChoice {
  if (!it || it.enabled !== true) return { do: "nothing" };
  if (it.kind === "room") return picking ? { do: "pickRoom", id: it.id } : { do: "openRoom", id: it.id };
  if (it.kind === "invite") return { do: "showInvite", id: it.id };
  if (it.kind === "person") return { do: "message", person: it.id };
  if (it.kind === "find") return { do: "newDm", text: it.id };
  if (it.kind === "action" && it.pick === true) return { do: "stage", action: it.id };
  if (it.a) return { do: "run", action: it.a, target: it.kind === "choice" ? it.target : null };
  return { do: "nothing" };
}

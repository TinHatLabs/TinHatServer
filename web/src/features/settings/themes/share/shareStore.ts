// shareStore.ts — theme share cards, the app side (THEMES-UI.md §14): "Share to a room…" (the quick switcher's pick
// mode → shareContent → an m.room.message), Try (a 30-second preview through the theme store with the Try bar; one trial
// at a time; any real apply ends it without going back) and Keep (keepPlan: use a library theme / one of My themes, or
// save a new My theme and use it). The pure rules are src/theme/share.ts.
import { create } from "zustand";
import type { Theme } from "@/theme/engine";
import { keepPlan, shareContent, TRY_MS } from "@/theme/share";
import type { JObj } from "@/theme/sync";
import { peekClient, sendMessage } from "@/core/matrix";
import { pickRoom } from "@/features/nav";
import { showToast } from "@/ui";
import { libraryDoc, libraryNow, loadLibrary } from "@/ui/themeLibrary";
import { chooseTheme, clearThemePreview, myThemeDocs, onThemeApplied, saveMyTheme, setThemePreview, themePreviewOwner } from "@/ui/themeStore";
import { APP_SPEC, onEditorOpensDuringTrial } from "../editor/editorStore";
import { refusalText } from "../text";

// ---- Share to a room (§14.5) -------------------------------------------------------------------------------------
export function openShareRoom(doc: Theme): void {
  pickRoom({ title: `Share ${doc.name} to…`, placeholder: "Search rooms", onPick: (roomId) => void shareTo(roomId, doc) });
}

export async function shareTo(roomId: string, doc: Theme): Promise<boolean> {
  const c = shareContent(doc, APP_SPEC);
  if (!c.ok) {
    showToast(`This theme can't be shared (${c.error.split(":")[0]}).`, "long");
    return false;
  }
  try {
    // a plain object: the pure module's objects are prototype-less (the SDK's body conversion needs plain JSON)
    await sendMessage(roomId, JSON.parse(JSON.stringify(c.content)));
    const room = peekClient()?.getRoom(roomId)?.name ?? "the room";
    showToast(`${doc.name} shared in ${room}`, "short");
    return true;
  } catch (e) {
    showToast(`Couldn't share ${doc.name}: ${(e as Error)?.message ?? e}`, "long");
    return false;
  }
}

// ---- Try (§14.4) ----------------------------------------------------------------------------------------------------
export interface Trial {
  /** the card that started it (event id), so that card's button reads "Stop" */
  key: string;
  doc: Theme;
  /** seconds left */
  left: number;
}
export const useTrial = create<{ trial: Trial | null }>()(() => ({ trial: null }));
let tick = 0;

function stopTimer(): void {
  if (tick) window.clearInterval(tick);
  tick = 0;
}

/** End the trial: `back` paints the effective choice again (Undo, the countdown); false when a real apply took over. */
export function endTrial(back = true): void {
  if (!useTrial.getState().trial) return;
  stopTimer();
  useTrial.setState({ trial: null });
  if (back || themePreviewOwner() === "try") clearThemePreview("try");
}

/** Try a card's theme for 30 s (§14.4). Refused while the theme editor is open (the button is disabled then). */
export function tryTheme(key: string, doc: Theme): boolean {
  if (themePreviewOwner() === "editor") return false;
  const err = setThemePreview("try", doc);
  if (err) {
    showToast(refusalText(err), "long");
    return false;
  }
  stopTimer();
  useTrial.setState({ trial: { key, doc, left: Math.round(TRY_MS / 1000) } });
  // once a second: a changed number is the only thing that moves (GPU.md)
  tick = window.setInterval(() => {
    const t = useTrial.getState().trial;
    if (!t) return stopTimer();
    if (t.left <= 1) endTrial(true);
    else useTrial.setState({ trial: { ...t, left: t.left - 1 } });
  }, 1000);
  return true;
}

// a real apply (a card, the ☰ menu, Keep, the editor's Save) ends the trial without going back
onThemeApplied(() => endTrial(false));
// the theme editor takes the screen from a trial
onEditorOpensDuringTrial(() => endTrial(false));

// ---- Keep (§14.4) ---------------------------------------------------------------------------------------------------
export type KeepState = "keep" | "use" | "inUse";

/** What Keep would do (its label, §14.3): save a new theme ("Keep"), use an existing one ("Use"), or nothing — that
 *  theme is the one on screen ("In use"). */
export function keepState(theme: JObj, activeId: string): KeepState {
  const plan = keepPlan(theme, (id) => libraryLookup(id), myThemeDocs() as unknown as JObj[]);
  if (plan.kind === "save") return "keep";
  return plan.id === activeId ? "inUse" : "use";
}

function libraryLookup(id: string): JObj | undefined {
  return (libraryNow()?.byId.get(id)?.doc ?? libraryDoc(id)) as unknown as JObj | undefined;
}

export async function keepTheme(theme: JObj): Promise<void> {
  if (!libraryNow()) await loadLibrary().catch(() => undefined);
  const plan = keepPlan(theme, (id) => libraryLookup(id), myThemeDocs() as unknown as JObj[]);
  if (plan.kind === "save") {
    const doc = plan.doc as unknown as Theme;
    const r = saveMyTheme(doc);
    if (r !== "saved" && r !== "noop") {
      showToast(refusalText(r), "long");
      return;
    }
    chooseTheme(doc);
    showToast(`${doc.name} added to My themes`, "short");
  } else {
    const doc = plan.kind === "library" ? (libraryLookup(plan.id) as unknown as Theme) : (myThemeDocs().find((d) => d.id === plan.id) as Theme);
    if (doc) chooseTheme(doc);
  }
  endTrial(false);
}

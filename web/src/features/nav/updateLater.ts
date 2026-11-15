// updateLater.ts — P17: "Later" on the update strip hides it until a NEWER version appears. The version the user put off
// is stored as the device pref "update-later-for" (the desktop's settings.uiPref("update-later-for"), Main.qml
// updateBannerUp — the same rule). A download the user started always shows (the desktop's downloading state).
export const UPDATE_LATER_PREF = "update-later-for";

/** true = keep the update strip hidden: the user said "Later" to exactly this version. */
export function updateLaterHides(laterFor: string, next: string, downloading = false): boolean {
  return !downloading && laterFor.length > 0 && laterFor === next;
}

/** The web has two update signals for one deployment: version.json's version ("v") and the served bundle's entry
 *  script ("b"). "Later" remembers each one known at the time ("v:12.1.16|b:/assets/index-x.js"). The strip stays
 *  hidden while a signal it shows now matches what was put off and NO signal known both then and now differs: a
 *  version arriving after the bundle (or the other way round) doesn't bring it back, a newer one of either does.
 *  No signal = nothing to remember = no Later. */
export function laterValue(next: string, bundle: string): string {
  return [next ? `v:${next}` : "", bundle ? `b:${bundle}` : ""].filter((k) => k.length > 0).join("|");
}
export function updateLaterHidesAny(laterFor: string, next: string, bundle: string): boolean {
  const put = new Map(laterFor.split("|").filter((k) => /^[vb]:./.test(k)).map((k) => [k[0], k.slice(2)] as const));
  const now = ([["v", next], ["b", bundle]] as const).filter(([, k]) => k.length > 0);
  if (now.some(([kind, k]) => put.has(kind) && put.get(kind) !== k)) return false; // a newer one of a signal: show
  return now.some(([kind, k]) => updateLaterHides(put.get(kind) ?? "", k));
}

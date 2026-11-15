// keys.ts — the soundboard's keys (QOL A16.0, product call P12 (a); A16.1). Digits 1-9 play the shown favourites
// whenever the search box doesn't have focus OR is empty (the box is focused on open, so the hotkeys used to be
// swallowed); a digit with no favourite behind it types into an empty box. Enter in the box plays the first match in
// screen order: favourites, room sounds, recent, then the web results (it used to look at favourites only).
// SHARED LOGIC: sbKeyAction is the desktop's SoundboardPopover.qml sbKeyAction, rule for rule; both replay
// testvectors/soundboard-keys/vectors.json.

export type SbCounts = { fav: number; room: number; recent: number; web: number };

/** "fav:N" / "room:0" / "recent:0" / "web:0" = play that one; "none" = the key is taken, nothing plays; "type" = not
 *  the soundboard's key (it types / goes to the focused control). */
export function sbKeyAction(key: string, mods: boolean, inSearch: boolean, query: string, c: SbCounts): string {
  if (key.length === 1 && key >= "1" && key <= "9") {
    if (mods) return "type";
    if (inSearch && query.length > 0) return "type";
    const n = Number(key);
    if (n <= c.fav) return "fav:" + (n - 1);
    return inSearch ? "type" : "none";
  }
  if (key === "Enter" && inSearch && !mods) {
    for (const k of ["fav", "room", "recent", "web"] as const) if (c[k] > 0) return k + ":0";
    return "none";
  }
  return "type";
}

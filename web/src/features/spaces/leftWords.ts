// leftWords.ts — what a kick / Disconnect / Mute says when the person is already gone (guest-leave follow-up, 12.1.1).
// The menus no longer list someone who left (the roster rule), so these words show in one case: the person leaves (or
// is kicked by someone else) while the confirmation for "Kick…" / "Disconnect from the call…" is open, then Confirm.
// Pure: the unit tests run it in Node (leftWords.test.ts); the desktop's crates/app/src/left_words.rs is the same
// rule with the same cases.

export type LeftScope = "room" | "space" | "call";

const gone = (m: string | null | undefined) => m === "leave" || m === "ban";

/**
 * null = go ahead; else the sentence that replaces the action.
 *   room   the room kick: someone who left / was banned → "<name> has already left"
 *   space  the space kick: only a joined or invited member can be removed; left / banned → "<name> has already left the
 *          space", anything else → "<name> isn't in the space"
 *   call   Disconnect / Mute (they act on the call server): `onCallServer` = they still have a tile there → go ahead;
 *          else left / banned → "<name> has already left", otherwise "They're not in the call"
 */
export function goneText(scope: LeftScope, name: string, membership: string | null | undefined, onCallServer = false): string | null {
  if (scope === "room") return gone(membership) ? `${name} has already left` : null;
  if (scope === "space") {
    if (membership === "join" || membership === "invite") return null;
    return gone(membership) ? `${name} has already left the space` : `${name} isn't in the space`;
  }
  if (onCallServer) return null;
  return gone(membership) ? `${name} has already left` : "They're not in the call";
}

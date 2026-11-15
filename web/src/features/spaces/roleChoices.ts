// roleChoices.ts — P13: the room member menu's "Change role…" presets. Matrix lets you set a level up to your own
// (never above), so an Admin can make another Admin; that can't be undone by you (you can't lower someone at your
// level), so it asks first. The desktop's RightPanel.qml powerMenu applies the same rule.
export const ROLE_PRESETS = [
  { t: "Admin", v: 100 },
  { t: "Moderator", v: 50 },
  { t: "Member", v: 0 },
] as const;

/** The presets I may hand out: up to my own level. */
export function roleChoices(myPower: number): { t: string; v: number }[] {
  return ROLE_PRESETS.filter((x) => x.v <= myPower);
}

/** Giving someone my own level can't be taken back by me: confirm first (not when they already have it). */
export function roleNeedsConfirm(v: number, myPower: number, current: number): boolean {
  return v >= myPower && v !== current;
}

/** The confirm's words (the same in both apps). */
export function roleConfirmWords(name: string, role: string): { title: string; message: string; confirm: string } {
  return {
    title: `Make ${name} ${/^[AEIOU]/.test(role) ? "an" : "a"} ${role}?`,
    message: `They'll have the same power as you, and you won't be able to undo it.`,
    confirm: `Make ${role}`,
  };
}

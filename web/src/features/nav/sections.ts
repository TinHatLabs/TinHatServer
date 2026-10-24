// sections.ts — 11.0 (EDITMODE-UI §12, LAYOUT §3 phone form): the phone home page's sections in the order and
// visibility of the layout's phone form. The rail column holds nav (the meta bubbles), dms (the DM strip) and spaces
// (the space list + "+"); the list column holds rooms (header, filter, rows), widgets (inside the list) and account (the
// card). Pure helpers; absent = today's order with everything shown.
export interface PhoneSections {
  rail: readonly string[];
  list: readonly string[];
}

export const DEFAULT_SECTIONS: PhoneSections = { rail: ["nav", "dms", "spaces"], list: ["rooms", "widgets", "account"] };

/** The known rail sections in phone-form order (unknown refs skipped). */
export function railOrder(s: PhoneSections | undefined): string[] {
  return (s ?? DEFAULT_SECTIONS).rail.filter((r) => r === "nav" || r === "dms" || r === "spaces");
}

/** Where the list column's parts go: rooms shown, widgets before / after the rows (or hidden), the account card at the
 *  top / bottom (or hidden). */
export function listPlan(s: PhoneSections | undefined): { rooms: boolean; widgets: "before" | "after" | null; account: "top" | "bottom" | null } {
  const l = (s ?? DEFAULT_SECTIONS).list;
  const i = (r: string) => l.indexOf(r);
  const rooms = i("rooms") >= 0;
  const widgets = i("widgets") < 0 ? null : rooms && i("widgets") < i("rooms") ? "before" : "after";
  const account = i("account") < 0 ? null : rooms && i("account") < i("rooms") ? "top" : !rooms && i("widgets") >= 0 && i("account") < i("widgets") ? "top" : "bottom";
  return { rooms, widgets, account };
}

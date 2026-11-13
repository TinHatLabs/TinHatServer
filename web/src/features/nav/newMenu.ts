// newMenu.ts — the room column's + (contract actions.json menus.new): its rows, and what New room opens. Pure, so node
// tests it (newMenu.test.ts). Desktop twin: crates/app/qml/NewMenu.qml (+ Main.qml's New room dialog), tested by
// scripts/new-menu-test.qml.
//
// QA D21 (12.1.11): making a plain room was hidden — on Home the + offered only New DM, and the way to a room went
// through the rail's "Join a space" → "Make a space instead" → unticking "Make this a space". New room… is on the +
// everywhere now: in a space the room goes into it (as before); on Home / People it is a room of its own.

export interface NewMenuRow {
  /** the contract action the row is (actions.json actions[].id; its label is the row's text) */
  action: "dm.new" | "room.create";
  text: string;
  icon: string;
}

export const NEW_MENU_ROWS: readonly NewMenuRow[] = Object.freeze([
  { action: "dm.new", text: "New DM…", icon: "document-edit-symbolic" },
  { action: "room.create", text: "New room…", icon: "folder-new-symbolic" },
]);

/** The rows of the + for the rail's selection (a space id "!…", or Home / People). */
export function newMenuRows(_activeKey: string): NewMenuRow[] {
  return [...NEW_MENU_ROWS];
}

/** What New room… opens: a room (never a space), in the selected space when there is one. */
export function newRoomOpen(activeKey: string, activeLabel: string): { kind: "newRoom"; space: false; parent: string | null; parentName: string } {
  const inSpace = activeKey.startsWith("!");
  return { kind: "newRoom", space: false, parent: inSpace ? activeKey : null, parentName: inSpace ? activeLabel : "" };
}

/** The New room dialog's title (desktop: Main.qml newRoomDialog.title): `inSpace` = the room goes into the space (it may,
 *  and "Put it in" is ticked); a space without a name says plain New room. */
export function newRoomTitle(space: boolean, inSpace: boolean, parentName: string): string {
  return space ? "New space" : inSpace && parentName ? `New room in ${parentName}` : "New room";
}
